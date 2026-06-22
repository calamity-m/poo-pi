import { homedir } from "node:os";
import { join } from "node:path";

/** Project-local Pi config directory; replace with Pi's public CONFIG_DIR_NAME when exported. */
export const PROJECT_CONFIG_DIR_NAME = ".pi";

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

/** Return the project-local package-owned config directory for a cwd. */
export function projectCoreConfigDirPath(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_DIR_NAME, CORE_CONFIG_DIR_NAME);
}

/** Return the project-local core settings path for permissions overrides. */
export function projectCoreSettingsPath(cwd: string): string {
  return join(projectCoreConfigDirPath(cwd), CORE_SETTINGS_FILE_NAME);
}
