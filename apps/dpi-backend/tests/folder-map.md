# Backend tests
- `subscription.test.ts`: credential persistence, Haiku catalog and ordered model scope (offline).
- `api.test.ts` / `streams.test.ts`: REST contract and streaming behavior.
- `store.test.ts` / `recovery.test.ts`: agent features and checkpoint recovery after SIGKILL.
- `history.test.ts` / `shared-state.test.ts`: history search and persisted app state.
- Node test runner via tsx; faux models and synthetic credentials, never personal logins.
