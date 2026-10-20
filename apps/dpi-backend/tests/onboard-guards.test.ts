import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
  DESTRUCTIVE_GUARD_FIXTURES,
  TEST_RUNNER_GUARD_FIXTURES,
  findDestructiveCommand,
  isAmbiguousTestScript,
  rewriteCommand,
} from "../src/onboard/guard-rules.js";
import { createGuardApprovalHost, commandApprovalHash } from "../src/onboard/guards.js";
import { tempStore, until } from "./helpers.js";
import { TicketStore, type Ticket } from "../src/onboard/tickets.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import type { Store } from "../src/store.js";

test("test-runner guard matches the plain-pi fixture table", () => {
  for (const fixture of TEST_RUNNER_GUARD_FIXTURES) {
    assert.deepEqual(rewriteCommand(fixture.command), fixture.rewritten ?? null, fixture.name);
    assert.equal(isAmbiguousTestScript(fixture.command), fixture.ambiguous ?? false, fixture.name);
  }
});

test("destructive guard matches plain-pi patterns including heredoc and echo text", () => {
  for (const fixture of DESTRUCTIVE_GUARD_FIXTURES) {
    assert.equal(findDestructiveCommand(fixture.command)?.label, fixture.label, fixture.name);
  }
});

test("human command approvals are root-only, exact-command, expiring and one-shot", () => {
  let now = 100;
  const approvals = createGuardApprovalHost({ now: () => now, ttlMs: 1_000 });
  const command = "rm -rf ./scratch";
  const hash = approvals.request(command);

  assert.equal(hash, commandApprovalHash(command));
  assert.equal(approvals.approve(hash, (ROOT_CONVERSATION_ID + 1) as typeof ROOT_CONVERSATION_ID), false);
  assert.equal(approvals.consume(command), false);
  assert.equal(approvals.approve(hash, ROOT_CONVERSATION_ID), true);
  assert.equal(approvals.consume("rm -rf ./scratch "), false, "whitespace changes the exact command hash");
  assert.equal(approvals.consume(command), true);
  assert.equal(approvals.consume(command), false, "approval cannot be reused");

  const expiring = approvals.request("git reset --hard");
  assert.equal(approvals.approve(expiring, ROOT_CONVERSATION_ID), true);
  now += 1_001;
  assert.equal(approvals.consume("git reset --hard"), false, "expired approval fails closed");
});

async function withOnboardingEnv<T>(setupDir: string, run: () => Promise<T>, options: { memory?: "off" | "local"; path?: string } = {}): Promise<T> {
  const keys = ["DPI_ONBOARD", "DPI_MEMORY", "DPI_TICKETS", "PI_SETUP_DIR", "PATH"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DPI_ONBOARD = "1";
  process.env.DPI_MEMORY = options.memory ?? "off";
  process.env.DPI_TICKETS = "0";
  process.env.PI_SETUP_DIR = setupDir;
  if (options.path) process.env.PATH = options.path;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("durable guards block until the root approves once, and forks cannot shed the guard", async () => {
  const fixture = await tempStore();
  const setupDir = `${fixture.root}/empty-setup`;
  const fakeBin = join(fixture.root, "fake-bin");
  let store: Awaited<ReturnType<typeof fixture.open>> | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    const fakeNpx = join(fakeBin, "npx");
    await writeFile(fakeNpx, `#!/bin/sh
printf 'fake-npx %s\\n' "$*"
`);
    await chmod(fakeNpx, 0o755);
    await withOnboardingEnv(setupDir, async () => {
      store = await fixture.open();
      const session = await store.create({ name: "Guards", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const extensionState = async (agent = c) => (await store!.extensionsOf(row, agent)).extensions.find((item) => item.name === "durable-guards")?.enabled;
      assert.equal(await extensionState(), true, "DPI_ONBOARD selects durable guards by default");
      assert.equal((await store.agentDetail(row, c)).tools.some((tool) => tool.name === "approve_command"), false,
        "approval is a host action from Store.send, not a model-callable tool");

      let index = 0;
      const turn = async (agent: typeof c, content: string) => {
        const submission = await store!.submitAuthenticatedUserMessage(row, agent, { content, requestId: `guard-${++index}` });
        const settled = await store!.settled(h, submission.id as number, 20_000);
        assert.equal(settled.status, "done");
      };
      const transcript = async (agent = c) => JSON.stringify((await store!.entries(agent, undefined, 500)).items);
      const extractApproval = async (agent = c) => {
        const match = /approve ([a-f0-9]{64})/i.exec(await transcript(agent));
        assert.ok(match, "blocked result tells the user the exact approval hash");
        return match[1].toLowerCase();
      };

      await turn(c, "!npx vitest");
      assert.match(await transcript(), /fake-npx vitest run --pool=forks --maxWorkers=2/);
      await turn(c, "!npm test");
      assert.match(await transcript(), /npm test.*blocked|blocked.*npm test/i);

      const doomed = `${fixture.work}/guard-doomed`;
      await mkdir(doomed);
      await turn(c, `!rm -rf ${doomed}`);
      assert.equal(existsSync(doomed), true, "first destructive attempt is blocked");
      const hash = await extractApproval();
      await turn(c, `approve ${hash}`);
      await turn(c, `!rm -rf ${doomed}`);
      assert.equal(existsSync(doomed), false, "the exact root-approved command runs once");

      await mkdir(doomed);
      await turn(c, `!rm -rf ${doomed}`);
      assert.equal(existsSync(doomed), true, "approval is consumed and cannot be reused");

      const combined = `${fixture.work}/combined-command`;
      await mkdir(combined);
      const combinedCommand = `npx playwright test e2e; rm -rf ${combined}`;
      await turn(c, `!${combinedCommand}`);
      assert.equal(existsSync(combined), true, "combined destructive command is initially blocked");
      const combinedHash = await extractApproval();
      await turn(c, `approve ${combinedHash}`);
      await turn(c, `!${combinedCommand}`);
      assert.equal(existsSync(combined), false, "approved destructive segment runs");
      assert.match(await transcript(), /fake-npx playwright test --workers=1 e2e/,
        "one-shot approval does not bypass the test-runner rewrite");

      await store.setExtension(row, c, { name: "durable-guards", enabled: false });
      assert.equal(await extensionState(), false, "the per-agent Extend toggle can disable the guard");
      await turn(c, "hello while the root guard is disabled");
      const entries = await store.entries(c, undefined, 500);
      const fork = await store.fork(row, c, { entryId: entries.items.at(-1)!.id });
      const forkAgent = (await store.resolveAgent(session.id, String(fork.id))).c;
      assert.equal(await extensionState(forkAgent), true, "fork creation restores the guard even if its source opted out");

      const forkDoomed = `${fixture.work}/fork-doomed`;
      await mkdir(forkDoomed);
      await turn(forkAgent, `!rm -rf ${forkDoomed}`);
      assert.equal(existsSync(forkDoomed), true, "fork destructive attempt is blocked");
      const forkHash = await extractApproval(forkAgent);
      await turn(forkAgent, `approve ${forkHash}`);
      await turn(forkAgent, `!rm -rf ${forkDoomed}`);
      assert.equal(existsSync(forkDoomed), true, "a non-root conversation cannot grant approval");
      await turn(c, `approve ${forkHash}`);
      await turn(forkAgent, `!rm -rf ${forkDoomed}`);
      assert.equal(existsSync(forkDoomed), false, "root approval can authorize a child command once");

      await store.setExtension(row, c, { name: "durable-guards", enabled: true });
      await store.configure(row, c, { readOnly: true });
      assert.equal(await extensionState(), true, "read-only policy does not remove the guard extension");
      const readOnly = await store.agentDetail(row, c);
      assert.equal(readOnly.config.readOnly, true);
      assert.equal(readOnly.tools.find((tool) => tool.name === "bash")?.offered, false);
    }, { path: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

async function writeMemoryCli(setupDir: string): Promise<void> {
  await mkdir(join(setupDir, "bin"), { recursive: true });
  await mkdir(join(setupDir, "experts"), { recursive: true });
  await writeFile(join(setupDir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(setupDir, "bin", "pi-memory.ts"), `let raw = "";\nfor await (const chunk of process.stdin) raw += chunk;\nconst command = process.argv[2];\nconst input = JSON.parse(raw);\nlet result = {};\nif (command === "expert") {\n  const name = typeof input.name === "string" ? input.name : "backend-engineer";\n  result = { profile: { name, excludeTools: ["edit", "write"], skills: [], body: "# Fixture expert\\nComplete the assigned slice." }, model: { model: "faux/echo", thinking: "high" }, bestPracticesIndex: "" };\n} else if (command === "roster") result = [{ name: "backend-engineer", description: "Fixture backend expert" }];\nelse if (command === "read") result = { text: "" };\nprocess.stdout.write(JSON.stringify(result));\n`);
}

function fakeSubagentModel(store: Store, command: string) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Fixture faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") { lastUser = index; break; }
    }
    const content = messages[lastUser]?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    if (prompt === "launch built-in child" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("subagent", { task: "Attempt subagent destructive command" })], { stopReason: "toolUse" });
    if (prompt === "Attempt subagent destructive command" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    if (prompt === "Attempt subagent destructive command" && afterToolResult)
      return fauxAssistantMessage("I stopped after the guard blocked the command.");
    return fauxAssistantMessage("Child finished.");
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
}

function fakeJobModel(store: Store, command: string) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Fixture faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") { lastUser = index; break; }
    }
    const content = messages[lastUser]?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    if (prompt.includes("Release check: gather facts for run #") && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    if (prompt.includes("Release check: gather facts for run #") && afterToolResult)
      return fauxAssistantMessage("The destructive command was blocked.");
    return fauxAssistantMessage("Job helper completed.");
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
}

function fakeDelegateModel(store: Store, command: string) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Fixture faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") { lastUser = index; break; }
    }
    const content = messages[lastUser]?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    if (prompt === "launch delegated destructive command" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("delegate", { expert: "backend-engineer", task: "Attempt the delegated destructive command" })], { stopReason: "toolUse" });
    if (prompt === "Attempt the delegated destructive command" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    if (prompt === "Attempt the delegated destructive command" && afterToolResult)
      return fauxAssistantMessage("DPI_GUARD_BLOCKED: I stopped without retrying.");
    return fauxAssistantMessage("Delegation finished.");
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
}

function fakeTicketModel(store: Store, command: string) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Fixture faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") { lastUser = index; break; }
    }
    const content = messages[lastUser]?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    if (prompt === "launch guarded ticket" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("run_ticket", { id: "guarded-ticket" })], { stopReason: "toolUse" });
    if (prompt.includes("Phase: build. Slice") && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    if (prompt.includes("Phase: build. Slice") && afterToolResult)
      return fauxAssistantMessage("CHECK: pnpm test\\nTICKET_STATUS: COMPLETE");
    return fauxAssistantMessage("Ticket launched.");
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
}

test("built-in subagents cannot shed guards when the parent has opted out", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  const target = join(fixture.root, "subagent-target");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await mkdir(target);
    await withOnboardingEnv(setupDir, async () => {
      store = await fixture.open();
      fakeSubagentModel(store, `rm -rf ${target}`);
      const session = await store.create({ name: "Guarded built-in child", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      await store.setExtension(row, c, { name: "durable-guards", enabled: false });
      const submission = await store.submitAuthenticatedUserMessage(row, c, { content: "launch built-in child", requestId: "launch-built-in-child" });
      assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
      assert.equal(existsSync(target), true, "the child's destructive command is blocked");
      const child = (await store.agents(row, undefined, true)).find((agent) => agent.kind === "subagent");
      assert.ok(child);
      const childConversation = (await store.resolveAgent(session.id, String(child.id))).c;
      assert.ok((await store.agentDetail(row, childConversation)).extensions.includes("durable-guards"));
      assert.match(JSON.stringify((await store.entries(childConversation, undefined, 100)).items), /DPI_GUARD_BLOCKED:/);
    });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("durable job helper agents inherit guards despite explicit tool configuration", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  const target = join(fixture.root, "job-target");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await mkdir(target);
    await withOnboardingEnv(setupDir, async () => {
      store = await fixture.open();
      fakeJobModel(store, `rm -rf ${target}`);
      const session = await store.create({ name: "Guarded job helper", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const { taskId } = await store.startJob(row, h, c, { job: "release-check", input: { commits: 2 } });
      const runOf = async () => (await store!.agentDoc(h, c, JOB_RUNS_DOC) as { items: Record<string, { status: string; phase: string; approval?: string; childConversationId?: number }> }).items[String(taskId)];
      await until(async () => (await runOf())?.approval === "pending", 20_000, "release-check helper to finish gathering");
      const run = await runOf();
      assert.ok(run.childConversationId, "release-check creates a helper child");
      assert.equal(existsSync(target), true, "job helper destructive command is blocked");
      const child = (await store.resolveAgent(session.id, String(run.childConversationId))).c;
      assert.ok((await store.agentDetail(row, child)).extensions.includes("durable-guards"));
      assert.match(JSON.stringify((await store.entries(child, undefined, 100)).items), /DPI_GUARD_BLOCKED:/);
      await store.approveJob(c, taskId, true);
      await until(async () => (await runOf())?.status === "completed", 20_000, "release-check to finish after native approval");
    });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("delegated expert children inherit destructive guards", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "setup");
  const target = join(fixture.root, "delegate-target");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await mkdir(target);
    await writeMemoryCli(setupDir);
    await withOnboardingEnv(setupDir, async () => {
      store = await fixture.open();
      fakeDelegateModel(store, `rm -rf ${target}`);
      const session = await store.create({ name: "Guarded delegate", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const submission = await store.submitAuthenticatedUserMessage(row, c, { content: "launch delegated destructive command", requestId: "launch-guarded-delegate" });
      assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
      assert.equal(existsSync(target), true, "the delegated bash command is blocked");
      const child = (await store.agents(row, undefined, true)).find((agent) => agent.kind === "subagent");
      assert.ok(child, "delegate creates an owned child");
      const childConversation = (await store.resolveAgent(session.id, String(child.id))).c;
      assert.ok((await store.agentDetail(row, childConversation)).extensions.includes("durable-guards"));
      assert.match(JSON.stringify((await store.entries(c, undefined, 100)).items), /DPI_GUARD_BLOCKED:/);
    }, { memory: "local" });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("ticket worker destructive command blocks its ticket and releases the device queue", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "setup");
  const repo = join(fixture.root, "projects", "repo");
  const origin = join(fixture.root, "origin.git");
  const fakeBin = join(fixture.root, "fake-bin");
  const target = join(fixture.root, "ticket-target");
  const at = new Date().toISOString();
  const ticketId = "guarded-ticket";
  const nextTicketId = "ticket-after-guard";
  let store: Store | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(target);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    execFileSync("git", ["config", "user.name", "Guard Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "guard-test@example.invalid"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "guard test fixture\\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
    execFileSync("git", ["push", "--set-upstream", "origin", "main"], { cwd: repo });
    execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: repo });
    await writeMemoryCli(setupDir);
    await mkdir(fakeBin, { recursive: true });
    const fakeGh = join(fakeBin, "gh");
    await writeFile(fakeGh, "#!/bin/sh\\nexit 99\\n");
    await chmod(fakeGh, 0o755);

    await withOnboardingEnv(setupDir, async () => {
      store = await fixture.open();
      fakeTicketModel(store, `rm -rf ${target}`);
      const session = await store.create({ name: "Guarded ticket", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const tickets = new TicketStore((mutate) => store!.shared.transactTicketState((state) => mutate(state as Record<string, unknown>)));
      const ticket = (id: string): Ticket => ({
        id,
        title: "Guard destructive work",
        goal: "Never run an unapproved destructive shell command",
        decisions: [],
        acceptanceCriteria: ["The destructive command is blocked"],
        plan: [{ id: "build", expert: "backend-engineer", task: "Attempt the assigned safe implementation", dependsOn: [] }],
        tier: "small",
        repo,
        device: "test",
        status: "ready",
        log: [],
        createdAt: at,
        updatedAt: at,
      });
      await tickets.list();
      await tickets.add(ticket(ticketId));
      await tickets.add(ticket(nextTicketId));
      assert.equal((await tickets.get(ticketId))?.status, "ready", "ticket fixture is stored before starting the run");
      const submission = await store.submitAuthenticatedUserMessage(row, c, { content: "launch guarded ticket", requestId: "launch-guarded-ticket" });
      assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
      await until(async () => (await tickets.get(ticketId))?.status === "blocked", 30_000, "guarded ticket to block");

      const blocked = await tickets.get(ticketId);
      assert.equal(blocked?.status, "blocked");
      assert.match(blocked?.blockedNote ?? "", /TICKET_STATUS: BLOCKED: command needs approval \(rm -rf\)/);
      assert.equal(blocked?.runToken, undefined, "blocking releases the run lease");
      assert.equal(existsSync(target), true, "the ticket's destructive bash command never ran");
      const claimed = await tickets.claim(nextTicketId, "test", "next-run", 2, Date.now());
      assert.equal(claimed.claimed, true, "the next ready ticket can claim the released device queue");
    }, { memory: "local", path: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});
