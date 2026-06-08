import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  AppliedPresetInput,
  SubagentModelSelection,
  SubagentRun,
  SubagentRunStatus,
  ToolPolicy,
} from "./types.ts";
import { MAX_RECORDED_RUNS } from "./types.ts";

/** NATO phonetic alphabet, used to assign readable subagent ids in spawn order. */
const NATO_NAMES = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliett",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
] as const;

/**
 * Build the next readable run id: a NATO phonetic name picked by spawn order with a tiny
 * random suffix for uniqueness (e.g. `alpha-7f`). The suffix is retried against `taken` so
 * the id stays unique even after the name pool wraps.
 */
export function nextRunId(seq: number, taken: Iterable<string>): string {
  const base = NATO_NAMES[seq % NATO_NAMES.length];
  const used = new Set(taken);
  let id: string;
  do {
    id = `${base}-${Math.random().toString(36).slice(2, 4)}`;
  } while (used.has(id));
  return id;
}

/** Create an in-memory run record for a new subagent invocation. */
export function createRun(
  id: string,
  input: AppliedPresetInput,
  selection: SubagentModelSelection,
  tools: ToolPolicy,
): SubagentRun {
  return {
    id,
    task: input.task,
    modelId: selection.modelId,
    thinkingLevel: selection.thinkingLevel,
    modelSource: selection.source,
    tools,
    presetAgentName: input.presetAgentName,
    presetAgentSource: input.presetAgentSource,
    status: "queued",
    currentActivity: "queued",
    startedAt: Date.now(),
  };
}

/** Update run activity from nested session events. */
export function handleSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void {
  switch (event.type) {
    case "agent_start":
      run.status = "running";
      run.currentActivity = "starting";
      break;
    case "turn_start":
      run.currentActivity = "thinking";
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") run.currentActivity = "responding";
      break;
    case "tool_execution_start":
      run.currentActivity = `using ${event.toolName}`;
      break;
    case "tool_execution_end":
      run.currentActivity = `${event.toolName} ${event.isError ? "error" : "done"}`;
      break;
    case "agent_end":
      // Preserve an operator-initiated abort; only a still-active run completes as done.
      if (run.status === "aborted") break;
      run.status = "done";
      run.currentActivity = "done";
      run.endedAt = Date.now();
      break;
  }
}

/** Keep only the newest bounded number of run records. */
export function pruneRuns(runs: SubagentRun[]): void {
  if (runs.length > MAX_RECORDED_RUNS) runs.splice(MAX_RECORDED_RUNS);
}

/** Return whether any run is currently active. */
export function hasActiveRuns(runs: SubagentRun[]): boolean {
  return runs.some((run) => run.status === "queued" || run.status === "running");
}

/** Return the display source for model selection plus preset agent metadata. */
export function formatRunSource(run: SubagentRun): string {
  return run.presetAgentName
    ? `${run.modelSource} · agent:${run.presetAgentName}`
    : run.modelSource;
}

/** Return a compact status icon. */
export function statusIcon(status: SubagentRunStatus): string {
  if (status === "queued") return "○";
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "aborted") return "■";
  return "!";
}

/** Format elapsed run time. */
export function formatElapsed(run: SubagentRun): string {
  const end = run.endedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - run.startedAt) / 1000))}s`;
}

/**
 * Build the text returned to the parent agent when a run is cancelled by the operator.
 * Includes any operator notes and any partial output captured before cancellation.
 */
export function formatCancellationResult(run: SubagentRun, partial: string): string {
  const lines = [`Subagent ${run.id} was cancelled by the user before completing.`];
  if (run.cancelNotes) lines.push(`User notes: ${run.cancelNotes}`);
  const trimmed = partial.trim();
  if (trimmed) lines.push("", "Partial output before cancellation:", trimmed);
  return lines.join("\n");
}

/** Truncate text to a single line with an ellipsis. */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
