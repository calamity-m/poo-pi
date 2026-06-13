import { basename } from "node:path";

import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { readCoreFooterSettings, writeCoreFooterSettings } from "../config/persistence.ts";
import type { CoreFooterSettings } from "../config/types.ts";
import { formatPercent, formatTokens } from "../lib/format.ts";
import { clearLinkedWorktreeCache, resolveLinkedWorktree } from "../lib/worktree.ts";
import type { PermissionsController } from "./permissions/index.ts";
import type { PermissionMode } from "./permissions/types.ts";
import type { ProxyReadinessHandle } from "./proxy/index.ts";
import type { SubagentsController } from "./subagents/index.ts";

/** Default footer template: a continuous powerline of live core-extension state. */
const DEFAULT_TEMPLATE = "{permissions}{project}{subagents}{context}{model}{worktree}{branch}";

/** Context percent where the footer shifts from healthy to warning. */
const CONTEXT_WARNING_PERCENT = 70;

/** Context percent where the footer shifts from warning to critical. */
const CONTEXT_CRITICAL_PERCENT = 90;

/** Active custom footer render callbacks for state changes outside footerData. */
const footerRenderRequests = new Set<() => void>();

/**
 * Nerd-font glyphs labelling each segment, echoing the gruvbox-rainbow preset's
 * icon-per-block aesthetic. Requires a patched (Nerd Font) terminal font.
 */
const GLYPHS = {
  permissions: "", // shield
  project: "", // folder
  subagents: "", // users
  model: "", // microchip
  context: "󰘚", // gauge
  branch: "", // git branch
  worktree: "", // linked worktree
  proxy: "", // globe
  status: "", // gear
} as const;

/** Powerline boundary glyphs: rounded opening cap and the solid right divider. */
const POWERLINE = {
  capLeft: "", //
  divider: "", //
} as const;

/** Runtime controllers the footer reads to summarize core extension state. */
export interface CoreFooterControllers {
  /** Permissions live state controller. */
  permissions: PermissionsController;
  /** Provider proxy readiness/status handle. */
  proxy: ProxyReadinessHandle;
  /** Subagent live run status controller. */
  subagents: SubagentsController;
}

/** Mutable footer state for the current extension runtime. */
interface FooterState {
  /** Whether this extension currently owns the footer renderer. */
  enabled: boolean;
  /** Template rendered by the core footer. */
  template: string;
}

/** Runtime controller used by `/core-settings` to mutate footer config live. */
export interface CoreFooterController {
  /** Return the current runtime footer settings. */
  getSettings(): Required<CoreFooterSettings>;
  /** Enable or disable the core footer and persist the choice. */
  setEnabled(ctx: ExtensionCommandContext, enabled: boolean): Promise<void>;
  /** Set the core footer template, enable the footer, and persist both. */
  setTemplate(ctx: ExtensionCommandContext, template: string): Promise<void>;
}

/** Register the core status footer and expose its runtime settings controller. */
export function registerCoreFooter(
  pi: ExtensionAPI,
  controllers: CoreFooterControllers,
): CoreFooterController {
  const state: FooterState = {
    enabled: true,
    template: DEFAULT_TEMPLATE,
  };

  pi.on("session_start", (_event, ctx) => {
    void reloadFooterSettings(ctx.cwd, state).then(() => {
      if (state.enabled) {
        applyFooter(ctx, state, controllers);
      } else {
        ctx.ui.setFooter(undefined);
      }
    });
  });

  pi.on("model_select", (_event, ctx) => {
    if (state.enabled) applyFooter(ctx, state, controllers);
  });

  return {
    getSettings: () => ({ enabled: state.enabled, template: state.template }),
    setEnabled: async (ctx, enabled) => {
      state.enabled = enabled;
      await persistFooterSettings(ctx.cwd, state);
      if (state.enabled) {
        applyFooter(ctx, state, controllers);
      } else {
        ctx.ui.setFooter(undefined);
      }
    },
    setTemplate: async (ctx, template) => {
      state.template = template;
      state.enabled = true;
      await persistFooterSettings(ctx.cwd, state);
      applyFooter(ctx, state, controllers);
    },
  };
}

/** Reload persisted footer settings into the runtime footer state. */
async function reloadFooterSettings(cwd: string, state: FooterState): Promise<void> {
  applyFooterSettings(state, await readCoreFooterSettings(cwd));
}

/** Persist the runtime footer state through unified core settings. */
async function persistFooterSettings(cwd: string, state: FooterState): Promise<void> {
  await writeCoreFooterSettings(cwd, { enabled: state.enabled, template: state.template });
}

/** Apply persisted footer settings, falling back to built-in defaults. */
function applyFooterSettings(state: FooterState, settings: CoreFooterSettings | undefined): void {
  state.enabled = settings?.enabled ?? true;
  state.template = settings?.template ?? DEFAULT_TEMPLATE;
}

/** Apply the current core footer renderer. */
function applyFooter(
  ctx: ExtensionContext,
  state: FooterState,
  controllers: CoreFooterControllers,
): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const requestRender = () => tui.requestRender();
    const unsubscribeBranch = footerData.onBranchChange(() => {
      clearLinkedWorktreeCache(ctx.cwd);
      requestRender();
    });
    footerRenderRequests.add(requestRender);

    return {
      dispose: () => {
        unsubscribeBranch();
        footerRenderRequests.delete(requestRender);
      },
      invalidate() {},
      render(width: number): string[] {
        const rendered = renderFooter(
          state.template,
          buildSegments(ctx, controllers, footerData),
          theme,
        );
        return [truncateToWidth(compactWhitespace(rendered), width)];
      },
    };
  });
}

/** A single powerline block: a glyph, label/value, and its theme color tokens. */
interface Segment {
  /** Nerd-font glyph shown before the label. */
  glyph: string;
  /** Short segment label, e.g. `perm`. */
  label: string;
  /** Live value rendered after the label. */
  value: string;
  /** Foreground (text/glyph) theme color token. */
  fg: string;
  /** Background theme color token; also drives powerline blending. */
  bg: string;
}

/** Build the per-token segment descriptors the powerline renderer consumes. */
function buildSegments(
  ctx: ExtensionContext,
  controllers: CoreFooterControllers,
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
): Record<string, Segment[]> {
  const proxyStatus = controllers.proxy.statusLabel();
  const subagentStatus = controllers.subagents.statusLabel();
  const worktree = resolveLinkedWorktree(ctx.cwd);

  return {
    permissions: [permissionsSegment(controllers.permissions.getMode())],
    proxy: [statusSegment(GLYPHS.proxy, "proxy", proxyStatus.replace(/^proxy:/, ""))],
    project: [
      {
        glyph: GLYPHS.project,
        label: "cwd",
        value: projectLabel(ctx.cwd),
        fg: "warning",
        bg: "customMessageBg",
      },
    ],
    subagents: [subagentsSegment(subagentStatus)],
    context: [contextSegment(ctx.getContextUsage(), ctx.model?.contextWindow)],
    model: [
      {
        glyph: GLYPHS.model,
        label: "model",
        value: ctx.model?.id ?? "none",
        fg: ctx.model ? "success" : "warning",
        bg: ctx.model ? "toolSuccessBg" : "toolPendingBg",
      },
    ],
    worktree: worktree ? [worktreeSegment(worktree.label)] : [],
    branch: [
      {
        glyph: GLYPHS.branch,
        label: "git",
        value: worktree?.branch ?? footerData.getGitBranch() ?? "none",
        fg: "syntaxKeyword",
        bg: "userMessageBg",
      },
    ],
    statuses: formatStatuses(footerData.getExtensionStatuses()),
  };
}

/** Return a compact project-location label for the current working directory. */
function projectLabel(cwd: string): string {
  return basename(cwd) || cwd;
}

/** Request a custom footer repaint after external controller state changes. */
export function requestCoreFooterRender(): void {
  for (const requestRender of footerRenderRequests) requestRender();
}

/** Build the compact current permissions-mode segment shown in the footer. */
function permissionsSegment(mode: PermissionMode): Segment {
  const colors = permissionModeColors(mode);
  return { glyph: GLYPHS.permissions, label: "perm", value: mode, ...colors };
}

/** Map each permission mode to risk-signaling footer color tokens. */
function permissionModeColors(mode: PermissionMode): Pick<Segment, "fg" | "bg"> {
  const colors = {
    safe: { fg: "success", bg: "toolSuccessBg" },
    trusted: { fg: "accent", bg: "selectedBg" },
    permissive: { fg: "warning", bg: "toolPendingBg" },
    open: { fg: "error", bg: "toolErrorBg" },
  } satisfies Record<PermissionMode, Pick<Segment, "fg" | "bg">>;
  return colors[mode];
}

/** Build the linked-worktree identity segment shown only in linked worktrees. */
function worktreeSegment(label: string): Segment {
  return {
    glyph: GLYPHS.worktree,
    label: "wt",
    value: label,
    fg: "accent",
    bg: "selectedBg",
  };
}

/** Build the compact current subagent-activity segment shown in the footer. */
function subagentsSegment(statusLabel: string | undefined): Segment {
  const active = statusLabel !== undefined;
  return {
    glyph: GLYPHS.subagents,
    label: "subagents",
    value: statusLabel?.replace(/^subagents:/, "") ?? "idle",
    fg: active ? "mdLink" : "muted",
    bg: active ? "toolPendingBg" : "customMessageBg",
  };
}

/** Build the compact current context-usage segment shown in the footer. */
function contextSegment(usage: ContextUsage | undefined, modelWindow: number | undefined): Segment {
  const percent = usage?.percent ?? null;
  const colors = contextPressureColors(percent);
  return {
    glyph: GLYPHS.context,
    label: "ctx",
    value: formatFooterContextUsage(usage, modelWindow),
    ...colors,
  };
}

/** Format live context usage as a terse token/window plus percent value. */
function formatFooterContextUsage(
  usage: ContextUsage | undefined,
  modelWindow: number | undefined,
): string {
  const tokens = usage?.tokens ?? null;
  const contextWindow = usage?.contextWindow ?? modelWindow ?? null;
  const percent = usage?.percent ?? null;
  return `${formatTokens(tokens)}/${formatTokens(contextWindow)} ${formatPercent(percent)}`;
}

/** Pick context-usage color tokens by pressure level. */
function contextPressureColors(percent: number | null): Pick<Segment, "fg" | "bg"> {
  if (percent === null) return { fg: "warning", bg: "toolPendingBg" };
  if (percent >= CONTEXT_CRITICAL_PERCENT) return { fg: "error", bg: "toolErrorBg" };
  if (percent >= CONTEXT_WARNING_PERCENT) return { fg: "warning", bg: "toolPendingBg" };
  return { fg: "success", bg: "toolSuccessBg" };
}

/** Minimal theme surface used by this footer renderer. */
interface FooterTheme {
  /** Apply a named foreground color. */
  fg(color: string, text: string): string;
  /** Apply a named background color. */
  bg(color: string, text: string): string;
  /** Bold text. */
  bold(text: string): string;
  /** Return the raw background ANSI escape for a token (used for blending). */
  getBgAnsi(color: string): string;
}

/** Render an ordered list of segments as one seamless powerline. */
function renderPowerline(theme: FooterTheme, segments: Segment[]): string {
  if (segments.length === 0) return "";
  const out: string[] = [];
  // Rounded opening cap drawn in the first segment's color over the terminal bg.
  out.push(`${bgToFg(theme.getBgAnsi(segments[0].bg))}${POWERLINE.capLeft}\x1b[0m`);
  segments.forEach((seg, index) => {
    out.push(renderBody(theme, seg));
    const next = segments[index + 1];
    // The divider is this segment's bg color (as fg) over the next segment's bg,
    // so adjacent blocks flow into one another. The final divider sits over the
    // default terminal background.
    const over = next ? theme.getBgAnsi(next.bg) : "\x1b[49m";
    out.push(`${bgToFg(theme.getBgAnsi(seg.bg))}${over}${POWERLINE.divider}\x1b[0m`);
  });
  return out.join("");
}

/** Render a segment's filled body: glyph, bold label, and value. */
function renderBody(theme: FooterTheme, seg: Segment): string {
  return theme.bg(seg.bg, theme.fg(seg.fg, ` ${seg.glyph} ${theme.bold(seg.label)}:${seg.value} `));
}

/** Reuse a background ANSI escape as a foreground color for powerline dividers. */
function bgToFg(bgAnsi: string): string {
  return bgAnsi.replace("\x1b[48;", "\x1b[38;").replace("\x1b[49m", "\x1b[39m");
}

/** Build a status segment whose colors derive from its terse status value. */
function statusSegment(glyph: string, label: string, status: string): Segment {
  return { glyph, label, value: status, fg: statusColor(status), bg: statusBackground(status) };
}

/** Pick a foreground color token from a terse status value. */
function statusColor(status: string): string {
  if (status.includes("error")) return "error";
  if (status.includes("loaded") || status.includes("route")) return "success";
  if (status.includes("skipped") || status.includes("unconfigured") || status.includes("off"))
    return "warning";
  return "accent";
}

/** Pick a background color token from a terse status value. */
function statusBackground(status: string): string {
  if (status.includes("error")) return "toolErrorBg";
  if (status.includes("loaded") || status.includes("route")) return "toolSuccessBg";
  return "toolPendingBg";
}

/**
 * Render a footer template into powerline text. Each `{token}` expands to its
 * segments; runs of adjacent segments form one continuous powerline, while any
 * literal text between tokens is emitted verbatim and breaks the run.
 */
function renderFooter(
  template: string,
  segmentsByToken: Record<string, Segment[]>,
  theme: FooterTheme,
): string {
  const out: string[] = [];
  let run: Segment[] = [];
  const flush = () => {
    if (run.length > 0) {
      out.push(renderPowerline(theme, run));
      run = [];
    }
  };
  for (const part of template.split(/(\{[a-z]+\})/g)) {
    if (part === "") continue;
    const token = /^\{([a-z]+)\}$/.exec(part)?.[1];
    const segments = token ? segmentsByToken[token] : undefined;
    if (segments) {
      run.push(...segments);
    } else {
      flush();
      out.push(part);
    }
  }
  flush();
  return out.join("");
}

/** Map extension status entries to footer segments. */
function formatStatuses(statuses: ReadonlyMap<string, string>): Segment[] {
  return [...statuses.entries()].map(([key, value]) => ({
    glyph: GLYPHS.status,
    label: key,
    value,
    fg: "muted",
    bg: "customMessageBg",
  }));
}

/** Collapse empty token gaps while preserving deliberate separators. */
function compactWhitespace(text: string): string {
  return visibleWidth(text) === 0 ? "" : text.replace(/\s+/g, " ").trim();
}

/** Expose pure helpers for focused unit tests. */
export const __footerForTest = {
  renderFooter,
  renderPowerline,
  bgToFg,
  GLYPHS,
  POWERLINE,
  formatFooterContextUsage,
  permissionModeColors,
  subagentsSegment,
  worktreeSegment,
  contextPressureColors,
  CONTEXT_WARNING_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
} satisfies Record<string, unknown>;
