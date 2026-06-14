import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SizeValue,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Navigation result returned by a text panel that can go back to a parent menu. */
export type PanelNavigationResult = "close" | "back";

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

/** Show a text panel where Backspace returns `"back"` instead of simply closing. */
export async function showNavigablePanel(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<PanelNavigationResult> {
  return await showNavigablePanelWithPlacement(ctx, title, lines, true);
}

/** Show a navigable text panel inline in the prompt area. */
export async function showInlineNavigablePanel(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
): Promise<PanelNavigationResult> {
  return await showNavigablePanelWithPlacement(ctx, title, lines, false);
}

/** Show a navigable text panel either inline or as an overlay. */
async function showNavigablePanelWithPlacement(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
  overlay: boolean,
): Promise<PanelNavigationResult> {
  const factory = (
    tui: { requestRender(): void },
    theme: PanelTheme,
    keybindings: KeybindingsManager,
    done: (result: PanelNavigationResult) => void,
  ) =>
    new TextPanel(
      theme,
      keybindings,
      () => tui.requestRender(),
      () => done("close"),
      title,
      lines,
      () => done("back"),
    );
  if (!overlay) return await ctx.ui.custom<PanelNavigationResult>(factory);
  return await ctx.ui.custom<PanelNavigationResult>(factory, {
    overlay: true,
    overlayOptions: { width: "80%", minWidth: 48, maxHeight: 24 },
  });
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

/** Options for a shared select-list overlay panel. */
export interface SelectPanelOptions<T = string> {
  /** Title rendered at the top of the selector. */
  title: string;
  /** Items shown in the selector. */
  items: SelectItem[];
  /** Optional footer hint; defaults to the standard select/close hint. */
  footer?: string;
  /** Maximum number of visible list items. */
  visibleItems?: number;
  /** Overlay width setting passed through to Pi's custom UI API. */
  width?: SizeValue;
  /** Overlay minimum width setting passed through to Pi's custom UI API. */
  minWidth?: number;
  /** Overlay maximum height setting passed through to Pi's custom UI API. */
  maxHeight?: SizeValue;
  /** Map the chosen item (Enter) to a result. Defaults to the item value. */
  onSelect?: (item: SelectItem) => T | null;
  /**
   * Intercept a raw key before the list handles it. Return a result to dismiss the overlay,
   * or `undefined` to let the list handle the key normally. The currently highlighted item is
   * passed so callers can act on the active selection.
   */
  onKey?: (data: string, current: SelectItem | null) => T | null | undefined;
}

/** Show a subagents-style select-list overlay and return the selected result. */
export async function showSelectPanel<T = string>(
  ctx: ExtensionContext,
  options: SelectPanelOptions<T>,
): Promise<T | null> {
  return await showSelectPanelWithPlacement(ctx, options, true);
}

/** Show a select-list panel inline in the prompt area and return the selected result. */
export async function showInlineSelectPanel<T = string>(
  ctx: ExtensionContext,
  options: SelectPanelOptions<T>,
): Promise<T | null> {
  return await showSelectPanelWithPlacement(ctx, options, false);
}

/** Show a select-list panel either inline or as an overlay. */
async function showSelectPanelWithPlacement<T = string>(
  ctx: ExtensionContext,
  options: SelectPanelOptions<T>,
  overlay: boolean,
): Promise<T | null> {
  const factory = (
    tui: { requestRender(): void },
    theme: SelectPanelTheme,
    _keybindings: KeybindingsManager,
    done: (result: T | null) => void,
  ) => {
    const list = new SelectList(
      options.items,
      options.visibleItems ?? Math.min(options.items.length, 12),
      {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      },
    );
    list.onSelect = (item) =>
      done(options.onSelect ? options.onSelect(item) : (item.value as unknown as T));
    list.onCancel = () => done(null);

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 1));
    container.addChild(list);
    container.addChild(
      new Text(theme.fg("dim", options.footer ?? "↑↓ navigate • Enter select • Esc close"), 1, 1),
    );
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (options.onKey) {
          const result = options.onKey(data, list.getSelectedItem());
          if (result !== undefined) {
            done(result);
            return;
          }
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  };
  if (!overlay) return await ctx.ui.custom<T | null>(factory);
  return await ctx.ui.custom<T | null>(factory, {
    overlay: true,
    overlayOptions: {
      width: options.width ?? "80%",
      minWidth: options.minWidth ?? 56,
      maxHeight: options.maxHeight ?? 18,
    },
  });
}

/** Minimal theme surface the panel needs for coloring its chrome. */
export interface PanelTheme {
  fg(color: string, text: string): string;
}

/** Minimal theme surface the select panel needs for list styling. */
interface SelectPanelTheme extends PanelTheme {
  bg(color: string, text: string): string;
  bold(text: string): string;
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
  private readonly onBack: (() => void) | undefined;

  /** Build the panel; `done` is invoked on dismissal so the awaiting command can return. */
  constructor(
    theme: PanelTheme,
    keybindings: KeybindingsManager,
    requestRender: () => void,
    done: () => void,
    title: string,
    lines: string[],
    onBack?: () => void,
  ) {
    this.theme = theme;
    this.chrome = new PanelChrome(theme);
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.done = done;
    this.title = title;
    this.lines = lines.length > 0 ? lines : ["(nothing to show)"];
    this.onBack = onBack;
  }

  /** Scroll within the content or dismiss the panel. */
  handleInput(data: string): void {
    if (this.onBack && (data === "\x7f" || data === "\b")) return this.onBack();
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
    const footer = this.onBack
      ? "↑/↓ PgUp/PgDn scroll • Backspace back • Esc/Enter/q close"
      : "↑/↓ PgUp/PgDn scroll • Esc/Enter/q close";
    const wrappedLines = this.lines.flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, contentWidth),
    );
    this.viewportHeight = Math.max(1, 24 - 4);
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
