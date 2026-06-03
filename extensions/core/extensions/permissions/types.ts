/** Active permission mode for the current project. */
export type PermissionMode = "safe" | "trusted" | "open" | "permissive";

/** Action outcome for a policy rule. */
export type RuleAction = "allow" | "ask" | "deny";

/** Decision outcome from the policy engine. */
export type Decision = "allow" | "ask" | "deny";

/** A human-authored config rule stored in `.pi/core-settings.json`. */
export interface Rule {
  /** Tool name or `"*"` to match all tools. */
  tool: string;
  action: RuleAction;
  /** Regex pattern string matched against the target (resolved path or bash command). */
  pattern: string;
}

/**
 * A machine-written "Always For This Project" grant.
 * Carries either a directory prefix (path tools) or a compiled regex (bash).
 */
export interface RememberedGrant {
  /** Tool this grant applies to. */
  tool: string;
  /** Absolute directory prefix for path tools; covers the dir and all subdirs. */
  dirPrefix?: string;
  /** Anchored regex string for bash commands (usually a flag-stop command prefix). */
  pattern?: string;
}

/** Permissions section shape inside `.pi/core-settings.json`. */
export interface PersistedPermissionConfig {
  mode: PermissionMode;
  rules: Rule[];
  remembered: RememberedGrant[];
}

/** Rule with precompiled regex for hot-path matching. */
export interface CompiledRule {
  tool: string;
  action: RuleAction;
  pattern: string;
  regex: RegExp;
}

/** RememberedGrant with precompiled regex for bash patterns. */
export interface CompiledGrant {
  tool: string;
  dirPrefix?: string;
  pattern?: string;
  regex?: RegExp;
}

/** In-memory permission state; process-global and reload-stable. */
export interface PermissionState {
  mode: PermissionMode;
  rules: CompiledRule[];
  remembered: CompiledGrant[];
}

/** A resolved path-tool target (read/write/edit/grep/find/ls). */
export interface PathTarget {
  kind: "path";
  /** Raw input path from the event. */
  rawPath: string;
  /**
   * Absolute real path, with symlinks resolved via nearest-existing-parent fallback.
   * Safe to use for containment checks and rule matching.
   */
  resolvedPath: string;
  /**
   * True if the basename is `.env` or starts with `.env.`.
   * Does NOT reflect whether the tool would recurse into a directory containing .env files.
   */
  isEnv: boolean;
}

/** A resolved bash target. */
export interface BashTarget {
  kind: "bash";
  command: string;
  /**
   * True if the command likely accesses a .env file (best-effort regex check).
   * Bypassable via obfuscation — treated as defense-in-depth, not a guarantee.
   */
  isEnvAccess: boolean;
}

/**
 * An unknown or custom tool target.
 * Defaults to "ask" in safe/trusted, "allow" in open.
 */
export interface OtherTarget {
  kind: "other";
  toolName: string;
}

export type ResolvedTarget = PathTarget | BashTarget | OtherTarget;
