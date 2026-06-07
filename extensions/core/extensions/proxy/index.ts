import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerProxyAuditCommand } from "./command.ts";
import { applyProviderOverrides } from "./routes.ts";
import { startProxyServer, stopProxyServer } from "./server.ts";
import { createProxyState, type ProxyState, type RegisterProxyOptions } from "./types.ts";

export type { RegisterProxyOptions } from "./types.ts";
export { resolveProxyClientTls } from "./tls.ts";

/** On-demand proxy readiness hook shared with nested-session callers. */
export interface ProxyReadinessHandle {
  /** Ensure the proxy server is listening and provider overrides are applied for the current context. */
  ensure(ctx: ExtensionContext): Promise<void>;
  /** Return whether the proxy server currently has a listening loopback route table. */
  isActive(): boolean;
  /** Return whether a provider currently has a proxy route. */
  isProviderProxied(provider: string): boolean;
  /** Compact status label for footer display. */
  statusLabel(): string;
}

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
export function registerProxy(
  pi: ExtensionAPI,
  options: RegisterProxyOptions,
): ProxyReadinessHandle {
  const state = getProxyState();
  const { tlsProvider } = options;

  const ensure = async (ctx: ExtensionContext): Promise<void> => {
    await startProxyServer(state, tlsProvider, ctx.cwd);
    await applyProviderOverrides(pi, ctx, state);
    ctx.ui.setStatus("proxy", formatProxyStatusLabel(state));
  };

  // Both fire the idempotent ensure path; re-applying recovers already-proxied routes.
  pi.on("session_start", (_event, ctx) => ensure(ctx));
  pi.on("before_agent_start", (_event, ctx) => ensure(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("proxy", undefined);
    return stopProxyServer(state);
  });

  registerProxyAuditCommand(pi, state);
  return {
    ensure,
    isActive: () => state.port !== undefined,
    isProviderProxied: (provider) =>
      [...state.routes.values()].some((route) => route.provider === provider),
    statusLabel: () => formatProxyStatusLabel(state),
  };
}

/** Format a terse proxy state summary for the core footer. */
function formatProxyStatusLabel(state: ProxyState): string {
  if (state.startError) return "proxy:error";
  if (state.port === undefined) return "proxy:off";
  const routeCount = state.routes.size;
  const warningSuffix = state.warnings.length > 0 || state.unproxied.length > 0 ? "!" : "";
  return `proxy:${routeCount} route${routeCount === 1 ? "" : "s"}${warningSuffix}`;
}
