import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { resolveSubagentModel, assertProxyLoopbackIfRequired } from "./model-resolution.ts";
import {
  applyPresetAgent,
  buildSubagentPrompt,
  extractFinalAssistantText,
  formatPresetGuidance,
  preloadFiles,
} from "./prompt.ts";
import { createRun, handleSubagentEvent, hasActiveRuns, pruneRuns } from "./run.ts";
import {
  buildSubagentsReport,
  clearSubagentsUi,
  formatSubagentsStatusLabel,
  selectSubagentRun,
  showSubagentTranscript,
  updateSubagentsUi,
} from "./ui.ts";
import {
  spawnSubagentSchema,
  toolPolicyNames,
  type RegisterSubagentsOptions,
  type SpawnSubagentInput,
  type SubagentRun,
  type SubagentsController,
} from "./types.ts";
import { loadPresetAgents, MAX_PRESET_BODY_CHARS, parsePresetAgentFile } from "./preset-agents.ts";
import {
  normalizeThinkingLevel,
  parseCanonicalModelId,
  formatCanonicalModelId,
} from "./model-resolution.ts";

export type { SubagentsController };

/** Register subagent spawning and visibility commands for the core extension bundle. */
export function registerSubagents(
  pi: ExtensionAPI,
  options: RegisterSubagentsOptions = {},
): SubagentsController {
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

  const controller: SubagentsController = {
    statusLabel: () => formatSubagentsStatusLabel(runs),
  };

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
        // Ensure the proxy has re-registered provider base URLs before resolving, so
        // the selected model picks up the loopback baseUrl when a provider is proxied.
        await options.proxy?.ensure(ctx);
        const selection = await resolveSubagentModel(mergedParams, ctx, pi);

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

  return controller;
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
