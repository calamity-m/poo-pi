import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProxyRoute, ProxyState, UnproxiedProvider } from "./types.ts";

/** Minimal model shape the proxy reads from the registry; `Model<Api>` satisfies it structurally. */
interface RegistryModel {
  provider: string;
  id: string;
  baseUrl: string;
}

/** Build the local `/p/` base URL prefix the proxy serves routes under for a given port. */
export function localProxyPrefix(port: number): string {
  return `http://127.0.0.1:${port}/p/`;
}

/** Return the route id from one of this extension's loopback proxy URLs, including stale ports after `/reload`. */
function localProxyRouteId(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return undefined;
    const [, prefix, routeId] = parsed.pathname.split("/");
    return prefix === "p" && routeId ? routeId : undefined;
  } catch {
    return undefined;
  }
}

/** Derive a URL-safe, stable route id from a provider name. */
function routeIdFor(provider: string): string {
  return provider.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/** Drop a single trailing slash so upstream base URLs compare and concatenate consistently. */
function normalizeBase(url: string): string {
  return url.replace(/\/$/, "");
}

/** Per-provider accumulator used while grouping models into routes. */
interface ProviderGroup {
  /** Distinct upstream base URLs seen for the provider. */
  upstreams: Set<string>;
  /** Disqualification reasons collected while scanning the provider's models. */
  reasons: Set<string>;
}

/**
 * Group registry models into one route per provider, applying disqualification
 * criteria and recovering already-proxied base URLs to their original upstream
 * so re-registration is idempotent (no proxy→proxy double-wrapping).
 *
 * A provider is disqualified — and reported in `unproxied` rather than routed — when it
 * exposes more than one upstream base URL, a model has a missing or non-`http(s)` base URL,
 * or its base URL is an unrecognized proxy URL whose upstream cannot be recovered. Providers
 * that ignore `model.baseUrl` (custom `streamSimple`) or set it dynamically (OAuth
 * `modifyModels`) are not detectable from the model registry and are silently not proxied;
 * this is an accepted limitation, documented in the plan and surfaced via status coverage.
 *
 * @param models All models from the registry.
 * @param _port Current listening proxy port, retained for caller clarity; stale-port recovery is route-id based.
 * @param existingRoutes Routes from a prior apply, used to recover upstreams for already-proxied models.
 * @returns The new route map (keyed by route id) and the list of unproxied providers.
 */
export function buildRoutes(
  models: readonly RegistryModel[],
  _port: number,
  existingRoutes: Map<string, ProxyRoute>,
): { routes: Map<string, ProxyRoute>; unproxied: UnproxiedProvider[] } {
  const groups = new Map<string, ProviderGroup>();

  for (const model of models) {
    const group = groups.get(model.provider) ?? { upstreams: new Set(), reasons: new Set() };
    classifyBaseUrl(model.baseUrl, existingRoutes, group);
    groups.set(model.provider, group);
  }

  const routes = new Map<string, ProxyRoute>();
  const unproxied: UnproxiedProvider[] = [];

  for (const [provider, group] of groups) {
    const reason = disqualify(group);
    if (reason) {
      unproxied.push({ provider, reason });
      continue;
    }
    const routeId = routeIdFor(provider);
    if (routes.has(routeId)) {
      unproxied.push({ provider, reason: `route id "${routeId}" collides with another provider` });
      continue;
    }
    routes.set(routeId, { provider, routeId, upstreamBaseUrl: [...group.upstreams][0] });
  }

  return { routes, unproxied };
}

/** Classify one model's base URL into the provider group: a usable upstream, or a disqualification reason. */
function classifyBaseUrl(
  baseUrl: string,
  existingRoutes: Map<string, ProxyRoute>,
  group: ProviderGroup,
): void {
  if (!baseUrl) {
    group.reasons.add("missing base url");
    return;
  }
  const routeId = localProxyRouteId(baseUrl);
  if (routeId) {
    const original = existingRoutes.get(routeId)?.upstreamBaseUrl;
    if (original) group.upstreams.add(original);
    else group.reasons.add("already proxied to an unknown route");
    return;
  }
  if (/^https?:\/\//.test(baseUrl)) {
    group.upstreams.add(normalizeBase(baseUrl));
    return;
  }
  group.reasons.add("non-http base url");
}

/** Return a disqualification reason for a provider group, or undefined when it qualifies for a single route. */
function disqualify(group: ProviderGroup): string | undefined {
  if (group.reasons.size > 0) return [...group.reasons][0];
  if (group.upstreams.size > 1) return "multiple upstream base URLs";
  if (group.upstreams.size === 0) return "no usable base url";
  return undefined;
}

/**
 * Re-register qualifying providers so their base URL points at the local proxy,
 * then refresh the active model so it routes through the proxy too.
 *
 * No-ops when the server is not listening, so a failed server start never strands
 * providers pointing at a dead `127.0.0.1`. Idempotent across repeated lifecycle
 * fires via {@link buildRoutes}'s already-proxied recovery.
 */
export async function applyProviderOverrides(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ProxyState,
): Promise<void> {
  if (state.port === undefined) return;

  const { routes, unproxied } = buildRoutes(ctx.modelRegistry.getAll(), state.port, state.routes);
  state.routes = routes;
  state.unproxied = unproxied;
  // Recompute warnings from scratch each apply; this runs every turn via
  // before_agent_start, so appending would accumulate duplicates unboundedly.
  state.warnings = [];

  const prefix = localProxyPrefix(state.port);
  for (const route of routes.values()) {
    pi.registerProvider(route.provider, { baseUrl: `${prefix}${route.routeId}` });
  }

  await refreshActiveModel(pi, ctx, state);
}

/**
 * Refresh the active model after a base-URL override and verify it now resolves
 * to the loopback proxy; record a warning if it does not (so the active model
 * silently bypassing the proxy is visible in status rather than hidden).
 */
async function refreshActiveModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ProxyState,
): Promise<void> {
  const active = ctx.model;
  if (!active || !state.routes.has(routeIdFor(active.provider))) return;

  const updated = ctx.modelRegistry.find(active.provider, active.id);
  if (!updated) return;
  await pi.setModel(updated);

  const resolved = ctx.modelRegistry.find(active.provider, active.id)?.baseUrl ?? "";
  if (!resolved.startsWith("http://127.0.0.1:")) {
    state.warnings.push(
      `active model ${active.provider}/${active.id} did not pick up the proxy baseUrl (resolved: ${resolved || "unknown"})`,
    );
  }
}
