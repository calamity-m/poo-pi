# BIGPLAN: Permissions mode-scoped config overhaul

## Plan Overview

Overhaul the permissions configuration model so each non-open mode owns its own `rules` and `remembered` grants, with `permissions.mode` selecting the active mode. Add project-local permissions in `.pi/poo/core-settings.json` and global permissions in `~/.pi/agent/poo/core-settings.json`, then merge them at load time with project config overriding global config. Done means a user can maintain different rule/grant sets for `safe`, `trusted`, and `permissive`, keep global defaults in the agent config, add project-specific overrides without touching global settings, and see/edit which scope is active through the existing permissions UI.

## Risks

- **Project overrides can weaken global guardrails** — The chosen merge model lets project-local rules override global rules. The UI and tests must make the override visible so a broad global deny is not silently neutralized by a project allow.
- **Hard cutover breaks flat configs** — The chosen migration stance rejects the current flat `{ mode, rules, remembered }` permissions shape. Validation errors and release notes must point users at the new nested shape so failures are actionable rather than silent fallback.
- **Project-local config is a trust boundary** — Reading `.pi/poo/core-settings.json` gives a repository influence over tool gating. Only honor project-local permissions when `ctx.isProjectTrusted()` is true, and block local permission writes in untrusted projects with an actionable warning.
- **Invalid config changes enforcement scope** — A malformed global or project permissions section cannot participate in the merge. Runtime load should warn once per reload, ignore only the invalid scope, and fall back to built-in defaults when the global scope is invalid.
- **Writes can land in the wrong scope or mode block** — Mode changes, remembered grants, and editor saves have different intended destinations. Centralize write helpers and cover them with tests so `/permissions safe` writes local `permissions.mode`, `/permissions default safe` writes global `permissions.mode`, and “Always For This Project” writes the local active-mode block without pinning local `permissions.mode`.
- **Mode-block scope order affects live enforcement** — The policy engine currently receives one flat state. The overhaul must preserve scope metadata through decision time so project rules can run before global rules, including narrower project allows that override broader global denies.
- **Process-global state depends on the active cwd** — The current state object is process-global, but effective permissions become cwd- and trust-sensitive. Reload on every `session_start`, store the cwd/source metadata with the state, and test that a session switch cannot keep another project’s merged permissions active.

## Plan Details

### Target configuration shape

Both global and project-local core settings use the same `permissions` shape:

```json
{
  "permissions": {
    "mode": "permissive",
    "safe": {
      "rules": [],
      "remembered": []
    },
    "trusted": {
      "rules": [],
      "remembered": []
    },
    "permissive": {
      "rules": [],
      "remembered": []
    }
  }
}
```

`open` remains a valid `permissions.mode`, but it has no mode block and no configurable rules. When the active mode is `open`, the permissions engine allows everything except the existing `.env` default-deny path/bash checks; the new nested schema does not provide an `open` block for `.env` allow overrides.

### Merge semantics

- Global file: `~/.pi/agent/poo/core-settings.json`.
- Project file: `<ctx.cwd>/.pi/poo/core-settings.json`.
- Project-local permissions are honored only when `ctx.isProjectTrusted()` is true.
- Active mode is `project.permissions.mode ?? global.permissions.mode ?? "trusted"`.
- `permissions.safe`, `permissions.trusted`, and `permissions.permissive` blocks are optional in each file. Missing mode blocks behave as empty blocks; writers create a missing block before appending rules or grants.
- For active modes `safe`, `trusted`, and `permissive`, preserve two scopes at decision time: project first, then global.
- Within one scope, keep the existing action precedence for matching rules: deny, then ask, then allow. If any project rule action matches, return that project action and do not evaluate global rules. This is what lets a narrower project allow override a broader global deny.
- Rule identity (`tool + pattern`) is still used for display, dedupe, and edit normalization: a project rule with the same identity as a global rule is reported as replacing that global rule.
- Remembered grants merge by identity (`tool + dirPrefix` for path grants, `tool + pattern` for bash grants). Project grants replace duplicate global grants, and local ask/deny rules can still override remembered grants because scoped rules are evaluated before grants.
- “Always For This Project” writes to the project-local active mode block only and does not write project-local `permissions.mode` when the project does not already have one.
- Global remembered grants are supported for hand-authored or global-editor use, but normal interactive grants remain project-local.

### Compatibility stance

This plan uses the chosen hard cutover: the flat permissions shape is invalid after the overhaul. `validateCoreSettings` should reject flat `permissions.rules` or `permissions.remembered` at the top level and explain the new per-mode block path, for example `permissions.trusted.rules`.

Runtime loading should use the same validator. An invalid project-local permissions section is ignored with a warning while global permissions still apply. An invalid global permissions section falls back to built-in defaults (`trusted`, empty mode blocks) with a warning. These fallbacks avoid crashing all tool calls while making the rejected scope visible.

### Critical Files

- `extensions/core/extensions/permissions/types.ts` — Replace flat persisted config types with nested per-mode config types while keeping the compiled effective `PermissionState` shape usable by enforcement.
- `extensions/core/config/persistence.ts` — Validate and parse the nested `permissions` section, reject the old flat top-level `rules`/`remembered`, and preserve non-permissions settings.
- `extensions/core/config/paths.ts` — Add project-local core settings path helpers without disturbing global settings paths used by other core features.
- `extensions/core/extensions/permissions/persistence.ts` — Read global and project configs, compile only the active mode block, preserve project/global scope order, and write local/global permissions through explicit helpers.
- `extensions/core/extensions/permissions/index.ts` — Load effective merged state on `session_start`, track source metadata for UI, and keep the process-global state mutation model.
- `extensions/core/extensions/permissions/enforcement.ts` — Continue consuming one effective `PermissionState`; update “Always For This Project” persistence to write local active-mode grants.
- `extensions/core/extensions/permissions/register.ts` — Update `/permissions`, `/permissions edit`, and `/permissions default` behavior for local/global scope and mode-specific blocks.
- `extensions/core/extensions/settings.ts` — Surface local/global permissions editing clearly through `/core-settings` without widening unrelated settings scope.
- `tests/smoke-permissions.mjs` — Add coverage for nested config parsing, scope merge, project override precedence, and local grant writes.
- `tests/core-settings.test.mjs` — Add validation/path tests for global vs project-local core settings and flat-shape rejection.

### Gotchas

- Use `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` for the project-local `.pi` directory name instead of hardcoding `.pi`.
- Do not change the storage location for non-permissions settings as part of this effort. Add permission-specific local helpers, or clearly named generic helpers, so proxy/subagent/footer/worktree behavior stays global unless separately requested.
- Keep the current compiled `PermissionState` as the per-scope state shape, but wrap it in a new effective state that carries project and global compiled scopes plus source metadata. Avoid pushing persisted nested config directly into the pure policy engine.
- The footer only shows the active mode today. The showcase/editor must carry the extra scope detail because the footer has no room to explain merge sources.
- `ctx.isProjectTrusted()` is available on `ExtensionContext`; use it during permission reload before reading project-local files.
- The current `/permissions safe|trusted|permissive|open` path mutates live state without persisting. This overhaul should make mode persistence explicit: direct mode commands save the project-local active mode, while `/permissions default <mode>` saves the global default mode and warns when a local mode still shadows it.
- Treat `ctx.cwd` as the permissions project root by design. Do not add git-root discovery in this overhaul; document that starting Pi from a different directory uses a different project-local config path.

### Pseudo-code / Sketches

```text
loadPermissions(ctx):
  globalResult = readValidatedGlobalPermissions()
  projectResult = ctx.isProjectTrusted()
    ? readValidatedProjectPermissions(ctx.cwd)
    : ignored("project not trusted")

  global = globalResult.valid ? globalResult.permissions : defaultPermissions()
  project = projectResult.valid ? projectResult.permissions : undefined

  mode = project?.mode ?? global?.mode ?? "trusted"

  if mode == "open":
    return effectiveState(mode, projectScope=empty, globalScope=empty, metadata)

  projectScope = compileBlock(project?.[mode] ?? emptyBlock)
  globalScope = compileBlock(global?.[mode] ?? emptyBlock)

  return { mode, projectScope, globalScope, metadata }

resolveRuleAction(tool, target):
  projectAction = matchWithinScopeUsingExistingModePrecedence(projectScope.rules, tool, target)
  if projectAction exists: return projectAction
  globalAction = matchWithinScopeUsingExistingModePrecedence(globalScope.rules, tool, target)
  if globalAction exists: return globalAction
  if projectOrGlobalGrantCovers(tool, target): return allow
  return modeDefault(tool, target)

rememberAlways(ctx, mode, grant):
  assertProjectTrustedForLocalWrite(ctx)
  local = readProjectCoreSettings(ctx.cwd)
  local.permissions[mode] ??= emptyBlock
  local.permissions[mode].remembered = dedupeAppend(local.permissions[mode].remembered, grant)
  writeProjectCoreSettings(ctx.cwd, local)
```

## Deliverables

### Deliverable 1. Nested permissions schema and path helpers

Introduce the new persisted permissions shape and local/global settings path support. This deliverable produces types and parsers that accept `permissions.mode` plus `permissions.safe|trusted|permissive` blocks, reject the old flat `permissions.rules` and `permissions.remembered`, and keep existing non-permissions settings behavior unchanged.

- [x] Add persisted nested permission types: `ModePermissionConfig`, `PersistedPermissionConfig`, and helpers for non-open mode keys.
- [x] Update `validatePermissionSection` and `parsePermissionConfig` in `extensions/core/config/persistence.ts` for the nested shape, with optional non-open mode blocks.
- [x] Reject flat top-level `permissions.rules` and `permissions.remembered` with an error that names `permissions.<mode>.rules` and `permissions.<mode>.remembered`.
- [x] Add project-local core settings path helpers using Pi `CONFIG_DIR_NAME`, targeting `<cwd>/.pi/poo/core-settings.json`.
- [x] Define writer normalization so missing `safe`/`trusted`/`permissive` blocks are created only when writing into that block.
- [x] Add tests in `tests/core-settings.test.mjs` for nested parsing, partial configs, flat rejection, open-without-block acceptance, and global/project path helpers.

### Deliverable 2. Effective permissions merge loader

Build one compiled effective `PermissionState` from global and trusted project-local config. This deliverable keeps enforcement simple by resolving mode, scope, and merge order before policy evaluation.

- [x] Implement read helpers for global permissions and project-local permissions, with project-local reads gated by `ctx.isProjectTrusted()`.
- [x] Implement runtime validation fallbacks: invalid project permissions ignored with warning; invalid global permissions replaced by built-in defaults with warning.
- [x] Implement active mode resolution: project mode, then global mode, then `trusted`.
- [x] Implement scoped active-mode compilation for `safe`, `trusted`, and `permissive`, preserving project-first then global order.
- [x] Define and implement effective-state metadata: active mode source, cwd, project-trust status, ignored scope reason, per-scope rule/grant counts, and overridden rule/grant identities.
- [x] Preserve `open` as mode-only with no active mode block and no config-rule overrides.
- [x] Add smoke tests for global-only, project-only, merged, project override with different patterns, same-identity replacement metadata, untrusted-project, invalid-scope fallback, and open-mode cases.

### Deliverable 3. Enforcement persistence updates

Update the runtime paths that write permission data so remembered grants and mode changes land in the intended scope. This deliverable should not rewrite the pure policy engine beyond what the merge loader requires.

- [x] Update `reloadState(ctx)` and `registerPermissions` to load the merged effective state and refresh source metadata on `session_start`.
- [x] Store the loaded cwd/source metadata with process-global state and reload on session switches so stale permissions from another cwd cannot remain active.
- [x] Update “Always For This Project” to append/dedupe grants under the project-local active mode block without setting project-local `permissions.mode`.
- [x] Block local writes for untrusted projects in `/permissions <mode>`, `/permissions edit local`, and “Always For This Project”, with a warning that the project must be trusted first.
- [x] Persist `/permissions <mode>` as the project-local active mode and refresh live effective state after writing.
- [x] Keep `/permissions default <mode>` writing the global default mode, and notify when the current project mode shadows the new default.
- [x] Ensure direct mode changes and remembered grants request a footer/status refresh after reloading the effective state.
- [x] Add smoke tests proving local grant writes affect only the active mode, do not modify global permissions, do not pin local mode, and are blocked when the project is untrusted.

### Deliverable 4. Permissions UI and editors for scope-aware config

Make the command surfaces explain and edit the new model. Users should be able to see the active mode, whether it came from global or project config, and edit local or global permissions deliberately.

- [x] Update the `/permissions` showcase to display active mode source, local/global rule counts, local/global remembered counts, ignored-scope warnings, shadowed default warnings, and override notes.
- [x] Change `/permissions edit` to edit project-local permissions by default.
- [x] Add `/permissions edit global` for global permissions and `/permissions edit local` for explicit project-local editing.
- [x] Update editor prefill to show the nested shape and validate against the same schema as core settings.
- [x] Update `/core-settings` permissions entries to distinguish active project mode, global default mode, local permissions edit, and global permissions edit.
- [x] Add command tests covering edit target selection, untrusted local edit blocking, default-mode shadow notifications, and validation failures for the flat shape.

### Deliverable 5. Verification and documentation

Finish with repeatable checks and concise user-facing documentation for the breaking config change and new merge behavior.

- [x] Update inline JSDoc for persisted config types, merge helpers, and command handlers.
- [x] Update any README or command help text that describes permissions config shape or `/permissions` usage.
- [x] Document the hard cutover from flat permissions config to per-mode blocks.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run validate:json`.
- [x] Run `npm run pack:dry-run`.

## Issues

- **2026-06-23 — agent:pi** — Implementation completed and verified. Note: the installed `@earendil-works/pi-coding-agent` public entrypoint does not currently export `CONFIG_DIR_NAME`, so `extensions/core/config/paths.ts` uses a local `.pi` constant with a comment to switch once the peer exposes the documented export.
- **2026-06-23 — agent:pi (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 8 recurring findings; 8 merged into the plan. Most significant changes: clarified scope-aware project-before-global rule resolution, made open mode rule-less, blocked untrusted local writes, defined invalid-config fallback behavior, and added metadata/default-shadow/grant-write tests.
- **2026-06-23 — agent:pi** — Pre-draft grill completed through structured choices. User decisions: project permissions override global permissions, project `permissions.mode` overrides the global default, project-local config lives at `.pi/poo/core-settings.json`, and the old flat permissions shape gets a hard cutover rather than migration.
