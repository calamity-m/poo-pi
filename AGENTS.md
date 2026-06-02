# Init Context

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; do not pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- Do not expand into wiring, integrations, or adjacent work that was not requested.
- If scope is unclear, stop and ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that was not requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Do not improve adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you would do it differently.
- If you notice unrelated dead code or stale metadata, mention it; do not delete it unless asked.

When your changes create orphans, remove imports, variables, functions, or files made unused by your changes. Do not remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass."
- "Fix the bug" -> "Write a test or smoke check that reproduces it, then make it pass."
- "Refactor X" -> "Run the relevant validation before and after."

For multi-step tasks, state a brief plan:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria require clarification.

## 5. In-Code Documentation

**Public API must be documented. Internal logic should explain the why.**

This repo is primarily TypeScript plus Markdown and JSON package resources.

- Use JSDoc for exported TypeScript functions, types, classes, constants, command handlers, and tool interfaces when their purpose or constraints are not obvious.
- Prompt and skill Markdown should document user-facing behavior directly in the file; keep frontmatter descriptions accurate.
- For internal code, comment the why, not the what. One short line is usually enough.
- Do not comment code that already reads plainly.

## 6. Pre-commit Hooks

**Prefer repeatable hooks and scripts over manual memory.**

Current runnable checks:
- `npm run validate:json` validates `package.json` and theme JSON files.
- `npm run pack:dry-run` verifies the package contents npm would publish.

There is no pre-commit config in this repo yet. If checks are repeatedly missed, add a small pre-commit hook that runs the npm scripts above; if TypeScript grows beyond the current extension files, add an appropriate `tsc --noEmit` check before relying on reviews.

## 7. Repository Map

### Key directories

```text
extensions/   -> Pi extension entry points; `poo-pi.ts` registers the package command/tool/status hook.
extensions/core/ -> Packaged core extension subtree currently present as placeholder/empty TypeScript files.
skills/       -> Agent skill directories; each skill is a directory with `SKILL.md` frontmatter.
prompts/      -> Top-level Markdown prompt templates exposed as slash commands.
themes/       -> Pi theme JSON files included in the package manifest.
```

### Entry points

```text
extensions/poo-pi.ts -> `pi -e ./extensions/poo-pi.ts --theme ./themes/poo-dark.json` for local extension/theme development.
package.json         -> `npm run validate:json` and `npm run pack:dry-run` for validation/package smoke checks.
```

### Data flow

```text
package.json pi manifest -> Pi discovers extensions/, skills/, prompts/, themes/
extensions/poo-pi.ts -> registers /poo-pi command + poo_pi_package_info tool -> reports bundled resource paths
npm pack --dry-run -> package.json files list -> publishable tarball contents
```

## 8. Project-Specific Notes

- This is an installable Pi package; keep Pi-provided imports such as `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies with `"*"` unless packaging needs change.
- Prompt files are non-recursive: only top-level `prompts/*.md` become slash commands.
- Skill names should stay lowercase kebab-case, and each skill directory must contain `SKILL.md` with useful frontmatter.
- Theme JSON must keep the required Pi color-token shape; validate JSON before packaging.
- `README.md` and `extensions/poo-pi.ts` currently mention `skills/surgical-refactor/SKILL.md`, but that path is not present; treat resource lists carefully when editing package metadata.

---

**These guidelines are working if:** diffs stay small, unnecessary rewrites decrease, and clarifying questions happen before implementation mistakes.
