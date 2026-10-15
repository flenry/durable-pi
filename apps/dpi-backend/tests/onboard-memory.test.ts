import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { MemoryError, createMemoryClient, memoryCommand, type MemoryClient } from "../src/onboard/memory-client.js";
import { normalizeRemote, projectKeyFor } from "../src/onboard/project-key.js";
import { createMemoryExtension } from "../src/onboard/memory.js";
import type { OnboardOptions } from "../src/onboard/config.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-onboard-memory-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function fakeSetup(dir: string, script: string) {
  const setupDir = join(dir, "setup");
  const bin = join(setupDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "pi-memory.ts"), script);
  return setupDir;
}

const localOptions = (setupDir: string): OnboardOptions => ({
  setupDir,
  memory: "local",
  memoryHost: "",
  skillsExclude: [],
  maxChildren: 2,
});

const sshOptions = (memoryHost = "memory-host"): OnboardOptions => ({
  setupDir: "/unused",
  memory: "ssh",
  memoryHost,
  skillsExclude: [],
  maxChildren: 2,
});

test("normalizeRemote matches the setup key format for SSH and HTTPS URLs", () => {
  assert.equal(normalizeRemote("git@GitHub.com:Acme/Some_Repo.git"), "github.com/acme/some-repo");
  assert.equal(normalizeRemote("https://user@GitHub.com/Acme/Some_Repo.git"), "github.com/acme/some-repo");
  assert.equal(normalizeRemote("ssh://git@git.example.com/Team/Repo.git"), "git.example.com/team/repo");
  assert.equal(normalizeRemote("not a remote"), undefined);
});

test("projectKeyFor prefers origin, uses the first reported remote without origin, and handles local repos", async () => {
  await withTempDir(async (dir) => {
    const preferred = join(dir, "preferred");
    await mkdir(preferred);
    git(preferred, "init", "-q");
    git(preferred, "remote", "add", "upstream", "https://example.com/other/ignored.git");
    git(preferred, "remote", "add", "origin", "git@GitHub.com:Acme/Preferred.git");
    assert.equal(projectKeyFor(preferred), "github.com/acme/preferred");

    const noOrigin = join(dir, "no-origin");
    await mkdir(noOrigin);
    git(noOrigin, "init", "-q");
    git(noOrigin, "remote", "add", "upstream", "https://github.com/Acme/First.git");
    git(noOrigin, "remote", "add", "backup", "https://github.com/Acme/Second.git");
    assert.equal(projectKeyFor(noOrigin), "github.com/acme/second", "git remote reports remote names in sorted order");

    const noRemote = join(dir, "local-project");
    await mkdir(noRemote);
    git(noRemote, "init", "-q");
    assert.equal(projectKeyFor(noRemote), "local/local-project");

    const plain = join(dir, "plain-folder");
    await mkdir(plain);
    assert.equal(projectKeyFor(plain), "local/plain-folder");
  });
});

test("projectKeyFor is stable across linked worktrees", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "checkout");
    const worktree = join(dir, "linked-worktree");
    await mkdir(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:Acme/Shared.git");
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"],
      { cwd: repo, stdio: "ignore" },
    );
    execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: repo, stdio: "ignore" });
    assert.equal(projectKeyFor(worktree), projectKeyFor(repo));
    assert.equal(projectKeyFor(worktree), "github.com/acme/shared");
  });
});

test("memoryCommand uses argv-only local and SSH commands and rejects unsafe inputs", () => {
  const local = memoryCommand(localOptions("/setup with spaces"), "index");
  assert.equal(local.cmd, process.execPath);
  assert.deepEqual(local.args, [join("/setup with spaces", "bin", "pi-memory.ts"), "index"]);

  assert.deepEqual(memoryCommand(sshOptions(), "read"), {
    cmd: "ssh",
    args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "memory-host", "pi-memory", "read"],
  });
  assert.throws(() => memoryCommand(sshOptions("-oProxyCommand=evil"), "index"), /DPI_MEMORY_HOST/);
  assert.throws(() => memoryCommand(sshOptions("host;touch /tmp/nope"), "index"), /DPI_MEMORY_HOST/);
  assert.throws(() => memoryCommand(localOptions("/setup"), "index; touch /tmp/nope"), /Unsupported memory command/);
  assert.throws(() => memoryCommand({ ...localOptions("/setup"), memory: "off" }, "index"), /memory is off/);
});

test("local memory client sends JSON to the CLI and parses its result", async () => {
  await withTempDir(async (dir) => {
    const setupDir = await fakeSetup(
      dir,
      [
        "const chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ command: process.argv[2], input: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));",
        "});",
      ].join("\n"),
    );
    const result = await createMemoryClient(localOptions(setupDir)).call<{ command: string; input: object }>("note", {
      scope: "project",
      entry: "A learning",
    });
    assert.deepEqual(result, { command: "note", input: { scope: "project", entry: "A learning" } });
  });
});

test("memory client reports CLI errors, EPIPE/process failures, timeouts, and oversized output", async () => {
  await withTempDir(async (dir) => {
    const failing = await fakeSetup(
      dir,
      "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ error: 'entry must be non-empty' })); process.exitCode = 2; });",
    );
    await assert.rejects(createMemoryClient(localOptions(failing)).call("note", {}), /entry must be non-empty/);

    const earlyExit = await fakeSetup(dir, "process.exit(1);");
    await assert.rejects(
      createMemoryClient(localOptions(earlyExit), { timeoutMs: 1000, maxInputBytes: 3_000_000 }).call("note", { entry: "x".repeat(2_000_000) }),
      (error: unknown) => error instanceof MemoryError && /EPIPE/.test(error.message),
    );

    const hangs = await fakeSetup(dir, "process.stdin.resume(); setInterval(() => {}, 1000);");
    await assert.rejects(
      createMemoryClient(localOptions(hangs), { timeoutMs: 30 }).call("index", {}),
      /timed out after 30ms/,
    );

    const controller = new AbortController();
    const pending = createMemoryClient(localOptions(hangs), { timeoutMs: 1000 }).call("index", {}, {
      abortSignal: controller.signal,
    } as never);
    controller.abort();
    await assert.rejects(pending, /request was cancelled/);

    const noisy = await fakeSetup(dir, "process.stdout.write('x'.repeat(4096));");
    await assert.rejects(
      createMemoryClient(localOptions(noisy), { maxOutputBytes: 128 }).call("index", {}),
      /output exceeded 128 bytes/,
    );
  });
});

test("SSH client reports offline VM failures without falling back to local execution", async () => {
  const client = createMemoryClient(sshOptions(), {
    spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      assert.equal(command, "ssh");
      assert.deepEqual(args, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "memory-host", "pi-memory", "index"]);
      return spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ error: 'should not mask transport failure' })); process.exit(255)"], options);
    }) as typeof spawn,
  });
  await assert.rejects(client.call("index", { projectKey: "github.com/acme/repo" }), /memory unavailable: VM unreachable/);
});

test("memory extension refreshes per-request indexes without returning local cwd or memory paths", async () => {
  const calls: { command: string; input: object }[] = [];
  const client: MemoryClient = {
    call: async <T>(command: string, input: object) => {
      calls.push({ command, input });
      return { dir: "/private/memory/path", index: `index ${calls.length}` } as T;
    },
  };
  const cwdSeen: string[] = [];
  const extension = createMemoryExtension(client, (cwd) => {
    cwdSeen.push(cwd);
    return `github.com/acme/${cwdSeen.length}`;
  });
  const render = extension.sections?.[0].render;
  assert.ok(render);

  const section = await render(
    { agent: { cwd: "/private/worktree/one" } } as never,
    {} as never,
  );
  assert.match(section ?? "", /Project memory — github\.com\/acme\/1/);
  assert.match(section ?? "", /index 1/);
  assert.doesNotMatch(section ?? "", /private|memory\/path/);

  const second = await render({ agent: { cwd: "/private/worktree/two" } } as never, {} as never);
  assert.match(second ?? "", /Project memory — github\.com\/acme\/2/);
  assert.deepEqual(cwdSeen, ["/private/worktree/one", "/private/worktree/two"]);
  assert.deepEqual(calls, [
    { command: "index", input: { projectKey: "github.com/acme/1" } },
    { command: "index", input: { projectKey: "github.com/acme/2" } },
  ]);
});

test("memory extension exposes current mutation semantics, safe reads, and CLI-backed tools", async () => {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const client: MemoryClient = {
    call: async <T>(command: string, input: object) => {
      calls.push({ command, input: input as Record<string, unknown> });
      if (command === "note") return { file: "/private/path/notes/topic.md", chars: 100, overCap: false, created: true } as T;
      if (command === "rewrite") return { file: "/private/path/notes/topic.md", chars: 90, overCap: false, created: false, deleted: false } as T;
      if (command === "read") return { text: "# memory content" } as T;
      return {} as T;
    },
  };
  const extension = createMemoryExtension(client, (cwd) => `local/${cwd.split("/").at(-1)}`);
  const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), ["memory_note", "memory_read", "memory_rewrite"]);
  assert.equal(tools.get("memory_note")?.replay, "unsafe");
  assert.equal(tools.get("memory_rewrite")?.replay, "unsafe");
  assert.equal(tools.get("memory_read")?.replay, "safe");

  const api = {
    conversationId: ROOT_CONVERSATION_ID,
    agent: async () => ({ cwd: "/work/repo" }),
    snapshot: async () => undefined,
  };
  const context = {} as never;
  const note = await tools.get("memory_note")!.execute(
    { scope: "project", topic: "topic", entry: "A durable fact", summary: "A summary" } as never,
    api as never,
    context,
  );
  assert.match(note.content?.map((part) => part.type === "text" ? part.text : "").join("") ?? "", /Created project memory topic/);
  assert.doesNotMatch(JSON.stringify(note), /private\/path|\/work\/repo/);

  await tools.get("memory_note")!.execute(
    { scope: "inbox", topic: "topic", entry: "Candidate", expert: "backend-engineer" } as never,
    api as never,
    context,
  );
  await tools.get("memory_rewrite")!.execute(
    { scope: "project", topic: "topic", content: "" } as never,
    api as never,
    context,
  );
  const read = await tools.get("memory_read")!.execute(
    { path: "notes/topic.md" } as never,
    api as never,
    context,
  );
  assert.match(read.content?.map((part) => part.type === "text" ? part.text : "").join("") ?? "", /# memory content/);
  assert.deepEqual(calls.map(({ command }) => command), ["note", "note", "rewrite", "read"]);
  assert.deepEqual(calls.map(({ input }) => input.projectKey), ["local/repo", "local/repo", "local/repo", "local/repo"]);
  assert.equal(calls[0].input.actor, "orchestrator");
  assert.equal(calls[1].input.actor, "orchestrator");
  assert.equal(calls[2].input.actor, "orchestrator");
  assert.equal(calls[3].input.path, "notes/topic.md");
  assert.doesNotMatch(JSON.stringify(calls), /\/work\/repo/);
});

test("memory extension degrades gracefully when the index is unavailable", async () => {
  const client: MemoryClient = {
    call: async () => {
      throw new MemoryError("memory unavailable: /private/home/path is unreachable");
    },
  };
  const extension = createMemoryExtension(client, () => "github.com/acme/repo");
  const render = extension.sections?.[0].render;
  assert.ok(render);
  const output = await render({ agent: { cwd: "/private/worktree" } } as never, {} as never);
  assert.match(output ?? "", /Project memory — github\.com\/acme\/repo/);
  assert.match(output ?? "", /index unavailable/i);
  assert.doesNotMatch(output ?? "", /private/);
});
