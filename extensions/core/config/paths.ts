import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Project-local relative path for unified core settings. */
export const CORE_SETTINGS_RELATIVE_PATH = join(".pi", "core-settings.json");

/** Return the absolute path to `.pi/core-settings.json` for a working directory. */
export function coreSettingsPath(cwd: string): string {
  return join(cwd, CORE_SETTINGS_RELATIVE_PATH);
}

/** Return Pi's user-scoped agent directory, honoring Pi's documented override. */
export function agentDirPath(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Return the user-scoped core settings path used for package defaults. */
export function globalCoreSettingsPath(): string {
  return join(agentDirPath(), "core-settings.json");
}

/** Infer the project working directory from `<cwd>/.pi/proxy-audit`. */
export function cwdFromProxyAuditDir(auditDir: string): string {
  return resolve(dirname(dirname(auditDir)));
}
