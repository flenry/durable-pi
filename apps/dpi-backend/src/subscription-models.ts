import type { Model } from "@earendil-works/pi-ai";

// Catalog-only backport from @earendil-works/pi-ai 1.2.0, providers/data/anthropic.json.
// Official ID/capabilities: https://platform.claude.com/docs/en/models/haiku-5-5/overview
// Keep the existing 1.0.3 runtime; prefer its native entry once it includes this model.
export const HAIKU_5_5: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  },
  contextWindow: 1000000,
  maxTokens: 128000,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
  promptCache: { short: 300, long: 3600 },
  inputLimits: {
    maxRequestBytes: 33554432,
    images: { maxPerRequest: 600, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } },
  },
  type: "chat",
};

// Catalog-only backport, copied field-for-field from the installed plain-pi catalog:
//   @earendil-works/pi-ai 1.4.0 (shipped with @earendil-works/pi-coding-agent 1.4.0),
//   dist/providers/data/openrouter.json, key "chat:deepseek/deepseek-v4.1-flash-1017",
//   inspected 2026-10-23.
// The pinned 1.0.3 runtime ships deepseek/deepseek-v4.1-flash but not this dated snapshot, and its
// catalog is older: these values are the current ones, and they control the outgoing request, not
// just the picker (pi-ai defaults `maxTokens` to `model.maxTokens`). Keep the 1.0.3 runtime; prefer
// the native entry once it includes this model.
export const DEEPSEEK_V4_1_FLASH_1017: Model<"openai-completions"> = {
  id: "deepseek/deepseek-v4.1-flash-1017",
  name: "DeepSeek V4.1 Flash 1017",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  input: ["text", "image"],
  cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 393216,
  compat: {
    supportsDeveloperRole: false,
    thinkingFormat: "openrouter",
    supportsStrictMode: true,
    sendSessionAffinityHeaders: true,
    requiresReasoningContentOnAssistantMessages: true,
  },
  inputLimits: {
    images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } },
  },
  type: "chat",
};
