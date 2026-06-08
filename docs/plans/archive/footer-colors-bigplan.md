# BIGPLAN: Footer Dynamic Colors

## Plan Overview

Enhance the core footer so its segment colors better communicate operational risk and activity at a glance. Done means the permissions, subagents, and context segments choose foreground/background theme tokens from their live state, with tests covering the thresholds and states that drive those choices. The work should stay inside the existing footer/subagent/controller seams and avoid introducing new theme schema requirements unless the current token set proves insufficient.

## Risks

- **Theme-token portability** — Footer rendering names theme tokens directly; tokens outside Pi's required 51-color schema can break custom themes. Use only documented required tokens (`muted`, `dim`, `success`, `warning`, `error`, `selectedBg`, `customMessageBg`, `tool*Bg`, etc.) and include bundled-theme visual smoke coverage.
- **Stale footer while subagents change state (likely a real gap, not a maybe)** — The footer's `render()` reads `controllers.subagents.statusLabel()` live, but the only subscription wired to `tui.requestRender()` today is `footerData.onBranchChange` (`footer.ts:155`); nothing repaints on subagent state changes. Subagent updates happen via `ctx.ui.setStatus()`/`setWidget()` in `updateSubagentsUi()` (`subagents/ui.ts:24-33`), which is not guaranteed to repaint the footer. This staleness is **pre-existing** — today's footer already goes stale when subagents change — so the color work makes an existing bug more visible rather than introducing it. Deliverable 2 commits to adding the smallest explicit repaint path at the `updateSubagentsUi()` boundary so the new idle/active contrast actually updates; treat this as in-scope work, not a verification that might be skipped.
- **Visual severity ambiguity** — Permissions modes are ordered by danger in product language, not by code shape. Encode an exhaustive severity map via `Record<PermissionMode, ...>`/`satisfies` so a new mode fails typecheck instead of inheriting a default. Note this guard enforces _coverage_, not _ordering_: `safe` < `trusted` < `permissive` < `open` is an asserted judgment call — only `open` is confirmed most-dangerous by code (`permissions/index.ts:61` notes `open` ungates write/bash), while the `permissive`-vs-`trusted` danger order is undocumented. Tests pin the chosen colors so the ordering is explicit and reviewable, but they cannot prove it is "correct."

## Plan Details

### Current behavior

`extensions/core/extensions/footer.ts` already renders a powerline footer from `Segment` descriptors with `fg` and `bg` theme-token strings. Context has a basic pressure map today: unknown is warning/pending, `>=70%` is warning/pending, `>=90%` is error/error background, otherwise success/success background. Permissions always render as `accent` on `selectedBg`, and subagents render as `mdLink`/`toolPendingBg` only while active, otherwise `muted`/`customMessageBg`.

### Critical Files

- `extensions/core/extensions/footer.ts` — footer segment construction, color-token selection, renderer helpers, and exported pure helpers for tests.
- `extensions/core/extensions/permissions/index.ts` — exposes `PermissionsController.getMode()` and defines the live mode values the footer maps to colors.
- `extensions/core/extensions/subagents/types.ts` — currently exposes only `statusLabel()`, so any richer idle/working state for the footer needs to fit here or be intentionally avoided.
- `extensions/core/extensions/subagents/ui.ts` — formats active subagent labels and performs UI updates when subagent state changes.
- `tests/footer.test.mjs` — focused tests for footer helpers and the natural place to add color-selection coverage.
- `themes/poo-dark.json` and `themes/poo-light.json` — theme palettes used for local visual smoke checks; required-token shape must remain valid.

### Gotchas

- Pi themes require a fixed token shape; arbitrary token names are not documented as safe for distributed themes.
- The user asked to dynamically change the theme item used, so the first implementation should select among existing theme tokens rather than hard-code ANSI/hex colors in footer code.
- `ctx.getContextUsage()` can return unknown usage; the footer must keep a distinct unknown state instead of treating it as healthy or as `0%`.
- Subagents return `undefined` when idle today; this is enough to dim idle state without broadening the controller interface, but not enough for queued-vs-running-vs-error nuance unless the interface changes.

### Pseudo-code / Sketches

```text
permissionsSegment(mode):
  severity = {
    safe:        { fg: success, bg: toolSuccessBg }
    trusted:     { fg: accent,  bg: selectedBg }
    permissive:  { fg: warning, bg: toolPendingBg }
    open:        { fg: error,   bg: toolErrorBg }
  }[mode]
  return { label: "perm", value: mode, ...severity }

subagentsSegment(statusLabel):
  if no statusLabel:
    return { value: "idle", fg: dim-or-muted, bg: customMessageBg }
  return { value: strippedStatus, fg: accent-or-mdLink, bg: toolPendingBg }

contextSegment(percent):
  if percent is null: warning/toolPendingBg, value stays ?
  if percent >= critical threshold: error/toolErrorBg
  if percent >= warning threshold: warning/toolPendingBg
  else success/toolSuccessBg
```

## Deliverables

### Deliverable 1. Permission severity colors

Make the permissions footer segment visibly track the active permissions mode. The mapping must be explicit, ordered by risk, and test-covered so `open` and `permissive` cannot accidentally look as safe as `safe` or `trusted`.

- [x] Add a small documented helper in `extensions/core/extensions/footer.ts` that maps each `PermissionMode` to footer `fg`/`bg` tokens.
- [x] Make the mapping exhaustive with a `Record<PermissionMode, ...>`/`satisfies` shape so a new mode fails typecheck rather than falling through. (This guards token _coverage_; the `safe`/`trusted`/`permissive`/`open` danger _ordering_ remains a documented judgment call — see Risks.)
- [x] Update the `{permissions}` segment to use that helper while preserving the existing glyph, label, and mode value.
- [x] Add `tests/footer.test.mjs` coverage for all permission modes, especially `permissive` and `open`.

### Deliverable 2. Subagent idle/active contrast

Make the subagents segment quiet when idle and more visible while any subagent is queued or running. Keep the scope to idle vs active unless a richer controller state is needed; the current `statusLabel()` contract already distinguishes those states.

- [x] Add a documented helper that maps subagent footer state (`undefined` vs active label) to value and color tokens.
- [x] Update the `{subagents}` segment to use the helper and preserve both the displayed `idle` fallback and the existing `^subagents:` prefix-strip (`footer.ts:224`).
- [x] Add the repaint path at the `updateSubagentsUi()` boundary (`extensions/core/extensions/subagents/ui.ts`) so the footer reflects live idle/active changes. First confirm whether `ctx.ui.setStatus()`/`setWidget()` already repaints the footer; if it does, record that and skip — otherwise add the smallest explicit repaint hook. This is in-scope: without it the new contrast renders stale (see Risks).
- [x] Add footer tests for idle and active subagent segment color choices.

### Deliverable 3. Context pressure thresholds

Refine and test context usage colors so the context segment escalates toward red as usage approaches the model limit. The existing warning/critical thresholds can remain if acceptable, but they should be named and tested rather than hidden in inline conditionals.

- [x] Extract named context pressure thresholds and a documented color-selection helper.
- [x] Preserve the unknown-usage display (`?/window ?`) and give it a non-healthy warning treatment.
- [x] Add boundary tests for unknown, healthy, warning, and critical percentages.
- [ ] Run a local visual smoke pass with `poo-dark` and `poo-light` to confirm the red/yellow/green backgrounds are legible.

### Deliverable 4. Validation and package safety

Prove the change is type-safe, test-covered, and does not break package/theme validation. This is intentionally a final validation slice, not new feature work.

- [x] Run `npm test`.
- [x] Run `npm run validate:json` if any theme file changes.
- [ ] Run a manual TUI visual smoke check with `poo-dark` and `poo-light`, confirming all chosen tokens are from Pi's required theme-token list and remain legible.
- [ ] Run `npm run pack:dry-run` if package resource metadata changes.
- [x] Record any threshold or color-token decisions in this plan's Issues section if they remain subjective after implementation.

## Issues

- **2026-06-08 — agent:pi** — Implementation kept the plan's subjective palette and thresholds: permissions map `safe`/`trusted`/`permissive`/`open` to success/accent/warning/error, context warning remains 70%, and context critical remains 90%. `npm test` and `npm run validate:json` passed; bundled themes contain all selected footer tokens, but manual TUI visual smoke remains outstanding.
- **2026-06-08 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 5 findings; 4 merged into plan. Key changes: made permission-mode color mapping explicitly exhaustive, sharpened the subagent repaint check to the `updateSubagentsUi()` boundary, and added required-token/visual-smoke validation.
- **2026-06-08 — agent:claude** — Open question: exact color-token mapping is not yet user-confirmed. The implementation should prefer the explicit severity mapping in this plan, but the final palette may need adjustment after a TUI visual pass.
- **2026-06-08 — agent:claude (post-review fixes)** — Code-verified the plan against `footer.ts`, `permissions/types.ts`, and `subagents/types.ts`. Three fixes applied: (1) the proposed `tool*Bg`/`selectedBg`/`customMessageBg` tokens are already in use in `footer.ts`, so portability risk is lower than first stated; (2) the subagent repaint concern is a confirmed pre-existing gap (only `onBranchChange` triggers `requestRender`) — Deliverable 2 now commits to adding the repaint path rather than treating it as optional; (3) clarified that the `Record<PermissionMode, ...>` guard enforces coverage, not the danger ordering, and noted `permissive`-vs-`trusted` ordering is an undocumented assertion.
