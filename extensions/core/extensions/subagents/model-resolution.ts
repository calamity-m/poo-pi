import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readCoreSubagentSettings } from "../../config/persistence.ts";
import type { SpawnSubagentInput, SubagentModelSelection, Tier } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProxyReadinessHandle } from "../proxy/index.ts";

/** Resolve a model override, configured tier, or the current parent fallback from live registry state. */
export async function resolveSubagentModel(
  input: SpawnSubagentInput,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<SubagentModelSelection> {
  if (input.model)
    return resolveCanonicalModel(input.model, input.thinkingLevel, ctx, "raw model override");

  const tier = normalizeTier(input.tier);
  if (tier) {
    const settings = await readCoreSubagentSettings(ctx.cwd);
    const mapping = settings?.[tier];
    if (!mapping) throw new Error(`No subagent model configured for tier "${tier}"`);
    return resolveCanonicalModel(
      mapping.model,
      input.thinkingLevel ?? mapping.thinkingLevel,
      ctx,
      `tier ${tier}`,
    );
  }

  if (!ctx.model)
    throw new Error("No subagent model configured and parent session has no active model.");
  const model = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) ?? ctx.model;
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Parent model is unavailable; authenticate provider "${model.provider}".`);
  }
  return {
    model,
    modelId: formatCanonicalModelId(model),
    thinkingLevel: normalizeThinkingLevel(input.thinkingLevel ?? pi.getThinkingLevel()),
    source: "parent fallback",
  };
}

/** Resolve and auth-check a canonical model id against the live model registry. */
export function resolveCanonicalModel(
  canonicalId: string,
  thinkingLevel: string | undefined,
  ctx: ExtensionContext,
  source: string,
): SubagentModelSelection {
  const parsed = parseCanonicalModelId(canonicalId);
  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Unknown model: ${canonicalId}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model is known but unavailable; authenticate provider "${parsed.provider}" or configure its API key: ${canonicalId}`,
    );
  }
  return {
    model,
    modelId: canonicalId,
    thinkingLevel: normalizeThinkingLevel(thinkingLevel),
    source,
  };
}

/** Parse a canonical provider/model-id string. */
export function parseCanonicalModelId(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid canonical model id: ${value}`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** Format a model as provider/model-id. */
export function formatCanonicalModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Normalize a tier parameter, throwing on unrecognized values. */
export function normalizeTier(value: string | undefined): Tier | undefined {
  if (value === undefined) return undefined;
  if (value === "fast" || value === "high") return value;
  throw new Error(`Invalid subagent tier: ${value}`);
}

/** Normalize a thinking level parameter, throwing on unrecognized values. */
export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`Invalid thinkingLevel: ${value}`);
}

/** Fail fast when a proxied provider's selected model still points away from loopback after readiness. */
export function assertProxyLoopbackIfRequired(
  selection: SubagentModelSelection,
  proxy: ProxyReadinessHandle | undefined,
): void {
  if (!proxy?.isActive() || !proxy.isProviderProxied(selection.model.provider)) return;
  const baseUrl = selection.model.baseUrl ?? "";
  if (!baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error(
      `Resolved subagent model ${selection.modelId} did not pick up the proxy baseUrl (resolved: ${baseUrl || "unknown"})`,
    );
  }
}
