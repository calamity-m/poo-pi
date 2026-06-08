# Core settings

Core extension settings are stored project-locally in `.pi/core-settings.json`. User-scoped defaults that should apply before a project has local core settings are stored in `~/.pi/agent/core-settings.json` (or `$PI_CODING_AGENT_DIR/core-settings.json`).

In an interactive session, run `/core-settings` (no arguments) to open a settings list:

- **Permissions mode** — cycle `safe` / `trusted` / `permissive` / `open`; applied live and persisted. (Interactive only — headless sessions run `open` regardless.)
- **Permissions config** — open the validated JSON editor for permission rules and remembered grants.
- **Proxy audit redaction** — toggle `on` / `off`; persisted and applied to future proxy requests.
- **Client TLS** — launch the secret-safe `/tls-setup` flow. The row shows only a redacted status (`loaded` / `unconfigured` / `error`, or `skipped`); passphrases, certificate bytes, and full target paths are never displayed or persisted.
- **Skip client TLS** — toggle `on` / `off`. When `on` (persisted as `tls.skip` in `.pi/core-settings.json`), client TLS resolution is skipped at startup: no setup prompt and no client certificate is attached. Any previously configured target metadata is kept on disk, so turning skip off restores it without re-setup. Applies on the next startup.
- **History search shortcut** — configure the `/history` shortcut, persisted as `historySearch.shortcut`. Applies after `/reload`.
- **Core settings JSON** — open the raw `.pi/core-settings.json` editor for advanced changes.

The scripted subcommands remain available: `/core-settings show` always prints the effective JSON (never the selector), `/core-settings edit` opens the unified JSON editor, and `/core-settings path` prints the file path. In a headless session, bare `/core-settings` falls back to showing the effective JSON.

The unified file currently contains permissions, non-secret TLS target metadata, and proxy audit redaction settings. TLS passphrases, certificate bytes, and private-key material are never persisted. Structured settings — permission rules, remembered grants, and the TLS target — are edited through their dedicated flows or the raw JSON editor, not as inline rows.
