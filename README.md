# poo-pi

Installable Pi package scaffold for bundling project-level resources:

- `extensions/` — TypeScript/JavaScript Pi extensions
- `skills/` — Agent Skills directories containing `SKILL.md`
- `prompts/` — Markdown prompt templates exposed as slash commands
- `themes/` — Pi theme JSON files

## Install

From this repository:

```bash
pi install /absolute/path/to/poo-pi
```

For a project-local install:

```bash
pi install /absolute/path/to/poo-pi -l
```

For development without installing:

```bash
pi -e ./extensions/poo-pi.ts --theme ./themes/poo-dark.json
```

## Package manifest

Pi discovers package resources from `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

## Current resources

```text
extensions/
  poo-pi.ts
  core/index.ts
skills/
  pi-package-maintainer/SKILL.md
  surgical-refactor/SKILL.md
prompts/
  plan.md
  release-check.md
  review.md
themes/
  poo-dark.json
  poo-light.json
```

## Core settings

Core extension settings are stored project-locally in `.pi/core-settings.json`.

In an interactive session, run `/core-settings` (no arguments) to open a settings list:

- **Permissions mode** — cycle `safe` / `trusted` / `permissive` / `open`; applied live and persisted. (Interactive only — headless sessions run `open` regardless.)
- **Permissions config** — open the validated JSON editor for permission rules and remembered grants.
- **Proxy audit redaction** — toggle `on` / `off`; persisted and applied to future proxy requests.
- **Client TLS** — launch the secret-safe `/tls-setup` flow. The row shows only a redacted status (`loaded` / `unconfigured` / `error`, or `skipped`); passphrases, certificate bytes, and full target paths are never displayed or persisted.
- **Skip client TLS** — toggle `on` / `off`. When `on` (persisted as `tls.skip` in `.pi/core-settings.json`), client TLS resolution is skipped at startup: no setup prompt and no client certificate is attached. Any previously configured target metadata is kept on disk, so turning skip off restores it without re-setup. Applies on the next startup.
- **Core settings JSON** — open the raw `.pi/core-settings.json` editor for advanced changes.

The scripted subcommands remain available: `/core-settings show` always prints the effective JSON (never the selector), `/core-settings edit` opens the unified JSON editor, and `/core-settings path` prints the file path. In a headless session, bare `/core-settings` falls back to showing the effective JSON.

The unified file currently contains permissions, non-secret TLS target metadata, and proxy audit redaction settings. TLS passphrases, certificate bytes, and private-key material are never persisted. Structured settings — permission rules, remembered grants, and the TLS target — are edited through their dedicated flows or the raw JSON editor, not as inline rows.

## Permissions extension

The `core/extensions/permissions` extension gates every tool call through a policy engine. Use `/permissions` to view or change the active mode.

### Modes

| Mode         | Default behavior                                                                 | Config rules                     |
| ------------ | -------------------------------------------------------------------------------- | -------------------------------- |
| `safe`       | Allow read/grep/ls/find; ask everything else                                     | Honored                          |
| `trusted`    | Allow path tools in cwd + known bash patterns; deny `rm -rf`, `curl\|bash`, etc. | Honored                          |
| `open`       | Allow everything                                                                 | Ignored (only .env deny applies) |
| `permissive` | Allow everything; ask only for commands matching config `ask` rules              | Honored, allow-before-ask        |

### Precedence

**safe / trusted**: `.env`-deny → config deny → config ask → config allow/grant → mode default

**permissive**: `.env`-deny → config deny → config allow/grant → config ask → **allow** (grants override the ask-list)

**open**: `.env`-deny → allow (config rules ignored)

### Compound bash commands

Commands are split on `&&`, `||`, `|`, `;`, newline, and `&` before matching:

- **ALLOW** requires every segment covered by an allow rule or grant
- **ASK** fires if any segment matches an ask rule
- **DENY** fires if any segment matches a deny rule _or_ the whole command matches (preserves pipe-spanning patterns like `curl x | bash`)
- Segments containing `$(…)` or backticks are never coverable → always ask/deny

### Backward-compatibility note

Upgrading from the initial permissions release changes matching for bash targets: patterns are now matched per-segment rather than against the whole command string. **Anchored single-command patterns** (e.g. `^npm\b`) are unaffected. If you saved a grant or config rule whose pattern contained `&&`, `|`, or `;` to match a whole compound string, it will no longer fire — re-author it as separate per-segment rules.

Permissions are written to the `permissions` section of `.pi/core-settings.json`.

### .env default-deny

Direct `.env` path-tool targets are blocked in all modes. Override with an explicit config allow rule:

```json
{ "tool": "*", "action": "allow", "pattern": "\\.env\\.example$" }
```

### Headless sessions

When `!hasUI` (print/RPC/automation), the extension always runs as `open` mode regardless of the persisted mode — write/bash/etc. are not gated.

## Validate

```bash
npm run validate:json
npm run pack:dry-run
```

## Notes for adding resources

- Put runtime extension dependencies in `dependencies`.
- Put Pi-provided imports such as `@earendil-works/pi-coding-agent` and `typebox` in `peerDependencies` with `"*"`.
- Skill names must be lowercase kebab-case and each skill must include a useful `description`.
- Prompt files are non-recursive; top-level `prompts/*.md` become `/prompt-name` commands.
- Theme files must include all required Pi color tokens.
