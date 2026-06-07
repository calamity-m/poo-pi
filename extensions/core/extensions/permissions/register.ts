import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { showInlinePanel } from "../../lib/ui/panel.ts";
import {
  SAFE_ALLOW_TOOLS,
  TRUSTED_BASH_ALLOW_PATTERNS,
  TRUSTED_BASH_DENY_PATTERNS,
} from "./policy.ts";
import {
  configFilePath,
  toRawGrants,
  toRawRules,
  validateConfig,
  writePermissionState,
} from "./persistence.ts";
import type { PermissionMode, PermissionState } from "./types.ts";

const MODES: PermissionMode[] = ["safe", "trusted", "permissive", "open"];

/**
 * Register the `/permissions [safe|trusted|permissive|open|edit]` operator command.
 *
 * - No args / unknown arg: open mode picker then show showcase.
 * - `safe`, `trusted`, `permissive`, `open`: set mode directly and show showcase.
 * - `edit`: open raw-JSON editor; validate before writing.
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

      // No arg or unrecognized — show the picker
      const labels = MODES.map((m) => (m === state.mode ? `${m} (current)` : m));
      const choice = await ctx.ui.select("Select permission mode", labels, { signal: ctx.signal });
      if (!choice) return; // cancelled

      const picked = MODES.find((m) => choice.startsWith(m));
      if (!picked) return;
      await applyMode(ctx, state, picked);
    },
  });
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

  const edited = await ctx.ui.editor("Edit permissions config (.pi/core-settings.json)", prefill);
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
