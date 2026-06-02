import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

/** Show a read-only, scrollable text panel as an overlay and resolve when the user dismisses it. */
export async function showPanel(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (_tui, theme, keybindings, done) => new TextPanel(theme, keybindings, done, title, lines),
    { overlay: true, overlayOptions: { width: "80%", minWidth: 48, maxHeight: 24 } },
  );
}

/** Minimal theme surface the panel needs for coloring its chrome. */
interface PanelTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Read-only overlay that renders fixed lines with arrow/page scrolling; Esc/Enter/q dismisses it. */
class TextPanel {
  focused = false;
  private offset = 0;
  private viewportHeight = 1;
  private readonly theme: PanelTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly title: string;
  private readonly lines: string[];

  /** Build the panel; `done` is invoked on dismissal so the awaiting command can return. */
  constructor(
    theme: PanelTheme,
    keybindings: KeybindingsManager,
    done: () => void,
    title: string,
    lines: string[],
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.title = title;
    this.lines = lines.length > 0 ? lines : ["(nothing to show)"];
  }

  /** Scroll within the content or dismiss the panel. */
  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.input.submit") ||
      data === "q" ||
      data === "\n" ||
      data === "\r"
    )
      return this.done();
    if (data === "\x1b[A" || this.keybindings.matches(data, "tui.editor.cursorUp")) this.scroll(-1);
    else if (data === "\x1b[B" || this.keybindings.matches(data, "tui.editor.cursorDown"))
      this.scroll(1);
  }

  /** Render the title, a window of content lines, and a footer hint. */
  render(width: number): string[] {
    const header = this.theme.fg("accent", this.theme.bold(this.title));
    const footer = this.theme.fg("dim", "↑/↓ scroll • Esc/Enter/q close");
    this.viewportHeight = Math.max(1, 24 - 2);
    const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
    this.offset = Math.min(this.offset, maxOffset);
    const window = this.lines.slice(this.offset, this.offset + this.viewportHeight);
    return [header, ...window.map((line) => truncate(line, width)), footer];
  }

  /** No-op required by the Pi custom component lifecycle. */
  invalidate(): void {}

  /** Shift the visible window, clamped to the content bounds. */
  private scroll(delta: number): void {
    const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
    this.offset = Math.max(0, Math.min(maxOffset, this.offset + delta));
  }
}

/** Truncate a line to the viewport width. */
function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1));
}
