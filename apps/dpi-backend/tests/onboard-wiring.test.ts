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
