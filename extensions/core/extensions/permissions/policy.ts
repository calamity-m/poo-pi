import { sep } from "node:path";

import {
  allSegmentsCovered,
  anySegmentMatches,
  bashGrantCovers,
  bashRuleMatches,
  denyMatches,
  splitBashSegments,
} from "./bash.ts";
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
 * Applied per-segment: every segment of a compound command must be covered.
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
 *
 * DENY semantics: matched against both each segment AND the whole command string.
 * The whole-command match preserves pipe-spanning patterns (e.g. `curl[^|]*|bash`).
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
 * Applies in `open` and `permissive` mode `.env` checks and when mapping bash targets.
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

/** The string form of a target used for non-bash rule/grant regex matching. */
function targetString(target: ResolvedTarget): string {
  if (target.kind === "path") return target.resolvedPath;
  if (target.kind === "bash") return target.command;
  return target.toolName;
}

/**
 * Return true if any config rule with the given action covers this (tool, target).
 * Used for non-bash (path/other) targets only.
 */
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
 * For bash targets, commands are split into segments once and all matching
 * (config rules, grants, built-in patterns) uses segment-aware quantifiers:
 *   - ALLOW requires every segment covered (no unsafe substitution).
 *   - ASK fires if any segment matches.
 *   - DENY fires if any segment matches OR the whole command matches
 *     (the whole-command check preserves pipe-spanning deny patterns like `curl|bash`).
 *
 * Precedence by mode:
 *
 * **safe / trusted**:
 *   1. .env path target without explicit config allow          → DENY
 *   2. config DENY rule matches                                → DENY
 *   3. config ASK rule matches                                 → ASK
 *   4. config ALLOW rule OR remembered grant covers all segs   → ALLOW
 *   5. mode default for (tool, target)                        → allow | ask | deny
 *
 * **open**: allow everything except .env (path or bash isEnvAccess) with no
 * explicit config allow. Config rules are otherwise ignored.
 *
 * **permissive**: allow-by-default with config rule honoring. Inverted ask/allow
 * ordering vs safe/trusted (grants/allow override ask):
 *   1. .env target (path isEnv or bash isEnvAccess) without explicit config allow → DENY
 *   2. config DENY rule matches                                → DENY
 *   3. config ALLOW rule OR remembered grant covers all segs   → ALLOW  ← before ASK
 *   4. config ASK rule matches                                 → ASK
 *   5. default                                                 → ALLOW
 *
 * The caller is responsible for converting `!hasUI` → `"open"` before calling.
 *
 * @param mode - Effective permission mode.
 * @param rules - Compiled config rules from centralized core settings.
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

  // Split bash segments exactly once and thread through all matchers below.
  const isBash = target.kind === "bash";
  const bashCmd = isBash ? target.command : "";
  const bashSegs = isBash ? splitBashSegments(target.command) : [];

  // ── open mode ────────────────────────────────────────────────────────────────
  if (mode === "open") {
    // open ignores all rules except the .env default-deny
    const isEnvTarget =
      (target.kind === "path" && target.isEnv) || (target.kind === "bash" && target.isEnvAccess);
    if (isEnvTarget && !ruleMatches(rules, "allow", toolName, tStr)) return "deny";
    return "allow";
  }

  // ── permissive mode ──────────────────────────────────────────────────────────
  if (mode === "permissive") {
    // Step 1: .env deny mirrors open (both path isEnv and bash isEnvAccess)
    const isEnvTarget =
      (target.kind === "path" && target.isEnv) || (target.kind === "bash" && target.isEnvAccess);
    if (isEnvTarget) {
      const hasAllowRule = isBash
        ? bashRuleMatches(rules, "allow", toolName, bashCmd, bashSegs)
        : ruleMatches(rules, "allow", toolName, tStr);
      if (!hasAllowRule) return "deny";
    }

    // Step 2: config DENY
    const isDenied = isBash
      ? bashRuleMatches(rules, "deny", toolName, bashCmd, bashSegs)
      : ruleMatches(rules, "deny", toolName, tStr);
    if (isDenied) return "deny";

    // Step 3: config ALLOW or grant (before ASK — grants override the ask-list in permissive)
    const isAllowed = isBash
      ? bashRuleMatches(rules, "allow", toolName, bashCmd, bashSegs)
      : ruleMatches(rules, "allow", toolName, tStr);
    if (isAllowed) return "allow";
    for (const grant of remembered) {
      const covered = isBash
        ? bashGrantCovers(grant, toolName, bashCmd, bashSegs)
        : grantCovers(grant, toolName, target);
      if (covered) return "allow";
    }

    // Step 4: config ASK
    const isAsked = isBash
      ? bashRuleMatches(rules, "ask", toolName, bashCmd, bashSegs)
      : ruleMatches(rules, "ask", toolName, tStr);
    if (isAsked) return "ask";

    // Step 5: default → allow
    return "allow";
  }

  // ── safe | trusted ───────────────────────────────────────────────────────────

  // Step 1: .env path target default-deny (override-able by explicit config allow)
  if (target.kind === "path" && target.isEnv) {
    if (!ruleMatches(rules, "allow", toolName, tStr)) return "deny";
  }

  // Step 2: config DENY
  const isDenied = isBash
    ? bashRuleMatches(rules, "deny", toolName, bashCmd, bashSegs)
    : ruleMatches(rules, "deny", toolName, tStr);
  if (isDenied) return "deny";

  // Step 3: config ASK
  const isAsked = isBash
    ? bashRuleMatches(rules, "ask", toolName, bashCmd, bashSegs)
    : ruleMatches(rules, "ask", toolName, tStr);
  if (isAsked) return "ask";

  // Step 4: config ALLOW or remembered grant
  const isAllowed = isBash
    ? bashRuleMatches(rules, "allow", toolName, bashCmd, bashSegs)
    : ruleMatches(rules, "allow", toolName, tStr);
  if (isAllowed) return "allow";
  for (const grant of remembered) {
    const covered = isBash
      ? bashGrantCovers(grant, toolName, bashCmd, bashSegs)
      : grantCovers(grant, toolName, target);
    if (covered) return "allow";
  }

  // Step 5: mode default
  return modeDefault(mode, toolName, target, cwd, bashSegs);
}

/**
 * Mode default (step 5) for safe/trusted when no explicit rule or grant matched.
 * Uses segment-aware quantifiers for bash targets.
 */
function modeDefault(
  mode: "safe" | "trusted",
  toolName: string,
  target: ResolvedTarget,
  cwd: string,
  bashSegs: string[],
): Decision {
  if (mode === "safe") {
    return SAFE_ALLOW_TOOLS.has(toolName) ? "allow" : "ask";
  }

  // trusted
  if (target.kind === "path") {
    return isWithinDir(target.resolvedPath, cwd) ? "allow" : "ask";
  }
  if (target.kind === "bash") {
    // DENY: any segment matches a deny pattern, OR the whole command does
    // (whole-command check preserves pipe-spanning patterns like curl|bash).
    if (denyMatches(target.command, bashSegs, TRUSTED_BASH_DENY_PATTERNS)) return "deny";
    // ALLOW: every segment covered by an allow pattern
    if (allSegmentsCovered(bashSegs, TRUSTED_BASH_ALLOW_PATTERNS)) return "allow";
    return "ask";
  }
  // custom/other tools → ask
  return "ask";
}

// Re-export for callers that only need the segment helpers (e.g. tests)
export { anySegmentMatches, allSegmentsCovered, denyMatches };
