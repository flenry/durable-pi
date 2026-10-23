# Backend tests
- `subscription.test.ts`: credential persistence, Haiku/DeepSeek catalog, ordered model scope, subscription routing of the delegated model (offline).
- `delegate-model.test.ts`: `DPI_DELEGATE_MODEL` parsing, loud failures on unusable values, and delegation model precedence.
- `api.test.ts` / `streams.test.ts`: REST contract and streaming behavior.
- `store.test.ts` / `recovery.test.ts`: agent features and checkpoint recovery after SIGKILL.
- `onboard-experts.test.ts` / `onboard-tickets.test.ts`: delegate and ticket-slice children take the configured delegation model while keeping their expert thinking level.
- `history.test.ts` / `shared-state.test.ts`: history search and persisted app state.
- Node test runner via tsx; faux models and synthetic credentials, never personal logins.
