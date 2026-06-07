# BIGPLAN: Preset Subagents

## Plan Overview

Add markdown-backed preset agents to the core subagents extension so the parent agent can spawn either a named preset, such as `explorer`, or a fresh custom subagent using the existing role/context fields. Presets initially live under `extensions/core/extensions/subagents/agents/*.md` and are discovered by the refactored subagents module at extension runtime. Done means `spawn_subagent` accepts an optional preset agent name, merges that preset's frontmatter/body with explicit tool-call arguments, and still preserves the existing dynamic custom-agent path when no preset is requested.

## Risks

- **Bundled resource discovery failure** — Presets must be readable from files beside the compiled/loaded extension module. `npm run pack:dry-run` only proves the markdown is in the tarball; it does not prove `import.meta.url` path resolution finds it when core runs from an installed `node_modules` layout rather than the dev tree. Mitigation: load via module-relative filesystem paths derived from `import.meta.url` (never `ctx.cwd`), and make installed-layout discovery an explicit early gate in Deliverable 2 — verify a test that mimics the installed directory structure resolves presets before the rest of the preset work proceeds. If installed-layout resolution cannot be made to work, a static manifest moves into v1 scope rather than staying deferred.
- **Refactor import churn** — The subagents extension moves from `extensions/core/extensions/subagents.ts` to a directory module. A reference search confirms only two internal importers exist (`extensions/core/index.ts` and `tests/subagents.test.mjs`); the published package entry is `extensions/poo-pi.ts`, not this file, so no external consumer imports it by path. Churn is therefore low — update the two importers together and delete the old file; a re-export shim is unnecessary.
- **Ambiguous preset override rules** — Preset frontmatter can define defaults that conflict with explicit `spawn_subagent` parameters. Mitigation: document and test a single precedence rule: explicit tool-call parameters override preset frontmatter; preset role/body is included before any custom role/context additions.
- **Prompt bloat from markdown presets** — Preset bodies plus custom context and preloaded files can inflate nested prompts. The existing preload caps are `MAX_PRELOADED_FILE_CHARS = 20_000` and `MAX_PRELOADED_TOTAL_CHARS = 60_000`; the preset body should stay well under these. Mitigation: cap preset body at **8,000 characters** (a `MAX_PRESET_BODY_CHARS` constant) and skip-and-warn on oversized bundled presets during loading.
- **Frontmatter parser contract drift** — A small local parser avoids a YAML dependency, but preset authors can otherwise assume unsupported YAML syntax. Mitigation: pin and test the exact supported frontmatter subset for v1 — `key: value` lines with unquoted or quoted scalar string values, blank lines allowed, **comments not supported**, duplicate-key rejection, and clear failures for any other structure (lists, nested maps, multi-line scalars).

## Plan Details

### Shared understanding

- Preset source path starts as `extensions/core/extensions/subagents/agents/*.md` only.
- The subagents extension should be refactored from `extensions/core/extensions/subagents.ts` into a directory entry point at `extensions/core/extensions/subagents/index.ts`.
- Markdown frontmatter is supported. `tier` maps to the existing subagent model tier and accepts `fast`, `high`, or `any`; `any` means do not force a configured tier and let normal model selection fall through unless the caller provides a more specific model/tier.
- The existing roll-your-own behavior remains available through `role`, `context`, `model`, `tier`, `tools`, `files`, and `outputFormat`.
- `task` remains required for every `spawn_subagent` call; a preset-only launch means `agent` plus `task`, not `agent` with no task.
- Load-failure policy is **skip-and-warn**: a malformed, unreadable, oversized, or invalid bundled preset is skipped with a logged warning, and the remaining valid presets still load. A missing or empty `agents/` directory yields zero presets, not an error. (Author errors are still caught loudly by the Deliverable 5 tests and `pack:dry-run` before publish.)
- `tier: any` resolves to the existing "parent fallback" path in `resolveSubagentModel` — when no `model` and no `tier` are passed, the resolver already uses the parent session's active model. `any` simply declines to inject a tier; no new resolver branch is needed.
- The enum-to-tools mapping already exists as `toolPolicyNames` in the current implementation (`none` → `[]`, `read-only` → read/grep/find/ls, `coding` → those plus bash/edit/write). Presets reuse it; no new mapping layer is required.

### Proposed preset markdown shape

```markdown
---
name: explorer
description: Investigate code paths and report findings without editing files.
tier: fast
tools: read-only
outputFormat: Concise findings with file paths.
---

You are an explorer subagent. Inspect relevant files, trace behavior, and return concise findings.
```

The filename can provide the default name (`explorer` from `explorer.md`). If frontmatter includes `name`, it must match the filename-derived name or validation should reject it to avoid aliases and collisions in the first version. Supported preset `tools` values are the existing tool policies: `none`, `read-only`, and `coding`; omitted `tools` defaults to the existing `read-only` behavior.

### Preset merge rules

```text
resolve params:
  if params.agent absent:
    use existing custom-only behavior

  preset = presetRegistry.get(params.agent)
  if missing: error with available names

  merged.tier = params.tier ?? preset.tier unless preset.tier == "any"
  merged.tools = params.tools ?? preset.tools
  merged.outputFormat = params.outputFormat ?? preset.outputFormat
  merged.role = [preset.body, params.role].filter(Boolean).join("\n\n")
  merged.context = params.context
  merged.model = params.model
  merged.files = params.files
```

Raw `model` remains the strongest model-selection override. If both `model` and preset `tier` are present, the model override wins through the existing resolver behavior. The final prompt order should remain explicit and testable: base subagent instructions, merged role text, custom context, preloaded files, relevant file paths, output format, then task.

### Critical Files

- `extensions/core/extensions/subagents.ts` — Current implementation to move into a subdirectory entry point.
- `extensions/core/extensions/subagents/index.ts` — New module entry point after refactor; should continue exporting `registerSubagents` and `__subagentsForTest`.
- `extensions/core/extensions/subagents/agents/*.md` — Built-in preset agent definitions, starting with at least one concrete example such as `explorer.md`.
- `extensions/core/index.ts` — Imports `registerSubagents`; the import path must be updated after the directory refactor if TypeScript resolution does not pick `index.ts` automatically from the old path.
- `tests/subagents.test.mjs` — Existing tests import `../extensions/core/extensions/subagents.ts`; update to the new module path and add preset parsing/merge tests.
- `package.json` — Existing `files` includes `extensions/`, and the repo already has `test`, `lint`, `format:check`, `validate:json`, and `pack:dry-run` scripts; `npm run pack:dry-run` should confirm markdown agents are included.

### Gotchas

- Do not load presets from arbitrary user-provided paths in the first version; the explicit starting scope is core-bundled presets under the subagents extension directory.
- Pi prompt templates are non-recursive, but these files are not prompt templates; they are extension-owned resources and should not be registered as slash commands.
- The nested subagent uses `DefaultResourceLoader({ noExtensions: true })`; preset resolution must happen in the parent extension before creating the nested session.
- The `tier: any` value is preset metadata, not a new user-configurable tier in core settings.
- Keep `read-only` as the safe default when neither the preset nor the caller specifies `tools`.
- The existing subagent model resolver intentionally resolves once before and once after proxy readiness so nested sessions use refreshed proxy-aware model objects; preserve that flow when applying presets.

### Pseudo-code / Sketches

```text
registerSubagents(pi, options):
  presets = loadPresetAgents(new URL("./agents/", import.meta.url))
  register spawn_subagent schema with optional agent string and available preset names

spawn_subagent(params):
  merged = params.agent ? applyPreset(params, presets) : params
  selection = resolveSubagentModel(merged, ctx, pi)
  ensure proxy
  selection = resolveSubagentModel(merged, ctx, pi)
  run nested session with buildSubagentPrompt(merged, preloadedFiles)
```

## Deliverables

> **Ordering:** Deliverable 1 must land before Deliverables 2–5, which all target the new `subagents/index.ts` path. Do not start preset work against the old `subagents.ts`.

### Deliverable 1. Refactor subagents into a directory module

Move the existing subagents extension from a single TypeScript file into a directory so bundled agent markdown files can live beside the implementation. This deliverable should preserve existing runtime behavior before adding preset functionality.

- [ ] Create `extensions/core/extensions/subagents/index.ts` containing the current implementation from `extensions/core/extensions/subagents.ts`.
- [ ] Search for all references to `extensions/core/extensions/subagents.ts` and `./extensions/subagents.ts` before changing imports.
- [ ] Update imports in `extensions/core/index.ts` and tests to reference the new directory module path explicitly.
- [ ] Remove the old `extensions/core/extensions/subagents.ts` (reference search confirms only two internal importers; no re-export shim needed).
- [ ] Run existing subagent tests to confirm behavior is unchanged after the move.

### Deliverable 2. Preset agent loader and validation

Add a small loader for markdown preset files under `extensions/core/extensions/subagents/agents/*.md`. It should parse frontmatter, validate supported fields, expose preset metadata to the tool implementation, and fail with clear errors for malformed bundled presets.

- [ ] Define a documented `PresetAgent` type with name, description, optional tier, optional tools, optional output format, markdown body, and source path.
- [ ] Implement a local frontmatter parser for simple scalar fields and enum validation for `tier: fast | high | any` and `tools: none | read-only | coding`.
- [ ] Load and validate built-in presets during extension registration from `agents/*.md`, using `import.meta.url` plus filesystem URL/path handling rather than `ctx.cwd`.
- [ ] **Early gate:** prove module-relative discovery works against an installed layout (a test that mimics the `node_modules` directory structure resolves presets), not just the dev tree, before building Deliverables 3–5.
- [ ] Enforce `MAX_PRESET_BODY_CHARS = 8_000` on the preset body during loading.
- [ ] Skip-and-warn (not hard-fail) on duplicate keys, duplicate preset names, invalid filenames, invalid enum values, oversized bodies, unsupported frontmatter structures, unreadable files, and mismatched frontmatter `name` values; load remaining valid presets.
- [ ] Handle a missing or empty `agents/` directory by yielding zero presets without error.
- [ ] Add at least one bundled preset markdown file, `extensions/core/extensions/subagents/agents/explorer.md`.

### Deliverable 3. Tool schema and prompt merge behavior

Extend `spawn_subagent` so callers can request a preset by name while retaining the custom subagent path. The implementation should make precedence obvious and testable: explicit call parameters override preset defaults, and preset role text is combined with custom role/context rather than silently discarded.

- [ ] Add optional `agent` to `spawnSubagentSchema` with a description that points to named preset agents, while keeping `task` required and `role`/`context` optional.
- [ ] Implement `applyPresetAgent(params, presets)` or equivalent pure helper for merging preset metadata with explicit params.
- [ ] Treat preset `tier: any` as no tier default, allowing the existing parent fallback unless the caller provides `tier` or `model`.
- [ ] Store the selected preset name/source on the in-memory run record and include it in tool update details where useful for debugging.
- [ ] Ensure missing preset names return an error that lists available presets.
- [ ] Add tests for the final built prompt order so preset text does not accidentally override explicit custom context/output instructions.

### Deliverable 4. Operator visibility and documentation

Make presets discoverable enough for the parent agent and human operator without adding a separate large UI. The tool guidance should tell the parent agent when to use a preset versus a custom role.

- [ ] Update `promptSnippet`/`promptGuidelines` to mention preset agents and the custom fallback.
- [ ] Include available preset names **and their `description` field** in the tool description or generated guidance using registration-time loaded preset metadata, so the parent agent can pick the right preset.
- [ ] Update `/subagents` reporting to show the preset agent name from the run record for runs that used one.
- [ ] Add a concise README or implementation note entry documenting the bundled preset file format, supported frontmatter subset, allowed tool policies, and override rules.

### Deliverable 5. Verification and package checks

Cover the refactor and preset behavior with focused tests and package smoke checks. The key acceptance criterion is that existing custom subagent calls keep working while named presets alter defaults and prompt content predictably.

- [ ] Update existing `tests/subagents.test.mjs` imports and keep current resolver tests passing.
- [ ] Add tests for frontmatter parsing, invalid preset metadata, duplicate keys, duplicate/mismatched names, invalid tool policies, oversized bodies, unsupported frontmatter structures, and `tier: any` behavior.
- [ ] Add tests proving skip-and-warn semantics (one malformed preset does not block valid ones) and that a missing/empty `agents/` directory yields zero presets without error.
- [ ] Add tests for preset merge precedence, including explicit `tools`, `tier`, `model`, `role`, `context`, and `outputFormat` overrides.
- [ ] Add tests for preset-only calls (`agent` plus `task`) and custom-only calls (no `agent`) to prove both schema paths work.
- [ ] Run `npm test`, `npm run lint`, `npm run format:check`, `npm run validate:json`, and `npm run pack:dry-run`.
- [ ] Confirm `npm run pack:dry-run` includes `extensions/core/extensions/subagents/agents/explorer.md`.

## Issues

- **2026-06-07 — agent:claude (adversarial review)** — Second pass: 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope), grounded against the actual `subagents.ts`. 11 findings; 8 merged, 2 resolved by reading code (`tier: any` already maps to the parent-fallback resolver path; `toolPolicyNames` enum-to-tools mapping already exists), 1 downgraded (import churn is only two internal references, no shim needed). Decisions confirmed by user: malformed-preset load policy is skip-and-warn; the `description` field is surfaced in tool guidance. Direct merges: installed-layout discovery early gate, `MAX_PRESET_BODY_CHARS = 8_000` cap + test, pinned frontmatter subset (no comments), missing/empty-dir handling, D1→D2-5 ordering note.
- **2026-06-07 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 16 findings; 14 merged into plan. Main changes: tightened runtime resource discovery, import-refactor compatibility, tool-policy/frontmatter contracts, registration-time preset loading, preset-only schema tests, and final prompt-order verification. Script-existence concerns were resolved from `package.json`; no separate plan change needed beyond documenting the available scripts.
- **2026-06-07 — agent:claude** — Initial scope confirmed by user: start with core-bundled presets only at `extensions/core/extensions/subagents/agents/*.md`; support frontmatter; `tier` accepts `fast`, `high`, `any`; named preset calls and custom roll-your-own calls must both remain available.
