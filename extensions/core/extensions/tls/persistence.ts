import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SourceTarget } from "./types.ts";

const CONFIG_PATH = join(".pi", "core-client-tls.json");

/** Read non-secret source target metadata from the project-local config file. */
export async function readPersistedTarget(
  ctx: ExtensionContext,
): Promise<SourceTarget | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configFilePath(ctx), "utf8"));
    if (isSourceTarget(parsed)) return parsed;
  } catch {
    // Absence or malformed local metadata should naturally fall back to the setup wizard.
  }
  return undefined;
}

/** Persist only source target metadata after a successful load; never write passphrases or cert bytes. */
export async function writePersistedTarget(
  ctx: ExtensionContext,
  target: SourceTarget,
): Promise<void> {
  const file = configFilePath(ctx);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
}

/** Expose whether this process currently has the project-local TLS config file, for smoke checks only. */
export function hasPersistedClientTlsConfig(cwd: string): boolean {
  return existsSync(join(cwd, CONFIG_PATH));
}

/** Return the project-local TLS config path. */
function configFilePath(ctx: ExtensionContext): string {
  return join(ctx.cwd, CONFIG_PATH);
}

/** Check whether an unknown JSON value is a persisted SourceTarget. */
function isSourceTarget(value: unknown): value is SourceTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.sourceId === "string" &&
    typeof target.locator === "string" &&
    typeof target.label === "string"
  );
}
