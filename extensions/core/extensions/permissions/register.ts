import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { showInlinePanel, showSelectPanel } from "../../lib/ui/panel.ts";
import {
  SAFE_ALLOW_TOOLS,
  TRUSTED_BASH_ALLOW_PATTERNS,
  TRUSTED_BASH_DENY_PATTERNS,
} from "./policy.ts";
import {
  configFilePath,
  defaultConfigFilePath,
  readDefaultPermissionMode,
  toRawGrants,
  toRawRules,
  validateConfig,
  writeDefaultPermissionMode,
  writePermissionState,
} from "./persistence.ts";
import type { PermissionMode, PermissionState } from "./types.ts";

const MODES: PermissionMode[] = ["safe", "trusted", "permissive", "open"];

type PermissionPickerResult =
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "default"; mode: PermissionMode };

/**
 * Register the `/permissions [safe|trusted|permissive|open|edit|default]` operator command.
 *
 * - No args / unknown arg: open mode picker then show showcase.
 * - `safe`, `trusted`, `permissive`, `open`: set mode directly and show showcase.
 * - `edit`: open raw-JSON editor; validate before writing.
 * - `default [mode]`: save the central default mode.
 *
 * The showcase content is derived from the policy engine's own constants so it
 * cannot drift from actual enforcement behavior.
 */
export function registerPermissionsCommand(pi: ExtensionAPI, state: PermissionState): void {
  pi.registerCommand("permissions", {
    description:
      "View or change the permission mode (safe / trusted / permissive / open) and inspect active rules",
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "edit") {
        await editPermissionConfig(ctx, state);
        return;
      }

      if (sub === "safe" || sub === "trusted" || sub === "open" || sub === "permissive") {
        await applyMode(ctx, state, sub as PermissionMode);
        return;
      }

      if (sub === "default") {
        await saveDefaultMode(ctx, state.mode);
        return;
      }

      if (sub.startsWith("default ")) {
        const mode = sub.slice("default ".length).trim();
        if (isPermissionMode(mode)) await saveDefaultMode(ctx, mode);
        else ctx.ui.notify("usage: /permissions default [safe|trusted|permissive|open]", "warning");
        return;
      }

      // No arg or unrecognized — show the picker.
      const choice = await pickPermissionMode(ctx, state);
      if (!choice) return;
      if (choice.kind === "default") {
        await saveDefaultMode(ctx, choice.mode);
        return;
      }
      await applyMode(ctx, state, choice.mode);
    },
  });
}

/** Return whether a string is one of the supported permission modes. */
function isPermissionMode(value: string): value is PermissionMode {
  return value === "safe" || value === "trusted" || value === "permissive" || value === "open";
}

/** Pick a mode, with `d` saving the highlighted mode as the central default. */
async function pickPermissionMode(
  ctx: ExtensionCommandContext,
  state: PermissionState,
): Promise<PermissionPickerResult | null> {
  const defaultMode = await readDefaultPermissionMode();

  if (!ctx.hasUI) {
    const labels = MODES.map((mode) => formatModeLabel(mode, state.mode, defaultMode));
    const choice = await ctx.ui.select("Select permission mode", labels, { signal: ctx.signal });
    const picked = choice ? MODES.find((m) => choice.startsWith(m)) : undefined;
    return picked ? { kind: "mode", mode: picked } : null;
  }

  return await showSelectPanel<PermissionPickerResult>(ctx, {
    title: "Select permission mode",
    items: MODES.map((mode) => ({
      label: formatModeLabel(mode, state.mode, defaultMode),
      value: mode,
      description: formatModeDescription(mode, state.mode, defaultMode),
    })),
    footer: "↑↓ navigate • Enter set mode • d save selected as default • Esc close",
    onSelect: (item) => ({ kind: "mode", mode: item.value as PermissionMode }),
    onKey: (data, item) => {
      if (data !== "d") return undefined;
      return item ? { kind: "default", mode: item.value as PermissionMode } : null;
    },
  });
}

/** Format a permission mode with default/current markers for the picker. */
function formatModeLabel(
  mode: PermissionMode,
  currentMode: PermissionMode,
  defaultMode: PermissionMode,
): string {
  const markers: string[] = [];
  if (mode === defaultMode) markers.push("default");
  if (mode === currentMode) markers.push("current");
  return markers.length > 0 ? `${mode} (${markers.join(") (")})` : mode;
}

/** Describe why a permission mode is specially marked in the picker. */
function formatModeDescription(
  mode: PermissionMode,
  currentMode: PermissionMode,
  defaultMode: PermissionMode,
): string | undefined {
  if (mode === defaultMode && mode === currentMode) return "Central default and active mode";
  if (mode === defaultMode) return "Central default mode";
  if (mode === currentMode) return "Active mode";
  return undefined;
}

/** Save the central default mode without changing rules or remembered grants. */
async function saveDefaultMode(ctx: ExtensionCommandContext, mode: PermissionMode): Promise<void> {
  await writeDefaultPermissionMode(mode);
  ctx.ui.notify(`permissions: default mode set to ${mode} (${defaultConfigFilePath()})`, "info");
}

/** Apply a new mode: update process-global state, persist, and show showcase. */
async function applyMode(
  ctx: ExtensionCommandContext,
  state: PermissionState,
  mode: PermissionMode,
): Promise<void> {
  await applyPermissionMode(ctx, state, mode);
  await present(ctx, `permissions: mode set to ${mode}`, buildShowcase(state, mode));
}

/**
 * Mutate the shared permission state's mode in place and persist it.
 * Mutating (not replacing) the object keeps the `tool_call` hook closure live.
 * Shared with `/core-settings` so the settings UI applies modes through the
 * same path as `/permissions` without rendering the showcase panel.
 */
export async function applyPermissionMode(
  ctx: ExtensionCommandContext,
  state: PermissionState,
  mode: PermissionMode,
): Promise<void> {
  state.mode = mode;
  await writePermissionState(ctx.cwd, state);
  ctx.ui.setStatus("permissions", `perm:${state.mode}`);
}

// ── /permissions edit ────────────────────────────────────────────────────────

/**
 * Open the raw-JSON editor prefilled with the current config.
 * Validates JSON + schema + regex before writing; rejects with an error message
 * on invalid input without touching the stored config.
 *
 * Falls back to a notify pointing at the file path when `!ctx.hasUI`.
 *
 * Exported so `/core-settings` can open the same validated permissions editor,
 * applying compiled rules into the shared live state via `writePermissionState`.
 */
export async function editPermissionConfig(
  ctx: ExtensionCommandContext,
  state: PermissionState,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`edit ${configFilePath(ctx.cwd)} directly to modify permissions config`, "info");
    return;
  }

  const prefill = JSON.stringify(
    {
      mode: state.mode,
      rules: toRawRules(state),
      remembered: toRawGrants(state),
    },
    null,
    2,
  );

  const edited = await ctx.ui.editor("Edit permissions config (poo/core-settings.json)", prefill);
  if (edited === undefined) return; // cancelled

  let parsed: unknown;
  try {
    parsed = JSON.parse(edited);
  } catch (err) {
    ctx.ui.notify(
      `[permissions] edit rejected — invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  const result = validateConfig(parsed);
  if (typeof result === "string") {
    ctx.ui.notify(`[permissions] edit rejected — ${result}`, "error");
    return;
  }

  // Valid — apply atomically
  state.mode = result.mode;
  state.rules = result.rules;
  state.remembered = result.remembered;
  await writePermissionState(ctx.cwd, state);
  ctx.ui.setStatus("permissions", `perm:${state.mode}`);
  ctx.ui.notify("[permissions] config updated and applied", "info");
}

// ── Showcase ─────────────────────────────────────────────────────────────────

/**
 * Build the selected mode's showcase lines from the policy engine constants.
 * Content is derived, not hand-written, to prevent drift from actual enforcement.
 */
function buildShowcase(state: PermissionState, mode: PermissionMode): string[] {
  const lines: string[] = [];

  lines.push(`Active mode: ${mode}`);
  lines.push("");

  appendModeShowcase(lines, mode);
  appendCommonNotes(lines, mode);
  appendActiveConfig(lines, state);

  return lines;
}

/** Append the mode-specific summary for the selected permission mode. */
function appendModeShowcase(lines: string[], mode: PermissionMode): void {
  if (mode === "safe") {
    lines.push("── safe mode ─────────────────────────────────────────────");
    lines.push(" precedence: .env-deny → config deny → config ask → config allow/grant → default");
    lines.push(` allows:  ${[...SAFE_ALLOW_TOOLS].join(", ")}`);
    lines.push(" prompts: write, edit, bash, and any other tool");
    lines.push(" blocks:  nothing extra beyond .env direct targets");
    lines.push("");
    return;
  }

  if (mode === "trusted") {
    lines.push("── trusted mode ──────────────────────────────────────────");
    lines.push(" precedence: .env-deny → config deny → config ask → config allow/grant → default");
    lines.push(" allows:  path tools (read/write/edit/grep/find/ls) within cwd");
    lines.push(" allows bash (all segments must match):");
    for (const p of TRUSTED_BASH_ALLOW_PATTERNS) {
      lines.push(`   ${p.source}`);
    }
    lines.push(" denies bash (any segment or whole command; override-able by config allow):");
    for (const p of TRUSTED_BASH_DENY_PATTERNS) {
      lines.push(`   ${p.source}`);
    }
    lines.push(" prompts: path tools outside cwd, unrecognized bash, custom tools");
    lines.push("");
    return;
  }

  if (mode === "permissive") {
    lines.push("── permissive mode ───────────────────────────────────────");
    lines.push(" precedence: .env-deny → config deny → config allow/grant → config ask → allow");
    lines.push(" allows:  everything by default; honors config rules");
    lines.push(" ask:     add config ask rules to prompt for specific commands/tools");
    lines.push("   grants (Always For This Project) override the ask-list");
    lines.push("   allow rules also override the ask-list");
    lines.push(" blocks:  .env path/bash targets; config deny rules");
    lines.push(" note:    ships with no built-in ask patterns — fresh permissive allows");
    lines.push("   everything except .env targets until you add ask rules");
    lines.push("");
    return;
  }

  lines.push("── open mode ─────────────────────────────────────────────");
  lines.push(" allows:  everything (config rules ignored)");
  lines.push(" blocks:  .env path/bash targets without an explicit allow rule");
  lines.push("");
}

/** Append notes that apply to the selected mode without listing other modes. */
function appendCommonNotes(lines: string[], mode: PermissionMode): void {
  if (mode !== "open") {
    lines.push("── compound bash commands ────────────────────────────────");
    lines.push(" commands are split into segments (&&, ||, |, ;, newline, &)");
    lines.push(" ALLOW: every segment must be covered — one uncovered segment → ask");
    lines.push(" ASK:   any segment matching an ask rule → prompt");
    lines.push(" DENY:  any segment matching a deny rule, OR the whole command");
    lines.push(" command substitution ($(...) or backticks) → always uncoverable → ask/deny");
    lines.push("");
  }

  lines.push("── always active ─────────────────────────────────────────");
  lines.push(" .env default-deny: direct .env path-tool targets are blocked");
  if (mode === "open" || mode === "permissive") {
    lines.push("   simple bash reads like `cat .env` are blocked too");
  }
  lines.push("   override: add an explicit config allow rule (e.g. \\.env\\.example$)");
  lines.push("   note: directory scans (grep/find over a parent dir) are NOT");
  lines.push("         recursively checked — nested .env files may still surface");
  lines.push(" headless (!hasUI): write/bash/etc. are not gated in automated sessions");
  lines.push("");
}

/** Append active config and remembered grants relevant to this project. */
function appendActiveConfig(lines: string[], state: PermissionState): void {
  lines.push("── active config ─────────────────────────────────────────");
  lines.push(` config rules:      ${state.rules.length}`);
  lines.push(` remembered grants: ${state.remembered.length}`);
  if (state.rules.length > 0) {
    lines.push("");
    lines.push(" rules:");
    for (const r of state.rules) {
      lines.push(`   ${r.action.padEnd(5)} ${r.tool.padEnd(8)} ${r.pattern}`);
    }
  }
  if (state.remembered.length > 0) {
    lines.push("");
    lines.push(" remembered grants (use /permissions edit to revoke):");
    for (const g of state.remembered) {
      const detail = g.dirPrefix ? `dir: ${g.dirPrefix}` : `pattern: ${g.pattern ?? "?"}`;
      lines.push(`   ${g.tool.padEnd(8)} ${detail}`);
    }
  }
}

/** Show lines in an inline TUI panel when UI is present; otherwise notify. */
async function present(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  if (ctx.hasUI) {
    await showInlinePanel(ctx, title, lines);
    return;
  }
  ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
}
