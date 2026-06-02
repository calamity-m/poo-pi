# BIGPLAN: Core provider reverse proxy (mTLS + audit)

## Plan Overview

Build the `proxy` core extension: a localhost reverse proxy that Pi's providers are re-registered through, so all LLM traffic passes through one place we control. The proxy exists to do two things on the upstream leg to the real provider/gateway: originate **mutual TLS** using the client certificate held by the existing `tls` core extension, and **audit** each request for operator debugging of provider issues and self-review of what the agent sent. It must also honor the host's `http_proxy`/`https_proxy`/`no_proxy` when reaching upstreams. Done means: provider calls route through `127.0.0.1`, reach their original upstream (directly or via the host proxy), present the client cert when one is loaded, and leave an auditable local record — without blocking traffic when no cert is loaded and without breaking response token streaming. A working reference prototype exists (reverse proxy + provider re-registration + proxy-env + request audit); mTLS origination is the main net-new work.

## Risks

- **`tls` provider on the request hot path** — The proxy calls `tlsProvider.getClientTls()` on every upstream request. If that throws, the `tls` extension is unloaded, or it returns a malformed/expired context, an unguarded call would crash _every_ LLM call, not just mTLS — turning the cert dependency into a single point of failure on all traffic. "Never block" must therefore cover provider errors, not only the no-cert case: any failure degrades to no-client-TLS and the request still proceeds. Mitigation: wrap the read in a guard, treat throw/undefined identically (forward without client TLS), and pin the provider's return/error contract (see Critical Files). Watch-for: a provider exception surfacing as a failed model call.
- **Audit writes blocking or failing the request** — Each request writes a per-request JSON (tmp+rename) and appends `index.jsonl`. If these are awaited before the response is forwarded, a slow/full/permission-denied disk delays or fails live traffic; and with retention deferred, the directory grows unbounded over a long high-traffic session. Mitigation: audit writes are best-effort and off the response-forwarding path (forward first, persist after/in parallel), failures are swallowed and surfaced in status, and `recent` reads the index by tail rather than loading it whole. Watch-for: first-byte latency tracking disk, or `/proxy-audit recent` slowing as the index grows.
- **mTLS + corporate proxy composition** — When both a client cert and an `http(s)_proxy` apply, the upstream connection must CONNECT-tunnel through the host proxy and _then_ perform the client-cert TLS handshake to the gateway. `HttpsProxyAgent` must be constructed with the cert/key (or a custom `connect`) so the client cert rides the tunneled TLS, not the proxy hop. If this composition is wrong, mTLS silently fails or the proxy hop sees the cert. Watch-for: gateway rejects handshake, or cert presented to the wrong peer. Also confirm `proxy-from-env`'s `getProxyForUrl` honors the host's `no_proxy` format used here — mis-evaluation routes a should-be-direct upstream through the corp proxy (or vice versa), changing which peer sees the cert. Prove with a smoke test against a local mTLS-requiring server reached both directly (a `no_proxy`-matched host) and through a local CONNECT proxy.
- **Silent provider coverage gaps** — Re-registration only works for providers whose models carry a real `baseUrl` in `modelRegistry`. Custom providers with a `streamSimple` handler that ignores `baseUrl`, providers exposing more than one upstream base URL, and OAuth providers that set `baseUrl` dynamically via `modifyModels` will not be proxied — so they get neither mTLS nor audit, silently. Mitigation: surface unproxied providers in `/proxy-audit status` (the reference already collects `unproxied`) and document the limitation.
- **Audit files are sensitive by design** — Request bodies (full prompts/messages) and, when redaction is switched off, auth headers/api keys are written to disk. This is accepted for operator use, but the files must be local-only: bind the server to `127.0.0.1` exclusively, write under a gitignored `.pi/proxy-audit/`, and default the redaction switch to redacting sensitive headers. Watch-for: server binding to `0.0.0.0`, or the audit dir missing from `.gitignore`.
- **Streaming integrity** — Provider responses are SSE token streams. The proxy must pipe the response through without buffering so token-by-token UX is preserved; audit captures response _metadata_ (status/duration/error), not the streamed body. Watch-for: any code path that awaits the full response before forwarding.
- **Re-registration idempotency** — Lifecycle fires `ensureProxyStarted`/`applyProviderOverrides` on both `session_start` and `before_agent_start`. Re-applying must detect already-proxied `baseUrl`s (a `127.0.0.1/p/...` URL) and not double-wrap them into a new route. The reference handles this via `localProxyRouteId`; preserve it.

## Plan Details

### Decided behavior

- **Architecture**: localhost reverse-proxy server, confirmed. Providers are re-registered through it via `pi.registerProvider(provider, { baseUrl })`; the server routes by path prefix `/p/:routeId` to the captured upstream.
- **mTLS scope**: _attach when loaded, never block_. When the `tls` provider has a loaded cert, present it on every HTTPS upstream (harmless if the server does not request one). When no cert is loaded, forward anyway. There is **no** per-provider enforcement and **no** fail-closed blocking — this deliberately diverges from the `tls` plan's consumer-fail-closed sketch (see Issues; the tls plan's "proxy fails closed" task should be reconciled).
- **Audit content**: _request-side only_, as the reference. Capture the request method/url/headers/body and response status/duration/error. Do not tee the response SSE stream; the model's returned tool calls are not separately captured this iteration.
- **Redaction**: a switch with two modes — (1) redact sensitive headers (`authorization`, `*api-key*`, `*token*`, `cookie`, …) but keep raw bodies [default], and (2) log everything raw including api keys. Operator-controlled; default is mode 1.

### Reference prototype

A complete working prototype of the proxy foundation + audit + proxy-env handling is available (provided as inspiration in the planning conversation). It already implements: ephemeral `127.0.0.1` server; `modelRegistry.getAll()` grouping into `(provider, upstreamBaseUrl)` routes; `registerProvider` baseURL override; `/p/:routeId` forwarding; `proxy-from-env` + `http(s)-proxy-agent` upstream; per-request JSON + `index.jsonl` audit with header redaction; `/proxy-audit [status|recent]` TUI; idempotent lifecycle on `session_start`/`before_agent_start`/`session_shutdown`. **It does not implement mTLS** — upstream uses plain `https.request` with no client cert. Treat the prototype as the starting shape for Deliverables 1, 3, and the command; Deliverable 2 (mTLS) is the net-new layer.

### Critical Files

- `extensions/core/extensions/proxy/index.ts` — Current scaffold: `registerProxy(pi, { tlsProvider })`, `RegisterProxyOptions`, `requireProxyClientTls`. Becomes the extension entry: lifecycle hooks, server start, provider re-registration, command registration. Note `requireProxyClientTls`'s fail-closed return is _not_ used to block given the "never block" decision — either repurpose it to "attach if present" or remove it.
- `extensions/core/extensions/proxy/audit.ts` — Currently empty. Home for audit record building, file writes (`.pi/proxy-audit/`), in-memory recent ring, and redaction switch.
- `extensions/core/extensions/tls/index.ts`, `tls/types.ts` — The `ClientTlsProvider` (lazy-read) the proxy reads at request time. **Pin the return contract before D2**: confirm whether `getClientTls()` yields a prebuilt `tls.SecureContext` or raw cert/key/ca material, since that changes how it threads into `HttpsProxyAgent` vs a direct `https.Agent`. Per the tls plan it is a `SecureContext`; verify against `tls/types.ts`.
- `extensions/core/index.ts` — Already wires `registerProxy(pi, { tlsProvider })`; no change expected beyond confirming order.
- `package.json` — Add real runtime deps `proxy-from-env`, `http-proxy-agent`, `https-proxy-agent` (not Pi peers); ensure they ship.
- `.gitignore` — Must exclude `.pi/proxy-audit/` (and the tls config file).

### Gotchas

- `ctx.modelRegistry.getAll()` / `.find(provider, id)` and `ctx.model` / `pi.setModel()` are the enumeration + active-model levers — there is no provider list on bare `ExtensionAPI`. After re-registration, the active model's `baseUrl` may need a `setModel` refresh (the reference does this).
- `ProviderConfig` has **no** agent/TLS hook — this is _why_ mTLS must happen in our own server's upstream request, not via `registerProvider`. The client cert is attached where the proxy makes the outbound call.
- The upstream agent choice is conditional: direct (`http`/`https.request`) when no host proxy applies for the URL, `http(s)-proxy-agent` when `getProxyForUrl` returns one. mTLS cert/key must be threaded into _whichever_ path is taken for an HTTPS upstream.
- **Host/SNI and path preservation:** the request must reach the gateway with `Host`/SNI = the gateway hostname (not `127.0.0.1`) and the upstream base path preserved. The reference already does this by stripping the inbound `host`/`connection`/`content-length` headers and rebuilding from the upstream URL (`buildUpstreamUrl` keeps the base path and merges query). Preserve that behavior — a leaked loopback `Host`/SNI breaks the gateway TLS handshake and looks like an mTLS bug.
- **Request is buffered, response is piped:** the inbound request body is fully read into memory before forwarding (needed to audit it) — acceptable, but add a max-body-size cap for what gets audited so large context/image payloads don't bloat audit files. The _response_ must be piped through unbuffered to preserve token streaming.
- Idempotent re-registration uses the `127.0.0.1/p/...` baseUrl as the "already proxied" sentinel; this must stay robust if another extension or OAuth `modifyModels` mutates baseUrl between `session_start` and `before_agent_start` (don't double-wrap proxy→proxy).
- Audit dir lives under `.pi/` alongside the tls config; keep `.pi/` conventions consistent and gitignored.
- Server binds `127.0.0.1:0` (ephemeral). Never bind a wildcard interface — the proxy forwards api keys.

### Pseudo-code / Sketches

```text
// Lifecycle (idempotent)
on session_start | before_agent_start (ctx):
  ensureProxyStarted(ctx)          // 127.0.0.1:0 server, mkdir .pi/proxy-audit
  applyProviderOverrides(pi, ctx)  // modelRegistry -> routes -> registerProvider(localhost)
on session_shutdown: stopProxy()

// Upstream request — mTLS added to the reference's requestUpstream()
requestUpstream(url, method, headers, body, tlsProvider):
  proxyUrl = getProxyForUrl(url)            // honors http(s)_proxy/no_proxy
  tls = tlsProvider.getClientTls()          // lazy read; may be undefined
  tlsOpts = tls ? { secureContext: tls.secureContext } : {}   // attach when loaded
  agent = proxyUrl ? proxyAgentWith(url, proxyUrl, tlsOpts)    // CONNECT then client-cert TLS
                   : (https ? new Agent(tlsOpts) : undefined)
  send request(url, { method, headers, agent, ...tlsOpts })   // never blocks on missing cert

// Audit (request-side only)
record = { request: { method, url, upstreamUrl, headers: maybeRedact(headers), body },
           response: { status, durationMs } | { error } }
write .pi/proxy-audit/requests/NNNNNN-provider-model.json  (atomic tmp+rename)
append .pi/proxy-audit/index.jsonl
```

## Deliverables

### Deliverable 1. Reverse-proxy foundation + provider re-registration

Stand up the localhost server and route Pi's providers through it, adapting the reference prototype. This is the foundation both other capabilities depend on. Success: with the extension loaded, a provider request is observably served by `127.0.0.1` and forwarded to its original upstream (directly or via the host proxy), and `/proxy-audit status` lists the active routes and any unproxied providers.

- [x] Adapt the reference's ephemeral `127.0.0.1` server, `ensureProxyStarted`, and `stopProxy` into `proxy/index.ts`, bound to localhost only.
- [x] Implement `applyProviderOverrides` using `ctx.modelRegistry.getAll()` → `(provider, upstreamBaseUrl)` routes → `pi.registerProvider(provider, { baseUrl: /p/<routeId> })`, with the idempotent already-proxied check.
- [x] Implement `/p/:routeId` request handling that rebuilds the upstream URL (path + query) and forwards via `proxy-from-env` + `http(s)-proxy-agent`, piping the response without buffering.
- [x] Wire lifecycle on `session_start`, `before_agent_start`, and `session_shutdown`; refresh the active model via `setModel` when its baseUrl was overridden. **Verify** the active model actually routes through the proxy after refresh (assert its resolved baseUrl is `127.0.0.1`), not just that routes are listed.
- [x] Ensure `applyProviderOverrides` runs only after the server is confirmed listening; if the server fails to start, skip the baseUrl overrides entirely (do not strand providers pointing at a dead `127.0.0.1`) and surface the failure in status.
- [x] Define explicit disqualification criteria for proxying (more than one upstream baseUrl for a provider, non-http baseUrl, custom `streamSimple` provider that ignores baseUrl, OAuth provider with dynamic `modifyModels` baseUrl) and collect/expose the resulting `unproxied` list in status.

### Deliverable 2. mTLS origination on the upstream leg

Layer the client certificate onto the upstream connection — the net-new work the reference lacks. Read the lazy `tls` provider at request time; when a cert is loaded, attach its `SecureContext` to the HTTPS upstream, composed correctly with the host proxy tunnel; when absent, forward unchanged. Success: a smoke test against a local mTLS-requiring server (reached both directly and through a local CONNECT proxy) shows the client cert presented when loaded, and plain forwarding when not.

- [x] Read `tlsProvider.getClientTls()` at request time (lazy, never cached across requests) inside a guard, and build TLS options only when a usable cert is present.
- [x] Attach the `SecureContext` to the direct-HTTPS path and to the `HttpsProxyAgent` path so the cert is presented on the gateway TLS handshake, not the proxy hop.
- [x] Confirm "never block" covers both cases: no cert loaded **and** a provider error (throw/undefined/expired) both degrade to forwarding without client TLS; audit still records the request.
- [x] Add a smoke test: local server requiring a client cert, reached directly and via a local CONNECT proxy, asserting handshake success with cert and graceful forward without. Include a streaming assertion over the proxy-agent + mTLS path so buffering/first-token regressions surface where mTLS users actually are.
- [x] Reconcile `requireProxyClientTls`: repurpose to "attach if present" or remove it, since the proxy does not fail closed.

### Deliverable 3. Audit capture, storage, and redaction switch

Persist an operator-facing record of each proxied request. Adapt the reference's per-request JSON + `index.jsonl` + in-memory recent ring, under a gitignored `.pi/proxy-audit/`. Add the two-mode redaction switch. Success: a proxied request produces an audit file and an `index.jsonl` line with request body + response status/duration; flipping the redaction switch changes whether sensitive headers are written raw.

- [x] Implement audit record building (request method/url/upstreamUrl/headers/body, response status/duration/error) in `audit.ts`, with a max-body-size cap so large context/image payloads are truncated rather than written whole.
- [x] Write per-request JSON atomically (tmp + rename) under `.pi/proxy-audit/requests/`, append `index.jsonl`, keep a bounded in-memory recent list. Writes are best-effort and **off the response-forwarding path** — forward the response first, persist after; swallow write errors and surface them in status.
- [x] Implement the redaction switch concretely: a persisted mode in `.pi/proxy-audit` config read **per request** (so a flip takes effect live), toggled by a `/proxy-audit redact <on|off>` subcommand. `on` (default) redacts sensitive headers and keeps raw bodies; `off` logs everything raw including api keys.
- [x] Add `.pi/proxy-audit/` to `.gitignore`.
- [x] Capture upstream failures (timeouts, non-2xx, connection errors) as audit records with the error, and surface them in status as recent errors.
- [x] Make `/proxy-audit recent` read the index by tail rather than loading the whole `index.jsonl`, so it stays fast as the log grows (retention/rotation itself remains deferred — see Issues).

### Deliverable 4. Operator command and packaging

Expose the operator view and ship the new dependencies. Success: `/proxy-audit status` and `/proxy-audit recent` render (TUI when `hasUI`, notify otherwise); `npm run validate:json` and `npm run pack:dry-run` pass with the added deps; the tls plan's stale "proxy fails closed" expectation is reconciled.

- [x] Implement `/proxy-audit [status|recent|redact <on|off>]` with the reference's TUI panel, falling back to `ctx.ui.notify` when `!ctx.hasUI`.
- [x] `status` shows server state/port, routes, unproxied providers, and recent errors; `recent` lists audited requests.
- [x] Add `proxy-from-env`, `http-proxy-agent`, `https-proxy-agent` to `package.json` dependencies and confirm they are packaged.
- [x] Run `npm run validate:json` and `npm run pack:dry-run`.
- [x] Update `docs/plans/tls-bigplan.md` to note the proxy attaches the cert opportunistically and does not fail closed (reconcile the consumer-fail-closed task).

## Issues

- **2026-06-02 — agent:claude (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). ~15 findings; merged. Most significant: the `tls` provider was an unguarded single point of failure on the request hot path (now a risk + never-block-covers-provider-errors task), and audit writes were on the response-forwarding path (now best-effort/off-path + bounded `recent` read). Also added Host/SNI+path-preservation and request-buffered/response-piped gotchas (both already handled by the reference, now locked), unproxied-detection criteria, server-start-before-overrides ordering, `no_proxy` verification, a concrete redaction switch (`/proxy-audit redact`, per-request read), a max-audit-body cap, and pinning the `ClientTlsProvider` return type before D2.
- **2026-06-02 — agent:claude** — Discovery (resolve in D1): confirm whether/when `pi.setModel` is required to make the _active_ model pick up the overridden `127.0.0.1` baseUrl. If `setModel` does not refresh the resolved baseUrl, the currently-active model silently bypasses the proxy (no mTLS, no audit) while others route correctly. The D1 verification task covers asserting this.
- **2026-06-02 — user + agent:claude (grill)** — Pre-implementation grill completed. Decisions: reverse-proxy architecture (confirmed, with a working reference prototype); mTLS = attach-when-loaded, never block (diverges from the tls plan's fail-closed consumer model — flagged for reconciliation in D4); audit = request-side only (no SSE teeing of returned tool calls); redaction = switchable between "redact sensitive headers / raw bodies" (default) and "log everything raw". Scope: one plan, proxy foundation + mTLS + audit.
- **2026-06-02 — agent:claude** — Cross-plan note: `tls-bigplan.md` Deliverable 6 / Overview describe consumers (incl. proxy) that "fail closed when TLS is unavailable". This proxy intentionally does not block. D4 must update the tls plan so the two documents agree.
- **2026-06-02 — agent:claude** — Deferred: audit file growth/retention (no rotation this iteration); providers that ignore `model.baseUrl` or expose multiple upstreams are not proxied (accepted limitation, surfaced in status); exact `HttpsProxyAgent` construction for CONNECT-then-client-cert-TLS to be settled during D2 implementation.
- **2026-06-02 — agent:claude (implementation)** — Implemented D1–D4. Code is split into focused modules under `extensions/core/extensions/proxy/`: `types.ts` (shared state/types), `tls.ts` (`resolveProxyClientTls`, attach-if-present), `upstream.ts` (`requestUpstream` agent selection + mTLS threading + proxy-env), `routes.ts` (route building + disqualification + `applyProviderOverrides`/active-model refresh), `server.ts` (loopback server + request handler), `audit.ts` (record building, atomic storage, redaction switch, tail read), `command.ts` + `audit-panel.ts` (`/proxy-audit` + TUI), and `index.ts` (lifecycle wiring, process-global state across `/reload`). **CONNECT composition resolved:** `https-proxy-agent` constructor options apply to the proxy hop, so the client `secureContext` (+`servername`) is threaded via the _request_ options instead, which `https-proxy-agent` carries into the post-CONNECT `tls.connect` to the gateway. `requireProxyClientTls` was repurposed to `resolveProxyClientTls` (never fails closed). Verified by `npm run smoke:proxy-mtls` (direct + via local CONNECT proxy, with cert and without, plus a streaming assertion) and `npm run smoke:proxy-audit` (routing, audit file/index, body capture, redaction flip). `validate:json`, `lint`, `format:check`, and `pack:dry-run` pass; deps `proxy-from-env`/`http-proxy-agent`/`https-proxy-agent` added and packaged.
