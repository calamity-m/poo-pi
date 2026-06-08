import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RedactionMode } from "../extensions/proxy/types.ts";
import type {
  PermissionMode,
  PersistedPermissionConfig,
  RememberedGrant,
  Rule,
  RuleAction,
} from "../extensions/permissions/types.ts";
import type { SourceTarget } from "../extensions/tls/types.ts";
import { createDefaultCoreSettings } from "./defaults.ts";
import { coreSettingsPath, cwdFromProxyAuditDir, globalCoreSettingsPath } from "./paths.ts";
import type {
  CoreFooterSettings,
  CoreHistorySearchSettings,
  CoreSettings,
  CoreSubagentSettings,
  CoreWorktreeSettings,
} from "./types.ts";

/** Read unified core settings from `.pi/core-settings.json`, returning defaults when absent or malformed. */
export async function readCoreSettings(cwd: string): Promise<CoreSettings> {
  return await readCoreSettingsFile(coreSettingsPath(cwd));
}

/** Read user-scoped core settings from `~/.pi/agent/core-settings.json`. */
export async function readGlobalCoreSettings(): Promise<CoreSettings> {
  return await readCoreSettingsFile(globalCoreSettingsPath());
}

/** Validate and persist unified core settings to `.pi/core-settings.json`. */
export async function writeCoreSettings(cwd: string, settings: CoreSettings): Promise<void> {
  await writeCoreSettingsFile(coreSettingsPath(cwd), settings);
}

/** Validate and persist user-scoped core settings to `~/.pi/agent/core-settings.json`. */
export async function writeGlobalCoreSettings(settings: CoreSettings): Promise<void> {
  await writeCoreSettingsFile(globalCoreSettingsPath(), settings);
}

/** Read the permissions section from unified core settings. */
export async function readCorePermissionConfig(
  cwd: string,
): Promise<PersistedPermissionConfig | undefined> {
  return (await readCoreSettings(cwd)).permissions;
}

/** Read the user-scoped permissions defaults from global core settings. */
export async function readGlobalCorePermissionConfig(): Promise<
  PersistedPermissionConfig | undefined
> {
  return (await readGlobalCoreSettings()).permissions;
}

/** Persist the permissions section in unified core settings. */
export async function writeCorePermissionConfig(
  cwd: string,
  permissions: PersistedPermissionConfig,
): Promise<void> {
  const settings = await readCoreSettings(cwd);
  settings.permissions = permissions;
  await writeCoreSettings(cwd, settings);
}

/** Persist the user-scoped permissions defaults in global core settings. */
export async function writeGlobalCorePermissionConfig(
  permissions: PersistedPermissionConfig,
): Promise<void> {
  const settings = await readGlobalCoreSettings();
  settings.permissions = permissions;
  await writeGlobalCoreSettings(settings);
}

/** Read non-secret client TLS target metadata from unified core settings. */
export async function readCoreClientTlsTarget(cwd: string): Promise<SourceTarget | undefined> {
  return (await readCoreSettings(cwd)).tls?.target;
}

/** Persist non-secret client TLS target metadata in unified core settings. */
export async function writeCoreClientTlsTarget(cwd: string, target: SourceTarget): Promise<void> {
  const settings = await readCoreSettings(cwd);
  settings.tls = { ...settings.tls, target };
  await writeCoreSettings(cwd, settings);
}

/** Read whether client TLS resolution should be skipped at startup. */
export async function readCoreClientTlsSkip(cwd: string): Promise<boolean> {
  return (await readCoreSettings(cwd)).tls?.skip ?? false;
}

/** Persist whether client TLS resolution should be skipped at startup. */
export async function writeCoreClientTlsSkip(cwd: string, skip: boolean): Promise<void> {
  const settings = await readCoreSettings(cwd);
  settings.tls = { ...settings.tls, skip };
  await writeCoreSettings(cwd, settings);
}

/** Return whether unified client TLS metadata exists. */
export function hasCoreClientTlsConfig(cwd: string): boolean {
  try {
    const parsed = parseCoreSettings(JSON.parse(readFileSync(coreSettingsPath(cwd), "utf8")));
    return Boolean(parsed?.tls?.target);
  } catch {
    return false;
  }
}

/** Read proxy audit redaction mode from unified core settings. */
export async function readCoreProxyRedactionMode(auditDir: string): Promise<RedactionMode> {
  const cwd = cwdFromProxyAuditDir(auditDir);
  return (await readCoreSettings(cwd)).proxy?.audit?.redact ?? "on";
}

/** Persist proxy audit redaction mode in unified core settings. */
export async function writeCoreProxyRedactionMode(
  auditDir: string,
  mode: RedactionMode,
): Promise<void> {
  const cwd = cwdFromProxyAuditDir(auditDir);
  const settings = await readCoreSettings(cwd);
  settings.proxy = {
    ...settings.proxy,
    audit: { ...settings.proxy?.audit, redact: mode },
  };
  await writeCoreSettings(cwd, settings);
}

/** Read history search settings from unified core settings. */
export async function readCoreHistorySearchSettings(
  cwd: string,
): Promise<CoreHistorySearchSettings | undefined> {
  return (await readCoreSettings(cwd)).historySearch;
}

/** Read history search settings synchronously for registration-time shortcut setup. */
export function readCoreHistorySearchSettingsSync(
  cwd: string,
): CoreHistorySearchSettings | undefined {
  try {
    return parseCoreSettings(JSON.parse(readFileSync(coreSettingsPath(cwd), "utf8")))
      ?.historySearch;
  } catch {
    return undefined;
  }
}

/** Persist history search settings without disturbing other core settings sections. */
export async function writeCoreHistorySearchSettings(
  cwd: string,
  historySearch: CoreHistorySearchSettings,
): Promise<void> {
  const settings = await readCoreSettings(cwd);
  settings.historySearch = historySearch;
  await writeCoreSettings(cwd, settings);
}

/** Read footer settings from unified core settings. */
export async function readCoreFooterSettings(cwd: string): Promise<CoreFooterSettings | undefined> {
  return (await readCoreSettings(cwd)).footer;
}

/** Persist footer settings without disturbing other core settings sections. */
export async function writeCoreFooterSettings(
  cwd: string,
  footer: CoreFooterSettings,
): Promise<void> {
  const settings = await readCoreSettings(cwd);
  settings.footer = footer;
  await writeCoreSettings(cwd, settings);
}

/** Read managed worktree settings from unified (project-local) core settings. */
export async function readCoreWorktreeSettings(
  cwd: string,
): Promise<CoreWorktreeSettings | undefined> {
  return (await readCoreSettings(cwd)).worktrees;
}

/** Read user-scoped subagent tier settings from global core settings. */
export async function readGlobalCoreSubagentSettings(): Promise<CoreSubagentSettings | undefined> {
  return (await readGlobalCoreSettings()).subagents;
}

/** Persist user-scoped subagent tier settings without disturbing other global settings sections. */
export async function writeGlobalCoreSubagentSettings(
  subagents: CoreSubagentSettings,
): Promise<void> {
  const settings = await readGlobalCoreSettings();
  settings.subagents = subagents;
  await writeGlobalCoreSettings(settings);
}

/** Validate an unknown JSON value for user edits and return normalized core settings. */
export function validateCoreSettings(value: unknown): CoreSettings | string {
  if (!isRecord(value)) return "config must be a JSON object";
  const permissionsError = validatePermissionSection(value["permissions"]);
  if (permissionsError) return permissionsError;
  const tlsError = validateTlsSection(value["tls"]);
  if (tlsError) return tlsError;
  const proxyError = validateProxySection(value["proxy"]);
  if (proxyError) return proxyError;
  const subagentsError = validateSubagentSection(value["subagents"]);
  if (subagentsError) return subagentsError;
  const footerError = validateFooterSection(value["footer"]);
  if (footerError) return footerError;
  const historySearchError = validateHistorySearchSection(value["historySearch"]);
  if (historySearchError) return historySearchError;
  const worktreeError = validateWorktreeSection(value["worktrees"]);
  if (worktreeError) return worktreeError;
  return parseCoreSettings(value) ?? createDefaultCoreSettings();
}

/** Parse an unknown JSON value into the supported core settings shape. */
export function parseCoreSettings(value: unknown): CoreSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out = createDefaultCoreSettings();

  const permissions = parsePermissionConfig(raw["permissions"]);
  if (permissions) out.permissions = permissions;

  const tls = parseTlsSettings(raw["tls"]);
  if (tls) out.tls = tls;

  const proxy = parseProxySettings(raw["proxy"]);
  if (proxy) out.proxy = proxy;

  const subagents = parseSubagentSettings(raw["subagents"]);
  if (subagents) out.subagents = subagents;

  const historySearch = parseHistorySearchSettings(raw["historySearch"]);
  if (historySearch) out.historySearch = historySearch;

  const footer = parseFooterSettings(raw["footer"]);
  if (footer) out.footer = footer;

  const worktrees = parseWorktreeSettings(raw["worktrees"]);
  if (worktrees) out.worktrees = worktrees;

  return out;
}

/** Read and parse one core settings file, returning defaults when absent or malformed. */
async function readCoreSettingsFile(path: string): Promise<CoreSettings> {
  return parseCoreSettings(await readJson(path)) ?? createDefaultCoreSettings();
}

/** Validate and write one core settings file with private file permissions. */
async function writeCoreSettingsFile(path: string, settings: CoreSettings): Promise<void> {
  const normalized = parseCoreSettings(settings) ?? createDefaultCoreSettings();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
}

/** Read and parse a JSON file, returning undefined for absence or malformed content. */
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Validate the permissions section when present in edited core settings. */
function validatePermissionSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"permissions" must be an object';
  if (!isPermissionMode(value["mode"])) {
    return '"permissions.mode" must be "safe", "trusted", "open", or "permissive"';
  }
  if (value["rules"] !== undefined && !Array.isArray(value["rules"]))
    return '"permissions.rules" must be an array';
  if (value["remembered"] !== undefined && !Array.isArray(value["remembered"]))
    return '"permissions.remembered" must be an array';
  return undefined;
}

/** Validate the TLS section when present in edited core settings. */
function validateTlsSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"tls" must be an object';
  if (value["target"] !== undefined && !parseSourceTarget(value["target"]))
    return '"tls.target" must include string sourceId, locator, and label';
  if (value["skip"] !== undefined && typeof value["skip"] !== "boolean")
    return '"tls.skip" must be a boolean';
  return undefined;
}

/** Validate the proxy section when present in edited core settings. */
function validateProxySection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"proxy" must be an object';
  const audit = value["audit"];
  if (audit === undefined) return undefined;
  if (!isRecord(audit)) return '"proxy.audit" must be an object';
  const redact = audit["redact"];
  if (redact !== undefined && redact !== "on" && redact !== "off")
    return '"proxy.audit.redact" must be "on" or "off"';
  return undefined;
}

/** Validate the history search section when present in edited core settings. */
function validateHistorySearchSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"historySearch" must be an object';
  const shortcut = value["shortcut"];
  if (shortcut !== undefined && !isKeyboardShortcut(shortcut)) {
    return '"historySearch.shortcut" must be a non-empty shortcut string';
  }
  return undefined;
}

/** Validate the footer section when present in edited core settings. */
function validateFooterSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"footer" must be an object';
  if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") {
    return '"footer.enabled" must be a boolean';
  }
  const template = value["template"];
  if (template !== undefined && (typeof template !== "string" || template.trim() === "")) {
    return '"footer.template" must be a non-empty string';
  }
  return undefined;
}

/** Validate the worktrees section when present in edited core settings. */
export function validateWorktreeSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"worktrees" must be an object';
  const root = value["root"];
  if (root !== undefined && (typeof root !== "string" || root.trim() === "")) {
    return '"worktrees.root" must be a non-empty string';
  }
  return undefined;
}

/** Validate the subagents section when present in edited core settings. */
export function validateSubagentSection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return '"subagents" must be an object';
  for (const tier of Object.keys(value)) {
    if (tier !== "fast" && tier !== "high") return `"subagents.${tier}" is not supported`;
    const mapping = value[tier];
    if (!isRecord(mapping)) return `"subagents.${tier}" must be an object`;
    if (!isCanonicalModelId(mapping["model"])) {
      return `"subagents.${tier}.model" must be a canonical provider/model-id string`;
    }
    const thinkingLevel = mapping["thinkingLevel"];
    if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
      return `"subagents.${tier}.thinkingLevel" must be one of off, minimal, low, medium, high, or xhigh`;
    }
  }
  return undefined;
}

/** Parse history search settings, dropping invalid fields. */
function parseHistorySearchSettings(value: unknown): CoreHistorySearchSettings | undefined {
  if (!isRecord(value)) return undefined;
  const shortcut = value["shortcut"];
  if (!isKeyboardShortcut(shortcut)) return undefined;
  return { shortcut: shortcut.trim() };
}

/** Parse the worktrees section, dropping invalid fields. */
function parseWorktreeSettings(value: unknown): CoreWorktreeSettings | undefined {
  if (!isRecord(value)) return undefined;
  const root = value["root"];
  if (typeof root !== "string" || root.trim() === "") return undefined;
  return { root: root.trim() };
}

/** Parse footer settings, dropping invalid fields. */
function parseFooterSettings(value: unknown): CoreFooterSettings | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = typeof value["enabled"] === "boolean" ? value["enabled"] : undefined;
  const template =
    typeof value["template"] === "string" && value["template"].trim() !== ""
      ? value["template"]
      : undefined;
  if (enabled === undefined && template === undefined) return undefined;
  return { ...(enabled !== undefined ? { enabled } : {}), ...(template ? { template } : {}) };
}

/** Parse the permissions section without compiling regexes. */
function parsePermissionConfig(value: unknown): PersistedPermissionConfig | undefined {
  if (!isRecord(value)) return undefined;
  const mode = isPermissionMode(value["mode"]) ? value["mode"] : undefined;
  if (!mode) return undefined;
  return {
    mode,
    rules: parseRules(value["rules"]),
    remembered: parseRemembered(value["remembered"]),
  };
}

/** Parse raw permission rules, dropping invalid items. */
function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const rules: Rule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const tool = item["tool"];
    const action = item["action"];
    const pattern = item["pattern"];
    if (typeof tool !== "string" || !isRuleAction(action) || typeof pattern !== "string") continue;
    rules.push({ tool, action, pattern });
  }
  return rules;
}

/** Parse raw remembered grants, dropping invalid items. */
function parseRemembered(value: unknown): RememberedGrant[] {
  if (!Array.isArray(value)) return [];
  const remembered: RememberedGrant[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item["tool"] !== "string") continue;
    const grant: RememberedGrant = { tool: item["tool"] };
    if (typeof item["dirPrefix"] === "string") grant.dirPrefix = item["dirPrefix"];
    if (typeof item["pattern"] === "string") grant.pattern = item["pattern"];
    if (grant.dirPrefix || grant.pattern) remembered.push(grant);
  }
  return remembered;
}

/** Parse the TLS section, retaining the target metadata and/or the skip flag. */
function parseTlsSettings(value: unknown): CoreSettings["tls"] | undefined {
  if (!isRecord(value)) return undefined;
  const target = parseSourceTarget(value["target"]);
  const skip = typeof value["skip"] === "boolean" ? value["skip"] : undefined;
  if (!target && skip === undefined) return undefined;
  const out: CoreSettings["tls"] = {};
  if (target) out.target = target;
  if (skip !== undefined) out.skip = skip;
  return out;
}

/** Parse a non-secret TLS source target. */
function parseSourceTarget(value: unknown): SourceTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value["sourceId"] === "string" &&
    typeof value["locator"] === "string" &&
    typeof value["label"] === "string"
  ) {
    return {
      sourceId: value["sourceId"],
      locator: value["locator"],
      label: value["label"],
    };
  }
  return undefined;
}

/** Parse the proxy section. */
function parseProxySettings(value: unknown): CoreSettings["proxy"] | undefined {
  if (!isRecord(value) || !isRecord(value["audit"])) return undefined;
  const redact = value["audit"]["redact"];
  if (redact !== "on" && redact !== "off") return undefined;
  return { audit: { redact } };
}

/** Parse the subagents section, retaining only valid fast/high mappings. */
function parseSubagentSettings(value: unknown): CoreSubagentSettings | undefined {
  if (!isRecord(value)) return undefined;
  const out: CoreSubagentSettings = {};
  for (const tier of ["fast", "high"] as const) {
    const mapping = value[tier];
    if (!isRecord(mapping) || !isCanonicalModelId(mapping["model"])) continue;
    out[tier] = {
      model: mapping["model"],
      ...(isThinkingLevel(mapping["thinkingLevel"])
        ? { thinkingLevel: mapping["thinkingLevel"] }
        : {}),
    };
  }
  return out.fast || out.high ? out : undefined;
}

/** Return whether a value is a canonical provider/model-id string. */
function isCanonicalModelId(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

/** Return whether a shortcut string is non-empty; Pi validates exact key syntax at registration. */
function isKeyboardShortcut(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Return whether a value is a supported Pi thinking level. */
function isThinkingLevel(
  value: unknown,
): value is NonNullable<CoreSubagentSettings["fast"]>["thinkingLevel"] {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

/** Return whether a value is a known permission mode. */
function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "safe" || value === "trusted" || value === "open" || value === "permissive";
}

/** Return whether a value is a known permission rule action. */
function isRuleAction(value: unknown): value is RuleAction {
  return value === "allow" || value === "ask" || value === "deny";
}

/** Return whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
