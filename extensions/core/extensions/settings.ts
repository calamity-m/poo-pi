import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

import { coreSettingsPath } from "../config/paths.ts";
import {
  readCoreClientTlsSkip,
  readCoreProxyRedactionMode,
  readCoreSettings,
  readCoreSubagentSettings,
  validateCoreSettings,
  writeCoreClientTlsSkip,
  writeCoreSettings,
  writeCoreSubagentSettings,
} from "../config/persistence.ts";
import type { PermissionsController } from "./permissions/index.ts";
import type { PermissionMode } from "./permissions/types.ts";
import { auditPaths, writeRedactionMode } from "./proxy/audit.ts";
import { showInlinePanel } from "./proxy/audit-panel.ts";
import type { RedactionMode } from "./proxy/types.ts";
import type { ClientTlsController } from "./tls/index.ts";

/** Live controllers the settings UI routes simple changes and configure actions through. */
export interface CoreSettingsControllers {
  /** Permissions live state controller (mode + validated config editor). */
  permissions: PermissionsController;
  /** Client TLS controller (secret-safe setup flow + redacted status). */
  tls: ClientTlsController;
}

/** Permission modes offered as a cycling row in the settings UI. */
const MODES: PermissionMode[] = ["safe", "trusted", "permissive", "open"];

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
    description: "View or edit poo-pi core settings stored in .pi/core-settings.json",
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "show") {
        await showSettings(ctx);
        return;
      }
      if (sub === "edit") {
        await editSettings(ctx);
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
async function editSettings(ctx: ExtensionCommandContext): Promise<void> {
  const path = coreSettingsPath(ctx.cwd);
  if (!ctx.hasUI) {
    ctx.ui.notify(`edit ${path} directly to modify core settings`, "info");
    return;
  }

  const prefill = `${JSON.stringify(await readCoreSettings(ctx.cwd), null, 2)}\n`;
  const edited = await ctx.ui.editor("Edit core settings (.pi/core-settings.json)", prefill);
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
  ctx.ui.notify("[core-settings] config updated", "info");
}

/**
 * Drive the interactive settings list. Each pass re-reads current settings and
 * live state so rows never show stale values after a configure/edit sub-flow;
 * simple rows live-apply through {@link applyChange} without leaving the list.
 *
 * NOTE: permission-mode live-apply is interactive-only — headless sessions run
 * `open` regardless of the persisted mode, so the chosen mode is not globally
 * enforced. Permission rules and TLS targets remain editable only through the
 * permissions editor, TLS setup, or raw JSON, not as inline rows.
 */
async function openCoreSettingsSelector(
  ctx: ExtensionCommandContext,
  controllers: CoreSettingsControllers,
): Promise<void> {
  for (;;) {
    const redaction = await readCoreProxyRedactionMode(auditPaths(ctx.cwd).dir);
    const tlsSkipped = await readCoreClientTlsSkip(ctx.cwd);
    const subagents = await readCoreSubagentSettings(ctx.cwd);

    const result = await ctx.ui.custom<SelectorResult>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = [
        {
          id: "permissions-mode",
          label: "Permissions mode",
          description: "Tool gating policy (interactive sessions only; headless runs open).",
          currentValue: controllers.permissions.getMode(),
          values: [...MODES],
        },
        actionItem(
          "permissions-config",
          "Permissions config",
          "configure",
          "Edit permission rules and remembered grants as validated JSON.",
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
          "tls",
          "Client TLS",
          tlsSkipped ? "skipped" : controllers.tls.statusLabel(),
          "Configure the mTLS client certificate via the secret-safe setup flow.",
          done,
        ),
        {
          id: "tls-skip",
          label: "Skip client TLS",
          description:
            "Skip mTLS setup at startup — no prompt, no client cert. Applies next startup.",
          currentValue: tlsSkipped ? "on" : "off",
          values: ["on", "off"],
        },
        actionItem(
          "subagents-fast",
          "Subagent fast model",
          subagents?.fast?.model ?? "unset",
          "Configure provider/model-id and optional thinking level for fast subagents.",
          done,
        ),
        actionItem(
          "subagents-high",
          "Subagent high model",
          subagents?.high?.model ?? "unset",
          "Configure provider/model-id and optional thinking level for high-capability subagents.",
          done,
        ),
        actionItem(
          "json-edit",
          "Core settings JSON",
          "edit",
          "Edit the raw .pi/core-settings.json for advanced changes.",
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

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("core settings")), 1, 1));
      container.addChild(list);

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
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
  if (id === "tls-skip") {
    await writeCoreClientTlsSkip(ctx.cwd, value === "on");
    ctx.ui.notify(
      value === "on"
        ? "tls: skip enabled — no client cert on next startup"
        : "tls: skip disabled — setup runs on next startup",
      "info",
    );
  }
}

/** Run a configure/edit action selected from the settings list. */
async function runAction(
  ctx: ExtensionCommandContext,
  controllers: CoreSettingsControllers,
  id: string,
): Promise<void> {
  if (id === "permissions-config") {
    await controllers.permissions.editConfig(ctx);
    return;
  }
  if (id === "tls") {
    await controllers.tls.configure(ctx);
    return;
  }
  if (id === "subagents-fast" || id === "subagents-high") {
    await configureSubagentTier(ctx, id === "subagents-fast" ? "fast" : "high");
    return;
  }
  if (id === "json-edit") {
    await editSettings(ctx);
  }
}

/** Prompt for one subagent tier mapping and persist it through the unified settings file. */
async function configureSubagentTier(
  ctx: ExtensionCommandContext,
  tier: "fast" | "high",
): Promise<void> {
  const current = await readCoreSubagentSettings(ctx.cwd);
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
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  const next = { ...current };
  next[tier] = {
    model: selectedModel,
    ...(thinkingLevel && thinkingLevel !== "unset" ? { thinkingLevel } : {}),
  };
  const validated = validateCoreSettings({ version: 1, subagents: next });
  if (typeof validated === "string") {
    ctx.ui.notify(`[core-settings] subagent ${tier} rejected — ${validated}`, "error");
    return;
  }
  await writeCoreSubagentSettings(ctx.cwd, next);
  ctx.ui.notify(`[core-settings] subagent ${tier} updated`, "info");
}
