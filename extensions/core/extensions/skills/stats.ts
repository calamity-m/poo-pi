import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SkillStatsFile } from "./types.ts";

/** User-level path used for persisted skills usage statistics. */
export const SKILL_STATS_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "poo-pi",
  "skill-stats.json",
);

/** Create an empty versioned stats file value. */
export function emptyStatsFile(): SkillStatsFile {
  return { version: 1, skills: {} };
}

/** Read persisted skill usage stats, falling back to an empty value when unavailable. */
export function readSkillStats(): SkillStatsFile {
  try {
    const parsed = JSON.parse(readFileSync(SKILL_STATS_PATH, "utf8")) as SkillStatsFile;
    return parsed.version === 1 && parsed.skills ? parsed : emptyStatsFile();
  } catch {
    return emptyStatsFile();
  }
}

/** Write skill usage stats to the package-specific user stats file. */
export function writeSkillStats(stats: SkillStatsFile): void {
  mkdirSync(dirname(SKILL_STATS_PATH), { recursive: true });
  writeFileSync(SKILL_STATS_PATH, `${JSON.stringify(stats, null, "\t")}\n`);
}

/** Record that a skill was either selected by the user or loaded by the agent. */
export function recordSkillUsage(
  name: string,
  path: string | undefined,
  kind: "user" | "agent",
): void {
  const stats = readSkillStats();
  const entry = (stats.skills[name] ??= { userUsed: 0, agentLoaded: 0, paths: [] });
  if (path && !entry.paths.includes(path)) entry.paths.push(path);

  const now = new Date().toISOString();
  if (kind === "user") {
    entry.userUsed++;
    entry.lastUser = now;
  } else {
    entry.agentLoaded++;
    entry.lastAgent = now;
  }

  writeSkillStats(stats);
}

/** Format an optional ISO timestamp for compact panel display. */
export function formatSeen(value: string | undefined): string {
  return value ? value.replace("T", " ").replace(/\.\d{3}Z$/, "Z") : "never";
}
