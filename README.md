# poo-pi

Installable Pi package scaffold for bundling project-level resources:

- `extensions/` — TypeScript/JavaScript Pi extensions
- `skills/` — Agent Skills directories containing `SKILL.md`
- `prompts/` — Markdown prompt templates exposed as slash commands
- `themes/` — Pi theme JSON files

## Install

Install from GitHub:

```bash
pi install git:github.com/calamity-m/poo-pi
```

Fetch updates later with:

```bash
pi update
```

For local development, install this checkout by path so Pi loads resources directly from the repo on disk:

```bash
pi install /home/calam/code/poo-pi
```

Use project-local settings instead of global user settings with:

```bash
pi install /home/calam/code/poo-pi -l --approve
```

After editing extensions, skills, or prompts, restart Pi or run `/reload`. Themes hot-reload automatically.

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
  autoformatter/index.ts
  core/index.ts
skills/
  pi-package-maintainer/SKILL.md
prompts/
  plan.md
  release-check.md
  review.md
themes/
  kanagawa.json
  poo-dark.json
  poo-light.json
```

## Extension docs

- [Autoformatter](docs/extensions/AUTOFORMATTER.md)
- [Core settings](docs/extensions/CORE_SETTINGS.md)
- [Context usage](docs/extensions/CONTEXT.md)
- [Worktrees](docs/extensions/WORKTREES.md)
- [History search](docs/extensions/HISTORY_SEARCH.md)
- [Prompt filler](docs/extensions/PROMPT_FILLER.md)
- [Preset subagents](docs/extensions/PRESET_SUBAGENTS.md)
- [Permissions](docs/extensions/PERMISSIONS.md)
- [Interview](docs/extensions/INTERVIEW.md)

## Testing

Run the full Node test suite, including smoke coverage:

```bash
npm test
```

Run only the smoke harness:

```bash
npm run test:smoke
```

The targeted `npm run smoke:*` commands are available for debugging individual smoke scenarios.

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
