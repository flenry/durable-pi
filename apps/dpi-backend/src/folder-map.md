# Backend source
- `main.ts` / `config.ts`: server startup and environment loading.
- `store.ts`: durable sessions, agent configuration and model validation.
- `subscription.ts`: credential store, provider registration and optional ordered model scope. Subscription mode also installs one pinned OpenRouter model (DeepSeek) so delegated children can run it.
- `subscription-models.ts`: catalog backports (Haiku 5.5, DeepSeek V4.1 Flash 1017); a native provider entry takes precedence when the runtime ships it.
- `onboard/delegate-model.ts`: `DPI_DELEGATE_MODEL` parsing and the explicit > configured > expert model precedence for delegated children.
- `routes.ts` / `streams.ts`: authenticated REST and SSE APIs.
- Scope narrows advertised models; it does not revoke existing-session model access.
