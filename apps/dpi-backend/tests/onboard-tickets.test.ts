import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { parseReminderWhen } from "../src/onboard/remind.js";
import {
  buildPullRequestBody,
  completedTicketSlices,
  isTicketWorkPath,
  normalizeTicketPlan,
  openTicketPullRequest,
  prepareTicketWorktree,
  TicketStore,
  ticketBlocker,
  ticketChecks,
  ticketCompleted,
  validateTicketRepo,
  createTicketsExtension,
  type Ticket,
  type TicketPlan,
} from "../src/onboard/tickets.js";
import { hourStamp, nextTopOfHour, selectReadyTicket } from "../src/onboard/scheduler.js";

const now = Date.parse("2026-10-15T10:30:00.000Z");

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "20261015-1030-retry-login",
    title: "Retry login",
    goal: "Make login retry safely",
    decisions: ["Preserve the existing session"],
    acceptanceCriteria: ["Retries once", "Never duplicates a session"],
    plan: [{ id: "backend", expert: "backend-engineer", task: "Implement retry", dependsOn: [], verify: "pnpm test" }],
    tier: "small",
    repo: "/repos/app",
    device: "command-center",
    status: "ready",
    log: [],
    createdAt: "2026-10-15T10:30:00.000Z",
    updatedAt: "2026-10-15T10:30:00.000Z",
    ...overrides,
  };
}

test("ticket work-path refusal matches plain-pi segment semantics", () => {
  assert.equal(isTicketWorkPath("/Users/ced/personal/app"), false);
  assert.equal(isTicketWorkPath("/Users/ced/work/app"), true);
  assert.equal(isTicketWorkPath("/Users/ced/work-laptop/app"), true);
  assert.equal(isTicketWorkPath("/Users/ced/office/app"), true);
  assert.equal(isTicketWorkPath("/Users/ced/workspace/app"), false);
  assert.equal(isTicketWorkPath("/Users/ced/WORK/app"), true);
});

test("ticket store atomically claims at most one device ticket and releases blocked work", async () => {
  let state: Record<string, unknown> = {};
  const store = new TicketStore(async (mutate) => mutate(state));
  await store.add(ticket());
  await store.add(ticket({ id: "20261015-1031-next", createdAt: "2026-10-15T10:31:00.000Z" }));

  const first = await store.claim("20261015-1030-retry-login", "command-center", "run-a", 101, now);
  assert.equal(first.claimed, true);
  assert.equal((await store.claim("20261015-1030-retry-login", "command-center", "run-a", 202, now)).claimed, true);
  const collidingTaskId = await store.claim("20261015-1031-next", "command-center", "run-b", 101, now);
  assert.equal(collidingTaskId.claimed, false, "task ids can collide across per-session harnesses");
  const concurrent = await store.claim("20261015-1031-next", "command-center", "run-c", 102, now);
  assert.equal(concurrent.claimed, false);
  assert.match(concurrent.reason ?? "", /already in progress/i);
  await assert.rejects(store.update("20261015-1030-retry-login", "done", "cancel", now), /in progress/);
  await assert.rejects(store.update("20261015-1031-next", "in-progress", undefined, now), /durable run/);

  await store.block("20261015-1030-retry-login", "Need credentials", now + 1000);
  const next = await store.claim("20261015-1031-next", "command-center", "run-d", 103, now + 2000);
  assert.equal(next.claimed, true, "a blocked ticket must not hold the queue");
  const blocked = await store.get("20261015-1030-retry-login");
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.blockedNote, "Need credentials");
});

test("ticket claims enforce device affinity and hourly scheduler idempotency", async () => {
  let state: Record<string, unknown> = {};
  const store = new TicketStore(async (mutate) => mutate(state));
  await store.add(ticket({ device: "home-mac" }));
  const wrongDevice = await store.claim("20261015-1030-retry-login", "command-center", "run-a", 101, now);
  assert.equal(wrongDevice.claimed, false);
  assert.match(wrongDevice.reason ?? "", /belongs to home-mac/i);
  assert.equal(await store.recordHour("2026-10-15T11:00:00.000Z"), true);
  assert.equal(await store.recordHour("2026-10-15T11:00:00.000Z"), false);
});

test("planning rejects dependencies that cannot be completed in pipeline order", () => {
  const plan = {
    title: "Ordered plan",
    goal: "Run dependencies in order",
    decisions: [],
    acceptanceCriteria: ["Dependencies precede dependents"],
    tier: "small",
    repo: "/repos/app",
    plan: [
      { id: "build", expert: "backend-engineer", task: "Implement", dependsOn: ["qa"] },
      { id: "qa", expert: "qa", task: "Verify", dependsOn: [] },
    ],
  };
  assert.throws(() => normalizeTicketPlan(plan), /must precede/);
  assert.throws(() => normalizeTicketPlan({ ...plan, plan: [
    { id: "qa", expert: "qa", task: "Verify", dependsOn: ["review"] },
    { id: "review", expert: "reviewer", task: "Review", dependsOn: [] },
  ] }), /must precede/);
  assert.doesNotThrow(() => normalizeTicketPlan({ ...plan, plan: [
    { id: "qa", expert: "qa", task: "Verify", dependsOn: ["build"] },
    { id: "build", expert: "backend-engineer", task: "Implement", dependsOn: [] },
  ] }));
});

test("QA and review dependencies wait for every earlier pipeline slice", () => {
  const planned = ticket({
    plan: [
      { id: "build-a", expert: "backend-engineer", task: "Build", dependsOn: [] },
      { id: "build-b", expert: "frontend-engineer", task: "Build UI", dependsOn: ["build-a"] },
      { id: "qa", expert: "qa", task: "Verify", dependsOn: ["build-b"] },
      { id: "reviewer", expert: "reviewer", task: "Review", dependsOn: ["qa"] },
    ],
  });
  assert.deepEqual([...completedTicketSlices(planned, "build", 1)].sort(), ["build-a"]);
  assert.deepEqual([...completedTicketSlices(planned, "qa", 0)].sort(), ["build-a", "build-b"]);
  assert.deepEqual([...completedTicketSlices(planned, "review", 0)].sort(), ["build-a", "build-b", "qa"]);
  assert.equal(ticketBlocker("TICKET_STATUS: BLOCKED: Need credentials"), "TICKET_STATUS: BLOCKED: Need credentials");
  assert.equal(ticketBlocker("NEEDS HUMAN: Confirm the data migration"), "NEEDS HUMAN: Confirm the data migration");
  assert.equal(ticketBlocker("TICKET_STATUS: COMPLETE"), undefined);
  assert.equal(ticketCompleted("TICKET_STATUS: COMPLETE"), true);
  assert.equal(ticketCompleted("Looks good"), false);
  assert.deepEqual(ticketChecks("Summary\nCHECK: pnpm test\ncheck: pnpm exec tsc --noEmit\n"), ["pnpm test", "pnpm exec tsc --noEmit"]);
});

test("scheduler selects the oldest usable device-affine ticket and reports invalid skips", async () => {
  const tickets = [
    ticket({ id: "old-invalid", createdAt: "2026-10-15T09:00:00.000Z" }),
    ticket({ id: "home-ticket", device: "home-mac", createdAt: "2026-10-15T09:30:00.000Z" }),
    ticket({ id: "next-valid", createdAt: "2026-10-15T10:00:00.000Z" }),
  ];
  const result = await selectReadyTicket(tickets, "command-center", async (candidate) =>
    candidate.id === "old-invalid" ? "repo is unavailable" : undefined,
  );
  assert.equal(result.ticket?.id, "next-valid");
  assert.deepEqual(result.skipped, [{ ticketId: "old-invalid", reason: "repo is unavailable" }]);
});

test("durable scheduler calculates top-of-hour deadlines and stable idempotency keys", () => {
  assert.equal(nextTopOfHour(now), Date.parse("2026-10-15T11:00:00.000Z"));
  assert.equal(nextTopOfHour(Date.parse("2026-10-15T11:00:00.000Z")), Date.parse("2026-10-15T11:00:00.000Z"));
  assert.equal(hourStamp(Date.parse("2026-10-15T11:47:00.000Z")), "2026-10-15T11:00:00.000Z");
});

test("reminder time parser accepts ISO timestamps and bounded relative durations", () => {
  assert.equal(parseReminderWhen("2026-10-15T11:00:00.000Z", now), Date.parse("2026-10-15T11:00:00.000Z"));
  assert.equal(parseReminderWhen("in 10m", now), now + 10 * 60_000);
  assert.equal(parseReminderWhen("2h", now), now + 2 * 60 * 60_000);
  assert.throws(() => parseReminderWhen("yesterday", now), /ISO timestamp or duration/i);
  assert.throws(() => parseReminderWhen("in 0m", now), /positive duration/i);
});

test("root ticket tools plan, list, update, and reject child use", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-ticket-tools-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  let state: Record<string, unknown> = {};
  const memory = { call: async <T>() => ({}) as T };
  const plan: TicketPlan = {
    title: "Retry login",
    goal: "Make login retry safely",
    decisions: ["Preserve the existing session"],
    acceptanceCriteria: ["Retries once", "Never duplicates a session"],
    plan: [{ id: "backend", expert: "backend-engineer", task: "Implement retry", dependsOn: [], verify: "pnpm test" }],
    tier: "small",
    repo,
  };
  const process = async (_command: string, args: readonly string[], options: { cwd?: string }) => ({
    stdout: args[0] === "rev-parse" ? options.cwd ?? "" : "git@github.com:acme/repo.git",
    stderr: "",
  });
  try {
    const extension = createTicketsExtension(
      { transactAppState: async (change) => change(state as never) },
      { device: "command-center", childExtensionNames: [], memory, process, now: () => now, plan: async () => plan },
    );
    const tools = new Map(extension.tools?.map((tool) => [tool.name, tool]));
    const memo = new Map<string, unknown>();
    const api = (conversationId = ROOT_CONVERSATION_ID, taskId = 500) => ({
      taskId,
      conversationId,
      callId: `call-${taskId}`,
      agent: async () => ({ cwd: repo }),
      memo: async (name: string, ...args: unknown[]) => {
        if (args.length > 1 && !memo.has(name)) memo.set(name, args[0]);
        return memo.get(name);
      },
      commit: async (change: (tx: unknown) => unknown) => change({
        doc: async () => ({ runs: {} }),
        createTask: async () => 700,
      }),
      details: async () => {},
    });
    const add = tools.get("add_ticket");
    const list = tools.get("list_tickets");
    const update = tools.get("update_ticket");
    assert.ok(add && list && update);
    const added = await add.execute({ request: "Retry login" } as never, api() as never, BACKGROUND_CONTEXT);
    const text = added.content?.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
    assert.match(text, /ready on command-center/);
    const stored = await new TicketStore(async (change) => change(state)).list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "ready");
    const listed = await list.execute({} as never, api() as never, BACKGROUND_CONTEXT);
    assert.match(listed.content?.map((part) => part.type === "text" ? part.text : "").join("") ?? "", /Retry login/);
    await update.execute({ id: stored[0].id, status: "blocked", note: "Need access" } as never, api(ROOT_CONVERSATION_ID, 501) as never, BACKGROUND_CONTEXT);
    assert.equal((await new TicketStore(async (change) => change(state)).get(stored[0].id))?.blockedNote, "Need access");
    await assert.rejects(list.execute({} as never, api((ROOT_CONVERSATION_ID + 1) as typeof ROOT_CONVERSATION_ID, 502) as never, BACKGROUND_CONTEXT), /root conversations/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo validation refuses non-git, no-origin, and work-path repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-ticket-repo-"));
  try {
    const plain = join(root, "plain");
    const repo = join(root, "repo");
    const workRepo = join(root, "work", "repo");
    const workAlias = join(root, "repo-alias");
    await mkdir(plain);
    await mkdir(repo);
    await mkdir(workRepo, { recursive: true });
    await import("node:fs/promises").then(({ symlink }) => symlink(workRepo, workAlias));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q"]);
    assert.match((await validateTicketRepo(plain)) ?? "", /not the root of a git repository/);
    assert.match((await validateTicketRepo(repo)) ?? "", /no origin remote/);
    assert.match((await validateTicketRepo(workRepo)) ?? "", /work repos are excluded/);
    assert.match((await validateTicketRepo(workAlias)) ?? "", /work repos are excluded/);
    git(["remote", "add", "origin", "git@github.com:acme/repo.git"]);
    assert.equal(await validateTicketRepo(repo), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ticket worktree starts from origin default and reuses the same branch after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-ticket-worktree-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  try {
    await mkdir(repo);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    execFileSync("git", ["config", "user.name", "Ticket Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "ticket-test@example.invalid"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: repo });
    const current = ticket({ repo });
    const first = await prepareTicketWorktree(current);
    const resumed = await prepareTicketWorktree({ ...current, worktree: first.worktree, branch: first.branch });
    assert.equal(first.branch, `ticket/${current.id}`);
    assert.equal(resumed.worktree, first.worktree);
    assert.match(resumed.base, /existing worktree/);
    const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(listing.split("\n").filter((line) => line === `worktree ${first.worktree}`).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR creation reuses an existing branch PR and never invokes merge", async () => {
  const calls: string[][] = [];
  let existing = "https://github.com/acme/repo/pull/9";
  const process = async (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "status") return { stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: existing, stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: "https://github.com/acme/repo/pull/10", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const first = await openTicketPullRequest(ticket(), "/tmp/ticket-worktree", "ticket/123", ["pnpm test"], process);
  const second = await openTicketPullRequest(ticket(), "/tmp/ticket-worktree", "ticket/123", ["pnpm test"], process);
  assert.equal(first, existing);
  assert.equal(second, existing);
  assert.equal(calls.filter((call) => call[1] === "pr" && call[2] === "create").length, 0);
  assert.equal(calls.some((call) => call.includes("merge")), false);
  existing = "";
  assert.equal(await openTicketPullRequest(ticket(), "/tmp/ticket-worktree", "ticket/123", [], process), "https://github.com/acme/repo/pull/10");
  assert.equal(calls.filter((call) => call[1] === "pr" && call[2] === "create").length, 1);
});

test("pull request body contains goal, criteria, and checks without any merge directive", () => {
  const body = buildPullRequestBody(ticket(), ["pnpm test", "pnpm exec tsc --noEmit"]);
  assert.match(body, /Make login retry safely/);
  assert.match(body, /Retries once/);
  assert.match(body, /Never duplicates a session/);
  assert.match(body, /pnpm test/);
  assert.match(body, /pnpm exec tsc --noEmit/);
  assert.doesNotMatch(body, /gh pr merge|merge this PR/i);
});
