import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

/** Valid Tier 1 planning iteration counts for the gated workflow. */
const TIER1_ITERATIONS = [3, 4, 5, 6, 7] as const;

/** Valid Tier 2 refinement iteration counts for the gated workflow. */
const TIER2_ITERATIONS = [1, 2, 3] as const;

/** Pi thinking levels selectable for models that support reasoning. */
const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

/** Labels used by the stepper progress indicator. */
const STEP_LABELS = ["Tier 1", "Evaluation", "Tier 2", "Seed"] as const;

/** Thinking choice captured by the gated-t1 setup UI. */
type ThinkingChoice = "off" | ThinkingLevel;

/** Model data needed by the gated-t1 setup UI. */
interface ModelOption {
  /** Canonical provider/model-id used by Pi APIs. */
  id: string;
  /** Provider id, used for grouping and search. */
  provider: string;
  /** Provider-local model id. */
  modelId: string;
  /** Human-readable model name from Pi's registry. */
  name: string;
  /** Whether the model supports reasoning/thinking controls. */
  reasoning: boolean;
  /** Thinking choices valid for this model. Non-reasoning models only expose off. */
  thinkingLevels: ThinkingChoice[];
}

/** Captured UI configuration for the gated-t1 workflow prototype. */
interface GatedT1Config {
  /** Number of Tier 1 planning agents/iterations. */
  tier1Iterations: number;
  /** Canonical provider/model-id for Tier 1 and Tier 2 planning. */
  planningModel: string;
  /** Thinking level for Tier 1 and Tier 2 planning. */
  planningThinking: ThinkingChoice;
  /** Canonical provider/model-id for evaluation gates. */
  evaluationModel: string;
  /** Thinking level for evaluation gates. */
  evaluationThinking: ThinkingChoice;
  /** Number of Tier 2 refinement agents/iterations. */
  tier2Iterations: number;
  /** User-provided task or problem statement that seeds the workflow. */
  seed: string;
}

/** Result returned by the gated-t1 setup UI. */
type GatedT1Result = { status: "submitted"; config: GatedT1Config } | { status: "cancelled" };

/** Active model picker target, or undefined when the stepper is active. */
type ModelPickerTarget = "planning" | "evaluation";

/** Register the gated workflow prototype command. */
export function registerGatedT1(pi: ExtensionAPI): void {
  pi.registerCommand("gated-t1", {
    description: "Prototype a gated multi-agent workflow setup UI",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/gated-t1 requires interactive UI mode.", "warning");
        return;
      }

      const models = availableModels(ctx);
      if (models.length === 0) {
        ctx.ui.notify("/gated-t1 could not find any authenticated models.", "warning");
        return;
      }

      const result = await ctx.ui.custom<GatedT1Result>((tui, theme, _keybindings, done) => {
        return new GatedT1Panel(models, currentModelId(ctx), tui, theme, done);
      });

      if (!result || result.status === "cancelled") {
        ctx.ui.notify("/gated-t1 cancelled.", "info");
        return;
      }

      pi.sendMessage({
        customType: "gated-t1",
        content: formatSummary(result.config),
        display: true,
        details: result.config,
      });
      ctx.ui.notify("/gated-t1 UI captured workflow settings; runner not implemented yet.", "info");
    },
  });
}

/** Return authenticated model options from the live model registry. */
function availableModels(ctx: ExtensionCommandContext): ModelOption[] {
  return ctx.modelRegistry
    .getAll()
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevels: supportedThinkingLevels(model.reasoning, model.thinkingLevelMap),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Return thinking choices valid for one model. */
function supportedThinkingLevels(
  reasoning: boolean,
  thinkingLevelMap: Partial<Record<ThinkingChoice, string | null>> | undefined,
): ThinkingChoice[] {
  if (!reasoning) return ["off"];
  return ["off", ...THINKING_LEVELS.filter((level) => thinkingLevelMap?.[level] !== null)];
}

/** Return the current session model identifier, if one is selected. */
function currentModelId(ctx: ExtensionCommandContext): string | undefined {
  if (!ctx.model) return undefined;
  return `${ctx.model.provider}/${ctx.model.id}`;
}

/** Format the captured settings as a visible session note. */
function formatSummary(config: GatedT1Config): string {
  return [
    "gated-t1 setup captured",
    "",
    `Tier 1 Planning: ${config.tier1Iterations} iteration${config.tier1Iterations === 1 ? "" : "s"} using ${formatModelWithThinking(config.planningModel, config.planningThinking)}`,
    `Evaluation: 1 agent using ${formatModelWithThinking(config.evaluationModel, config.evaluationThinking)}`,
    `Tier 2 Planning refinement: ${config.tier2Iterations} iteration${config.tier2Iterations === 1 ? "" : "s"} using ${formatModelWithThinking(config.planningModel, config.planningThinking)}`,
    "Human Acceptance: pending future workflow runner",
    "Implementation: pending future workflow runner",
    `Final Evaluation: 1 agent using ${formatModelWithThinking(config.evaluationModel, config.evaluationThinking)}`,
    "Refinement: 1 agent pending future workflow runner",
    "Done: pending future workflow runner",
    "",
    "Seed:",
    config.seed,
  ].join("\n");
}

/** Format a model id with its thinking selection. */
function formatModelWithThinking(model: string, thinking: ThinkingChoice): string {
  return `${model} (thinking ${thinking})`;
}

/** Interactive prompt stepper for gathering gated-t1 prototype settings. */
class GatedT1Panel {
  focused = false;
  private step = 0;
  private selectedRow = 0;
  private tier1Index = 0;
  private planningModelIndex = 0;
  private planningThinkingIndex = 0;
  private evaluationModelIndex = 0;
  private evaluationThinkingIndex = 0;
  private tier2Index = 0;
  private seed = "";
  private modelPicker: ModelPickerTarget | undefined;
  private modelQuery = "";
  private modelPickerIndex = 0;
  private readonly models: ModelOption[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: GatedT1Result) => void;

  /** Build the stepper with authenticated models and the current model as the preferred default. */
  constructor(
    models: ModelOption[],
    currentModel: string | undefined,
    tui: TUI,
    theme: Theme,
    done: (result: GatedT1Result) => void,
  ) {
    this.models = models;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    const currentIndex = currentModel ? models.findIndex((model) => model.id === currentModel) : -1;
    if (currentIndex >= 0) {
      this.planningModelIndex = currentIndex;
      this.evaluationModelIndex = currentIndex;
    }
  }

  /** Handle keyboard input for selection, search, text entry, submission, and cancellation. */
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) return this.done({ status: "cancelled" });
    if (this.modelPicker) {
      this.handleModelPickerInput(data);
      return;
    }
    if (matchesKey(data, "escape")) return this.done({ status: "cancelled" });

    if (this.step === 3) {
      this.handleSeedInput(data);
      return;
    }

    if (matchesKey(data, "up")) this.moveRow(-1);
    else if (matchesKey(data, "down")) this.moveRow(1);
    else if (matchesKey(data, "left")) this.cycleActiveValue(-1);
    else if (matchesKey(data, "right") || data === " ") this.cycleActiveValue(1);
    else if (matchesKey(data, "shift+tab") || data === "\b" || data === "\x7f") this.previousStep();
    else if (matchesKey(data, "tab")) this.nextStep();
    else if (isEnter(data)) this.activateCurrentRow();
    else return;

    this.tui.requestRender();
  }

  /** Render the active step, progress indicator, and keyboard hints. */
  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (this.modelPicker) return this.renderModelPicker(renderWidth);

    const body = this.renderBody(renderWidth);
    const help =
      this.step === 3
        ? "Type seed text • Enter submit • Shift+Tab back • Esc cancel"
        : "↑↓ fields • ←/→ change values • Enter choose model/next • Tab next • Esc cancel";
    const lines = [
      this.theme.fg("border", "─".repeat(renderWidth)),
      this.theme.fg("accent", this.theme.bold("gated-t1 workflow setup")),
      this.progress(renderWidth),
      "",
      ...body,
      "",
      this.theme.fg("dim", help),
      this.theme.fg("border", "─".repeat(renderWidth)),
    ];
    return lines.map((line) => truncateToWidth(line, renderWidth, ""));
  }

  /** No cached state to invalidate. */
  invalidate(): void {}

  /** Move selection within the active step. */
  private moveRow(delta: number): void {
    const rows = this.rowCount();
    this.selectedRow = Math.max(0, Math.min(rows - 1, this.selectedRow + delta));
  }

  /** Return the selectable row count for the active step. */
  private rowCount(): number {
    if (this.step === 0) return this.planningModel.reasoning ? 3 : 2;
    if (this.step === 1) return this.evaluationModel.reasoning ? 2 : 1;
    return 1;
  }

  /** Currently selected planning model. */
  private get planningModel(): ModelOption {
    return this.models[this.planningModelIndex];
  }

  /** Currently selected evaluation model. */
  private get evaluationModel(): ModelOption {
    return this.models[this.evaluationModelIndex];
  }

  /** Currently selected planning thinking choice. */
  private get planningThinking(): ThinkingChoice {
    return this.planningModel.thinkingLevels[this.planningThinkingIndex] ?? "off";
  }

  /** Currently selected evaluation thinking choice. */
  private get evaluationThinking(): ThinkingChoice {
    return this.evaluationModel.thinkingLevels[this.evaluationThinkingIndex] ?? "off";
  }

  /** Advance to the next step, or submit from the final step. */
  private nextStep(): void {
    if (this.step < 3) {
      this.step++;
      this.selectedRow = 0;
      return;
    }
    this.submit();
  }

  /** Move to the previous step when possible. */
  private previousStep(): void {
    if (this.step === 0) return;
    this.step--;
    this.selectedRow = 0;
  }

  /** Activate the current row without relying on left/right cycling. */
  private activateCurrentRow(): void {
    if (this.step === 0 && this.selectedRow === 1) return this.openModelPicker("planning");
    if (this.step === 1 && this.selectedRow === 0) return this.openModelPicker("evaluation");
    this.nextStep();
  }

  /** Cycle the currently highlighted non-text value. */
  private cycleActiveValue(delta: number): void {
    if (this.step === 0 && this.selectedRow === 0) {
      this.tier1Index = cycleIndex(this.tier1Index, TIER1_ITERATIONS.length, delta);
    } else if (this.step === 0 && this.selectedRow === 1) {
      this.openModelPicker("planning");
    } else if (this.step === 0 && this.selectedRow === 2) {
      this.planningThinkingIndex = cycleIndex(
        this.planningThinkingIndex,
        this.planningModel.thinkingLevels.length,
        delta,
      );
    } else if (this.step === 1 && this.selectedRow === 0) {
      this.openModelPicker("evaluation");
    } else if (this.step === 1 && this.selectedRow === 1) {
      this.evaluationThinkingIndex = cycleIndex(
        this.evaluationThinkingIndex,
        this.evaluationModel.thinkingLevels.length,
        delta,
      );
    } else if (this.step === 2) {
      this.tier2Index = cycleIndex(this.tier2Index, TIER2_ITERATIONS.length, delta);
    }
  }

  /** Open the searchable model picker for a model field. */
  private openModelPicker(target: ModelPickerTarget): void {
    this.modelPicker = target;
    this.modelQuery = "";
    this.modelPickerIndex = this.currentModelIndexFor(target);
  }

  /** Handle keyboard input while the searchable model picker is open. */
  private handleModelPickerInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.closeModelPicker();
      this.tui.requestRender();
      return;
    }

    const filtered = this.filteredModels();
    if (matchesKey(data, "up")) {
      this.modelPickerIndex = Math.max(0, this.modelPickerIndex - 1);
    } else if (matchesKey(data, "down")) {
      this.modelPickerIndex = Math.min(filtered.length - 1, this.modelPickerIndex + 1);
    } else if (matchesKey(data, "backspace") || data === "\b" || data === "\x7f") {
      this.modelQuery = this.modelQuery.slice(0, -1);
      this.modelPickerIndex = 0;
    } else if (isEnter(data) && filtered.length > 0) {
      this.selectModel(filtered[this.modelPickerIndex]);
      this.closeModelPicker();
    } else if (isPrintableInput(data)) {
      this.modelQuery += data;
      this.modelPickerIndex = 0;
    } else return;

    this.tui.requestRender();
  }

  /** Close the model picker and return to the stepper. */
  private closeModelPicker(): void {
    this.modelPicker = undefined;
    this.modelQuery = "";
    this.modelPickerIndex = 0;
  }

  /** Return the currently selected model index for a picker target. */
  private currentModelIndexFor(target: ModelPickerTarget): number {
    return target === "planning" ? this.planningModelIndex : this.evaluationModelIndex;
  }

  /** Select a model for the active picker target, clamping thinking to supported choices. */
  private selectModel(model: ModelOption): void {
    if (this.modelPicker === "planning") {
      this.planningModelIndex = this.models.findIndex((item) => item.id === model.id);
      this.planningThinkingIndex = clampThinkingIndex(
        this.planningThinkingIndex,
        this.planningModel,
      );
    } else if (this.modelPicker === "evaluation") {
      this.evaluationModelIndex = this.models.findIndex((item) => item.id === model.id);
      this.evaluationThinkingIndex = clampThinkingIndex(
        this.evaluationThinkingIndex,
        this.evaluationModel,
      );
    }
  }

  /** Return models matching the current picker query. */
  private filteredModels(): ModelOption[] {
    const query = this.modelQuery.trim().toLowerCase();
    if (!query) return this.models;
    const terms = query.split(/\s+/u);
    return this.models.filter((model) => {
      const haystack = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  /** Handle text editing keys for the seed input step. */
  private handleSeedInput(data: string): void {
    if (matchesKey(data, "shift+tab")) {
      this.previousStep();
      this.tui.requestRender();
      return;
    }
    if (isEnter(data)) {
      if (this.seed.trim()) this.submit();
      else this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace") || data === "\b" || data === "\x7f") {
      this.seed = this.seed.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.seed += data;
      this.tui.requestRender();
    }
  }

  /** Submit the current selections to the command handler. */
  private submit(): void {
    const seed = this.seed.trim();
    if (!seed) return;
    this.done({
      status: "submitted",
      config: {
        tier1Iterations: TIER1_ITERATIONS[this.tier1Index],
        planningModel: this.planningModel.id,
        planningThinking: this.planningThinking,
        evaluationModel: this.evaluationModel.id,
        evaluationThinking: this.evaluationThinking,
        tier2Iterations: TIER2_ITERATIONS[this.tier2Index],
        seed,
      },
    });
  }

  /** Render the active step's body rows. */
  private renderBody(width: number): string[] {
    if (this.step === 0) {
      return [
        this.theme.fg("accent", "Step 1: Tier 1 Planning"),
        "Choose the number of Tier 1 planning iterations, then search for a planning model.",
        "",
        this.valueRow("Tier 1 iterations", String(TIER1_ITERATIONS[this.tier1Index]), 0, width),
        this.valueRow("Planning model", modelDisplay(this.planningModel), 1, width),
        ...this.thinkingRows(
          "Planning thinking",
          this.planningModel,
          this.planningThinking,
          2,
          width,
        ),
      ];
    }
    if (this.step === 1) {
      return [
        this.theme.fg("accent", "Step 2: Evaluation"),
        "Choose the model used by evaluation gates.",
        "",
        this.valueRow("Evaluation model", modelDisplay(this.evaluationModel), 0, width),
        ...this.thinkingRows(
          "Evaluation thinking",
          this.evaluationModel,
          this.evaluationThinking,
          1,
          width,
        ),
      ];
    }
    if (this.step === 2) {
      return [
        this.theme.fg("accent", "Step 3: Tier 2 Planning refinement"),
        `Tier 2 uses the Tier 1 planning model: ${formatModelWithThinking(this.planningModel.id, this.planningThinking)}`,
        "",
        this.valueRow("Tier 2 iterations", String(TIER2_ITERATIONS[this.tier2Index]), 0, width),
      ];
    }
    return this.renderSeedStep(width);
  }

  /** Render a thinking row only when useful, otherwise show non-selectable unsupported state. */
  private thinkingRows(
    label: string,
    model: ModelOption,
    thinking: ThinkingChoice,
    row: number,
    width: number,
  ): string[] {
    if (model.reasoning) return [this.valueRow(label, thinking, row, width)];
    return [this.theme.fg("dim", padToWidth(`  ${label}: off (unsupported by model)`, width))];
  }

  /** Render the final seed-input step. */
  private renderSeedStep(width: number): string[] {
    const prompt = this.seed.length > 0 ? `${this.seed}█` : "█";
    const inputLines = wrapTextWithAnsi(prompt, Math.max(1, width - 2)).map((line) => `  ${line}`);
    return [
      this.theme.fg("accent", "Step 4: Seed gated-t1"),
      "Describe the task, problem, or goal this gated workflow should start from.",
      "",
      ...inputLines,
      ...(this.seed.trim()
        ? []
        : ["", this.theme.fg("warning", "Seed input is required before submit.")]),
    ];
  }

  /** Render the searchable model picker. */
  private renderModelPicker(width: number): string[] {
    const filtered = this.filteredModels();
    this.modelPickerIndex = Math.min(this.modelPickerIndex, Math.max(0, filtered.length - 1));
    const title = this.modelPicker === "planning" ? "Planning model" : "Evaluation model";
    const visible = filtered.slice(this.modelPickerIndex, this.modelPickerIndex + 10);
    const lines = [
      this.theme.fg("border", "─".repeat(width)),
      this.theme.fg("accent", this.theme.bold(`Choose ${title}`)),
      `Search: ${this.modelQuery || this.theme.fg("dim", "type to filter")}`,
      "",
      ...(visible.length > 0
        ? visible.flatMap((model, offset) =>
            this.modelOptionLines(model, this.modelPickerIndex + offset, width),
          )
        : [this.theme.fg("warning", "No models match that search.")]),
      "",
      this.theme.fg("dim", "Type search • ↑↓ navigate • Enter select • Esc back"),
      this.theme.fg("border", "─".repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /** Render one model option in the picker. */
  private modelOptionLines(model: ModelOption, index: number, width: number): string[] {
    const active = index === this.modelPickerIndex;
    const thinking = model.reasoning
      ? `thinking: ${model.thinkingLevels.join("/")}`
      : "thinking: unsupported";
    const label = `${active ? "❯" : " "} ${model.id}`;
    const description = `   ${model.name} · ${thinking}`;
    const labelLine = padToWidth(truncateToWidth(label, width, ""), width);
    const descriptionLine = padToWidth(truncateToWidth(description, width, ""), width);
    if (!active) return [labelLine, this.theme.fg("dim", descriptionLine)];
    return [
      this.theme.bg("selectedBg", this.theme.fg("accent", labelLine)),
      this.theme.bg("selectedBg", this.theme.fg("muted", descriptionLine)),
    ];
  }

  /** Render one selectable value row. */
  private valueRow(label: string, value: string, row: number, width: number): string {
    const active = this.selectedRow === row;
    const prefix = active ? "❯" : " ";
    const text = `${prefix} ${label}: ${value}`;
    const padded = padToWidth(truncateToWidth(text, width, ""), width);
    return active ? this.theme.bg("selectedBg", this.theme.fg("accent", padded)) : padded;
  }

  /** Render the four-step progress line. */
  private progress(width: number): string {
    const parts = STEP_LABELS.map((label, index) => {
      const marker = index < this.step ? "✓" : index === this.step ? "●" : "○";
      const text = `${marker} ${index + 1}. ${label}`;
      if (index < this.step) return this.theme.fg("success", text);
      if (index === this.step) return this.theme.fg("accent", this.theme.bold(text));
      return this.theme.fg("dim", text);
    });
    return truncateToWidth(parts.join(this.theme.fg("dim", "  →  ")), width, "");
  }
}

/** Clamp a thinking index to the valid choices for a selected model. */
function clampThinkingIndex(index: number, model: ModelOption): number {
  return Math.max(0, Math.min(index, model.thinkingLevels.length - 1));
}

/** Return a compact model label for selected-value rows. */
function modelDisplay(model: ModelOption): string {
  return model.name === model.modelId ? model.id : `${model.id} (${model.name})`;
}

/** Return an index moved by delta and wrapped to the provided length. */
function cycleIndex(index: number, length: number, delta: number): number {
  return (index + delta + length) % length;
}

/** Pad a possibly styled string to an exact visible width. */
function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

/** Return true when the raw input represents an Enter key. */
function isEnter(data: string): boolean {
  return matchesKey(data, "return") || matchesKey(data, "enter") || data === "\n" || data === "\r";
}

/** Return true for printable text input that should be appended to a text field. */
function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  return [...data].every((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

/** Default Pi extension entrypoint for standalone gated-t1 development. */
export default function gatedT1Extension(pi: ExtensionAPI): void {
  registerGatedT1(pi);
}
