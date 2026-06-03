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
