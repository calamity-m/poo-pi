import { readFile } from "node:fs/promises";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  parsePermissionConfig,
  readGlobalCorePermissionConfig,
  readProjectCorePermissionConfig,
  validatePermissionSection,
  writeGlobalCorePermissionConfig,
  writeProjectCorePermissionConfig,
} from "../../config/persistence.ts";
import { globalCoreSettingsPath, projectCoreSettingsPath } from "../../config/paths.ts";

import type {
  CompiledGrant,
  CompiledPermissionScope,
  CompiledRule,
  ModePermissionConfig,
  NonOpenPermissionMode,
  PermissionMode,
  PermissionSourceMetadata,
  PermissionState,
  PersistedPermissionConfig,
  RememberedGrant,
  Rule,
} from "./types.ts";
import { NON_OPEN_PERMISSION_MODES } from "./types.ts";

/** Default state when no config file exists or the file is malformed. */
const DEFAULTS: PermissionState = {
  mode: "trusted",
  rules: [],
  remembered: [],
};

/** Empty compiled permission scope. */
const EMPTY_SCOPE: CompiledPermissionScope = { rules: [], remembered: [] };

/** Validation-aware permission read result for one settings scope. */
interface PermissionConfigReadResult {
  /** Parsed permissions section when present and valid. */
  permissions?: PersistedPermissionConfig;
  /** Why this scope was ignored. */
  error?: string;
}

/** Return the absolute path to the project-local permissions settings file. */
export function configFilePath(cwd: string): string {
  return projectCoreSettingsPath(cwd);
}

/** Return the absolute path to the centralized core settings defaults file. */
export function defaultConfigFilePath(): string {
  return globalCoreSettingsPath();
}

/** Return whether a mode has a persisted rule/grant block. */
export function isNonOpenMode(mode: PermissionMode): mode is NonOpenPermissionMode {
  return mode !== "open";
}

/** Return a fresh default persisted permissions object. */
export function createDefaultPermissionConfig(): PersistedPermissionConfig {
  return { mode: DEFAULTS.mode };
}

/**
 * Read permissions from global and project-local core settings and return compiled state.
 * Project-local settings are honored only when the caller marks the project trusted.
 */
export async function readPermissionState(
  cwd: string,
  projectTrusted = true,
): Promise<PermissionState> {
  const globalResult = await readPermissionsFromPath(globalCoreSettingsPath(), "global");
  const projectResult = projectTrusted
    ? await readPermissionsFromPath(projectCoreSettingsPath(cwd), "project")
    : { error: "project is not trusted" };

  if (globalResult.error)
    console.warn(`[permissions] ignoring global permissions: ${globalResult.error}`);
  if (projectResult.error && projectTrusted) {
    console.warn(`[permissions] ignoring project permissions: ${projectResult.error}`);
  }

  return buildEffectiveState(cwd, projectTrusted, globalResult, projectResult);
}

/** Read the effective default mode from centralized core settings. */
export async function readDefaultPermissionMode(): Promise<PermissionMode> {
  return (await readGlobalCorePermissionConfig())?.mode ?? DEFAULTS.mode;
}

/** Persist the global default mode without discarding per-mode rules or grants. */
export async function writeDefaultPermissionMode(mode: PermissionMode): Promise<void> {
  const existing = (await readGlobalCorePermissionConfig()) ?? {};
  await writeGlobalCorePermissionConfig({ ...existing, mode });
}

/** Persist the project-local active mode without changing global defaults. */
export async function writeProjectPermissionMode(cwd: string, mode: PermissionMode): Promise<void> {
  const existing = (await readProjectCorePermissionConfig(cwd)) ?? {};
  await writeProjectCorePermissionConfig(cwd, { ...existing, mode });
}

/**
 * Persist the current active rules/grants to the project-local active mode block.
 * This compatibility helper also pins the project-local mode.
 */
export async function writePermissionState(cwd: string, state: PermissionState): Promise<void> {
  const existing = (await readProjectCorePermissionConfig(cwd)) ?? {};
  const next = serializeStateIntoConfig(existing, state, true);
  await writeProjectCorePermissionConfig(cwd, next);
}

/** Persist active rules/grants to the local active block without pinning local mode. */
export async function writePermissionRulesAndGrants(
  cwd: string,
  state: PermissionState,
): Promise<void> {
  const existing = (await readProjectCorePermissionConfig(cwd)) ?? {};
  const next = serializeStateIntoConfig(existing, state, false);
  await writeProjectCorePermissionConfig(cwd, next);
}

/** Append remembered grants to the project-local active mode block without pinning local mode. */
export async function appendLocalRememberedGrants(
  cwd: string,
  mode: PermissionMode,
  grants: CompiledGrant[],
): Promise<void> {
  if (!isNonOpenMode(mode) || grants.length === 0) return;
  const existing = (await readProjectCorePermissionConfig(cwd)) ?? {};
  const block = ensureModeBlock(existing, mode);
  block.remembered ??= [];
  for (const grant of grants.map(rawGrantFromCompiled)) {
    if (
      !block.remembered.some(
        (candidate) => rememberedIdentity(candidate) === rememberedIdentity(grant),
      )
    ) {
      block.remembered.push(grant);
    }
  }
  await writeProjectCorePermissionConfig(cwd, existing);
}

/**
 * Validate, parse, and compile a raw JSON value into a `PermissionState`.
 * Legacy flat objects are accepted only for in-memory test construction; persisted
 * config validation rejects that shape via {@link validateConfig}.
 */
export function parseAndCompile(raw: unknown): PermissionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj["rules"]) || Array.isArray(obj["remembered"])) {
    const mode = isValidMode(obj["mode"]) ? obj["mode"] : DEFAULTS.mode;
    return {
      mode,
      rules: compileRules(Array.isArray(obj["rules"]) ? obj["rules"] : []),
      remembered: compileGrants(Array.isArray(obj["remembered"]) ? obj["remembered"] : []),
    };
  }

  const permissions = parsePermissionConfig(raw) ?? createDefaultPermissionConfig();
  const mode = permissions.mode ?? DEFAULTS.mode;
  const active = isNonOpenMode(mode) ? permissions[mode] : undefined;
  const scope = mode === "open" ? EMPTY_SCOPE : compileModeBlock(active);
  return { mode, rules: scope.rules, remembered: scope.remembered, globalScope: scope };
}

/** Return true if the value is a valid PermissionMode. */
export function isValidMode(value: unknown): value is PermissionMode {
  return value === "safe" || value === "trusted" || value === "open" || value === "permissive";
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
    if (typeof g["dirPrefix"] === "string") grant.dirPrefix = g["dirPrefix"];
    if (typeof g["pattern"] === "string") {
      const regex = tryCompile(g["pattern"]);
      if (!regex) continue;
      grant.pattern = g["pattern"];
      grant.regex = regex;
    }
    if (!grant.dirPrefix && !grant.pattern) continue;
    out.push(grant);
  }
  return out;
}

/** Try to compile a regex pattern string. */
function tryCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    console.warn(`[permissions] dropping invalid regex pattern: ${pattern}`);
    return undefined;
  }
}

/** Validate a raw permissions config and return a compiled active state or an error string. */
export function validateConfig(raw: unknown): PermissionState | string {
  const error = validatePermissionSection(raw);
  if (error) return error;
  return parseAndCompile(raw);
}

/**
 * Add a remembered grant to the in-memory state, deduplicating by `tool`+`pattern`
 * (for bash grants) or `tool`+`dirPrefix` (for path grants).
 */
export function addGrant(state: PermissionState, grant: CompiledGrant): void {
  const isDup = state.remembered.some(
    (g) => compiledGrantIdentity(g) === compiledGrantIdentity(grant),
  );
  if (!isDup) state.remembered.push(grant);
  const scope = state.projectScope ?? state.globalScope;
  if (
    scope &&
    !scope.remembered.some((g) => compiledGrantIdentity(g) === compiledGrantIdentity(grant))
  ) {
    scope.remembered.push(grant);
  }
}

/** Build a fresh ExtensionContext-aware loader for session_start. */
export async function reloadState(ctx: ExtensionContext): Promise<PermissionState> {
  const maybeCtx = ctx as ExtensionContext & { isProjectTrusted?: () => boolean };
  return readPermissionState(ctx.cwd, maybeCtx.isProjectTrusted?.() ?? true);
}

/** Serialize the active flattened rules back to raw shapes for display. */
export function toRawRules(state: PermissionState): Rule[] {
  return state.rules.map((r) => ({ tool: r.tool, action: r.action, pattern: r.pattern }));
}

/** Serialize the active flattened grants back to raw shapes for display. */
export function toRawGrants(state: PermissionState): RememberedGrant[] {
  return state.remembered.map(rawGrantFromCompiled);
}

/** Serialize a state as a nested permissions object for editor prefill. */
export function toPersistedConfig(state: PermissionState): PersistedPermissionConfig {
  const out: PersistedPermissionConfig = { mode: state.mode };
  if (isNonOpenMode(state.mode)) {
    out[state.mode] = {
      rules: toRawRules(state),
      remembered: toRawGrants(state),
    };
  }
  return out;
}

/** Read one settings file, validating only its permissions section. */
async function readPermissionsFromPath(
  path: string,
  scope: "global" | "project",
): Promise<PermissionConfigReadResult> {
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    return {
      error: `${scope} settings unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      error: `${scope} settings JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${scope} settings must be a JSON object` };
  }
  const permissions = (parsed as Record<string, unknown>)["permissions"];
  const error = validatePermissionSection(permissions);
  if (error) return { error };
  return { permissions: parsePermissionConfig(permissions) };
}

/** Build effective state and metadata from raw global/project results. */
function buildEffectiveState(
  cwd: string,
  projectTrusted: boolean,
  globalResult: PermissionConfigReadResult,
  projectResult: PermissionConfigReadResult,
): PermissionState {
  const globalPermissions = globalResult.error
    ? createDefaultPermissionConfig()
    : (globalResult.permissions ?? createDefaultPermissionConfig());
  const projectPermissions = projectResult.error ? undefined : projectResult.permissions;
  const mode = projectPermissions?.mode ?? globalPermissions.mode ?? DEFAULTS.mode;
  const modeSource = projectPermissions?.mode
    ? "project"
    : globalPermissions.mode
      ? "global"
      : "default";

  const projectScope =
    mode === "open" ? { ...EMPTY_SCOPE } : compileModeBlock(projectPermissions?.[mode]);
  const globalScope =
    mode === "open" ? { ...EMPTY_SCOPE } : compileModeBlock(globalPermissions[mode]);
  const projectRuleIds = new Set(projectScope.rules.map(ruleIdentity));
  const projectGrantIds = new Set(projectScope.remembered.map(compiledGrantIdentity));
  const effectiveGlobalScope = {
    rules: globalScope.rules.filter((rule) => !projectRuleIds.has(ruleIdentity(rule))),
    remembered: globalScope.remembered.filter(
      (grant) => !projectGrantIds.has(compiledGrantIdentity(grant)),
    ),
  };

  const metadata: PermissionSourceMetadata = {
    cwd,
    projectTrusted,
    modeSource,
    projectPath: projectCoreSettingsPath(cwd),
    globalPath: globalCoreSettingsPath(),
    ignoredProjectReason: projectResult.error,
    ignoredGlobalReason: globalResult.error,
    globalMode: globalPermissions.mode,
    counts: {
      project: { rules: projectScope.rules.length, remembered: projectScope.remembered.length },
      global: {
        rules: effectiveGlobalScope.rules.length,
        remembered: effectiveGlobalScope.remembered.length,
      },
      overriddenRules: globalScope.rules
        .filter((rule) => projectRuleIds.has(ruleIdentity(rule)))
        .map(ruleIdentity),
      overriddenGrants: globalScope.remembered
        .filter((grant) => projectGrantIds.has(compiledGrantIdentity(grant)))
        .map(compiledGrantIdentity),
    },
  };

  return {
    mode,
    rules: [...projectScope.rules, ...effectiveGlobalScope.rules],
    remembered: [...projectScope.remembered, ...effectiveGlobalScope.remembered],
    projectScope,
    globalScope: effectiveGlobalScope,
    metadata,
  };
}

/** Compile one optional persisted mode block. */
function compileModeBlock(block: ModePermissionConfig | undefined): CompiledPermissionScope {
  return {
    rules: compileRules(block?.rules ?? []),
    remembered: compileGrants(block?.remembered ?? []),
  };
}

/** Serialize active state arrays into a nested persisted config. */
function serializeStateIntoConfig(
  existing: PersistedPermissionConfig,
  state: PermissionState,
  persistMode: boolean,
): PersistedPermissionConfig {
  const next: PersistedPermissionConfig = { ...existing };
  if (persistMode) next.mode = state.mode;
  if (isNonOpenMode(state.mode)) {
    next[state.mode] = {
      rules: toRawRules(state),
      remembered: toRawGrants(state),
    };
  }
  return next;
}

/** Ensure a persisted mode block exists before a write. */
function ensureModeBlock(
  permissions: PersistedPermissionConfig,
  mode: NonOpenPermissionMode,
): ModePermissionConfig {
  permissions[mode] ??= {};
  return permissions[mode]!;
}

/** Return a raw remembered grant from a compiled grant. */
function rawGrantFromCompiled(g: CompiledGrant): RememberedGrant {
  const out: RememberedGrant = { tool: g.tool };
  if (g.dirPrefix !== undefined) out.dirPrefix = g.dirPrefix;
  if (g.pattern !== undefined) out.pattern = g.pattern;
  return out;
}

/** Return a stable identity string for rule replacement/dedupe. */
function ruleIdentity(rule: Pick<Rule, "tool" | "pattern">): string {
  return `${rule.tool}\u0000${rule.pattern}`;
}

/** Return a stable identity string for raw remembered-grant dedupe. */
function rememberedIdentity(grant: RememberedGrant): string {
  return `${grant.tool}\u0000${grant.dirPrefix ?? grant.pattern ?? ""}`;
}

/** Return a stable identity string for compiled remembered-grant dedupe. */
function compiledGrantIdentity(grant: CompiledGrant): string {
  return `${grant.tool}\u0000${grant.dirPrefix ?? grant.pattern ?? ""}`;
}

/** Return whether an fs error is ENOENT. */
function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Touch imported mode list so TypeScript keeps this module close to type definitions. */
void NON_OPEN_PERMISSION_MODES;
