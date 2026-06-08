# BIGPLAN: Worktree Tools

## Plan Overview

This effort gives Pi agents a safer, standardized way to create Git worktrees without relying on ad-hoc `bash git worktree add ...` commands that different models place in different directories. The MVP adds `add_git_worktree`, stores created worktrees under a managed root that defaults to Pi-owned user space, and keeps `/worktree` useful as the current-repository inventory. Done means an agent can create a worktree for an existing local branch, a detached ref, or an explicit new branch in a predictable location, with tests covering path selection, Git command construction, settings parsing, and custom-tool permission expectations.

## Risks

- **Path safety regression** — Allowing a model-supplied source repository path can weaken the standardization goal if destination paths or Git roots are derived loosely. Mitigate by resolving the source repo through Git, keeping destination paths entirely under the managed root, and testing path traversal and nested-directory cases.
- **Permission bypass confusion** — `add_git_worktree` is a custom mutating tool rather than a `bash` call, so users must not assume bash-specific permission rules or audit text cover the internal Git execution. Mitigate by verifying Pi's custom-tool `tool_call` permission path, documenting that the tool mutates the filesystem, and returning explicit created-path details.
- **Branch/ref mode ambiguity** — Git worktree creation has distinct semantics for existing local branches, detached refs, and new branches. Mitigate with an explicit `mode` parameter, mode-specific validation, local-branch checks for existing-branch mode, and tests that reject mixed fields.
- **Repository namespace collisions** — A default layout based only on repository basename can collide for unrelated repos with the same name. Mitigate with a sanitized repo namespace that includes a stable short hash of the resolved Git top-level path.
- **Destination allocation races** — Two agents can request the same label at the same time. Mitigate by reserving the final destination directory atomically before running Git and treating allocation conflicts as retryable tool errors.
- **Configured-root footguns** — Relative paths, symlinks, unwritable parents, or roots inside the source repository can make managed worktrees confusing or unsafe. Mitigate by expanding `~`, requiring an absolute path after expansion, resolving containment consistently, creating missing parents, and rejecting roots that are inside the resolved source repository.
- **Synchronous Git execution in tools** — Existing worktree code uses synchronous Git calls, but `git worktree add` can perform checkout work and invoke filters. Mitigate by using cancellable child-process execution for the mutating tool with a bounded timeout and concise timeout errors.
- **Settings sprawl** — Core settings already cover permissions, TLS, proxy, subagents, history search, and footer behavior. Raw JSON editing through `/core-settings edit` is acceptable for the MVP; do not add an interactive settings row for worktrees in this effort.

## Plan Details

### Proposed tool contract

`add_git_worktree` should be a custom Pi tool registered by the core worktree extension. It should infer the current repository from `ctx.cwd` by default and accept an optional `repoPath` that is resolved through Git before use. It must always choose the destination path under the configured managed root, never from an arbitrary model-supplied path.

The Pi tool `execute` signature is `execute(toolCallId, params, signal, onUpdate, ctx)` (see `extensions/core/extensions/interview/index.ts` and `subagents/index.ts`); `ctx` is the last argument, `signal` is the third, and the return shape is `{ content, details, isError? }`. The tool reads its cancellation `signal` from that third argument and `cwd` from `ctx.cwd`.

The tool should require an explicit mode:

| Mode              | Required fields            | Forbidden mode fields                | Git shape                                                      |
| ----------------- | -------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `existing_branch` | `branch`                   | `ref`, `branchName`, `startPoint`    | `git worktree add <managed-path> <branch>`                     |
| `detached`        | `ref`                      | `branch`, `branchName`, `startPoint` | `git worktree add --detach <managed-path> <ref>`               |
| `new_branch`      | `branchName`, `startPoint` | `branch`, `ref`                      | `git worktree add -b <branchName> <managed-path> <startPoint>` |

Existing-branch mode means an existing local branch. The implementation should verify the branch exists locally and return a clear error if Git reports that the branch is already checked out in another worktree. Remote-tracking branch auto-creation is not part of the MVP.

A caller can provide an optional `label`. The implementation sanitizes labels, falls back to a deterministic label from branch/ref input, and resolves collisions without escaping the managed root.

### Managed root

Default managed root: `~/.pi/worktrees/<repo-namespace>/<label>`.

`<repo-namespace>` should combine a sanitized basename with a stable short hash of the resolved Git top-level path, for example `poo-pi-a1b2c3d4`. This keeps paths readable while avoiding collisions between unrelated repositories with the same basename.

The root should be configurable through core settings, using a minimal shape such as:

```json
{
  "version": 1,
  "worktrees": {
    "root": "~/.pi/worktrees"
  }
}
```

The setting is user-facing but edited through `/core-settings edit` rather than a dedicated selector row in the MVP.

**Settings location decision:** `worktrees.root` lives in the **project-local** `.pi/core-settings.json`, read via `readCoreSettings(ctx.cwd)` (not the global `readGlobalCoreSettings()` used by subagent tiers). The default value (`~/.pi/worktrees`) is still a user-global directory, but the override is per-project. Both `add_git_worktree` and `/worktree` must read through the same project-local path so they agree on the managed root.

### Critical Files

- `extensions/core/extensions/worktree/command.ts` — current `/worktree` implementation and porcelain parser; host listing enhancements or shared formatting here when they are command-specific.
- `extensions/core/extensions/worktree/index.ts` — worktree feature entrypoint; should export/register any new tool module.
- `extensions/core/lib/worktree.ts` — linked-worktree detection for footer/context; useful for shared Git-root helpers but should not be over-expanded with tool-specific behavior.
- `extensions/core/config/types.ts` — unified core settings type must gain the minimal worktree settings shape.
- `extensions/core/config/persistence.ts` — settings parser/validator must preserve and validate the new `worktrees` section.
- `extensions/core/config/defaults.ts` — default settings version source; keep defaults sparse and derive the runtime default root in worktree code.
- `extensions/core/index.ts` — core bundle wiring for registering the new tool.
- `extensions/core/extensions/permissions/` — permission engine path to verify custom mutating tools are gated as expected.
- `tests/worktree.test.mjs` — existing focused worktree tests; extend for tool helper behavior and Git integration where practical.
- `tests/core-settings.test.mjs` — settings round-trip and validation coverage for the new `worktrees` section.
- `tests/smoke-permissions.mjs` or focused permission tests — verify `add_git_worktree` is visible to custom-tool permission decisions if coverage can be added without a live TUI.
- `docs/extensions/WORKTREES.md` — user-facing worktree docs; update from list-only to list-plus-add-tool behavior.

### Gotchas

- `startPoint` alone does not create a branch; new branch mode must pass `-b <branchName>` explicitly.
- Git branch names and filesystem labels have different validity rules; validate branch names with Git or conservative checks and sanitize labels separately.
- `~` expansion is not automatic in Node path APIs; expand the managed root setting before resolving destination paths.
- Destination paths must be checked after resolution to ensure they remain under the managed root.
- Use path containment checks that compare full path segments, not string prefixes.
- The current `/worktree` command reports all linked worktrees for the current repository from Git, not a global managed-root inventory.
- `remove_git_worktree` is deliberately out of scope for the MVP because removal identity and metadata ownership were not settled.
- Permission gating for `add_git_worktree` is coarse. `mapTargetAndNormalize` in `extensions/core/extensions/permissions/enforcement.ts` classifies every custom tool as `kind: "other"`, which defaults to ask in safe/trusted and can only be allowed/denied wholesale by tool name. There is no path-aware or arg-aware gating like `bash`/`write` receive, and audit text will not reflect the internal `git` execution or the destination path. Document this limitation rather than attempting finer gating in the MVP.
- Reuse the existing full-segment containment helper pattern in `extensions/core/lib/worktree.ts` (`isUnderWorktreesDir`, which uses `relative()` plus `..`-segment rejection) for managed-root containment instead of re-deriving prefix checks.
- Atomic destination reservation must use a non-recursive `mkdir` (which fails with `EEXIST`) as the lock, looping with a collision suffix on conflict. `mkdir(..., { recursive: true })` is not exclusive and will not surface `EEXIST`, so it cannot provide the race protection; create any missing parents separately, then reserve the final leaf non-recursively.

### Pseudo-code / Sketches

```text
execute add_git_worktree(toolCallId, params, signal, onUpdate, ctx):
  repoRoot = resolveGitTopLevel(params.repoPath ?? ctx.cwd)
  if no repoRoot: return tool error

  settings = readCoreSettings(ctx.cwd)   // project-local .pi/core-settings.json
  managedRoot = expandHome(settings.worktrees?.root ?? "~/.pi/worktrees")
  managedRoot = requireAbsoluteManagedRoot(managedRoot)
  reject managedRoot if it is inside repoRoot

  repoNamespace = sanitizeLabel(basename(repoRoot)) + "-" + shortHash(repoRoot)
  label = chooseSanitizedLabel(params.label, params mode fields)
  destination = reserveUniqueDirectory(join(managedRoot, repoNamespace), label)
  assert destination is under join(managedRoot, repoNamespace)

  validateModeFields(params)
  validateBranchOrRef(repoRoot, params)
  args = buildGitWorktreeAddArgs(params.mode, destination, params)
  run cancellable git -C repoRoot worktree add ...
  return destination, repoRoot, mode, branch/ref details
```

## Deliverables

### Deliverable 1. Settings and path policy

This deliverable defines where managed worktrees live and makes that policy testable. It adds a minimal `worktrees.root` core setting while keeping the default as `~/.pi/worktrees`, with implementation helpers that expand `~`, sanitize labels, create unique repository namespaces, reserve destinations, and prove generated paths cannot escape the managed directory.

- [x] Add `CoreWorktreeSettings` and optional `worktrees` to `extensions/core/config/types.ts`.
- [x] Add a `validateWorktreeSection` to `validateCoreSettings` AND a `parseWorktreeSettings` to `parseCoreSettings` in `extensions/core/config/persistence.ts` (every section in this file has both halves; the validate half guards `/core-settings edit`).
- [x] Add settings round-trip and validation tests in `tests/core-settings.test.mjs`.
- [x] Add pure helper tests (exported via an `__worktreeForTest`-style hook, matching the existing test-export pattern) for home expansion, absolute-root validation, label sanitization, repo namespace hashing, collision naming, atomic destination reservation, and managed-root containment.
- [x] Add tests that reject configured managed roots inside the resolved source repository.

### Deliverable 2. add_git_worktree tool

This deliverable registers the model-callable creation primitive. The tool should have an explicit schema for `existing_branch`, `detached`, and `new_branch` modes, reject invalid mode/field combinations, run Git from a resolved source repository, allocate the destination from the configured path policy, and return a concise result with the created path and checked-out branch/ref.

- [x] Add a worktree tool module under `extensions/core/extensions/worktree/` with TSDoc on the public registration function and helper functions.
- [x] Define the `add_git_worktree` parameter schema with explicit mode-specific fields.
- [x] Implement exact mode validation from the Plan Details matrix and reject irrelevant mode fields.
- [x] Implement Git source resolution from `ctx.cwd` plus optional `repoPath`.
- [x] Read core settings at runtime and use settings/path-policy helpers to compute `<managedRoot>/<repoNamespace>/<label>`.
- [x] Reserve the destination with a non-recursive `mkdir` lock (collision suffix on `EEXIST`), verify containment, and clean up an empty reservation directory when Git creation fails.
- [x] Validate existing local branches, explicit new branch names, and refs before command execution.
- [x] Implement Git command construction for existing local branch, detached ref, and explicit new branch modes.
- [x] Execute the mutating Git command with cancellation/timeout support from the tool `signal`.
- [x] Return clear tool errors for non-Git source, invalid branch/ref combinations, already-checked-out branches, destination conflicts, timeout/cancellation, and Git command failures.
- [x] Register the tool through `extensions/core/extensions/worktree/index.ts` and `extensions/core/index.ts` without changing unrelated extension wiring.
- [x] Verify `add_git_worktree` is subject to the expected custom-tool permission path (it resolves to `kind: "other"`, ask-by-default in safe/trusted, gated wholesale by tool name) and document the coarse, name-only gating and the missing path/arg detail in audit text in code comments or docs.

### Deliverable 3. Listing and documentation

This deliverable keeps the human-facing `/worktree` workflow aligned with the new managed creation flow. It updates current-repository listing output and docs enough that users can see where managed worktrees went and understand that removal remains manual or Git-native for now.

- [x] Update `/worktree` output to keep absolute paths visible and mark entries under the expanded configured managed root with a stable marker such as `managed`.
- [x] Compare `/worktree` managed entries using resolved absolute paths and full path-segment containment.
- [x] Ensure `/worktree` reads the same `worktrees.root` setting as `add_git_worktree`.
- [x] Update `docs/extensions/WORKTREES.md` with the managed root default, supported tool modes, settings shape, no-remove MVP boundary, and the fact that `/worktree` is current-repository scoped.
- [x] Add docs examples for existing local branch, detached ref, and explicit new branch tool calls, including optional `label` and `repoPath`.
- [x] Update README extension-doc summary only if the worktree docs title/behavior summary changes.

### Deliverable 4. Verification

This deliverable proves the tool works without relying on a live TUI. It extends the Node test suite with focused helper tests and temporary-repository Git tests, then runs the standard checks relevant to TypeScript extension code.

- [x] Add temporary Git repository tests for existing local branch mode.
- [x] Add temporary Git repository tests for detached ref mode.
- [x] Add temporary Git repository tests for explicit new branch mode.
- [x] Add a temporary Git repository test using a non-default configured `worktrees.root`.
- [x] Add tests for same-basename repositories producing distinct repo namespaces.
- [x] Add tests that reject destination traversal, invalid branch/ref input, and invalid mode/field combinations.
- [x] Add test setup that configures local `user.name`, `user.email`, and explicit initial branches in temporary Git repositories.
- [x] Run `npm test`.
- [x] Run `npm run typecheck` if a narrower loop is needed during implementation.

## Issues

- **2026-06-09 — agent:pi (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 17 findings; 17 merged into plan. The largest changes were adding permission expectations, repo namespace hashing, atomic destination allocation, exact mode validation, and configured-root rules.
- **2026-06-09 — agent:pi** — `repoPath` remains the sharpest design edge: the user selected allowing any repo path, but the safety goal argues for `ctx.cwd` by default and strict Git-root resolution for optional `repoPath`. Implementers should not let `repoPath` influence destination paths beyond the sanitized repository label.
- **2026-06-09 — agent:pi (codebase review)** — Plan validated against the codebase. Fixed the tool `execute` signature in the pseudo-code (`ctx` last, `signal` third, `onUpdate` present), decided `worktrees.root` lives in project-local `.pi/core-settings.json` (per `readCoreSettings(ctx.cwd)`, unlike global subagent tiers), made the `validate`+`parse` settings pair explicit, documented that custom-tool permission gating is coarse name-only (`kind: "other"`), specified non-recursive `mkdir`/`EEXIST` for atomic reservation, and pointed reservation/containment work at the existing `isUnderWorktreesDir` helper and `__worktreeForTest` export pattern.
- **2026-06-09 — agent:pi** — `remove_git_worktree` is deferred from the MVP. The grilling surfaced uncertainty about target identity and whether removal is needed; revisit only after `add_git_worktree` usage shows a concrete cleanup workflow.
- **2026-06-09 — agent:pi (implementation)** — All four deliverables implemented. Added `worktrees.root` to the unified settings type/validate/parse, a pure `path-policy.ts` (home expansion, absolute-root requirement, label sanitization, repo-namespace hashing, full-segment containment, non-recursive `mkdir` reservation), the `add_git_worktree` tool (`add-tool.ts`) with strict mode validation, branch/ref pre-checks, cancellable/timeout Git execution, and reservation cleanup on failure, plus `/worktree` `managed` marking via the shared setting. Tests: settings round-trip/validation, path-policy helpers, and temp-repo integration for all three modes, non-default root, same-basename namespaces, and rejection cases. `npm test` (118) and `npm run typecheck` pass. Branch-name validity uses `git check-ref-format --branch`; already-checked-out conflicts surface through Git's stderr.
