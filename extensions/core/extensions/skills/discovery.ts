import { readFileSync } from "node:fs";
import { normalize, resolve } from "node:path";

import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import type { SkillIndex, SkillIndexEntry, SkillRow, SkillStatsFile } from "./types.ts";

/** Estimate prompt tokens from text with a conservative four-characters-per-token heuristic. */
export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** Read a skill file frontmatter flag to determine whether the model may invoke it automatically. */
export function readSkillStatus(path: string): "on" | "user-only" {
  try {
    const text = readFileSync(path, "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    return frontmatter?.[1]?.match(/^disable-model-invocation:\s*true\s*$/m) ? "user-only" : "on";
  } catch {
    return "on";
  }
}

/** Return an absolute normalized path using the current session cwd for relative paths. */
export function normalizeSkillPath(path: string, cwd: string): string {
  return normalize(path.startsWith("/") ? path : resolve(cwd, path));
}

/** Build lookup indexes for all currently available skill commands. */
export function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndex {
  const byName = new Map<string, SkillIndexEntry>();
  const byPath = new Map<string, SkillIndexEntry>();

  for (const command of pi.getCommands().filter((command) => command.source === "skill")) {
    const name = command.name.replace(/^skill:/, "");
    const path = normalizeSkillPath(command.sourceInfo.path, cwd);
    const entry = { name, path };
    byName.set(name, entry);
    byPath.set(path, entry);
  }

  return { byName, byPath };
}

/** Render a short source label for a skill command. */
export function skillScopeLabel(command: SlashCommandInfo): string {
  const info = command.sourceInfo;
  if (info.scope === "project") return "project";
  if (info.scope === "temporary") return "temporary";
  if (info.origin === "package") return "installed";
  return "user";
}

/** Convert a Pi skill command into a browser row with stats attached. */
export function toSkillRow(command: SlashCommandInfo, stats: SkillStatsFile): SkillRow {
  const name = command.name.replace(/^skill:/, "");
  const description = command.description ?? "";
  const path = command.sourceInfo.path;
  return {
    name,
    description,
    path,
    scope: skillScopeLabel(command),
    status: readSkillStatus(path),
    tokens: estimateTokens(
      `<skill><name>${name}</name><description>${description}</description><location>${path}</location></skill>`,
    ),
    stats: stats.skills[name] ?? { userUsed: 0, agentLoaded: 0, paths: [] },
  };
}
