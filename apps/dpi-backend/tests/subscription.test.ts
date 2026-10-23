import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { loadConfig } from "../src/config.js";
import {
  fileCredentialStore,
  installSubscription,
  subscriptionDefault,
  subscriptionModels,
} from "../src/subscription.js";
import { Store } from "../src/store.js";
import "./helpers.js";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";

const SCOPE = "anthropic/claude-opus-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-haiku-5-5,openai-codex/gpt-6.1-sol,openai-codex/gpt-6-luna";

function catalog() {
  const models = createModels();
  installSubscription(models);
  // Offline catalog availability: never use real logins or call a model.
  models.getAvailable = async (provider?: string) => models.getModels(provider);
  return models;
}

// Real credential resolution, synthetic inputs: the production `createModels` auth path (credential
// store + auth context) with no personal logins, files or network.
type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type StoredCredential = Awaited<ReturnType<CredentialStore["read"]>>;

function syntheticCredentialStore(records: Record<string, { type: "api_key"; key: string }> = {}): CredentialStore {
  const all = new Map<string, StoredCredential>(Object.entries(records));
  return {
    async read(providerId) {
      return all.get(providerId);
    },
    async list() {
      return [...all.entries()].map(([providerId, credential]) => ({ providerId, type: credential!.type }));
    },
    async modify(providerId, fn) {
      const next = await fn(all.get(providerId));
      if (next === undefined) all.delete(providerId);
      else all.set(providerId, next);
      return next;
    },
    async delete(providerId) {
      all.delete(providerId);
    },
  };
}

/** Synthetic process environment for pi-ai's auth context: no personal env, no file probing. */
const syntheticEnv = (env: Record<string, string> = {}) => ({
  env: async (name: string) => env[name],
  fileExists: async () => false,
});

function authenticatedCatalog(
  credentials: CredentialStore = syntheticCredentialStore(),
  env: Record<string, string> = {},
) {
  const models = createModels({ credentials, authContext: syntheticEnv(env) });
  installSubscription(models);
  return models;
}

test("subscription catalog includes official Haiku 5.5 metadata", () => {
  const models = catalog();
  const haiku = models.getModel("anthropic", "claude-haiku-5-5");
  assert.ok(haiku);
  assert.equal(haiku.contextWindow, 1_000_000);
  assert.equal(haiku.maxTokens, 128_000);
  assert.equal(haiku.reasoning, true);
  assert.equal(haiku.api, "anthropic-messages");
  assert.deepEqual(haiku.cost.tiers, [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]);
  assert.equal(models.getAllModels("anthropic").filter((m) => m.id === haiku.id).length, 1);
  installSubscription(models);
  assert.equal(models.getModels("anthropic").filter((m) => m.id === haiku.id).length, 1);
});

test("subscription scope lists exactly the requested five models in order", async () => {
  const result = await subscriptionModels(catalog(), { DPI_SCOPED_MODELS: SCOPE });
  assert.deepEqual(result.map((m) => `${m.provider}/${m.id}`), SCOPE.split(","));
});

test("scope is optional, rejects unknown ids, and excludes unauthenticated providers", async () => {
  const models = catalog();
  assert.ok((await subscriptionModels(models, {})).length > 5);
  await assert.rejects(subscriptionModels(models, { DPI_SCOPED_MODELS: "anthropic/not-a-model" }), /DPI_SCOPED_MODELS/);
  await assert.rejects(subscriptionModels(models, { DPI_SCOPED_MODELS: "claude-haiku-5-5" }), /DPI_SCOPED_MODELS/);
  models.getAvailable = async (provider?: string) => provider === "anthropic" ? [] : models.getModels(provider);
  const result = await subscriptionModels(models, { DPI_SCOPED_MODELS: SCOPE });
  assert.deepEqual(result.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
});

test("subscription mode installs exactly the pinned OpenRouter DeepSeek entry", () => {
  const models = catalog();
  assert.deepEqual(models.getModels("openrouter").map((m) => m.id), [DEEPSEEK]);
  const deepseek = models.getModel("openrouter", DEEPSEEK);
  assert.ok(deepseek);
  assert.equal(deepseek.name, "DeepSeek V4.1 Flash 1017");
  assert.equal(deepseek.api, "openai-completions");
  assert.equal(deepseek.reasoning, true);
  assert.equal(deepseek.contextWindow, 1_048_576);
  // Reconciled with the installed plain-pi catalog (@earendil-works/pi-ai 1.4.0, inspected 2026-10-23).
  assert.equal(deepseek.maxTokens, 393_216);
  assert.deepEqual(deepseek.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.deepEqual(deepseek.input, ["text", "image"]);
});

test("picker lists the subscription models plus one DeepSeek entry, and omits it without OpenRouter auth", async () => {
  const models = catalog();
  const listed = await subscriptionModels(models, {});
  const openrouter = listed.filter((m) => m.provider === "openrouter");
  assert.deepEqual(openrouter.map((m) => m.id), [DEEPSEEK]);
  assert.equal(openrouter[0].icon, "deepseek.png");
  assert.equal(openrouter[0].tier, "A");
  assert.equal(openrouter[0].contextWindow, 1_048_576);
  assert.ok(listed.some((m) => m.provider === "openai-codex"));
  assert.ok(listed.some((m) => m.provider === "anthropic"));

  // No OpenRouter credential on the device: the entry is not advertised, and the subscription list is unchanged.
  models.getAvailable = async (provider?: string) => provider === "openrouter" ? [] : models.getModels(provider);
  const subscriptionOnly = await subscriptionModels(models, {});
  assert.equal(subscriptionOnly.some((m) => m.provider === "openrouter"), false);
  assert.ok(subscriptionOnly.length > 5);
});

test("scope accepts the delegated DeepSeek id and rejects other OpenRouter models", async () => {
  const models = catalog();
  const scope = `anthropic/claude-opus-5-5,openrouter/${DEEPSEEK}`;
  const result = await subscriptionModels(models, { DPI_SCOPED_MODELS: scope });
  assert.deepEqual(result.map((m) => `${m.provider}/${m.id}`), scope.split(","));
  await assert.rejects(subscriptionModels(models, { DPI_SCOPED_MODELS: "openrouter/anthropic/claude-sonnet-5-5" }), /DPI_SCOPED_MODELS/);
  await assert.rejects(subscriptionModels(models, { DPI_SCOPED_MODELS: "openrouter/deepseek/deepseek-v4.1-flash" }), /DPI_SCOPED_MODELS/);
});

test("a subscription device routes the delegated DeepSeek model unchanged and rejects uninstalled OpenRouter ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-sub-store-"));
  const store = await Store.open({
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "test",
    provider: "subscription",
    authFile: join(root, "auth.json"),
  });
  try {
    const deepseek = { provider: "openrouter", modelId: DEEPSEEK };
    assert.deepEqual(store.validateModel(deepseek), deepseek);
    // Recovery routes every conversation's model on open: the delegated model must survive it.
    assert.deepEqual(store.routedModel(deepseek), deepseek);
    assert.throws(() => store.validateModel({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" }), /Unknown model/);
    // Existing selection/default behaviour stays unchanged: the root default is still a subscription model.
    assert.equal(store.deviceInfo().defaultModel, "gpt-6.1-sol");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delegation model that this device does not serve fails startup instead of being substituted", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-sub-delegate-"));
  const options = {
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "test",
    provider: "subscription" as const,
    authFile: join(root, "auth.json"),
  };
  const original = { onboard: process.env.DPI_ONBOARD, delegate: process.env.DPI_DELEGATE_MODEL };
  try {
    process.env.DPI_ONBOARD = "1";
    process.env.DPI_DELEGATE_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
    await assert.rejects(Store.open(options), /DPI_DELEGATE_MODEL.*not available on this device/);
    process.env.DPI_DELEGATE_MODEL = `openrouter/${DEEPSEEK}`;
    const store = await Store.open(options);
    await store.close();
    assert.equal(store.options.provider, "subscription");
  } finally {
    if (original.onboard === undefined) delete process.env.DPI_ONBOARD;
    else process.env.DPI_ONBOARD = original.onboard;
    if (original.delegate === undefined) delete process.env.DPI_DELEGATE_MODEL;
    else process.env.DPI_DELEGATE_MODEL = original.delegate;
    rmSync(root, { recursive: true, force: true });
  }
});

const tmp = () => mkdtempSync(join(tmpdir(), "dpi-sub-"));
const oauth = (n: number) => ({ type: "oauth" as const, access: `a${n}`, refresh: `r${n}`, expires: n });

test("credential store reads pi's auth.json shape and lists without secrets", async () => {
  const dir = tmp();
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ "openai-codex": oauth(1), zai: { type: "api_key", key: "k" } }));
  const store = fileCredentialStore(file);
  assert.deepEqual(await store.read("openai-codex"), oauth(1));
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.list(), [
    { providerId: "openai-codex", type: "oauth" },
    { providerId: "zai", type: "api_key" },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("modify keeps other logins, writes 0600, and delete removes one login", async () => {
  const dir = tmp();
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ anthropic: oauth(1), zai: { type: "api_key", key: "k" } }));
  const store = fileCredentialStore(file);
  await store.modify("anthropic", async () => oauth(2));
  const all = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(all.anthropic, oauth(2));
  assert.deepEqual(all.zai, { type: "api_key", key: "k" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await store.delete("anthropic");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).anthropic, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent refreshes are serialized, so a rotated token is never lost", async () => {
  const dir = tmp();
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ "openai-codex": oauth(0) }));
  // Two stores = two processes sharing one auth.json. Each refresh must see the previous one's result.
  const a = fileCredentialStore(file);
  const b = fileCredentialStore(file);
  const bump = (store: typeof a) =>
    store.modify("openai-codex", async (cur) => {
      const n = (cur as ReturnType<typeof oauth>).expires;
      await new Promise((r) => setTimeout(r, 20)); // a refresh does network I/O
      return oauth(n + 1);
    });
  await Promise.all([bump(a), bump(b), bump(a), bump(b)]);
  assert.deepEqual(await a.read("openai-codex"), oauth(4));
  rmSync(dir, { recursive: true, force: true });
});

test("config accepts DPI_PROVIDER=subscription and rejects unknown providers", () => {
  const env = { DPI_TOKEN: "x".repeat(40), DPI_ENV_FILE: "/nonexistent" };
  const config = loadConfig([], { ...env, DPI_PROVIDER: "subscription", DPI_AUTH_FILE: "/tmp/auth.json" });
  assert.equal(config.provider, "subscription");
  assert.equal(config.authFile, "/tmp/auth.json");
  assert.equal(loadConfig([], env).provider, "openrouter");
  assert.throws(() => loadConfig([], { ...env, DPI_PROVIDER: "bogus" }), /DPI_PROVIDER/);
});

test("default subscription model is overridable as provider/modelId", () => {
  assert.deepEqual(subscriptionDefault({}), { provider: "openai-codex", modelId: "gpt-6.1-sol" });
  assert.deepEqual(subscriptionDefault({ DPI_DEFAULT_MODEL: "anthropic/claude-opus-5-5" }), {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
  });
  assert.throws(() => subscriptionDefault({ DPI_DEFAULT_MODEL: "openrouter/x" }), /DPI_DEFAULT_MODEL/);
});

test("real auth resolution advertises DeepSeek only when a synthetic OpenRouter credential resolves", async () => {
  // Missing credential: the real getAvailable/getAuth path reports nothing and lists nothing.
  const missing = authenticatedCatalog();
  assert.deepEqual(await missing.getAvailable("openrouter"), []);
  assert.equal(await missing.getAuth("openrouter"), undefined);
  assert.equal((await subscriptionModels(missing, {})).some((m) => m.provider === "openrouter"), false);
  // The subscription models stay unknown too, so the device lists exactly nothing here.
  assert.deepEqual(await missing.getAvailable("anthropic"), []);

  // Environment credential: same path, synthetic OPENROUTER_API_KEY only.
  const viaEnv = authenticatedCatalog(syntheticCredentialStore(), { OPENROUTER_API_KEY: "sk-or-synthetic-env" });
  assert.deepEqual((await viaEnv.getAvailable("openrouter")).map((m) => m.id), [DEEPSEEK]);
  const envAuth = await viaEnv.getAuth("openrouter");
  assert.equal(envAuth?.auth.apiKey, "sk-or-synthetic-env");
  assert.deepEqual((await subscriptionModels(viaEnv, {})).filter((m) => m.provider === "openrouter").map((m) => m.id), [DEEPSEEK]);

  // Stored credential: a synthetic api_key in the plain pi auth.json shape.
  const viaStore = authenticatedCatalog(
    syntheticCredentialStore({ openrouter: { type: "api_key", key: "sk-or-synthetic-stored" } }),
  );
  assert.deepEqual((await viaStore.getAvailable("openrouter")).map((m) => m.id), [DEEPSEEK]);
  const storeAuth = await viaStore.getAuth("openrouter");
  assert.equal(storeAuth?.auth.apiKey, "sk-or-synthetic-stored");
  assert.notEqual(storeAuth?.source, envAuth?.source);
});

test("an OpenRouter discovery failure surfaces instead of silently dropping the delegated model", async () => {
  const models = catalog();
  models.getAvailable = async (provider?: string) => {
    if (provider === "openrouter") throw new Error("openrouter catalog offline");
    return models.getModels(provider);
  };
  // Documented policy: a failing optional provider fails the listing (and therefore startup) loudly;
  // nothing is swallowed and no other model is substituted.
  await assert.rejects(subscriptionModels(models, {}), /openrouter catalog offline/);
});

test("the emitted OpenRouter request carries the exact DeepSeek id and the reconciled output cap", async () => {
  const models = authenticatedCatalog(syntheticCredentialStore(), { OPENROUTER_API_KEY: "sk-or-synthetic-env" });
  const deepseek = models.getModel("openrouter", DEEPSEEK);
  assert.ok(deepseek);

  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const stream = models.streamSimple(
    deepseek,
    { messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "ping" }] }] },
    {
      reasoning: "xhigh",
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body ?? "{}")) };
        throw new Error("offline test transport");
      },
    } as never,
  );
  try {
    for await (const _ of stream) {
      // Drain until the injected transport fails; only the outgoing request matters here.
    }
  } catch {
    // A failed offline request is expected.
  }

  assert.ok(captured, "the provider dispatched a request");
  assert.match(captured.url, /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.equal(captured.body.model, DEEPSEEK);
  // The pinned runtime defaults the request cap to model.maxTokens, so the backport value is operational.
  // OpenRouter dispatches through openai-completions with max_completion_tokens.
  assert.equal(captured.body.max_completion_tokens, 393_216);
  assert.equal(captured.body.max_tokens, undefined);
  // durable xhigh clamps to the vendor-supported max, as the catalog declares (xhigh: null).
  assert.deepEqual(captured.body.reasoning, { effort: "max" });
});

test("a persisted subscription device keeps the DeepSeek child and its unchanged Codex root across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-sub-reopen-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const authFile = join(root, "auth.json");
  writeFileSync(authFile, "{}");
  const options = {
    dataDir: join(root, "data"),
    startDirs: [work],
    name: "test",
    provider: "subscription" as const,
    authFile,
  };
  const deepseek = { provider: "openrouter", modelId: DEEPSEEK };
  let sessionId = "";
  let childId = 0;
  try {
    const store = await Store.open(options);
    try {
      const summary = await store.create({ name: "reopen", cwd: work, model: { provider: "openai-codex", modelId: "gpt-6.1-sol" } });
      sessionId = summary.id;
      const row = store.list().find((entry) => entry.id === sessionId);
      assert.ok(row);
      const harness = await store.openAgent(row);
      const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: deepseek } }, BACKGROUND_CONTEXT);
      childId = Number(child.id);
      assert.deepEqual((await child.agent(BACKGROUND_CONTEXT)).model, deepseek);
    } finally {
      await store.close();
    }

    const reopened = await Store.open(options);
    try {
      const row = reopened.list().find((entry) => entry.id === sessionId);
      assert.ok(row);
      assert.equal(row.provider, "openai-codex");
      assert.equal(row.model, "gpt-6.1-sol");
      const harness = await reopened.openAgent(row);
      const rootConversation = await harness.root(BACKGROUND_CONTEXT);
      assert.deepEqual((await rootConversation.agent(BACKGROUND_CONTEXT)).model, {
        provider: "openai-codex",
        modelId: "gpt-6.1-sol",
      });
      const child = await harness.conversation(childId as never, BACKGROUND_CONTEXT);
      assert.ok(child, "the child conversation was recovered");
      assert.deepEqual((await child.agent(BACKGROUND_CONTEXT)).model, deepseek);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
