import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { showPanel } from "../proxy/audit-panel.ts";
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

const MODES: PermissionMode[] = ["safe", "trusted", "open", "permissive"];

/**
 * Register the `/permissions [safe|trusted|open|edit]` operator command.
 *
 * - No args / unknown arg: open mode picker then show showcase.
 * - `safe`, `trusted`, `open`: set mode directly and show showcase.
 * - `edit`: open raw-JSON editor; validate before writing.
 *
 * The showcase content is derived from the policy engine's own constants so it
 * cannot drift from actual enforcement behavior.
 */
export function registerPermissionsCommand(pi: ExtensionAPI, state: PermissionState): void {
  pi.registerCommand("permissions", {
    description:
      "View or change the permission mode (safe / trusted / open / permissive) and inspect active rules",
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "edit") {
        await handleEdit(ctx, state);
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
  state.mode = mode;
  await writePermissionState(ctx.cwd, state);
  await present(ctx, `permissions: mode set to ${mode}`, buildShowcase(state));
}

// ── /permissions edit ────────────────────────────────────────────────────────

/**
 * Open the raw-JSON editor prefilled with the current config.
 * Validates JSON + schema + regex before writing; rejects with an error message
 * on invalid input without touching the stored config.
 *
 * Falls back to a notify pointing at the file path when `!ctx.hasUI`.
 */
async function handleEdit(ctx: ExtensionCommandContext, state: PermissionState): Promise<void> {
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

  const edited = await ctx.ui.editor(
    "Edit permissions config (.pi/core-permissions.json)",
    prefill,
  );
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
 * Build the showcase panel lines from the policy engine's own constants.
 * Content is derived, not hand-written, to prevent drift from actual enforcement.
 */
function buildShowcase(state: PermissionState): string[] {
  const lines: string[] = [];

  lines.push(`Active mode: ${state.mode}`);
  lines.push("");

  lines.push("── safe mode ─────────────────────────────────────────────");
  lines.push(" precedence: .env-deny → config deny → config ask → config allow/grant → default");
  lines.push(` allows:  ${[...SAFE_ALLOW_TOOLS].join(", ")}`);
  lines.push(" prompts: write, edit, bash, and any other tool");
  lines.push(" blocks:  (nothing extra beyond .env)");
  lines.push("");

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

  lines.push("── open mode ─────────────────────────────────────────────");
  lines.push(" allows:  everything (config rules ignored)");
  lines.push(" blocks:  .env direct path-tool access (see below)");
  lines.push("");

  lines.push("── permissive mode ───────────────────────────────────────");
  lines.push(" precedence: .env-deny → config deny → config allow/grant → config ask → allow");
  lines.push(" allows:  everything by default; honors config rules");
  lines.push(" ask:     add config ask rules to prompt for specific commands/tools");
  lines.push("   grants (Always For This Project) override the ask-list");
  lines.push("   allow rules also override the ask-list");
  lines.push(" blocks:  .env (path and bash) same as open; config deny rules");
  lines.push(" note:    ships with no built-in ask patterns — fresh permissive ≡ open");
  lines.push("   until you add ask rules via /permissions edit");
  lines.push("");

  lines.push("── compound bash commands (all modes) ────────────────────");
  lines.push(" commands are split into segments (&&, ||, |, ;, newline, &)");
  lines.push(" ALLOW: every segment must be covered — one uncovered segment → ask");
  lines.push(" ASK:   any segment matching an ask rule → prompt");
  lines.push(" DENY:  any segment matching a deny rule, OR the whole command");
  lines.push("   (whole-command match preserves pipe-spanning patterns like curl|bash)");
  lines.push(" command substitution ($(...) or backticks) → always uncoverable → ask/deny");
  lines.push(" backward-compat note: saved patterns that matched a whole compound string");
  lines.push("   now match per-segment; anchored single-command patterns are unaffected");
  lines.push("");

  lines.push("── always active (all modes) ──────────────────────────────");
  lines.push(" .env default-deny: direct .env path-tool targets are blocked");
  lines.push("   override: add an explicit config allow rule (e.g. \\.env\\.example$)");
  lines.push("   note: directory scans (grep/find over a parent dir) are NOT");
  lines.push("         recursively checked — nested .env files may still surface");
  lines.push(" headless (!hasUI): always runs as open mode regardless of persisted mode");
  lines.push("   write/bash/etc. are NOT gated in headless/automated sessions");
  lines.push("");

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

  return lines;
}

/** Show lines in a TUI panel when UI is present; otherwise notify. */
async function present(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  if (ctx.hasUI) {
    await showPanel(ctx, title, lines);
    return;
  }
  ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
}
