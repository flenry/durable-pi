import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createModels } from "@earendil-works/pi-ai/models";
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
  assert.equal(deepseek.maxTokens, 943_718);
  assert.deepEqual(deepseek.cost, { input: 0.07, output: 0.5, cacheRead: 0.008, cacheWrite: 0 });
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
