import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-agent-core";

import { formatPercent, formatTokens } from "../core/lib/format.ts";
import { showPanel } from "../core/lib/ui/panel.ts";

/** Last prompt data captured after all earlier before-agent-start handlers reached this extension. */
interface CapturedPrompt {
  /** Assembled system prompt for the captured turn. */
  systemPrompt: string;
  /** Structured inputs used to assemble the captured system prompt. */
  options: BuildSystemPromptOptions;
}

/** A named prompt contributor with an estimated token count. */
interface PromptContributor {
  /** Human-readable contributor label. */
  label: string;
  /** Text contributed to the prompt or debug report. */
  text: string;
  /** Estimated tokens for {@link PromptContributor.text}. */
  tokens: number;
}

/** Full report data rendered by `/debug-system-prompt`. */
interface DebugSystemPromptReport {
  /** Prompt source used to explain snapshot freshness. */
  snapshot: "current" | "last-turn";
  /** Assembled system prompt string. */
  systemPrompt: string;
  /** Structured prompt inputs, when available. */
  options: BuildSystemPromptOptions;
  /** Context usage reported by Pi for the active model/session. */
  usage: ContextUsage | undefined;
  /** Current model identity and context window. */
  model: { provider?: string; id?: string; contextWindow?: number } | undefined;
  /** Currently active tool names. */
  activeTools: string[];
  /** All registered tool definitions. */
  tools: ToolInfo[];
  /** Estimated prompt and debug-section contributors. */
  contributors: PromptContributor[];
}

/** Command context surface needed from newer Pi prompt-debug APIs. */
interface CommandPromptContext {
  /** Context usage for the active session/model. */
  getContextUsage(): ContextUsage | undefined;
  /** Current assembled system prompt. */
  getSystemPrompt(): string;
  /** Structured inputs used to build the current system prompt, when exposed by Pi. */
  getSystemPromptOptions?: () => BuildSystemPromptOptions;
  /** Current working directory, used for older runtimes without structured prompt inputs. */
  cwd?: string;
  /** Current model, when selected. */
  model: { provider?: string; id?: string; contextWindow?: number } | undefined;
}

/** Narrow command context to the prompt-debug API surface while local peer types catch up. */
function commandPromptContext(ctx: ExtensionCommandContext): CommandPromptContext {
  return ctx as ExtensionCommandContext & CommandPromptContext;
}

/** Load the debug extension and register its debug commands. */
export default function debug(pi: ExtensionAPI): void {
  registerDebugSystemPrompt(pi);
}

/** Register `/debug-system-prompt`, a popup inspector for prompt inputs and tool definitions. */
export function registerDebugSystemPrompt(pi: ExtensionAPI): void {
  let captured: CapturedPrompt | undefined;

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    captured = { systemPrompt: event.systemPrompt, options: event.systemPromptOptions };
  });
  pi.on("session_start", () => {
    captured = undefined;
  });
  pi.on("session_shutdown", () => {
    captured = undefined;
  });

  pi.registerCommand("debug-system-prompt", {
    description: "Inspect the assembled system prompt, prompt inputs, tools, and token estimates",
    handler: async (_args, ctx) => {
      const report = buildDebugSystemPromptReport(pi, commandPromptContext(ctx), captured);
      const lines = formatDebugSystemPromptReport(report);
      if (ctx.hasUI) await showPanel(ctx, "debug-system-prompt", lines);
      else console.log(lines.join("\n"));
    },
  });
}

/** Build a report from live command context, falling back to the last turn snapshot if needed. */
function buildDebugSystemPromptReport(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: CommandPromptContext,
  captured: CapturedPrompt | undefined,
): DebugSystemPromptReport {
  const currentOptions = ctx.getSystemPromptOptions?.() ??
    captured?.options ?? { cwd: ctx.cwd ?? "" };
  const currentPrompt = ctx.getSystemPrompt();
  const snapshot =
    captured?.systemPrompt && captured.systemPrompt !== currentPrompt ? "last-turn" : "current";
  const systemPrompt = snapshot === "last-turn" ? captured!.systemPrompt : currentPrompt;
  const options = snapshot === "last-turn" ? captured!.options : currentOptions;

  return {
    snapshot,
    systemPrompt,
    options,
    usage: ctx.getContextUsage(),
    model: ctx.model,
    activeTools: pi.getActiveTools(),
    tools: pi.getAllTools(),
    contributors: promptContributors(options, systemPrompt, pi.getAllTools()),
  };
}

/** Render the debug report as scrollable plain text with Markdown-like headings. */
function formatDebugSystemPromptReport(report: DebugSystemPromptReport): string[] {
  const lines: string[] = [];
  const promptTokens = estimateText(report.systemPrompt);
  const toolDefinitionTokens = estimateText(
    stableJson(report.tools.map((tool) => serializableTool(tool, report.activeTools))),
  );

  lines.push("# Debug system prompt", "");
  lines.push(
    `Snapshot: ${report.snapshot === "current" ? "current command context" : "last agent turn"}`,
  );
  lines.push(`Model: ${formatModel(report.model)}`);
  lines.push(
    `System prompt: ~${formatTokens(promptTokens)} tokens, ${report.systemPrompt.length} chars`,
  );
  lines.push(
    `All tool definitions: ~${formatTokens(toolDefinitionTokens)} tokens across ${report.tools.length} tools`,
  );
  lines.push(
    `Active tools: ${report.activeTools.length ? report.activeTools.join(", ") : "(none)"}`,
  );
  lines.push(`Context usage: ${formatUsage(report.usage, report.model)}`);
  lines.push("");

  lines.push("## Estimated prompt contributors", "");
  for (const contributor of report.contributors) {
    lines.push(`- ${contributor.label}: ~${formatTokens(contributor.tokens)} tokens`);
  }
  lines.push("");

  lines.push("## Assembled system prompt", "", "```text", report.systemPrompt, "```", "");

  lines.push("## Structured prompt additions", "");
  appendPromptOptions(lines, report.options);
  lines.push("");

  lines.push("## All tool definitions", "");
  for (const tool of report.tools) appendTool(lines, tool, report.activeTools.includes(tool.name));
  lines.push("Esc/Enter/q close");
  return lines;
}

/** Convert system-prompt options into token-sized contributors for curation. */
function promptContributors(
  options: BuildSystemPromptOptions,
  systemPrompt: string,
  tools: ToolInfo[],
): PromptContributor[] {
  const contributors: PromptContributor[] = [];
  addContributor(contributors, "assembled system prompt", systemPrompt);
  addContributor(contributors, "custom prompt", options.customPrompt);
  addContributor(contributors, "appended prompt", options.appendSystemPrompt);
  addContributor(contributors, "prompt guidelines", options.promptGuidelines?.join("\n"));
  addContributor(
    contributors,
    "active tool snippets",
    Object.values(options.toolSnippets ?? {}).join("\n"),
  );
  for (const file of options.contextFiles ?? []) {
    addContributor(contributors, `context file: ${file.path}`, file.content);
  }
  for (const skill of options.skills ?? []) {
    addContributor(contributors, `skill metadata: ${skill.name}`, stableJson(skill));
  }
  addContributor(
    contributors,
    "all registered tool definitions",
    stableJson(tools.map((tool) => serializableTool(tool))),
  );
  return contributors;
}

/** Append a contributor if the text is not empty. */
function addContributor(items: PromptContributor[], label: string, text: string | undefined): void {
  if (!text) return;
  items.push({ label, text, tokens: estimateText(text) });
}

/** Append a compact but complete view of system-prompt construction inputs. */
function appendPromptOptions(lines: string[], options: BuildSystemPromptOptions): void {
  lines.push(`cwd: ${options.cwd}`);
  appendTextBlock(lines, "customPrompt", options.customPrompt);
  appendTextBlock(lines, "appendSystemPrompt", options.appendSystemPrompt);
  lines.push(`promptGuidelines: ${options.promptGuidelines?.length ?? 0}`);
  for (const guideline of options.promptGuidelines ?? []) lines.push(`  - ${guideline}`);
  lines.push(`contextFiles: ${options.contextFiles?.length ?? 0}`);
  for (const file of options.contextFiles ?? []) {
    lines.push(`  - ${file.path}: ~${formatTokens(estimateText(file.content))} tokens`);
  }
  lines.push(`skills: ${options.skills?.length ?? 0}`);
  for (const skill of options.skills ?? []) {
    lines.push(`  - ${skill.name}: ${skill.description}`);
  }
  lines.push(`toolSnippets: ${Object.keys(options.toolSnippets ?? {}).length}`);
  for (const [name, snippet] of Object.entries(options.toolSnippets ?? {})) {
    lines.push(`  - ${name}: ${snippet}`);
  }
}

/** Append a named structured text block, including full content for prompt debugging. */
function appendTextBlock(lines: string[], label: string, text: string | undefined): void {
  if (!text) {
    lines.push(`${label}: (none)`);
    return;
  }
  lines.push(`${label}: ~${formatTokens(estimateText(text))} tokens`, "```text", text, "```");
}

/** Append one registered tool definition including JSON parameter schema. */
function appendTool(lines: string[], tool: ToolInfo, active: boolean): void {
  lines.push(`### ${tool.name}${active ? " (active)" : ""}`);
  lines.push(`Source: ${formatSource(tool.sourceInfo)}`);
  lines.push(`Description: ${tool.description}`);
  if (tool.promptGuidelines?.length) {
    lines.push("Prompt guidelines:");
    for (const guideline of tool.promptGuidelines) lines.push(`- ${guideline}`);
  }
  lines.push("Parameters:", "```json", stableJson(tool.parameters), "```", "");
}

/** Return a JSON-safe tool object with active status for the all-tools token estimate. */
function serializableTool(tool: ToolInfo, activeTools: string[] = []): Record<string, unknown> {
  return {
    name: tool.name,
    active: activeTools.includes(tool.name),
    sourceInfo: tool.sourceInfo,
    description: tool.description,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  };
}

/** Estimate tokens for text using Pi's tokenizer, falling back to a character heuristic. */
function estimateText(text: string): number {
  try {
    return Math.max(0, estimateTokens({ role: "user", content: text, timestamp: 0 }));
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/** Format model context usage and remaining capacity when available. */
function formatUsage(
  usage: ContextUsage | undefined,
  model: { contextWindow?: number } | undefined,
): string {
  const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? null;
  if (!usage) return `unknown/${formatTokens(contextWindow)} tokens`;
  if (usage.tokens === null) return `?/${formatTokens(contextWindow)} tokens (?)`;
  return `${formatTokens(usage.tokens)}/${formatTokens(contextWindow)} tokens (${formatPercent(usage.percent)})`;
}

/** Format the active model label. */
function formatModel(model: { provider?: string; id?: string } | undefined): string {
  if (!model) return "unknown";
  return model.provider ? `${model.provider}/${model.id ?? "unknown"}` : (model.id ?? "unknown");
}

/** Format extension source metadata for display. */
function formatSource(sourceInfo: ToolInfo["sourceInfo"]): string {
  return [sourceInfo.scope, sourceInfo.source, sourceInfo.origin, sourceInfo.path]
    .filter(Boolean)
    .join(" · ");
}

/** Stringify unknown values with stable indentation. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

/** Expose pure helpers for focused tests. */
export const __debugSystemPromptForTest = {
  buildDebugSystemPromptReport,
  formatDebugSystemPromptReport,
  promptContributors,
} satisfies Record<string, unknown>;
