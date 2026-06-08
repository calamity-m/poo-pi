import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
export interface PanelTheme {
  fg(color: string, text: string): string;
}

/** Shared panel chrome renderer for titled panels with no side borders. */
export class PanelChrome {
  private readonly theme: PanelTheme;

  /** Build a panel chrome renderer using the provided color theme. */
  constructor(theme: PanelTheme) {
    this.theme = theme;
  }

  /** Render edge-to-edge rules, a visible title row, and padded content rows. */
  render(title: string, width: number, lines: string[]): string[] {
    if (width < 1) return [""];

    return [
      this.horizontalRule(width),
      this.frameLine(this.theme.fg("accent", title), width),
      ...lines.map((line) => this.frameLine(line, width)),
      this.horizontalRule(width),
    ];
  }

  /** Render an edge-to-edge horizontal rule. */
  horizontalRule(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(0, width)));
  }

  /** Render one content line with right padding and no side borders. */
  frameLine(text: string, contentWidth: number): string {
    const clipped = truncateToWidth(text, contentWidth, "");
    const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
    return `${clipped}${pad}`;
  }
}

/** Read-only panel that renders wrapped lines with arrow/page scrolling; Esc/Enter/q dismisses it. */
export class TextPanel {
  focused = false;
  private offset = 0;
  private viewportHeight = 1;
  private totalRenderedLines = 1;
  private readonly theme: PanelTheme;
  private readonly chrome: PanelChrome;
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
    this.chrome = new PanelChrome(theme);
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
    } else if (data === "\x1b[5~" || this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scroll(-this.viewportHeight);
      this.requestRender();
    } else if (data === "\x1b[6~" || this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scroll(this.viewportHeight);
      this.requestRender();
    }
  }

  /** Render a bordered title, a window of content lines, and a footer hint. */
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth(this.title, width, "")];

    const contentWidth = width;
    const footer = "↑/↓ PgUp/PgDn scroll • Esc/Enter/q close";
    const wrappedLines = this.lines.flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, contentWidth),
    );
    this.viewportHeight = Math.max(1, 24 - 3);
    this.totalRenderedLines = wrappedLines.length;
    const maxOffset = Math.max(0, wrappedLines.length - this.viewportHeight);
    this.offset = Math.min(this.offset, maxOffset);
    const window = wrappedLines.slice(this.offset, this.offset + this.viewportHeight);

    return this.chrome.render(this.title, width, [...window, this.theme.fg("dim", footer)]);
  }

  /** No-op required by the Pi custom component lifecycle. */
  invalidate(): void {}

  /** Shift the visible window, clamped to the content bounds. */
  private scroll(delta: number): void {
    const maxOffset = Math.max(0, this.totalRenderedLines - this.viewportHeight);
    this.offset = Math.max(0, Math.min(maxOffset, this.offset + delta));
  }
}
