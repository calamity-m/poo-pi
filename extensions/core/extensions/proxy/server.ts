import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";

import type { ClientTlsProvider } from "../tls/index.ts";
import {
  buildAuditRecord,
  describeError,
  ensureAuditStore,
  nextAuditId,
  persistAuditRecord,
  readRedactionMode,
} from "./audit.ts";
import { resolveProxyClientTls } from "./tls.ts";
import type { AuditResponse, ProxyState } from "./types.ts";
import { requestUpstream } from "./upstream.ts";

/** Hop-by-hop and loopback-specific headers stripped before forwarding so SNI/Host target the gateway. */
const STRIPPED_HEADERS = [
  "host",
  "connection",
  "content-length",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
];

/**
 * Start the ephemeral loopback proxy server, binding `127.0.0.1:0` exclusively
 * (never a wildcard interface — the proxy forwards api keys). Idempotent: a
 * no-op when already started. On listen failure, records `state.startError` and
 * leaves `state.port` unset so callers skip base-URL overrides.
 *
 * @param state Shared proxy runtime state, populated with the server, port, and audit dir.
 * @param tlsProvider Lazy TLS provider read per request for client-cert origination.
 * @param cwd Working directory under which the audit store lives.
 */
export async function startProxyServer(
  state: ProxyState,
  tlsProvider: ClientTlsProvider,
  cwd: string,
): Promise<void> {
  if (state.server) return;
  try {
    const store = await ensureAuditStore(cwd);
    state.auditDir = store.dir;
    state.auditSeq = store.seq;
  } catch (error) {
    state.writeErrors.push(`audit store init failed: ${describeError(error)}`);
  }
  await listen(state, tlsProvider);
}

/** Stop the proxy server and clear its bound state. */
export async function stopProxyServer(state: ProxyState): Promise<void> {
  const server = state.server;
  if (!server) return;
  state.server = undefined;
  state.port = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Create and bind the server, resolving once it is listening or its bind has failed. */
function listen(state: ProxyState, tlsProvider: ClientTlsProvider): Promise<void> {
  return new Promise<void>((resolve) => {
    const server = createServer((req, res) => {
      void handleRequest(state, tlsProvider, req, res);
    });
    server.once("error", (error) => {
      state.startError = describeError(error);
      resolve();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      state.server = server;
      state.port = address && typeof address === "object" ? address.port : undefined;
      state.startError = undefined;
      resolve();
    });
  });
}

/**
 * Handle one inbound proxy request: resolve its route, buffer the body, forward
 * it upstream with client TLS attached when loaded, and pipe the response back
 * unbuffered. Audit persistence runs after the response is forwarded, never on
 * its critical path.
 */
async function handleRequest(
  state: ProxyState,
  tlsProvider: ClientTlsProvider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const start = Date.now();
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = /^\/p\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  const route = match ? state.routes.get(match[1]) : undefined;
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("proxy: unknown route");
    return;
  }

  const upstreamUrl = `${route.upstreamBaseUrl}${match![2] ?? ""}${parsed.search}`;
  const headers = rebuildHeaders(req.headers);
  const body = await readBody(req);
  const tlsOptions = resolveProxyClientTls(tlsProvider);
  const id = nextAuditId(state);

  const finish = (response: AuditResponse) =>
    void recordRequest(state, {
      id,
      provider: route.provider,
      method: req.method ?? "GET",
      url: parsed.pathname + parsed.search,
      upstreamUrl,
      headers,
      body,
      response,
    });

  try {
    const upstream = await requestUpstream(
      { url: upstreamUrl, method: req.method ?? "GET", headers, body },
      tlsOptions,
    );
    res.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(res);
    upstream.once("end", () =>
      finish({ status: upstream.statusCode, durationMs: Date.now() - start }),
    );
    upstream.once("error", (error) =>
      finish({ error: describeError(error), durationMs: Date.now() - start }),
    );
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy: upstream error");
    }
    finish({ error: describeError(error), durationMs: Date.now() - start });
  }
}

/** Inputs the handler hands to audit persistence after forwarding the response. */
interface RecordInput {
  id: string;
  provider: string;
  method: string;
  url: string;
  upstreamUrl: string;
  headers: OutgoingHttpHeaders;
  body?: Buffer;
  response: AuditResponse;
}

/** Read the live redaction mode, build the record, and persist it best-effort. */
async function recordRequest(state: ProxyState, input: RecordInput): Promise<void> {
  try {
    const mode = state.auditDir ? await readRedactionMode(state.auditDir) : "on";
    await persistAuditRecord(state, buildAuditRecord({ ...input, mode }));
  } catch {
    // Audit must never disturb live traffic; persistence already swallows its own errors.
  }
}

/** Copy inbound headers, dropping hop-by-hop and loopback headers so the gateway sees correct Host/SNI. */
function rebuildHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...incoming };
  for (const name of STRIPPED_HEADERS) delete out[name];
  return out;
}

/** Fully buffer the request body so it can be both forwarded and audited. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}
