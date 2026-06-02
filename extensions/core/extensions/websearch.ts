import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ClientTlsProvider, LoadedClientTls } from "./tls/index.ts";

/** Options used to wire websearch support to core TLS without reading TLS at registration time. */
export interface RegisterWebsearchOptions {
  /** Lazy-read TLS provider; websearch requests must fail closed when it has no loaded certificate. */
  tlsProvider: ClientTlsProvider;
}

/** Result of resolving TLS for a websearch request. */
export type WebsearchTlsResolution =
  | { ok: true; tls: LoadedClientTls }
  | { ok: false; message: string };

/** Register TLS-backed web search support and retain the lazy TLS provider for request-time reads. */
export function registerWebsearch(_pi: ExtensionAPI, options: RegisterWebsearchOptions) {
  void options;
}

/** Resolve TLS for an outbound websearch request, failing closed when no client certificate is loaded. */
export function requireWebsearchClientTls(tlsProvider: ClientTlsProvider): WebsearchTlsResolution {
  const tls = tlsProvider.getClientTls();
  if (!tls) return { ok: false, message: tlsProvider.getClientTlsStatus().message };
  return { ok: true, tls };
}
