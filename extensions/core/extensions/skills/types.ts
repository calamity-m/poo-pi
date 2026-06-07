import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** Supported ordering modes for the interactive skills browser. */
export type SkillSortMode = "scope" | "name" | "tokens";

/** Persisted usage counters and timestamps for a skill. */
export interface SkillStats {
  userUsed: number;
  agentLoaded: number;
  lastUser?: string;
  lastAgent?: string;
  paths: string[];
}

/** Versioned on-disk shape for skill usage statistics. */
export interface SkillStatsFile {
  version: 1;
  skills: Record<string, SkillStats>;
}

/** Normalized lookup entry for a discoverable skill command. */
export interface SkillIndexEntry {
  name: string;
  path: string;
}

/** Name and path indexes used to match user commands and agent reads. */
export interface SkillIndex {
  byName: Map<string, SkillIndexEntry>;
  byPath: Map<string, SkillIndexEntry>;
}

/** Skill metadata displayed in the browser panel. */
export interface SkillRow {
  name: string;
  description: string;
  path: string;
  scope: string;
  status: "on" | "user-only";
  tokens: number;
  stats: SkillStats;
}

/** Minimal color surface required by the skills browser. */
export interface SkillsTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/** Skill command with the source metadata expected for package skills. */
export type SkillCommand = SlashCommandInfo;
