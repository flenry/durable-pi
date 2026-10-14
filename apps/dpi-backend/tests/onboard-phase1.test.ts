import assert from "node:assert/strict";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { OnboardOptions } from "../src/onboard/config.js";
import { createMemoryClient, type MemoryClient } from "../src/onboard/memory-client.js";
import { createMemoryExtension } from "../src/onboard/memory.js";
import { projectKeyFor } from "../src/onboard/project-key.js";
import { createSkillsExtension } from "../src/onboard/skills.js";
import { createWebExtension } from "../src/onboard/web.js";
import type { WebExtensionOptions, WebResponse } from "../src/onboard/web.js";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"] as const;

function memoryCliFor(t: TestContext): string | undefined {
  const configured = process.env.PI_MEMORY_CLI_TEST_PATH?.trim();
  if (!configured) {
    t.skip("PI_MEMORY_CLI_TEST_PATH is absent; the pi-memory CLI integration needs a local pi-setup checkout");
    return undefined;
  }
  const cliPath = resolve(configured);
  assert.ok(existsSync(cliPath), "PI_MEMORY_CLI_TEST_PATH must point to the pi-memory.ts file");
  return cliPath;
}

function safeEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Store's local client inherits process.env, so integration subprocesses run with only non-secret basics and temp roots. */
async function withSafeProcessEnvironment<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

async function initTempRepo(repoDir: string, remoteUrl: string): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: repoDir, stdio: "ignore" });
  return projectKeyFor(repoDir);
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dpi-onboard-phase1-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function setupFixture(root: string, cliPath: string): Promise<string> {
  const setupDir = join(root, "setup");
  const skillDir = join(setupDir, "agent", "skills", "fixture-skill");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await mkdir(join(setupDir, "experts"), { recursive: true });
  await mkdir(join(setupDir, "bin"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: A temporary integration skill\n---\nRead references/guide.md for the verified fixture details.\n",
  );
  await writeFile(join(skillDir, "references", "guide.md"), "# Fixture reference\nThis file is resolved relative to the loaded skill source.\n");
  await writeFile(
    join(setupDir, "experts", "ORCHESTRATOR.durable.md"),
    "# Temporary QA playbook\nDURABLE_ONBOARDING_PLAYBOOK_SENTINEL\n",
  );
  // Point the temporary setup at the read-only CLI supplied by PI_MEMORY_CLI_TEST_PATH.
  await symlink(cliPath, join(setupDir, "bin", "pi-memory.ts"));
  return setupDir;
}

function localClient(setupDir: string, env: NodeJS.ProcessEnv): MemoryClient {
  const spawnWithFixtureEnv = ((command: string, args: readonly string[], options: SpawnOptions) => {
    assert.equal(command, process.execPath);
    assert.equal(args[0], join(setupDir, "bin", "pi-memory.ts"));
    return spawn(command, [...args], { ...options, env, cwd: tmpdir() });
  }) as typeof spawn;
  const options: OnboardOptions = { setupDir, memory: "local", memoryHost: "", skillsExclude: [] };
  return createMemoryClient(options, { spawn: spawnWithFixtureEnv });
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return result.content?.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n") ?? "";
}

function toolMap<T extends { name: string }>(extension: { tools?: readonly T[] }) {
  return new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
}

function webResponse(body: string, contentType = "text/html; charset=utf-8"): WebResponse {
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

test("actual pi-memory CLI round-trips notes, preserves pins, and denies symlink escapes", async (t) => {
  const cliPath = memoryCliFor(t);
  if (!cliPath) return;

  await withTempDir(async (root) => {
    const setupDir = await setupFixture(root, cliPath);
    const projectsDir = join(root, "projects");
    const expertsDir = join(root, "experts");
    const client = localClient(setupDir, safeEnvironment({ PI_PROJECTS_DIR: projectsDir, PI_EXPERTS_DIR: expertsDir }));
    const projectKey = await initTempRepo(join(root, "repo"), "https://example.invalid/qa/phase1-cli.git");

    const written = await client.call<{ created: boolean; file: string }>("note", {
      scope: "project",
      projectKey,
      topic: "conventions",
      entry: "Pinned integration behavior survives consolidation",
      summary: "CLI round-trip behavior",
      pinned: true,
      actor: "orchestrator",
    });
    assert.equal(written.created, true);

    const indexed = await client.call<{ dir: string; index: string }>("index", { projectKey });
    assert.equal(indexed.dir, join(projectsDir, ...projectKey.split("/")));
    assert.match(indexed.index, /notes\/conventions\.md — CLI round-trip behavior \(1 entries, 1 pinned/);

    const firstRead = await client.call<{ text: string }>("read", { projectKey, path: "notes/conventions.md" });
    const pinnedLine = firstRead.text.split("\n").find((line) => line.includes("📌"));
    assert.ok(pinnedLine, "the actual CLI note must contain the pinned entry");
    const rewritten = await client.call<{ deleted: boolean }>("rewrite", {
      scope: "project",
      projectKey,
      topic: "conventions",
      content: `${pinnedLine}\n- [2026-10-15] Consolidated unpinned guidance`,
      actor: "orchestrator",
    });
    assert.equal(rewritten.deleted, false);
    const afterRewrite = await client.call<{ text: string }>("read", { projectKey, path: "notes/conventions.md" });
    assert.ok(afterRewrite.text.includes(pinnedLine), "rewrite must preserve the pinned line verbatim");
    assert.match(afterRewrite.text, /Consolidated unpinned guidance/);

    const outsideFile = join(root, "outside-note.md");
    const outsideContents = "PRIVATE_FIXTURE_SENTINEL: never return or mutate this file";
    await writeFile(outsideFile, outsideContents);
    const noteLink = join(projectsDir, ...projectKey.split("/"), "notes", "escaped.md");
    await symlink(outsideFile, noteLink);

    await assert.rejects(
      client.call("read", { projectKey, path: "notes/escaped.md" }),
      /memory path escapes its configured store/,
    );
    await assert.rejects(
      client.call("note", {
        scope: "project",
        projectKey,
        topic: "escaped",
        entry: "must not overwrite an external target",
        summary: "Blocked symlink write",
        actor: "orchestrator",
      }),
      /memory path escapes its configured store/,
    );
    assert.equal(await readFile(outsideFile, "utf8"), outsideContents);
  });
});

test("new opt-in requests include temp skills, memory, and root playbook; opt-out and read-only remain bounded", async (t) => {
  const cliPath = memoryCliFor(t);
  if (!cliPath) return;

  const temp = await tempStore();
  let store: Store | undefined;
  const setupDir = await setupFixture(temp.root, cliPath);
  const projectsDir = join(temp.root, "projects");
  const expertsDir = join(temp.root, "experts");
  try {
    const projectKey = await initTempRepo(temp.work, "https://example.invalid/qa/phase1-store.git");
    const seedClient = localClient(setupDir, safeEnvironment({ PI_PROJECTS_DIR: projectsDir, PI_EXPERTS_DIR: expertsDir }));
    await seedClient.call("note", {
      scope: "project",
      projectKey,
      topic: "orientation",
      entry: "This index was rendered from the isolated pi-memory store",
      summary: "Temporary project memory",
      actor: "orchestrator",
    });

    const env = safeEnvironment({
      DPI_ONBOARD: "1",
      DPI_MEMORY: "local",
      DPI_SKILLS_EXCLUDE: "",
      PI_SETUP_DIR: setupDir,
      PI_PROJECTS_DIR: projectsDir,
      PI_EXPERTS_DIR: expertsDir,
    });
    await withSafeProcessEnvironment(env, async () => {
      store = await temp.open();
      const session = await store.create({ name: "Onboard integration", cwd: temp.work, model: faux });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const initial = await store.agentDetail(row, c);
      const offered = new Set(initial.tools.filter((tool) => tool.offered).map((tool) => tool.name));
      for (const name of ["load_skill", "memory_note", "memory_rewrite", "memory_read", "fetch_url", "web_search"])
        assert.ok(offered.has(name), `${name} is offered to the new opt-in root`);

      const submission = await store.send(c, { content: "inspect the available setup", requestId: "phase1-root-request" });
      assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
      const rootRequest = JSON.stringify(await store.activeEntries(c));
      assert.match(rootRequest, /fixture-skill.*temporary integration skill/i);
      assert.ok(rootRequest.includes(`Project memory — ${projectKey}`));
      assert.match(rootRequest, /notes\/orientation\.md — Temporary project memory/);
      assert.match(rootRequest, /DURABLE_ONBOARDING_PLAYBOOK_SENTINEL/);

      const nonRoot = await store.createAgent(row, { from: "main", name: "phase1-non-root" });
      const child = await store.resolveAgent(row.id, String(nonRoot.id));
      assert.notEqual(child.c.id, ROOT_CONVERSATION_ID);
      const childSubmission = await store.send(child.c, { content: "inspect setup without root guidance", requestId: "phase1-non-root-request" });
      assert.equal((await store.settled(child.h, childSubmission.id as number, 20_000)).status, "done");
      const nonRootRequest = JSON.stringify(await store.activeEntries(child.c));
      assert.match(nonRootRequest, /fixture-skill.*temporary integration skill/i);
      assert.doesNotMatch(nonRootRequest, /DURABLE_ONBOARDING_PLAYBOOK_SENTINEL/);

      await store.configure(row, c, { readOnly: true });
      const readOnly = await store.agentDetail(row, c);
      assert.equal(readOnly.config.readOnly, true);
      const readOnlyTools = new Set(readOnly.tools.filter((tool) => tool.offered).map((tool) => tool.name));
      assert.equal(readOnlyTools.has("memory_note"), false);
      assert.equal(readOnlyTools.has("memory_rewrite"), false);
      for (const name of ["memory_read", "load_skill", "fetch_url", "web_search"])
        assert.ok(readOnlyTools.has(name), `${name} remains available in read-only mode`);
    });
  } finally {
    await store?.close();
    await temp.cleanup();
  }

  const legacy = await tempStore();
  let legacyStore: Store | undefined;
  try {
    await withSafeProcessEnvironment(safeEnvironment({ DPI_ONBOARD: "0", DPI_MEMORY: "invalid-but-ignored" }), async () => {
      legacyStore = await legacy.open();
      const session = await legacyStore.create({ name: "Onboard opt-out", cwd: legacy.work, model: faux });
      const { row, h, c } = await legacyStore.resolveAgent(session.id, "main");
      const detail = await legacyStore.agentDetail(row, c);
      assert.deepEqual(detail.extensions, ["coding-tools", "playground"]);
      assert.equal(detail.tools.some((tool) => ["load_skill", "memory_note", "fetch_url"].includes(tool.name)), false);
      const submission = await legacyStore.send(c, { content: "legacy request", requestId: "phase1-opt-out-request" });
      assert.equal((await legacyStore.settled(h, submission.id as number, 20_000)).status, "done");
      const legacyRequest = JSON.stringify(await legacyStore.activeEntries(c));
      assert.doesNotMatch(legacyRequest, /Available skills|Project memory|DURABLE_ONBOARDING_PLAYBOOK_SENTINEL/);
    });
  } finally {
    await legacyStore?.close();
    await legacy.cleanup();
  }
});

test("load_skill resolves its reference and memory tools round-trip through the actual CLI", async (t) => {
  const cliPath = memoryCliFor(t);
  if (!cliPath) return;

  await withTempDir(async (root) => {
    const setupDir = await setupFixture(root, cliPath);
    const skills = createSkillsExtension({ setupDir, skillsExclude: [] });
    const catalog = await skills.sections?.[0].render?.({ agent: {} } as never, BACKGROUND_CONTEXT);
    assert.match(catalog ?? "", /fixture-skill.*temporary integration skill/i);
    const loadSkill = skills.tools?.find((tool) => tool.name === "load_skill");
    assert.ok(loadSkill);
    const loaded = await loadSkill.execute({ name: "fixture-skill" } as never, {} as never, BACKGROUND_CONTEXT);
    const loadedText = textOf(loaded);
    const sourcePath = await realpath(join(setupDir, "agent", "skills", "fixture-skill", "SKILL.md"));
    assert.ok(loadedText.includes(`Source (verified): ${sourcePath}`));
    assert.match(loadedText, /Read references\/guide\.md/);
    assert.match(loadedText, /resolve.*relative to the directory containing this verified source file/i);
    const reference = await readFile(join(dirname(sourcePath), "references", "guide.md"), "utf8");
    assert.match(reference, /resolved relative to the loaded skill source/);

    const projectsDir = join(root, "projects");
    const expertsDir = join(root, "experts");
    const repoDir = join(root, "repo");
    const projectKey = await initTempRepo(repoDir, "https://example.invalid/qa/phase1-tools.git");
    const client = localClient(setupDir, safeEnvironment({ PI_PROJECTS_DIR: projectsDir, PI_EXPERTS_DIR: expertsDir }));
    const memory = createMemoryExtension(client);
    const tools = toolMap(memory);
    const api = { agent: async () => ({ cwd: repoDir }) };
    const note = await tools.get("memory_note")!.execute(
      { scope: "project", topic: "qa", entry: "Tool execution writes through pi-memory", summary: "Actual CLI tools" } as never,
      api as never,
      BACKGROUND_CONTEXT,
    );
    assert.match(textOf(note as { content?: { type: string; text?: string }[] }), /Created project memory topic/);

    const read = await tools.get("memory_read")!.execute(
      { path: "notes/qa.md" } as never,
      api as never,
      BACKGROUND_CONTEXT,
    );
    assert.match(textOf(read as { content?: { type: string; text?: string }[] }), /Tool execution writes through pi-memory/);
    const stored = await readFile(join(projectsDir, ...projectKey.split("/"), "notes", "qa.md"), "utf8");
    assert.match(stored, /Tool execution writes through pi-memory/);
  });
});

test("web tools use injected fetch only and report a missing search backend actionably", async () => {
  const fetched: string[] = [];
  const searchInvocations: string[] = [];
  const options: WebExtensionOptions = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async ({ url }) => {
      fetched.push(url.href);
      return webResponse("<html><head><title>Offline fixture docs</title></head><body><h1>Injected transport only</h1></body></html>");
    },
    spawn: ((command: string) => {
      searchInvocations.push(command);
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" })));
      return child as never;
    }) as never,
  };
  const web = createWebExtension(options);
  const tools = toolMap(web);
  const fetchUrl = tools.get("fetch_url");
  const webSearch = tools.get("web_search");
  assert.ok(fetchUrl);
  assert.ok(webSearch);

  const fetchedResult = await fetchUrl.execute({ url: "https://fixture.example/docs" } as never, {} as never, BACKGROUND_CONTEXT);
  assert.match(textOf(fetchedResult as { content?: { type: string; text?: string }[] }), /Injected transport only/);
  assert.deepEqual(fetched, ["https://fixture.example/docs"]);

  const searchResult = await webSearch.execute({ query: "official fixture documentation" } as never, {} as never, BACKGROUND_CONTEXT);
  assert.equal(searchResult.isError, true);
  assert.match(textOf(searchResult as { content?: { type: string; text?: string }[] }), /mcporter is not installed or not on PATH/);
  assert.deepEqual(searchInvocations, ["mcporter"]);
});

test("SSH memory proxy writes only to its simulated VM and never falls back locally", async (t) => {
  const cliPath = memoryCliFor(t);
  if (!cliPath) return;

  await withTempDir(async (root) => {
    const vmProjectsDir = join(root, "vm-projects");
    const vmExpertsDir = join(root, "vm-experts");
    const localProjectsDir = join(root, "local-projects");
    const vmEnv = safeEnvironment({ PI_PROJECTS_DIR: vmProjectsDir, PI_EXPERTS_DIR: vmExpertsDir });
    const invocations: { command: string; args: string[] }[] = [];
    let failNextRemoteCall = false;

    // Simulate ssh by proxying its allowlisted command to the real CLI with a separate temporary VM store.
    const sshProxy = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocations.push({ command, args: [...args] });
      assert.equal(command, "ssh", "the SSH-configured client must never start the local CLI");
      assert.equal(args.at(-2), "pi-memory");
      assert.equal(args.at(-3), "test-memory-host");
      if (failNextRemoteCall) {
        failNextRemoteCall = false;
        const waitForInputThenFail = "process.stdin.resume(); process.stdin.on('end', () => process.exit(255));";
        return spawn(process.execPath, ["-e", waitForInputThenFail], { ...options, env: vmEnv, cwd: root });
      }
      const remoteCommand = args.at(-1);
      assert.ok(remoteCommand);
      return spawn(process.execPath, [cliPath, remoteCommand], { ...options, env: vmEnv, cwd: root });
    }) as typeof spawn;

    const sshOptions: OnboardOptions = {
      setupDir: join(root, "unused-local-setup"),
      memory: "ssh",
      memoryHost: "test-memory-host",
      skillsExclude: [],
    };
    const client = createMemoryClient(sshOptions, { spawn: sshProxy });
    const projectKey = await initTempRepo(join(root, "repo"), "https://example.invalid/qa/ssh-phase1.git");
    await client.call("note", {
      scope: "project",
      projectKey,
      topic: "remote",
      entry: "This note is in the simulated VM store only",
      summary: "SSH proxy test",
      actor: "orchestrator",
    });

    const vmNote = join(vmProjectsDir, ...projectKey.split("/"), "notes", "remote.md");
    assert.match(await readFile(vmNote, "utf8"), /simulated VM store only/);
    assert.equal(existsSync(localProjectsDir), false, "the SSH client must not write a local copy");

    failNextRemoteCall = true;
    await assert.rejects(client.call("index", { projectKey }), /memory unavailable: VM unreachable/);
    assert.equal(invocations.length, 2);
    assert.ok(invocations.every(({ command }) => command === "ssh"));
    assert.equal(existsSync(localProjectsDir), false, "an unreachable remote never creates or falls back to local memory");
  });
});
