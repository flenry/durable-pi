import assert from "node:assert/strict";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { test } from "node:test";
import type { WebExtensionOptions, WebFetch, WebLookup, WebResponse } from "../src/onboard/web.js";
import { createWebExtension } from "../src/onboard/web.js";

const publicLookup: WebLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeSearchChild(options: {
  stdout?: string;
  stderr?: string;
  error?: Error;
  close?: boolean;
  onKill?: (signal: string) => void;
} = {}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout,
    stderr,
    kill: (signal: string) => {
      options.onKill?.(signal);
      return true;
    },
  });
  if (options.close !== false) {
    setImmediate(() => {
      if (options.error) {
        child.emit("error", options.error);
        child.emit("close", -2, null);
        return;
      }
      const pipesClosed = Promise.all([once(stdout, "close"), once(stderr, "close")]);
      stdout.end(options.stdout ?? "");
      stderr.end(options.stderr ?? "");
      void pipesClosed.then(() => child.emit("close", 0, null));
    });
  }
  return child;
}
const createTestWebExtension = (options: WebExtensionOptions = {}) => createWebExtension({ lookup: publicLookup, ...options });

function response(
  status: number,
  headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" },
  chunks: string[] = ["hello"],
  onCancel?: () => void,
): WebResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    cancel: async () => onCancel?.(),
  };
}

function getTools(extension: ReturnType<typeof createWebExtension>) {
  const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
  const fetchUrl = tools.get("fetch_url");
  const webSearch = tools.get("web_search");
  assert.ok(fetchUrl);
  assert.ok(webSearch);
  return { fetchUrl, webSearch };
}

function outputText(result: { content?: { type: string; text?: string }[] }): string {
  return result.content?.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n") ?? "";
}

async function callFetch(
  tool: ReturnType<typeof getTools>["fetchUrl"],
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
) {
  return tool.execute(args as never, {} as never, { abortSignal } as never);
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createSigtermIgnoringFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dpi-web-search-")).catch((error: unknown) => {
    throw new Error("could not create temporary web_search fixture", { cause: error });
  });
  const fixturePath = join(directory, "ignore-sigterm.cjs");
  await writeFile(fixturePath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");

  let child: ChildProcess | undefined;
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
  let exited: Promise<unknown[]> | undefined;
  const spawnSearch = ((command: string, _args: readonly string[], options: Record<string, unknown>) => {
    assert.equal(command, "mcporter");
    child = nodeSpawn(process.execPath, [fixturePath], {
      detached: options.detached === true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("spawn", resolveSpawned);
    exited = once(child, "close");
    return child;
  }) as never;

  return {
    spawn: spawnSearch,
    waitForSpawn: () => spawned,
    waitForExit: () => exited ?? Promise.resolve([]),
    cleanup: async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (exited) await within(exited, 1_000, "fixture child did not exit after SIGKILL").catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createProcessTreeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dpi-web-search-tree-"));
  const fixturePath = join(directory, "spawn-grandchild.cjs");
  const grandchildPidPath = join(directory, "grandchild.pid");
  await writeFile(fixturePath, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    writeFileSync(process.env.DPI_WEB_SEARCH_GRANDCHILD_PID_FILE, String(grandchild.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `);

  let child: ChildProcess | undefined;
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
  let stdoutClosed: Promise<unknown[]> | undefined;
  let stderrClosed: Promise<unknown[]> | undefined;
  let childClosed: Promise<unknown[]> | undefined;
  const spawnSearch = ((command: string, _args: readonly string[], options: Record<string, unknown>) => {
    assert.equal(command, "mcporter");
    assert.equal(options.detached, process.platform !== "win32", "Unix invocations must own a detached process group");
    child = nodeSpawn(process.execPath, [fixturePath], {
      detached: options.detached === true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, DPI_WEB_SEARCH_GRANDCHILD_PID_FILE: grandchildPidPath },
    });
    child.once("spawn", resolveSpawned);
    childClosed = once(child, "close");
    if (child.stdout) stdoutClosed = once(child.stdout, "close");
    if (child.stderr) stderrClosed = once(child.stderr, "close");
    return child;
  }) as never;

  const waitForGrandchildPid = async () => {
    const deadline = Date.now() + 1_000;
    for (;;) {
      try {
        const pid = Number(await readFile(grandchildPidPath, "utf8"));
        assert.ok(Number.isInteger(pid) && pid > 0);
        return pid;
      } catch (error) {
        if (Date.now() >= deadline) throw new Error("grandchild fixture did not publish its pid", { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };

  return {
    spawn: spawnSearch,
    waitForSpawn: () => spawned,
    waitForGrandchildPid,
    waitForPipesClosed: async () => {
      assert.ok(stdoutClosed && stderrClosed, "fixture stdout/stderr pipes should be owned");
      await Promise.all([stdoutClosed, stderrClosed]);
    },
    get child() { return child; },
    cleanup: async () => {
      if (child?.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      } else if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      if (childClosed) await within(childClosed, 1_000, "process-tree fixture did not close").catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`grandchild process ${pid} remained alive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function assertSearchProcessTreeKilled(mode: "timeout" | "cancel") {
  const fixture = await createProcessTreeFixture();
  const unrelated = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  const unrelatedClosed = once(unrelated, "close");
  const controller = new AbortController();
  try {
    await within(once(unrelated, "spawn"), 1_000, `${mode} unrelated process did not spawn`);
    const extension = createWebExtension({
      searchTimeoutMs: mode === "timeout" ? 1_200 : 5_000,
      spawn: fixture.spawn,
    });
    const pending = getTools(extension).webSearch.execute(
      { query: "docs" } as never,
      {} as never,
      { abortSignal: mode === "cancel" ? controller.signal : undefined } as never,
    );
    await within(fixture.waitForSpawn(), 1_000, `${mode} fixture parent did not spawn`);
    const grandchildPid = await fixture.waitForGrandchildPid();
    if (mode === "cancel") controller.abort();

    const result = await within(pending, 2_000, `web_search did not settle after ${mode}`);
    assert.equal(result.isError, true);
    assert.match(outputText(result), mode === "timeout" ? /timed out/i : /cancelled/i);
    assert.ok(fixture.child);
    assert.equal(fixture.child.stdout?.destroyed, true, `${mode} must destroy owned stdout`);
    assert.equal(fixture.child.stderr?.destroyed, true, `${mode} must destroy owned stderr`);
    assert.ok(unrelated.pid);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), `${mode} must not kill an unrelated process group`);
    await within(
      Promise.all([fixture.waitForPipesClosed(), waitForProcessExit(grandchildPid)]),
      2_000,
      `${mode} must close inherited pipes and terminate the grandchild`,
    );
  } finally {
    if (unrelated.pid && process.platform !== "win32") {
      try { process.kill(-unrelated.pid, "SIGKILL"); } catch { /* already gone */ }
    } else if (unrelated.exitCode === null && unrelated.signalCode === null) {
      unrelated.kill("SIGKILL");
    }
    await within(unrelatedClosed, 1_000, `${mode} unrelated fixture did not exit`).catch(() => undefined);
    await fixture.cleanup();
  }
}

async function runIsolatedTitleProbe(contentType: "text/html" | "text/plain", raw: boolean, repeats: number) {
  const moduleUrl = new URL("../src/onboard/web.ts", import.meta.url).href;
  const script = `
    import { createWebExtension } from ${JSON.stringify(moduleUrl)};
    const contentType = process.env.DPI_TITLE_PROBE_CONTENT_TYPE;
    const raw = process.env.DPI_TITLE_PROBE_RAW === "true";
    const repeats = Number(process.env.DPI_TITLE_PROBE_REPEATS);
    const source = "<title>".repeat(repeats);
    let heartbeat = false;
    setTimeout(() => { heartbeat = true; }, 10);
    const extension = createWebExtension({
      timeoutMs: 100,
      maxResponseBytes: 5_000_000,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async () => ({
        status: 200,
        headers: { "content-type": contentType },
        body: (async function* () { yield Buffer.from(source); })(),
      }),
    });
    const tool = extension.tools.find((item) => item.name === "fetch_url");
    const started = Date.now();
    const result = await tool.execute({ url: "https://public.example/adversarial-title", raw, no_cache: true }, {}, {});
    const elapsedMs = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log(JSON.stringify({
      error: result.details?.error,
      isError: result.isError,
      heartbeat,
      elapsedMs,
      sourceBytes: Buffer.byteLength(source),
      title: result.details?.title,
    }));
    if (result.isError || !heartbeat || result.details?.title !== "") process.exitCode = 1;
  `;
  const child = nodeSpawn(process.execPath, ["--import=tsx", "--input-type=module", "-e", script], {
    env: {
      ...process.env,
      DPI_TITLE_PROBE_CONTENT_TYPE: contentType,
      DPI_TITLE_PROBE_RAW: String(raw),
      DPI_TITLE_PROBE_REPEATS: String(repeats),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  let watchdog: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    close,
    new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`isolated title probe stalled (${contentType}, raw=${raw})`));
      }, 2_500);
    }),
  ]).finally(() => clearTimeout(watchdog));
  assert.equal(exit[0], 0, `isolated title probe failed: ${stderr}\\n${stdout}`);
  const line = stdout.trim().split("\\n").at(-1);
  assert.ok(line, `isolated title probe returned no result: ${stderr}`);
  return JSON.parse(line) as { error?: string; isError: boolean; heartbeat: boolean; elapsedMs: number; sourceBytes: number; title: string };
}

async function runIsolatedHtmlProbe(
  kind: "unmatched-tags" | "unmatched-comments" | "unmatched-quotes",
  size: number,
  mode: "timeout" | "cancel" | "body-before-conversion" = "timeout",
) {
  const moduleUrl = new URL("../src/onboard/web.ts", import.meta.url).href;
  const script = `
    import { createWebExtension } from ${JSON.stringify(moduleUrl)};
    const kind = process.env.DPI_HTML_PROBE_KIND;
    const size = Number(process.env.DPI_HTML_PROBE_SIZE);
    const mode = process.env.DPI_HTML_PROBE_MODE;
    const controller = new AbortController();
    const part = kind === "unmatched-tags" ? "<"
      : kind === "unmatched-comments" ? "<!--"
      : "<a href=\\\"";
    const source = part.repeat(Math.floor(size / part.length));
    let heartbeat = false;
    setTimeout(() => { heartbeat = true; }, 10);
    if (mode === "cancel") setTimeout(() => controller.abort(), 50);
    const expectedError = mode === "cancel" ? "cancelled" : "timeout";
    const timeoutMs = mode === "cancel" ? 5_000 : mode === "body-before-conversion" ? 500 : 150;
    const extension = createWebExtension({
      timeoutMs,
      maxResponseBytes: 5_000_000,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: (async function* () {
          if (mode === "body-before-conversion") await new Promise((resolve) => setTimeout(resolve, 350));
          yield Buffer.from(source);
        })(),
      }),
    });
    const tool = extension.tools.find((item) => item.name === "fetch_url");
    const started = Date.now();
    const result = await tool.execute(
      { url: "https://public.example/adversarial", no_cache: true },
      {},
      { abortSignal: mode === "cancel" ? controller.signal : undefined },
    );
    console.log(JSON.stringify({
      error: result.details?.error,
      isError: result.isError,
      heartbeat,
      elapsedMs: Date.now() - started,
      sourceBytes: Buffer.byteLength(source),
    }));
    if (result.details?.error !== expectedError || !heartbeat) process.exitCode = 1;
  `;
  const child = nodeSpawn(process.execPath, ["--import=tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, DPI_HTML_PROBE_KIND: kind, DPI_HTML_PROBE_SIZE: String(size), DPI_HTML_PROBE_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  let watchdog: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    close,
    new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`isolated malformed-HTML probe stalled (${kind}, ${size} chars)`));
      }, 2_500);
    }),
  ]).finally(() => clearTimeout(watchdog));
  assert.equal(exit[0], 0, `isolated HTML probe failed: ${stderr}\n${stdout}`);
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, `isolated HTML probe returned no result: ${stderr}`);
  return JSON.parse(line) as { error: string; isError: boolean; heartbeat: boolean; elapsedMs: number; sourceBytes: number };
}

test("registers replay-safe web tools with compatible fetch options", () => {
  const { fetchUrl, webSearch } = getTools(createWebExtension({}));
  assert.equal(fetchUrl.replay, "safe");
  assert.equal(webSearch.replay, "safe");
  assert.deepEqual(Object.keys(fetchUrl.parameters.properties ?? {}).sort(), ["max_chars", "no_cache", "raw", "url"]);
  assert.deepEqual(Object.keys(webSearch.parameters.properties ?? {}).sort(), ["num_results", "objective", "query"]);
});

test("rejects non-HTTP, encoded private IPv4, and private IPv6 literals before fetch", async () => {
  let calls = 0;
  const extension = createWebExtension({
    fetch: async () => {
      calls++;
      return response(200);
    },
  });
  const { fetchUrl } = getTools(extension);
  for (const url of [
    "file:///etc/passwd",
    "https://user:pass@public.example/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://%31%32%37.0.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    const result = await callFetch(fetchUrl, { url });
    assert.equal(result.isError, true, url);
    assert.match(outputText(result), /refused|only http/i, url);
  }
  assert.equal(calls, 0);
});

test("fails closed on private or mixed DNS answers and pins the chosen public address into fetch", async () => {
  let calls = 0;
  const privateDns = createWebExtension({
    lookup: async () => [{ address: "10.1.2.3", family: 4 }],
    fetch: async () => {
      calls++;
      return response(200);
    },
  });
  const privateResult = await callFetch(getTools(privateDns).fetchUrl, { url: "https://public.example/" });
  assert.equal(privateResult.isError, true);
  assert.match(outputText(privateResult), /SSRF|public address/i);
  assert.equal(calls, 0);

  const mixedDns = createWebExtension({
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ],
    fetch: async () => {
      calls++;
      return response(200);
    },
  });
  const mixedResult = await callFetch(getTools(mixedDns).fetchUrl, { url: "https://public.example/" });
  assert.equal(mixedResult.isError, true);
  assert.equal(calls, 0);

  const v6Private = createTestWebExtension({
    lookup: async () => [{ address: "fd00::1", family: 6 }],
    fetch: async () => {
      calls++;
      return response(200);
    },
  });
  const v6Result = await callFetch(getTools(v6Private).fetchUrl, { url: "https://public.example/" });
  assert.equal(v6Result.isError, true);
  assert.equal(calls, 0);

  const dnsFailure = createTestWebExtension({
    lookup: async () => { throw new Error("resolver details must not leak"); },
    fetch: async () => {
      calls++;
      return response(200);
    },
  });
  const failedLookup = await callFetch(getTools(dnsFailure).fetchUrl, { url: "https://public.example/" });
  assert.equal(failedLookup.isError, true);
  assert.match(outputText(failedLookup), /DNS resolution failed/i);
  assert.doesNotMatch(JSON.stringify(failedLookup), /resolver details/);
  assert.equal(calls, 0);

  let observedAddress = "";
  const pinnedFetch: WebFetch = async (request) => {
    observedAddress = request.address.address;
    return response(200);
  };
  const pinned = createWebExtension({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: pinnedFetch,
  });
  const result = await callFetch(getTools(pinned).fetchUrl, { url: "https://public.example/" });
  assert.equal(result.isError, undefined);
  assert.equal(observedAddress, "93.184.216.34", "the transport receives the validated IP instead of resolving again");
});

test("revalidates redirect destinations and enforces the redirect bound", async () => {
  let calls = 0;
  let cancelled = 0;
  const extension = createTestWebExtension({
    fetch: async () => {
      calls++;
      return response(302, { location: "http://127.0.0.1/private" }, [], () => cancelled++);
    },
  });
  const result = await callFetch(getTools(extension).fetchUrl, { url: "https://public.example/start" });
  assert.equal(result.isError, true);
  assert.match(outputText(result), /SSRF/i);
  assert.equal(calls, 1, "the private redirect target must not be requested");
  assert.equal(cancelled, 1, "discarded redirect bodies are cancelled");

  let dnsRedirectCalls = 0;
  const privateDnsRedirect = createTestWebExtension({
    lookup: async (hostname) => [{ address: hostname === "public.example" ? "93.184.216.34" : "10.0.0.8", family: 4 }],
    fetch: async () => {
      dnsRedirectCalls++;
      return response(302, { location: "https://private.example/secret" }, []);
    },
  });
  const privateDnsResult = await callFetch(getTools(privateDnsRedirect).fetchUrl, { url: "https://public.example/start" });
  assert.equal(privateDnsResult.isError, true);
  assert.equal(dnsRedirectCalls, 1);

  const lookedUp: string[] = [];
  let publicHop = 0;
  const publicRedirect = createTestWebExtension({
    lookup: async (hostname) => {
      lookedUp.push(hostname);
      return [{ address: hostname === "public.example" ? "93.184.216.34" : "1.1.1.1", family: 4 }];
    },
    fetch: async () => ++publicHop === 1
      ? response(302, { location: "https://other.example/final" }, [])
      : response(200, { "content-type": "text/plain" }, ["final content"]),
  });
  const followed = await callFetch(getTools(publicRedirect).fetchUrl, { url: "https://public.example/start" });
  assert.equal(followed.isError, undefined);
  assert.deepEqual(lookedUp, ["public.example", "other.example"]);
  assert.match(outputText(followed), /Source URL: https:\/\/other\.example\/final/);

  let redirectCalls = 0;
  const loops = createTestWebExtension({
    fetch: async () => {
      redirectCalls++;
      return response(302, { location: "/again" }, []);
    },
  });
  const loopResult = await callFetch(getTools(loops).fetchUrl, { url: "https://public.example/start" });
  assert.equal(loopResult.isError, true);
  assert.match(outputText(loopResult), /redirect limit|loop/i);
  assert.ok(redirectCalls <= 6);

  const downgrade = createTestWebExtension({
    fetch: async () => response(302, { location: "http://public.example/insecure" }, []),
  });
  const downgradeResult = await callFetch(getTools(downgrade).fetchUrl, { url: "https://public.example/start" });
  assert.equal(downgradeResult.isError, true);
  assert.match(outputText(downgradeResult), /HTTPS to HTTP/i);

  let boundedCalls = 0;
  const tooManyRedirects = createTestWebExtension({
    fetch: async ({ url }) => {
      boundedCalls++;
      return response(302, { location: `/next/${boundedCalls}` }, []);
    },
  });
  const redirectLimit = await callFetch(getTools(tooManyRedirects).fetchUrl, { url: "https://public.example/start" });
  assert.equal(redirectLimit.isError, true);
  assert.match(outputText(redirectLimit), /Redirect limit exceeded/);
  assert.equal(boundedCalls, 6);
});

test("refuses unsupported content types and bounds streamed response bytes", async () => {
  const unsupported = createTestWebExtension({
    fetch: async () => response(200, { "content-type": "application/pdf" }, ["pdf"]),
  });
  const pdf = await callFetch(getTools(unsupported).fetchUrl, { url: "https://public.example/file" });
  assert.equal(pdf.isError, true);
  assert.match(outputText(pdf), /content.type/i);

  let cancelled = 0;
  const oversized = createTestWebExtension({
    maxResponseBytes: 8,
    fetch: async () => response(200, { "content-type": "text/plain" }, ["12345", "67890"], () => cancelled++),
  });
  const big = await callFetch(getTools(oversized).fetchUrl, { url: "https://public.example/large" });
  assert.equal(big.isError, true);
  assert.match(outputText(big), /size limit|too large/i);
  assert.equal(cancelled, 1);
});

test("isolates malformed HTML conversion, enforces its deadline, and keeps the backend event loop responsive", async () => {
  const probes = [
    ["unmatched-tags", 100_000],
    ["unmatched-tags", 4_900_000],
    ["unmatched-comments", 4_900_000],
    ["unmatched-quotes", 4_900_000],
  ] as const;
  for (const [kind, size] of probes) {
    const probe = await runIsolatedHtmlProbe(kind, size);
    assert.equal(probe.error, "timeout", `${kind} (${size} chars) should hit the fetch/conversion deadline`);
    assert.equal(probe.isError, true);
    assert.equal(probe.heartbeat, true, "unrelated event-loop timers should run during conversion");
    assert.ok(probe.elapsedMs < 1_000, `conversion deadline took ${probe.elapsedMs}ms`);
    assert.ok(probe.sourceBytes <= 5_000_000);
    if (size > 4_000_000) assert.ok(probe.sourceBytes > 4_800_000, "probe should be near the configured body limit");
  }
  const combinedDeadline = await runIsolatedHtmlProbe("unmatched-tags", 100_000, "body-before-conversion");
  assert.equal(combinedDeadline.error, "timeout", "body reading and conversion must share one deadline");
  assert.ok(combinedDeadline.elapsedMs < 800, `body-plus-conversion exceeded the total deadline: ${combinedDeadline.elapsedMs}ms`);

  const cancelled = await runIsolatedHtmlProbe("unmatched-tags", 100_000, "cancel");
  assert.equal(cancelled.error, "cancelled", "caller cancellation must interrupt a running conversion worker");
  assert.equal(cancelled.heartbeat, true);
  assert.ok(cancelled.elapsedMs < 1_000, `conversion cancellation took ${cancelled.elapsedMs}ms`);
});

test("raw HTML and default text/plain title handling stay responsive to repeated open tags", async () => {
  for (const [contentType, raw] of [["text/html", true], ["text/plain", false]] as const) {
    const probe = await runIsolatedTitleProbe(contentType, raw, 30_000);
    assert.ok(!probe.isError, `${contentType}, raw=${raw}`);
    assert.equal(probe.heartbeat, true, `${contentType}, raw=${raw}: event-loop heartbeat must run`);
    assert.equal(probe.title, "", `${contentType}, raw=${raw}: title extraction is omitted outside conversion`);
    assert.equal(probe.sourceBytes, 210_000);
    assert.ok(probe.elapsedMs < 500, `${contentType}, raw=${raw}: settlement was not bounded (${probe.elapsedMs}ms)`);
  }
});

test("converts useful HTML structure, removes executable/style content, and reports truncation with source URL", async () => {
  const html = [
    "<!doctype html><html><head><title>Docs &amp; APIs</title><style>.hidden { display:none }</style></head>",
    "<body><script>steal()</script><h1>Guide</h1><p>Read <a href=\"https://docs.example/ref\">the reference</a> and <a href=\"/reference\">local guide</a> plus <a href=\"javascript:alert(1)\">unsafe</a>.</p>",
    "<ul><li>One</li><li>Two</li></ul><pre><code>const x = 1;</code></pre></body></html>",
  ].join("");
  const extension = createTestWebExtension({ fetch: async () => response(200, { "content-type": "text/html; charset=utf-8" }, [html]) });
  const result = await callFetch(getTools(extension).fetchUrl, {
    url: "https://public.example/docs?token=not-a-secret",
    max_chars: 500,
  });
  assert.equal(result.isError, undefined);
  const text = outputText(result);
  assert.match(text, /# Docs & APIs/);
  assert.match(text, /# Guide/);
  assert.match(text, /\[the reference\]\(https:\/\/docs\.example\/ref\)/);
  assert.match(text, /\[local guide\]\(https:\/\/public\.example\/reference\)/);
  assert.match(text, /unsafe/);
  assert.doesNotMatch(text, /\[unsafe\]\(javascript:/i);
  assert.match(text, /- One/);
  assert.match(text, /const x = 1/);
  assert.doesNotMatch(text, /steal\(\)|\.hidden/);
  assert.match(text, /Truncated: false/);
  assert.match(text, /https:\/\/public\.example\/docs\?token=%5Bredacted%5D/);
  assert.doesNotMatch(text, /not-a-secret/);

  const long = createTestWebExtension({ fetch: async () => response(200, { "content-type": "text/plain" }, ["x".repeat(700)]) });
  const truncated = await callFetch(getTools(long).fetchUrl, { url: "https://public.example/long", max_chars: 500 });
  assert.match(outputText(truncated), /Truncated: true/);
  assert.match(outputText(truncated), /showing 500 of 700 chars/);
});

test("raw mode returns source text and no_cache bypasses the bounded in-memory cache", async () => {
  let calls = 0;
  const extension = createTestWebExtension({
    fetch: async () => response(200, { "content-type": "text/html" }, [`<h1>response-${++calls}</h1>`]),
  });
  const { fetchUrl } = getTools(extension);
  const first = await callFetch(fetchUrl, { url: "https://public.example/page", raw: true });
  const second = await callFetch(fetchUrl, { url: "https://public.example/page", raw: true });
  const bypass = await callFetch(fetchUrl, { url: "https://public.example/page", raw: true, no_cache: true });
  assert.match(outputText(first), /response-1/);
  assert.match(outputText(second), /response-1/);
  assert.match(outputText(bypass), /response-2/);
  assert.match(outputText(bypass), /Cache: bypassed/);
  assert.equal(calls, 2);
});

test("times out and propagates caller cancellation without leaving a fetch pending", async () => {
  const hanging = createTestWebExtension({
    timeoutMs: 20,
    fetch: (_request) => new Promise((_resolve, reject) => {
      // The production adapter observes the signal; this fake does too.
      _request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const timed = await callFetch(getTools(hanging).fetchUrl, { url: "https://public.example/slow" });
  assert.equal(timed.isError, true);
  assert.match(outputText(timed), /timed out/i);

  let fetchCalled = false;
  const dnsHanging = createTestWebExtension({
    timeoutMs: 20,
    lookup: () => new Promise(() => {}),
    fetch: async () => {
      fetchCalled = true;
      return response(200);
    },
  });
  const dnsTimed = await callFetch(getTools(dnsHanging).fetchUrl, { url: "https://public.example/slow-dns" });
  assert.equal(dnsTimed.isError, true);
  assert.match(outputText(dnsTimed), /timed out/i);
  assert.equal(fetchCalled, false, "no request follows a timed-out DNS lookup");

  const controller = new AbortController();
  const cancellable = createTestWebExtension({
    fetch: (request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  });
  const pending = callFetch(getTools(cancellable).fetchUrl, { url: "https://public.example/slow" }, controller.signal);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.match(outputText(cancelled), /cancelled/i);
});

test("web_search hard-kills a SIGTERM-ignoring child at timeout without waiting for its callback", async () => {
  const fixture = await createSigtermIgnoringFixture();
  try {
    const extension = createWebExtension({ searchTimeoutMs: 120, spawn: fixture.spawn });
    const pending = getTools(extension).webSearch.execute({ query: "docs" } as never, {} as never, {} as never);
    await within(fixture.waitForSpawn(), 1_000, "timeout fixture did not spawn");
    const result = await within(pending, 800, "web_search did not settle after its hard timeout");
    assert.equal(result.isError, true);
    assert.match(outputText(result), /timed out/i);
    const exit = await within(fixture.waitForExit(), 1_000, "timed-out fixture child remained alive");
    assert.equal(exit[1], "SIGKILL", "timeout must forcibly terminate a child that ignores SIGTERM");
  } finally {
    await fixture.cleanup();
  }
});

test("web_search hard-kills a SIGTERM-ignoring child on caller cancellation", async () => {
  const fixture = await createSigtermIgnoringFixture();
  const controller = new AbortController();
  try {
    const extension = createWebExtension({ searchTimeoutMs: 5_000, spawn: fixture.spawn });
    const pending = getTools(extension).webSearch.execute({ query: "docs" } as never, {} as never, { abortSignal: controller.signal } as never);
    await within(fixture.waitForSpawn(), 1_000, "cancellation fixture did not spawn");
    controller.abort();
    const result = await within(pending, 800, "web_search did not settle after cancellation");
    assert.equal(result.isError, true);
    assert.match(outputText(result), /cancelled/i);
    const exit = await within(fixture.waitForExit(), 1_000, "cancelled fixture child remained alive");
    assert.equal(exit[1], "SIGKILL", "cancellation must forcibly terminate a child that ignores SIGTERM");
  } finally {
    await fixture.cleanup();
  }
});

test("web_search timeout kills its process group, inherited pipes, and grandchild", async () => {
  await assertSearchProcessTreeKilled("timeout");
});

test("web_search cancellation kills its process group, inherited pipes, and grandchild", async () => {
  await assertSearchProcessTreeKilled("cancel");
});

test("web_search passes bounded query data as one argv value and does not use a shell", async () => {
  let invocation: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
  const extension = createWebExtension({
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      invocation = { command, args, options };
      return fakeSearchChild({ stdout: "result title https://docs.example" });
    }) as never,
  });
  const { webSearch } = getTools(extension);
  const injection = "docs; touch /tmp/should-not-run";
  const result = await webSearch.execute({ query: injection, objective: "official docs", num_results: 3 } as never, {} as never, {} as never);
  assert.equal(result.isError, undefined);
  assert.equal(invocation?.command, "mcporter");
  assert.equal(invocation?.options.shell, undefined);
  assert.equal(invocation?.options.detached, process.platform !== "win32");
  assert.deepEqual(invocation?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(invocation?.args[0], "call");
  assert.equal(invocation?.args[1], "exa.web_search_exa");
  const payloadAt = invocation?.args.indexOf("--args") ?? -1;
  assert.ok(payloadAt >= 0);
  assert.deepEqual(JSON.parse(invocation!.args[payloadAt + 1]), {
    query: injection,
    objective: "official docs",
    numResults: 3,
  });
  assert.match(outputText(result), /UNTRUSTED external data/);
  assert.doesNotMatch(JSON.stringify(result), /should-not-run/);
});

test("web_search reports missing mcporter without leaking stderr and caps query/result size", async () => {
  const missing = createWebExtension({
    spawn: (() => fakeSearchChild({ error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) })) as never,
  });
  const { webSearch } = getTools(missing);
  const unavailable = await webSearch.execute({ query: "docs" } as never, {} as never, {} as never);
  assert.equal(unavailable.isError, true);
  assert.match(outputText(unavailable), /mcporter.*not installed|Exa backend unavailable/i);
  assert.doesNotMatch(JSON.stringify(unavailable), /spawn failed/);

  const extension = createWebExtension({
    maxSearchOutputBytes: 1_234,
    spawn: (() => fakeSearchChild({ stdout: "x".repeat(1_235) })) as never,
  });
  const oversized = await getTools(extension).webSearch.execute({ query: "docs" } as never, {} as never, {} as never);
  assert.equal(oversized.isError, true);
  assert.match(outputText(oversized), /output exceeded.*limit/i);

  let timeoutKill: string | undefined;
  let timeoutOptions: Record<string, unknown> | undefined;
  const timeout = createWebExtension({
    searchTimeoutMs: 20,
    maxSearchOutputBytes: 1_234,
    spawn: ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
      timeoutOptions = options;
      return fakeSearchChild({ close: false, onKill: (signal) => { timeoutKill = signal; } });
    }) as never,
  });
  const timed = await getTools(timeout).webSearch.execute({ query: "docs" } as never, {} as never, {} as never);
  assert.equal(timed.isError, true);
  assert.equal(timeoutOptions?.detached, process.platform !== "win32");
  assert.equal(timeoutKill, "SIGKILL");
  assert.match(outputText(timed), /timed out/i);

  const controller = new AbortController();
  let cancellationKill: string | undefined;
  const cancellable = createWebExtension({
    spawn: ((_command: string, _args: readonly string[], _options: Record<string, unknown>) =>
      fakeSearchChild({ close: false, onKill: (signal) => { cancellationKill = signal; } })) as never,
  });
  const pending = getTools(cancellable).webSearch.execute({ query: "docs" } as never, {} as never, { abortSignal: controller.signal } as never);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.equal(cancellationKill, "SIGKILL");
  assert.match(outputText(cancelled), /cancelled/i);

  const tooLong = await getTools(extension).webSearch.execute({ query: "x".repeat(3000) } as never, {} as never, {} as never);
  assert.equal(tooLong.isError, true);
  assert.match(outputText(tooLong), /query.*too long/i);
});
