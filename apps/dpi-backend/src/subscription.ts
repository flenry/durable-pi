// Subscription provider mode (DPI_PROVIDER=subscription): run agents on the model subscriptions
// you are already logged in to with the pi coding agent (ChatGPT/Codex and Claude OAuth),
// instead of an OpenRouter API key. Credentials come from pi's auth.json, whose shape is
// exactly pi-ai's `Credential` record keyed by provider id.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CreateModelsOptions, MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ModelInfo } from "../../dpi-sdk/src/api.js";
import { HAIKU_5_5 } from "./subscription-models.js";

export const SUBSCRIPTION_PROVIDERS = ["openai-codex", "anthropic"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
export const DEFAULT_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
export const DEFAULT_SUBSCRIPTION_MODEL = { provider: "openai-codex", modelId: "gpt-6.1-sol" } as const;
const ICONS: Record<SubscriptionProvider, string> = { "openai-codex": "openai.png", anthropic: "anthropic.png" };

export const isSubscriptionProvider = (p: string): p is SubscriptionProvider =>
  (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(p);

// pi-ai exports the credential store contract only through CreateModelsOptions.
type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];
type Records = Record<string, Credential>;

/**
 * CredentialStore over a pi auth.json. Reads re-read the file, so logins refreshed by another
 * process (the pi coding agent) are picked up. Writes (OAuth refreshes) hold a lock across
 * read → refresh → write and replace the file atomically with mode 0600, so two processes never
 * refresh the same login at once and invalidate each other's rotated refresh token.
 */
export function fileCredentialStore(file = DEFAULT_AUTH_FILE): CredentialStore {
  const readAll = (): Records => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Records;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  };
  const writeAll = (all: Records) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const lock = `${file}.lock`;
  const acquire = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        mkdirSync(lock);
        return;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true });
        } catch {
          // raced with the holder releasing it
        }
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${lock}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };

  const store: CredentialStore = {
    async read(providerId) {
      return readAll()[providerId];
    },
    async list(): Promise<readonly CredentialInfo[]> {
      return Object.entries(readAll()).map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    async modify(providerId, fn) {
      await acquire();
      try {
        const all = readAll();
        const next = await fn(all[providerId]);
        if (next === undefined) delete all[providerId];
        else all[providerId] = next;
        writeAll(all);
        return next;
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    },
    async delete(providerId) {
      await store.modify(providerId, async () => undefined);
    },
  };
  return store;
}

/** Register the subscription providers on a Models registry created with fileCredentialStore. */
export function installSubscription(models: MutableModels): void {
  models.setProvider(openaiCodexProvider());
  const anthropic = anthropicProvider();
  const chat = anthropic.getModels();
  if (!chat.some((m) => m.id === HAIKU_5_5.id)) {
    const all = anthropic.getAllModels?.() ?? chat;
    anthropic.getModels = () => [...chat, HAIKU_5_5];
    anthropic.getAllModels = () => [...all, HAIKU_5_5];
  }
  models.setProvider(anthropic);
}

/** Authenticated models advertised to clients; optional scope is ordered provider/modelId CSV. */
export async function subscriptionModels(models: MutableModels, env = process.env): Promise<ModelInfo[]> {
  const scope = env.DPI_SCOPED_MODELS?.trim()
    ? [...new Set(env.DPI_SCOPED_MODELS.split(",").map((id) => id.trim()))]
    : undefined;
  for (const id of scope ?? []) {
    const slash = id.indexOf("/");
    const provider = id.slice(0, slash);
    if (slash < 1 || !isSubscriptionProvider(provider) || !models.getModel(provider, id.slice(slash + 1)))
      throw Error(`DPI_SCOPED_MODELS: unknown subscription model ${id}; use provider/modelId`);
  }
  const out: ModelInfo[] = [];
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    const available = await models.getAvailable(provider, { signal: AbortSignal.timeout(10_000) });
    for (const m of available)
      out.push({
        id: m.id,
        provider,
        name: m.name,
        tier: "S",
        icon: ICONS[provider],
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        cost: { input: m.cost.input, output: m.cost.output },
      });
  }
  if (!scope) return out;
  const available = new Map(out.map((m) => [`${m.provider}/${m.id}`, m]));
  return scope.flatMap((id) => available.has(id) ? [available.get(id)!] : []);
}

/** The default model as `provider/modelId`, overridable with DPI_DEFAULT_MODEL. */
export function subscriptionDefault(env = process.env): { provider: SubscriptionProvider; modelId: string } {
  const raw = env.DPI_DEFAULT_MODEL;
  if (!raw) return DEFAULT_SUBSCRIPTION_MODEL;
  const slash = raw.indexOf("/");
  const provider = raw.slice(0, slash);
  if (slash < 1 || !isSubscriptionProvider(provider))
    throw Error(`DPI_DEFAULT_MODEL must be <${SUBSCRIPTION_PROVIDERS.join("|")}>/<modelId>, got ${raw}`);
  return { provider, modelId: raw.slice(slash + 1) };
}
