import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema, Static } from "typebox";
import { Type } from "typebox";

import { readCoreSubagentSettings } from "../config/persistence.ts";
import type { ProxyReadinessHandle } from "./proxy/index.ts";
import { showInlinePanel } from "./proxy/audit-panel.ts";

const TOOL_POLICIES = ["none", "read-only", "coding"] as const;
const TIERS = ["fast", "high"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MAX_RECORDED_RUNS = 20;
const MAX_PRELOADED_FILE_CHARS = 20_000;
const MAX_PRELOADED_TOTAL_CHARS = 60_000;

const toolPolicyNames = {
  none: [],
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
} satisfies Record<ToolPolicy, string[]>;

const spawnSubagentSchema = Type.Object({
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
});

type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;
type ToolPolicy = (typeof TOOL_POLICIES)[number];
type Tier = (typeof TIERS)[number];
type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

interface RegisterSubagentsOptions {
  /** Optional proxy readiness hook; when present, subagents re-resolve models after it runs. */
  proxy?: ProxyReadinessHandle;
}

interface SubagentRun {
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
  /** Current lifecycle status. */
  status: SubagentRunStatus;
  /** Compact status line for operators. */
  currentActivity: string;
  /** Final answer snippet, retained in memory only. */
  finalText?: string;
  /** Error text, retained in memory only. */
  error?: string;
  /** Start timestamp in milliseconds. */
  startedAt: number;
  /** End timestamp in milliseconds. */
  endedAt?: number;
}

interface SubagentModelSelection {
  /** Model object from the live registry. */
  model: Model<any>;
  /** Canonical provider/model-id string. */
  modelId: string;
  /** Thinking level for the nested session. */
  thinkingLevel?: ThinkingLevel;
  /** Human-readable source for reporting. */
  source: string;
}

/** Register subagent spawning and visibility commands for the core extension bundle. */
export function registerSubagents(pi: ExtensionAPI, options: RegisterSubagentsOptions = {}): void {
  const runs: SubagentRun[] = [];
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;

  const updateUi = (ctx: ExtensionContext): void => {
    updateSubagentsUi(ctx, runs, clearWidgetTimer, (timer) => {
      clearWidgetTimer = timer;
    });
  };

  pi.on("input", async (_event, ctx) => {
    if (!hasActiveRuns(runs))
      clearSubagentsUi(ctx, clearWidgetTimer, (timer) => (clearWidgetTimer = timer));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearSubagentsUi(ctx, clearWidgetTimer, (timer) => (clearWidgetTimer = timer));
  });

  pi.registerCommand("subagents", {
    description: "Show active and recent isolated subagent runs",
    handler: async (_args, ctx) => {
      const lines = buildSubagentsReport(runs);
      if (ctx.hasUI) await showInlinePanel(ctx, "subagents", lines);
      else ctx.ui.notify(`subagents\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: "Run an isolated ephemeral Pi subagent and return only its final answer.",
    promptSnippet:
      "Run an isolated subagent for review, investigation, or parallel analysis tasks.",
    promptGuidelines: [
      "Use spawn_subagent for isolated investigation, review, or parallel analysis; prefer tier over raw model unless the user asks for a specific model.",
      "spawn_subagent defaults to read-only tools; request coding tools only when file mutation is explicitly needed.",
      "spawn_subagent returns only the final subagent answer; the nested transcript is intentionally ephemeral.",
    ],
    parameters: spawnSubagentSchema as TSchema,
    async execute(_toolCallId, params: SpawnSubagentInput, signal, onUpdate, ctx) {
      let run: SubagentRun | undefined;
      try {
        let selection = await resolveSubagentModel(params, ctx, pi);
        await options.proxy?.ensure(ctx);
        selection = await resolveSubagentModel(params, ctx, pi);

        assertProxyLoopbackIfRequired(selection, options.proxy);
        const policy = params.tools ?? "read-only";
        run = createRun(params, selection, policy);
        runs.unshift(run);
        pruneRuns(runs);
        updateUi(ctx);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Starting subagent ${run.id} (${selection.source}, ${policy} tools)…`,
            },
          ],
          details: {
            id: run.id,
            model: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            tools: policy,
          },
        });

        const loader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          noExtensions: true,
        });
        await loader.reload();

        const { session } = await createAgentSession({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          model: selection.model,
          thinkingLevel: selection.thinkingLevel,
          modelRegistry: ctx.modelRegistry,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(ctx.cwd),
          tools: toolPolicyNames[policy],
          noTools: policy === "none" ? "all" : undefined,
        });

        let finalText = "";
        const unsubscribe = session.subscribe((event) => {
          if (!run) return;
          handleSubagentEvent(run, event);
          if (event.type === "agent_end") finalText = extractFinalAssistantText(event.messages);
          updateUi(ctx);
        });

        try {
          const abort = (): void => {
            if (!run) return;
            run.status = "aborted";
            run.currentActivity = "aborting";
            run.endedAt = Date.now();
            updateUi(ctx);
            void session.abort();
          };
          if (signal?.aborted) {
            abort();
            throw new Error("Subagent aborted before start.");
          }
          signal?.addEventListener("abort", abort, { once: true });
          try {
            const preloadedFiles = await preloadFiles(ctx.cwd, params.files);
            await session.prompt(buildSubagentPrompt(params, preloadedFiles), {
              source: "extension",
            });
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        } finally {
          unsubscribe();
          session.dispose();
        }

        const text = finalText.trim() || "Subagent completed without a final text response.";
        run.status = run.status === "aborted" ? "aborted" : "done";
        run.currentActivity = run.status;
        run.finalText = text;
        run.endedAt = Date.now();
        updateUi(ctx);
        return {
          content: [{ type: "text", text }],
          details: {
            id: run.id,
            model: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            tools: policy,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (run) {
          run.status = signal?.aborted ? "aborted" : "error";
          run.currentActivity = run.status;
          run.error = message;
          run.endedAt = Date.now();
          updateUi(ctx);
        }
        return {
          content: [{ type: "text", text: message }],
          details: { id: run?.id, error: message },
          isError: true,
        };
      }
    },
  });
}

/** Resolve a model override, configured tier, or the current parent fallback from live registry state. */
async function resolveSubagentModel(
  input: SpawnSubagentInput,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<SubagentModelSelection> {
  if (input.model)
    return resolveCanonicalModel(input.model, input.thinkingLevel, ctx, "raw model override");

  const tier = normalizeTier(input.tier);
  if (tier) {
    const settings = await readCoreSubagentSettings(ctx.cwd);
    const mapping = settings?.[tier];
    if (!mapping) throw new Error(`No subagent model configured for tier "${tier}"`);
    return resolveCanonicalModel(
      mapping.model,
      input.thinkingLevel ?? mapping.thinkingLevel,
      ctx,
      `tier ${tier}`,
    );
  }

  if (!ctx.model)
    throw new Error("No subagent model configured and parent session has no active model.");
  const model = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) ?? ctx.model;
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Parent model is unavailable; authenticate provider "${model.provider}".`);
  }
  return {
    model,
    modelId: formatCanonicalModelId(model),
    thinkingLevel: normalizeThinkingLevel(input.thinkingLevel ?? pi.getThinkingLevel()),
    source: "parent fallback",
  };
}

/** Resolve and auth-check a canonical model id against the live model registry. */
function resolveCanonicalModel(
  canonicalId: string,
  thinkingLevel: string | undefined,
  ctx: ExtensionContext,
  source: string,
): SubagentModelSelection {
  const parsed = parseCanonicalModelId(canonicalId);
  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Unknown model: ${canonicalId}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model is known but unavailable; authenticate provider "${parsed.provider}" or configure its API key: ${canonicalId}`,
    );
  }
  return {
    model,
    modelId: canonicalId,
    thinkingLevel: normalizeThinkingLevel(thinkingLevel),
    source,
  };
}

/** Parse a canonical provider/model-id string. */
function parseCanonicalModelId(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid canonical model id: ${value}`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** Format a model as provider/model-id. */
function formatCanonicalModelId(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Normalize a tier parameter. */
function normalizeTier(value: string | undefined): Tier | undefined {
  if (value === undefined) return undefined;
  if (value === "fast" || value === "high") return value;
  throw new Error(`Invalid subagent tier: ${value}`);
}

/** Normalize a thinking level parameter. */
function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`Invalid thinkingLevel: ${value}`);
}

/** Fail fast when a proxied provider's selected model still points away from loopback after readiness. */
function assertProxyLoopbackIfRequired(
  selection: SubagentModelSelection,
  proxy: ProxyReadinessHandle | undefined,
): void {
  if (!proxy?.isActive() || !proxy.isProviderProxied(selection.model.provider)) return;
  const baseUrl = selection.model.baseUrl ?? "";
  if (!baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error(
      `Resolved subagent model ${selection.modelId} did not pick up the proxy baseUrl (resolved: ${baseUrl || "unknown"})`,
    );
  }
}

/** Create an in-memory run record. */
function createRun(
  input: SpawnSubagentInput,
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
    status: "queued",
    currentActivity: "queued",
    startedAt: Date.now(),
  };
}

/** Update run activity from nested session events. */
function handleSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void {
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

/** Update footer/widget state for active and recently completed subagents. */
function updateSubagentsUi(
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
    return;
  }

  ctx.ui.setStatus("subagents", undefined);
  ctx.ui.setWidget("subagents", buildSubagentWidget(runs), { placement: "aboveEditor" });
  setClearWidgetTimer(
    setTimeout(() => {
      ctx.ui.setWidget("subagents", undefined);
      setClearWidgetTimer(undefined);
    }, 8000),
  );
}

/** Clear subagent UI decorations and timer. */
function clearSubagentsUi(
  ctx: ExtensionContext,
  clearWidgetTimer: ReturnType<typeof setTimeout> | undefined,
  setClearWidgetTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
): void {
  if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
  setClearWidgetTimer(undefined);
  ctx.ui.setStatus("subagents", undefined);
  ctx.ui.setWidget("subagents", undefined);
}

/** Return whether any run is currently active. */
function hasActiveRuns(runs: SubagentRun[]): boolean {
  return runs.some((run) => run.status === "queued" || run.status === "running");
}

/** Build short widget lines for recent subagent runs. */
function buildSubagentWidget(runs: SubagentRun[]): string[] | undefined {
  if (runs.length === 0) return undefined;
  return runs
    .slice(0, 5)
    .map(
      (run) =>
        `${statusIcon(run.status)} ${run.id} ${run.modelSource} ${run.currentActivity} — ${truncate(run.task, 72)}`,
    );
}

/** Build the text report shown by `/subagents`. */
function buildSubagentsReport(runs: SubagentRun[]): string[] {
  if (runs.length === 0) return ["No subagent runs recorded in this extension runtime."];
  return runs.flatMap((run) => [
    `${statusIcon(run.status)} ${run.id} ${run.status.toUpperCase()} · ${run.modelSource} · ${run.modelId}${run.thinkingLevel ? `:${run.thinkingLevel}` : ""} · tools:${run.tools}`,
    `task: ${truncate(run.task, 140)}`,
    `activity: ${run.currentActivity} · elapsed: ${formatElapsed(run)}`,
    ...(run.error ? [`error: ${truncate(run.error, 160)}`] : []),
    ...(run.finalText ? [`final: ${truncate(run.finalText, 220)}`] : []),
    "",
  ]);
}

/** Keep only the newest bounded number of run records. */
function pruneRuns(runs: SubagentRun[]): void {
  if (runs.length > MAX_RECORDED_RUNS) runs.splice(MAX_RECORDED_RUNS);
}

/** Return a compact status icon. */
function statusIcon(status: SubagentRunStatus): string {
  if (status === "queued") return "○";
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "aborted") return "■";
  return "!";
}

/** Format elapsed run time. */
function formatElapsed(run: SubagentRun): string {
  const end = run.endedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - run.startedAt) / 1000))}s`;
}

/** Truncate text to one line. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Read bounded file snippets for prompt preloading, reporting failures as prompt text. */
async function preloadFiles(cwd: string, files: string[] | undefined): Promise<string[]> {
  if (!files?.length) return [];
  let total = 0;
  const blocks: string[] = [];
  for (const rawFile of files) {
    const file = rawFile.replace(/^@+/, "");
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    try {
      const raw = await readFile(path, "utf8");
      const remaining = Math.max(0, MAX_PRELOADED_TOTAL_CHARS - total);
      const content = raw.slice(0, Math.min(MAX_PRELOADED_FILE_CHARS, remaining));
      total += content.length;
      const truncated =
        content.length < raw.length
          ? `\n[truncated: ${raw.length - content.length} chars omitted]`
          : "";
      blocks.push(`### ${file}\n\`\`\`\n${content}${truncated}\n\`\`\``);
      if (total >= MAX_PRELOADED_TOTAL_CHARS) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blocks.push(`### ${file}\n[Could not preload file: ${message}]`);
    }
  }
  return blocks;
}

/** Build the isolated subagent prompt from structured inputs and preloaded file blocks. */
function buildSubagentPrompt(input: SpawnSubagentInput, preloadedFiles: string[]): string {
  const parts = [
    "You are an isolated ephemeral subagent spawned by a parent Pi session.",
    "Work independently. Do not assume access to the parent conversation beyond the context below.",
    "Return a concise final answer for the parent agent. Do not mention hidden chain-of-thought.",
  ];
  if (input.role) parts.push(`\nRole:\n${input.role}`);
  if (input.context) parts.push(`\nContext:\n${input.context}`);
  if (preloadedFiles.length) parts.push(`\nPreloaded files:\n${preloadedFiles.join("\n\n")}`);
  if (input.files?.length)
    parts.push(`\nRelevant file paths:\n${input.files.map((file) => `- ${file}`).join("\n")}`);
  if (input.outputFormat) parts.push(`\nOutput format:\n${input.outputFormat}`);
  parts.push(`\nTask:\n${input.task}`);
  return parts.join("\n");
}

/** Extract the last assistant text message from nested-session `agent_end` messages. */
function extractFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/** Expose pure helpers for focused smoke/unit tests. */
export const __subagentsForTest = {
  parseCanonicalModelId,
  formatCanonicalModelId,
  normalizeThinkingLevel,
  buildSubagentPrompt,
  preloadFiles,
  resolveSubagentModel,
} satisfies Record<string, unknown>;
