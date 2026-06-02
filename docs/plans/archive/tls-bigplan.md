# BIGPLAN: Core TLS client certificate loading

## Plan Overview

Implement the TLS portion of core so Pi can load a password-protected PFX/P12 client certificate as the first core capability during startup, hold it only in process memory, and make it available to other core extensions through a safe getter/provider API. The user experience is part of the feature: when no usable saved location exists, interactive runs should guide the user through choosing the certificate file and entering the password with a hidden input, then persist only the location for next time. Done means local test certificates exist, TLS resolves during `session_start`, the core consumers (proxy and websearch) read the provider lazily at use-time and fail closed when TLS is unavailable, and no LLM-callable command or tool can reveal certificate bytes or passwords.

## Risks

- **Secret material exposure** — PFX bytes, passphrases, and derived TLS objects must never be logged, persisted, included in tool results, or made reachable from an LLM-callable tool. Keep certificate access in module-private state, expose only a minimal in-process API, and audit command/tool/status output for metadata-only behavior.
- **Startup deadlock or unusable non-interactive mode** — Blocking startup on a TUI flow can hang print/JSON/RPC or headless runs. Gate interactive prompting on `ctx.hasUI`, provide a clear failure/status path when no UI is available, and add an explicit retry command for interactive correction without exposing secrets.
- **Persistence scope mismatch** — Confirmed: `ExtensionAPI` exposes only `appendEntry()` (session-scoped persistence) and no project-level config/storage API, so a saved cert path cannot be remembered across sessions via Pi. The plan must use a small project-local config file holding only non-secret path/source metadata. Concrete hazard: that file (or a stray status line) could be committed to git and leak the certificate path — add it to `.gitignore` and treat the path as potentially sensitive.
- **Lazy-read race / stale read** — Consumers read the provider lazily at use-time (chosen lifecycle), so the blocking-startup hazard is gone, but a consumer invoked before `session_start` resolves TLS would observe `unconfigured`. Mitigation: consumers must treat `getClientTls() === undefined` as fail-closed (not "proceed without mTLS"), the provider must expose a status the consumer can check, and a smoke check should prove a consumer reads loaded TLS after `session_start` and fails closed before it.
- **PFX/Node load incompatibility** — OpenSSL 3.x writes `.p12`/`.pfx` with PBES2/AES by default, but older defaults (or `-legacy`) use RC2/3DES that Node's `crypto`/`tls` may reject with `mac verify failure` or `unsupported`. If the fixture-generation script (Deliverable 1) produces a bundle Node cannot decrypt, every dependent smoke check in D2/D4/D5 fails. Mitigation: the Deliverable 1 smoke check (Node loads the generated PFX with the known password) must pass before any dependent deliverable starts, and the generation script must pin an algorithm Node accepts.
- **Undocumented security-sensitive flow** — TLS setup will include lifecycle ordering, custom TUI, secret handling, and future extension seams; if the code is under-documented, later changes can accidentally weaken guarantees. Require TSDoc on every function and targeted inline comments explaining why security/lifecycle choices exist.

## Plan Details

### Target behavior

TLS resolves client material through a **registry of cert sources**, each owning two orthogonal concerns the old single-resolver model conflated: _where the cert comes from_ and (separately) _where its passphrase comes from_. A source is selected by priority and contributes its own stage-2 chooser; passphrases are supplied by a pluggable `PassphraseProvider` so a future `pass`/keyring secret source slots into the same PFX load path without a new source. **This iteration implements exactly one source (`pfx-file`) and one passphrase provider (interactive hidden prompt)**; the registry and wizard are built to hold more (keyring, `pass`, PKCS#11) but are not populated.

Interactive setup is a **3-stage wizard**:

1. **Stage 1 — source picker.** `ctx.ui` select over registered sources, ordered by priority. **Auto-skipped when only one source is registered** (the case today), so there is no pointless single-option prompt.
2. **Stage 2 — target chooser, owned by the source.** The chosen source presents how to pick its concrete, non-secret target: PFX → a `.pfx`/`.p12` file picker; a keyring → a list of keyring entries; `pass` → an entry path. The result is a non-secret `SourceTarget` locator.
3. **Stage 3 — passphrase (only if required).** The source declares whether it needs a secret and pulls it through the `PassphraseProvider`. PFX → interactive hidden prompt; a future `pass`/keyring secret source → no prompt at all. Sources whose material needs no passphrase skip this stage.

Startup resolution order:

1. Read persisted non-secret config `{ sourceId, locator, label }`.
2. If it exists and the source's `validateTarget` passes (file readable / entry present), **skip stages 1 and 2** and go straight to stage 3.
3. Otherwise run the full wizard. Persist `{ sourceId, locator, label }` only after a successful load — never the passphrase.
4. If the user cancels or loading fails, mark TLS unavailable with a metadata-only error and do not continue silently.

The full wizard is **re-entrant** by two paths: (a) clearing persistence — deleting the project-local config file drops the fast path so the next startup runs the wizard cold; and (b) running the `/tls-setup` command at any time, which **forces stage 1 regardless of a valid persisted target**, re-resolves TLS in place, and overwrites the persisted `SourceTarget` on success. The command path is the supported way to switch source or fix a wrong target without manually editing files.

Non-interactive startup should not attempt hidden TUI prompts (gate on `ctx.hasUI === false`). It may still resolve fully when a persisted target validates _and_ the source's passphrase provider can supply the secret without UI (the future `pass`/keyring path). When a secret is required but only obtainable interactively, TLS fails closed with a status that tells the human to run `/tls-setup`, without serializing secret-bearing state.

### Public/internal API shape

Prefer a small module API from `extensions/core/extensions/tls.ts` rather than a registered Pi tool. Consumers import a getter or receive a provider object from core wiring. The returned object should be safe to use for outbound HTTPS/mTLS but not easy to stringify into secret material.

Sketch the model as:

```text
// Non-secret, persisted locator for a source's chosen target.
type SourceTarget = { sourceId: string; locator: string; label: string };

// A cert source owns its stage-2 chooser and its load. It never owns the
// passphrase mechanism — that is injected so secret sources stay orthogonal.
interface ClientTlsSource {
  id: string;          // "pfx-file" (future: "keyring", "pass", "pkcs11")
  label: string;       // stage-1 display name
  priority: number;    // stage-1 ordering / default selection
  needsPassphrase: boolean;
  chooseTarget(ctx): Promise<SourceTarget | undefined>;   // STAGE 2 (source-specific UI)
  validateTarget(ctx, target: SourceTarget): Promise<boolean>; // skip stage 2 on later startups
  load(ctx, target: SourceTarget, passphrase: PassphraseProvider): Promise<LoadResult>; // STAGE 3 + load
}

// STAGE 3 mechanism. Interactive prompt is the only implementation this iteration;
// `pass`/keyring secret providers slot in later without touching any source.
interface PassphraseProvider {
  canProvide(ctx): boolean;                 // interactive: ctx.hasUI; pass: `pass` on PATH
  getPassphrase(ctx): Promise<string>;      // used immediately, never retained
}

type ClientTlsState =
  | { status: "unconfigured" }
  | { status: "loaded"; sourceId: string; target: { locator: string; label: string };
      secureContext: SecureContext; metadata: {} }
  | { status: "error"; sourceId?: string; message: string };

interface ClientTlsProvider {
  getClientTls(): LoadedClientTls | undefined;
  getClientTlsStatus(): RedactedClientTlsStatus;
}
```

Keep raw cert bytes and passphrases inside the source's load call stack where possible. If Node requires retaining options for downstream use, prefer a `tls.SecureContext` or frozen agent/options wrapper over returning raw bytes/`passphrase` to consumers. If a consumer truly needs Node TLS options, expose a narrowly typed method whose implementation returns only values that are still necessary and document why.

**Return-type forward-compat boundary:** `secureContext: SecureContext` assumes exportable key material in process (file, PEM, keyring-export). A PKCS#11/HSM source cannot produce a `SecureContext` from bytes — the key stays on the token and is referenced via an OpenSSL engine. If hardware-backed keys are ever in scope, the consumer contract should return an opaque "attach to outbound connection" handle (e.g. a configured `https.Agent`) rather than a `SecureContext`. Left as an open question in Issues; not decided here.

### Critical Files

- `extensions/core/extensions/tls/index.ts` — TLS registration, source registry orchestration, `session_start` resolution, redacted status, and retry/setup command.
- `extensions/core/extensions/tls/types.ts` — Provider, source, target, passphrase, loaded TLS, and redacted status contracts.
- `extensions/core/extensions/tls/pfx-source.ts` — `pfx-file` source, PFX/P12 target chooser, passphrase validation, and `SecureContext` loading.
- `extensions/core/extensions/tls/tui.ts` — Hidden passphrase prompt and masked input component.
- `extensions/core/extensions/tls/persistence.ts` — Project-local non-secret `SourceTarget` persistence.
- `extensions/core/index.ts` — Currently calls the no-arg placeholders `registerTls(pi)`, `registerProxy(pi)`, `registerWebsearch(pi)`. Needs to capture the provider from `registerTls(pi)` and thread it into `registerProxy`/`registerWebsearch` (lazy reads — no awaiting at registration).
- `extensions/core/extensions/proxy/index.ts`, `extensions/core/extensions/websearch.ts` — No-arg placeholders that must take and consume the provider (Deliverable 6).
- `/home/calam/code/pi-shit/extensions/secret-input/index.ts` — Reference implementation for masked TUI input that avoids chat history and tool output.
- `package.json` — May need scripts for generating local cert fixtures and validating package contents.
- `test-fixtures/` or `fixtures/tls/` — Proposed location for generated local-only PFX/P12 files and generation script output; do not publish private keys unintentionally unless they are clearly test-only fixtures.

### Gotchas

- `ctx.ui` is available in event/command contexts, not during bare registration. Lifecycle is settled as **lazy consumer reads** (see Pseudo-code): registration stays synchronous and is not blocked on TLS; TLS resolves inside the `session_start` handler where `ctx.ui` exists; consumers read the provider at use-time. This sidesteps the await/`session_start` ordering contradiction.
- Confirmed in the installed Pi (`types.d.ts`): `ctx.hasUI` (boolean) exists for gating prompts, `ctx.ui.custom<T>()` exists and the `secret-input` reference masks input via a `render()` returning `"*"`, and `ctx.ui.setStatus(key, text)` exists for the status line. `ctx.ui.custom()` can implement hidden secret input; ordinary `ctx.ui.input()` is not acceptable for passwords.
- No project-level config/storage API exists on `ExtensionAPI` — only `appendEntry()` (session-scoped). Remembering the chosen source/target across sessions therefore requires a project-local config file, not Pi-managed state. Persist the whole `SourceTarget` (`{ sourceId, locator, label }`), not just a path.
- Stage 1 (source picker) must auto-skip when the registry holds a single source, or today's PFX-only build forces a one-option prompt. Stage 2 is owned by the source (file picker for PFX, entry list for a keyring) — do not hardcode a global file picker. Stage 3 is conditional on `source.needsPassphrase` and on whether the `PassphraseProvider` can supply non-interactively.
- Cert source and secret source are orthogonal: a future `pass`/keyring `PassphraseProvider` feeds the _existing_ `pfx-file` source. Resist folding secret origin into the source list (it causes a combinatorial `pfx+prompt`/`pfx+pass`/... explosion).
- OpenSSL 3.x default `.p12` encryption (PBES2/AES) vs legacy RC2/3DES: pin an algorithm Node can load and verify with the D1 smoke check before relying on the fixture (see PFX/Node load incompatibility risk).
- `pi.appendEntry()` state does not participate in LLM context, but it is session persistence. It is still the wrong place for passwords and may be the wrong scope for remembering certificate path.
- Status lines and notifications must avoid full paths if paths are considered sensitive in this environment; at minimum, never include PFX bytes, passphrase length, or decrypted certificate data.
- The PFX source's stage-2 chooser may need to be a custom file picker because the docs show `select()` and autocomplete, not a built-in file picker. Keep it simple: cwd/home navigation, filter to `.pfx`/`.p12`, manual path fallback as the guaranteed baseline.
- Documentation is heavily weighted for this extension. Every function should have TSDoc, exported types/interfaces should describe security constraints, and inline comments should explain non-obvious why decisions such as redaction, lazy-read lifecycle, memory retention, source/secret orthogonality, and source priority ordering.

### Pseudo-code / Sketches

```text
// Lazy-read model: registration is synchronous and not blocked on TLS.
// Consumers hold the provider and call getClientTls() at use-time, not
// at registration. TLS actually resolves later, inside session_start.
core(pi):
  tlsProvider = registerTls(pi)          // synchronous; returns provider immediately
  registerModels(pi)
  registerSubagents(pi)
  registerProxy(pi, { tlsProvider })     // proxy reads tlsProvider lazily on request
  registerPermissions(pi)
  registerWebsearch(pi, { tlsProvider }) // websearch reads tlsProvider lazily on request

registerTls(pi):
  state = { status: "unconfigured" }
  provider = { getClientTls, getClientTlsStatus }  // closes over `state`

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("core-tls", "tls: loading")
    state = await resolveClientTls(ctx, resolverRegistry)  // mutates closed-over state
    ctx.ui.setStatus("core-tls", redactedStatus(state))
  })

  pi.registerCommand("tls-setup", metadataOnlyRetryHandler)
  return provider

// Consumer contract: undefined / non-loaded TLS means FAIL CLOSED for websearch,
// never "proceed without the client cert".
// NOTE: the proxy consumer intentionally diverges — it attaches the cert when
// loaded and forwards without it otherwise (never blocks). See docs/plans/proxy-bigplan.md.
websearchRequest(tlsProvider, ...):
  tls = tlsProvider.getClientTls()
  if tls is undefined: fail closed with redacted status
  else: use tls.secureContext for the outbound mTLS connection

resolveClientTls(ctx, registry, config, { force = false } = {}):
  // /tls-setup passes force=true to skip the fast path and re-run the wizard from stage 1.
  // Fast path: persisted choice skips stages 1 + 2 (unless forced).
  saved = force ? none : config.read()           // { sourceId, locator, label } | none
  if saved:
    source = registry.byId(saved.sourceId)
    if source and await source.validateTarget(ctx, saved):
      return await loadWith(ctx, source, saved)  // stage 3 only

  // Cold path: full wizard.
  if not ctx.hasUI: return { status: "error", message: "tls: setup required (run /tls-setup)" }
  source = stage1_pickSource(ctx, registry)      // auto-skipped if registry has one source
  if not source: return { status: "unconfigured" }   // cancelled
  target = await source.chooseTarget(ctx)        // stage 2, source-owned UI
  if not target: return { status: "unconfigured" }   // cancelled
  result = await loadWith(ctx, source, target)
  if result.loaded: config.write(target)         // persist non-secret locator only
  return result

loadWith(ctx, source, target):
  // stage 3: source pulls the passphrase via the injected provider only if needed
  passphrase = source.needsPassphrase ? selectPassphraseProvider(ctx) : noneProvider
  return await source.load(ctx, target, passphrase)  // bytes + secret stay in this stack
```

## Deliverables

### Deliverable 1. Local TLS test fixtures

Create a repeatable way to generate local test certificates, including a password-protected PFX/P12 fixture that can be used manually and by smoke tests. The fixtures must be clearly marked test-only and generated by script so no one mistakes them for production secrets.

- [x] Choose a fixture directory and add it to package metadata intentionally, either included as test-only published examples or excluded from package publishing.
- [x] Add a script that uses OpenSSL to generate a local CA, client key/cert, and password-protected `.p12`/`.pfx` with a known test password.
- [x] Document how to regenerate fixtures and which files are safe test artifacts.
- [x] Add a smoke check that verifies Node can load the generated PFX/P12 with the known password.

### Deliverable 2. Safe TLS provider, source registry, and passphrase seam

Replace the placeholder in `extensions/core/extensions/tls.ts` with a minimal in-process provider API, a priority-ordered **source registry**, and a **`PassphraseProvider`** seam. This deliverable creates the extension points for future cert sources (keyring, PKCS#11) and secret sources (`pass`, keyring) while implementing only the `pfx-file` source and the interactive passphrase provider.

- [x] Define exported provider/status types with TSDoc explaining that secret material is not exposed to LLM-callable tools.
- [x] Define the `ClientTlsSource`, `PassphraseProvider`, and `SourceTarget` interfaces with TSDoc spelling out the source/secret orthogonality and the "passphrase used immediately, never retained" rule.
- [x] Define the `LoadedClientTls` and `RedactedClientTlsStatus` types referenced by the provider interface and reconcile them with `ClientTlsState` (the sketch references all three but only defines `ClientTlsState`).
- [x] Add TSDoc to every function in the TLS implementation, including non-exported source, passphrase-provider, persistence, and TUI helpers.
- [x] Implement module-private state for loaded TLS material and redacted status metadata.
- [x] Implement a source registry sorted by priority, holding exactly one source this iteration (`pfx-file`); the registry shape must accept additional sources without consumer changes.
- [x] Implement the `pfx-file` source's `load`, taking its passphrase through an injected `PassphraseProvider` rather than calling `ctx.ui` directly.
- [x] Implement the interactive `PassphraseProvider` (`canProvide = ctx.hasUI`); leave `pass`/keyring providers unimplemented but documented as the seam.
- [x] Ensure source/load errors redact file contents, passphrases, and decrypted certificate details.
- [x] Add a consumer-facing getter that returns usable TLS material without returning the passphrase or raw bytes unless Node API constraints force it and the rationale is documented.

### Deliverable 3. Staged interactive setup wizard

Build the 3-stage setup wizard: stage 1 source picker, stage 2 source-owned target chooser, stage 3 optional passphrase. The wizard must auto-skip stages that aren't needed (single source; persisted valid target; source needing no passphrase) so the PFX-only build today is a clean file-pick + password flow, while the structure already supports more sources. A human must be able to recover from cancellation or a wrong password via `/tls-setup`.

- [x] Implement the stage-1 source picker via `ctx.ui` select over the registry, ordered by priority, **auto-skipped when only one source is registered**.
- [x] Implement the `pfx-file` source's stage-2 chooser as a simple `.pfx`/`.p12` file picker (cwd/home navigation, extension filter), with a manual-path fallback as the guaranteed baseline and comments explaining navigation/filtering.
- [x] Vendor/adapt the `secret-input` reference (an out-of-repo absolute path) into the reusable hidden passphrase prompt backing the interactive `PassphraseProvider`, so the masked-input primitive is versioned in this repo.
- [x] Implement the project-local config file: path resolution, read, and write of the non-secret `SourceTarget` (`{ sourceId, locator, label }`), plus a `.gitignore` entry so it is not committed.
- [x] Persist only the `SourceTarget` after a successful load — never the passphrase.
- [x] On later startups, when the persisted target's source `validateTarget` passes, skip stages 1 and 2 and go straight to stage 3 (passphrase) if required.
- [x] Add a metadata-only `/tls-setup` command that forces the full wizard from stage 1 — bypassing the persisted-target fast path even when a valid target exists — then re-resolves TLS in place and overwrites the persisted `SourceTarget` on success.
- [x] Ensure the cold path also triggers naturally when persistence is absent: deleting the project-local config file makes the next startup run the wizard. (Falls out of the fast-path check; verify there is no stale in-memory cache that defeats it.)

### Deliverable 4. Startup ordering and non-interactive behavior

Resolve TLS inside `session_start` and expose it through the provider so consumers can read it lazily at use-time (chosen lifecycle: lazy consumer reads, not blocking startup). This includes handling non-interactive modes without hanging and making failures visible without leaking secrets.

- [x] Pass the provider from `registerTls(pi)` into the consumer registrations in `extensions/core/index.ts`, with comments documenting the lazy-read lifecycle and why TLS is not awaited at registration.
- [x] Resolve TLS inside the `session_start` handler (where `ctx.ui` exists) and mutate the provider's closed-over state so later reads see loaded material.
- [x] In non-interactive or no-UI contexts (`ctx.hasUI === false`), fail closed with a redacted status instead of prompting.
- [x] Set a concise status indicator such as `tls: loaded`, `tls: unconfigured`, or `tls: error` without secret-bearing details.
- [x] On non-interactive fail-closed, surface an actionable, redacted message telling the human to run `/tls-setup` interactively (not just a terse `tls: error`).
- [x] Add a smoke check proving a consumer reads loaded TLS after `session_start` resolves, and fails closed (undefined) before it.

### Deliverable 5. Security audit and validation

Verify the feature satisfies the security promises: no LLM-callable path can print secret material, no password is persisted, and logs/statuses are redacted. This deliverable should happen after the UX/provider pieces exist, not as a paper exercise.

- [x] Search command/tool registrations and confirm none return PFX bytes, passphrases, decrypted certs, or passphrase length.
- [x] Verify persisted state contains only non-secret source metadata, never password or certificate material.
- [ ] Add focused tests or smoke scripts for wrong password, missing file, cancellation, and successful load.
- [x] Run `npm run validate:json` and `npm run pack:dry-run` after package metadata/script changes.
- [x] Document accepted residual risks, especially any Node TLS API requirement that forces keeping raw options in memory.
- [x] Review the implementation for documentation completeness: every function has TSDoc, and inline comments explain security-sensitive or lifecycle-sensitive logic without restating obvious code.

### Deliverable 6. Consumer wiring (proxy and websearch)

Wire both core consumers to actually use the loaded client TLS, proving the provider is consumable end-to-end. Each consumer reads the provider lazily at request-time. **Websearch fails closed** when TLS is unavailable. **The proxy intentionally does not** — it attaches the cert opportunistically when loaded and forwards without it otherwise (never blocks traffic); see `docs/plans/proxy-bigplan.md` for that decision. This is the difference between "a provider exists" and "Pi can use a loaded client cert."

- [x] `registerProxy(pi, { tlsProvider })` accepts the provider and attaches `getClientTls()`'s `SecureContext` to its outbound HTTPS leg when a cert is loaded, forwarding without it otherwise (implemented by proxy-bigplan; the proxy does **not** fail closed).
- [ ] Update `registerWebsearch(pi, { tlsProvider })` to accept and store the provider, and apply the client TLS to its outbound requests.
- [x] Define and document the fail-closed contract: when `getClientTls()` returns `undefined`, the consumer aborts with a redacted status rather than connecting without the cert.
- [x] Add a smoke check that a consumer applies the loaded `SecureContext` after `session_start`, and fails closed before TLS resolves.

## Issues

- **2026-06-02 — agent:claude (proxy reconciliation)** — The proxy consumer is now implemented (see `docs/plans/proxy-bigplan.md`) and deliberately **does not fail closed**: it attaches the client cert when loaded and forwards without it otherwise, so a missing/expired cert or a throwing TLS provider degrades to no-client-TLS rather than blocking LLM traffic. The Overview, the consumer-contract pseudo-code, and Deliverable 6 are updated so the fail-closed contract now applies to **websearch only**; the websearch fail-closed task is unchanged.
- **2026-06-02 — agent:claude (implementation)** — Implemented D1-D4 and the available security/consumer smoke checks. Fingerprint exposure was dropped from the implementation and plan sketch, leaving no certificate fingerprint in redacted status until the open sensitivity question is resolved. Proxy/websearch currently have fail-closed TLS resolution helpers because the repo still has placeholder consumers with no outbound request implementation to attach a `SecureContext` to.
- **2026-06-02 — user + agent:claude (design)** — Committed to a multi-source architecture as a planned, first-class part of the design (not just a future hook). Setup is now a 3-stage wizard (source picker → source-owned target chooser → optional passphrase), backed by a `ClientTlsSource` registry and an orthogonal `PassphraseProvider` seam. **Implementation scope is unchanged**: only the `pfx-file` source and the interactive passphrase provider are built this iteration; keyring/`pass`/PKCS#11 are documented seams, not deliverables. Stage 1 auto-skips with a single source so the PFX-only build stays a plain file-pick + password flow. Reshaped Target behavior, API shape, Gotchas, Pseudo-code, and Deliverables 2 & 3.
- **2026-06-02 — agent:claude** — Open question (deferred): does PKCS#11/HSM (non-exportable hardware-backed keys) ever come into scope? If yes, the provider must return an opaque connect handle (e.g. configured `https.Agent`) instead of `secureContext: SecureContext`, since an HSM key cannot build a SecureContext from in-process bytes. Resolve before Deliverable 2 freezes the loaded-state return type.
- **2026-06-02 — agent:claude (adversarial review #2)** — Plan reviewed again by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope) against the live repo. ~10 findings; merged. Key changes: added Deliverable 6 (wire proxy + websearch to consume the provider), committed to a lazy-consumer-read lifecycle (resolving the `await`-vs-`session_start` contradiction), confirmed no project-level config API exists (cert path persists via a project-local config file), added the OpenSSL/Node PFX-encryption risk, defined the missing `LoadedClientTls`/`RedactedClientTlsStatus` types as a task, and required vendoring the external `secret-input` masking primitive into the repo.
- **2026-06-02 — agent:claude** — Open question (deferred): is a certificate fingerprint considered non-secret in this environment? The `ClientTlsState.metadata.fingerprint` field is exposed in redacted status, and no deliverable currently computes it. Confirm it is safe to surface (and add a compute task) or drop the field before Deliverable 2 ships the type. Paths are already treated as potentially sensitive, so fingerprint sensitivity is not a given.
- **2026-06-02 — agent:claude** — Added documentation as a first-class implementation requirement: every function should have TSDoc, and inline comments should explain security-sensitive or lifecycle-sensitive decisions.
- **2026-06-02 — agent:claude (adversarial review)** — Plan reviewed from Risks & Assumptions and Completeness & Scope perspectives. 4 findings; 4 merged into plan. Main changes: added non-interactive fail-closed behavior, clarified persistence-scope risk, made load-order verification explicit, and added security validation tasks.
- **2026-06-02 — agent:claude** — Persistence backend remains a design decision: session entries are available but likely wrong scope for a reusable saved certificate path; implementation should verify whether Pi has a project-level extension config API before choosing a small project-local config file.
