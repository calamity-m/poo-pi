import type { Server } from "node:http";

import type { ClientTlsProvider } from "../tls/index.ts";

/** Options used to wire proxy support to core TLS without reading TLS at registration time. */
export interface RegisterProxyOptions {
  /**
   * Lazy-read TLS provider. The proxy reads it per request and attaches the client
   * certificate when one is loaded; it never blocks traffic when none is (see {@link resolveProxyClientTls}).
   */
  tlsProvider: ClientTlsProvider;
}

/** A single proxied provider: its name, the captured upstream base URL, and the local route id it is served under. */
export interface ProxyRoute {
  /** Provider name as it appears in the model registry. */
  provider: string;
  /** Stable local route id; the server serves this provider under `/p/<routeId>`. */
  routeId: string;
  /** Original upstream base URL the route forwards to (may include a base path). */
  upstreamBaseUrl: string;
}

/** A provider that could not be routed through the proxy, with the reason for operator visibility. */
export interface UnproxiedProvider {
  /** Provider name that was skipped. */
  provider: string;
  /** Human-readable disqualification reason. */
  reason: string;
}

/** Redaction switch mode. `on` redacts sensitive headers (raw bodies kept); `off` logs everything raw. */
export type RedactionMode = "on" | "off";

/** Request-side fields captured for an audited proxy request. */
export interface AuditRequest {
  /** HTTP method. */
  method: string;
  /** Inbound local proxy URL path (`/p/<routeId>/...`). */
  url: string;
  /** Resolved upstream URL the request was forwarded to. */
  upstreamUrl: string;
  /** Forwarded headers, with sensitive values redacted when the switch is `on`. */
  headers: Record<string, string>;
  /** Request body as text when it fits within the audit body cap. */
  body?: string;
  /** First captured bytes of a larger request body, decoded as UTF-8 text. */
  bodyHead?: string;
  /** Last captured bytes of a larger request body, decoded as UTF-8 text. */
  bodyTail?: string;
  /** Original request body size in bytes, when a body was captured. */
  bodyBytes?: number;
  /** Bytes omitted between `bodyHead` and `bodyTail` for a larger request body. */
  bodyOmittedBytes?: number;
  /** Whether the audited body was captured as head/tail from a larger payload. */
  bodyTruncated?: boolean;
}

/** Response-side metadata captured for an audited proxy request; the streamed body is never teed. */
export interface AuditResponse {
  /** Upstream HTTP status, when the request reached the upstream. */
  status?: number;
  /** Wall-clock duration from request receipt to response completion, in milliseconds. */
  durationMs: number;
  /** Upstream failure message (timeout, connection error, etc.), when the request did not complete. */
  error?: string;
}

/** One persisted audit record describing a single proxied request and its outcome. */
export interface AuditRecord {
  /** Zero-padded monotonic sequence id, also used in the per-request file name. */
  id: string;
  /** ISO timestamp of when the request was received. */
  timestamp: string;
  /** Provider the route belongs to. */
  provider: string;
  /** Model id parsed from the request body, when available. */
  model?: string;
  /** Captured request side. */
  request: AuditRequest;
  /** Captured response side. */
  response: AuditResponse;
}

/**
 * Mutable runtime state shared between the lifecycle hooks, the server request
 * handler, and the `/proxy` command. A single instance is created per
 * `registerProxy` call and threaded through the proxy modules.
 */
export interface ProxyState {
  /** The listening loopback server, or undefined before start / after stop. */
  server?: Server;
  /** Bound ephemeral port once the server is listening. */
  port?: number;
  /** Absolute audit directory (`<cwd>/.pi/proxy-audit`), set when the server starts. */
  auditDir?: string;
  /** Active routes keyed by route id. */
  routes: Map<string, ProxyRoute>;
  /** Providers skipped during re-registration, surfaced in status. */
  unproxied: UnproxiedProvider[];
  /** Message describing why the server failed to start, if it did. */
  startError?: string;
  /** Non-fatal re-registration warnings (e.g. the active model did not pick up the proxy baseUrl). */
  warnings: string[];
  /** Bounded ring of the most recent audit records for fast status/recent reads. */
  recent: AuditRecord[];
  /** Bounded ring of recent audit-write failures, surfaced in status. */
  writeErrors: string[];
  /** Monotonic counter feeding audit record ids, seeded from existing files at start. */
  auditSeq: number;
}

/** Create empty proxy runtime state. */
export function createProxyState(): ProxyState {
  return {
    routes: new Map(),
    unproxied: [],
    recent: [],
    writeErrors: [],
    warnings: [],
    auditSeq: 0,
  };
}
