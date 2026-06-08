import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { TSchema, Static } from "typebox";
import { Type } from "typebox";

import type { ProxyReadinessHandle } from "../proxy/index.ts";
import type { PresetAgent } from "./preset-agents.ts";

export const TOOL_POLICIES = ["none", "read-only", "coding"] as const;
export const TIERS = ["fast", "high"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const MAX_RECORDED_RUNS = 20;
export const MAX_PRELOADED_FILE_CHARS = 20_000;
export const MAX_PRELOADED_TOTAL_CHARS = 60_000;

export const toolPolicyNames = {
  none: [],
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
} satisfies Record<ToolPolicy, string[]>;

export const spawnSubagentSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Optional named preset agent to use before explicit overrides." }),
  ),
  task: Type.String({ description: "The isolated subagent task to run." }),
  tier: Type.Optional(StringEnum(TIERS, { description: "Configured subagent tier to use." })),
  model: Type.Optional(
    Type.String({ description: "Raw canonical model override, provider/model-id." }),
  ),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
  role: Type.Optional(Type.String({ description: "Optional role/persona for the subagent." })),
  context: Type.Optional(Type.String({ description: "Extra context to provide to the subagent." })),
  files: Type.Optional(
    Type.Array(Type.String(), { description: "Relevant file paths to preload into the prompt." }),
  ),
  tools: Type.Optional(
    StringEnum(TOOL_POLICIES, { description: "Tool access policy. Defaults to read-only." }),
  ),
  outputFormat: Type.Optional(Type.String({ description: "Requested final answer format." })),
}) satisfies TSchema;

export type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export type Tier = (typeof TIERS)[number];
export type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

/** Merged preset + explicit tool-call params with provenance metadata. */
export interface AppliedPresetInput extends SpawnSubagentInput {
  /** Selected preset name for operator reporting. */
  presetAgentName?: string;
  /** Selected preset source path for diagnostics. */
  presetAgentSource?: string;
}

/** Options passed to registerSubagents. */
export interface RegisterSubagentsOptions {
  /** Optional proxy readiness hook; when present, subagents re-resolve models after it runs. */
  proxy?: ProxyReadinessHandle;
}

/** Live subagent status exposed to the core footer. */
export interface SubagentsController {
  /** Compact status label for active subagent work, or undefined when idle. */
  statusLabel(): string | undefined;
}

/** In-memory record for one subagent invocation. */
export interface SubagentRun {
  /** Stable display id for this in-memory run. */
  id: string;
  /** User-facing task summary. */
  task: string;
  /** Canonical resolved model id. */
  modelId: string;
  /** Resolved thinking level. */
  thinkingLevel?: ThinkingLevel;
  /** Where model selection came from. */
  modelSource: string;
  /** Tool access policy granted to the nested session. */
  tools: ToolPolicy;
  /** Optional preset agent used for this run. */
  presetAgentName?: string;
  /** Optional preset source path used for this run. */
  presetAgentSource?: string;
  /** Current lifecycle status. */
  status: SubagentRunStatus;
  /** Compact status line for operators. */
  currentActivity: string;
  /** Final answer snippet, retained in memory only. */
  finalText?: string;
  /** Full nested-session transcript, retained in memory only. */
  transcript?: unknown[];
  /** Error text, retained in memory only. */
  error?: string;
  /** Start timestamp in milliseconds. */
  startedAt: number;
  /** End timestamp in milliseconds. */
  endedAt?: number;
  /**
   * Abort hook for a live run. Aborts the nested session and records optional operator
   * notes that are surfaced back to the parent agent. Present only while the run is active.
   */
  cancel?: (notes?: string) => void;
  /** Operator-provided cancellation notes, surfaced back to the parent agent. */
  cancelNotes?: string;
}

/** Action chosen from the `/subagents` selector overlay. */
export type SubagentSelectAction =
  | { kind: "open"; runId: string }
  | { kind: "cancel"; runId: string; withNotes: boolean }
  | { kind: "cancel-all"; withNotes: boolean };

/** Cancel variants of {@link SubagentSelectAction}. */
export type SubagentCancelAction = Extract<SubagentSelectAction, { kind: "cancel" | "cancel-all" }>;

/** Resolved model plus provenance for a subagent session. */
export interface SubagentModelSelection {
  /** Model object from the live registry. */
  model: Model<any>;
  /** Canonical provider/model-id string. */
  modelId: string;
  /** Thinking level for the nested session. */
  thinkingLevel?: ThinkingLevel;
  /** Human-readable source for reporting. */
  source: string;
}

export type { ProxyReadinessHandle, PresetAgent };
