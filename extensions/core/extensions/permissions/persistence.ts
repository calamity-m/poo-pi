import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  CompiledGrant,
  CompiledRule,
  PermissionMode,
  PermissionState,
  PersistedPermissionConfig,
  RememberedGrant,
  Rule,
} from "./types.ts";

const CONFIG_PATH = join(".pi", "core-permissions.json");

/** Default state when no config file exists or the file is malformed. */
const DEFAULTS: PermissionState = {
  mode: "trusted",
  rules: [],
  remembered: [],
};

/** Return the absolute path to the project-local permissions config file. */
export function configFilePath(cwd: string): string {
  return join(cwd, CONFIG_PATH);
}

/**
 * Read `.pi/core-permissions.json` and return compiled in-memory state.
 * Falls back to defaults on absence or malformed JSON; invalid regex patterns
 * are dropped with a console warning rather than crashing.
 */
export async function readPermissionState(cwd: string): Promise<PermissionState> {
  try {
    const raw = await readFile(configFilePath(cwd), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseAndCompile(parsed);
  } catch {
    // Absent or malformed → defaults
    return { ...DEFAULTS, rules: [], remembered: [] };
  }
}

/**
 * Persist the current permission state to `.pi/core-permissions.json`.
 * Creates `.pi/` if absent. Written with mode 0o600 (owner-read-only).
 * Only serializes the raw `mode`, `rules`, and `remembered` arrays
 * (not the compiled regexes).
 */
export async function writePermissionState(cwd: string, state: PermissionState): Promise<void> {
  const file = configFilePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  const config: PersistedPermissionConfig = {
    mode: state.mode,
    rules: state.rules.map((r) => ({ tool: r.tool, action: r.action, pattern: r.pattern })),
    remembered: state.remembered.map((g) => {
      const out: RememberedGrant = { tool: g.tool };
      if (g.dirPrefix !== undefined) out.dirPrefix = g.dirPrefix;
      if (g.pattern !== undefined) out.pattern = g.pattern;
      return out;
    }),
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Validate, parse, and compile a raw JSON value into a `PermissionState`.
 * Returns defaults for invalid top-level shapes; invalid rules/grants are dropped.
 * Exposed for use in `/permissions edit` validation before writing.
 */
export function parseAndCompile(raw: unknown): PermissionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
  const obj = raw as Record<string, unknown>;

  const mode = isValidMode(obj["mode"]) ? obj["mode"] : DEFAULTS.mode;
  const rules = compileRules(Array.isArray(obj["rules"]) ? obj["rules"] : []);
  const remembered = compileGrants(Array.isArray(obj["remembered"]) ? obj["remembered"] : []);

  return { mode, rules, remembered };
}

/** Return true if the value is a valid PermissionMode. */
export function isValidMode(value: unknown): value is PermissionMode {
  return value === "safe" || value === "trusted" || value === "open";
}

/** Compile raw rule objects, dropping any with invalid patterns. */
function compileRules(items: unknown[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["tool"] !== "string") continue;
    if (r["action"] !== "allow" && r["action"] !== "ask" && r["action"] !== "deny") continue;
    if (typeof r["pattern"] !== "string") continue;
    const regex = tryCompile(r["pattern"]);
    if (!regex) continue;
    out.push({ tool: r["tool"], action: r["action"], pattern: r["pattern"], regex });
  }
  return out;
}

/** Compile raw grant objects, dropping any with invalid patterns. */
function compileGrants(items: unknown[]): CompiledGrant[] {
  const out: CompiledGrant[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const g = item as Record<string, unknown>;
    if (typeof g["tool"] !== "string") continue;
    const grant: CompiledGrant = { tool: g["tool"] };
    if (typeof g["dirPrefix"] === "string") {
      grant.dirPrefix = g["dirPrefix"];
    }
    if (typeof g["pattern"] === "string") {
      const regex = tryCompile(g["pattern"]);
      if (!regex) continue; // drop grants with bad regex
      grant.pattern = g["pattern"];
      grant.regex = regex;
    }
    if (!grant.dirPrefix && !grant.pattern) continue; // neither field — drop
    out.push(grant);
  }
  return out;
}

/**
 * Try to compile a regex pattern string.
 * Returns the RegExp on success, or undefined if the pattern is syntactically invalid.
 */
function tryCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    console.warn(`[permissions] dropping invalid regex pattern: ${pattern}`);
    return undefined;
  }
}

/**
 * Validate a raw config (parsed JSON) and return a compiled state, or a string
 * error message if invalid. Used by `/permissions edit` before writing.
 */
export function validateConfig(raw: unknown): PermissionState | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "config must be a JSON object";
  }
  const obj = raw as Record<string, unknown>;
  if (!isValidMode(obj["mode"])) {
    return `"mode" must be "safe", "trusted", or "open"; got ${JSON.stringify(obj["mode"])}`;
  }
  if (obj["rules"] !== undefined && !Array.isArray(obj["rules"])) {
    return '"rules" must be an array';
  }
  if (obj["remembered"] !== undefined && !Array.isArray(obj["remembered"])) {
    return '"remembered" must be an array';
  }
  // Compile — invalid patterns are logged and dropped; still valid overall
  return parseAndCompile(raw);
}

/**
 * Add a remembered grant to the in-memory state.
 * Deduplication is not performed — the caller controls when to persist.
 */
export function addGrant(state: PermissionState, grant: CompiledGrant): void {
  state.remembered.push(grant);
}

/** Build a fresh ExtensionContext-aware loader (convenience wrapper for session_start). */
export async function reloadState(ctx: ExtensionContext): Promise<PermissionState> {
  return readPermissionState(ctx.cwd);
}

/** Serialize the state back to the Rule / RememberedGrant raw shapes for display. */
export function toRawRules(state: PermissionState): Rule[] {
  return state.rules.map((r) => ({ tool: r.tool, action: r.action, pattern: r.pattern }));
}

/** Serialize the state back to the RememberedGrant raw shapes for display. */
export function toRawGrants(state: PermissionState): RememberedGrant[] {
  return state.remembered.map((g) => {
    const out: RememberedGrant = { tool: g.tool };
    if (g.dirPrefix !== undefined) out.dirPrefix = g.dirPrefix;
    if (g.pattern !== undefined) out.pattern = g.pattern;
    return out;
  });
}
