import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ContextUsage,
  ExtensionAPI,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import { estimateTokens, serializeConversation } from "@earendil-works/pi-agent-core";

import { formatPercent, formatTokens } from "../lib/format.ts";
import { showInlinePanel } from "../lib/ui/panel.ts";

type CategoryId = "system" | "conversation" | "tool_results" | "summaries" | "unknown";
type EstimateQuality = "good" | "low" | "limited";
type ContextStatus = "OK" | "watch" | "compact soon" | "usage unknown until next model response";

interface ReportItem {
  category: Exclude<CategoryId, "unknown">;
  label: string;
  tokens: number;
}

interface ReportCategory {
  id: CategoryId;
  label: string;
  tokens: number | null;
  percent: number | null;
}

interface ResourceLine {
  label: string;
  tokens: number;
}

/** A skill row tagged with the source group it should render under. */
interface SkillLine extends ResourceLine {
  group: string;
}

interface ContextReport {
  model: string;
  canonical: { tokens: number | null; contextWindow: number | null; percent: number | null };
  status: ContextStatus;
  estimateQuality: EstimateQuality;
  categories: ReportCategory[];
  topContributors: ReportItem[];
  memoryFiles: ResourceLine[];
  skills: SkillLine[];
  tools: string[];
  notes: string[];
  isLive: boolean;
}

const CATEGORY_LABELS: Record<CategoryId, string> = {
  system: "System prompt",
  conversation: "Messages",
  tool_results: "Tool results",
  summaries: "Summaries",
  unknown: "Unknown/overhead",
};

const CATEGORY_SYMBOLS: Record<CategoryId | "free", string> = {
  system: "π",
  conversation: "Π",
  tool_results: "ϖ",
  summaries: "∏",
  unknown: "?",
  free: "·",
};

const CATEGORY_COLORS: Record<CategoryId | "free", string> = {
  system: "\x1b[35m",
  conversation: "\x1b[36m",
  tool_results: "\x1b[33m",
  summaries: "\x1b[34m",
  unknown: "\x1b[31m",
  free: "\x1b[2m",
};

const ANSI_RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RULE_COLOR = "\x1b[90m";
const GRID_WIDTH = 20;
const GRID_ROWS = 5;
const SECTION_RULE = "─".repeat(GRID_WIDTH * 2 - 1);
const TOP_CONTRIBUTOR_LIMIT = 5;

/** Accent colors for resource sections, keyed by section. */
const RESOURCE_ACCENTS = {
  tools: "\x1b[36m",
  memory: "\x1b[35m",
  skills: "\x1b[32m",
} as const;
let lastSystemPromptOptions: BuildSystemPromptOptions | undefined;

/** Register `/context`, a read-only context-usage report command. */
export function registerContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    lastSystemPromptOptions = event.systemPromptOptions;
  });
  pi.on("session_start", () => {
    lastSystemPromptOptions = undefined;
  });
  pi.on("session_shutdown", () => {
    lastSystemPromptOptions = undefined;
  });

  pi.registerCommand("context", {
    description: "Show current context usage without adding to message history",
    handler: async (_args, ctx) => {
      const report = buildContextReport({
        usage: ctx.getContextUsage(),
        model: ctx.model,
        systemPrompt: ctx.getSystemPrompt(),
        systemPromptOptions: lastSystemPromptOptions,
        skills: resolveSkills(lastSystemPromptOptions, ctx.cwd),
        branch: ctx.sessionManager.getBranch(),
        isIdle: ctx.isIdle(),
      });
      const lines = formatContextReport(report, { color: ctx.hasUI });
      if (ctx.hasUI) await showInlinePanel(ctx, "context", lines);
      else console.log(lines.join("\n"));
    },
  });
}

/**
 * Resolve the skills exposed to the agent. Prefers the authoritative set captured from the last
 * assembled prompt; before the first turn that is unavailable, so load default skill metadata
 * directly since skill name/description are static and known without a model response.
 */
function resolveSkills(options: BuildSystemPromptOptions | undefined, cwd: string): Skill[] {
  if (options?.skills && options.skills.length > 0) return options.skills;
  try {
    return loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true })
      .skills;
  } catch {
    return [];
  }
}

/** Build a deterministic report from command-context data without mutating session state. */
function buildContextReport(input: {
  usage: ContextUsage | undefined;
  model: { id?: string; provider?: string; contextWindow?: number } | undefined;
  systemPrompt: string;
  systemPromptOptions?: BuildSystemPromptOptions;
  skills?: Skill[];
  branch: unknown[];
  isIdle: boolean;
}): ContextReport {
  const canonical = {
    tokens: input.usage?.tokens ?? null,
    contextWindow: input.usage?.contextWindow ?? input.model?.contextWindow ?? null,
    percent: input.usage?.percent ?? null,
  };
  const items = [
    ...systemItems(input.systemPromptOptions, input.systemPrompt),
    ...branchItems(input.branch),
  ];
  const knownEstimate = items.reduce((sum, item) => sum + item.tokens, 0);
  const denominator = canonical.tokens && canonical.tokens > 0 ? canonical.tokens : knownEstimate;
  const categories = makeCategories(items, canonical.tokens, denominator);
  const notes: string[] = ["category counts are estimates; total usage is from Pi"];
  if (!input.systemPromptOptions)
    notes.push("tool and memory breakdowns appear after the first agent turn");
  if (!input.isIdle) notes.push("live snapshot: values may change after the active turn finishes");
  if (!input.usage) notes.push("canonical usage is unavailable until Pi has model usage data");
  if (input.usage && input.usage.tokens === null)
    notes.push("token count is unknown after compaction until the next model response");
  if (canonical.tokens !== null && knownEstimate > canonical.tokens)
    notes.push("category estimates exceed canonical total; percentages use estimated total");

  const unknown = categories.find((category) => category.id === "unknown")?.tokens;
  const estimateQuality =
    canonical.tokens === null
      ? "limited"
      : unknown !== null && canonical.tokens > 0 && (unknown ?? 0) / canonical.tokens > 0.5
        ? "low"
        : "good";

  const systemResources = systemResourceItems(input.systemPromptOptions);
  const contributorItems =
    systemResources.length > 0
      ? [...systemResources, ...items.filter((item) => item.category !== "system")]
      : items;

  return {
    model: formatModel(input.model),
    canonical,
    status: statusFor(canonical.percent),
    estimateQuality,
    categories,
    topContributors: contributorItems
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_CONTRIBUTOR_LIMIT),
    memoryFiles: memoryFileLines(input.systemPromptOptions),
    skills: skillLines(input.skills ?? input.systemPromptOptions?.skills),
    tools: toolLines(input.systemPromptOptions),
    notes,
    isLive: !input.isIdle,
  };
}

/** Convert cached system-prompt options into sized, safe labels. */
function systemItems(
  options: BuildSystemPromptOptions | undefined,
  fallbackPrompt: string,
): ReportItem[] {
  if (!options) {
    return fallbackPrompt
      ? [
          {
            category: "system",
            label: "assembled system prompt",
            tokens: estimateText(fallbackPrompt),
          },
        ]
      : [];
  }

  const items: ReportItem[] = [];
  addTextItem(items, "system", "custom system prompt", options.customPrompt);
  addTextItem(items, "system", "appended system prompt", options.appendSystemPrompt);
  addTextItem(items, "system", "prompt guidelines", options.promptGuidelines?.join("\n"));
  addTextItem(
    items,
    "system",
    "tool snippets",
    Object.values(options.toolSnippets ?? {}).join("\n"),
  );
  for (const file of options.contextFiles ?? [])
    addTextItem(items, "system", `context file: ${file.path}`, file.content);
  for (const skill of options.skills ?? [])
    items.push({ category: "system", label: `skill: ${skill.name}`, tokens: estimateSkill(skill) });
  return items.length > 0 ? items : systemItems(undefined, fallbackPrompt);
}

/** Return display rows for context files already loaded into the system prompt. */
function memoryFileLines(options: BuildSystemPromptOptions | undefined): ResourceLine[] {
  return (options?.contextFiles ?? []).map((file) => ({
    label: file.path,
    tokens: estimateText(file.content),
  }));
}

/** Return display rows for skills exposed to the agent, tagged by source group. */
function skillLines(skills: Skill[] | undefined): SkillLine[] {
  return (skills ?? []).map((skill) => ({
    label: skill.name,
    tokens: estimateSkill(skill),
    group: skillGroup(skill.sourceInfo),
  }));
}

/**
 * Estimate the tokens a skill contributes to the system prompt: only its name, description, and
 * location are exposed via {@link https://agentskills.io | the agent-skills block}; the body is
 * read on demand, so it is not counted here.
 */
function estimateSkill(skill: { name: string; description: string; filePath?: string }): number {
  return estimateText(
    `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.filePath ?? ""}</location>\n  </skill>`,
  );
}

/** Map a skill's source info to a display group, mirroring Pi's user/project/package taxonomy. */
function skillGroup(sourceInfo: { scope?: string; source?: string } | undefined): string {
  if (sourceInfo?.scope === "user") return "User";
  if (sourceInfo?.scope === "project") return "Project";
  const source = sourceInfo?.source;
  return source && source !== "local" ? `Plugin (${source})` : "Other";
}

/** Return active tool names captured from the last assembled system prompt options. */
function toolLines(options: BuildSystemPromptOptions | undefined): string[] {
  return options?.selectedTools ?? Object.keys(options?.toolSnippets ?? {});
}

/** Return grouped system resources for concise Claude-style contributor rows. */
function systemResourceItems(options: BuildSystemPromptOptions | undefined): ReportItem[] {
  if (!options) return [];
  const items: ReportItem[] = [];
  const contextFiles = options.contextFiles ?? [];
  const memoryTokens = contextFiles.reduce((sum, file) => sum + estimateText(file.content), 0);
  if (memoryTokens > 0)
    items.push({
      category: "system",
      label: contextFiles.length === 1 ? `context file: ${contextFiles[0].path}` : "Memory files",
      tokens: memoryTokens,
    });
  const skills = options.skills ?? [];
  const skillTokens = skills.reduce((sum, skill) => sum + estimateSkill(skill), 0);
  if (skillTokens > 0)
    items.push({
      category: "system",
      label: skills.length === 1 ? `skill: ${skills[0].name}` : "Skills",
      tokens: skillTokens,
    });
  const toolTokens = Object.values(options.toolSnippets ?? {}).reduce(
    (sum, snippet) => sum + estimateText(snippet),
    0,
  );
  if (toolTokens > 0) items.push({ category: "system", label: "System tools", tokens: toolTokens });
  addTextItem(
    items,
    "system",
    "System prompt",
    [options.customPrompt, options.appendSystemPrompt, ...(options.promptGuidelines ?? [])]
      .filter(Boolean)
      .join("\n"),
  );
  return items;
}

/** Classify active-branch entries into report items. */
function branchItems(branch: unknown[]): ReportItem[] {
  const items: ReportItem[] = [];
  for (const [index, rawEntry] of branch.entries()) {
    const entry = rawEntry as Record<string, any>;
    if (entry.type === "message") items.push(...messageItems(entry.message, index));
    else if (entry.type === "compaction")
      addTextItem(items, "summaries", `compaction summary ${index + 1}`, entry.summary);
    else if (entry.type === "branch_summary")
      addTextItem(items, "summaries", `branch summary ${index + 1}`, entry.summary);
    else if (entry.type === "custom_message")
      addTextItem(
        items,
        "conversation",
        `custom:${entry.customType ?? "message"}`,
        stableText(entry.content),
      );
  }
  return items;
}

/** Classify one message, including nested assistant content blocks and tool results. */
function messageItems(message: any, index: number): ReportItem[] {
  if (!message) return [];
  if (message.role === "toolResult") {
    return [
      {
        category: "tool_results",
        label: `tool result: ${message.toolName ?? index + 1}`,
        tokens: estimateMessage(message),
      },
    ];
  }
  if (message.role !== "assistant") {
    return [
      {
        category: "conversation",
        label: `${message.role ?? "message"} turn ${index + 1}`,
        tokens: estimateMessage(message),
      },
    ];
  }

  const items: ReportItem[] = [];
  let conversationText = "";
  for (const [blockIndex, block] of (message.content ?? []).entries()) {
    if (block?.type === "toolResult") {
      addTextItem(
        items,
        "tool_results",
        `tool result block ${index + 1}.${blockIndex + 1}`,
        stableText(block),
      );
    } else {
      conversationText += `${stableText(block)}\n`;
    }
  }
  addTextItem(items, "conversation", `assistant turn ${index + 1}`, conversationText);
  return items;
}

/** Reconcile category estimates with the canonical total when available. */
function makeCategories(
  items: ReportItem[],
  canonicalTokens: number | null,
  denominator: number,
): ReportCategory[] {
  const totals = new Map<CategoryId, number>();
  for (const item of items)
    totals.set(item.category, (totals.get(item.category) ?? 0) + item.tokens);
  const known = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const unknown = canonicalTokens === null ? null : Math.max(0, canonicalTokens - known);
  if (unknown !== null) totals.set("unknown", unknown);
  const percentBase = Math.max(1, denominator);
  return (["system", "conversation", "tool_results", "summaries", "unknown"] as CategoryId[]).map(
    (id) => {
      const tokens = id === "unknown" ? unknown : (totals.get(id) ?? 0);
      return {
        id,
        label: CATEGORY_LABELS[id],
        tokens,
        percent: tokens === null ? null : (tokens / percentBase) * 100,
      };
    },
  );
}

/** Format a report as pre-rendered plain lines for panel or headless output. */
function formatContextReport(report: ContextReport, options: { color?: boolean } = {}): string[] {
  const usage =
    report.canonical.tokens === null
      ? `?/${formatTokens(report.canonical.contextWindow)} tokens (?)`
      : `${formatTokens(report.canonical.tokens)}/${formatTokens(report.canonical.contextWindow)} tokens (${formatPercent(report.canonical.percent)})`;
  const grid = usageGrid(report, options.color);
  const modelName = report.model.includes("/")
    ? report.model.split("/").slice(1).join("/")
    : report.model;
  const lines = [
    report.model,
    modelName,
    `${usage} · ${report.status}`,
    rule(options.color),
    ...grid,
    rule(options.color),
    `Estimated usage by category · quality ${report.estimateQuality}`,
    ...report.categories.map(
      (category) =>
        `  ${categorySymbol(category.id, options.color)} ${colorText(category.label, category.id, options.color)}: ${formatCategoryValue(category)}`,
    ),
    `  ${categorySymbol("free", options.color)} ${colorText("Free space", "free", options.color)}: ${formatFreeSpace(report)}`,
  ];

  appendResourceSection(
    lines,
    "Tools · loaded in system prompt",
    report.tools.map((label) => ({ label, tokens: 0 })),
    false,
    options.color,
    RESOURCE_ACCENTS.tools,
  );
  appendResourceSection(
    lines,
    "Memory files · /memory",
    report.memoryFiles,
    true,
    options.color,
    RESOURCE_ACCENTS.memory,
  );
  appendSkillSection(lines, report.skills, options.color);

  lines.push(rule(options.color), "Top contributors");
  if (report.topContributors.length === 0) lines.push(`${dimText("└", options.color)} (none)`);
  for (const [index, item] of report.topContributors.entries()) {
    const branch = index === report.topContributors.length - 1 ? "└" : "├";
    lines.push(
      `${dimText(branch, options.color)} ${truncate(item.label, 50)}: ${dimText(`~${formatTokens(item.tokens)} tokens`, options.color)}`,
    );
  }
  lines.push(
    rule(options.color),
    ...report.notes.map((note) => `Note: ${note}`),
    "Esc/Enter/q close",
  );
  return lines;
}

/** Append a Claude-style tree section when resource rows are known, accenting rows when colored. */
function appendResourceSection(
  lines: string[],
  title: string,
  rows: ResourceLine[],
  includeTokens: boolean,
  color = false,
  accent?: string,
): void {
  if (rows.length === 0) return;
  lines.push(rule(color), accentText(title, accent, color));
  for (const [index, row] of rows.entries()) {
    const branch = index === rows.length - 1 ? "└" : "├";
    const suffix = includeTokens
      ? `: ${dimText(`~${formatTokens(row.tokens)} tokens`, color)}`
      : "";
    lines.push(
      `${dimText(branch, color)} ${accentText(truncate(row.label, 68), accent, color)}${suffix}`,
    );
  }
}

/** Fixed display order for skill source groups; unknown groups sort after these alphabetically. */
const SKILL_GROUP_ORDER = ["User", "Project", "Other"];

/** Append the Claude-style skills section, grouped by source with a colored header per group. */
function appendSkillSection(lines: string[], skills: SkillLine[], color = false): void {
  if (skills.length === 0) return;
  lines.push(rule(color), accentText("Skills · /skills", RESOURCE_ACCENTS.skills, color));

  const groups = new Map<string, SkillLine[]>();
  for (const skill of skills) {
    const rows = groups.get(skill.group) ?? [];
    rows.push(skill);
    groups.set(skill.group, rows);
  }

  for (const group of sortGroups([...groups.keys()])) {
    const rows = groups.get(group)!.sort((a, b) => b.tokens - a.tokens);
    lines.push(accentText(group, RESOURCE_ACCENTS.skills, color));
    for (const [index, row] of rows.entries()) {
      const branch = index === rows.length - 1 ? "└" : "├";
      lines.push(
        `${dimText(branch, color)} ${truncate(row.label, 68)}: ${dimText(`~${formatTokens(row.tokens)} tokens`, color)}`,
      );
    }
  }
}

/** Order skill groups by the known priority list, then alphabetically (Plugins land after fixed groups). */
function sortGroups(groups: string[]): string[] {
  return groups.sort((a, b) => {
    const rank = (group: string) => {
      const index = SKILL_GROUP_ORDER.indexOf(group);
      return index === -1 ? SKILL_GROUP_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/** Render a section rule, dimmed when colored output is enabled. */
function rule(color = false): string {
  return color ? `${RULE_COLOR}${SECTION_RULE}${ANSI_RESET}` : SECTION_RULE;
}

/** De-emphasize chrome text (branch glyphs, token counts) when colored. */
function dimText(text: string, color = false): string {
  return color ? `${DIM}${text}${ANSI_RESET}` : text;
}

/** Accent a resource label/title in its section color when colored and an accent is given. */
function accentText(text: string, accent: string | undefined, color = false): string {
  return color && accent ? `${accent}${text}${ANSI_RESET}` : text;
}

/** Color one category token when the report is rendered in the TUI. */
function categorySymbol(category: CategoryId | "free", color = false): string {
  return colorText(CATEGORY_SYMBOLS[category], category, color);
}

/** Wrap text in a category color when enabled. */
function colorText(text: string, category: CategoryId | "free", color = false): string {
  return color ? `${CATEGORY_COLORS[category]}${text}${ANSI_RESET}` : text;
}

/** Render the usage grid with used category symbols first and free cells last. */
function usageGrid(report: ContextReport, color = false): string[] {
  const totalCells = GRID_WIDTH * GRID_ROWS;
  const percent = report.canonical.percent ?? 0;
  const usedCells = Math.max(0, Math.min(totalCells, Math.round((percent / 100) * totalCells)));
  const cells: string[] = [];
  const knownCategories = report.categories.filter(
    (category) =>
      category.id !== "unknown" && category.tokens !== null && (category.tokens ?? 0) > 0,
  );
  const knownTotal = knownCategories.reduce((sum, category) => sum + (category.tokens ?? 0), 0);
  for (const category of knownCategories) {
    const count =
      knownTotal > 0 ? Math.round(((category.tokens ?? 0) / knownTotal) * usedCells) : 0;
    cells.push(...Array.from({ length: count }, () => categorySymbol(category.id, color)));
  }
  while (cells.length < usedCells) cells.push(categorySymbol("unknown", color));
  cells.length = usedCells;
  while (cells.length < totalCells) cells.push(categorySymbol("free", color));
  return Array.from({ length: GRID_ROWS }, (_unused, row) =>
    cells.slice(row * GRID_WIDTH, (row + 1) * GRID_WIDTH).join(" "),
  );
}

/** Format a category row value in Claude-style wording. */
function formatCategoryValue(category: ReportCategory): string {
  if (category.tokens === null) return "?";
  return `${formatTokens(category.tokens)} tokens (${formatPercent(category.percent)})`;
}

/** Format remaining context window capacity. */
function formatFreeSpace(report: ContextReport): string {
  if (report.canonical.tokens === null || report.canonical.contextWindow === null) return "?";
  const free = Math.max(0, report.canonical.contextWindow - report.canonical.tokens);
  const percent =
    report.canonical.percent === null ? null : Math.max(0, 100 - report.canonical.percent);
  return `${formatTokens(free)} (${formatPercent(percent)})`;
}

/** Add a text-backed item when it has content. */
function addTextItem(
  items: ReportItem[],
  category: ReportItem["category"],
  label: string,
  text: string | undefined,
): void {
  if (!text) return;
  items.push({ category, label, tokens: estimateText(text) });
}

/** Estimate tokens for a stable string using Pi's exported estimateTokens helper. */
function estimateText(text: string): number {
  return estimateMessage({ role: "user", content: text, timestamp: 0 });
}

/** Estimate tokens for one message-like object using Pi's exported helpers. */
function estimateMessage(message: any): number {
  try {
    return Math.max(0, estimateTokens(message));
  } catch {
    return Math.ceil(stableText(message).length / 4);
  }
}

/** Produce deterministic text for arbitrary message/content objects. */
function stableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stableText).join("\n");
  if (value && typeof value === "object") {
    const item = value as any;
    if (item.role) {
      try {
        return serializeConversation([item]);
      } catch {}
    }
    if (typeof item.text === "string") return item.text;
    if (typeof item.thinking === "string") return item.thinking;
    return JSON.stringify(item);
  }
  return String(value ?? "");
}

/** Return a compact model label. */
function formatModel(model: { id?: string; provider?: string } | undefined): string {
  if (!model) return "unknown";
  return model.provider ? `${model.provider}/${model.id ?? "unknown"}` : (model.id ?? "unknown");
}

/** Map usage percentage to the displayed pressure status. */
function statusFor(percent: number | null): ContextStatus {
  if (percent === null) return "usage unknown until next model response";
  if (percent >= 90) return "compact soon";
  if (percent >= 70) return "watch";
  return "OK";
}

/** Truncate a string without leaking full bodies into the compact report. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Expose pure helpers for focused unit tests. */
export const __contextForTest = {
  buildContextReport,
  formatContextReport,
  branchItems,
  messageItems,
  systemItems,
} satisfies Record<string, unknown>;
