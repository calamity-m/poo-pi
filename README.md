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
