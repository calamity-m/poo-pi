import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

/** Show a read-only, scrollable text panel as an overlay and resolve when dismissed. */
export async function showPanel(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new TextPanel(theme, keybindings, () => tui.requestRender(), done, title, lines),
    { overlay: true, overlayOptions: { width: "80%", minWidth: 48, maxHeight: 24 } },
  );
}

/** Show a read-only, scrollable text panel inline in the prompt area. */
export async function showInlinePanel(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new TextPanel(theme, keybindings, () => tui.requestRender(), done, title, lines),
  );
}

/** Minimal theme surface the panel needs for coloring its chrome. */
interface PanelTheme {
  fg(color: string, text: string): string;
}

/** Read-only panel that renders fixed lines with arrow scrolling; Esc/Enter/q dismisses it. */
class TextPanel {
  focused = false;
  private offset = 0;
  private viewportHeight = 1;
  private readonly theme: PanelTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly done: () => void;
  private readonly title: string;
  private readonly lines: string[];

  /** Build the panel; `done` is invoked on dismissal so the awaiting command can return. */
  constructor(
    theme: PanelTheme,
    keybindings: KeybindingsManager,
    requestRender: () => void,
    done: () => void,
    title: string,
    lines: string[],
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
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
    if (data === "\x1b[A" || this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scroll(-1);
      this.requestRender();
    } else if (data === "\x1b[B" || this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scroll(1);
      this.requestRender();
    }
  }

  /** Render a bordered title, a window of content lines, and a footer hint. */
  render(width: number): string[] {
    if (width < 4) return [truncate(this.title, width)];

    const innerWidth = width - 2;
    const footer = "↑/↓ scroll • Esc/Enter/q close";
    this.viewportHeight = Math.max(1, 24 - 3);
    const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
    this.offset = Math.min(this.offset, maxOffset);
    const window = this.lines.slice(this.offset, this.offset + this.viewportHeight);

    return [
      this.borderLine(this.title, width),
      ...window.map((line) => this.frameLine(truncate(line, innerWidth), innerWidth)),
      this.frameLine(this.theme.fg("dim", truncate(footer, innerWidth)), innerWidth),
      this.theme.fg("border", `└${"─".repeat(innerWidth)}┘`),
    ];
  }

  /** No-op required by the Pi custom component lifecycle. */
  invalidate(): void {}

  /** Render the top border with the panel title embedded. */
  private borderLine(title: string, width: number): string {
    const innerWidth = width - 2;
    const label = ` ${truncate(title, Math.max(0, innerWidth - 2))} `;
    const rule = "─".repeat(Math.max(0, innerWidth - label.length));
    return this.theme.fg("border", `┌${label}${rule}┐`);
  }

  /** Render one content line with vertical borders and right padding. */
  private frameLine(text: string, innerWidth: number): string {
    const pad = " ".repeat(Math.max(0, innerWidth - visibleLength(text)));
    return `${this.theme.fg("border", "│")}${text}${pad}${this.theme.fg("border", "│")}`;
  }

  /** Shift the visible window, clamped to the content bounds. */
  private scroll(delta: number): void {
    const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
    this.offset = Math.max(0, Math.min(maxOffset, this.offset + delta));
  }
}

/** Truncate a plain-text line to the viewport width. */
function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1));
}

/** Return the visible length of text after skipping ANSI SGR sequences. */
function visibleLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 27 && text[i + 1] === "[") {
      i += 2;
      while (i < text.length && text[i] !== "m") i++;
      continue;
    }
    length++;
  }
  return length;
}
