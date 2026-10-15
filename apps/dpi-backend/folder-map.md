# Durable device backend
- `src/`: API, durable store and subscription catalog; consult its folder map before edits.
- `tests/`: offline API, recovery and subscription tests; consult its folder map before edits.
- `deploy/`: launchd/systemd templates.
- `README.md`: deployment and configuration, including optional subscription model scope.
- `API.md`: wire API reference.
- Runtime credentials and databases live outside this checkout under `~/.dpi` / `~/.pi`.
