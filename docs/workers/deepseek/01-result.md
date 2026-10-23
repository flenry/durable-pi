# Expose DeepSeek in durable — result

Status: implemented, verified locally, committed. No push, no deploy, no credential or secret access.

## What durable actually supported before this change

- `DPI_PROVIDER=openrouter` was a full first-class mode (`store.ts` installs `openrouterProvider()` and requires every curated id to exist in the vendor catalog), and `DPI_PROVIDER=subscription` ran only `openai-codex` + `anthropic` with pi's `auth.json`.
- The two modes were mutually exclusive. In `subscription` mode the OpenRouter provider was not registered at all, and `subscriptionModels`, `validateModel`, `routedModel`, `DPI_SCOPED_MODELS` validation and `subscriptionDefault` all rejected `provider: "openrouter"`.
- Execution gate: pi-durable's `generation.prepare` resolves `models.getModel(provider, modelId)` and fails with `failNoModel` when the provider is not installed, so an unregistered OpenRouter model could never run.
- Recovery gate: `Store.openAgent` re-routes **every** conversation's model through `routedModel()` on open (store.ts), so even a correctly configured child would have been silently reset to `openai-codex/gpt-6.1-sol` on the next backend restart.
- Delegation gate: `onboard/experts.ts:modelRef()` and `onboard/tickets.ts:ensureTicketChild()` take the child model from the `pi-memory expert` payload, i.e. the plain-pi expert store (`~/.pi/experts/config.json` + `config.local.json`). There was no durable-side child-model knob.
- Catalog gate: the pinned `@earendil-works/pi-ai@1.0.3` ships `deepseek/deepseek-v4.1-flash` but **not** `deepseek/deepseek-v4.1-flash-1017` (plain pi knows it via pi-ai 1.2.0). Verified against `node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json`.
- Credentials: OpenRouter authenticates via `OPENROUTER_API_KEY` resolved from `process.env` (the backend loads `~/.dpi/backend.env`) or an `openrouter` api-key entry in `DPI_AUTH_FILE`. Presence on either device is still **unknown** (never inspected).

## Changes (all inside `apps/dpi-backend`, plus this doc)

1. `src/subscription-models.ts` — added `DEEPSEEK_V4_1_FLASH_1017`, a catalog-only backport (same pattern as the existing `HAIKU_5_5`). Metadata transcribed from the installed plain-pi catalog: cost 0.07 / 0.5 / cacheRead 0.008, context 1 048 576, maxTokens 943 718, reasoning, `openai-completions`, `thinkingLevelMap` with `max: "max"`. No dependency bump; the native entry wins automatically if a future pi-ai ships it.
2. `src/subscription.ts` — `installSubscription` also registers `openrouterProvider()` narrowed to exactly that one entry (`SUBSCRIPTION_OPENROUTER_MODELS`), even if the vendor catalog later grows. New `isSubscriptionModel(provider, modelId)` is the single predicate for "runnable in subscription mode". `subscriptionModels` lists subscription providers plus the deepseek entry (`tier A`, `icon deepseek.png`) and accepts `openrouter/deepseek/deepseek-v4.1-flash-1017` in `DPI_SCOPED_MODELS`; other OpenRouter ids still fail. `subscriptionDefault` is unchanged.
3. `src/store.ts` — subscription `routedModel`/`validateModel` accept the pinned OpenRouter model through `isSubscriptionModel` and keep it verbatim through recovery (no fallback to a subscription model). Startup now rejects a configured delegation model that this device cannot resolve: `DPI_DELEGATE_MODEL: <provider>/<modelId> is not available on this device; ... Delegation never substitutes a model.`
4. `src/onboard/delegate-model.ts` (new) — `parseDelegateModel()` for `<provider>/<modelId>` (model ids may contain slashes) and `delegatedModel()` precedence: **explicit per-child model > `DPI_DELEGATE_MODEL` > expert config**. No tool passes an explicit per-child model today; the parameter exists so the order is documented and tested when one is added.
5. `src/config.ts` — startup fails fast on a malformed `DPI_DELEGATE_MODEL`, even when onboarding (its only consumer) is off.
6. `src/onboard/config.ts` — `OnboardOptions.delegateModel` from `DPI_DELEGATE_MODEL`; unset = `undefined` = today's behaviour.
7. `src/onboard/experts.ts`, `src/onboard/tickets.ts`, `src/onboard/index.ts` — `delegate` children and ticket-slice children take the configured model; the expert's own **thinking level** is kept (`max` → durable `xhigh`); root conversations and plain-pi expert config are never touched.
8. Tests — `tests/delegate-model.test.ts` (new), additions to `tests/subscription.test.ts`, `tests/onboard-experts.test.ts`, `tests/onboard-tickets.test.ts`.
9. Docs — `apps/dpi-backend/README.md` (new `DPI_DELEGATE_MODEL` row + a "Delegated workers on DeepSeek" section), `src/folder-map.md`, `tests/folder-map.md`.

Exposure is deliberately narrow: subscription devices list exactly their OAuth models plus `openrouter/deepseek/deepseek-v4.1-flash-1017`. `DPI_PROVIDER=openrouter` devices are unchanged (curated catalog), so this model id is subscription-mode only.

## Verification

Run from `apps/dpi-backend`, with `PI_GUARDS_PARITY_DIR=/Users/ced/.pi/agent/extensions` and `PI_MEMORY_CLI_TEST_PATH=/Users/ced/.pi/bin/pi-memory.ts`:

| Check | Result |
|---|---|
| `./node_modules/.bin/tsc --noEmit -p .` | clean (strict) |
| `tsx --test --test-concurrency=2 tests/subscription.test.ts tests/delegate-model.test.ts` | 19/19 pass |
| `tsx --test --test-concurrency=2 tests/onboard-experts.test.ts tests/onboard-tickets.test.ts` | 36/36 pass |
| `tsx --test --test-concurrency=2 tests/*.test.ts` | **143 pass, 0 fail** (baseline before the change: 130 pass) |

Covered behaviours: catalog entry installed and nothing else; picker shows the entry with credentials and omits it without them while the subscription list is unchanged; scope accepts the deepseek id and rejects other OpenRouter ids; a subscription device routes/validates the delegated model unchanged and rejects uninstalled ids; device `defaultModel` stays `gpt-6.1-sol`; unknown-in-device `DPI_DELEGATE_MODEL` fails startup; malformed value fails startup; precedence explicit > configured > expert; delegate child gets the configured model with the expert's thinking level and the root agent doc is untouched; ticket-slice child does the same.

## Commit

`76efb11 feat: expose deepseek to delegated workers` on branch `deepseek-model` (worktree `/Users/ced/personal/durable-pi-deepseek`), based on `696d648`. The commit that records this result file is doc-only and follows it. Final re-verification after that commit: `tsc --noEmit -p .` clean, full suite 143/143 pass at concurrency 2.

Local-only install artifacts, deliberately **not** committed (delete if unwanted): `apps/dpi-backend/pnpm-lock.yaml`, `apps/dpi-backend/pnpm-workspace.yaml` (pnpm 11 wrote `allowBuilds` placeholders for `@google/genai`, `esbuild`, `protobufjs`; ignored build scripts do not affect tsx/tsc). `apps/dpi-backend/package-lock.json` and `docs/architecture.html` were not touched.

## Deployment (parent only; nothing was deployed from here)

Applies to the subscription devices (the VM and Home). OpenRouter mode devices are unaffected.

1. **Credential presence — safe check, no values.** On each device (Home locally, since it has no inbound SSH; VM via its ssh path):
   `grep -c '^OPENROUTER_API_KEY=' ~/.dpi/backend.env` → `1` means present. Do **not** print the file or the value. If `0`, the DeepSeek model will not be advertised and delegated children will fail with the provider's auth error; supply the key through the normal secret channel (`env_keys: [OPENROUTER_API_KEY]` in `dpi-network.yaml` reads it from `.env`) before enabling `DPI_DELEGATE_MODEL`.
2. **Device env** (device `env` block in `dpi-network.yaml`, then `just net up <id>` writes `~/.dpi/backend.env`):
   - both devices: `DPI_DELEGATE_MODEL: openrouter/deepseek/deepseek-v4.1-flash-1017`
   - ensure `DPI_ONBOARD: 1` (delegation is off without onboarding)
   - **Home only**, which currently has a scope: append `openrouter/deepseek/deepseek-v4.1-flash-1017` to `DPI_SCOPED_MODELS`, e.g.
     `anthropic/claude-opus-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-haiku-5-5,openai-codex/gpt-6.1-sol,openai-codex/gpt-6-luna,openrouter/deepseek/deepseek-v4.1-flash-1017`
   - the VM has no scope, so the entry appears automatically once credentials exist.
3. **Code**: `just net deploy <id>` then `just net restart <id>` (service restart is required; the change is code, not data). No migration, no data-dir change.
4. **Verify after restart** (token from the device env, never echoed):
   - `just net probe <id>` → `/healthz` 200, `/v1/device` 401 without token.
   - `curl -s -H "Authorization: Bearer $DPI_TOKEN" https://<device>/v1/device | jq '.defaultModel, [.models[].id]'` → `defaultModel` unchanged (`gpt-6.1-sol` unless a device overrides `DPI_DEFAULT_MODEL`), and `deepseek/deepseek-v4.1-flash-1017` present only when the key is.
   - From a root session, delegate one trivial task, then
     `curl -s -H "Authorization: Bearer $DPI_TOKEN" https://<device>/v1/sessions/<session>/agents/<child>/config | jq .model`
     → `{"provider":"openrouter","modelId":"deepseek/deepseek-v4.1-flash-1017"}`. The root agent's own `/config` must still show the model the user chose.
   - Rollback: remove `DPI_DELEGATE_MODEL` (and the scope addition) and restart; unset restores expert-config models exactly.

## Caveats and open items

- Credentials on both devices remain unverified (no secret access); step 1 is the only safe check.
- `DPI_DELEGATE_MODEL` only affects onboarding delegation. If the parent wants durable-wide adoption it must be in each device's env; nothing is on by default.
- Expert thinking levels `max` map to durable `xhigh`, and the DeepSeek catalog entry declares `xhigh: null`, so pi's thinking-level clamping may send the nearest supported level (`max`) at request time. This is pre-existing vendor-capability behaviour, not a durable substitution.
- `justfile` / root `README` / `.claude/commands/install.md` still document `npm install`; outside the owned paths, unchanged. I installed with pnpm per the task.

## Learnings

- Project memory `decisions` (new): the DeepSeek default is durable-delegation-only; plain-pi expert config stays untouched; root model unchanged.
- Project memory `worked`: how subscription mode hosts one foreign-provider model, and the `openAgent` re-routing trap that would silently undo it.
- Expert best practices (`model-catalog-and-shared-config`): check the installed vendored catalog before assuming an id exists (small backport beats a dependency bump), and put overrides for shared config in the calling product behind a flag with tested precedence.
