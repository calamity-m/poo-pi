# BIGPLAN: Worktree awareness

## Plan Overview

This effort makes the core Pi package aware of linked Git worktrees without adding noise in ordinary repositories. When Pi is running from a linked worktree, the default footer should clearly show both the worktree identity and current branch, and each user-prompted agent run should receive a small system-prompt note naming the linked worktree and the current absolute working directory Pi considers active. Done means the footer and prompt context update from live Git/session-cwd data, while sessions outside a linked worktree behave exactly as they do today.

## Risks

- **Worktree terminology mismatch** — Git calls any checkout a working tree, but the requested behavior likely means linked worktrees created by `git worktree add`. Mitigate by detecting linked worktrees specifically, not every Git repository checkout, and documenting that choice in code/tests.
- **Stale cwd context** — Pi's session cwd is stable, while shell `cd` commands inside one-off bash calls do not necessarily change Pi's effective cwd. Mitigate by explicitly scoping the prompt note to Pi's authoritative session/effective cwd (`event.systemPromptOptions.cwd`, then `ctx.cwd`) and by avoiding claims that transient shell directories are tracked unless Pi exposes a real cwd-change path.
- **Footer replacement fragility** — The core footer already owns a custom footer and includes a `{branch}` token. Mitigate by extending the existing segment/template system rather than adding a second footer owner.
- **Synchronous Git on the render hot path** — `footer.ts` calls `buildSegments` inside a synchronous `render(width)` on every `tui.requestRender()`. An uncached `git` spawn per render would block the UI and is slow on WSL/Windows. Mitigate with a session-scoped cache keyed on `ctx.cwd` (which is stable per session, so a single resolve per session suffices); detection must be synchronous (`execSync`/`spawnSync`) because `render` cannot await. Watch-for: measured `git rev-parse` time on a cold cache in a worktree.

## Plan Details

### Detection semantics

For this plan, "in a worktree" means "inside a linked Git worktree", not merely inside any Git repository. A linked worktree can be detected by comparing Git's per-worktree git dir with the common git dir; in normal checkouts they are the same, while linked worktrees have a per-worktree git dir under the common repository's `worktrees/` area. Note that submodules and bare repos also have a per-worktree git dir distinct from the common dir, so a naive dir-comparison can false-positive; the detector should additionally require the per-worktree git dir to live under the common dir's `worktrees/` segment, and the test matrix must cover submodule and bare-repo cases.

The detection helper should return no data when the cwd is outside Git or in the main checkout. When it returns data, it should include enough fields for both footer display and prompt injection: absolute cwd, worktree root, stable worktree display label, branch, and optionally the common git dir/main repository path if cheaply available. The display label should be deterministic: prefer the worktree root basename for compact UI, but keep the absolute root in prompt context/tests so duplicate basenames remain diagnosable. When HEAD is detached (`--abbrev-ref HEAD` returns the literal `HEAD`), normalize the branch field to the short commit SHA so the footer and prompt show the actual commit rather than a confusing `HEAD` string.

The shared helper lives under `extensions/core/lib/` (the established home for shared helpers such as `format.ts`), not a new `worktree/` extension dir. Deliverables 2 and 3 both import it, so Deliverable 1 must land first.

### Critical Files

- `extensions/core/extensions/footer.ts` — owns the default core footer template, branch segment, and footer rendering helpers.
- `extensions/core/extensions/context.ts` — already captures `before_agent_start` prompt options and is a useful reference for system-prompt event handling, though the worktree prompt injection should likely live in its own small module.
- `extensions/core/index.ts` — registers core extension modules; new worktree awareness should be wired here once.
- `tests/footer.test.mjs` — existing pure footer tests to extend for worktree segment/template behavior.
- `README.md` — user-facing core feature notes if the footer or prompt context behavior becomes configurable or otherwise visible.
- `extensions/core/index.ts` — also registers the new `/worktree` command (Deliverable 5).
- Installed `@earendil-works/pi-coding-agent` (`docs/extensions.md`, `dist/core/extensions/types.d.ts`) — reference for the `pi.sendUserMessage` / `ctx.ui` selection APIs and confirmation that `ctx.cwd` is read-only.

### Gotchas

- The current default footer template is `{permissions}{project}{subagents}{context}{model}{branch}`; adding worktree information should avoid duplicating the branch value or making non-worktree sessions wider.
- Pi extension docs expose `before_agent_start` for per-turn system-prompt modification and `ctx.ui.setFooter()` / `footerData.onBranchChange()` for reactive footer updates.
- `footerData.getGitBranch()` already tracks branch changes for rendering, but it does not expose linked-worktree metadata; use a package-local helper unless Pi adds a richer footerData API.
- Running Git commands on every render would be wasteful. Cache detection by cwd plus git-dir/common-dir signature, and invalidate on branch-change callbacks and before each prompt injection. Treat long-lived footer cache freshness as best-effort outside branch/cwd changes.
- `render(width)` in `footer.ts` is synchronous, so detection cannot be async there — use `execSync`/`spawnSync` (or a value cached at a prior async point) rather than a promise.
- The `before_agent_start` injection mechanism is unverified. `context.ts` handles this event by _reading_ `event.systemPromptOptions` and returning nothing; the pseudo-code's `return systemPrompt + note` is illustrative only. Injection most likely happens by appending to `event.systemPromptOptions.appendSystemPrompt` (a field `context.ts` already reads). Verify the real contract before implementing Deliverable 3.
- `event.systemPromptOptions.cwd` is assumed but not referenced anywhere in the current core code; confirm it exists before relying on it, and fall back to `ctx.cwd` (which is confirmed present) otherwise.

### Pseudo-code / Sketches

```text
resolveLinkedWorktree(cwd): WorktreeInfo | null
  run git rev-parse --show-toplevel --git-dir --git-common-dir --abbrev-ref HEAD in cwd
  if git fails -> null
  resolve git-dir and common-dir to absolute paths
  if same path -> null  # main checkout, no linked-worktree behavior
  if git-dir not under <common-dir>/worktrees/ -> null  # submodule/bare, not a linked worktree
  if branch == "HEAD" (detached) -> branch = short SHA of HEAD
  derive compact label from worktree root basename
  return { cwd: absolute cwd, root, label, branch, gitDir, commonGitDir }

footer buildSegments(...):
  info = resolveLinkedWorktree(ctx.cwd)
  if info == null:
    branch segment remains current branch-only segment
    worktree token expands to []
  else:
    branch segment value = info.branch
    worktree segment value = info.label

before_agent_start(event, ctx):
  cwd = event.systemPromptOptions.cwd ?? ctx.cwd
  info = cwd ? resolveLinkedWorktree(cwd) : null
  if info == null: no-op
  # mechanism to verify: append to event.systemPromptOptions.appendSystemPrompt
  # (NOT a string return) — confirm against the live Pi API before building.
  event.systemPromptOptions.appendSystemPrompt += "\n\nWorktree context:\n- Linked worktree: <label>\n- Branch: <branch>\n- Worktree root: <absolute root>\n- Current Pi working directory: <absolute cwd>"
```

## Deliverables

### Deliverable 1. Linked worktree detection

Create a small, tested helper that identifies linked Git worktrees and returns normalized metadata for the rest of the extension. It should not classify non-Git directories or a repository's main checkout as active worktree contexts.

- [x] Add a small synchronous TypeScript helper under `extensions/core/lib/` for resolving linked-worktree metadata from a cwd.
- [x] Use Git plumbing commands with explicit cwd and graceful failure for non-Git directories.
- [x] Require the per-worktree git dir to sit under `<common-dir>/worktrees/` so submodules and bare repos are not misclassified as linked worktrees.
- [x] Normalize a detached HEAD (`--abbrev-ref HEAD` == `HEAD`) to the short commit SHA in the returned branch field.
- [x] Add a session-scoped cache keyed on cwd so the helper is not re-spawned on every footer render or prompt; this is the cache the footer and prompt handlers consume.
- [x] Add unit tests or smoke tests covering non-Git, main checkout, linked worktree, detached HEAD, submodule, bare repo, and duplicate-basename display cases.

### Deliverable 2. Footer worktree display

Extend the existing core footer so the default linked-worktree footer visibly shows worktree identity and branch, while non-worktree sessions render as they do today. This should preserve the `/footer` template model and avoid introducing a second custom footer. Existing custom templates should not be silently rewritten; they can opt into the new `{worktree}` token.

- [x] (Depends on Deliverable 1.) Add a `{worktree}` footer token whose segment expands to `[]` when no linked-worktree metadata exists.
- [x] Set the default template to `{permissions}{project}{subagents}{context}{model}{worktree}{branch}` so the worktree label sits immediately before the branch; confirm the empty `{worktree}` segment yields byte-identical output to today's footer in ordinary repos.
- [x] Keep `{branch}` behavior compatible for users who set custom templates.
- [x] Document that custom footer templates must include `{worktree}` to show the linked-worktree label.
- [x] Extend `tests/footer.test.mjs` for empty worktree expansion and linked-worktree segment rendering.

### Deliverable 3. System prompt worktree context

Inject a short system-prompt note from `before_agent_start` only when Pi's current effective/session cwd is inside a linked worktree. The note should include the linked worktree label, branch, worktree root, and current absolute cwd so the agent has explicit orientation at the start of each user-prompted run.

- [x] (Depends on Deliverable 1.) Register a focused `before_agent_start` handler for worktree context.
- [x] Verify how `before_agent_start` injects into the system prompt (likely mutating `event.systemPromptOptions.appendSystemPrompt`, not a string return) and whether `event.systemPromptOptions.cwd` exists, before wiring the handler.
- [x] Use the same detection helper as the footer to avoid drift.
- [x] Resolve cwd with explicit precedence: `event.systemPromptOptions.cwd` first, then `ctx.cwd`; if neither is available, skip injection.
- [x] Add tests around prompt injection/no-op behavior using pure helper functions where possible.

### Deliverable 4. Documentation and validation

Document the behavior just enough for maintainers and users to understand why linked worktrees receive extra context and ordinary repositories do not. Validate with the existing package checks.

- [x] Add a concise README note if the feature is user-visible enough to warrant it.
- [x] Run `npm run typecheck` and targeted tests for worktree/footer behavior.
- [x] Run `npm test` if the implementation touches shared footer or prompt code broadly.

### Deliverable 5. `/worktree` command (list-only)

Add a `/worktree` slash command that lists the repository's Git worktrees so the user does not have to drop to a separate tool. **Scope is list-only for now**: switching/relocating the agent into a selected worktree is deferred (see the Issues entry) because Pi exposes no extension API to re-point the agent's working directory mid-session. List worktrees with `git worktree list --porcelain` (run from any checkout; it reports all worktrees for the common repository), marking the current one. Reuse Deliverable 1's helper only for label/identity formatting, not for enumeration. Register the command in `extensions/core/index.ts` alongside the other core commands.

- [x] Add a `/worktree` command that enumerates worktrees via `git worktree list --porcelain` and displays them, marking the current worktree.
- [x] Handle non-worktree / single-checkout repos gracefully (notify that there are no linked worktrees) and non-Git directories (no-op with a clear message).
- [x] Add tests for enumeration parsing, current-worktree marking, and the no-worktrees case using pure helpers where possible.

## Issues

- **2026-06-08 — agent:pi** — Implementation validation note: `npm run format:check`, `npm run typecheck`, `node --test tests/footer.test.mjs tests/worktree.test.mjs`, `npm run validate:json`, `npm run pack:dry-run`, and `npm test` pass. During commit, the worktree tests initially failed under Git hook environment variables; the test Git helper now strips Git-local environment variables before creating nested repositories.
- **2026-06-08 — agent:claude** — Deliverable 5 narrowed to **list-only** at user request. Switching/relocating into a selected worktree (and the dirty-tree guard that gated it) is deferred: Pi has no extension cwd-relocation API, and the `pi.sendUserMessage` fallback was judged not worth shipping for now since footer/branch/prompt context (Deliverables 2–3) wouldn't follow such a switch. Revisit if Pi adds a real relocation API. The relocation Risk was removed since list-only carries no such risk.
- **2026-06-08 — agent:claude** — Verified Deliverable 5 feasibility against the installed `@earendil-works/pi-coding-agent`. No extension API re-points the agent cwd mid-session: `ctx.cwd` is a read-only string (`docs/extensions.md:871`), `ReadonlySessionManager` exposes only `getCwd` (`session-manager.d.ts:136`), `FooterDataProvider.setCwd` is excluded from the readonly view and only affects branch display, and `newSession`/`switchSession` take no cwd to re-root. `pi.sendUserMessage(content, { deliverAs })` _is_ available (`docs/extensions.md:1311`), so Deliverable 5 now implements the "move" as a message injection instructing the agent to swap, per the chosen fallback. Residual limitation logged in the Risk: footer/branch/prompt context (Deliverables 2–3) won't follow a message-injected switch.
- **2026-06-08 — agent:claude** — Added Deliverable 5 (`/worktree` command) at user request: interactive worktree picker that relocates the agent into the selected worktree, blocking on any uncommitted changes (`git status --porcelain` non-empty) in the current worktree. Open feasibility question: Pi may not expose a runtime cwd-relocation API — the deliverable and a new top Risk gate the move path behind verifying that capability, with list-and-print-`cd`-target as the fallback.
- **2026-06-08 — agent:claude (adversarial review)** — Second adversarial pass by 2 sub-agents, cross-checked against `footer.ts`/`context.ts`. 11 findings; 9 merged. Biggest changes: caching now has an owning task (footer `render` is synchronous and ran uncached git per render); detection guards against submodule/bare-repo false positives; detached HEAD normalizes to short SHA (user choice); default template fixed to `…{model}{worktree}{branch}` (user choice); prompt-injection sketch corrected to mutate `appendSystemPrompt` rather than return a string, with that mechanism and `systemPromptOptions.cwd` flagged for verification. Verified `onBranchChange`/`getGitBranch`/`setFooter`/`ctx.cwd`/`appendSystemPrompt` all exist.
- **2026-06-08 — agent:pi** — Open terminology question: this plan interprets "when we enter a worktree" as a linked Git worktree, not every Git repository working tree. If that is wrong, Deliverable 1 detection semantics should change before implementation.
- **2026-06-08 — agent:pi** — Pi may not expose a persistent directory-change event for transient `cd` commands inside bash tool calls. The plan injects Pi's authoritative current cwd per turn, but deeper tracking may require core Pi support if `ctx.cwd` does not change in the scenarios the user cares about.
