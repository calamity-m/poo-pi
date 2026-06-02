import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ClientTlsProvider, LoadedClientTls } from "../tls/index.ts";

/** Options used to wire proxy support to core TLS without reading TLS at registration time. */
export interface RegisterProxyOptions {
  /** Lazy-read TLS provider; proxy requests must fail closed when it has no loaded certificate. */
  tlsProvider: ClientTlsProvider;
}

/** Result of resolving TLS for a proxy request. */
export type ProxyTlsResolution =
  | { ok: true; tls: LoadedClientTls }
  | { ok: false; message: string };

/** Register provider reverse proxy support and retain the lazy TLS provider for request-time reads. */
export function registerProxy(_pi: ExtensionAPI, options: RegisterProxyOptions) {
  void options;
}

/** Resolve TLS for an outbound proxy request, failing closed when no client certificate is loaded. */
export function requireProxyClientTls(tlsProvider: ClientTlsProvider): ProxyTlsResolution {
  const tls = tlsProvider.getClientTls();
  if (!tls) return { ok: false, message: tlsProvider.getClientTlsStatus().message };
  return { ok: true, tls };
}
