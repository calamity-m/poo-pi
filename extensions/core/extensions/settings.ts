import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, parseKey } from "@earendil-works/pi-tui";

import { coreSettingsPath, globalCoreSettingsPath } from "../config/paths.ts";
import {
  readCoreHistorySearchSettings,
  readCoreProxyRedactionMode,
  readCoreSettings,
  readCoreWorktreeSettings,
  readGlobalCoreSubagentSettings,
  validateCoreSettings,
  writeCoreHistorySearchSettings,
  writeCoreSettings,
  writeCoreWorktreeSettings,
  writeGlobalCoreSubagentSettings,
} from "../config/persistence.ts";
import { DEFAULT_MANAGED_ROOT } from "./worktree/path-policy.ts";
import type { CoreFooterController } from "./footer.ts";
import type { PermissionsController } from "./permissions/index.ts";
import type { PermissionMode } from "./permissions/types.ts";
import { auditPaths, writeRedactionMode } from "./proxy/audit.ts";
import { PanelChrome, showInlinePanel } from "../lib/ui/panel.ts";
import type { RedactionMode } from "./proxy/types.ts";

/** Live controllers the settings UI routes simple changes and configure actions through. */
export interface CoreSettingsControllers {
  /** Permissions live state controller (mode + validated config editor). */
  permissions: PermissionsController;
  /** Footer live state controller (enabled flag + template). */
  footer: CoreFooterController;
}

/** Permission modes offered as a cycling row in the settings UI. */
const MODES: PermissionMode[] = ["safe", "trusted", "permissive", "open"];

/** Default shortcut used when no history search setting is persisted. */
const DEFAULT_HISTORY_SEARCH_SHORTCUT = "f8";

/** Thinking levels that can be persisted for a configured subagent tier. */
const SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

/** Result of the settings selector: the user closed it, or activated a configure/edit action. */
type SelectorResult = { kind: "close" } | { kind: "action"; id: string };

/**
 * Register the `/core-settings` command.
 *
 * - No args with a UI opens the interactive selector; headless no-arg shows JSON.
 * - `show` always renders the effective settings JSON (never the selector).
 * - `edit` opens the raw-JSON editor; `path` reports the settings file path.
 */
export function registerCoreSettings(pi: ExtensionAPI, controllers: CoreSettingsControllers): void {
  pi.registerCommand("core-settings", {
    description: "View or edit poo-pi core settings stored in ~/.pi/agent/poo/core-settings.json",
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "show") {
        await showSettings(ctx);
        return;
      }
      if (sub === "edit") {
        await editSettings(ctx, controllers);
        return;
      }
      if (sub === "path") {
        ctx.ui.notify(coreSettingsPath(ctx.cwd), "info");
        return;
      }
      if (sub !== "") {
        ctx.ui.notify("usage: /core-settings [show|edit|path]", "warning");
        return;
      }
      if (!ctx.hasUI) {
        await showSettings(ctx);
        return;
      }
      await openCoreSettingsSelector(ctx, controllers);
    },
  });
}

/** Show the current effective core settings. */
async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
  const settings = await readCoreSettings(ctx.cwd);
  const lines = JSON.stringify(settings, null, 2).split("\n");
  if (ctx.hasUI) {
    await showInlinePanel(ctx, "core settings", lines);
    return;
  }
  ctx.ui.notify(`core settings\n${lines.join("\n")}`, "info");
}

/** Open the unified core settings JSON in Pi's editor and persist valid edits. */
async function editSettings(
  ctx: ExtensionCommandContext,
  controllers?: CoreSettingsControllers,
): Promise<void> {
  const path = coreSettingsPath(ctx.cwd);
  if (!ctx.hasUI) {
    ctx.ui.notify(`edit ${path} directly to modify core settings`, "info");
    return;
  }

  const prefill = `${JSON.stringify(await readCoreSettings(ctx.cwd), null, 2)}\n`;
  const edited = await ctx.ui.editor("Edit core settings (poo/core-settings.json)", prefill);
  if (edited === undefined) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(edited);
  } catch (error) {
    ctx.ui.notify(
      `[core-settings] edit rejected — invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  const settings = validateCoreSettings(parsed);
  if (typeof settings === "string") {
    ctx.ui.notify(`[core-settings] edit rejected — ${settings}`, "error");
    return;
  }

  await writeCoreSettings(ctx.cwd, settings);
  if (controllers) await controllers.permissions.reload(ctx);
  ctx.ui.notify("[core-settings] config updated", "info");
}

/**
 * Drive the interactive settings list. Each pass re-reads current settings and
 * live state so rows never show stale values after a configure/edit sub-flow;
 * simple rows live-apply through {@link applyChange} without leaving the list.
 *
 * NOTE: permission-mode live-apply is interactive-only — headless sessions run
 * `open` regardless of the persisted mode, so the chosen mode is not globally
 * enforced. Permission rules remain editable only through the permissions
 * editor or raw JSON, not as inline rows.
 */
async function openCoreSettingsSelector(
  ctx: ExtensionCommandContext,
  controllers: CoreSettingsControllers,
): Promise<void> {
  for (;;) {
    const redaction = await readCoreProxyRedactionMode(auditPaths(ctx.cwd).dir);
    const subagents = await readGlobalCoreSubagentSettings();
    const historySearch = await readCoreHistorySearchSettings(ctx.cwd);
    const worktrees = await readCoreWorktreeSettings(ctx.cwd);
    const footer = controllers.footer.getSettings();

    const result = await ctx.ui.custom<SelectorResult>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = [
        {
          id: "permissions-mode",
          label: "Project permissions mode",
          description:
            "Persist the active project-local mode (interactive sessions only; headless runs open).",
          currentValue: controllers.permissions.getMode(),
          values: [...MODES],
        },
        actionItem(
          "permissions-config-local",
          "Local permissions config",
          "edit",
          "Edit project-local permission rules and remembered grants as validated JSON.",
          done,
        ),
        actionItem(
          "permissions-config-global",
          "Global permissions defaults",
          "edit",
          "Edit global default mode, rules, and remembered grants as validated JSON.",
          done,
        ),
        {
          id: "proxy-redact",
          label: "Proxy audit redaction",
          description: "Mask sensitive headers in audit records for future proxy requests.",
          currentValue: redaction,
          values: ["on", "off"],
        },
        actionItem(
          "history-search-shortcut",
          "History search shortcut",
          historySearch?.shortcut ?? DEFAULT_HISTORY_SEARCH_SHORTCUT,
          "Configure the user-message history search shortcut. Applies after /reload.",
          done,
        ),
        {
          id: "footer-enabled",
          label: "Footer enabled",
          description: "Show the core status footer instead of Pi's default footer.",
          currentValue: footer.enabled ? "on" : "off",
          values: ["on", "off"],
        },
        actionItem(
          "footer-template",
          "Footer template",
          footer.template,
          "Edit the core status footer token template.",
          done,
        ),
        actionItem(
          "subagents-fast",
          "Subagent fast model",
          subagents?.fast?.model ?? "unset",
          "Configure global provider/model-id and optional thinking level for fast subagents.",
          done,
        ),
        actionItem(
          "subagents-high",
          "Subagent high model",
          subagents?.high?.model ?? "unset",
          "Configure global provider/model-id and optional thinking level for high-capability subagents.",
          done,
        ),
        actionItem(
          "worktree-root",
          "Managed worktree root",
          worktrees?.root ?? DEFAULT_MANAGED_ROOT,
          "Directory under which add_git_worktree creates worktrees. Leading ~ is expanded.",
          done,
        ),
        actionItem(
          "json-edit",
          "Core settings JSON",
          "edit",
          "Edit the raw ~/.pi/agent/poo/core-settings.json for advanced changes.",
          done,
        ),
      ];

      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 12),
        getSettingsListTheme(),
        (id, value) => void applyChange(ctx, controllers, id, value),
        () => done({ kind: "close" }),
      );

      const chrome = new PanelChrome(theme);

      return {
        render: (width) => chrome.render("core settings", width, ["", ...list.render(width)]),
        invalidate: () => list.invalidate(),
        handleInput: (data) => list.handleInput(data),
      };
    });

    if (!result || result.kind === "close") return;
    await runAction(ctx, controllers, result.id);
  }
}

/**
 * Build a row that, when activated, closes the selector and reports the action so
 * the caller can run a separate UI flow (editor/setup) the inline list cannot host.
 */
function actionItem(
  id: string,
  label: string,
  currentValue: string,
  description: string,
  done: (result: SelectorResult) => void,
): SettingItem {
  return {
    id,
    label,
    description,
    currentValue,
    submenu: () => {
      done({ kind: "action", id });
      return { render: () => [], invalidate: () => {} };
    },
  };
}

/**
 * Apply a simple value-row change, persisting and live-applying where supported.
 * Safe to invoke repeatedly as the user cycles values.
 */
async function applyChange(
  ctx: ExtensionCommandContext,
  controllers: CoreSettingsControllers,
  id: string,
  value: string,
): Promise<void> {
  if (id === "permissions-mode") {
    await controllers.permissions.setMode(ctx, value as PermissionMode);
    ctx.ui.notify(`permissions: mode set to ${value}`, "info");
    return;
  }
  if (id === "proxy-redact") {
    await writeRedactionMode(auditPaths(ctx.cwd).dir, value as RedactionMode);
    ctx.ui.notify(
      value === "on"
        ? "proxy: redaction on for future requests"
        : "proxy: redaction off — future requests log headers raw",
      value === "on" ? "info" : "warning",
    );
    return;
  }
  if (id === "footer-enabled") {
    await controllers.footer.setEnabled(ctx, value === "on");
    ctx.ui.notify(value === "on" ? "footer: enabled" : "footer: disabled", "info");
  }
}

/** Run a configure/edit action selected from the settings list. */
async function runAction(
  ctx: ExtensionCommandContext,
  controllers: CoreSettingsControllers,
  id: string,
): Promise<void> {
  if (id === "permissions-config-local") {
    await controllers.permissions.editConfig(ctx, "local");
    return;
  }
  if (id === "permissions-config-global") {
    await controllers.permissions.editConfig(ctx, "global");
    return;
  }
  if (id === "history-search-shortcut") {
    await configureHistorySearchShortcut(ctx);
    return;
  }
  if (id === "subagents-fast" || id === "subagents-high") {
    await configureSubagentTier(ctx, id === "subagents-fast" ? "fast" : "high");
    return;
  }
  if (id === "footer-template") {
    await configureFooterTemplate(ctx, controllers.footer);
    return;
  }
  if (id === "worktree-root") {
    await configureWorktreeRoot(ctx);
    return;
  }
  if (id === "json-edit") {
    await editSettings(ctx, controllers);
  }
}

/** Prompt for the footer template and persist it through the unified settings file. */
async function configureFooterTemplate(
  ctx: ExtensionCommandContext,
  footer: CoreFooterController,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("use /core-settings edit to change the footer", "info");
    return;
  }

  const edited = await ctx.ui.editor("Edit footer template", `${footer.getSettings().template}\n`);
  const template = edited?.trim();
  if (!template) return;

  const validated = validateCoreSettings({ version: 1, footer: { template } });
  if (typeof validated === "string") {
    ctx.ui.notify(`[core-settings] footer template rejected — ${validated}`, "error");
    return;
  }

  await footer.setTemplate(ctx, template);
  ctx.ui.notify("[core-settings] footer template updated", "info");
}

/** Prompt for the managed worktree root and persist it through the unified settings file. */
async function configureWorktreeRoot(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("use /core-settings edit to change the managed worktree root", "info");
    return;
  }

  const current = await readCoreWorktreeSettings(ctx.cwd);
  const edited = await ctx.ui.editor(
    "Edit managed worktree root (leading ~ is expanded)",
    `${current?.root ?? DEFAULT_MANAGED_ROOT}\n`,
  );
  if (edited === undefined) return;
  const root = edited.trim();
  if (!root) {
    ctx.ui.notify("[core-settings] worktree root unchanged — value was empty", "warning");
    return;
  }

  const validated = validateCoreSettings({ version: 1, worktrees: { root } });
  if (typeof validated === "string") {
    ctx.ui.notify(`[core-settings] worktree root rejected — ${validated}`, "error");
    return;
  }

  await writeCoreWorktreeSettings(ctx.cwd, { root });
  ctx.ui.notify(`[core-settings] managed worktree root set to ${root}`, "info");
}

/** Prompt for the history search shortcut and persist it through the unified settings file. */
async function configureHistorySearchShortcut(ctx: ExtensionCommandContext): Promise<void> {
  const current = await readCoreHistorySearchSettings(ctx.cwd);
  const prefill = current?.shortcut ?? DEFAULT_HISTORY_SEARCH_SHORTCUT;
  const captured = await ctx.ui.custom<CapturedShortcut | undefined>(
    (tui, theme, keybindings, done) =>
      new ShortcutCapture(theme, keybindings, prefill, done, () => tui.requestRender()),
  );
  const shortcut = captured?.shortcut;
  if (!shortcut) return;

  if (captured.conflicts.length > 0) {
    const ok = await ctx.ui.confirm(
      "Shortcut conflict",
      `${shortcut} is already bound to ${captured.conflicts.join(", ")}. Save anyway?`,
    );
    if (!ok) return;
  }

  const validated = validateCoreSettings({ version: 1, historySearch: { shortcut } });
  if (typeof validated === "string") {
    ctx.ui.notify(`[core-settings] history search shortcut rejected — ${validated}`, "error");
    return;
  }

  await writeCoreHistorySearchSettings(ctx.cwd, { shortcut });
  ctx.ui.notify(
    `[core-settings] history search shortcut set to ${shortcut}; run /reload to apply`,
    "info",
  );
}

/** Shortcut captured from raw terminal input plus any effective keybinding conflicts. */
interface CapturedShortcut {
  /** Pi shortcut string parsed from the raw keypress. */
  shortcut: string;
  /** Existing keybinding ids that already use the shortcut. */
  conflicts: string[];
}

/** Theme surface needed by the shortcut capture UI. */
interface ShortcutCaptureTheme {
  /** Colorize text with a named theme color. */
  fg(color: string, text: string): string;
  /** Bold text. */
  bold(text: string): string;
}

/** Keybinding manager surface needed by the shortcut capture UI. */
interface ShortcutCaptureKeybindings {
  /** Return whether a raw keypress matches a named keybinding. */
  matches(data: string, id: string): boolean;
  /** Effective keybinding config, available on Pi's injected manager. */
  getEffectiveConfig?: () => Record<string, string | string[] | undefined>;
}

/** Minimal custom UI that captures one raw keypress and returns its Pi shortcut id. */
class ShortcutCapture {
  focused = false;
  private message: string | undefined;
  private readonly theme: ShortcutCaptureTheme;
  private readonly chrome: PanelChrome;
  private readonly keybindings: ShortcutCaptureKeybindings;
  private readonly currentShortcut: string;
  private readonly done: (result: CapturedShortcut | undefined) => void;
  private readonly requestRender: () => void;

  /** Build the key capture prompt. */
  constructor(
    theme: ShortcutCaptureTheme,
    keybindings: ShortcutCaptureKeybindings,
    currentShortcut: string,
    done: (result: CapturedShortcut | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme;
    this.chrome = new PanelChrome(theme);
    this.keybindings = keybindings;
    this.currentShortcut = currentShortcut;
    this.done = done;
    this.requestRender = requestRender;
  }

  /** Render a compact bordered key-capture prompt. */
  render(width: number): string[] {
    const lines = [
      this.theme.fg("accent", this.theme.bold("History search shortcut")),
      `Current: ${this.currentShortcut}`,
      "Press the key combination to assign.",
      this.theme.fg("dim", "Esc/Ctrl+C cancels. /reload is required after save."),
    ];
    if (this.message) lines.push(this.message);
    return this.chrome.render("shortcut", width, lines);
  }

  /** Capture the next keypress, or cancel on the configured select-cancel binding. */
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    const shortcut = parseKey(data);
    if (!shortcut) {
      this.message = this.theme.fg("warning", "Could not parse that key; try another.");
      this.requestRender();
      return;
    }

    this.done({ shortcut, conflicts: findShortcutConflicts(shortcut, this.keybindings) });
  }

  /** No cached state to invalidate. */
  invalidate(): void {}
}

/** Return keybinding ids whose effective key list already includes the shortcut. */
function findShortcutConflicts(
  shortcut: string,
  keybindings: ShortcutCaptureKeybindings,
): string[] {
  const effective = keybindings.getEffectiveConfig?.() ?? {};
  const normalized = shortcut.toLowerCase();
  const conflicts: string[] = [];
  for (const [id, value] of Object.entries(effective)) {
    const keys = Array.isArray(value) ? value : value ? [value] : [];
    if (keys.some((key) => key.toLowerCase() === normalized)) conflicts.push(id);
  }
  return conflicts;
}

/** Prompt for one subagent tier mapping and persist it through centralized settings. */
async function configureSubagentTier(
  ctx: ExtensionCommandContext,
  tier: "fast" | "high",
): Promise<void> {
  const current = await readGlobalCoreSubagentSettings();
  const available = [
    ...new Set(
      ctx.modelRegistry
        .getAll()
        .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
        .map((model) => `${model.provider}/${model.id}`),
    ),
  ].sort();
  if (available.length === 0) {
    ctx.ui.notify(
      "[core-settings] no authenticated models available; use /login or /core-settings edit for raw JSON configuration",
      "warning",
    );
    return;
  }

  const currentModel = current?.[tier]?.model;
  const selectedModel = await ctx.ui.select(
    `Subagent ${tier} model${currentModel ? ` (current: ${currentModel})` : ""}`,
    available,
  );
  if (!selectedModel) return;

  const thinkingLevel = await ctx.ui.select(`Subagent ${tier} thinking level`, [
    "unset",
    ...SUBAGENT_THINKING_LEVELS,
  ]);
  if (thinkingLevel && thinkingLevel !== "unset" && !isSubagentThinkingLevel(thinkingLevel)) {
    ctx.ui.notify(`[core-settings] unsupported thinking level selected: ${thinkingLevel}`, "error");
    return;
  }
  const persistedThinkingLevel: ThinkingLevel | undefined =
    thinkingLevel && thinkingLevel !== "unset" && isSubagentThinkingLevel(thinkingLevel)
      ? thinkingLevel
      : undefined;
  const next = { ...current };
  next[tier] = {
    model: selectedModel,
    ...(persistedThinkingLevel ? { thinkingLevel: persistedThinkingLevel } : {}),
  };
  const validated = validateCoreSettings({ version: 1, subagents: next });
  if (typeof validated === "string") {
    ctx.ui.notify(`[core-settings] subagent ${tier} rejected — ${validated}`, "error");
    return;
  }
  await writeGlobalCoreSubagentSettings(next);
  ctx.ui.notify(`[core-settings] subagent ${tier} updated (${globalCoreSettingsPath()})`, "info");
}

/** Return whether a selected UI string is a supported persisted thinking level. */
function isSubagentThinkingLevel(value: string): value is ThinkingLevel {
  return (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value);
}
