/** Active permission mode for the current session. */
export type PermissionMode = "safe" | "trusted" | "open" | "permissive";

/** Permission modes that own persisted rule/grant blocks. */
export type NonOpenPermissionMode = Exclude<PermissionMode, "open">;

/** Stable list of persisted mode-block keys. */
export const NON_OPEN_PERMISSION_MODES: readonly NonOpenPermissionMode[] = [
  "safe",
  "trusted",
  "permissive",
];

/** Action outcome for a policy rule. */
export type RuleAction = "allow" | "ask" | "deny";

/** Decision outcome from the policy engine. */
export type Decision = "allow" | "ask" | "deny";

/** A human-authored config rule stored in centralized core settings. */
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

/** Rules and grants persisted for one non-open permission mode. */
export interface ModePermissionConfig {
  /** Human-authored rules for this mode block. */
  rules?: Rule[];
  /** Machine-written or hand-authored grants for this mode block. */
  remembered?: RememberedGrant[];
}

/** Permissions section shape inside global or project-local core settings. */
export interface PersistedPermissionConfig {
  /** Active/default mode for this scope; optional so local grants need not pin mode. */
  mode?: PermissionMode;
  /** Rules and grants used when safe is active. */
  safe?: ModePermissionConfig;
  /** Rules and grants used when trusted is active. */
  trusted?: ModePermissionConfig;
  /** Rules and grants used when permissive is active. */
  permissive?: ModePermissionConfig;
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

/** One compiled permissions scope in the effective project/global merge. */
export interface CompiledPermissionScope {
  /** Compiled rules active for the selected mode. */
  rules: CompiledRule[];
  /** Compiled remembered grants active for the selected mode. */
  remembered: CompiledGrant[];
}

/** Diagnostic metadata for the effective permissions merge. */
export interface PermissionSourceMetadata {
  /** Cwd used as the project-local config root. */
  cwd: string;
  /** Whether project-local permissions were eligible to load. */
  projectTrusted: boolean;
  /** Whether the active mode came from project, global, or built-in defaults. */
  modeSource: "project" | "global" | "default";
  /** Project-local settings file path. */
  projectPath: string;
  /** Global settings file path. */
  globalPath: string;
  /** Reason project-local permissions were ignored, if any. */
  ignoredProjectReason?: string;
  /** Reason global permissions fell back to built-in defaults, if any. */
  ignoredGlobalReason?: string;
  /** Global default mode even when shadowed by a project-local mode. */
  globalMode?: PermissionMode;
  /** Rule/grant counts and replacement notes for each compiled scope. */
  counts: {
    project: { rules: number; remembered: number };
    global: { rules: number; remembered: number };
    overriddenRules: string[];
    overriddenGrants: string[];
  };
}

/** In-memory permission state; process-global and reload-stable. */
export interface PermissionState {
  mode: PermissionMode;
  /** Flattened active rules retained for display and legacy pure-policy callers. */
  rules: CompiledRule[];
  /** Flattened active grants retained for display and legacy pure-policy callers. */
  remembered: CompiledGrant[];
  /** Project-local compiled scope, evaluated before global when present. */
  projectScope?: CompiledPermissionScope;
  /** Global compiled scope. */
  globalScope?: CompiledPermissionScope;
  /** Source and merge metadata for UI/status messages. */
  metadata?: PermissionSourceMetadata;
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
