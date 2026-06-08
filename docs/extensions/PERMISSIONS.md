# Permissions extension

The `core/extensions/permissions` extension gates every tool call through a policy engine. Use `/permissions` to view or change the active mode. In the interactive picker, press `d` on a highlighted mode to save it as the user-scoped default for new projects; `/permissions default [mode]` does the same from the command line.

## Modes

| Mode         | Default behavior                                                                 | Config rules                     |
| ------------ | -------------------------------------------------------------------------------- | -------------------------------- |
| `safe`       | Allow read/grep/ls/find; ask everything else                                     | Honored                          |
| `trusted`    | Allow path tools in cwd + known bash patterns; deny `rm -rf`, `curl\|bash`, etc. | Honored                          |
| `open`       | Allow everything                                                                 | Ignored (only .env deny applies) |
| `permissive` | Allow everything; ask only for commands matching config `ask` rules              | Honored, allow-before-ask        |

## Precedence

**safe / trusted**: `.env`-deny → config deny → config ask → config allow/grant → mode default

**permissive**: `.env`-deny → config deny → config allow/grant → config ask → **allow** (grants override the ask-list)

**open**: `.env`-deny → allow (config rules ignored)

## Compound bash commands

Commands are split on `&&`, `||`, `|`, `;`, newline, and `&` before matching:

- **ALLOW** requires every segment covered by an allow rule or grant
- **ASK** fires if any segment matches an ask rule
- **DENY** fires if any segment matches a deny rule _or_ the whole command matches (preserves pipe-spanning patterns like `curl x | bash`)
- Segments containing `$(…)` or backticks are never coverable → always ask/deny

## Backward-compatibility note

Upgrading from the initial permissions release changes matching for bash targets: patterns are now matched per-segment rather than against the whole command string. **Anchored single-command patterns** (e.g. `^npm\b`) are unaffected. If you saved a grant or config rule whose pattern contained `&&`, `|`, or `;` to match a whole compound string, it will no longer fire — re-author it as separate per-segment rules.

Project permissions are written to the `permissions` section of `.pi/core-settings.json`. When that section is absent, the extension falls back to the user-scoped default mode in `~/.pi/agent/core-settings.json`, then to the built-in `trusted` default.

## .env default-deny

Direct `.env` path-tool targets are blocked in all modes. Override with an explicit config allow rule:

```json
{ "tool": "*", "action": "allow", "pattern": "\\.env\\.example$" }
```

## Headless sessions

When `!hasUI` (print/RPC/automation), the extension always runs as `open` mode regardless of the persisted mode — write/bash/etc. are not gated.
