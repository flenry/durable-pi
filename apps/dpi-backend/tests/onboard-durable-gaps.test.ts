import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { Store, type StoreOptions } from "../src/store.js";
import { ExpertIdentity } from "../src/onboard/experts.js";
import { TicketStore, type Ticket, type TicketCheckpoint } from "../src/onboard/tickets.js";

const context = BACKGROUND_CONTEXT;

type FakeMessage = ReturnType<typeof fauxAssistantMessage>;
type ModelRequest = { prompt: string; signal?: AbortSignal; afterToolResult: boolean };
type ModelResponder = (request: ModelRequest) => FakeMessage | Promise<FakeMessage>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part)
      return typeof part.text === "string" ? part.text : "";
    return "";
  }).join("");
}

function installFakeModel(store: Store, respond: ModelResponder) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Fixture faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript, options) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") {
        lastUser = index;
        break;
      }
    }
    const prompt = lastUser >= 0 ? textOf(messages[lastUser].content) : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    return respond({ prompt, signal: options?.signal, afterToolResult });
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
  return fake;
}

async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeMemoryCliFixture(root: string): Promise<string> {
  const setupDir = join(root, "setup");
  await mkdir(join(setupDir, "bin"), { recursive: true });
  await mkdir(join(setupDir, "experts"), { recursive: true });
  await mkdir(join(setupDir, "agent", "skills"), { recursive: true });
  await writeFile(join(setupDir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(setupDir, "bin", "pi-memory.ts"), `import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const command = process.argv[2];
const input = JSON.parse(raw);
let result = {};
if (command === "expert") {
  const gate = process.env.DPI_TEST_EXPERT_GATE;
  while (gate && existsSync(gate)) await delay(10);
  const name = typeof input.name === "string" ? input.name : "backend-engineer";
  result = {
    profile: { name, description: "Fixture expert", mode: "worktree", excludeTools: [], skills: [], body: "# Fixture expert\\nComplete the assigned slice." },
    model: { model: "faux/echo", thinking: "high" },
    bestPracticesIndex: "",
  };
} else if (command === "roster") {
  result = [{ name: "backend-engineer", description: "Fixture backend engineer", model: "faux/echo", thinking: "high" }];
} else if (command === "index") {
  result = { index: "" };
} else if (command === "read") {
  result = { text: "" };
} else if (command === "note") {
  result = { file: "notes/history.md", chars: 1, overCap: false, created: true };
} else if (command === "rewrite") {
  result = { file: "notes/history.md", chars: 1, overCap: false, created: false, deleted: false };
}
process.stdout.write(JSON.stringify(result));
`);
  return setupDir;
}

async function writeFakeGh(root: string): Promise<string> {
  const bin = join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const gh = join(bin, "gh");
  await writeFile(gh, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf 'create\\n' >> "$DPI_TEST_GH_LOG"
  printf '%s\\n' 'https://github.com/example/project/pull/42'
  exit 0
fi
printf 'unexpected fake gh command\\n' >&2
exit 2
`);
  await chmod(gh, 0o755);
  return bin;
}

function storeOptions(root: string, startDir: string): StoreOptions {
  return { dataDir: join(root, "data"), startDirs: [startDir], name: "fixture-device", provider: "faux" };
}

async function openStorePaused(options: StoreOptions): Promise<{ store: Store; resume(): void }> {
  // Store.open resumes recovered sessions before returning; defer only that scheduling until the fake provider is installed.
  const pending: (() => void)[] = [];
  const originalOpen = Harness.open;
  const mutableHarness = Harness as { open: typeof Harness.open };
  mutableHarness.open = (async (...args: Parameters<typeof originalOpen>) => {
    const harness = await originalOpen(...args);
    const resume = harness.resume.bind(harness);
    harness.resume = () => { pending.push(resume); };
    return harness;
  }) as typeof originalOpen;
  let store: Store;
  try {
    store = await Store.open(options);
  } finally {
    mutableHarness.open = originalOpen;
  }
  return { store, resume: () => { for (const resume of pending) resume(); } };
}

function git(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createLocalRepo(root: string): Promise<string> {
  const repo = join(root, "project", "repo");
  const origin = join(root, "origin.git");
  await mkdir(repo, { recursive: true });
  git(undefined, ["init", "--bare", "--initial-branch=main", origin]);
  git(undefined, ["init", "--initial-branch=main", repo]);
  git(repo, ["config", "user.name", "Ticket Test"]);
  git(repo, ["config", "user.email", "ticket-test@example.invalid"]);
  await writeFile(join(repo, "README.md"), "fixture repository\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "--set-upstream", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  return repo;
}

function makeTicket(repo: string, id: string): Ticket {
  const at = new Date().toISOString();
  return {
    id,
    title: "Durable recovery fixture",
    goal: "Resume delegated build work without duplicating resources",
    decisions: [],
    acceptanceCriteria: ["Both build slices complete exactly once"],
    plan: [
      { id: "build-first", expert: "backend-engineer", task: "Complete the first build slice", dependsOn: [] },
      { id: "build-second", expert: "backend-engineer", task: "Complete the second build slice", dependsOn: ["build-first"] },
    ],
    tier: "small",
    repo,
    device: "fixture-device",
    status: "ready",
    log: [],
    createdAt: at,
    updatedAt: at,
  };
}

function ticketStoreFor(store: Store): TicketStore {
  return new TicketStore((mutate) => store.shared.transactAppState((state) => mutate(state as Record<string, unknown>)));
}

function rowTicketModel(options: {
  ticketId: string;
  onFirstBuildStarted: () => void;
  buildCalls: Map<string, number>;
}): ModelResponder {
  return ({ prompt, signal, afterToolResult }) => {
    if (prompt === "launch durable ticket" && !afterToolResult)
      return fauxAssistantMessage([fauxToolCall("run_ticket", { id: options.ticketId })], { stopReason: "toolUse" });

    const slice = /Phase: build\. Slice ([^:]+):/.exec(prompt)?.[1];
    if (slice) {
      const count = (options.buildCalls.get(slice) ?? 0) + 1;
      options.buildCalls.set(slice, count);
      if (slice === "build-first" && count === 1) {
        options.onFirstBuildStarted();
        if (!signal) throw new Error("The faux build model needs its cancellation signal");
        return new Promise<FakeMessage>((resolve) => {
          if (signal.aborted) {
            resolve(fauxAssistantMessage("interrupted"));
            return;
          }
          signal.addEventListener("abort", () => resolve(fauxAssistantMessage("interrupted")), { once: true });
        });
      }
      if (slice === "build-first" && count === 2) return fauxAssistantMessage("");
      return fauxAssistantMessage("CHECK: pnpm exec tsc --noEmit -p .\nTICKET_STATUS: COMPLETE");
    }
    return fauxAssistantMessage("Done.");
  };
}

test("ticket build resumes after Store close/reopen without duplicate children, worktrees, or PRs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-ticket-recovery-"));
  const repo = await createLocalRepo(root);
  const setupDir = await writeMemoryCliFixture(root);
  const fakeBin = await writeFakeGh(root);
  const startDir = join(root, "projects");
  await mkdir(startDir, { recursive: true });
  const options = storeOptions(root, startDir);
  const ticketId = "20261015-1030-durable-recovery";
  const gatePath = join(root, "hold-expert-cli");
  const ghLog = join(root, "gh.log");
  const env = {
    DPI_ONBOARD: "1",
    DPI_MEMORY: "local",
    DPI_TICKETS: "0",
    PI_SETUP_DIR: setupDir,
    DPI_TEST_EXPERT_GATE: gatePath,
    DPI_TEST_GH_LOG: ghLog,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const buildCalls = new Map<string, number>();
  let notifyFirstBuild!: () => void;
  const firstBuildStarted = new Promise<void>((resolve) => { notifyFirstBuild = resolve; });
  const responder = rowTicketModel({ ticketId, onFirstBuildStarted: () => notifyFirstBuild(), buildCalls });
  let store: Store | undefined;
  try {
    await withEnvironment(env, async () => {
      store = await Store.open(options);
      installFakeModel(store, responder);
      const session = await store.create({ name: "Ticket recovery fixture", cwd: repo, model: { provider: "faux", modelId: "echo" } });
      const tickets = ticketStoreFor(store);
      await tickets.list();
      await tickets.add(makeTicket(repo, ticketId));
      await tickets.add(makeTicket(repo, "20261015-1031-next-ticket"));
      const { h, c } = await store.resolveAgent(session.id, "main");
      const submission = await store.send(c, { content: "launch durable ticket", requestId: "launch-durable-ticket" });
      assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
      await withTimeout(firstBuildStarted, 20_000, "first delegated build model request");

      const running = await tickets.get(ticketId);
      assert.equal(running?.status, "in-progress");
      assert.ok(running?.runTaskId);
      const taskId = running.runTaskId as TaskId;
      const beforeRestart = await h.getTask(taskId, context);
      const checkpoint = beforeRestart?.state as { status: string; checkpoint?: TicketCheckpoint };
      assert.equal(checkpoint.status, "running");
      assert.equal(checkpoint.checkpoint?.phase, "build");
      assert.deepEqual(Object.keys(checkpoint.checkpoint?.children ?? {}), ["build-first"]);
      const firstChildId = checkpoint.checkpoint?.children["build-first"];
      assert.ok(firstChildId);
      assert.ok(checkpoint.checkpoint?.worktree);
      const ownedBefore = await h.commit(async (tx) => (await tx.scanConversations({ ownerTaskId: taskId }, 50)).items, context);
      assert.equal(ownedBefore.length, 1);

      await writeFile(gatePath, "hold");
      await store.close();
      store = undefined;

      const recovery = await openStorePaused(options);
      store = recovery.store;
      installFakeModel(store, responder);
      await rm(gatePath, { force: true });
      recovery.resume();
      const reopened = store.row(session.id);
      const reopenedHarness = store.harness(reopened);
      const resumedTicket = await ticketStoreFor(store).get(ticketId);
      assert.ok(resumedTicket?.runTaskId);
      await waitUntil(async () => (await ticketStoreFor(store!).get(ticketId))?.status === "done", 30_000, "ticket completion after restart");

      const complete = await ticketStoreFor(store).get(ticketId);
      assert.equal(complete?.status, "done");
      assert.equal(complete?.pr, "https://github.com/example/project/pull/42");
      assert.deepEqual(await ticketStoreFor(store).claim("20261015-1031-next-ticket", "fixture-device", "queue-probe", 999, Date.now()), { claimed: true },
        "completing the ticket releases the device queue");

      const finalTask = await reopenedHarness.getTask(taskId, context);
      const terminalState = finalTask?.state as { status: string; outcome?: { status: string; result?: { status?: string } } };
      assert.equal(terminalState.status, "terminal");
      assert.equal(terminalState.outcome?.result?.status, "done");
      const ownedAfter = await reopenedHarness.commit(async (tx) => (await tx.scanConversations({ ownerTaskId: taskId }, 50)).items, context);
      assert.equal(ownedAfter.length, 2, "one delegated child exists for each build slice");
      assert.ok(ownedAfter.some((child) => child.id === firstChildId), "the interrupted slice reuses its original child");
      const sliceIds = await Promise.all(ownedAfter.map(async (child) => {
        const identity = await reopenedHarness.snapshot(ExpertIdentity, child.id, context);
        return (identity as { ticketSliceId?: string } | undefined)?.ticketSliceId;
      }));
      assert.deepEqual(sliceIds.sort(), ["build-first", "build-second"]);
      assert.deepEqual([...buildCalls.keys()].sort(), ["build-first", "build-second"]);
      assert.equal(buildCalls.get("build-first"), 3, "the interrupted child is resumed, then retried once after an empty answer");
      assert.equal(buildCalls.get("build-second"), 1);

      const worktrees = git(repo, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line === `worktree ${complete?.worktree}`);
      assert.equal(worktrees.length, 1, "the ticket has exactly one registered worktree");
      const ghCalls = await readFile(ghLog, "utf8").catch(() => "");
      assert.equal(ghCalls.trim().split(/\r?\n/).filter(Boolean).length, 1, "fake gh creates exactly one PR");
    });
  } finally {
    await store?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function reminderTaskFor(store: Store, sessionId: string, when: number) {
  const { h } = await store.resolveAgent(sessionId, "main");
  const records = await h.commit((tx) => tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: "dpi.reminder" }, 200), context);
  const record = records.items.find((task) => (task.input as { when?: number }).when === when);
  assert.ok(record, `reminder task exists for ${new Date(when).toISOString()}`);
  return record;
}

async function reminderEvents(store: Store, sessionId: string, reminderId: string) {
  const { c } = await store.resolveAgent(sessionId, "main");
  const page = await c.entries({}, 1000, undefined, context);
  return page.items.filter((entry) => entry.kind === "dpi.reminder" && (entry.data as { id?: string } | undefined)?.id === reminderId);
}

function reminderResponder(requests: Map<string, { when: number; message: string }>): ModelResponder {
  return ({ prompt, afterToolResult }) => {
    if (!afterToolResult && prompt.startsWith("schedule-reminder:")) {
      const request = requests.get(prompt);
      assert.ok(request, `test reminder request is configured: ${prompt}`);
      return fauxAssistantMessage([fauxToolCall("remind", {
        when: new Date(request.when).toISOString(),
        message: request.message,
      })], { stopReason: "toolUse" });
    }
    if (!afterToolResult && prompt.startsWith("cancel-reminder:")) {
      return fauxAssistantMessage([fauxToolCall("cancel_reminder", { id: prompt.slice("cancel-reminder:".length) })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Done.");
  };
}

test("reminders fire once through the durable timer after Store restart and cancellation survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-reminder-recovery-"));
  const setupDir = await writeMemoryCliFixture(root);
  const startDir = join(root, "projects");
  await mkdir(startDir, { recursive: true });
  const options = storeOptions(root, startDir);
  const requests = new Map<string, { when: number; message: string }>();
  const responder = reminderResponder(requests);
  const env = { DPI_ONBOARD: "1", DPI_MEMORY: "local", DPI_TICKETS: "0", PI_SETUP_DIR: setupDir };
  let store: Store | undefined;
  try {
    await withEnvironment(env, async () => {
      store = await Store.open(options);
      installFakeModel(store, responder);
      const session = await store.create({ name: "Reminder recovery fixture", cwd: startDir, model: { provider: "faux", modelId: "echo" } });
      const fireAt = Date.now() + 4_000;
      requests.set("schedule-reminder:fire", { when: fireAt, message: "fire after restart" });
      let { row, h, c } = await store.resolveAgent(session.id, "main");
      const scheduled = await store.send(c, { content: "schedule-reminder:fire", requestId: "schedule-reminder-fire" });
      assert.equal((await store.settled(h, scheduled.id as number, 20_000)).status, "done");
      const fireTask = await reminderTaskFor(store, session.id, fireAt);
      const fireInput = fireTask.input as { id: string; when: number };
      assert.ok(Date.now() < fireAt, "the Store closes before the reminder is due");

      await store.close();
      store = undefined;
      store = await Store.open(options);
      installFakeModel(store, responder);
      assert.ok(Date.now() < fireAt, "the Store reopens before the reminder is due");
      await waitUntil(async () => (await reminderEvents(store!, session.id, fireInput.id)).length === 1, 12_000, "reminder firing after restart");
      const reopenedRow = store.row(session.id);
      h = store.harness(reopenedRow);
      await waitUntil(async () => (await h.getTask(fireTask.id, context))?.state.status === "terminal", 5_000, "fired reminder task to finish");
      assert.equal((await reminderEvents(store, session.id, fireInput.id)).length, 1, "the reminder appends one firing entry");
      await store.close();
      store = undefined;
      store = await Store.open(options);
      installFakeModel(store, responder);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await reminderEvents(store, session.id, fireInput.id)).length, 1, "a terminal reminder does not fire again after another restart");

      const cancelAt = Date.now() + 4_000;
      requests.set("schedule-reminder:cancel", { when: cancelAt, message: "must remain cancelled" });
      ({ row, h, c } = await store.resolveAgent(session.id, "main"));
      const scheduledForCancel = await store.send(c, { content: "schedule-reminder:cancel", requestId: "schedule-reminder-cancel" });
      assert.equal((await store.settled(h, scheduledForCancel.id as number, 20_000)).status, "done");
      const cancelTask = await reminderTaskFor(store, session.id, cancelAt);
      const cancelInput = cancelTask.input as { id: string; when: number };
      const cancel = await store.send(c, { content: `cancel-reminder:${cancelInput.id}`, requestId: "cancel-durable-reminder" });
      assert.equal((await store.settled(h, cancel.id as number, 20_000)).status, "done");
      await waitUntil(async () => (await h.getTask(cancelTask.id, context))?.state.status === "terminal", 5_000, "cancelled reminder task to stop");
      assert.ok(Date.now() < cancelAt, "cancellation completes before the reminder is due");

      await store.close();
      store = undefined;
      store = await Store.open(options);
      installFakeModel(store, responder);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, cancelAt - Date.now() + 150)));
      assert.equal((await reminderEvents(store, session.id, cancelInput.id)).length, 0, "a cancelled reminder never appends a firing entry");
    });
  } finally {
    await store?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
