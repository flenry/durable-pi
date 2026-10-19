import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import express from "express";
import { test } from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import {
  DESTRUCTIVE_GUARD_FIXTURES,
  TEST_RUNNER_GUARD_FIXTURES,
  findDestructiveCommand,
  isAmbiguousTestScript,
  rewriteCommand,
} from "../src/onboard/guard-rules.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import { tempStore, until } from "./helpers.js";

test("destructive guard scans heredoc bodies and executable shell syntax", () => {
  const cases = [
    ["quoted executable heredoc", "bash <<'EOF'\nrm -rf /tmp/review-scratch\nEOF", "rm -rf"],
    ["unquoted executable heredoc", "bash <<EOF\nrm -rf /tmp/review-scratch\nEOF", "rm -rf"],
    ["single ampersand list", "echo safe & rm -rf /tmp/review-scratch", "rm -rf"],
    ["process substitution", "echo <(rm -rf /tmp/review-scratch)", "rm -rf"],
    ["echo text matches plain-pi baseline", "echo 'rm -rf /tmp/review-scratch'", "rm -rf"],
    ["printf text matches plain-pi baseline", "printf '%s\\n' 'DROP TABLE users'", "SQL DROP/TRUNCATE"],
  ] as const;
  for (const [name, command, expected] of cases)
    assert.equal(findDestructiveCommand(command)?.label, expected, name);
});

function installCommandModel(store: Store, commandForPrompt: (prompt: string) => string | undefined) {
  const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Guard-fix faux" }] });
  let response: FauxResponseFactory;
  response = async (transcript) => {
    fake.appendResponses([response]);
    const messages = transcript.messages as unknown as { role: string; content?: unknown }[];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") {
        lastUser = index;
        break;
      }
    }
    const content = messages[lastUser]?.content;
    const prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
        : "";
    const afterToolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
    const command = afterToolResult ? undefined : commandForPrompt(prompt);
    return command
      ? fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" })
      : fauxAssistantMessage("I stopped after the tool result.");
  };
  fake.setResponses([response]);
  store.models.setProvider(fake.provider);
}

async function withEnvironment<T>(enabled: boolean, setupDir: string, run: () => Promise<T>): Promise<T> {
  const keys = ["DPI_ONBOARD", "DPI_MEMORY", "DPI_TICKETS", "PI_SETUP_DIR"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DPI_ONBOARD = enabled ? "1" : "0";
  process.env.DPI_MEMORY = "off";
  process.env.DPI_TICKETS = "0";
  process.env.PI_SETUP_DIR = setupDir;
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

test("real guarded bash calls block quoted and unquoted heredocs, background lists, and process substitutions", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await withEnvironment(true, setupDir, async () => {
      store = await fixture.open();
      const session = await store.create({ name: "Guard syntax", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { h, c } = await store.resolveAgent(session.id, "main");
      let command = "";
      installCommandModel(store, (prompt) => prompt.startsWith("probe ") ? command : undefined);
      const probes = [
        (target: string) => `bash <<'EOF'\nrm -rf ${target}\nEOF`,
        (target: string) => `bash <<EOF\nrm -rf ${target}\nEOF`,
        (target: string) => `echo safe & rm -rf ${target}`,
        (target: string) => `echo <(rm -rf ${target})`,
      ];
      for (const [index, makeCommand] of probes.entries()) {
        const target = join(fixture.work, `guard-syntax-${index}`);
        await mkdir(target);
        command = makeCommand(target);
        const submission = await store.send(session.id, c, { content: `probe ${index}`, requestId: `syntax-${index}` });
        assert.equal((await store.settled(h, submission.id as number, 20_000)).status, "done");
        assert.equal(existsSync(target), true, `the guard blocked ${index}: ${command}`);
      }
    });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

async function startRouteServer(store: Store, token: string) {
  const app = express();
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use(errorMiddleware);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("authenticated message route grants approvals once per newly accepted request", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  const token = "guard-route-test-token";
  const target = join(fixture.work, "guard-route-target");
  let store: Store | undefined;
  let server: Awaited<ReturnType<typeof startRouteServer>> | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await mkdir(target);
    await withEnvironment(true, setupDir, async () => {
      store = await fixture.open();
      const session = await store.create({ name: "Approval route", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      installCommandModel(store, (prompt) => {
        if (prompt === "run destructive probe") return `rm -rf ${target}`;
        if (prompt === "hold the root busy") return "sleep 1; echo finished";
        return undefined;
      });
      server = await startRouteServer(store, token);
      const endpoint = `${server.base}/v1/sessions/${session.id}/agents/main/messages`;
      const send = async (content: string, requestId: string, whenBusy = "followUp", waitMs = 20_000) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ content, requestId, whenBusy, waitMs }),
        });
        return { response, body: await response.json() as { submissionId?: number; status?: string; error?: { code: string; message: string } } };
      };
      const entries = async () => {
        const response = await fetch(`${server!.base}/v1/sessions/${session.id}/agents/main/entries?scope=all`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
        return await response.json() as { items: unknown[] };
      };
      const waitFor = async (submissionId: number) => {
        const response = await fetch(`${server!.base}/v1/sessions/${session.id}/submissions/${submissionId}?waitMs=20000`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
      };

      const firstBlock = await send("run destructive probe", "destructive-first");
      assert.equal(firstBlock.response.status, 200);
      assert.equal(existsSync(target), true);
      const approvalHash = /approve ([a-f0-9]{64})/i.exec(JSON.stringify(await entries()))?.[1];
      assert.ok(approvalHash, "the guard returns the exact host approval hash");
      const approvalText = `approve ${approvalHash}`;

      const acceptedApproval = await send(approvalText, "same-human-reply");
      assert.equal(acceptedApproval.response.status, 200);
      const allowed = await send("run destructive probe", "destructive-allowed");
      assert.equal(allowed.response.status, 200);
      assert.equal(existsSync(target), false, "the accepted root approval authorizes one exact command");

      await mkdir(target);
      const secondBlock = await send("run destructive probe", "destructive-second");
      assert.equal(secondBlock.response.status, 200);
      assert.equal(existsSync(target), true, "the first approval has been consumed");
      const duplicateApproval = await send(approvalText, "same-human-reply");
      assert.equal(duplicateApproval.response.status, 200);
      assert.equal(duplicateApproval.body.submissionId, acceptedApproval.body.submissionId);
      const afterDuplicate = await send("run destructive probe", "destructive-after-duplicate");
      assert.equal(afterDuplicate.response.status, 200);
      assert.equal(existsSync(target), true, "a duplicate requestId cannot re-arm the old approval");

      const hold = await send("hold the root busy", "busy-work", "followUp", 25);
      assert.equal(hold.response.status, 202, "the slow root submission remains in progress");
      assert.ok(hold.body.submissionId);
      const rejectedApproval = await send(approvalText, "busy-approval", "reject", 0);
      assert.equal(rejectedApproval.response.status, 409);
      assert.equal(rejectedApproval.body.error?.code, "busy");
      await waitFor(hold.body.submissionId!);
      const afterBusyRejection = await send("run destructive probe", "destructive-after-busy-rejection");
      assert.equal(afterBusyRejection.response.status, 200);
      assert.equal(existsSync(target), true, "a rejected busy submission cannot grant approval");
    });
  } finally {
    await server?.close();
    await store?.close();
    await fixture.cleanup();
  }
});

test("startup upgrades a legacy explicit Extend selection and preserves a later opt-out", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await withEnvironment(false, setupDir, async () => {
      store = await fixture.open();
      const session = await store.create({ name: "Legacy Extend", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, c } = await store.resolveAgent(session.id, "main");
      await store.setExtension(row, c, { name: "system-prompts", enabled: true });
    });
    await store!.close();
    store = undefined;

    await withEnvironment(true, setupDir, async () => {
      store = await fixture.open();
      const session = store.list()[0];
      const { row, c } = await store.resolveAgent(session.id, "main");
      const extensions = () => store!.extensionsOf(row, c);
      assert.equal((await extensions()).extensions.find((item) => item.name === "durable-guards")?.enabled, true);
      assert.equal((await extensions()).extensions.find((item) => item.name === "system-prompts")?.enabled, true);

      await store!.setExtension(row, c, { name: "durable-guards", enabled: false });
      assert.equal((await extensions()).extensions.find((item) => item.name === "durable-guards")?.enabled, false);
    });
    await store!.close();
    store = undefined;

    await withEnvironment(true, setupDir, async () => {
      store = await fixture.open();
      const session = store.list()[0];
      const { row, c } = await store.resolveAgent(session.id, "main");
      assert.equal((await store.extensionsOf(row, c)).extensions.find((item) => item.name === "durable-guards")?.enabled, false,
        "the migration marker and explicit opt-out survive restart");
    });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("startup upgrades a pre-guard helper child owned by an in-flight release check", async () => {
  const fixture = await tempStore();
  const setupDir = join(fixture.root, "empty-setup");
  let store: Store | undefined;
  try {
    await mkdir(setupDir, { recursive: true });
    await withEnvironment(false, setupDir, async () => {
      store = await fixture.open();
      const fake = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Legacy helper faux" }] });
      let response: FauxResponseFactory;
      response = async () => {
        fake.appendResponses([response]);
        return fauxAssistantMessage("Legacy helper facts.");
      };
      fake.setResponses([response]);
      store.models.setProvider(fake.provider);

      const session = await store.create({ name: "Legacy helper recovery", cwd: fixture.work, model: { provider: "faux", modelId: "echo" } });
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const { taskId } = await store.startJob(row, h, c, { job: "release-check", input: { commits: 2 } });
      const runOf = async () => (await store!.agentDoc(h, c, JOB_RUNS_DOC) as {
        items: Record<string, { status: string; approval?: string; childConversationId?: number }>;
      }).items[String(taskId)];
      await until(async () => (await runOf())?.approval === "pending" && !!(await runOf())?.childConversationId, 30_000, "legacy helper to wait for approval");
      const run = await runOf();
      assert.ok(run.childConversationId);
      const helper = (await store.resolveAgent(session.id, String(run.childConversationId))).c;
      assert.equal((await store.agentDetail(row, helper)).extensions.includes("durable-guards"), false,
        "the helper has the pre-upgrade explicit extension selection");
    });
    await store!.close();
    store = undefined;

    await withEnvironment(true, setupDir, async () => {
      store = await fixture.open();
      const session = store.list()[0];
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      const run = (await store.agentDoc(h, c, JOB_RUNS_DOC) as {
        items: Record<string, { status: string; approval?: string; childConversationId?: number }>;
      }).items;
      const waiting = Object.values(run).find((item) => item.approval === "pending");
      assert.ok(waiting?.childConversationId, "the old parent job is still in flight at recovery");
      const helper = (await store.resolveAgent(session.id, String(waiting.childConversationId))).c;
      assert.equal((await store.agentDetail(row, helper)).extensions.includes("durable-guards"), true,
        "the helper selection is migrated before recovery resumes");
    });
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

const parityDir = process.env.PI_GUARDS_PARITY_DIR;
async function importPlainPiSource(path: string) {
  const source = await readFile(path, "utf8");
  const withRuntimeAdapter = source.replace(
    /^import \{ isToolCallEventType \} from "@earendil-works\/pi-coding-agent";$/m,
    "const isToolCallEventType = (toolName, event) => event.toolName === toolName;",
  );
  const javascript = transpileModule(withRuntimeAdapter, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("guard fixture tables match the actual plain-pi rule functions when available", {
  skip: parityDir ? false : "PI_GUARDS_PARITY_DIR is unset; plain-pi source parity is unavailable in this checkout",
}, async () => {
  assert.ok(parityDir);
  const [plainDangerousModule, plainTestRunner] = await Promise.all([
    importPlainPiSource(join(parityDir, "dangerous-bash-guard.ts")),
    importPlainPiSource(join(parityDir, "test-runner-guard.ts")),
  ]);
  for (const fixture of TEST_RUNNER_GUARD_FIXTURES) {
    assert.deepEqual(plainTestRunner.rewriteCommand(fixture.command), fixture.rewritten ?? null, fixture.name);
    assert.equal(plainTestRunner.isAmbiguousTestScript(fixture.command), fixture.ambiguous ?? false, fixture.name);
    assert.deepEqual(rewriteCommand(fixture.command), plainTestRunner.rewriteCommand(fixture.command), fixture.name);
    assert.equal(isAmbiguousTestScript(fixture.command), plainTestRunner.isAmbiguousTestScript(fixture.command), fixture.name);
  }

  type PlainHook = (event: { toolName: string; input: { command: string } }, context: { hasUI: boolean }) => unknown;
  let hook: PlainHook | undefined;
  const extension = plainDangerousModule.default as (pi: { on: (name: string, handler: PlainHook) => void }) => void;
  extension({ on: (_name, handler) => { hook = handler; } });
  assert.ok(hook, "loaded the actual plain-pi destructive hook");
  for (const fixture of DESTRUCTIVE_GUARD_FIXTURES) {
    const result = await hook({ toolName: "bash", input: { command: fixture.command } }, { hasUI: false }) as { block?: unknown; reason?: string } | undefined;
    const label = result?.block && result.reason ? /^Blocked \(([^)]+)\)/.exec(result.reason)?.[1] : undefined;
    assert.equal(label, fixture.label, fixture.name);
    assert.equal(findDestructiveCommand(fixture.command)?.label, fixture.label, fixture.name);
  }
});
