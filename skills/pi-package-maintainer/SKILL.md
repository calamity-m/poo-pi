---
name: pi-package-maintainer
description: Maintain Pi packages that bundle extensions, skills, prompt templates, and themes. Use when creating, reviewing, packaging, or publishing a Pi package.
license: MIT
---

# Pi Package Maintainer

Use this workflow when working on a repository intended to be installable with `pi install`.

## Checklist

1. Inspect `package.json` for:
   - `keywords` containing `pi-package`
   - a `pi` manifest listing `extensions`, `skills`, `prompts`, and/or `themes`
   - runtime dependencies in `dependencies`
   - Pi-provided packages in `peerDependencies` with `"*"`
2. Validate resource conventions:
   - extensions are `.ts` or `.js` files, or directories with `index.ts`
   - skills are directories containing `SKILL.md` with valid frontmatter
   - prompts are top-level Markdown files with optional frontmatter
   - themes are JSON files with all required color tokens
3. Run available validation commands, especially JSON parsing and `npm pack --dry-run`.
4. Keep package resources reviewable: avoid hidden install scripts and document what extensions do.

## Installation Smoke Test

From a separate directory, install locally:

```bash
pi install /absolute/path/to/package -l
pi list
```

Then start Pi and verify `/poo-pi`, bundled prompt commands, skill commands, and theme selection appear.
