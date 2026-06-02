import { sep } from "node:path";

import type {
  CompiledGrant,
  CompiledRule,
  Decision,
  PermissionMode,
  ResolvedTarget,
} from "./types.ts";

// ── Mode-default constants ────────────────────────────────────────────────────
// These are the authoritative source of truth for the showcase panel in
// register.ts — build the showcase from these exports, not from hand-written text.

/** Tools auto-allowed in `safe` mode (read-family). Everything else → ask. */
export const SAFE_ALLOW_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "ls", "find"]);

/**
 * Bash command patterns auto-allowed in `trusted` mode.
 * Checked only after all config rules pass (step 5 mode default).
 */
export const TRUSTED_BASH_ALLOW_PATTERNS: readonly RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^pwd$/,
  /^echo\b/,
  /^which\b/,
  /^type\b/,
  /^man\b/,
  /^git\s+(log|status|diff|show|branch|fetch|pull)\b/,
  /^cargo\s+(check|build|test|clippy|fmt)\b/,
  /^npm\s+(run|test|install|ci|ls|outdated)\b/,
  /^node\b/,
  /^tsc\b/,
  /^prettier\b/,
  /^oxlint\b/,
  /^oxfmt\b/,
];

/**
 * Bash command patterns denied in `trusted` mode default.
 * Applied in step 5 (mode default) so config ALLOW rules can override them.
 * Separate from the `.env` path-tool default-deny (step 1).
 */
export const TRUSTED_BASH_DENY_PATTERNS: readonly RegExp[] = [
  /rm\s+-rf/,
  /\bcat\s+\.env(?!\S)/, // best-effort .env read via bash (not .env.example)
  /curl[^|]*\|\s*(bash|sh)\b/, // curl-pipe-to-shell
  /wget[^|]*\|\s*(bash|sh)\b/, // wget-pipe-to-shell
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return true if the given basename refers to a `.env` file.
 * `.env.example` is treated as an env file by this check; an explicit config allow
 * rule (e.g. `pattern: "\\.env\\.example$"`) is the intended way to permit it.
 */
export function isEnvBasename(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Return true if the bash command likely accesses a `.env` file.
 * Best-effort; bypassable via obfuscation (`c''at .env`, env vars, etc.).
 * Applies in `open` mode's `.env` check and when mapping bash targets.
 */
export function isBashEnvAccess(command: string): boolean {
  // (?!\S) ensures .env is at the end or followed by whitespace, not .env.example
  return /\bcat\s+\.env(?!\S)|\bless\s+\.env(?!\S)|\bmore\s+\.env(?!\S)/.test(command);
}

/**
 * Return true if `target` is within `dir` at a path-segment boundary.
 * A raw string-prefix check (`startsWith`) would match `/repo/src2` for dir `/repo/src`.
 * This ensures only paths inside `dir` or equal to it qualify.
 */
export function isWithinDir(target: string, dir: string): boolean {
  const withSep = dir.endsWith(sep) ? dir : dir + sep;
  return target === dir || target.startsWith(withSep);
}

/** Run a regex against a target, swallowing any runtime error (ReDoS accepted risk). */
function safeTest(regex: RegExp, target: string): boolean {
  try {
    return regex.test(target);
  } catch {
    return false;
  }
}

/** The string form of a target used for rule/grant regex matching. */
function targetString(target: ResolvedTarget): string {
  if (target.kind === "path") return target.resolvedPath;
  if (target.kind === "bash") return target.command;
  return target.toolName;
}

/** Return true if any config rule with the given action covers this (tool, target). */
function ruleMatches(
  rules: CompiledRule[],
  action: "allow" | "ask" | "deny",
  toolName: string,
  tStr: string,
): boolean {
  for (const rule of rules) {
    if (rule.action !== action) continue;
    if (rule.tool !== toolName && rule.tool !== "*") continue;
    if (safeTest(rule.regex, tStr)) return true;
  }
  return false;
}

/** Return true if any remembered grant covers this (tool, target) pair. */
function grantCovers(grant: CompiledGrant, toolName: string, target: ResolvedTarget): boolean {
  if (grant.tool !== toolName && grant.tool !== "*") return false;
  if (target.kind === "path" && grant.dirPrefix !== undefined) {
    return isWithinDir(target.resolvedPath, grant.dirPrefix);
  }
  if (target.kind === "bash" && grant.regex !== undefined) {
    return safeTest(grant.regex, target.command);
  }
  return false;
}

// ── Policy engine ─────────────────────────────────────────────────────────────

/**
 * Pure policy decision engine. All inputs must be pre-normalized; no I/O.
 *
 * Precedence (safe/trusted modes):
 *   1. .env path target without explicit config allow          → DENY
 *   2. config DENY rule matches                                → DENY
 *   3. config ASK rule matches                                 → ASK
 *   4. config ALLOW rule OR remembered grant matches           → ALLOW
 *   5. mode default for (tool, target)                        → allow | ask | deny
 *
 * `open` mode short-circuits: allow everything except .env (path or bash) with
 * no explicit config allow rule.
 *
 * The caller is responsible for converting `!hasUI` → `"open"` before calling.
 *
 * @param mode - Effective permission mode.
 * @param rules - Compiled config rules from `.pi/core-permissions.json`.
 * @param remembered - Compiled "Always For This Project" grants.
 * @param toolName - Name of the tool being invoked.
 * @param target - Pre-normalized resolved target.
 * @param cwd - Project root used for trusted cwd-containment checks.
 */
export function decide(
  mode: PermissionMode,
  rules: CompiledRule[],
  remembered: CompiledGrant[],
  toolName: string,
  target: ResolvedTarget,
  cwd: string,
): Decision {
  const tStr = targetString(target);

  if (mode === "open") {
    // open ignores all rules except the .env default-deny
    const isEnvTarget =
      (target.kind === "path" && target.isEnv) || (target.kind === "bash" && target.isEnvAccess);
    if (isEnvTarget && !ruleMatches(rules, "allow", toolName, tStr)) return "deny";
    return "allow";
  }

  // safe | trusted

  // 1. .env path target default-deny (override-able by explicit config allow)
  if (target.kind === "path" && target.isEnv) {
    if (!ruleMatches(rules, "allow", toolName, tStr)) return "deny";
  }

  // 2. Config DENY
  if (ruleMatches(rules, "deny", toolName, tStr)) return "deny";

  // 3. Config ASK
  if (ruleMatches(rules, "ask", toolName, tStr)) return "ask";

  // 4. Config ALLOW or remembered grant
  if (ruleMatches(rules, "allow", toolName, tStr)) return "allow";
  for (const grant of remembered) {
    if (grantCovers(grant, toolName, target)) return "allow";
  }

  // 5. Mode default
  return modeDefault(mode, toolName, target, cwd);
}

/** Mode default (step 5) for safe/trusted when no explicit rule or grant matched. */
function modeDefault(
  mode: PermissionMode,
  toolName: string,
  target: ResolvedTarget,
  cwd: string,
): Decision {
  if (mode === "safe") {
    return SAFE_ALLOW_TOOLS.has(toolName) ? "allow" : "ask";
  }

  // trusted
  if (target.kind === "path") {
    return isWithinDir(target.resolvedPath, cwd) ? "allow" : "ask";
  }
  if (target.kind === "bash") {
    // Hardcoded deny patterns take priority over allow patterns at the mode-default level
    if (TRUSTED_BASH_DENY_PATTERNS.some((r) => safeTest(r, target.command))) return "deny";
    if (TRUSTED_BASH_ALLOW_PATTERNS.some((r) => safeTest(r, target.command))) return "allow";
    return "ask";
  }
  // custom/other tools → ask
  return "ask";
}
