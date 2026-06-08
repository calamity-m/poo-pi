#!/usr/bin/env node
// Smoke test for proxy route recovery across /reload.
//
// /reload can restart the ephemeral loopback proxy on a new port while the model
// registry still contains provider baseUrls pointing at the old proxy port. The
// route builder must unwrap those stale local proxy URLs back to the original
// upstream instead of capturing the dead proxy as the new upstream.

import { buildRoutes, localProxyPrefix } from "../extensions/core/extensions/proxy/routes.ts";

const existingRoutes = new Map([
  [
    "anthropic",
    {
      provider: "anthropic",
      routeId: "anthropic",
      upstreamBaseUrl: "https://api.anthropic.com",
    },
  ],
]);

const stalePort = 41001;
const currentPort = 41002;

const recovered = buildRoutes(
  [{ provider: "anthropic", id: "claude", baseUrl: `${localProxyPrefix(stalePort)}anthropic` }],
  currentPort,
  existingRoutes,
);

assert(
  recovered.unproxied.length === 0,
  `unexpected unproxied: ${JSON.stringify(recovered.unproxied)}`,
);
assert(
  recovered.routes.get("anthropic")?.upstreamBaseUrl === "https://api.anthropic.com",
  `stale proxy URL was not recovered: ${recovered.routes.get("anthropic")?.upstreamBaseUrl}`,
);

const unknown = buildRoutes(
  [{ provider: "unknown", id: "m", baseUrl: `${localProxyPrefix(stalePort)}missing` }],
  currentPort,
  existingRoutes,
);

assert(unknown.routes.size === 0, "unknown stale proxy route should not be routed");
assert(
  unknown.unproxied[0]?.reason === "already proxied to an unknown route",
  `unexpected unknown-route reason: ${unknown.unproxied[0]?.reason}`,
);

console.log("proxy reload recovery ok");

/** Throw when a smoke assertion fails. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
