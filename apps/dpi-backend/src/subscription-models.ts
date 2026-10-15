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
