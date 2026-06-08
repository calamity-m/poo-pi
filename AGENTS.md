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

**Strongly prefer TSDoc/JSDoc on all functions. Complex or unclear logic should explain the why.**

This repo is primarily TypeScript plus Markdown and JSON package resources.

- Heavily prefer TSDoc/JSDoc for every TypeScript function, method, class, type, constant, command handler, and tool interface, exported or internal.
- Keep documentation concise: describe purpose, important constraints, parameters, return values, and side effects when they are not immediately obvious.
- Prompt and skill Markdown should document user-facing behavior directly in the file; keep frontmatter descriptions accurate.
- For complex or unclear internal operations, add code comments that explain the why, not the what. One short line is usually enough.
- Do not comment code that already reads plainly unless a TSDoc/JSDoc block is expected by this guidance.

## 6. File Size

**Prefer files under 1,000 lines.**

- Do not let a file grow beyond 1,000 lines unless there is a clear, documented reason.
- Split cohesive logic into smaller files earlier to avoid reaching 1,000 lines.
- Avoid splitting files mechanically; preserve readable ownership boundaries and simple imports.

## 7. Pre-commit Hooks

**Prefer repeatable hooks and scripts over manual memory.**

Current runnable checks:

- `npm run typecheck` runs `tsc --noEmit` over `extensions/**/*.ts` (also chained into `npm test`).
- `npm run validate:json` validates `package.json` and theme JSON files.
- `npm run pack:dry-run` verifies the package contents npm would publish.

There is no pre-commit config in this repo yet. If checks are repeatedly missed, add a small pre-commit hook that runs the npm scripts above.

## 8. Repository Map

### Key directories

```text
extensions/   -> Pi extension entry points; `core/index.ts` registers the bundled core commands, tools, and hooks.
extensions/core/ -> Packaged core extension subtree currently present as placeholder/empty TypeScript files.
skills/       -> Agent skill directories; each skill is a directory with `SKILL.md` frontmatter.
prompts/      -> Top-level Markdown prompt templates exposed as slash commands.
themes/       -> Pi theme JSON files included in the package manifest.
```

### Entry points

```text
extensions/core/index.ts -> `pi -e ./extensions/core/index.ts --theme ./themes/poo-dark.json` for local extension/theme development.
package.json         -> `npm run validate:json` and `npm run pack:dry-run` for validation/package smoke checks.
```

### Data flow

```text
package.json pi manifest -> Pi discovers extensions/, skills/, prompts/, themes/
extensions/core/index.ts -> registers the packaged core extension features
npm pack --dry-run -> package.json files list -> publishable tarball contents
```

## 9. Project-Specific Notes

- This is an installable Pi package; keep Pi-provided imports such as `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies with `"*"` unless packaging needs change.
- Prompt files are non-recursive: only top-level `prompts/*.md` become slash commands.
- Skill names should stay lowercase kebab-case, and each skill directory must contain `SKILL.md` with useful frontmatter.
- Theme JSON must keep the required Pi color-token shape; validate JSON before packaging.
- Treat package resource lists carefully when editing package metadata; prompt discovery is non-recursive and skills require a `SKILL.md` file.

---

**These guidelines are working if:** diffs stay small, unnecessary rewrites decrease, and clarifying questions happen before implementation mistakes.
