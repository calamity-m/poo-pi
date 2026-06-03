import type { CoreSettings } from "./types.ts";

/** Current unified core settings schema version. */
export const CORE_SETTINGS_VERSION = 1;

/** Build an empty core settings object. */
export function createDefaultCoreSettings(): CoreSettings {
  return { version: CORE_SETTINGS_VERSION };
}
