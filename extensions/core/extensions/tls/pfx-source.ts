import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { promptHiddenSecret } from "./tui.ts";
import type { ClientTlsSource, ClientTlsState, PassphraseProvider, SourceTarget } from "./types.ts";

export const PFX_SOURCE_ID = "pfx-file";

/** Create the only implemented certificate source for this iteration: password-protected PFX/P12 files. */
export function createPfxFileSource(): ClientTlsSource {
  return {
    id: PFX_SOURCE_ID,
    label: "PFX/P12 file",
    priority: 10,
    needsPassphrase: true,
    chooseTarget: choosePfxTarget,
    validateTarget: validatePfxTarget,
    load: loadPfxTarget,
  };
}

/** Create the interactive hidden passphrase provider; future pass/keyring providers plug into the same seam. */
export function createInteractivePassphraseProvider(): PassphraseProvider {
  return {
    canProvide: (ctx) => ctx.hasUI,
    getPassphrase: (ctx, prompt) => promptHiddenSecret(ctx, prompt),
  };
}

/** Stage-2 PFX chooser with a simple browser and manual path fallback. */
async function choosePfxTarget(ctx: ExtensionContext): Promise<SourceTarget | undefined> {
  const mode = await ctx.ui.select("Choose PFX/P12 certificate", [
    "Enter path manually",
    "Browse current directory",
    "Browse home directory",
  ]);
  if (!mode) return undefined;
  const path =
    mode === "Enter path manually"
      ? await promptForPfxPath(ctx)
      : await browseForPfxPath(ctx, mode === "Browse home directory" ? homedir() : ctx.cwd);
  if (!path) return undefined;
  const locator = normalizePath(ctx, path);
  return { sourceId: PFX_SOURCE_ID, locator, label: basename(locator) };
}

/** Ask for a PFX/P12 path; this fallback keeps setup usable if the browser is too limited. */
async function promptForPfxPath(ctx: ExtensionContext): Promise<string | undefined> {
  const value = await ctx.ui.input("Path to .pfx/.p12 client certificate", "./client.p12");
  return value?.trim() || undefined;
}

/** Browse directories with a PFX/P12 extension filter and explicit navigation entries. */
async function browseForPfxPath(
  ctx: ExtensionContext,
  startDir: string,
): Promise<string | undefined> {
  let current = normalizePath(ctx, startDir);
  for (;;) {
    const entries = await listPfxBrowserEntries(current);
    const selected = await ctx.ui.select(
      `Choose PFX/P12 in ${basename(current) || current}`,
      entries.map((entry) => entry.label),
    );
    if (!selected) return undefined;
    const entry = entries.find((candidate) => candidate.label === selected);
    if (!entry) return undefined;
    if (entry.kind === "manual") return promptForPfxPath(ctx);
    if (entry.kind === "up") {
      current = dirname(current);
      continue;
    }
    if (entry.kind === "directory") {
      current = entry.path;
      continue;
    }
    if (entry.kind === "file") return entry.path;
    return undefined;
  }
}

/** Return browser entries, filtering files to PFX/P12 while keeping directory navigation visible. */
async function listPfxBrowserEntries(
  directory: string,
): Promise<
  Array<
    | { label: string; kind: "manual" | "up" }
    | { label: string; kind: "directory" | "file"; path: string }
  >
> {
  const entries: Array<
    | { label: string; kind: "manual" | "up" }
    | { label: string; kind: "directory" | "file"; path: string }
  > = [
    { label: "Enter path manually", kind: "manual" },
    { label: "..", kind: "up" },
  ];
  try {
    const names = await readdir(directory, { withFileTypes: true });
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory())
        entries.push({ label: `${entry.name}/`, kind: "directory", path: fullPath });
      if (entry.isFile() && isPfxPath(entry.name))
        entries.push({ label: entry.name, kind: "file", path: fullPath });
    }
  } catch {
    // Keep the manual fallback available without exposing filesystem errors or paths in UI output.
  }
  return entries;
}

/** Validate a persisted PFX target without logging or surfacing its full path. */
async function validatePfxTarget(_ctx: ExtensionContext, target: SourceTarget): Promise<boolean> {
  if (target.sourceId !== PFX_SOURCE_ID || !isPfxPath(target.locator)) return false;
  try {
    const info = await stat(target.locator);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Load a PFX/P12 into a SecureContext while dropping raw bytes and passphrase after each validation attempt. */
async function loadPfxTarget(
  ctx: ExtensionContext,
  target: SourceTarget,
  passphraseProvider: PassphraseProvider,
): Promise<ClientTlsState> {
  let pfx: Buffer;
  try {
    pfx = await readFile(target.locator);
  } catch {
    return {
      status: "error",
      sourceId: PFX_SOURCE_ID,
      message: "tls: unable to read client certificate",
    };
  }

  for (;;) {
    const passphrase = await passphraseProvider.getPassphrase(
      ctx,
      `Passphrase for ${target.label}`,
    );
    if (passphrase === undefined) return { status: "unconfigured" };
    const secureContext = validatePfxPassphrase(pfx, passphrase);
    if (secureContext) {
      return {
        status: "loaded",
        tls: {
          sourceId: PFX_SOURCE_ID,
          targetLabel: target.label,
          secureContext,
          metadata: {},
        },
      };
    }

    if (!ctx.hasUI)
      return {
        status: "error",
        sourceId: PFX_SOURCE_ID,
        message: "tls: invalid client certificate passphrase",
      };
    ctx.ui.notify("tls: certificate password was not valid", "warning");
    const retry = await ctx.ui.confirm(
      "TLS certificate password failed",
      "Try entering the password again?",
    );
    if (!retry)
      return {
        status: "error",
        sourceId: PFX_SOURCE_ID,
        message: "tls: invalid client certificate passphrase",
      };
  }
}

/** Validate that a passphrase can decrypt the PFX by creating the SecureContext used by consumers. */
function validatePfxPassphrase(pfx: Buffer, passphrase: string): SecureContext | undefined {
  try {
    return createSecureContext({ pfx, passphrase });
  } catch {
    return undefined;
  }
}

/** Normalize user-entered paths relative to Pi's current working directory. */
function normalizePath(ctx: ExtensionContext, path: string): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
}

/** Return true for PFX/P12 paths supported by this source. */
function isPfxPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".pfx" || ext === ".p12";
}
