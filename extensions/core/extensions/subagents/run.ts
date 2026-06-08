import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  AppliedPresetInput,
  SubagentModelSelection,
  SubagentRun,
  SubagentRunStatus,
  ToolPolicy,
} from "./types.ts";
import { MAX_RECORDED_RUNS } from "./types.ts";

/** Create an in-memory run record for a new subagent invocation. */
export function createRun(
  input: AppliedPresetInput,
  selection: SubagentModelSelection,
  tools: ToolPolicy,
): SubagentRun {
  return {
    id: `sa-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`,
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

/** Truncate text to a single line with an ellipsis. */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
