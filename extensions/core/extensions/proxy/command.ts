import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { showNavigablePanel, showPanel, showSelectPanel } from "../../lib/ui/panel.ts";
import { readRecentTail, writeRedactionMode } from "./audit.ts";
import type { AuditRecord, ProxyState, RedactionMode } from "./types.ts";

/** How many recent requests `/proxy recent` lists. */
const RECENT_VIEW_LIMIT = 20;

/**
 * Register the `/proxy [status|recent|redact <on|off>]` operator command.
 *
 * - `status` (default) shows server state/port, routes, unproxied providers, warnings, and recent errors.
 * - `recent` lists recently audited requests (by tailing the index).
 * - `redact on|off` flips the redaction switch live for subsequent requests.
 *
 * Output renders as a TUI panel when a UI is available, and falls back to
 * `ctx.ui.notify` otherwise.
 */
export function registerProxyCommand(pi: ExtensionAPI, state: ProxyState): void {
  pi.registerCommand("proxy", {
    description:
      "Inspect the provider reverse proxy: status, recent requests, and redaction switch",
    handler: async (args, ctx) => {
      const [sub, value] = args.trim().split(/\s+/, 2);
      switch (sub) {
        case "":
          if (ctx.hasUI) {
            await showProxyMenu(ctx, state);
            return;
          }
          await present(ctx, "proxy: status", statusLines(state));
          return;
        case "status":
          await present(ctx, "proxy: status", statusLines(state));
          return;
        case "recent":
          await present(ctx, "proxy: recent requests", await recentLines(state));
          return;
        case "redact":
          await handleRedact(ctx, state, value);
          return;
        default:
          ctx.ui.notify("usage: /proxy [status|recent|redact <on|off>]", "warning");
      }
    },
  });
}

/** Show the interactive proxy command menu using the shared select-panel UX. */
async function showProxyMenu(ctx: ExtensionCommandContext, state: ProxyState): Promise<void> {
  while (true) {
    const selected = await showSelectPanel(ctx, {
      title: "proxy",
      items: [
        {
          value: "status",
          label: "status",
          description: "Show server state, routes, warnings, and recent errors",
        },
        {
          value: "recent",
          label: "recent requests",
          description: "Show recently audited provider requests",
        },
        {
          value: "redact-on",
          label: "redaction on",
          description: "Mask sensitive headers in future audit records",
        },
        {
          value: "redact-off",
          label: "redaction off",
          description: "Log raw headers, including api keys, in future audit records",
        },
      ],
      footer: "↑↓ navigate • Enter open • Esc close",
    });

    switch (selected) {
      case "status":
        if ((await presentNavigable(ctx, "proxy: status", statusLines(state))) === "back") continue;
        return;
      case "recent":
        if (
          (await presentNavigable(ctx, "proxy: recent requests", await recentLines(state))) ===
          "back"
        )
          continue;
        return;
      case "redact-on":
        await handleRedact(ctx, state, "on");
        return;
      case "redact-off":
        await handleRedact(ctx, state, "off");
        return;
      default:
        return;
    }
  }
}

/** Apply a redaction-switch flip, validating the requested mode. */
async function handleRedact(
  ctx: ExtensionCommandContext,
  state: ProxyState,
  value: string | undefined,
): Promise<void> {
  if (value !== "on" && value !== "off") {
    ctx.ui.notify("usage: /proxy redact <on|off>", "warning");
    return;
  }
  if (!state.auditDir) {
    ctx.ui.notify("proxy: audit store not initialized yet", "warning");
    return;
  }
  await writeRedactionMode(state.auditDir, value as RedactionMode);
  ctx.ui.notify(
    value === "on"
      ? "proxy: redaction on (sensitive headers masked)"
      : "proxy: redaction off (logging everything raw, including api keys)",
    "info",
  );
}

/** Build the status view lines from current proxy state. */
function statusLines(state: ProxyState): string[] {
  const lines: string[] = [];
  lines.push(
    state.server && state.port !== undefined
      ? `server: listening on 127.0.0.1:${state.port}`
      : `server: not running${state.startError ? ` (${state.startError})` : ""}`,
  );

  lines.push("", `routes (${state.routes.size}):`);
  for (const route of state.routes.values())
    lines.push(`  ${route.provider} -> ${route.upstreamBaseUrl}`);

  if (state.unproxied.length > 0) {
    lines.push("", `unproxied (${state.unproxied.length}):`);
    for (const item of state.unproxied) lines.push(`  ${item.provider} (${item.reason})`);
  }

  if (state.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of state.warnings) lines.push(`  ${warning}`);
  }

  const recentErrors = state.recent.filter((record) => record.response.error);
  if (recentErrors.length > 0 || state.writeErrors.length > 0) {
    lines.push("", "recent errors:");
    for (const record of recentErrors.slice(-5))
      lines.push(`  ${record.provider} ${record.request.upstreamUrl}: ${record.response.error}`);
    for (const error of state.writeErrors.slice(-5)) lines.push(`  ${error}`);
  }

  return lines;
}

/** Build the recent-requests view by tailing the audit index, falling back to the in-memory ring. */
async function recentLines(state: ProxyState): Promise<string[]> {
  let records: AuditRecord[] = [];
  if (state.auditDir) {
    try {
      records = await readRecentTail(state.auditDir, RECENT_VIEW_LIMIT);
    } catch {
      records = [];
    }
  }
  if (records.length === 0) records = state.recent.slice(-RECENT_VIEW_LIMIT);
  return records.map(formatRecord);
}

/** Render one audit record as a single status line. */
function formatRecord(record: AuditRecord): string {
  const model = record.model ? `/${record.model}` : "";
  const outcome = record.response.error
    ? `ERROR ${record.response.error}`
    : `${record.response.status ?? "?"} ${record.response.durationMs}ms`;
  return `${record.id} ${record.timestamp} ${record.provider}${model} ${record.request.method} ${outcome}`;
}

/** Show lines in a TUI panel when a UI is present; otherwise notify with joined text. */
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

/** Show lines from the interactive menu, where Backspace returns to the parent menu. */
async function presentNavigable(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
): Promise<"close" | "back"> {
  if (ctx.hasUI) return await showNavigablePanel(ctx, title, lines);
  ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
  return "close";
}
