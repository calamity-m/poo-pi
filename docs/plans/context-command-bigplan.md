# BIGPLAN: Context Command

## Plan Overview

Add a core Pi extension command, `/context`, that gives users a fast, trustworthy snapshot of current context usage without sending any output to the model or adding entries to message history. The command should show the canonical current usage from Pi, then explain what is filling the window with clearly labeled estimates and top contributors. Done means a user can run `/context`, visually understand how close they are to the model limit, see the dominant contributors, and close the report without changing the session branch or future LLM context.

## Risks

- **False precision in breakdowns** — `ctx.getContextUsage()` gives the canonical total, but Pi does not expose exact token counts per source category. Treat the top-line total as authoritative, derive category breakdowns as estimates, and always include an `unknown/overhead` bucket when estimates do not reconcile with the canonical total. Use Pi's own exported tokenizer (`estimateTokens` / `calculateContextTokens` / `serializeConversation`) for the per-category estimates so they reconcile against the canonical total instead of diverging the way an ad-hoc char/4 heuristic would.
- **Accidental history pollution** — Sending a user/assistant message or appending a session entry would make `/context` part of future context. The command context's session manager is a `ReadonlySessionManager` (no `appendCustomMessageEntry`/`sendMessage`), so the reachable mutation surface is the command-context actions: `ctx.sendMessage`, `fork`, `navigateTree`, `newSession`, `switchSession`, `compact`, `appendCustomMessageEntry` (where exposed). Keep output in `ctx.ui.custom()` / `ctx.ui.notify()` / `console.log`, and add a test that asserts none of those mutating actions are called and `getBranch().length` is unchanged before/after the handler.
- **Unavailable usage after compaction or on a fresh session** — `ctx.getContextUsage()` returns `ContextUsage | undefined`, and even when present its `tokens`/`percent` can be `null` (after compaction, before the next assistant usage). The command must handle three states distinctly: object `undefined`, object present with `tokens: null`, and object present with tokens. Render a useful report in all three: show the percentage as unknown where it is, explain why, and display branch/system estimates separately.
- **No `ctx.mode` field; only a `hasUI` boolean** — There is no `tui/rpc/json/print` mode enum on the extension context. The only transport signal is `ctx.hasUI: boolean` (false in print/RPC modes). The output path is a 2-way switch — render the panel when `hasUI` is true, fall back to `ctx.ui.notify`/`console.log` text when false — not the 4-row matrix originally sketched. Any finer transport distinction is an open question, not a settled deliverable.
- **Slow report at high context pressure** — `/context` is most valuable when sessions are already large, and char/token estimation inherently serializes every active-branch entry, so cost is O(total branch bytes) — which grows precisely when the command is used. "Avoid full-history processing" here means active-branch-only (already required) plus a concrete ceiling, not avoiding the per-entry pass. Mitigation: inspect only the active branch, cap top contributors, never read files from disk, and add a large-branch fixture asserting a stated budget (target: report build < 50ms on a branch of ~500 entries / ~1M chars). Without a numeric target the smoke test asserts nothing.

## Plan Details

### Shared understanding

- `/context` is an extension command, not a prompt template and not an LLM tool.
- The command is observational: it reads session/model/system prompt state and renders a report; it should not mutate the session or trigger an agent turn.
- The top-line usage number comes from `ctx.getContextUsage()` (which can be `undefined`) and should be the number users learn to trust.
- The "what filled it up" section is useful only if it is honest about estimate quality.
- The first version should optimize for the common interactive UI case (`ctx.hasUI === true`), with a small text fallback when `hasUI` is false.
- The command context exposes `getSystemPrompt(): string` (a flat assembled string), **not** a structured `getSystemPromptOptions()`. To itemize the system prompt into named contributors, the extension subscribes to `before_agent_start` and caches the `systemPromptOptions` payload from that event; the command reads the cache. If no turn has started yet, the cache is empty and system/static is shown as a single sized blob from `getSystemPrompt()`.

### UX sketch

Default `/context` opens a compact, dismissible panel. The panel should fit in one terminal screen for normal sessions and degrade into a scrollable text panel when there are many contributors.

```text
User mental model

  "Can I keep going?"        "What should I trim?"
          │                          │
          ▼                          ▼
  ┌────────────────────────────────────────────────────┐
  │ /context                                            │
  │  1. How full is the active model window?            │
  │  2. What categories dominate the current prompt?    │
  │  3. Which entries/files/results are the top items?  │
  └────────────────────────────────────────────────────┘
```

```text
Proposed default panel

┌ context ───────────────────────────────────────────────────────────────┐
│ model  anthropic/claude-sonnet-4-5        window 200k                  │
│ usage  128.4k / 200k   64%                 status OK                   │
│                                                                        │
│ [██████████████████████████░░░░░░░░░░░░░░] 64%                         │
│                                                                        │
│ estimated makeup                                  quality good         │
│ system/static      31.0k 24%  ██████░░░░░░░░░░░░░░░░░░                 │
│ conversation       58.0k 45%  ███████████░░░░░░░░░░░░░                 │
│ tool results       26.4k 21%  █████░░░░░░░░░░░░░░░░░░░                 │
│ summaries           5.7k  4%  █░░░░░░░░░░░░░░░░░░░░░░░                 │
│ unknown/overhead    7.3k  6%  █░░░░░░░░░░░░░░░░░░░░░░░                 │
│                                                                        │
│ top contributors                                                       │
│  1. AGENTS.md + loaded context files                 ~18.2k            │
│  2. assistant turn 9 with tool calls                  ~14.1k           │
│  3. read: extensions/core/extensions/subagents/...    ~10.4k           │
│                                                                        │
│ note: category counts are estimates; total usage is from Pi.           │
│ Esc/Enter/q close                                                      │
└────────────────────────────────────────────────────────────────────────┘
```

```text
Color/status thresholds

  0-69%       green/normal   "OK"
  70-89%      yellow         "watch"
  90%+        red            "compact soon"
  unknown     dim/warning    "usage unknown until next model response"

  empty ─────────────────────────────── full
        ████████████████████░░░░░░░░░░
```

### Data flow

```text
/context command
   │
   ├─ read canonical usage
   │    └─ ctx.getContextUsage() -> { tokens, contextWindow, percent }
   │
   ├─ read model/session/system sources
   │    ├─ usage.contextWindow (canonical; ctx.model?.contextWindow only as fallback when usage is undefined)
   │    ├─ cached systemPromptOptions (from before_agent_start) or getSystemPrompt() blob
   │    └─ ctx.sessionManager.getBranch()
   │
   ├─ classify + estimate contributors
   │    ├─ system/static: custom/system prompt, context files, skills, tools
   │    ├─ conversation: user + assistant text/thinking/tool calls
   │    ├─ tool results: toolResult and bashExecution outputs in context
   │    ├─ summaries: compaction + branch summaries
   │    └─ unknown/overhead: canonical total minus estimates, clamped at 0
   │
   └─ render command-only output
        ├─ ctx.hasUI: inline ctx.ui.custom(...) via showInlinePanel()
        ├─ no UI (hasUI false): console.log(formatPlainReport)
        └─ no sendMessage / no appendEntry / no triggerTurn
```

### Mode behavior matrix

```text
ctx.hasUI   output path                         history effect
─────────   ───────────                         ──────────────
true        dismissible inline ctx.ui.custom panel none
false       console.log plain text report        none
```

There is no `ctx.mode` enum; `ctx.hasUI` is the only transport signal (false in print/RPC). The v1 command does not trigger model calls. If Pi later exposes a structured command return channel for headless modes, that can replace `console.log`, but it should still stay outside session history.

### Classification rules

Session entries are a discriminated union on `entry.type`: `message`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `thinking_level_change`, `model_change`, `session_info`. There is **no** top-level `toolResult` or `bashExecution` entry type — tool calls and their results live _inside_ a `message` entry's `AgentMessage` content blocks. Classification therefore happens at two levels: by `entry.type`, then by content block within `message` entries.

```text
entry / block                                       bucket
─────────────                                       ──────
cached systemPromptOptions.customPrompt             system/static
cached systemPromptOptions.appendSystemPrompt       system/static
cached systemPromptOptions.contextFiles[*]          system/static (label path only)
cached systemPromptOptions.skills[*]                system/static (label name/path only)
cached systemPromptOptions tool/guideline snippets  system/static
  (or, if cache empty: getSystemPrompt() whole)     system/static (single sized blob)
entry.type == message, role user                    conversation
entry.type == message, assistant text/thinking      conversation
entry.type == message, assistant tool-call block    conversation
entry.type == message, tool-result content block    tool results
entry.type == compaction                            summaries
entry.type == branch_summary                        summaries
entry.type == custom_message                        conversation, labeled custom:<type>
entry.type == label/thinking_level_change/etc.       ignored for context makeup
```

Tests should cover both the entry-level and block-level mapping directly so the report does not drift as format helpers change. The "tool results" bucket specifically requires descending into `AgentMessage` content blocks — call that out as its own implementation task, not an entry-type switch.

### Estimation strategy

The implementation should reuse Pi's own exported tokenizer rather than an ad-hoc char/4 heuristic — Pi's main entry exports `estimateTokens`, `calculateContextTokens`, and `serializeConversation` (the same functions Pi uses for compaction), so there is no new dependency and per-category estimates reconcile against the canonical total instead of diverging for tokenizer-mismatch reasons. Estimate per item with `estimateTokens` (serializing entries via `serializeConversation`/`stableTextFor` as appropriate), reconcile against `ctx.getContextUsage().tokens` when available, and label the result as approximate. Keep the estimator deterministic and testable.

```text
estimate source item:
  text = stableTextFor(item)        // serializeConversation for message entries
  estimatedTokens = estimateTokens(text)   // Pi's exported tokenizer

reconcile:
  knownEstimate = sum(category estimates)
  canonical = usage.tokens

  if canonical is known:
    unknown = max(0, canonical - knownEstimate)
    if unknown / canonical > 0.50:
      mark estimateQuality = "low" and suppress fine-grained confidence language
    if knownEstimate > canonical:
      scale displayed category percentages against knownEstimate
      show note: "category estimates exceed canonical total"
  else:
    unknown = null
    estimateQuality = "limited"
    show percentages against knownEstimate only
```

The formatter should display an estimate quality label (`good`, `low`, or `limited`) near the category bars. Fine-grained bars are still useful as directional hints, but the panel should never imply category counts are exact.

### ASCII architecture

```text
Extension registration

extensions/core/index.ts
        │
        ├─ registerClear(pi)
        ├─ registerPrompt(pi)
        ├─ registerSubagents(pi)
        └─ registerContext(pi)  ◄── new
                  │
                  └─ pi.registerCommand("context", { handler })
```

```text
No-history guarantee

             allowed                               forbidden
  ┌─────────────────────────┐          ┌──────────────────────────────┐
  │ ctx.ui.custom inline    │          │ pi.sendMessage(...)           │
  │ ctx.ui.notify summary   │          │ pi.sendUserMessage(...)       │
  │ local strings/objects   │          │ appendCustomMessageEntry(...) │
  └───────────┬─────────────┘          └──────────────┬───────────────┘
              │                                       │
              ▼                                       ▼
     terminal/RPC only                       future LLM context grows
     session branch unchanged                requirement violated
```

### Critical Files

- `extensions/core/index.ts` — Registers bundled core extension capabilities; should import and call the new context command registration.
- `extensions/core/extensions/context.ts` — Proposed new small module containing `/context` command registration, report building, formatting helpers, and test exports.
- `extensions/core/lib/ui/panel.ts` — Existing reusable read-only panel extracted from the proxy extension. `showInlinePanel(ctx, title, lines: string[])` renders a flat scrollable inline prompt-area list with Esc/Enter/q close. All visual elements (usage bar, category bars) must be pre-rendered to `string[]` before being passed in; it is not a structured-component API. If richer layout is needed, a bespoke `ctx.ui.custom` component is required instead — pick one, don't treat them as interchangeable.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` & `.../core/session-manager.d.ts` — Source of truth for the real APIs (`getContextUsage`, `getSystemPrompt`, `hasUI`, `ReadonlySessionManager`, the `SessionEntry` union). Reconcile any further design against these before coding.
- `tests/context.test.mjs` — Proposed focused tests for report building, unknown usage handling, and no-history behavior.
- `README.md` — User-facing command documentation, including the no-history guarantee and estimate caveat.
- `package.json` — Existing package manifest already includes `extensions/`; validation should confirm no new package resource list is needed.

### Gotchas

- `ctx.getContextUsage()` returns `ContextUsage | undefined`, and a present object can have `tokens: null` / `percent: null`. Handle all three states; never coerce a null/absent percent to `0%` because that falsely suggests an empty context. Test the `undefined` return distinctly (common on a fresh session).
- The canonical context window is `usage.contextWindow`. Use `ctx.model?.contextWindow` only as a fallback when `getContextUsage()` is `undefined`; do not read both and risk a mismatched denominator on the headline percentage.
- There is no `getSystemPromptOptions()`. The cached `before_agent_start` `systemPromptOptions` payload can include full context-file contents and skill text — treat it as sensitive: show names and sizes, not full content. When the cache is empty, `getSystemPrompt()` returns only an opaque blob you can size but not itemize.
- `ctx.sessionManager.getBranch()` is the relevant path for the active conversation tree. `getEntries()` would include abandoned branches and inflate the explanation.
- The report builder should not read any referenced files from disk; it should only classify data already available on the command context.
- Tool outputs may already be truncated before they entered context; report what is present in session/context, not the full temp-file content.
- If category estimates exceed the canonical total, do not hide it. Show a short caveat instead of pretending exact reconciliation.
- Command output should not call `ctx.waitForIdle()` by default; a quick current snapshot is more useful than blocking unexpectedly. Detect activity with `ctx.isIdle()` and, when not idle, label the report as a live snapshot that may change after the turn finishes (reading a branch mid-append can give inconsistent sums).
- Keep the default contributor list capped, such as top 5, with truncation rather than unbounded rendering. Longer detail modes can be deferred until v2.

### Pseudo-code / Sketches

```text
registerContext(pi):
  pi.registerCommand("context", {
    description: "Show current context usage without adding to message history",
    handler: async (_args, ctx) => {
      const report = buildContextReport({
        usage: ctx.getContextUsage(),            // ContextUsage | undefined
        model: ctx.model,                         // contextWindow fallback only
        system: cachedSystemPromptOptions ?? ctx.getSystemPrompt(),
        branch: ctx.sessionManager.getBranch(),
        isIdle: ctx.isIdle(),
      })

      if (ctx.hasUI):
        await showContextPanel(ctx, report)       // showInlinePanel(ctx, title, string[])
      else:
        console.log(formatPlainReport(report))
    },
  })
```

```text
buildContextReport(input):
  canonical = input.usage ?? fallbackFromModel(input.model)
  items = []

  add system/static items from systemPromptOptions
  add active branch message items grouped by role/type
  add compaction and branch summary entries

  categories = groupByCategory(items)
  totals = reconcile(categories, canonical.tokens)
  status = threshold(canonical.percent)
  topContributors = sort(items by estimatedTokens desc).slice(0, 5)

  return { canonical, categories, totals, status, topContributors, notes }
```

## Deliverables

### Deliverable 1. Command skeleton and no-history contract

Create the `/context` extension command as a small core module and wire it into the existing core extension bundle. This deliverable proves the command can run without creating session entries, sending user/assistant messages, or triggering an LLM turn.

- [x] Add `extensions/core/extensions/context.ts` with `registerContext(pi)` and concise TSDoc for the exported registration function.
- [x] Import and call `registerContext(pi)` from `extensions/core/index.ts`.
- [x] Implement a minimal command handler that reads `ctx.getContextUsage()` (handling the `undefined` return) and renders command-only output via the `ctx.hasUI` true/false paths.
- [x] Add a focused test that invokes the handler with a fake command context, verifies `getBranch().length` is unchanged before/after, and asserts none of the reachable mutating actions are called — inject a context whose `sendMessage`/`fork`/`navigateTree`/`newSession`/`switchSession`/`compact`/`appendCustomMessageEntry` throw if invoked.

### Deliverable 2. Report model and estimator

Build a deterministic report model that separates the canonical usage number from estimated category makeup. This deliverable makes the command useful beyond a single percentage while avoiding false precision.

- [x] Define internal report types for canonical usage, status, categories, top contributors, and notes.
- [x] Subscribe to `before_agent_start` and cache its `systemPromptOptions` payload; implement helpers that extract safe display labels from the cache (falling back to a single sized `getSystemPrompt()` blob when the cache is empty) without exposing full sensitive content.
- [x] Implement entry-level branch classification using `ctx.sessionManager.getBranch()` for the real `SessionEntry` union (`message`, `compaction`, `branch_summary`, `custom_message`, ignored others) per the Plan Details mapping.
- [x] Implement block-level classification that descends into `message` entries' `AgentMessage` content blocks to separate conversation text/thinking/tool-call blocks from tool-result blocks (the "tool results" bucket).
- [x] Implement the token estimator using Pi's exported `estimateTokens`/`serializeConversation` and the reconciliation logic with an `unknown/overhead` bucket.
- [x] Add tests for `getContextUsage() === undefined`, present-with-`tokens: null` (post-compaction), known usage, estimates greater than canonical usage, high unknown/overhead, active-branch-only classification, entry-to-bucket mapping, and block-to-bucket mapping for tool results.
- [x] Add a bounded large-branch fixture or smoke test that proves report generation does not read files from disk and caps top contributors.

### Deliverable 3. Fast visual UX

Render the report so users can judge context pressure at a glance. The default TUI experience should be compact, readable, and honest about estimate quality.

- [x] Implement a text report formatter with a fixed-width usage bar, threshold status, estimated category bars, estimate quality label, top contributors, and caveat notes.
- [x] Pre-render all visual elements (usage bar, category bars) to `string[]` and pass them to `showInlinePanel(ctx, title, lines)` for the `ctx.hasUI` path, keeping close keys consistent with existing panels.
- [ ] Verify the panel interaction contract manually or with a focused harness: opens, scrolls/truncates overflow, dismisses via Esc/Enter/q, and returns control to the editor.
- [x] Add the `hasUI === false` fallback: `console.log(formatPlainReport)` plain-text output.
- [x] Ensure the panel avoids rendering full context file contents, prompt text, or tool output bodies in the contributor list.

### Deliverable 4. Documentation and validation

Document how users should interpret `/context`, including what is exact, what is estimated, and why the output does not enter message history. Validate the package after the extension is wired.

- [x] Update `README.md` with `/context` usage, sample output, no-history guarantee, and estimate caveat.
- [x] Run `npm test` or at least the new focused context tests plus any touched extension tests.
- [x] Run `npm run validate:json`.
- [x] Run `npm run pack:dry-run` to confirm package contents remain valid.

## Issues

- **2026-06-07 — agent:pi** — Refactored the shared read-only panel out of `extensions/core/extensions/proxy/audit-panel.ts` into `extensions/core/lib/ui/panel.ts`. This removes cross-extension imports from `/context` and also updates existing settings, permissions, subagents, and proxy commands to use the common UI helper.
- **2026-06-07 — agent:pi** — Follow-up UX change: `/context` now uses the reusable inline panel instead of an overlay popup so the report appears in the prompt area.
- **2026-06-07 — agent:pi** — Implementation completed with one verification gap left open: the reusable panel path is wired and covered through formatter/headless tests, but interactive panel open/scroll/dismiss behavior was not manually exercised in a live TUI during this pass.
- **2026-06-07 — agent:claude** — Revised the default-panel UX mock: added the required `quality` label (was missing despite the spec), re-balanced sample numbers to a representative post-tokenizer split (`unknown/overhead` 31% → 6%, since estimates now reconcile via Pi's tokenizer), unified percent precision (dropped the `64.2%`/`64%` mismatch), and fixed the box-border alignment.
- **2026-06-07 — agent:claude (adversarial review)** — Plan re-reviewed by 2 adversarial sub-agents, both of which verified against the installed Pi SDK. 11 findings; all merged. Most significant: three load-bearing APIs in the prior draft did not exist — `getSystemPromptOptions()` (no such method; only `getSystemPrompt(): string`), `ctx.mode` (only `hasUI: boolean`), and top-level `toolResult`/`bashExecution` entry types (tool data is nested in `message` content blocks). Also corrected: `getContextUsage()` returns `ContextUsage | undefined`; Pi already exports a tokenizer; the no-history test must target the real (read-only) mutation surface; `showPanel` takes pre-rendered `string[]`. User decisions: system-prompt itemization via cached `before_agent_start` payload; per-category estimates via Pi's exported `estimateTokens`/`serializeConversation`.
- **2026-06-07 — agent:claude** — Resolved (was open in pi's review): finer transport detection beyond `hasUI` is out of scope for v1 — there is no `ctx.mode` to distinguish rpc/json/print, so all non-UI modes share the `console.log` path.
- **2026-06-07 — agent:pi (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 11 findings; 9 merged into plan. Most significant changes: explicit mode matrix, classification mapping, estimate-quality handling, large-session performance risk, and TUI interaction verification.
- **2026-06-07 — agent:pi** — Resolved: the TUI default is inline (`showInlinePanel`) rather than overlay, so `/context` appears in the prompt area.
- **2026-06-07 — agent:pi** — Open product question: whether `/context` should accept detail modes such as `/context full` or stay argument-free for v1. Current plan keeps v1 argument-free unless implementation proves the compact panel too crowded.
