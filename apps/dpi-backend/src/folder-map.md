# Backend source
- `main.ts` / `config.ts`: server startup and environment loading.
- `store.ts`: durable sessions, agent configuration and model validation.
- `subscription.ts`: credential store, provider registration and optional ordered model scope.
- `subscription-models.ts`: official Haiku 5.5 catalog backport; native provider entry takes precedence.
- `routes.ts` / `streams.ts`: authenticated REST and SSE APIs.
- Scope narrows advertised models; it does not revoke existing-session model access.
