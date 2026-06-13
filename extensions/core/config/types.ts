import type { RedactionMode } from "../extensions/proxy/types.ts";
import type { PersistedPermissionConfig } from "../extensions/permissions/types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Current version of the centralized core settings file. */
export type CoreSettingsVersion = 1;

/** Proxy settings persisted by core. */
export interface CoreProxySettings {
  /** Proxy audit settings. */
  audit?: {
    /** Whether sensitive request headers are redacted in audit records. */
    redact?: RedactionMode;
  };
}

/** Persisted model/thinking mapping for one subagent tier. */
export interface SubagentModelMapping {
  /** Canonical model id in provider/model-id form. */
  model: string;
  /** Optional thinking level to use for this tier. */
  thinkingLevel?: ThinkingLevel;
}

/** Subagent model tier settings persisted by core. */
export interface CoreSubagentSettings {
  /** Low-latency subagent model mapping. */
  fast?: SubagentModelMapping;
  /** Higher-capability subagent model mapping. */
  high?: SubagentModelMapping;
}

/** History search settings persisted by core. */
export interface CoreHistorySearchSettings {
  /** Keyboard shortcut registered by the history command. */
  shortcut?: string;
}

/** Managed worktree settings persisted by core. */
export interface CoreWorktreeSettings {
  /** Managed root under which `add_git_worktree` creates worktrees; `~` is expanded at runtime. */
  root?: string;
}

/** Footer settings persisted by core. */
export interface CoreFooterSettings {
  /** Whether the core status footer should replace Pi's default footer. */
  enabled?: boolean;
  /** Template rendered by the core status footer. */
  template?: string;
}

/** Unified centralized settings for the poo-pi core extension bundle. */
export interface CoreSettings {
  /** Settings schema version. */
  version: CoreSettingsVersion;
  /** Tool permission settings. */
  permissions?: PersistedPermissionConfig;
  /** Provider proxy settings. */
  proxy?: CoreProxySettings;
  /** Isolated subagent model tier settings. */
  subagents?: CoreSubagentSettings;
  /** User-message history search settings. */
  historySearch?: CoreHistorySearchSettings;
  /** Core status footer settings. */
  footer?: CoreFooterSettings;
  /** Managed Git worktree settings. */
  worktrees?: CoreWorktreeSettings;
}
