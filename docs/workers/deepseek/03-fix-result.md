# DeepSeek review fix — result

Status: F1 and F2 fixed, verified locally, committed. No push, deploy, restart, credential access or remote request.

Source review: `docs/workers/deepseek/02-review-result.md` (verdict FIX; F1 blocking, F2 non-blocking coverage).

## F1 — catalog metadata reconciled (P1)

The backport claimed `maxTokens: 943718` and prices `0.07 / 0.5 / 0.008`. Both were transcribed from the plain-pi **1.2.0** `models-store.json` snapshot and were stale: the currently installed plain-pi catalog is older-runtime-independent and says otherwise.

Dated evidence used (read locally, no secrets, no network):

```
file: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/
      @earendil-works/pi-ai/dist/providers/data/openrouter.json
package: @earendil-works/pi-ai 1.4.0 (shipped with @earendil-works/pi-coding-agent 1.4.0)
key:     "chat:deepseek/deepseek-v4.1-flash-1017"
seen:    2026-10-23
```

Field-by-field comparison against the previous backport — only two values differed:

| Field | Was | Now (1.4.0 catalog) |
|---|---|---|
| `maxTokens` | 943718 | **393216** |
| `cost.input` | 0.07 | **0.15** |
| `cost.output` | 0.5 | **0.6** |
| `cost.cacheRead` | 0.008 | **0.003** |
| `cost.cacheWrite` | 0 | 0 |
| `contextWindow` | 1048576 | 1048576 (unchanged) |
| `max` thinking, `thinkingLevelMap`, `compat`, `inputLimits`, `input` | — | unchanged |

`src/subscription-models.ts` now cites that file, version and inspection date, and the constants carry the reconciled values. This matters operationally, not cosmetically: the pinned runtime's `api/simple-options.js` defaults `maxTokens` to `model.maxTokens`, so the backport value is the outgoing request cap.

Regression added (real provider request, injected transport, no network):

- `tests/subscription.test.ts` → "the emitted OpenRouter request carries the exact DeepSeek id and the reconciled output cap": `createModels` with a synthetic credential store + synthetic auth context, `installSubscription`, real `models.streamSimple(deepseek, …, { reasoning: "xhigh", fetch })`. The injected fetch captures the dispatch and throws. Asserts:
  - URL `https://openrouter.ai/api/v1/chat/completions…`
  - `body.model === "deepseek/deepseek-v4.1-flash-1017"` (exact id, no substitution)
  - `body.max_completion_tokens === 393216` and no `max_tokens` field (OpenRouter uses the `max_completion_tokens` form)
  - `body.reasoning === { effort: "max" }` — durable `xhigh` clamps to the vendor-supported `max`, which removes the "may clamp" uncertainty from the first result.
- Catalog metadata assertions updated to 393 216 / 0.15 / 0.6 / 0.003.

## F2 — credential and persistence fidelity (P2)

Replaced list-mocking with the real auth path, synthetic inputs only:

1. **Real credential resolution** — `tests/subscription.test.ts` → "real auth resolution advertises DeepSeek only when a synthetic OpenRouter credential resolves". Uses `createModels({ credentials, authContext })` where `credentials` is an in-memory `CredentialStore` and `authContext` is `{ env(), fileExists() }` returning synthetic values, then the real `getAvailable("openrouter")` / `getAuth("openrouter")`:
   - **missing**: `getAvailable` → `[]`, `getAuth` → `undefined`, and `subscriptionModels` advertises no OpenRouter entry (while `anthropic` stays unknown too, so nothing is invented);
   - **env**: synthetic `OPENROUTER_API_KEY` → exactly the DeepSeek id, `getAuth().auth.apiKey` equals the synthetic key, `subscriptionModels` lists the entry;
   - **store**: synthetic `{"openrouter": {"type":"api_key","key":…}}` → same model list, `getAuth()` resolves the stored key from a different source label than the env case.
2. **Real persistence regression** — "a persisted subscription device keeps the DeepSeek child and its unchanged Codex root across reopen": real `Store.open` (subscription provider, temp data dir, empty temp auth file, no sessions' credentials), `store.create` a Codex root session, `harness.createConversation` a child with the DeepSeek model, `store.close()`, then `Store.open` again on the same data dir. Asserts the catalog row stays `openai-codex/gpt-6.1-sol`, the recovered root agent model is still Codex, and the recovered child agent model is still exactly `openrouter/deepseek/deepseek-v4.1-flash-1017`. This exercises the real `openAgent` recovery loop that previously could silently re-route a child.
3. **Optional-provider policy documented** — "an OpenRouter discovery failure surfaces instead of silently dropping the delegated model": when `getAvailable("openrouter")` throws, `subscriptionModels` rejects loudly (and therefore startup fails) rather than swallowing the provider or substituting a model. This records the residual risk the review noted instead of leaving it implicit.

Catalog-only tests remain (`catalog()` with a stubbed `getAvailable`) for the fast structural assertions; they are no longer the only evidence for credential behaviour.

## Files touched

- `apps/dpi-backend/src/subscription-models.ts` — reconciled values + dated source citation.
- `apps/dpi-backend/tests/subscription.test.ts` — updated metadata assertions; four new tests (real auth missing/env/store, discovery failure, injected-transport request, persisted Store close/reopen).
- `docs/workers/deepseek/01-result.md` — original result corrected (metadata, test count, xhigh note) with a pointer to this fix iteration, so watchers see the completion update.
- `docs/workers/deepseek/03-fix-result.md` — this file.

No source behaviour changed beyond the catalog numbers: registration, eligibility, routing, delegation precedence and deployment knobs are untouched.

## Verification

From `apps/dpi-backend` with `PI_GUARDS_PARITY_DIR=/Users/ced/.pi/agent/extensions` and `PI_MEMORY_CLI_TEST_PATH=/Users/ced/.pi/bin/pi-memory.ts`:

| Check | Result |
|---|---|
| `./node_modules/.bin/tsc --noEmit -p .` | clean (strict) |
| `tsx --test --test-concurrency=2 tests/subscription.test.ts` | 17/17 pass |
| `tsx --test --test-concurrency=2 tests/*.test.ts` | **147 pass, 0 fail** (~50 s; 143 before this fix) |
| `git diff --check` | clean (no whitespace errors) |

## Commit

`fix: reconcile deepseek catalog metadata` on branch `deepseek-model` (worktree `/Users/ced/personal/durable-pi-deepseek`), on top of `1a61fb3`. The commit that adds this result file and the `01-result.md` correction is doc-only and follows it. No push.

Local-only install artifacts stay untracked and uncommitted: `apps/dpi-backend/pnpm-lock.yaml`, `apps/dpi-backend/pnpm-workspace.yaml`.

## Deployment

Unchanged from `01-result.md`: opt-in `DPI_DELEGATE_MODEL=openrouter/deepseek/deepseek-v4.1-flash-1017`, `DPI_ONBOARD=1`, Home's `DPI_SCOPED_MODELS` extended, OpenRouter credential present (safe check `grep -c '^OPENROUTER_API_KEY=' ~/.dpi/backend.env` → `1`), then `just net deploy <id>` + `just net restart <id>`. Nothing was deployed here; credentials and live validity remain unverified.

## Residual notes

- The backport now mirrors the installed 1.4.0 catalog; when the pinned runtime is upgraded and ships the native entry, `installSubscription` prefers it automatically and this copy becomes dead weight.
- Pricing/cap changes affect accounting and the default output ceiling only; no request-shape logic changed.
- Live OpenRouter acceptance of 393 216 output tokens was not exercised (no network, no credentials); the assertion is against the current authoritative local catalog and the emitted payload.

## Learnings

- Project memory `worked`: a catalog backport is operational config — its `maxTokens` becomes the request cap and its prices drive accounting, so reconcile against the current installed catalog and assert the emitted payload, not the constant.
- Project memory `conventions`-worthy test pattern: pi-ai's real `getAvailable`/`getAuth`/`streamSimple` can be exercised offline with an in-memory `CredentialStore` + synthetic `authContext` + injected `fetch`, and Store recovery is testable by close/reopen on a temp data dir — no personal logins or network.
- Expert best practices: when a review flags "tests mock the integration", replace the mock with the real seam and synthetic inputs instead of adding more assertions to the mock.
