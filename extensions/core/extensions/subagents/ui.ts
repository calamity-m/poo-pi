import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { showInlinePanel, showSelectPanel, TextPanel } from "../../lib/ui/panel.ts";
import { requestCoreFooterRender } from "../footer.ts";
import { formatElapsed, formatRunSource, hasActiveRuns, statusIcon, truncate } from "./run.ts";
import { buildTranscriptLines } from "./transcript.ts";
import type { SubagentRun } from "./types.ts";

/** Update footer/widget state for active and recently completed subagents. */
export function updateSubagentsUi(
  ctx: ExtensionContext,
  runs: SubagentRun[],
  clearWidgetTimer: ReturnType<typeof setTimeout> | undefined,
  setClearWidgetTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
): void {
  if (clearWidgetTimer) {
    clearTimeout(clearWidgetTimer);
    setClearWidgetTimer(undefined);
  }

  const active = runs.filter((run) => run.status === "queued" || run.status === "running");
  if (active.length > 0) {
    ctx.ui.setStatus(
      "subagents",
      `${active.length} subagent${active.length === 1 ? "" : "s"} running`,
    );
    ctx.ui.setWidget("subagents", buildSubagentWidget(runs), { placement: "aboveEditor" });
    requestCoreFooterRender();
    return;
  }

  ctx.ui.setStatus("subagents", undefined);
  ctx.ui.setWidget("subagents", buildSubagentWidget(runs), { placement: "aboveEditor" });
  requestCoreFooterRender();
  setClearWidgetTimer(
    setTimeout(() => {
      ctx.ui.setWidget("subagents", undefined);
      setClearWidgetTimer(undefined);
    }, 8000),
  );
}

/** Format active subagent state for the core footer. */
export function formatSubagentsStatusLabel(runs: SubagentRun[]): string | undefined {
  const active = runs.filter((run) => run.status === "queued" || run.status === "running");
  if (active.length === 0) return undefined;
  const current = active[0];
  const suffix = active.length === 1 ? current.currentActivity : `${active.length} running`;
  return `subagents:${suffix}`;
}

/** Clear subagent UI decorations and timer. */
export function clearSubagentsUi(
  ctx: ExtensionContext,
  clearWidgetTimer: ReturnType<typeof setTimeout> | undefined,
  setClearWidgetTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
): void {
  if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
  setClearWidgetTimer(undefined);
  ctx.ui.setStatus("subagents", undefined);
  ctx.ui.setWidget("subagents", undefined);
  requestCoreFooterRender();
}

/** Build short widget lines for recent subagent runs. */
function buildSubagentWidget(runs: SubagentRun[]): string[] | undefined {
  if (runs.length === 0) return undefined;
  return runs
    .slice(0, 5)
    .map(
      (run) =>
        `${statusIcon(run.status)} ${run.id} ${formatRunSource(run)} ${run.currentActivity} — ${truncate(run.task, 72)}`,
    );
}

/** Build the text report shown by `/subagents`. */
export function buildSubagentsReport(runs: SubagentRun[]): string[] {
  if (runs.length === 0) return ["No subagent runs recorded in this extension runtime."];
  return runs.flatMap((run) => [
    `${statusIcon(run.status)} ${run.id} ${run.status.toUpperCase()} · ${formatRunSource(run)} · ${run.modelId}${run.thinkingLevel ? `:${run.thinkingLevel}` : ""} · tools:${run.tools}`,
    `task: ${truncate(run.task, 140)}`,
    `activity: ${run.currentActivity} · elapsed: ${formatElapsed(run)}`,
    ...(run.error ? [`error: ${truncate(run.error, 160)}`] : []),
    ...(run.finalText ? [`final: ${truncate(run.finalText, 220)}`] : []),
    "",
  ]);
}

/** Open the interactive subagent run selector and return the selected run id. */
export async function selectSubagentRun(
  ctx: ExtensionContext,
  runs: SubagentRun[],
): Promise<string | null> {
  if (runs.length === 0) {
    await showInlinePanel(ctx, "subagents", buildSubagentsReport(runs));
    return null;
  }

  return await showSelectPanel(ctx, {
    title: "subagent transcripts",
    items: runs.map((run) => ({
      value: run.id,
      label: `${statusIcon(run.status)} ${run.id} ${run.status}`,
      description: `${formatElapsed(run)} · ${formatRunSource(run)} · ${truncate(run.task, 90)}`,
    })),
    footer: "↑↓ navigate • Enter open transcript • Esc close",
  });
}

/** Open a colored, scrollable transcript panel for one subagent run. */
export async function showSubagentTranscript(
  ctx: ExtensionContext,
  run: SubagentRun,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new TextPanel(
        theme,
        keybindings,
        () => tui.requestRender(),
        done,
        `${run.id} transcript`,
        buildTranscriptLines(run, theme),
      ),
    { overlay: true, overlayOptions: { width: "90%", minWidth: 64, maxHeight: "85%" } },
  );
}

export { hasActiveRuns };
