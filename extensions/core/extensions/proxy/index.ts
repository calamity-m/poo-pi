import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerProxyAuditCommand } from "./command.ts";
import { applyProviderOverrides } from "./routes.ts";
import { startProxyServer, stopProxyServer } from "./server.ts";
import { createProxyState, type ProxyState, type RegisterProxyOptions } from "./types.ts";

export type { RegisterProxyOptions } from "./types.ts";
export { resolveProxyClientTls } from "./tls.ts";

const PROXY_MEMORY_KEY = "__pooPiCoreProxyState";

/**
 * Return the process-local proxy state, reused across Pi runtime reloads in the
 * same Node process. Persisting the route map lets re-registration recover
 * already-proxied base URLs across `/reload` and `/new` instead of
 * double-wrapping them into dead routes after the ephemeral server restarts.
 */
function getProxyState(): ProxyState {
  const scope = globalThis as typeof globalThis & { [PROXY_MEMORY_KEY]?: ProxyState };
  scope[PROXY_MEMORY_KEY] ??= createProxyState();
  return scope[PROXY_MEMORY_KEY]!;
}

/**
 * Register the provider reverse proxy: start the loopback server, re-register
 * providers through it, originate mTLS on the upstream leg when a client
 * certificate is loaded, audit each request, and expose the `/proxy-audit`
 * operator command.
 *
 * The server starts before any base-URL overrides are applied, and overrides
 * are skipped entirely when it fails to start so providers are never stranded
 * pointing at a dead `127.0.0.1`.
 */
export function registerProxy(pi: ExtensionAPI, options: RegisterProxyOptions): void {
  const state = getProxyState();
  const { tlsProvider } = options;

  const ensure = async (ctx: ExtensionContext): Promise<void> => {
    await startProxyServer(state, tlsProvider, ctx.cwd);
    await applyProviderOverrides(pi, ctx, state);
  };

  // Both fire the idempotent ensure path; re-applying recovers already-proxied routes.
  pi.on("session_start", (_event, ctx) => ensure(ctx));
  pi.on("before_agent_start", (_event, ctx) => ensure(ctx));
  pi.on("session_shutdown", () => stopProxyServer(state));

  registerProxyAuditCommand(pi, state);
}
