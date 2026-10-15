import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, defineTask, type Tx } from "@earendil-works/pi-durable";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";
import type { MemoryClient } from "../src/onboard/memory-client.js";
import { createMemoryExtension } from "../src/onboard/memory.js";
import { createExpertsExtension, DelegateChildren, ExpertIdentity } from "../src/onboard/experts.js";

const context = BACKGROUND_CONTEXT;

const HoldingTask = defineTask<{}, { phase: "hold" }, { done: true }>({
  name: "test.holding-task",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, ctx) => {
      for (;;) await runtime.sleep(runtime.now() + 1000, ctx);
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});

function expertResponse(name: string) {
  return {
    profile: {
      name,
      description: `${name} fixture expert`,
      mode: "worktree",
      excludeTools: name === "reviewer" ? ["edit", "write"] : name === "frontend-engineer" ? ["read"] : [],
      skills: ["/fixture/skills/codebase-design"],
      body: "# Role\nYou review the work.\n\n## Directives\n\nKeep it evidence-based.",
      directives: "Keep it evidence-based.",
    },
    model: { model: "faux/echo", thinking: "high" },
    bestPracticesIndex: "notes/worked.md — current practice",
  };
}

function fixtureClient(): MemoryClient {
  return {
    call: async <T>(command: string, input: object) => {
      if (command === "expert") return expertResponse(String((input as { name?: unknown }).name)) as T;
      if (command === "roster") return [
        { name: "backend-engineer", description: "Backend expert", model: "faux/echo", thinking: "high" },
        { name: "reviewer", description: "Read-only reviewer", model: "faux/echo", thinking: "high" },
      ] as T;
      if (command === "index") return { index: "project memory" } as T;
      return { file: "notes/topic.md", chars: 1, overCap: false, created: true } as T;
    },
  };
}

function expertHarnessApi(options: { taskId?: number; conversationId?: number; cwd?: string } = {}) {
  const taskId = options.taskId ?? 10;
  const conversationId = options.conversationId ?? ROOT_CONVERSATION_ID;
  const state = {
    nextId: ROOT_CONVERSATION_ID + 1,
    conversations: [] as { id: number; owner?: { conversationId: number; taskId: number } }[],
    agents: new Map<number, Record<string, unknown>>(),
    identities: new Map<number, { expert: string; worktree?: { repoRoot: string; path: string; branch: string; baseCommit: string } }>(),
    delegateChildren: { children: {} as Record<string, number> },
    tasks: new Map<number, { state: { status: string } }>([[taskId, { state: { status: "running" } }]]),
    submissions: [] as { content: string; requestId: string }[],
    details: [] as unknown[],
  };
  const tx = {
    scanConversations: async (query: { ownerTaskId?: number }) => ({
      items: state.conversations.filter((record) => query.ownerTaskId === undefined || record.owner?.taskId === query.ownerTaskId),
    }),
    createConversation: async ({ ownership }: { ownership: { taskId: number } }) => {
      const id = state.nextId++;
      const record = { id, owner: { conversationId, taskId: ownership.taskId } };
      state.conversations.push(record);
      state.agents.set(id, {
        extensions: ["coding-tools", "playground", "skills", "memory", "web", "playbook", "experts"],
        tools: ["bash", "read", "write", "edit", "memory_note", "memory_rewrite", "delegate"],
        cwd: options.cwd ?? "/repo",
      });
      return record;
    },
    doc: async (token: unknown, id?: number) => {
      if (token === AgentDoc) {
        const agent = state.agents.get(id!) ?? {};
        state.agents.set(id!, agent);
        return agent;
      }
      if (token === ExpertIdentity) {
        const identity = state.identities.get(id!) ?? { expert: "" };
        state.identities.set(id!, identity);
        return identity;
      }
      if (token === DelegateChildren) return state.delegateChildren;
      throw new Error("unexpected document");
    },
    task: async (id: number) => state.tasks.get(id),
    entry: async () => ({ model: [{ role: "assistant", content: [{ type: "text", text: "Fixture answer" }] }] }),
  };
  const api = {
    taskId,
    conversationId,
    callId: "call-delegate",
    agent: async () => ({ cwd: options.cwd ?? "/repo", model: { provider: "faux", modelId: "echo" } }),
    commit: async <T>(change: (transaction: typeof tx) => T | Promise<T>) => change(tx),
    snapshot: async (token: unknown, id: number) => token === ExpertIdentity ? state.identities.get(id) : undefined,
    details: async (details: unknown) => { state.details.push(details); },
    conversation: async (id: number) => ({
      submit: async (submission: { content: string; requestId: string }) => {
        state.submissions.push(submission);
        return { wait: async () => ({ status: "done", type: "input", answer: id }) };
      },
    }),
  };
  return { api, state, tx };
}

function extensionForExperts(options: { maxChildren?: number; writeTools?: ReadonlySet<string> } = {}) {
  const client = fixtureClient();
  const children = ["coding-tools", "memory", "skills", "web"].map((name) => ({ name })) as never[];
  return createExpertsExtension(client, { maxChildren: options.maxChildren ?? 2, childExtensions: children, writeTools: options.writeTools ?? new Set(["bash", "write", "edit", "memory_note", "memory_rewrite", "delegate"]) });
}

async function withExpertFixtureEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const original = { ...process.env };
  const basics = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, basics, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

test("memory actor and self come from the trusted conversation identity, never tool arguments", async () => {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const client: MemoryClient = {
    call: async <T>(command: string, input: object) => {
      const payload = input as Record<string, unknown>;
      calls.push({ command, input: payload });
      if (command === "note" && payload.scope === "expert" && payload.actor === "expert" && payload.expert !== payload.self)
        throw new Error("experts may only write their own best practices");
      return { file: "notes/topic.md", chars: 1, overCap: false, created: true } as T;
    },
  };
  const extension = createMemoryExtension(client, () => "github.com/acme/repo");
  const note = extension.tools?.find((tool) => tool.name === "memory_note");
  assert.ok(note);
  const rootApi = {
    conversationId: ROOT_CONVERSATION_ID,
    agent: async () => ({ cwd: "/repo" }),
    snapshot: async () => undefined,
  };
  await note.execute(
    { scope: "expert", topic: "worked", entry: "Root-authored", expert: "reviewer", actor: "expert", self: "reviewer" } as never,
    rootApi as never,
    context,
  );
  assert.deepEqual(calls[0].input, {
    scope: "expert",
    projectKey: "github.com/acme/repo",
    expert: "reviewer",
    topic: "worked",
    entry: "Root-authored",
    actor: "orchestrator",
  });

  const expertApi = {
    conversationId: ROOT_CONVERSATION_ID + 1,
    agent: async () => ({ cwd: "/repo" }),
    snapshot: async (token: unknown) => token === ExpertIdentity ? { expert: "backend-engineer" } : undefined,
  };
  await note.execute(
    { scope: "expert", topic: "worked", entry: "Owned learning", actor: "owner", self: "reviewer" } as never,
    expertApi as never,
    context,
  );
  assert.deepEqual(calls[1].input, {
    scope: "expert",
    projectKey: "github.com/acme/repo",
    expert: "backend-engineer",
    topic: "worked",
    entry: "Owned learning",
    actor: "expert",
    self: "backend-engineer",
  });

  await assert.rejects(
    note.execute(
      { scope: "expert", topic: "worked", entry: "Spoof", expert: "reviewer", actor: "orchestrator", self: "reviewer" } as never,
      expertApi as never,
      context,
    ),
    /own best practices/,
  );
  assert.equal(calls[2].input.actor, "expert");
  assert.equal(calls[2].input.self, "backend-engineer");
  assert.equal(calls[2].input.expert, "reviewer");

  await assert.rejects(
    note.execute(
      { scope: "expert", topic: "worked", entry: "No trusted identity", expert: "reviewer" } as never,
      { ...expertApi, snapshot: async () => undefined } as never,
      context,
    ),
    /trusted expert identity/,
  );
  assert.equal(calls.length, 3);
});

test("delegate creates a configured reviewer child with trusted identity and replay-safe ownership", async () => {
  const extension = extensionForExperts();
  const delegate = extension.tools?.find((tool) => tool.name === "delegate");
  assert.ok(delegate);
  assert.equal(delegate.replay, "safe");
  const fixture = expertHarnessApi();
  const result = await delegate.execute({ expert: "reviewer", task: "Review the current changes." } as never, fixture.api as never, context);

  assert.equal(fixture.state.conversations.length, 1);
  const childId = fixture.state.conversations[0].id;
  assert.equal(fixture.state.conversations[0].owner?.taskId, 10);
  assert.equal(fixture.state.identities.get(childId)?.expert, "reviewer");
  const child = fixture.state.agents.get(childId)!;
  assert.deepEqual(child.model, { provider: "faux", modelId: "echo" });
  assert.equal(child.thinkingLevel, "high");
  assert.match(String(child.instructions), /You review the work/);
  assert.match(String(child.instructions), /Keep it evidence-based/);
  assert.match(String(child.instructions), /memory_note/);
  assert.deepEqual(child.extensions, ["coding-tools", "memory", "skills", "web"]);
  assert.ok(Array.isArray(child.tools));
  assert.ok((child.tools as string[]).includes("read"));
  for (const name of ["bash", "write", "edit", "memory_note", "memory_rewrite", "delegate"])
    assert.equal((child.tools as string[]).includes(name), false, `${name} is excluded from the read-only reviewer`);
  assert.deepEqual(fixture.state.submissions, [{ type: "input", content: "Review the current changes.", requestId: "child:10" }]);
  assert.equal((result.details as { conversationId?: number } | undefined)?.conversationId, childId);
  assert.match(result.content?.map((part) => part.type === "text" ? part.text : "").join(" ") ?? "", /reviewer/);

  await delegate.execute({ expert: "reviewer", task: "Review the current changes." } as never, fixture.api as never, context);
  assert.equal(fixture.state.conversations.length, 1, "replaying a tool call reuses its owned child");
});

test("delegate honors profile excludeTools even when the expert is not read-only", async () => {
  const extension = extensionForExperts();
  const delegate = extension.tools?.find((tool) => tool.name === "delegate");
  assert.ok(delegate);
  const fixture = expertHarnessApi();
  await delegate.execute({ expert: "frontend-engineer", task: "Build the page." } as never, fixture.api as never, context);
  const child = fixture.state.agents.get(ROOT_CONVERSATION_ID + 1)!;
  assert.ok(Array.isArray(child.tools));
  assert.equal((child.tools as string[]).includes("read"), false);
  assert.equal((child.tools as string[]).includes("bash"), true, "non-read-only experts keep non-excluded tools");
});

test("delegate is root-only and the roster is shown only to the root", async () => {
  const extension = extensionForExperts();
  const delegate = extension.tools?.find((tool) => tool.name === "delegate");
  assert.ok(delegate);
  const child = expertHarnessApi({ conversationId: ROOT_CONVERSATION_ID + 1 });
  await assert.rejects(delegate.execute({ expert: "reviewer", task: "Review." } as never, child.api as never, context), /available only to root conversations/);
  assert.equal(child.state.conversations.length, 0);

  const roster = extension.sections?.find((item) => item.key === "expert-roster");
  assert.ok(roster);
  const render = (conversationId: number) => roster.render(
    { conversationId, agent: {}, env: undefined, shown: {}, read: {} } as never,
    context,
  );
  const rootText = await render(ROOT_CONVERSATION_ID);
  assert.match(rootText ?? "", /backend-engineer.*Backend expert/);
  assert.match(rootText ?? "", /reviewer.*Read-only reviewer/);
  assert.equal(await render(ROOT_CONVERSATION_ID + 1), undefined);
});

test("delegate returns a documented at-capacity result without creating another child", async () => {
  const extension = extensionForExperts({ maxChildren: 1 });
  const delegate = extension.tools?.find((tool) => tool.name === "delegate");
  assert.ok(delegate);
  const fixture = expertHarnessApi({ taskId: 11 });
  fixture.state.conversations.push({ id: ROOT_CONVERSATION_ID + 1, owner: { conversationId: ROOT_CONVERSATION_ID, taskId: 5 } });
  fixture.state.delegateChildren.children["5"] = ROOT_CONVERSATION_ID + 1;
  fixture.state.tasks.set(5, { state: { status: "running" } });
  const result = await delegate.execute({ expert: "reviewer", task: "Review." } as never, fixture.api as never, context);
  const text = result.content?.map((part) => part.type === "text" ? part.text : "").join(" ") ?? "";
  assert.match(text, /at capacity/i);
  assert.match(text, /retry after a child completes/i);
  assert.equal(fixture.state.conversations.length, 1);

  const terminal = expertHarnessApi({ taskId: 12 });
  terminal.state.conversations.push({ id: ROOT_CONVERSATION_ID + 1, owner: { conversationId: ROOT_CONVERSATION_ID, taskId: 5 } });
  terminal.state.delegateChildren.children["5"] = ROOT_CONVERSATION_ID + 1;
  terminal.state.tasks.set(5, { state: { status: "terminal" } });
  const accepted = await delegate.execute({ expert: "reviewer", task: "Review." } as never, terminal.api as never, context);
  assert.doesNotMatch(accepted.content?.map((part) => part.type === "text" ? part.text : "").join(" ") ?? "", /at capacity/i);
  assert.equal(terminal.state.conversations.length, 2, "terminal children no longer consume capacity");
  assert.equal(Object.hasOwn(terminal.state.delegateChildren.children, "5"), false, "terminal reservations are pruned");
});

test("worktree delegation branches from the parent HEAD and reuses its worktree after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-delegate-worktree-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "seed.txt"), "parent head\\n");
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "seed.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd: repo, stdio: "ignore" });
    const parentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const extension = extensionForExperts();
    const delegate = extension.tools?.find((tool) => tool.name === "delegate");
    assert.ok(delegate);
    const noGit = expertHarnessApi({ cwd: root });
    await assert.rejects(
      delegate.execute({ expert: "backend-engineer", task: "Implement safely.", worktree: true } as never, noGit.api as never, context),
      /worktree mode requires.*local Git repository/,
    );
    assert.equal(noGit.state.conversations.length, 0, "invalid worktree requests do not leave empty children");
    const fixture = expertHarnessApi({ cwd: repo });
    const args = { expert: "backend-engineer", task: "Implement the feature.", worktree: true };
    const first = await delegate.execute(args as never, fixture.api as never, context);
    const childId = fixture.state.conversations[0].id;
    const identity = fixture.state.identities.get(childId)!;
    assert.ok(identity.worktree);
    assert.equal(identity.worktree.branch, `durable/${childId}`);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: identity.worktree.path, encoding: "utf8" }).trim(), parentHead);
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: identity.worktree.path, encoding: "utf8" }).trim(), identity.worktree.branch);
    assert.equal(fixture.state.agents.get(childId)?.cwd, identity.worktree.path);
    const details = first.details as { worktree?: string; branch?: string } | undefined;
    assert.equal(details?.worktree, identity.worktree.path);
    assert.equal(details?.branch, identity.worktree.branch);

    const resumedExtension = extensionForExperts();
    const resumedDelegate = resumedExtension.tools?.find((tool) => tool.name === "delegate");
    assert.ok(resumedDelegate);
    await resumedDelegate.execute(args as never, fixture.api as never, context);
    const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(listing.split("\n").filter((line) => line === `worktree ${identity.worktree!.path}`).length, 1);
    assert.equal(fixture.state.conversations.length, 1, "the recovered tool call does not create a duplicate conversation or worktree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faux provider receives a fully configured durable reviewer child", async () => {
  const temp = await tempStore();
  const setupDir = join(temp.root, "setup");
  let store: Store | undefined;
  let cleanupOwner: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(setupDir, "bin"), { recursive: true });
    await mkdir(join(setupDir, "agent", "skills", "codebase-design"), { recursive: true });
    await writeFile(join(setupDir, "agent", "skills", "codebase-design", "SKILL.md"), "---\nname: codebase-design\ndescription: Deep-module design guidance\n---\n# Codebase design\n");
    await writeFile(join(setupDir, "bin", "pi-memory.ts"), [
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      "  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      "  const command = process.argv[2];",
      "  const profile = { name: input.name, description: 'Fixture reviewer', mode: 'worktree', excludeTools: ['edit', 'write'], skills: ['/fixture/skills/codebase-design'], body: '# Role\\nReview the work.\\n\\n## Directives\\n\\nCite evidence.' };",
      "  const value = command === 'expert' ? { profile, model: { model: 'faux/echo', thinking: 'high' }, bestPracticesIndex: 'notes/worked.md — reviewed patterns' } : command === 'roster' ? [{ name: 'reviewer', description: 'Fixture reviewer', model: 'faux/echo', thinking: 'high' }] : command === 'index' ? { index: 'project fixture memory' } : command === 'read' ? { text: '' } : { file: 'notes/topic.md', chars: 1, overCap: false, created: true };",
      "  process.stdout.write(JSON.stringify(value));",
      "});",
    ].join("\n"));

    await withExpertFixtureEnv({
      DPI_ONBOARD: "1",
      DPI_MEMORY: "local",
      DPI_MAX_CHILDREN: "2",
      DPI_SKILLS_EXCLUDE: "",
      PI_SETUP_DIR: setupDir,
    }, async () => {
      store = await temp.open();
      const session = await store!.create({ name: "Expert integration", cwd: temp.work, model: faux });
      const { row, h, c } = await store!.resolveAgent(session.id, "main");
      const ownerTaskId = await c.commit(
        (tx) => tx.createTask(HoldingTask, {}, { ownership: { kind: "conversation" } }),
        context,
      );
      cleanupOwner = () => h.abortTask(ownerTaskId, context).then(() => undefined);

      const parent = await c.agent(context);
      const delegate = parent.tools.find((tool) => tool.name === "delegate");
      assert.ok(delegate);
      const result = await delegate.execute(
        { expert: "reviewer", task: "Review the current implementation." } as never,
        {
          taskId: ownerTaskId,
          conversationId: c.id,
          callId: "test-delegate",
          agent: (ctx: typeof context) => c.agent(ctx),
          commit: (change: (tx: Tx) => unknown, ctx: typeof context) => c.commit(change, ctx),
          snapshot: (token: never, id: never, ctx: typeof context) => h.snapshot(token, id, ctx),
          details: async () => {},
          conversation: (id: never, ctx: typeof context) => h.conversation(id, ctx),
        } as never,
        context,
      );
      const details = result.details as { conversationId?: number } | undefined;
      assert.ok(details?.conversationId);
      const child = await h.conversation(details.conversationId as never, context);
      assert.ok(child);
      const childAgent = await child.agent(context);
      assert.deepEqual(childAgent.model, { provider: "faux", modelId: "echo" });
      assert.equal(childAgent.thinkingLevel, "high");
      assert.deepEqual(childAgent.extensions.map((extension) => extension.name), ["coding-tools", "memory", "skills", "web"]);
      assert.match(childAgent.instructions ?? "", /Review the work/);
      assert.match(childAgent.instructions ?? "", /Cite evidence/);
      const childDetail = await store!.agentDetail(row, child);
      assert.equal(childDetail.config.readOnly, true);
      for (const tool of childDetail.tools.filter((item) => item.writes)) assert.equal(tool.offered, false, tool.name);
      const transcript = JSON.stringify(await store!.activeEntries(child));
      assert.match(transcript, /notes\/worked\.md — reviewed patterns/);
      assert.match(transcript, /codebase-design/);
      assert.match(result.content?.map((part) => part.type === "text" ? part.text : "").join(" ") ?? "", /Expert reviewer completed/);

      await store!.close();
      store = undefined;
      cleanupOwner = undefined;
      store = await temp.open();
      const reopened = await store!.resolveAgent(session.id, "main");
      const childCountBeforeReplay = (await store!.agents(reopened.row)).length;
      const reopenedParent = await reopened.c.agent(context);
      const reopenedDelegate = reopenedParent.tools.find((tool) => tool.name === "delegate");
      assert.ok(reopenedDelegate);
      const replayed = await reopenedDelegate.execute(
        { expert: "reviewer", task: "Review the current implementation." } as never,
        {
          taskId: ownerTaskId,
          conversationId: reopened.c.id,
          callId: "test-delegate-replay",
          agent: (ctx: typeof context) => reopened.c.agent(ctx),
          commit: (change: (tx: Tx) => unknown, ctx: typeof context) => reopened.c.commit(change, ctx),
          snapshot: (token: never, id: never, ctx: typeof context) => reopened.h.snapshot(token, id, ctx),
          details: async () => {},
          conversation: (id: never, ctx: typeof context) => reopened.h.conversation(id, ctx),
        } as never,
        context,
      );
      assert.equal((replayed.details as { conversationId?: number } | undefined)?.conversationId, details.conversationId);
      assert.equal((await store!.agents(reopened.row)).length, childCountBeforeReplay, "restart replay reuses the durable child");
    });
  } finally {
    await cleanupOwner?.().catch(() => {});
    await store?.close();
    await temp.cleanup();
  }
});

test("trusted expert section renders the current best-practices index and listed skills", async () => {
  const client: MemoryClient = {
    call: async <T>(command: string) => {
      if (command === "expert") return {
        profile: { name: "backend-engineer", skills: ["/fixture/skills/codebase-design", "/fixture/skills/grill"] },
        bestPracticesIndex: "notes/worked.md — current practice",
      } as T;
      return { index: "project index" } as T;
    },
  };
  const extension = createMemoryExtension(client, () => "local/repo");
  const section = extension.sections?.find((item) => item.key === "expert-memory");
  assert.ok(section);
  const rendered = await section.render(
    {
      conversationId: ROOT_CONVERSATION_ID + 1,
      agent: { cwd: "/repo" },
      read: { snapshot: async (token: unknown) => token === ExpertIdentity ? { expert: "backend-engineer" } : undefined },
    } as never,
    context,
  );
  assert.match(rendered ?? "", /notes\/worked\.md — current practice/);
  assert.match(rendered ?? "", /codebase-design/);
  assert.match(rendered ?? "", /grill/);
  assert.doesNotMatch(rendered ?? "", /fixture\/skills/);
});
