import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  DynamicBorder,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { TSchema, Static } from "typebox";
import { Type } from "typebox";

import { readCoreSubagentSettings } from "../../config/persistence.ts";
import type { ProxyReadinessHandle } from "../proxy/index.ts";
import { showInlinePanel, TextPanel, type PanelTheme } from "../proxy/audit-panel.ts";
import {
  loadPresetAgents,
  MAX_PRESET_BODY_CHARS,
  parsePresetAgentFile,
  type PresetAgent,
} from "./preset-agents.ts";

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
});

type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;
type ToolPolicy = (typeof TOOL_POLICIES)[number];
type Tier = (typeof TIERS)[number];
type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

interface AppliedPresetInput extends SpawnSubagentInput {
  /** Selected preset name for operator reporting. */
  presetAgentName?: string;
  /** Selected preset source path for diagnostics. */
  presetAgentSource?: string;
}

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
  const { presets, warnings } = loadPresetAgents(new URL("./agents/", import.meta.url));
  for (const warning of warnings) console.warn(warning);
  const presetGuidance = formatPresetGuidance(presets);
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
      if (!ctx.hasUI) {
        const lines = buildSubagentsReport(runs);
        ctx.ui.notify(`subagents\n${lines.join("\n")}`, "info");
        return;
      }

      const selectedRunId = await selectSubagentRun(ctx, runs);
      const run = runs.find((candidate) => candidate.id === selectedRunId);
      if (run) await showSubagentTranscript(ctx, run);
    },
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: `Run an isolated ephemeral Pi subagent and return only its final answer.${presetGuidance}`,
    promptSnippet:
      "Run an isolated subagent for review, investigation, or parallel analysis tasks. Use a named preset agent when it fits, or omit agent for a custom role/context.",
    promptGuidelines: [
      "Use spawn_subagent for isolated investigation, review, or parallel analysis; prefer preset agent names or tier over raw model unless the user asks for a specific model.",
      "spawn_subagent defaults to read-only tools; request coding tools only when file mutation is explicitly needed.",
      "Named preset agents provide default role text, tier/tools/output format, and explicit tool-call parameters override those defaults.",
      "spawn_subagent returns only the final subagent answer; the nested transcript is intentionally ephemeral.",
    ],
    parameters: spawnSubagentSchema as TSchema,
    async execute(_toolCallId, params: SpawnSubagentInput, signal, onUpdate, ctx) {
      let run: SubagentRun | undefined;
      try {
        const mergedParams = applyPresetAgent(params, presets);
        let selection = await resolveSubagentModel(mergedParams, ctx, pi);
        await options.proxy?.ensure(ctx);
        selection = await resolveSubagentModel(mergedParams, ctx, pi);

        assertProxyLoopbackIfRequired(selection, options.proxy);
        const policy = mergedParams.tools ?? "read-only";
        run = createRun(mergedParams, selection, policy);
        runs.unshift(run);
        pruneRuns(runs);
        updateUi(ctx);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Starting subagent ${run.id}${run.presetAgentName ? ` (${run.presetAgentName})` : ""} (${selection.source}, ${policy} tools)…`,
            },
          ],
          details: {
            id: run.id,
            model: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            tools: policy,
            agent: run.presetAgentName,
            agentSource: run.presetAgentSource,
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
          if (event.type === "agent_end") {
            finalText = extractFinalAssistantText(event.messages);
            run.transcript = event.messages;
          }
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
            const preloadedFiles = await preloadFiles(ctx.cwd, mergedParams.files);
            await session.prompt(buildSubagentPrompt(mergedParams, preloadedFiles), {
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
            agent: run.presetAgentName,
            agentSource: run.presetAgentSource,
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

/** Return markdown preset metadata as one description suffix for tool registration. */
function formatPresetGuidance(presets: Map<string, PresetAgent>): string {
  if (presets.size === 0) return "";
  const lines = [...presets.values()].map(
    (preset) => `\n- ${preset.name}: ${preset.description ?? "No description provided."}`,
  );
  return `\n\nAvailable preset agents:${lines.join("")}`;
}

/** Merge a named preset with explicit tool-call params, preserving explicit precedence. */
function applyPresetAgent(
  params: SpawnSubagentInput,
  presets: Map<string, PresetAgent>,
): AppliedPresetInput {
  if (!params.agent) return params;
  const preset = presets.get(params.agent);
  if (!preset) {
    const available = [...presets.keys()].sort().join(", ") || "none";
    throw new Error(
      `Unknown preset agent "${params.agent}". Available preset agents: ${available}.`,
    );
  }
  const presetTier = preset.tier === "any" ? undefined : preset.tier;
  return {
    ...params,
    tier: params.tier ?? presetTier,
    tools: params.tools ?? preset.tools,
    outputFormat: params.outputFormat ?? preset.outputFormat,
    role: [preset.body, params.role].filter(Boolean).join("\n\n") || undefined,
    presetAgentName: preset.name,
    presetAgentSource: preset.sourcePath,
  };
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
        `${statusIcon(run.status)} ${run.id} ${formatRunSource(run)} ${run.currentActivity} — ${truncate(run.task, 72)}`,
    );
}

/** Build the text report shown by `/subagents`. */
function buildSubagentsReport(runs: SubagentRun[]): string[] {
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
async function selectSubagentRun(
  ctx: ExtensionContext,
  runs: SubagentRun[],
): Promise<string | null> {
  if (runs.length === 0) {
    await showInlinePanel(ctx, "subagents", buildSubagentsReport(runs));
    return null;
  }

  return await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const items: SelectItem[] = runs.map((run) => ({
        value: run.id,
        label: `${statusIcon(run.status)} ${run.id} ${run.status}`,
        description: `${formatElapsed(run)} · ${formatRunSource(run)} · ${truncate(run.task, 90)}`,
      }));
      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);

      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("subagent transcripts")), 1, 1));
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • Enter open transcript • Esc close"), 1, 1),
      );
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "80%", minWidth: 56, maxHeight: 18 } },
  );
}

/** Open a colored, scrollable transcript panel for one subagent run. */
async function showSubagentTranscript(ctx: ExtensionContext, run: SubagentRun): Promise<void> {
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

/** Build themed transcript lines from a retained nested-session message list. */
function buildTranscriptLines(run: SubagentRun, theme: TranscriptTheme): string[] {
  const lines = [
    `${theme.fg("toolTitle", theme.bold(run.id))} ${theme.fg(statusColor(run.status), run.status.toUpperCase())}`,
    `${theme.fg("muted", "model:")} ${theme.fg("accent", run.modelId)}${run.thinkingLevel ? theme.fg("muted", `:${run.thinkingLevel}`) : ""} ${theme.fg("muted", `tools:${run.tools}`)}${run.presetAgentName ? theme.fg("muted", ` agent:${run.presetAgentName}`) : ""}`,
    `${theme.fg("muted", "elapsed:")} ${theme.fg("dim", formatElapsed(run))}`,
    "",
    theme.fg("borderMuted", "─── Task ───"),
    ...colorBlock(run.task, theme, "userMessageText"),
    "",
  ];

  if (!run.transcript?.length) {
    lines.push(theme.fg("warning", "Transcript is not available yet."));
    if (run.error) lines.push("", theme.fg("error", run.error));
    if (run.finalText)
      lines.push(
        "",
        theme.fg("borderMuted", "─── Final ───"),
        ...colorBlock(run.finalText, theme, "toolOutput"),
      );
    return lines;
  }

  run.transcript.forEach((message, index) => {
    if (index > 0) lines.push("");
    appendMessageLines(lines, message, theme);
  });
  return lines;
}

/** Append one colored message block to the transcript. */
function appendMessageLines(lines: string[], rawMessage: unknown, theme: TranscriptTheme): void {
  const message = asRecord(rawMessage);
  const role = typeof message?.role === "string" ? message.role : "unknown";
  lines.push(formatMessageHeader(role, message, theme));

  if (role === "assistant" && Array.isArray(message?.content)) {
    for (const part of message.content) appendContentPart(lines, part, theme, "toolOutput");
    return;
  }
  if (role === "toolResult") {
    const content =
      Array.isArray(message?.content) || typeof message?.content === "string"
        ? message.content
        : [];
    appendContent(lines, content, theme, message?.isError === true ? "error" : "toolOutput");
    return;
  }
  if (role === "user" || role === "custom") {
    appendContent(lines, message?.content, theme, "userMessageText");
    return;
  }
  lines.push(...colorBlock(JSON.stringify(rawMessage, null, 2), theme, "dim"));
}

/** Return a colored message header for transcript navigation. */
function formatMessageHeader(
  role: string,
  message: Record<string, unknown> | undefined,
  theme: TranscriptTheme,
): string {
  if (role === "assistant") return theme.fg("accent", theme.bold("─── assistant ───"));
  if (role === "user") return theme.fg("userMessageText", theme.bold("─── user ───"));
  if (role === "toolResult") {
    const toolName = typeof message?.toolName === "string" ? message.toolName : "tool";
    const isError = message?.isError === true;
    return theme.fg(
      isError ? "error" : "success",
      theme.bold(`─── tool result: ${toolName} ${isError ? "✗" : "✓"} ───`),
    );
  }
  return theme.fg("muted", theme.bold(`─── ${role} ───`));
}

/** Append content blocks or string content to transcript lines. */
function appendContent(
  lines: string[],
  content: unknown,
  theme: TranscriptTheme,
  color: string,
): void {
  if (typeof content === "string") {
    lines.push(...colorBlock(content, theme, color));
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) appendContentPart(lines, part, theme, color);
}

/** Append one content part with role-appropriate coloring. */
function appendContentPart(
  lines: string[],
  rawPart: unknown,
  theme: TranscriptTheme,
  color: string,
): void {
  const part = asRecord(rawPart);
  if (!part || typeof part.type !== "string") {
    lines.push(theme.fg("dim", JSON.stringify(rawPart)));
    return;
  }
  if (part.type === "text" && typeof part.text === "string") {
    lines.push(...colorBlock(part.text, theme, color));
  } else if (part.type === "thinking" && typeof part.thinking === "string") {
    lines.push(theme.fg("muted", "thinking:"), ...colorBlock(part.thinking, theme, "dim"));
  } else if (part.type === "toolCall") {
    const name = typeof part.name === "string" ? part.name : "tool";
    lines.push(theme.fg("toolTitle", `→ ${name}`));
    lines.push(...colorBlock(JSON.stringify(part.arguments ?? {}, null, 2), theme, "dim"));
  } else if (part.type === "image") {
    const mime = typeof part.mimeType === "string" ? part.mimeType : "image";
    lines.push(theme.fg("warning", `[${mime} omitted]`));
  } else {
    lines.push(...colorBlock(JSON.stringify(rawPart, null, 2), theme, "dim"));
  }
}

/** Color each line of a text block independently so wrapping preserves styles. */
function colorBlock(text: string, theme: PanelTheme, color: string): string[] {
  const rawLines = text.split("\n");
  return rawLines.length > 0
    ? rawLines.map((line) => theme.fg(color, line || " "))
    : [theme.fg(color, " ")];
}

/** Return the best status color token for a run state. */
function statusColor(status: SubagentRunStatus): string {
  if (status === "done") return "success";
  if (status === "error") return "error";
  if (status === "aborted") return "warning";
  return "accent";
}

/** Narrow unknown JSON-ish values to object records. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Theme surface needed for transcript rendering. */
interface TranscriptTheme extends PanelTheme {
  bold(text: string): string;
}

/** Keep only the newest bounded number of run records. */
function pruneRuns(runs: SubagentRun[]): void {
  if (runs.length > MAX_RECORDED_RUNS) runs.splice(MAX_RECORDED_RUNS);
}

/** Return the display source for model selection plus preset agent metadata. */
function formatRunSource(run: SubagentRun): string {
  return run.presetAgentName
    ? `${run.modelSource} · agent:${run.presetAgentName}`
    : run.modelSource;
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
  loadPresetAgents,
  parsePresetAgentFile,
  applyPresetAgent,
  MAX_PRESET_BODY_CHARS,
} satisfies Record<string, unknown>;
