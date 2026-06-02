import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

import type { ProxyTlsOptions } from "./tls.ts";

/** A request to forward to a captured upstream. Headers and body are already rebuilt for the upstream. */
export interface UpstreamRequest {
  /** Absolute upstream URL, with the base path preserved and query merged. */
  url: string;
  /** HTTP method to use upstream. */
  method: string;
  /** Headers to send upstream; the caller has stripped loopback `host`/`connection`/`content-length`. */
  headers: OutgoingHttpHeaders;
  /** Fully-buffered request body, or undefined for bodyless methods. */
  body?: Buffer;
}

/**
 * Forward a single request to its upstream and resolve with the live response
 * stream for the caller to pipe through unbuffered (preserving SSE token streaming).
 *
 * The outbound path is chosen per request:
 * - if `proxy-from-env` returns a proxy for the URL (honoring `http(s)_proxy`/`no_proxy`),
 *   the request tunnels through it via an `http(s)-proxy-agent`;
 * - otherwise it connects directly.
 *
 * When `tlsOptions` is provided and the upstream is HTTPS, the client certificate's
 * secure context is attached to the **request options** rather than to the agent
 * constructor. This matters for the CONNECT-tunnel case: `https-proxy-agent` applies
 * its constructor options to the proxy hop, but carries the per-request TLS options
 * into the post-CONNECT `tls.connect` to the gateway — so the cert is presented on the
 * gateway handshake, not to the proxy. `servername` pins SNI/identity to the gateway
 * host (never the loopback the proxy listens on).
 *
 * @param req Rebuilt upstream request (URL, method, headers, optional body).
 * @param tlsOptions Client-TLS secure context to present, or undefined to forward without client TLS.
 * @returns The upstream response stream, resolved on its first byte.
 */
export function requestUpstream(
  req: UpstreamRequest,
  tlsOptions: ProxyTlsOptions | undefined,
): Promise<IncomingMessage> {
  const target = new URL(req.url);
  const isHttps = target.protocol === "https:";
  const proxyUrl = getProxyForUrl(req.url) || undefined;
  const useClientTls = isHttps && tlsOptions !== undefined;

  const agent = selectAgent(isHttps, proxyUrl, useClientTls);
  // Client TLS rides the request options so it reaches the gateway handshake on
  // both the direct and CONNECT-tunnel paths.
  const tlsRequestOptions = useClientTls
    ? { secureContext: tlsOptions!.secureContext, servername: target.hostname }
    : {};
  const send = isHttps ? httpsRequest : httpRequest;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const outbound = send(
      req.url,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host },
        ...(agent ? { agent } : {}),
        ...tlsRequestOptions,
      },
      resolve,
    );
    outbound.on("error", reject);
    if (req.body) outbound.write(req.body);
    outbound.end();
  });
}

/**
 * Select the outbound agent for an upstream request.
 *
 * @returns A proxy agent when a host proxy applies, a fresh `https.Agent` for a
 * direct HTTPS request carrying a client cert (so its socket is never pooled and
 * reused for a request without one), or undefined to use Node's default agent.
 */
function selectAgent(
  isHttps: boolean,
  proxyUrl: string | undefined,
  useClientTls: boolean,
): HttpProxyAgent<string> | HttpsProxyAgent<string> | HttpsAgent | undefined {
  if (proxyUrl) {
    return isHttps ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
  }
  return useClientTls ? new HttpsAgent() : undefined;
}
