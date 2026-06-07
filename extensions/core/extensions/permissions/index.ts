import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { buildToolCallHandler, createMutex } from "./enforcement.ts";
import { reloadState } from "./persistence.ts";
import {
  applyPermissionMode,
  editPermissionConfig,
  registerPermissionsCommand,
} from "./register.ts";
import type { PermissionMode, PermissionState } from "./types.ts";

const PERMISSIONS_MEMORY_KEY = "__pooPiCorePermissionsState";
const STATUS_KEY = "permissions";

/**
 * Live controller over the process-global permission state, used by `/core-settings`
 * to read and change permissions through the same helpers as `/permissions`.
 */
export interface PermissionsController {
  /** Current active permission mode. */
  getMode(): PermissionMode;
  /** Set and persist the mode, mutating the shared live state in place. */
  setMode(ctx: ExtensionCommandContext, mode: PermissionMode): Promise<void>;
  /** Open the validated permissions JSON editor against the shared live state. */
  editConfig(ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Return the process-global permissions store, reused across Pi runtime reloads
 * in the same Node process so the active mode and grants survive `/reload` and `/new`.
 *
 * The inner `state` field starts as a placeholder; `reloadState` is called on
 * `session_start` to load the real config from `.pi/core-settings.json`.
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
 * - Loads persisted mode + rules from `.pi/core-settings.json` on `session_start`.
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
export function registerPermissions(pi: ExtensionAPI): PermissionsController {
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
    ctx.ui.setStatus(STATUS_KEY, `perm:${global.state.mode}`);
  };

  pi.on("session_start", (_event, ctx) => load(ctx));

  pi.on("tool_call", buildToolCallHandler(global.state, mutex, global.notifiedRef));

  registerPermissionsCommand(pi, global.state);

  return {
    getMode: () => global.state.mode,
    setMode: async (ctx, mode) => {
      await applyPermissionMode(ctx, global.state, mode);
      ctx.ui.setStatus(STATUS_KEY, `perm:${global.state.mode}`);
    },
    editConfig: (ctx) => editPermissionConfig(ctx, global.state),
  };
}
