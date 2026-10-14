import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { onboardEnabledFromEnv, onboardOptionsFromEnv } from "../src/onboard/config.js";
import { createPlaybookExtension } from "../src/onboard/playbook.js";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

const ONBOARD_ENV_KEYS = ["DPI_ONBOARD", "PI_SETUP_DIR", "DPI_MEMORY", "DPI_MEMORY_HOST", "DPI_SKILLS_EXCLUDE"] as const;

type OnboardEnv = Partial<Record<(typeof ONBOARD_ENV_KEYS)[number], string | undefined>>;

async function withOnboardEnv<T>(env: OnboardEnv, run: () => Promise<T>): Promise<T> {
  const previous = new Map(ONBOARD_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ONBOARD_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of ONBOARD_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function setupFixture(root: string, withPlaybook = true): Promise<string> {
  const setupDir = join(root, "setup");
  await mkdir(join(setupDir, "agent", "skills", "fixture-skill"), { recursive: true });
  await mkdir(join(setupDir, "experts"), { recursive: true });
  await writeFile(
    join(setupDir, "agent", "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Fixture capability for wiring tests\n---\n# Fixture skill\n",
  );
  if (withPlaybook) {
    await writeFile(join(setupDir, "experts", "ORCHESTRATOR.durable.md"), "# Test Playbook Override\nWIRING_PLAYBOOK_SENTINEL\n");
  }
  return setupDir;
}

function sectionInput(conversationId: number) {
  return { conversationId, agent: {}, env: undefined, shown: {}, read: {} } as never;
}

function systemText(entries: unknown[]): string {
  return JSON.stringify(entries);
}

test("DPI_ONBOARD defaults off, accepts only explicit values, and validates config when enabled", async () => {
  assert.equal(onboardEnabledFromEnv({}), false);
  assert.equal(onboardEnabledFromEnv({ DPI_ONBOARD: "0" }), false);
  assert.equal(onboardEnabledFromEnv({ DPI_ONBOARD: "1" }), true);
  assert.throws(() => onboardEnabledFromEnv({ DPI_ONBOARD: "true" }), /DPI_ONBOARD must be 0 or 1/);
  assert.throws(() => onboardOptionsFromEnv({ DPI_MEMORY: "ssh" }), /DPI_MEMORY_HOST/);
  assert.throws(() => onboardOptionsFromEnv({ DPI_MEMORY: "unexpected" }), /DPI_MEMORY must be/);
  assert.throws(() => onboardOptionsFromEnv({ PI_SETUP_DIR: "" }), /PI_SETUP_DIR must not be empty/);

  const t = await tempStore();
  await withOnboardEnv({ DPI_ONBOARD: "true" }, async () => {
    await assert.rejects(() => Store.open(t.options), /DPI_ONBOARD must be 0 or 1/);
  });
  await t.cleanup();
});

test("playbook uses the configured override only for the canonical root and falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-playbook-"));
  try {
    const extension = createPlaybookExtension(root);
    const render = extension.sections?.[0].render;
    assert.ok(render);
    const fallback = await render(sectionInput(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
    assert.match(fallback ?? "", /Tier sizing/);
    assert.match(fallback ?? "", /one question at a time/i);
    assert.match(fallback ?? "", /define done/i);
    assert.match(fallback ?? "", /report.*close the loop/i);
    assert.match(fallback ?? "", /Phase 1 limitations/i);
    assert.match(fallback ?? "", /does not provide configured durable expert delegation/i);
    assert.doesNotMatch(fallback ?? "", /Herdr|worker_watch|expert_manage/i);

    const child = await render(sectionInput((ROOT_CONVERSATION_ID + 1) as number), BACKGROUND_CONTEXT);
    assert.equal(child, undefined, "non-root conversations do not receive the root playbook");

    await mkdir(join(root, "experts"), { recursive: true });
    await writeFile(join(root, "experts", "ORCHESTRATOR.durable.md"), "# Configured Guidance\nCONFIGURED_GUIDANCE_SENTINEL\n");
    const override = await render(sectionInput(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
    assert.match(override ?? "", /CONFIGURED_GUIDANCE_SENTINEL/);
    assert.doesNotMatch(override ?? "", /Tier sizing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in installs onboarding for new roots, filters memory mutations read-only, and omits playbook in owned children", async () => {
  const t = await tempStore();
  const setupDir = await setupFixture(t.root);
  let store: Store | undefined;
  try {
    await withOnboardEnv(
      { DPI_ONBOARD: "1", PI_SETUP_DIR: setupDir, DPI_MEMORY: "off", DPI_SKILLS_EXCLUDE: "" },
      async () => {
        store = await t.open();
        const session = await store!.create({ name: "Onboard root", cwd: t.work, model: faux });
        const { row, h, c } = await store!.resolveAgent(session.id, "main");
        const initial = await store!.agentDetail(row, c);
        for (const extension of ["skills", "memory", "web", "playbook"]) assert.ok(initial.extensions.includes(extension), extension);
        const offered = new Set(initial.tools.filter((tool) => tool.offered).map((tool) => tool.name));
        for (const tool of ["load_skill", "memory_note", "memory_rewrite", "memory_read", "fetch_url", "web_search"])
          assert.ok(offered.has(tool), tool);

        const submission = await store!.send(c, { content: "hello", requestId: "onboard-root-prompt" });
        assert.equal((await store!.settled(h, submission.id as number, 20000)).status, "done");
        const rootPrompt = systemText(await store!.activeEntries(c));
        assert.match(rootPrompt, /Test Playbook Override/);
        assert.match(rootPrompt, /WIRING_PLAYBOOK_SENTINEL/);
        assert.match(rootPrompt, /fixture-skill.*Fixture capability/);
        assert.match(rootPrompt, /memory index unavailable/);

        // Create a real task-owned conversation through the durable transaction API. It inherits the host selection;
        // only the canonical root receives the playbook section.
        const { taskId: ownerTaskId } = await store!.startJob(row, h, c, { job: "workspace-snapshot", input: { path: "." } });
        const childId = await h.commit(
          (tx) => tx.createConversation({ ownership: { kind: "task", taskId: ownerTaskId as TaskId } }).then((record) => record.id),
          BACKGROUND_CONTEXT,
        );
        const childRecord = await h.commit((tx) => tx.conversation(childId), BACKGROUND_CONTEXT);
        assert.equal(childRecord?.owner?.taskId, ownerTaskId);
        const child = await h.conversation(childId, BACKGROUND_CONTEXT);
        assert.ok(child);
        const childSubmission = await child.submit({ type: "input", content: "child hello", requestId: "onboard-owned-child" }, BACKGROUND_CONTEXT);
        assert.equal((await childSubmission.wait(BACKGROUND_CONTEXT)).status, "done");
        const childPrompt = systemText(await store!.activeEntries(child));
        assert.doesNotMatch(childPrompt, /WIRING_PLAYBOOK_SENTINEL/);
        assert.match(childPrompt, /fixture-skill.*Fixture capability/);

        await store!.configure(row, c, { readOnly: true });
        const readOnly = await store!.agentDetail(row, c);
        assert.equal(readOnly.config.readOnly, true);
        const offeredReadOnly = new Set(readOnly.tools.filter((tool) => tool.offered).map((tool) => tool.name));
        assert.equal(offeredReadOnly.has("memory_note"), false);
        assert.equal(offeredReadOnly.has("memory_rewrite"), false);
        for (const tool of ["memory_read", "load_skill", "fetch_url", "web_search"]) assert.ok(offeredReadOnly.has(tool), tool);
      },
    );
  } finally {
    await store?.close();
    await t.cleanup();
  }
});

test("read-only policy survives onboarding upgrades and explicit disable restores writers", async () => {
  const t = await tempStore();
  const setupDir = await setupFixture(t.root);
  let store: Store | undefined;
  try {
    const session = await withOnboardEnv({ DPI_ONBOARD: "0" }, async () => {
      store = await t.open();
      const created = await store.create({ name: "Legacy read-only", cwd: t.work, model: faux });
      const { row, c } = await store.resolveAgent(created.id, "main");
      const legacyWriters = new Set([
        "bash",
        "write",
        "edit",
        "update_state",
        "run_durable_job",
        "ping_on_call_engineer",
        "subagent",
        "start_session",
      ]);
      const markLegacyReadOnly = async (agent: typeof c) => {
        const writers = (await agent.agent(BACKGROUND_CONTEXT)).tools.filter((tool) => legacyWriters.has(tool.name));
        assert.ok(writers.length > 0);
        await agent.configure({ tools: { remove: writers } }, BACKGROUND_CONTEXT);
      };
      await markLegacyReadOnly(c);
      const { h } = await store.resolveAgent(created.id, "main");
      const { taskId } = await store.startJob(row, h, c, { job: "workspace-snapshot", input: { path: "." } });
      const ownedChildId = await h.commit(
        (tx) => tx.createConversation({ ownership: { kind: "task", taskId: taskId as TaskId } }).then((record) => record.id),
        BACKGROUND_CONTEXT,
      );

      const childSummary = await store.createAgent(row, { from: "main" });
      const child = await store.resolveAgent(created.id, String(childSummary.id));
      await markLegacyReadOnly(child.c);

      const restrictedSummary = await store.createAgent(row, { from: "main" });
      const restricted = await store.resolveAgent(created.id, String(restrictedSummary.id));
      const tools = (await restricted.c.agent(BACKGROUND_CONTEXT)).tools;
      const bash = tools.find((tool) => tool.name === "bash");
      const read = tools.find((tool) => tool.name === "read");
      assert.ok(bash && read);
      await restricted.c.configure({ tools: { remove: [bash, read] } }, BACKGROUND_CONTEXT);

      const writableSummary = await store.createAgent(row, { from: "main" });
      return {
        id: created.id,
        ownedChildId: ownedChildId as number,
        childId: childSummary.id,
        restrictedId: restrictedSummary.id,
        writableId: writableSummary.id,
      };
    });

    await store?.close();
    store = undefined;

    await withOnboardEnv(
      { DPI_ONBOARD: "1", PI_SETUP_DIR: setupDir, DPI_MEMORY: "off", DPI_SKILLS_EXCLUDE: "" },
      async () => {
        store = await t.open();
        const assertWriters = async (agentRef: string, expectedReadOnly: boolean) => {
          const { row, c } = await store!.resolveAgent(session.id, agentRef);
          const detail = await store!.agentDetail(row, c);
          assert.equal(detail.config.readOnly, expectedReadOnly);
          const offered = new Set(detail.tools.filter((tool) => tool.offered).map((tool) => tool.name));
          if (expectedReadOnly) {
            for (const tool of detail.tools.filter((item) => item.writes)) assert.equal(offered.has(tool.name), false, tool.name);
          } else {
            assert.ok(offered.has("memory_note"));
            assert.ok(offered.has("memory_rewrite"));
          }
          return { row, c, offered };
        };

        const root = await assertWriters("main", true);
        await assertWriters(String(session.ownedChildId), true);
        await assertWriters(String(session.childId), true);
        const custom = await assertWriters(String(session.restrictedId), false);
        assert.equal(custom.offered.has("bash"), false, "custom writer exclusion is preserved");
        assert.equal(custom.offered.has("read"), false, "custom reader exclusion is preserved");
        assert.ok(custom.offered.has("write"), "a partial writer exclusion is not mistaken for read-only");
        await assertWriters(String(session.writableId), false);

        await store!.configure(custom.row, custom.c, { readOnly: true });
        const customReadOnly = await store!.agentDetail(custom.row, custom.c);
        for (const tool of customReadOnly.tools.filter((item) => item.writes)) assert.equal(tool.offered, false, tool.name);
        assert.equal(customReadOnly.tools.find((tool) => tool.name === "read")?.offered, false);
        await store!.configure(custom.row, custom.c, { readOnly: false });
        const customRestored = await store!.agentDetail(custom.row, custom.c);
        assert.equal(customRestored.config.readOnly, false);
        assert.equal(customRestored.tools.find((tool) => tool.name === "bash")?.offered, false);
        assert.equal(customRestored.tools.find((tool) => tool.name === "read")?.offered, false);
        assert.ok(customRestored.tools.find((tool) => tool.name === "memory_note")?.offered);

        await store!.configure(root.row, root.c, { readOnly: false });
        const disabled = await store!.agentDetail(root.row, root.c);
        assert.equal(disabled.config.readOnly, false);
        assert.ok(disabled.tools.find((tool) => tool.name === "memory_note")?.offered);
        assert.ok(disabled.tools.find((tool) => tool.name === "memory_rewrite")?.offered);
      },
    );

    await (store as Store | undefined)?.close();
    store = undefined;
    await withOnboardEnv(
      { DPI_ONBOARD: "1", PI_SETUP_DIR: setupDir, DPI_MEMORY: "off", DPI_SKILLS_EXCLUDE: "" },
      async () => {
        store = await t.open();
        const { row, c } = await store!.resolveAgent(session.id, "main");
        const detail = await store!.agentDetail(row, c);
        assert.equal(detail.config.readOnly, false);
        assert.ok(detail.tools.find((tool) => tool.name === "memory_note")?.offered);
        assert.ok(detail.tools.find((tool) => tool.name === "memory_rewrite")?.offered);
        await store!.configure(row, c, { readOnly: true });
      },
    );

    await (store as Store | undefined)?.close();
    store = undefined;
    await withOnboardEnv(
      { DPI_ONBOARD: "1", PI_SETUP_DIR: setupDir, DPI_MEMORY: "off", DPI_SKILLS_EXCLUDE: "" },
      async () => {
        store = await t.open();
        const { row, c } = await store!.resolveAgent(session.id, "main");
        const detail = await store!.agentDetail(row, c);
        assert.equal(detail.config.readOnly, true);
        for (const tool of detail.tools.filter((item) => item.writes)) assert.equal(tool.offered, false, tool.name);
      },
    );
  } finally {
    await store?.close();
    await t.cleanup();
  }
});

test("missing setup degrades gracefully without creating a local memory tree", async () => {
  const t = await tempStore();
  const missingSetup = join(t.root, "not-installed");
  let store: Store | undefined;
  try {
    await withOnboardEnv({ DPI_ONBOARD: "1", PI_SETUP_DIR: missingSetup, DPI_MEMORY: "local" }, async () => {
      store = await t.open();
      const session = await store!.create({ name: "Missing setup", cwd: t.work, model: faux });
      const { row, h, c } = await store!.resolveAgent(session.id, "main");
      const submission = await store!.send(c, { content: "hello", requestId: "missing-setup-prompt" });
      assert.equal((await store!.settled(h, submission.id as number, 20000)).status, "done");
      const prompt = systemText(await store!.activeEntries(c));
      assert.match(prompt, /No skills found/);
      assert.match(prompt, /Phase 1 limitations/);
      assert.match(prompt, /memory index unavailable/);
      assert.ok((await store!.agentDetail(row, c)).tools.some((tool) => tool.name === "fetch_url" && tool.offered));
      assert.equal(existsSync(missingSetup), false, "setup/memory clients do not create a local setup tree");
    });
  } finally {
    await store?.close();
    await t.cleanup();
  }
});

test("default-off leaves legacy extensions unchanged even if onboarding-only settings are invalid", async () => {
  const t = await tempStore();
  let store: Store | undefined;
  try {
    await withOnboardEnv({ DPI_ONBOARD: undefined, DPI_MEMORY: "not-a-mode", PI_SETUP_DIR: undefined }, async () => {
      store = await t.open();
      const session = await store!.create({ name: "Legacy", cwd: t.work, model: faux });
      const { row, c } = await store!.resolveAgent(session.id, "main");
      const detail = await store!.agentDetail(row, c);
      assert.deepEqual(detail.extensions, ["coding-tools", "playground"]);
      assert.equal(detail.tools.some((tool) => ["load_skill", "memory_note", "fetch_url"].includes(tool.name)), false);
    });
  } finally {
    await store?.close();
    await t.cleanup();
  }
});
