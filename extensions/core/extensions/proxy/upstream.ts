import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

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
 * @param req Rebuilt upstream request (URL, method, headers, optional body).
 * @returns The upstream response stream, resolved on its first byte.
 */
export function requestUpstream(req: UpstreamRequest): Promise<IncomingMessage> {
  const target = new URL(req.url);
  const isHttps = target.protocol === "https:";
  const proxyUrl = getProxyForUrl(req.url) || undefined;
  const agent = selectAgent(isHttps, proxyUrl);
  const send = isHttps ? httpsRequest : httpRequest;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const outbound = send(
      req.url,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host },
        ...(agent ? { agent } : {}),
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
 * @returns A proxy agent when a host proxy applies, or undefined to use Node's default agent.
 */
function selectAgent(
  isHttps: boolean,
  proxyUrl: string | undefined,
): HttpProxyAgent<string> | HttpsProxyAgent<string> | undefined {
  if (proxyUrl) {
    return isHttps ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
  }
  return undefined;
}
