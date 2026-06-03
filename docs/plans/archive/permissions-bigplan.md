# BIGPLAN: Core permissions extension (modes + per-call prompts)

## Plan Overview

Build the `permissions` core extension: a single `tool_call`-hook policy engine that gates every tool the agent runs through one of three modes — `safe`, `trusted`, `open` — and, when a call is neither auto-allowed nor auto-denied, prompts the operator with **Only Once / Always For This Project / Deny**. `.env` is denied by default (strictly for path tools, best-effort for bash). A `/permissions` slash command lets the operator switch modes and shows a live showcase of what the current mode allows, asks for, and blocks. Done means: with the extension loaded, a `read`/`grep`/`ls` runs without friction in `safe`, a `write` prompts the operator, an "Always" grant is remembered for the project across restarts, `.env` access by a path tool is blocked, and `/permissions` flips modes with an at-a-glance showcase. Headless (`!hasUI`) sessions behave as `open` mode by design (see Risks). The current `permissions/` files (`index.ts`, `policy.ts`, `enforcement.ts`, `register.ts`) are placeholder stubs; this is net-new implementation onto that scaffold.

## Risks

- **The hook is on every tool call's hot path** — `registerPermissions` adds one `tool_call` handler that fires before _every_ tool the agent runs. If it throws (bad config JSON, a user-authored regex that errors, an unexpected event shape, a UI call rejecting), an unguarded handler turns the permission layer into a single point of failure that blocks or crashes _all_ tool use, not just the call in question. Mitigation: wrap the entire decision in try/catch; on internal error, fail open as `open` mode does (deny a known direct `.env` target if already mapped, otherwise allow) and `notify` the operator once. Malformed config falls back to mode defaults rather than denying everything. Watch-for: a thrown handler surfacing as every tool call failing.
- **Concurrent tool calls stacking prompts** — Pi can execute tool calls in parallel (`executionMode`), so multiple `tool_call` events can be in-flight at once. Each "ask" path `await`s `ctx.ui.select`, and two overlapping dialogs would collide or interleave unreadably. Mitigation: serialize the _prompting_ path through a single async mutex/queue so at most one Once/Always/Deny dialog is open at a time; auto-allow/auto-deny decisions stay fully parallel (no lock). Watch-for: two permission dialogs racing, or a deadlock if the lock isn't released on every return/throw path. Note the mutex is also a throughput chokepoint — a burst of parallel "ask" calls queues strictly behind one operator dialog at a time; acceptable, but consider coalescing identical pending asks (same tool+target) into one dialog if it bites.
- **Headless sessions run as `open` mode (fail-open, by decision)** — When `ctx.hasUI` is false (print/RPC/automation) the extension behaves as `open` mode: allow everything, never prompt, with only the `.env` path-tool default-deny still applying. This is an explicit decision — headless/automated use is defined as `open`. The consequence is real and must be stated plainly: an unattended `pi` provides _no_ gating of `write`/`edit`/`bash` regardless of the persisted mode, so `safe`/`trusted` give no protection headless. Mitigation: document loudly in the showcase, JSDoc, and README; this is accepted for now and revisitable (a future fail-closed-headless option). Watch-for: anyone relying on `safe` to sandbox a non-interactive run.
- **`.env` protection is direct-path-only for path tools, best-effort for bash, and override-able** — Direct path-tool targets (`read`/`write`/`edit`/`ls`/`find`/`grep`) match `.env` reliably by resolved basename, but directory scans such as `grep`/`find` over a parent directory are not recursively expanded by the permission layer and may still surface nested `.env` files. Bash `.env` protection rides the same configurable deny-regex and is trivially bypassable (`c''at .env`, `$VAR`, base64, `xxd`). Additionally, `.env` is _default-deny, override-able_ by an explicit config allow rule — so it is not the absolute block the original brief described. Mitigation: document the direct-path-only boundary and treat bash `.env` blocking as defense-in-depth, not a guarantee; keep direct path-tool targets strict; document the override path. Watch-for: anyone assuming `.env` cannot leak via directory scans or bash. (See Issues — this diverges from the original "always blocked from any and all tools" caveat.)
- **`trusted` cwd-scoping and symlink escape** — `trusted` auto-allows path tools "within CWD and subdirectories." A naive prefix check on the raw argument is fooled by `..` traversal and by symlinks inside the cwd that point outside it. Mitigation: resolve to an absolute real path (`realpath`/`path.resolve`) before the containment check; a target whose real path is outside `cwd` falls to "ask", not "allow". Watch-for: a symlinked path escaping the cwd boundary silently auto-allowed.
- **User-authored regex catastrophic backtracking** — Config rules are regexes evaluated on the hot path. A pathological hand-written pattern could hang the handler on every bash call. Compile-once-at-load only rejects _syntactically invalid_ patterns (drop+warn); it does **not** address a valid-but-slow pattern, which compiles fine and hangs at match time. So runtime ReDoS is explicitly **unmitigated and accepted** as an operator-authored risk (the operator controls their own config). The thing that would make it a real mitigation — a per-match timeout or pattern-length cap — is deferred (see Issues). Watch-for: a tool call hanging after a config edit.
- **Over-broad, permanent "Always" grants** — An "Always For This Project" grant never expires and can grant far more than the call that triggered it: a bash first-token rule like `^git\b` permits `git push` and arbitrary hooks; a directory-prefix grant on `cwd` allows writes to everything under it. Under prompt fatigue, operators grant broadly and never revisit, silently neutering the gate for the project's life. Mitigation: pre-fill the editable bash rule conservatively (anchored first token, shown before saving); surface live config-rule and remembered-grant counts in the showcase; revocation is via `/permissions edit` (Deliverable 5) or by hand-editing `.pi/core-permissions.json`. Watch-for: a growing `remembered` list nobody prunes.

## Plan Details

### Decided behavior (from the pre-draft grill)

- **Modes**:
  - `safe` — allow read-family tools (`read`, `grep`, `ls`, `find`); everything else (`write`, `edit`, `bash`, custom/network tools) → ask.
  - `trusted` — allow path tools (`read`/`write`/`edit`/`ls`/`find`/`grep`) whose resolved target is within `cwd`; allow bash commands matching the safe allow-regex set (`ls`, `cat`, `git log`, `cargo check`, …); ask for external paths and unrecognized/compound commands. Config rules and remembered grants apply on top.
  - `open` — allow everything, never ask, **regardless of config** — the _only_ exception is the `.env` default-deny (still blocked unless an explicit config allow re-permits it). **Headless (`!hasUI`) sessions are evaluated as `open` regardless of the persisted mode.**
- **Per-call prompt** (`safe`/`trusted` "ask" outcomes, interactive only): a `ctx.ui.select` with three choices — **Only Once**, **Always For This Project**, **Deny**. On Deny, a follow-up `ctx.ui.input` collects an optional note, which becomes the `reason` returned to the agent. "Always" persists a remembered grant for the project.
- **"Always" grant granularity**: path tools key on the target's **directory prefix** (grant covers that dir + subdirs); bash derives an anchored first-token rule (e.g. `^npm\b`) and **pre-fills it via `ctx.ui.input`** so the operator can widen/narrow before it is saved.
- **Default mode**: `trusted`, **persisted per-project** in gitignored `.pi/`.
- **`.env`**: default-deny across all tools; an explicit config allow rule may re-permit it (override-able).

### Precedence (evaluated per tool call)

```text
decide(mode, event):
  if !hasUI: mode = "open"                  # headless ≡ open mode, by decision
  if mode == "open":
     target is .env (path tools, or bash deny-regex hit) and no explicit config-allow  -> DENY
     else                                                                               -> ALLOW   # open ignores all other rules
  else (safe | trusted):
     1. target is .env and no explicit config-allow rule        -> DENY   (default-deny)
     2. config DENY rule matches                                -> DENY
     3. config ASK rule matches                                 -> ASK
     4. config ALLOW rule matches OR remembered grant matches   -> ALLOW  (per-key loosening exception)
     5. fall back to MODE DEFAULT for (tool, target)            -> allow | ask
```

Deny-wins over allow within a mode; explicit rules/grants override the mode default but cannot globally relax the mode (there is no "allow all bash" rule — only scoped allow exceptions). `open` short-circuits the whole engine except `.env`.

### Storage

One project-local JSON file, `.pi/core-permissions.json` (gitignored; `.pi/` is already ignored). Hand-editable. Shape:

```jsonc
{
  "mode": "trusted", // active mode, persisted
  "rules": [
    // operator-authored config; compiled once at load
    { "tool": "bash", "action": "deny", "pattern": "rm\\s+-rf" },
    { "tool": "*", "action": "allow", "pattern": "\\.env\\.example$" },
  ],
  "remembered": [
    // machine-written "Always For This Project" grants
    { "tool": "write", "dirPrefix": "/abs/cwd/src" },
    { "tool": "bash", "pattern": "^npm\\b" },
  ],
}
```

`rules` and `remembered` share the same matcher; the distinction is provenance (human config vs prompt-captured) and that `rules` may carry `deny`/`ask`/`allow` while `remembered` is always `allow`.

### Tool → target mapping

- Path tools (`read`/`write`/`edit`/`ls`/`find`/`grep`): target = the resolved absolute real path from `event.input` (e.g. `path`, `file_path`). `.env` check = basename is `.env` or starts with `.env.` (but `.env.example` is matched by an allow rule, not special-cased).
- `bash`: target = `event.input.command` string, matched against the regex sets.
- Everything else (custom tools — `websearch`, `models`, `proxy-audit`, etc.): treated as "other" — `safe`/`trusted` → ask, `open` → allow. No path/bash semantics.

### Critical Files

- `extensions/core/extensions/permissions/index.ts` — Stub `registerPermissions(_pi)`. Becomes the entry: load persisted state into process-global (survive `/reload` like proxy does), register the `tool_call` handler **and the `session_start` re-read handler**, register the `/permissions` command, own the prompt serialization mutex and the per-process "degraded" notify-once flag.
- `extensions/core/extensions/permissions/policy.ts` — Stub (empty). The pure decision engine: `decide(mode, rules, remembered, target) -> "allow" | "ask" | "deny"` plus `.env` detection, cwd-containment on pre-normalized absolute paths, path-segment matching, and regex matching. No filesystem I/O, no UI — unit/smoke-testable in isolation.
- `extensions/core/extensions/permissions/enforcement.ts` — Stub (empty). The `tool_call` handler: map event → target, normalize filesystem paths before calling `decide`, handle `hasUI === false` (open mode), drive the Once/Always/Deny dialog, persist "Always" grants, return `{ block, reason }`. Wraps everything in try/catch (fail open like `open` mode and notify once).
- `extensions/core/extensions/permissions/register.ts` — Stub (empty). The `/permissions` command: mode `ctx.ui.select`, persist the choice, render the showcase panel (reuse the `proxy/audit-panel.ts` pattern).
- `extensions/core/extensions/permissions/persistence.ts` — **new**. Read/write `.pi/core-permissions.json`. Compile `rules` regexes once on read.
- `extensions/core/extensions/tls/persistence.ts` — **reference only, not a runtime dependency** (nothing imports it). Copy its persistence patterns into the new `persistence.ts`: `mkdir(dirname, { recursive: true })`, `writeFile(..., { mode: 0o600 })`, `JSON.parse` in a try/catch that falls back to defaults on absence/malformed, and a `configFilePath(ctx)` keyed off `ctx.cwd`. Reuse the patterns, not the module.
- `extensions/core/extensions/permissions/types.ts` — **new**. `PermissionMode`, `Rule`, `RememberedGrant`, `PermissionState`, decision types.
- `extensions/core/index.ts` — Already calls `registerPermissions(pi)`; no change beyond confirming load order (after proxy is fine; permissions doesn't depend on it).
- `.gitignore` — `.pi/` already ignored; confirm `.pi/core-permissions.json` is covered (it is). No change expected.
- `package.json` — Add a `smoke:permissions` script; no new runtime deps (regex + node fs only).

### Gotchas

- **Pi API contracts (verified against `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`):** `on("tool_call", handler)` handler type is `ExtensionHandler<ToolCallEvent, ToolCallEventResult>` returning `Promise<R | void>`, and the result is `{ block?: boolean; reason?: string }` — the runtime `await`s it, so awaiting UI inside the handler is supported and _is_ how we ask. `ctx.ui.select(title, options, opts?)` returns `Promise<string | undefined>` (undefined on cancel/abort); `ctx.ui.input(title, placeholder?, opts?)` returns `Promise<string | undefined>`; `ctx.hasUI: boolean` and `ctx.signal: AbortSignal | undefined` exist. These are not assumptions — they're confirmed in the type defs. We only ever `block`; we do not mutate `event.input`.
- `event.input` field names differ per tool (`read.path`, `write.file_path`, `edit.file_path`, `ls.path`, `bash.command`, …). Use `isToolCallEventType(name, event)` guards from the API rather than blind property access; built-ins narrow without type params.
- The prompt mutex must release on _every_ exit path (allow, deny, error, abort) or one stuck dialog freezes all subsequent tool calls. Guard with try/finally.
- `ctx.signal` may abort while a dialog is open (user hits escape / aborts the turn). Treat an aborted/closed dialog (`select` resolving `undefined`) as **Deny** (fail toward not-acting), not allow.
- Process-global state across `/reload`/`/new` (the proxy uses a `globalThis` key) keeps the active mode and loaded rules stable across reloads in the same process; re-read the file on `session_start` so external edits to `core-permissions.json` are picked up.
- `.env.example` and similar must remain usable — handled by an allow rule / the "starts with `.env.`" check excluding `.env.example` via an allow rule, not by blocking it. Decide the exact default rule set in D1.
- `.env` path-tool protection checks the explicit target path only. It does not recursively inspect directory arguments for `grep`/`find`; document that boundary rather than pretending the permission layer can guarantee no nested `.env` output from directory scans.
- Read-family vs write-family tool lists must be explicit constants, not inferred, so a newly added built-in tool defaults to "ask" in `safe` rather than silently "allow".
- **Project-root anchor is `ctx.cwd`**, not `process.cwd()` — use the context's cwd for the `.pi/` path and for `trusted` containment, consistent with `tls/persistence.ts`. The cwd-containment check is **decision-time only**: a symlink swapped between the check and the tool's execution (TOCTOU) is unmitigated and accepted; we resolve real paths to defeat the static `..`/symlink case, not a racing attacker.
- Normalize filesystem targets before calling pure `decide()`. Keep `realpath`/missing-path handling out of the policy engine so the engine stays sync and testable.
- `realpath` on the final target fails for legitimate new-file writes. Resolve the nearest existing parent directory and then append the unresolved basename/relative suffix so `write` can create new in-cwd files without turning containment failures into handler errors.
- Directory-prefix grants and cwd-containment checks must compare path segments, not raw string prefixes (`/repo/src` must not match `/repo/src2`).
- **Persistence writes are serialized by the prompt mutex** — an "Always" grant is only written from inside `askOperator`, which already runs under the single prompt lock, so two grant-writes cannot race each other. The remaining race is a grant-write vs a `session_start` re-read; treat the in-memory state as authoritative for the running process and re-read only on `session_start` (not mid-turn), so an external edit can't clobber a just-made grant.
- **"Notify once" on degraded fallback** is a single per-process boolean flag (reset on `/reload`): when the handler hits its try/catch fallback it notifies at most once per process, so a persistently broken config warns the operator without spamming a notification on every tool call.

### Pseudo-code / Sketches

```text
registerPermissions(pi):
  state = loadState(globalThis)          // mode + compiled rules + grants, process-global
  promptLock = new Mutex()

  pi.on("session_start", ctx => state = reloadFromDisk(ctx.cwd))   // pick up external edits
  pi.on("tool_call", async (event, ctx) => {
    try {
      const target = mapTargetAndNormalize(event, ctx.cwd)  // path | command | "other"
      const mode = ctx.hasUI ? state.mode : "open"          // headless ≡ open (documented decision)
      const d = decide(mode, state.rules, state.remembered, event.toolName, target)
      if (d === "allow") return
      if (d === "deny")  return { block: true, reason: denyReason(target) }
      // d === "ask" (only reachable when hasUI, since headless ran as open)
      return await promptLock.run(() => askOperator(ctx, state, event, target))
    } catch (e) {
      ctx.ui.notify("permissions: internal error, allowing as open mode", "warning")
      return knownDirectEnvTarget(event) ? { block: true, reason: ".env blocked by permissions" } : undefined
    }
  })

  registerPermissionsCommand(pi, state)                // /permissions

askOperator(ctx, state, event, target):
  choice = await ctx.ui.select("Permission required", ["Only Once", "Always For This Project", "Deny"])
  switch (choice):
    "Only Once":               return            // allow this call, remember nothing
    "Always For This Project":
        grant = deriveGrant(event, target)       // dir-prefix for paths; editable first-token regex for bash
        if bash: grant.pattern = await ctx.ui.input("Remembered command rule", grant.pattern) ?? grant.pattern
        state.remember(grant); await persist(ctx.cwd, state)
        return
    "Deny" | undefined:
        note = await ctx.ui.input("Reason (optional)", "")
        return { block: true, reason: note || "denied by operator" }
```

## Deliverables

### Deliverable 1. Permission decision engine + persistence

The pure core: types, the `decide()` function implementing the precedence table, `.env` detection, cwd-containment with real-path resolution, the regex matcher, the default mode rule sets, and read/write of `.pi/core-permissions.json`. No UI, no Pi event wiring — this is the testable heart. Success: a `scripts/smoke-permissions.mjs` feeds synthetic `(mode, rules, remembered, tool, target)` tuples through `decide()` and asserts the expected `allow|ask|deny`, including `.env` (denied in every mode, re-permitted by an allow rule), `open` ignoring rules, `trusted` cwd-containment, symlink/`..` escape falling to ask, and bash regex allow/deny.

- [x] Define `types.ts`: `PermissionMode`, `Rule` (`tool`, `action`, `pattern`), `RememberedGrant` (`tool`, `dirPrefix?`, `pattern?`), `PermissionState`, decision union.
- [x] Implement `policy.ts` `decide(...)` per the precedence table, including the `open` short-circuit and the `.env` default-deny with allow-rule override, operating only on already-normalized path targets.
- [x] Implement `.env` detection (basename `.env` / starts-with `.env.`) and cwd-containment on normalized absolute paths so `..` and symlink escapes fall to "ask"; make directory-prefix matches segment-boundary aware.
- [x] Define the default mode rule sets as explicit constants, enumerated concretely (two builders must produce the same security behavior): the read-family allow list for `safe`; the full `trusted` safe-bash allow-regex set (`ls`, `cat`, `pwd`, `git log|status|diff|show|branch`, `cargo check|build|test`, …) and a small default deny-regex set (`rm -rf`, `.env` access, `curl|sh` pipes, …); and the bash **first-token derivation rules** for "Always" grants — how quoting, `sudo`/env-var prefixes, pipes/redirects, and compound (`;`/`&&`/`$()`) commands are handled (compound → ask, never auto-allowed).
- [x] Implement `persistence.ts`: read/write `.pi/core-permissions.json` (mirror `tls/persistence.ts` — `mkdir`, atomic-ish write, `0o600`, malformed → defaults), compiling `rules`/`remembered` regexes once and dropping+warning on invalid patterns.
- [x] Add `scripts/smoke-permissions.mjs` covering the cases above; wire `smoke:permissions` in `package.json`.

### Deliverable 2. `tool_call` enforcement + Once/Always/Deny prompt

Wire the engine into Pi's `tool_call` hook and make the interactive prompt real. Maps each tool event to a target, evaluates `decide()` (treating `!hasUI` as `open`), and for an interactive "ask" drives the three-way `ctx.ui.select` with the optional deny note and the "Always" grant persistence. All wrapped in try/catch (degrade to mode default) and serialized through a prompt mutex. Success: in `safe` mode a `read` runs silently, a `write` raises the three-choice dialog; "Only Once" allows just that call, "Always For This Project" persists a grant that suppresses the next matching call (verified by re-triggering), "Deny" blocks with the typed note surfaced as the agent-visible `reason`; a `.env` path-tool read/write is blocked; two concurrent ask-calls queue rather than collide; a `!hasUI` invocation allows a `write`/`bash` (open behavior) while still blocking a `.env` path-tool read.

- [x] Implement `mapTargetAndNormalize(event, ctx.cwd)` using `isToolCallEventType` guards for each built-in tool; normalize path targets with `path.resolve` + nearest-existing-parent `realpath`; classify unknown/custom tools as "other" (defaulting to ask in `safe`/`trusted`, never skipped).
- [x] Implement the `tool_call` handler in `enforcement.ts`: compute the effective mode (`!ctx.hasUI` → `open`), allow/deny/ask dispatch, return `{ block, reason }`; whole body in try/catch failing open like `open` mode (deny a known direct `.env` target if already mappable, otherwise allow) with the per-process notify-once.
- [x] Implement the prompt mutex so only one Once/Always/Deny dialog is open at a time; release on every path via try/finally; treat `select` returning `undefined` (escape/abort) as Deny.
- [x] Implement "Always" grant derivation: directory-prefix for path tools; anchored first-token bash rule pre-filled through `ctx.ui.input` for operator editing; persist via `persistence.ts` (write happens under the prompt lock).
- [x] Implement the Deny note via `ctx.ui.input`, threading it into the `reason` field so the agent sees why.
- [x] Register the `session_start` handler that re-reads `core-permissions.json` into process-global state, and confirm mode + remembered grants survive `/reload` (process-global) and an external file edit (re-read on next `session_start`).
- [x] Add a concurrency + headless smoke harness driving the enforcement handler directly: assert two concurrent "ask" invocations serialize and the mutex releases on abort/error, and assert `!hasUI` allows `write`/`bash` but blocks a `.env` path-tool read. (The D1 engine smoke has no mutex/handler; this is the integration-level check.)

### Deliverable 3. `/permissions` picker + mode showcase

The operator UX. `/permissions` opens a `ctx.ui.select` of the three modes, persists the choice, then renders a showcase panel of what the chosen mode allows / asks / denies (reuse the `proxy/audit-panel.ts` panel pattern; `ctx.ui.notify` fallback when `!hasUI`). Success: `/permissions` lists the modes with the current one indicated, selecting one persists and takes effect immediately for subsequent tool calls, and the showcase clearly shows the allowed/ask/blocked buckets plus the always-on `.env` block and the headless-allow caveat.

- [x] Implement `register.ts` `/permissions`: `ctx.ui.select` of `safe`/`trusted`/`open` (annotate the active one), persist the selection, update process-global state.
- [x] Build the showcase content **derived from the policy engine's own constants** (the mode rule sets and default rules), not hand-written, so it cannot drift from actual enforcement: per-mode allowed / prompts-for / blocked summary, the `.env` default-deny note, active config-rule and remembered-grant counts, and the "headless sessions run as open mode" caveat.
- [x] Render via a TUI panel when `ctx.hasUI`, falling back to `ctx.ui.notify` otherwise (mirror `proxy/command.ts`'s `present`).
- [x] Support `/permissions` with no args (open picker) and optionally `/permissions <mode>` to set directly without the picker.

### Deliverable 4. Packaging, smoke, and docs

Make it shippable and reconcile the divergence from the original brief. Success: `npm run smoke:permissions` passes, `npm run validate:json` and `npm run pack:dry-run` pass, the new files are packaged, and the `.env` override-able decision is recorded so a future reader isn't surprised it isn't an absolute block.

- [x] Confirm `.pi/core-permissions.json` is covered by the existing `.pi/` gitignore entry (no secrets are written, but config is project-local).
- [x] Ensure the new `permissions/*.ts` files and `scripts/smoke-permissions.mjs` are within the packaged `files` globs; run `npm run validate:json` and `npm run pack:dry-run`.
- [x] JSDoc the exported entry points and the headless-allow + `.env`-override caveats inline where they bite.
- [x] Record in this plan / repo docs that `.env` is default-deny _override-able_ and direct-path-only for path tools (directory scans may still surface nested `.env` files), diverging from the "always blocked from any and all tools" brief, so the guarantee is documented honestly.

### Deliverable 5. `/permissions edit` — config + grant editor

Give operators a first-class way to revoke "Always" grants and tune config rules without leaving Pi or hand-finding the file. `/permissions edit` opens `ctx.ui.editor` (a primitive that already exists) prefilled with the current pretty-printed `core-permissions.json`; on save it validates (JSON parse → schema check → regex compile) and, only if valid, writes atomically via `persistence.ts` and updates the process-global state so the change takes effect immediately. Invalid input is rejected with the error surfaced and the file left untouched (re-open the editor or abort — never persist a broken config). Falls back to `ctx.ui.notify("edit .pi/core-permissions.json directly")` when `!ctx.hasUI`. This is deliberately the **raw-JSON** form for simplicity; a guided revoke picker (`ctx.ui.select` over the `remembered` list to delete individual grants) is a possible later extension, not part of this deliverable. Success: removing a `remembered` grant in the editor and saving makes the next matching call prompt again; a syntactically broken edit is rejected without corrupting the stored config or losing existing grants.

- [x] Route a `/permissions edit` subcommand (alongside the picker/`/permissions <mode>` from D3) into `register.ts`.
- [x] Implement the edit flow: `ctx.ui.editor` prefilled with the pretty-printed current config; on return, validate JSON + schema + regex compile.
- [x] On valid save, write atomically via `persistence.ts` and refresh process-global state; on invalid, surface the specific error and do **not** write (offer re-edit or cancel).
- [x] `!ctx.hasUI` fallback: `notify` pointing the operator at the file path; no editor.
- [x] Extend `scripts/smoke-permissions.mjs` (or the D2 integration smoke) to cover validate-and-reject of a malformed edit and successful grant removal taking effect.

## Issues

- **2026-06-03 — agent:claude** — All 5 deliverables implemented and verified: 63/63 smoke assertions pass (`npm run smoke:permissions`), `npm run validate:json` and `npm run pack:dry-run` pass, all 7 new files packaged. One minor fix during implementation: `isBashEnvAccess` regex tightened from `\.env\b` to `\.env(?!\S)` so `cat .env.example` is not incorrectly flagged.
- **2026-06-03 — user + agent:claude** — Resolved remaining review decisions: target normalization happens before the pure `decide()` call for simplicity/testability; internal permission-layer errors fail open like `open` mode with a warning/notify-once, while still denying a known direct `.env` target if it was already mappable.
- **2026-06-03 — user + agent:claude** — Resolved one review decision: `.env` protection is documented as direct-path-only for path tools; directory scans such as `grep`/`find` over a parent directory are not recursively inspected by the permission layer and may still surface nested `.env` files.
- **2026-06-03 — agent:claude (adversarial review)** — Plan reviewed with Risks & Assumptions plus Completeness & Scope lenses. 5 findings; 2 unambiguous path-normalization fixes merged into Gotchas/D1. Remaining findings need a user decision before editing: `.env` guarantees for directory-scanning path tools, whether containment I/O belongs outside the pure policy engine, and the exact fail-open/fail-closed fallback on internal errors.
- **2026-06-03 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). ~17 findings; most merged. Most significant: the headless fail-open behavior — escalated to the user, who redefined headless as `open` mode (allow-all, `.env` path-deny still applies), now reflected in Overview/Risks/precedence/pseudo-code/D2. Also merged: over-broad permanent "Always" grants (new risk; revocation = hand-edit), honest ReDoS wording (compile-time catches only invalid syntax, runtime ReDoS accepted), Pi API contracts marked verified (not assumed), persistence-write serialization + cwd-anchor/TOCTOU + notify-once-scope gotchas, `tls/persistence.ts` cited as a pattern reference to copy (not a runtime dependency), an explicit `session_start` registration task, a concurrency+headless integration smoke (D1's engine smoke has no mutex), and showcase-derived-from-engine to prevent drift.
- **2026-06-03 — agent:claude** — Open question (verify in D2): confirm `tool_call` fires uniformly for _all_ tools, including custom and MCP tools, so the "other" bucket is actually gated (ask in `safe`/`trusted`) rather than silently bypassing the hook. The Pi type defs show `CustomToolCallEvent` in the `ToolCallEvent` union, which suggests yes, but it is untested against a live MCP tool; the D2 mapTarget task must default unrecognized event shapes to "other"→ask, not skip.
- **2026-06-03 — user + agent:claude** — Added Deliverable 5 (`/permissions edit`): raw-JSON editor via `ctx.ui.editor` to revoke "Always" grants / tune config rules with validate-before-write. A guided revoke picker is noted as a possible later extension. This resolves the review's revocation-UI gap.
- **2026-06-03 — agent:claude** — Deferred (from review): no _expiry_ for "Always" grants (revocation now via Deliverable 5 or hand-edit); runtime ReDoS guard (per-match timeout / pattern-length cap) not implemented; TOCTOU on symlink containment unmitigated (decision-time check only); a future fail-closed-headless option if automation needs gating.
- **2026-06-03 — user + agent:claude (grill)** — Pre-draft grill completed. Decisions captured in Plan Details: headless (`!hasUI`) falls through to **allow**; `open` never asks and ignores all config except the `.env` default-deny; `safe`/`trusted` use full precedence where remembered grants + config allow rules loosen per-key and config deny/ask tighten; bash classified by a configurable allow/deny **regex** list; "Always" grants key on directory-prefix (paths) or an editable anchored first-token rule (bash); default mode `trusted`, persisted per-project in gitignored `.pi/`.
- **2026-06-03 — agent:claude** — **Divergence from original brief flagged:** the initial request said "`.env` should always be blocked from any and all tools," but the grill settled on `.env` as _default-deny, override-able_ by an explicit config allow rule, and bash `.env` protection is best-effort regex (bypassable). The plan implements the grilled decision; if an absolute, un-overridable `.env` block is actually required, that changes Deliverable 1's precedence and is worth confirming before implementation.
- **2026-06-03 — agent:claude** — **Headless = `open` mode, accepted (user decision):** when `!ctx.hasUI` (print/RPC/automation) the extension runs as `open` — allow everything, never prompt, only the `.env` path-tool deny still applies. So `safe`/`trusted` give no gating of `write`/`edit`/`bash` headless. Defined this way deliberately ("headless/automated use is open mode"); documented in the showcase, JSDoc, and README; revisit with a fail-closed-headless option if non-interactive sandboxing is ever needed.
- **2026-06-03 — agent:claude** — Deferred: rule-set hot-reload mid-session beyond `session_start` re-read; per-rule ReDoS guarding beyond compile-time validation; coverage decisions for future custom tools default to "other" → ask in `safe`/`trusted`.
