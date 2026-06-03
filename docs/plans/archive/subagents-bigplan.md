# BIGPLAN: Core Subagents Extension

## Plan Overview

Build the `extensions/core/extensions/subagents.ts` placeholder into a core Pi extension that lets the parent agent spawn isolated, ephemeral subagents for investigation, review, and parallel analysis. The implementation should borrow the proven shape from `/home/calam/code/pi-shit/extensions/subagents/` while fitting poo-pi core conventions: unified `.pi/core-settings.json`, concise TSDoc, and the existing proxy lifecycle. The nested-session APIs this needs (`createAgentSession`, `SessionManager`, `DefaultResourceLoader`, `getAgentDir`, `StringEnum`, `ThinkingLevel`, `Model`) are not all available through the current `pi-coding-agent`/`pi-tui` peers, so this effort accepts adding `@earendil-works/pi-ai` (and `pi-agent-core` if required) as new `"*"` peer dependencies. Done means the parent model can call a `spawn_subagent` tool, choose either a configured `fast` or `high` subagent model when needed, fall back to the currently active `/model` selection by default, and have nested subagent traffic continue through the core provider proxy when the proxy is enabled.

## Risks

- **Proxy bypass in nested sessions** — `createAgentSession()` can use a model object whose `baseUrl` was captured before core proxy overrides were applied. Mitigation: resolve subagent models from the live `ctx.modelRegistry` at tool execution time, add an explicit proxy-readiness/refresh step before creating the nested session, and smoke-test that a subagent request appears in `.pi/proxy-audit`.
- **Nested extension recursion** — Loading core extensions inside a subagent session could register `spawn_subagent` again and let subagents spawn subagents unexpectedly. Mitigation: use a `DefaultResourceLoader` with extensions disabled for the nested session and pass only the intended built-in tools.
- **Settings drift across core schema changes** — `parseCoreSettings()` is lenient-by-design: it starts from defaults and silently discards any section it doesn't recognize, so any write after an un-updated parser will erase the user's `subagents` block. Separately, the "reject invalid edits" promise is not free — the parser drops, it does not reject; rejection requires a dedicated `validateSubagentSection()` returning clear error strings wired into `validateCoreSettings()`. Mitigation: treat subagent settings as a schema slice and update parser, validator (new section helper), persistence, defaults, and UI in the same deliverable.
- **Default-path proxy exposure** — The no-tier default reuses the parent's current `ctx.model`, which is the path most exposed to a stale or un-proxied `baseUrl` (`proxy/routes.ts` already warns when the active model fails to pick up the proxy baseUrl, i.e. this is an observed condition, not hypothetical). Mitigation: verify the default path specifically in Deliverable 4 (not just the explicit-override path), and define behavior — abort or warn — when the resolved active model still points at a non-loopback URL.
- **Tool policy overexposure** — The inspired implementation supports `coding` tools, which can mutate files from a nested session. Mitigation: keep `read-only` as the default, expose `coding` only as an explicit request, and make the tool prompt guidance tell the parent agent when not to grant it.

## Plan Details

### Settings shape

Use the existing unified core settings file rather than introducing a separate `model-tiers.json` file:

```json
{
  "version": 1,
  "subagents": {
    "fast": { "model": "provider/model-id", "thinkingLevel": "off" },
    "high": { "model": "provider/model-id", "thinkingLevel": "high" }
  }
}
```

Only `fast` and `high` are user-configured tiers for this effort. The implicit default is not stored as a static setting: if the tool call omits a tier/model override, it uses the current active `ctx.model` and `pi.getThinkingLevel()` so it tracks the user's latest `/model` and thinking selection.

### Model selection rules

1. Raw `model: "provider/model-id"` override wins, for explicit user requests only.
2. `tier: "fast" | "high"` resolves through `settings.subagents[tier]`.
3. No model/tier uses the parent session's current model and thinking level.
4. Resolved models must exist in `ctx.modelRegistry` and pass `ctx.modelRegistry.hasConfiguredAuth(model)` before creating the nested session.

### Proxy compatibility

Core currently registers subagents before proxy in `extensions/core/index.ts`, but the proxy `ensure()` path runs on `session_start` and `before_agent_start`. The subagent tool must not assume registration order means proxy readiness. Before `createAgentSession()`, it should either invoke a small exported proxy ensure helper or otherwise resolve the selected model after proxy overrides have refreshed the registry. The nested session should receive the same `ctx.modelRegistry` so provider overrides, auth, and proxy-routed model base URLs are shared.

### Critical Files

- `extensions/core/extensions/subagents.ts` — Placeholder to replace with the `spawn_subagent` tool, `/subagents` status command, run tracking, prompt builder, and nested session execution.
- `/home/calam/code/pi-shit/extensions/subagents/index.ts` — Inspiration for schema, UI report, file preloading, run tracking, and nested `createAgentSession()` usage.
- `extensions/core/index.ts` — Core wiring order; `registerSubagents()` currently takes no arguments and registers _before_ `registerProxy()`. Must be reworked to thread the proxy-readiness dependency from `registerProxy()` into `registerSubagents()` (definite change, not "may need").
- `extensions/core/extensions/proxy/index.ts` and `extensions/core/extensions/proxy/routes.ts` — Existing provider override lifecycle and active-model refresh. Note `ensure` is currently a _private closure_ inside `registerProxy()` and is not exported; exposing on-demand readiness changes `registerProxy()`'s contract (its return value/signature) and must consider what happens if `ensure` is called concurrently with the `before_agent_start` ensure.
- `package.json` — Add `@earendil-works/pi-ai` (and `pi-agent-core` if needed) as `"*"` peer dependencies and a test-runner dev dependency + `test` script. CLAUDE.md §9 flags package metadata as sensitive; keep edits minimal and re-run `pack:dry-run`.
- `extensions/core/config/types.ts`, `extensions/core/config/persistence.ts`, `extensions/core/config/defaults.ts` — Unified settings schema, parser, validator, and defaults for adding the `subagents` section.
- `extensions/core/extensions/settings.ts` — Interactive/raw `/core-settings` UI that must expose and validate subagent model configuration.
- `scripts/smoke-proxy-audit.mjs` or a new focused smoke script — Candidate place to verify nested subagent traffic is audited through the proxy.

### Gotchas

- The pi-shit implementation imports shared `model-tiers` helpers that do not exist in this repo; do not copy that dependency shape directly.
- Pi docs recommend `StringEnum` from `@earendil-works/pi-ai` for tool string enums; use it instead of `Type.Union(Type.Literal(...))` for Google compatibility.
- `DefaultResourceLoader({ noExtensions: true })` is important: without it, packaged core extensions can reload inside the subagent and recursively expose the same tool.
- The subagent's transcript should remain ephemeral; only the final answer and compact run metadata return to the parent.
- File preloading needs caps like the inspired implementation so a parent cannot accidentally inject huge files into the nested prompt.
- `ctx.model` can be unset (early session / headless invocation); the reference impl throws "parent session has no active model" in this case. Decide and document the default-path behavior when `ctx.model` is absent — error vs. require a configured tier.
- The double `resolveSubagentModel(...)` in the pseudo-code is intentional: the second call re-reads the registry _after_ the proxy ensure step so the nested session picks up the proxy-rerouted model object rather than a pre-override one.

### Pseudo-code / Sketches

```text
spawn_subagent(params, ctx):
  policy = params.tools ?? "read-only"
  selection = resolveSubagentModel(params, ctx, pi)
  ensureProxyAppliedIfAvailable(ctx)
  selection = resolveSubagentModel(params, ctx, pi)  # after proxy refresh
  run = recordRun(selection, policy, params.task)

  loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), noExtensions: true })
  await loader.reload()
  nested = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    model: selection.model,
    thinkingLevel: selection.thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    tools: toolNamesForPolicy(policy),
    noTools: policy === "none" ? "all" : undefined
  })
  subscribe to nested events for status
  await nested.session.prompt(buildPrompt(params, preloadFiles(params.files)), { source: "extension" })
  return final assistant text
```

## Deliverables

### Deliverable 1. Subagent settings and model resolution

Add a `subagents` settings section to core settings and make model resolution deterministic: configured `fast` and `high` tiers are available, while omitted tier/model uses the active parent `/model` selection at execution time. This deliverable produces reusable parsing, validation, formatting, and UI/config entry points before the tool depends on them.

- [x] Extend `CoreSettings` with a `subagents?: { fast?: SubagentModelMapping; high?: SubagentModelMapping }` section and documented mapping types.
- [x] Update `parseCoreSettings()` to recognize and retain the `subagents` section (the lenient parser drops unknown sections — without this, writes erase the block).
- [x] Add a `validateSubagentSection()` returning clear error strings for invalid tier names, invalid canonical model ids, and invalid thinking levels, wired into `validateCoreSettings()`; confirm which path the raw `/core-settings` editor runs (`validate` vs `parse`) so invalid edits are actually rejected, not silently dropped.
- [x] Add persistence helpers for reading/writing subagent settings without disturbing permissions, TLS, or proxy settings.
- [x] Add `/core-settings` interactive UI rows/actions for `fast` and `high` mappings sourced from authenticated `ctx.modelRegistry` models and supported thinking levels. This couples to live registry-auth state at settings-open time — provide a raw-JSON-edit fallback so configuration is still possible if the dynamic picker is hard or auth is unavailable.
- [x] Implement and unit/smoke-check a resolver that handles raw model override, `fast`/`high` tier, and parent active-model fallback.

### Deliverable 2. Proxy-aware nested session execution

Implement `spawn_subagent` around Pi's nested session APIs, using the live model registry and ensuring proxy overrides are applied before the nested session sends provider traffic. This is the core behavior: an isolated subagent runs the requested task, uses only the selected tool policy, and returns only its final text.

- [x] Replace the placeholder `registerSubagents()` with a documented tool schema using Google-compatible string enums.
- [x] Define the proxy readiness export contract from `proxy/index.ts` (e.g. return an `ensure`/readiness handle from `registerProxy()` rather than keeping it a private closure), and confirm it is safe to call mid-session and concurrently with the `before_agent_start` ensure.
- [x] Thread the readiness handle through `extensions/core/index.ts` into `registerSubagents()` (which currently takes no args and registers before proxy), and consume it in the tool before the second model resolve.
- [x] Create nested sessions with `DefaultResourceLoader({ noExtensions: true })`, `SessionManager.inMemory(ctx.cwd)`, the selected model/thinking level, and bounded tool policies.
- [x] Forward aborts from the parent tool call signal into the nested session and dispose subscriptions/session resources in `finally` blocks.
- [x] Extract the final assistant text from nested `agent_end` messages and return an error result only when execution actually fails.

### Deliverable 3. Operator visibility and safety controls

Expose enough UI/status to make active and recent subagent runs understandable without polluting conversation history. Keep defaults safe and make elevated tool access explicit.

- [x] Track a bounded in-memory run list with id, task, model source, model id, thinking level, tool policy, status, activity, elapsed time, final snippet, and error.
- [x] Register `/subagents` to show active and recent runs in an interactive panel when UI is available and a concise report otherwise.
- [x] Add transient status/widget updates while subagents run and clear them on input/session shutdown.
- [x] Keep `read-only` as the default tool policy, require explicit `coding` in tool args for file mutation, and describe this in `promptGuidelines`.
- [x] Cap preloaded file content per file and in total, normalize leading `@` path prefixes, and report preload failures inside the nested prompt rather than throwing.

### Deliverable 4. Verification and packaging smoke checks

Prove the feature works in the package context, not just by copying the inspiration extension. The most important check is that nested subagent provider calls are routed through the existing core proxy when it is active.

- [ ] Add or update a smoke script that invokes a subagent against a test/fake provider path and verifies a corresponding `.pi/proxy-audit` record is written. Cover the **default (no-tier) path** specifically, not only the explicit-override path, since that is the most proxy-exposed.
- [x] Add focused tests for settings parse/validate behavior, including invalid tier names, invalid canonical model ids, and invalid thinking levels, and the round-trip that an existing `subagents` block survives a write.
- [ ] Add a verification (manual or smoke) for cancellation: abort a running subagent and confirm the nested session stops and subscriptions/session resources are released.
- [x] Run `npm test`, `npm run lint`, `npm run format:check`, `npm run validate:json`, and `npm run pack:dry-run` after implementation.
- [x] Document local manual verification steps in an implementation note (preferred over `README.md`, which already carries a known stale-reference caveat per CLAUDE.md §9), including `/core-settings`, `/subagents`, `spawn_subagent`, and proxy audit confirmation.

### Deliverable 5. Dependency and test-harness groundwork

Establish the package prerequisites the rest of the effort depends on, before implementation begins. This deliverable exists because the nested-session APIs are not all reachable through the current peers, and the verification work assumes a test runner that the repo does not yet have.

- [x] Confirm exactly which symbols (`createAgentSession`, `SessionManager`, `DefaultResourceLoader`, `getAgentDir`, `StringEnum`, `ThinkingLevel`, `Model`) resolve from `pi-coding-agent` vs. require `@earendil-works/pi-ai` / `pi-agent-core`.
- [x] Add the required `@earendil-works/pi-ai` (and `pi-agent-core` if needed) entries as `"*"` peer dependencies in `package.json`; re-run `npm run pack:dry-run`.
- [x] Add a test runner (e.g. `node:test` or `vitest`) as a dev dependency with an `npm test` script, and confirm it runs clean on an empty/placeholder test.

## Issues

- **2026-06-04 — agent:codex (implementation)** — Core implementation, settings tests, and package checks are complete. Remaining verification gaps are the headless/default-path nested proxy-audit smoke and an explicit cancellation verification; both stay open in Deliverable 4.
- **2026-06-04 — agent:claude (adversarial review #2)** — Plan re-reviewed by 2 adversarial passes (Risks & Assumptions, Completeness & Scope), both code-grounded. ~10 findings; merged: firmed the settings-drift risk to reflect the lenient parser, added a default-path proxy-exposure risk, decomposed the proxy-readiness hook into a concrete cross-file contract change, added `validateSubagentSection` and a raw-JSON UI fallback to D1, added cancellation + default-path verification to D4, and added Deliverable 5 (peer deps + test runner). Two findings escalated to user decisions (see below).
- **2026-06-04 — agent:claude (decision)** — Peer dependencies: user chose to pre-commit to adding `@earendil-works/pi-ai` (and `pi-agent-core` if required) as `"*"` peers; the "package-local imports" done-criterion is relaxed accordingly. Tracked in Deliverable 5.
- **2026-06-04 — agent:claude (decision)** — Test harness: user chose to add a real test runner + `npm test` script rather than smoke-only. Tracked in Deliverable 5; D4 now runs `npm test`.
- **2026-06-04 — agent:claude (open)** — Smoke-harness feasibility spike: confirm a nested `createAgentSession` can run headless against the existing fake-provider smoke fixtures and emit an auditable proxy request, before committing to proxy-audit as the D4 acceptance gate. If infeasible headless, the proxy-bypass risk stays practically unverified.
- **2026-06-04 — agent:claude** — Assumption: "fast" and "high" are the only configured subagent model tiers for this effort; the default model is intentionally dynamic and follows the current active `/model` selection rather than being persisted.
