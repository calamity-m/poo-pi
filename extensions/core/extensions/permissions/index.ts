import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildToolCallHandler, createMutex } from "./enforcement.ts";
import { reloadState } from "./persistence.ts";
import { registerPermissionsCommand } from "./register.ts";
import type { PermissionState } from "./types.ts";

const PERMISSIONS_MEMORY_KEY = "__pooPiCorePermissionsState";

/**
 * Return the process-global permissions store, reused across Pi runtime reloads
 * in the same Node process so the active mode and grants survive `/reload` and `/new`.
 *
 * The inner `state` field starts as a placeholder; `reloadState` is called on
 * `session_start` to load the real config from `.pi/core-permissions.json`.
 */
function getPermissionsGlobal(): { state: PermissionState; notifiedRef: [boolean] } {
  const scope = globalThis as typeof globalThis & {
    [PERMISSIONS_MEMORY_KEY]?: { state: PermissionState; notifiedRef: [boolean] };
  };
  scope[PERMISSIONS_MEMORY_KEY] ??= {
    state: { mode: "trusted", rules: [], remembered: [] },
    notifiedRef: [false],
  };
  return scope[PERMISSIONS_MEMORY_KEY]!;
}

/**
 * Register the core permissions extension.
 *
 * - Loads persisted mode + rules from `.pi/core-permissions.json` on `session_start`.
 * - Adds a `tool_call` hook that gates every tool through the policy engine.
 * - Registers the `/permissions` operator command (mode picker + showcase + editor).
 *
 * The process-global state (mode, rules, grants) survives `/reload` and `/new`
 * in the same process; external config file edits are picked up on next `session_start`.
 *
 * HEADLESS NOTE: When `!ctx.hasUI` (print/RPC/automation), the extension runs as
 * `open` mode — write/bash/etc. are NOT gated regardless of the persisted mode.
 * Only the `.env` direct path-tool default-deny still applies headless.
 *
 * .ENV NOTE: `.env` is default-deny and override-able by an explicit config allow
 * rule (e.g. `{tool: "*", action: "allow", pattern: "\\.env\\.example$"}`).
 * Direct path-tool targets matching `.env` or `.env.*` are blocked; directory scans
 * (grep/find over a parent directory) are NOT recursively checked.
 */
export function registerPermissions(pi: ExtensionAPI): void {
  const global = getPermissionsGlobal();
  const mutex = createMutex();

  const load = async (ctx: ExtensionContext): Promise<void> => {
    const loaded = await reloadState(ctx);
    // Update in-place so handler closures see the new state
    global.state.mode = loaded.mode;
    global.state.rules = loaded.rules;
    global.state.remembered = loaded.remembered;
    // Reset the degraded-notify flag on reload so fresh errors surface again
    global.notifiedRef[0] = false;
  };

  pi.on("session_start", (_event, ctx) => load(ctx));

  pi.on("tool_call", buildToolCallHandler(global.state, mutex, global.notifiedRef));

  registerPermissionsCommand(pi, global.state);
}
