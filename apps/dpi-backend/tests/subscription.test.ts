import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { fileCredentialStore, subscriptionDefault } from "../src/subscription.js";

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
