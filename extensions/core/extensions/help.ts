import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from "@earendil-works/pi-tui";

import { PanelChrome } from "../lib/ui/panel.ts";

/** Rows of the command list kept visible at once before scrolling. */
const VIEWPORT_HEIGHT = 14;

/** Source of a command, used as a short tag in the list. */
type CommandSource = "builtin" | "extension" | "prompt" | "skill";

/** Tab-cycled view modes: all commands, custom (non-builtin) only, or builtins only. */
type HelpMode = "default" | "custom" | "builtin";

/** Mode cycle order for the Tab hotkey. */
const MODE_ORDER: readonly HelpMode[] = ["default", "custom", "builtin"];

/** A single command row shown in the help panel. */
interface HelpCommand {
  /** Command name without the leading slash, e.g. `history`. */
  name: string;
  /** One-line description of what the command does. */
  description: string;
  /** Where the command comes from. */
  source: CommandSource;
}

/**
 * Pi's built-in slash commands. Mirrored here because they are not returned by
 * the public `ctx.getCommands()` API; keep in sync with Pi's BUILTIN_SLASH_COMMANDS.
 */
const BUILTIN_COMMANDS: ReadonlyArray<Omit<HelpCommand, "source">> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
  { name: "quit", description: "Quit the app" },
];

/** Register the `/help` command, a searchable browser of available slash commands. */
export function registerHelp(pi: ExtensionAPI): void {
  pi.registerCommand("help", {
    description: "Browse available slash commands and their descriptions",
    handler: async (args, ctx) => {
      await runHelp(pi, ctx, args.trim());
    },
  });
}

/** Open the help browser, then populate the editor with the chosen command. */
async function runHelp(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  initialQuery: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("help requires an interactive UI", "warning");
    return;
  }

  const commands = collectCommands(pi);
  const result = await ctx.ui.custom<HelpCommand | undefined>((tui, theme, keybindings, done) => {
    return new HelpComponent(commands, initialQuery, theme, keybindings, done, () =>
      tui.requestRender(),
    );
  });

  if (result) ctx.ui.setEditorText(`/${result.name} `);
}

/** Merge built-in and registered commands, deduped by name (registered wins), sorted by name. */
export function collectCommands(pi: Pick<ExtensionAPI, "getCommands">): HelpCommand[] {
  const byName = new Map<string, HelpCommand>();
  for (const builtin of BUILTIN_COMMANDS) {
    byName.set(builtin.name, { ...builtin, source: "builtin" });
  }
  for (const command of pi.getCommands()) {
    byName.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      source: command.source,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Filter commands by view mode, then case-insensitively across name and description. */
export function filterCommands(
  commands: readonly HelpCommand[],
  query: string,
  mode: HelpMode = "default",
): HelpCommand[] {
  const normalized = query.trim().toLocaleLowerCase();
  return commands.filter(
    (command) =>
      matchesMode(command, mode) &&
      (!normalized ||
        `${command.name} ${command.description}`.toLocaleLowerCase().includes(normalized)),
  );
}

/** Test whether a command belongs in the given view mode. */
function matchesMode(command: HelpCommand, mode: HelpMode): boolean {
  if (mode === "builtin") return command.source === "builtin";
  if (mode === "custom") return command.source !== "builtin";
  return true;
}

/** Minimal theme surface used by the help panel. */
interface HelpTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Interactive, filterable, scrollable browser of available slash commands. */
class HelpComponent extends Container implements Focusable {
  private input: Input;
  private results: HelpCommand[];
  private mode: HelpMode = "default";
  private selectedIndex = 0;
  private scroll = 0;
  private focusedValue = false;
  private chrome: PanelChrome;
  private commands: readonly HelpCommand[];
  private theme: HelpTheme;
  private keybindings: { matches(data: string, id: string): boolean };
  private done: (result: HelpCommand | undefined) => void;
  private requestRender: () => void;

  /** Build the help browser over the captured command list. */
  constructor(
    commands: readonly HelpCommand[],
    initialQuery: string,
    theme: HelpTheme,
    keybindings: { matches(data: string, id: string): boolean },
    done: (result: HelpCommand | undefined) => void,
    requestRender: () => void,
  ) {
    super();
    this.commands = commands;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.requestRender = requestRender;
    this.chrome = new PanelChrome(theme);
    this.input = new Input();
    this.input.setValue(initialQuery);
    this.addChild(this.input);
    this.results = filterCommands(commands, initialQuery, this.mode);
  }

  /** Propagate focus to the embedded input so cursor placement works. */
  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  /** Render the filter box, a scrolling window of commands, and key help. */
  render(width: number): string[] {
    const lines = this.input.render(Math.max(1, width));

    if (this.results.length === 0) {
      lines.push(this.theme.fg("warning", "No matching commands"));
    } else {
      const window = this.results.slice(this.scroll, this.scroll + VIEWPORT_HEIGHT);
      window.forEach((command, offset) => {
        lines.push(this.renderRow(command, this.scroll + offset, width));
      });
    }

    lines.push(
      this.theme.fg(
        "dim",
        `${this.results.length} commands • tab mode (${this.mode}) • ↑↓ navigate • enter insert • esc cancel`,
      ),
    );
    return this.chrome.render("help", width, lines);
  }

  /** Route navigation keys to the list and text editing to the filter input. */
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.results[this.selectedIndex];
      if (selected) this.done(selected);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.cycleMode();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refresh();
    this.requestRender();
  }

  /** Clear cached child render state. */
  invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  /** Move the selection, wrapping around, and keep it inside the viewport. */
  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
    if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
    else if (this.selectedIndex >= this.scroll + VIEWPORT_HEIGHT)
      this.scroll = this.selectedIndex - VIEWPORT_HEIGHT + 1;
    this.requestRender();
  }

  /** Advance to the next view mode and recompute the visible commands. */
  private cycleMode(): void {
    const next = (MODE_ORDER.indexOf(this.mode) + 1) % MODE_ORDER.length;
    this.mode = MODE_ORDER[next];
    this.refresh();
    this.requestRender();
  }

  /** Recompute results for the current query and mode, resetting selection. */
  private refresh(): void {
    this.results = filterCommands(this.commands, this.input.getValue(), this.mode);
    this.selectedIndex = 0;
    this.scroll = 0;
  }

  /** Render one command row: selection marker, padded name, source tag, description. */
  private renderRow(command: HelpCommand, index: number, width: number): string {
    const marker = index === this.selectedIndex ? "→ " : "  ";
    const name = pad(`/${command.name}`, 22);
    const tag = pad(`[${command.source}]`, 12);
    const clipped = truncateToWidth(`${marker}${name} ${tag} ${command.description}`, width, "");
    return index === this.selectedIndex
      ? this.theme.fg("accent", clipped)
      : this.theme.fg("muted", clipped);
  }
}

/** Pad text to a visible width (ANSI-aware) for column alignment. */
function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Pure helpers exposed for Node tests. */
export const __helpForTest = {
  collectCommands,
  filterCommands,
  BUILTIN_COMMANDS,
};
