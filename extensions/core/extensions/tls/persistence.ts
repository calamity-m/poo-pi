import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  hasCoreClientTlsConfig,
  readCoreClientTlsTarget,
  writeCoreClientTlsTarget,
} from "../../config/persistence.ts";

import type { SourceTarget } from "./types.ts";

/** Read non-secret source target metadata from unified core settings. */
export async function readPersistedTarget(
  ctx: ExtensionContext,
): Promise<SourceTarget | undefined> {
  return readCoreClientTlsTarget(ctx.cwd);
}

/** Persist only source target metadata after a successful load; never write passphrases or cert bytes. */
export async function writePersistedTarget(
  ctx: ExtensionContext,
  target: SourceTarget,
): Promise<void> {
  await writeCoreClientTlsTarget(ctx.cwd, target);
}

/** Expose whether this process currently has project-local TLS metadata, for smoke checks only. */
export function hasPersistedClientTlsConfig(cwd: string): boolean {
  return hasCoreClientTlsConfig(cwd);
}
