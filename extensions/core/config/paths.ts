import { homedir } from "node:os";
import { join } from "node:path";

/** Package-owned settings directory below Pi's user-scoped agent directory. */
export const CORE_CONFIG_DIR_NAME = "poo";

/** File name for unified poo-pi core settings. */
export const CORE_SETTINGS_FILE_NAME = "core-settings.json";

/** Return Pi's user-scoped agent directory, honoring Pi's documented override. */
export function agentDirPath(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Return the package-owned config directory: `~/.pi/agent/poo`. */
export function coreConfigDirPath(): string {
  return join(agentDirPath(), CORE_CONFIG_DIR_NAME);
}

/** Return the centralized core settings path; cwd is accepted for legacy callers. */
export function coreSettingsPath(_cwd?: string): string {
  return join(coreConfigDirPath(), CORE_SETTINGS_FILE_NAME);
}

/** Return the centralized core settings path used for package defaults. */
export function globalCoreSettingsPath(): string {
  return coreSettingsPath();
}
