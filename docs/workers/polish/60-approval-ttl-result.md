# 60 — Approval TTL fix result

## Outcome

Implemented and committed as `c342b14` (`fix: extend destructive approval ttl`).

Pending destructive-command approvals now expire after 24 hours and remain process-local, bounded/pruned, root-only, exact-hash, and one-shot. Process restarts still discard approval state and fail closed. Root approval replies now include accepted/unknown status in the submitted transcript; rejected submissions do not grant approval. Blocked-tool guidance explicitly says to rerun the exact command once after approval, even if earlier attempts failed.

## Repro first

Added fake-clock regression coverage that advances beyond the old 10-minute TTL, accepts the root approval, then confirms the exact command can be consumed once; another request is verified expired at 24 hours. Ran the late-approval case on baseline `0fafa65`; it failed because `approve()` returned `false`. It passes after the fix.

## Tests

- `cd apps/dpi-backend && ./node_modules/.bin/tsc --noEmit -p .` — passed.
- Full backend suite with the task's required parity/memory environment — **130 passed, 0 failed**.
- `git diff --check` — passed.

## Learnings

- Keep the approval side effect after successful submission admission: busy/rejected submissions must not grant. Determine transcript feedback from a non-mutating pending check, then grant only after `c.submit()` succeeds.
- Approval records remain process-local by design; a backend restart invalidates outstanding codes, preserving fail-closed behavior.
