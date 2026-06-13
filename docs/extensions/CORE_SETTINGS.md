# Core settings

Core extension settings are stored centrally in `~/.pi/agent/poo/core-settings.json` (or `$PI_CODING_AGENT_DIR/poo/core-settings.json` when Pi's agent dir override is set).

In an interactive session, run `/core-settings` (no arguments) to open a settings list:

- **Permissions mode** — cycle `safe` / `trusted` / `permissive` / `open`; applied live and persisted. (Interactive only — headless sessions run `open` regardless.)
- **Permissions config** — open the validated JSON editor for permission rules and remembered grants.
- **Proxy audit redaction** — toggle `on` / `off`; persisted and applied to future proxy requests.
- **History search shortcut** — configure the `/history` shortcut, persisted as `historySearch.shortcut`. Applies after `/reload`.
- **Core settings JSON** — open the raw `~/.pi/agent/poo/core-settings.json` editor for advanced changes.

The scripted subcommands remain available: `/core-settings show` always prints the effective JSON (never the selector), `/core-settings edit` opens the unified JSON editor, and `/core-settings path` prints the file path. In a headless session, bare `/core-settings` falls back to showing the effective JSON.

The unified file currently contains permissions, proxy audit redaction, subagent, history search, footer, and worktree settings. Structured settings — permission rules and remembered grants — are edited through their dedicated flows or the raw JSON editor, not as inline rows.
