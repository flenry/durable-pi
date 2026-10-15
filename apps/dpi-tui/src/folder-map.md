# Terminal client source
- `main.ts`: CLI arguments, device resolution and session creation.
- `app.ts`: terminal lifecycle, streams and keyboard dispatch.
- `pickers.ts`: selection overlays and model cycling (provider + id, wraps in device order).
- `commands.ts`: slash commands and `/help` shortcut descriptions.
- `render.ts` / `theme.ts`: transcript rendering and dark styling.
- Model shortcuts change the next turn; overlays keep their own input handling.
