import type { SecureContext } from "node:tls";

import type { ClientTlsProvider } from "../tls/index.ts";

/** Secure-context options attached to an HTTPS upstream connection when a client certificate is loaded. */
export interface ProxyTlsOptions {
  /** Node TLS secure context built from the loaded client certificate. */
  secureContext: SecureContext;
}

/**
 * Read the lazy TLS provider and return secure-context options when a client
 * certificate is loaded, or `undefined` otherwise.
 *
 * This is the proxy's "attach when loaded, never block" policy: unlike a
 * fail-closed consumer, any failure — no certificate, a provider that throws,
 * or a malformed/expired context — degrades to `undefined` so the upstream
 * request still proceeds without client TLS. It is read fresh per request and
 * never cached, so loading or rotating a certificate takes effect immediately.
 */
export function resolveProxyClientTls(tlsProvider: ClientTlsProvider): ProxyTlsOptions | undefined {
  try {
    const tls = tlsProvider.getClientTls();
    if (!tls?.secureContext) return undefined;
    return { secureContext: tls.secureContext };
  } catch {
    // Never let a TLS-provider fault break the request hot path; forward without client TLS.
    return undefined;
  }
}
