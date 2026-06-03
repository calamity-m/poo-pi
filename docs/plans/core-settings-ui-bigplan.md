# BIGPLAN: Core Settings UI

## Plan Overview

Build an interactive `/core-settings` UI that feels like Pi's built-in `/settings`, but manages poo-pi core extension settings stored in `.pi/core-settings.json`. Done means interactive users can open `/core-settings`, navigate a settings list, change supported core options with immediate persistence and live application where applicable, while non-interactive use keeps the existing `show`, `edit`, and `path` command behavior. The UI should avoid exposing TLS secrets or over-expanding into unrelated core extension refactors.

## Risks

- **Live state drift** — Writing `.pi/core-settings.json` alone is not enough for settings already held in process memory, especially permissions mode/rules and proxy audit redaction. Route every UI change through the same helpers or runtime state used by existing commands so the change is both persisted and active immediately.
- **Secret leakage in TLS UI** — TLS source metadata can include sensitive paths, while passphrases and certificate bytes must never enter rendered text, editor prefill, notifications, or chat history. Reuse the existing TLS setup flow and redacted labels instead of exposing raw target data in the settings list.
- **Built-in `/settings` internals are not extension API** — Pi's default selector uses internal `showSelector` wiring that extensions cannot call directly. The generic `SettingsList` (with its `SettingItem[]` rows) is **not** exported from `@earendil-works/pi-coding-agent`; it lives in `@earendil-works/pi-tui`, which is not currently a declared dependency. The exported `SettingsSelectorComponent` is hardwired to Pi's own settings shape (`autoCompact`, `showImages`, `thinkingLevel`, …) and cannot represent core rows. Decision (2026-06-03): add `@earendil-works/pi-tui` as a `"*"` peer dependency and use its `SettingsList`/`SettingItem`, rendered through public `ctx.ui.custom()` with `getSettingsListTheme()`. Pi provides `pi-tui` at runtime, consistent with the existing `pi-coding-agent` peer dep.
- **Structured config does not fit simple toggles** — Permission rules, remembered grants, and TLS targets are nested objects/arrays, not simple enum values. Keep simple values inline and provide explicit configure/edit actions for nested sections rather than forcing fragile string encodings into `SettingsList` rows.

## Plan Details

### UX Shape

`/core-settings` should become the interactive selector entrypoint when `ctx.hasUI` is true. Keep `/core-settings show`, `/core-settings edit`, and `/core-settings path` so existing scripted/headless usage remains clear. In headless mode, no-arg `/core-settings` should fall back to showing effective settings or a usage message rather than trying to open a TUI.

Initial settings list candidates:

- Permissions mode: `safe`, `trusted`, `permissive`, `open`; persist and update the active permission state.
- Permissions config: `configure`; open the existing validated JSON editor for rules and remembered grants, or a scoped editor for the permissions section.
- Proxy audit redaction: `on`, `off`; persist so subsequent proxy requests use the new redaction mode.
- Client TLS: `configure`; open/reuse the existing TLS setup flow, showing only redacted status/labels.
- Core settings JSON: `edit`; preserve the current full-file editor path for advanced users.

### Critical Files

- `extensions/core/extensions/settings.ts` — Current `/core-settings show|edit|path` command; likely home for command dispatch and/or a thin wrapper around a new UI component.
- `extensions/core/config/persistence.ts` — Unified read/write/validation helpers for `.pi/core-settings.json`; UI changes should use or extend these helpers.
- `extensions/core/config/types.ts` — Source of truth for persisted core settings shape.
- `extensions/core/extensions/permissions/index.ts` — Owns process-global permission state; likely needs to expose a small controller or return value so `/core-settings` can update live permissions.
- `extensions/core/extensions/permissions/register.ts` — Existing `/permissions` command has validated edit/mode logic that should be reused or extracted, not duplicated blindly.
- `extensions/core/extensions/proxy/command.ts` and `extensions/core/extensions/proxy/audit.ts` — Existing proxy redaction command and persistence path; `command.ts` guards on `state.auditDir` and writes via `writeRedactionMode` (a thin wrapper over `writeCoreProxyRedactionMode`). Settings UI must share the same write path.
- `extensions/core/extensions/proxy/audit-panel.ts` — `showInlinePanel` helper the existing proxy/TLS commands render through; reuse for consistent inline feedback.
- `extensions/core/extensions/tls/index.ts` and `extensions/core/extensions/tls/tui.ts` — Existing TLS setup and secret-safe UI; settings UI should call into this rather than rendering secret-bearing details.
- `extensions/core/extensions/tls/pfx-source.ts` and `extensions/core/extensions/tls/persistence.ts` — Source registry + interactive passphrase provider and target read/write that `resolveClientTls`/`/tls-setup` depend on; the configure action must wire these exactly as `registerTls` does, not reconstruct them.
- `extensions/core/config/paths.ts` — Provides `coreSettingsPath` and `cwdFromProxyAuditDir` used by every write helper.
- `package.json` — Add `@earendil-works/pi-tui` to `peerDependencies` as `"*"`; keep the existing peer-dep-only convention.
- `/home/calam/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/settings-selector.js` — Reference implementation for Pi's built-in `/settings` UX.
- `/home/calam/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — Public extension TUI patterns, especially `SettingsList` and `ctx.ui.custom()`.

### Gotchas

- `SettingsList` can update values immediately, so callbacks must be safe to run multiple times and should notify only when useful.
- `SettingsList` is a `pi-tui` export, not a `pi-coding-agent` one; do not reach for the exported `SettingsSelectorComponent`, which only models Pi's built-in settings and cannot hold core rows.
- The current `/core-settings` no-arg behavior shows JSON; changing no-arg to open UI is a behavior change. `show` must always print/panel JSON; only bare no-arg opens the selector under `ctx.hasUI`. The current handler treats `""` and `"show"` identically, so they must be split.
- `readCoreSettings()` returns defaults on malformed JSON; the UI should surface validation errors from edit flows instead of silently normalizing user edits.
- Permissions are loaded into a mutable process-global state on `session_start`; replacing the object will not update closures, but mutating the existing object will. The settings UI must reach the _same_ global the `tool_call` hook closes over (via `permissions/index.ts`), not construct a second state object.
- Permission-mode "live apply" is interactive-process-only: when `!ctx.hasUI`, the permissions extension runs as `open` regardless of persisted mode (`permissions/index.ts`). The UI must not imply the chosen mode is globally enforced; headless sessions ignore it by design.
- Proxy redaction is read fresh per request from the unified file, so persistence is enough for subsequent requests, but user feedback should still say the change affects future requests.
- Proxy redaction persistence is `auditDir`-keyed: `command.ts` guards on `state.auditDir` and returns "audit store not initialized yet" before the proxy starts, and `writeCoreProxyRedactionMode` derives cwd from `auditDir`. The settings UI is reachable from `ctx.cwd` and may not have `auditDir`; it needs either the proxy state or a cwd-based redaction write path, and cannot persist via the existing path when the proxy isn't running.
- TLS setup can prompt for passphrases; do not route that through generic JSON editors or settings-list values.

### Pseudo-code / Sketches

```text
/core-settings handler(args, ctx):
  if args == "show" -> showSettings(ctx)
  if args == "edit" -> editSettings(ctx)
  if args == "path" -> notify path
  if args non-empty -> usage warning
  if !ctx.hasUI -> showSettings(ctx)
  openCoreSettingsSelector(ctx, controllers)

openCoreSettingsSelector(ctx, controllers):
  read current settings + live statuses
  build SettingItem[] with simple enum rows and configure rows
  ctx.ui.custom((tui, theme, _kb, done) =>
    Container(DynamicBorder, title, SettingsList(...), help, DynamicBorder)
  )

on setting change:
  permissions-mode -> controllers.permissions.setMode(ctx, value)
  proxy-redact -> writeCoreProxyRedactionMode(auditDir-or-cwd adapter, value)
  permissions-config -> open validated permissions editor, update live state
  tls-configure -> controllers.tls.configure(ctx)
  json-edit -> editSettings(ctx), then refresh list
```

## Deliverables

### Deliverable 1. Public settings UI shell

Create the interactive selector for `/core-settings` using public Pi TUI APIs. This deliverable changes command routing so interactive no-arg `/core-settings` opens a `SettingsList` UI, while `show`, `edit`, and `path` remain available and headless no-arg behavior remains useful.

- [x] Add `@earendil-works/pi-tui` to `package.json` `peerDependencies` as `"*"`.
- [x] Add or extract a small core settings selector component using `ctx.ui.custom()`, `SettingsList`/`SettingItem` from `@earendil-works/pi-tui`, `getSettingsListTheme()`, and existing border/text patterns.
- [x] Route `/core-settings` with no args to the selector only when `ctx.hasUI` is true.
- [x] Preserve `/core-settings show`, `/core-settings edit`, and `/core-settings path` behavior; `show` always renders JSON (never opens the selector), even when `ctx.hasUI`.
- [x] Add clear help/usage text for unknown subcommands.
- [x] Verify with lint/format and a lightweight interactive smoke path if available.

### Deliverable 2. Live-applied simple settings

Wire simple settings rows that can be represented as enum/toggle values. The first target rows are permission mode and proxy audit redaction because they already have existing command semantics and persisted storage.

- [x] Export a permissions controller from `permissions/index.ts` (which owns the process-global state) that sets mode and mutates the shared `PermissionState` in place; extract the existing private `applyMode` from `register.ts` rather than duplicating it.
- [x] Add a permissions mode row with values `safe`, `trusted`, `permissive`, and `open`.
- [x] Add a proxy audit redaction row with values `on` and `off`, persisting via `writeRedactionMode`/`writeCoreProxyRedactionMode` (not a direct `writeCoreSettings`); make the proxy state or a cwd-based write path reachable from the settings command, and degrade gracefully when the proxy isn't running.
- [x] Ensure UI changes give concise feedback and apply without requiring `/reload` where the current runtime can support it.
- [x] Add or extend smoke coverage for persisted permission mode and proxy redaction changes.

### Deliverable 3. Configure actions for structured settings

Provide safe paths for settings that are nested or secret-adjacent instead of forcing them into inline toggle rows. This deliverable should reuse existing validated editors and TLS setup flows as much as possible.

- [x] Add a permissions config `configure` action that reuses `validateConfig` from `permissions/persistence.ts` (which compiles regexes into the live state via `writePermissionState`) — not `validateCoreSettings` — and extract `handleEdit` from `register.ts` rather than duplicating it.
- [x] Add a client TLS `configure` action that invokes the existing secret-safe `/tls-setup` flow, wiring `tls/pfx-source.ts` and `tls/persistence.ts` exactly as `registerTls` does rather than displaying raw target metadata.
- [x] Add a core settings JSON `edit` action for advanced full-file edits, then refresh the visible settings list after successful save.
- [x] After every configure/edit sub-flow returns (permissions edit, TLS setup, JSON edit), re-read core settings + live state and refresh all affected rows, so the mode/TLS-status/redaction rows never show stale values.
- [x] Ensure TLS UI displays only redacted status or labels and never passphrases, certificate bytes, or full sensitive paths.
- [x] Document any structured setting that remains intentionally editable only through raw JSON.

### Deliverable 4. Validation and documentation

Update documentation and checks so future agents understand the UI behavior and its boundaries. This includes README command docs and test/smoke expectations around live application vs persisted-only changes.

- [x] Update `README.md` to describe interactive `/core-settings`, retained subcommands, and what each row controls.
- [x] Add a short note that TLS secrets are never persisted or displayed by the settings UI.
- [x] Run `npm run format:check`, `npm run lint`, relevant smoke scripts, `npm run validate:json`, and `npm run pack:dry-run`.
- [x] If interactive behavior cannot be automated, record the manual smoke steps in the implementation notes or README.

## Implementation Notes

**2026-06-03 — implemented.** All four deliverables landed:

- `package.json` declares `@earendil-works/pi-tui` as a `"*"` peer dependency.
- `extensions/core/extensions/settings.ts` hosts the selector loop (`ctx.ui.custom()` + `SettingsList`/`SettingItem` + `getSettingsListTheme()`, framed by `Container`/`Text`). Each loop pass re-reads settings + live state, so rows refresh after any sub-flow. Configure/edit rows use a `submenu` that immediately closes the selector and reports an action, since the editor/setup flows cannot be hosted inline.
- Simple rows live-apply: permission mode via the new `PermissionsController.setMode` (extracted `applyPermissionMode` in `register.ts`, mutates the shared global state in place); proxy redaction via `writeRedactionMode(auditPaths(cwd).dir, …)`, which works even when the proxy never started.
- Configure rows reuse existing flows: `PermissionsController.editConfig` (extracted `editPermissionConfig`, `validateConfig` + `writePermissionState`), `ClientTlsController.configure` (the exact `/tls-setup` flow), and the raw JSON editor. TLS rows show only `statusLabel()` — `loaded`/`unconfigured`/`error`.

**Manual smoke (interactive UI not automatable):** in a UI session, run `/core-settings`; cycle Permissions mode and confirm the footer notice + persisted `permissions.mode` in `.pi/core-settings.json`; toggle Proxy audit redaction and confirm `proxy.audit.redact`; activate Client TLS and confirm the `/tls-setup` flow opens and the row reflects the new status on return; activate Permissions config / Core settings JSON and confirm the validated editors open and rows refresh after save. Automated coverage: `smoke:permissions` (persisted mode round-trip) and `smoke:proxy-audit` (cwd-derived redaction round-trip).

## Issues

- **2026-06-03 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 11 findings; 10 merged. Most significant: both reviewers independently found the central UI primitive `SettingsList` is not a `pi-coding-agent` export (it's in the un-installed `@earendil-works/pi-tui`) and `SettingsSelectorComponent` is hardwired to Pi's settings — verified directly. User chose to add `pi-tui` as a `"*"` peer dependency. Also merged: permission-mode live-apply is interactive-only (headless runs `open`), proxy redaction is `auditDir`-keyed and needs proxy-state reachability, list-refresh after sub-flows was missing, and the exact validators/write helpers/controller extraction points are now named. One MINOR (TLS configure-only consequence) folded into the existing TLS deferral below.
- **2026-06-03 — agent:pi** — Open decision: should `/core-settings` include a way to clear/reset persisted TLS target metadata, or only reuse `/tls-setup` configuration? Deferring is safe because configure-only matches existing capabilities and avoids inventing destructive behavior. Concrete consequence to track (added by review): configure-only leaves a one-way door — no UI path to clear a persisted TLS target — and the TLS configure action is a no-op headless, since `resolveClientTls` returns `unconfigured` when `!ctx.hasUI`.
- **2026-06-03 — agent:pi** — Open decision: if full JSON edit changes TLS/proxy/permissions, should the selector attempt to live-apply every changed section immediately, or notify users to run `/reload` for sections that cannot be safely refreshed? Deferring is safe because simple rows can still live-apply through dedicated callbacks.
