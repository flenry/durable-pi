import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";
import { Store } from "../src/store.js";

const HoldingTask = defineTask<{}, { phase: "hold" }, { done: true }>({
  name: "test.close-holding-task",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, context) => {
      for (;;) await runtime.sleep(runtime.now() + 1000, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

test("agent close persists, hides descendants, and forks start open", async () => {
  const temp = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(temp.root, "home"), startDirs: temp.work, token });
  const client = new DpiClient(server.base, token);
  try {
    const session = await client.createSession({ name: "Close test", cwd: temp.work, model: faux });
    const main = client.agent(session.id, "main");
    await assert.rejects(
      () => main.setClosed(true),
      (error: DpiError) => error.code === "invalid" && error.status === 400,
    );

    const childId = (await client.session(session.id).createAgent({ name: "Reviewer" })).id;
    const child = client.agent(session.id, childId);
    assert.equal((await child.get()).closed, false);
    assert.equal((await child.send("seed a branch", "followUp", "close-seed", 15_000)).status, "done");
    const answer = (await child.entries({ scope: "active" })).items.find((entry) => entry.kind === "pi.assistant");
    assert.ok(answer);

    const closed = await child.setClosed(true);
    assert.equal(closed.closed, true);
    assert.equal(closed.busy, false);
    assert.equal(closed.background, 0);
    const fork = await child.fork({ entryId: answer.id, name: "Open fork" });
    assert.equal(fork.closed, false, "a fork gets its initial open state, not its source's closed state");

    const visible = await client.session(session.id).agents();
    assert.equal(visible.some((agent) => agent.id === childId), false);
    assert.equal(visible.some((agent) => agent.id === fork.id), false, "descendants stay hidden with their closed parent");
    const all = await client.session(session.id).agents({ closed: true });
    assert.equal(all.find((agent) => agent.id === childId)?.closed, true);
    assert.equal(all.find((agent) => agent.id === fork.id)?.closed, false);
    assert.equal((await client.tree()).sessions[0].agents.some((agent) => agent.id === childId), false);
    assert.equal((await client.tree({ closed: true })).sessions[0].agents.some((agent) => agent.id === childId), true);
    assert.equal((await client.sessions())[0].agents.some((agent) => agent.id === childId), false);
    assert.equal((await client.sessions({ closed: true }))[0].agents.some((agent) => agent.id === childId), true);
    assert.equal((await client.session(session.id).get()).busy, false);
    assert.equal((await client.session(session.id).get({ closed: true })).agents.some((agent) => agent.id === childId), true);

    assert.equal((await child.entries({ scope: "active" })).items.length > 0, true, "closing preserves history");
    assert.equal((await child.setClosed(false)).closed, false);
    assert.equal((await client.session(session.id).agents()).some((agent) => agent.id === fork.id), true);

    await child.setClosed(true);
    await server.stop();
    await server.start();
    const restarted = new DpiClient(server.base, token);
    const persisted = await restarted.session(session.id).agents({ closed: true });
    assert.equal(persisted.find((agent) => agent.id === childId)?.closed, true);
    assert.equal(persisted.find((agent) => agent.id === fork.id)?.closed, false);
  } finally {
    await server.stop();
    await temp.cleanup();
  }
});

test("close aborts active tasks owned by descendant conversations", async () => {
  const temp = await tempStore();
  let store: Store | undefined;
  try {
    store = await temp.open();
    const session = await store.create({ name: "Owned close", cwd: temp.work, model: faux });
    const summary = await store.createAgent(store.row(session.id), { name: "Owner" });
    const { row, h, c } = await store.resolveAgent(session.id, String(summary.id));
    const ownerTaskId = await c.commit(
      (tx) => tx.createTask(HoldingTask, {}, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    const descendantId = await h.commit(
      (tx) => tx.createConversation({ ownership: { kind: "task", taskId: ownerTaskId } }).then((record) => record.id),
      BACKGROUND_CONTEXT,
    );
    const descendant = await h.conversation(descendantId, BACKGROUND_CONTEXT);
    assert.ok(descendant);
    await descendant.commit(
      (tx) => tx.createTask(HoldingTask, {}, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    await until(async () => (await store!.liveTasks(h)).filter((task) => task.conversationId === summary.id || task.conversationId === descendantId).length === 2, 10_000, "owned conversations are busy");

    await assert.rejects(
      () => store!.setAgentClosed(row, c, true),
      (error: DpiError) => error.code === "busy",
    );
    await store.setAgentClosed(row, c, true, true);
    const live = await store.liveTasks(h);
    assert.equal(live.some((task) => task.conversationId === summary.id || task.conversationId === descendantId), false);
    assert.equal((await store.agentSummary(row, c)).closed, true);
    const visible = await store.agents(row);
    assert.equal(visible.some((agent) => agent.id === summary.id || agent.id === descendantId), false);
    const all = await store.agents(row, undefined, true);
    assert.equal(all.find((agent) => agent.id === descendantId)?.closed, false);
  } finally {
    await store?.close();
    await temp.cleanup();
  }
});

test("closing a busy child requires abort and aborts its work before closing", async () => {
  const temp = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(temp.root, "home"), startDirs: temp.work, token });
  const client = new DpiClient(server.base, token);
  try {
    const session = await client.createSession({ name: "Busy close", cwd: temp.work, model: faux });
    const childId = (await client.session(session.id).createAgent({ name: "Worker" })).id;
    const child = client.agent(session.id, childId);
    const submission = await child.send("!sleep 30; echo finished", "followUp", "close-busy", 250);
    assert.equal(submission.status, "pending");
    await until(async () => (await child.get()).busy, 5000, "child is busy");

    await assert.rejects(
      () => child.setClosed(true),
      (error: DpiError) => error.code === "busy" && error.status === 409 && /abort\s*:\s*true/i.test(error.message),
    );
    assert.equal((await child.setClosed(true, { abort: true })).closed, true);
    const live = await client.session(session.id).tasks("live");
    assert.equal(live.some((task) => task.conversationId === childId), false);
  } finally {
    await server.stop();
    await temp.cleanup();
  }
});
