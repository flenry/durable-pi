import { test } from "node:test";
import assert from "node:assert/strict";
import { delegatedModel, parseDelegateModel } from "../src/onboard/delegate-model.js";
import { onboardOptionsFromEnv } from "../src/onboard/config.js";
import { loadConfig } from "../src/config.js";
import { subscriptionDefault } from "../src/subscription.js";

const DEEPSEEK = "openrouter/deepseek/deepseek-v4.1-flash-1017";

test("DPI_DELEGATE_MODEL parses provider/modelId with slashes in the model id", () => {
  assert.deepEqual(parseDelegateModel(DEEPSEEK), {
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash-1017",
  });
  assert.deepEqual(parseDelegateModel(" openai-codex/gpt-6-luna "), { provider: "openai-codex", modelId: "gpt-6-luna" });
  assert.equal(parseDelegateModel(undefined), undefined);
  assert.equal(parseDelegateModel("   "), undefined);
});

test("an unusable DPI_DELEGATE_MODEL fails loudly instead of being ignored", () => {
  assert.throws(() => parseDelegateModel("deepseek-v4.1-flash-1017"), /DPI_DELEGATE_MODEL must be <provider>\/<modelId>/);
  assert.throws(() => parseDelegateModel("/gpt-6-luna"), /DPI_DELEGATE_MODEL must be <provider>\/<modelId>/);
  assert.throws(() => parseDelegateModel("openrouter/"), /DPI_DELEGATE_MODEL must be <provider>\/<modelId>/);
  assert.throws(
    () => onboardOptionsFromEnv({ DPI_DELEGATE_MODEL: "not-a-model" }),
    /DPI_DELEGATE_MODEL must be <provider>\/<modelId>/,
  );
});

test("onboarding carries the delegation model only when it is configured", () => {
  assert.equal(onboardOptionsFromEnv({}).delegateModel, undefined);
  assert.deepEqual(onboardOptionsFromEnv({ DPI_DELEGATE_MODEL: DEEPSEEK }).delegateModel, {
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash-1017",
  });
});

test("delegation model precedence is explicit per-child, then DPI_DELEGATE_MODEL, then the expert config", () => {
  const explicit = { provider: "faux", modelId: "explicit" };
  const configured = { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash-1017" };
  const expert = { provider: "openai-codex", modelId: "gpt-6-luna" };
  assert.deepEqual(delegatedModel(explicit, configured, expert), explicit);
  assert.deepEqual(delegatedModel(undefined, configured, expert), configured);
  assert.deepEqual(delegatedModel(undefined, undefined, expert), expert);
});

test("startup rejects a malformed DPI_DELEGATE_MODEL even when onboarding is off", () => {
  const env = { DPI_TOKEN: "x".repeat(40), DPI_ENV_FILE: "/nonexistent" };
  assert.throws(() => loadConfig([], { ...env, DPI_DELEGATE_MODEL: "deepseek" }), /DPI_DELEGATE_MODEL must be <provider>\/<modelId>/);
  assert.equal(loadConfig([], { ...env, DPI_DELEGATE_MODEL: " " }).token.length, 40);
});

test("DPI_DELEGATE_MODEL never changes the device's root default model", () => {
  assert.deepEqual(subscriptionDefault({ DPI_DELEGATE_MODEL: DEEPSEEK }), {
    provider: "openai-codex",
    modelId: "gpt-6.1-sol",
  });
});
