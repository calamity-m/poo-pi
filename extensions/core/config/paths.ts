import { dirname, join, resolve } from "node:path";

/** Project-local relative path for unified core settings. */
export const CORE_SETTINGS_RELATIVE_PATH = join(".pi", "core-settings.json");

/** Return the absolute path to `.pi/core-settings.json` for a working directory. */
export function coreSettingsPath(cwd: string): string {
  return join(cwd, CORE_SETTINGS_RELATIVE_PATH);
}

/** Infer the project working directory from `<cwd>/.pi/proxy-audit`. */
export function cwdFromProxyAuditDir(auditDir: string): string {
  return resolve(dirname(dirname(auditDir)));
}
