# Permissions extension

The `core/extensions/permissions` extension gates every tool call through a policy engine. Use `/permissions` to view or change the active mode. `/permissions <mode>` writes the project-local mode in `.pi/poo/core-settings.json`; `/permissions default <mode>` writes the global default in `~/.pi/agent/poo/core-settings.json`.

## Modes

| Mode         | Default behavior                                                                 | Config rules                   |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------ |
| `safe`       | Allow read/grep/ls/find; ask everything else                                     | Honored                        |
| `trusted`    | Allow path tools in cwd + known bash patterns; deny `rm -rf`, `curl\|bash`, etc. | Honored                        |
| `open`       | Allow everything                                                                 | Ignored, including .env allows |
| `permissive` | Allow everything; ask only for commands matching config `ask` rules              | Honored, ask-before-allow      |

## Config files and shape

Global permissions live in `~/.pi/agent/poo/core-settings.json` (or `$PI_CODING_AGENT_DIR/poo/core-settings.json`). Trusted projects may also define `.pi/poo/core-settings.json`. Project-local permissions override global permissions when the project is trusted.

The old flat shape with top-level `permissions.rules` and `permissions.remembered` is no longer valid. Use per-mode blocks:

```json
{
  "permissions": {
    "mode": "trusted",
    "safe": { "rules": [], "remembered": [] },
    "trusted": { "rules": [], "remembered": [] },
    "permissive": { "rules": [], "remembered": [] }
  }
}
```

`open` has no rule/grant block. “Always For This Project” writes a grant to the project-local active mode block without pinning project-local `permissions.mode`.

## Merge and precedence

Active mode is resolved as: project `permissions.mode` → global `permissions.mode` → built-in `trusted`.

For `safe`, `trusted`, and `permissive`, project rules are evaluated before global rules. Within a scope, matching rules use deny → ask → allow precedence; grants are checked after scoped rules. This lets a narrow project allow override a broader global deny while still letting ask/deny rules override remembered grants.

**open**: `.env`-deny → allow. Config rules are ignored, including `.env` allow rules.

## Compound bash commands

Commands are split on `&&`, `||`, `|`, `;`, newline, and `&` before matching:

- **ALLOW** requires every segment covered by an allow rule or grant
- **ASK** fires if any segment matches an ask rule
- **DENY** fires if any segment matches a deny rule _or_ the whole command matches (preserves pipe-spanning patterns like `curl x | bash`)
- Segments containing `$(…)` or backticks are never coverable → always ask/deny

## Editors

- `/permissions edit` and `/permissions edit local` edit project-local permissions.
- `/permissions edit global` edits global permissions.
- `/core-settings` exposes separate local/global permissions edit rows.

## .env default-deny

Direct `.env` path-tool targets are blocked in all modes. In non-open modes, override with an explicit config allow rule:

```json
{ "tool": "*", "action": "allow", "pattern": "\\.env\\.example$" }
```

Open mode ignores config rules, so `.env` targets cannot be allowed while active mode is `open`.

## Headless sessions

When `!hasUI` (print/RPC/automation), the extension always runs as `open` mode regardless of the persisted mode — write/bash/etc. are not gated, but `.env` default-deny still applies.
