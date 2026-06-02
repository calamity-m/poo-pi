import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";

/** Prompt for a secret using a custom masked component so the value never enters chat history. */
export async function promptHiddenSecret(
  ctx: ExtensionContext,
  title: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => new MaskedSecretInput(tui, theme, keybindings, done, title),
    {
      overlay: true,
      overlayOptions: { width: "70%", minWidth: 48, maxHeight: 5 },
    },
  );
}

/** Minimal vendored masked input component adapted from the local secret-input reference extension. */
class MaskedSecretInput {
  focused = false;
  private value: string[] = [];
  private cursor = 0;
  private pasteBuffer = "";
  private isInPaste = false;
  private readonly tui: { requestRender(): void };
  private readonly theme: { fg(color: string, text: string): string; bold(text: string): string };
  private readonly keybindings: KeybindingsManager;
  private readonly done: (value: string | undefined) => void;
  private readonly title: string;

  /** Build a masked input component; only `done` receives the secret, never render/status text. */
  constructor(
    tui: { requestRender(): void },
    theme: { fg(color: string, text: string): string; bold(text: string): string },
    keybindings: KeybindingsManager,
    done: (value: string | undefined) => void,
    title: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.title = title;
  }

  /** Handle text editing, paste, submit, and cancel without echoing secret characters. */
  handleInput(data: string): void {
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }
    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
      if (endIndex === -1) return;
      const pasted = this.pasteBuffer.slice(0, endIndex).replace(/[\r\n]/g, "");
      const remaining = this.pasteBuffer.slice(endIndex + "\x1b[201~".length);
      this.pasteBuffer = "";
      this.isInPaste = false;
      this.insertText(pasted);
      if (remaining) this.handleInput(remaining);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit") || data === "\n" || data === "\r")
      return this.done(this.value.join(""));
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.cancel();
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward"))
      return this.deleteBackward();
    if (this.keybindings.matches(data, "tui.editor.deleteCharForward")) return this.deleteForward();
    if (this.keybindings.matches(data, "tui.editor.cursorLeft")) return this.moveCursor(-1);
    if (this.keybindings.matches(data, "tui.editor.cursorRight")) return this.moveCursor(1);
    if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) return this.setCursor(0);
    if (this.keybindings.matches(data, "tui.editor.cursorLineEnd"))
      return this.setCursor(this.value.length);
    if (!hasControlChars(data)) {
      this.insertText(data);
      this.tui.requestRender();
    }
  }

  /** Render only mask characters; no passphrase text, length-bearing status, or path is displayed. */
  render(width: number): string[] {
    const prompt = "> ";
    const available = Math.max(1, width - prompt.length);
    const start = Math.max(
      0,
      Math.min(this.cursor - Math.floor(available / 2), this.value.length - available + 1),
    );
    const cursorInView = this.cursor - start;
    const visibleLength = Math.min(
      this.value.length - start,
      available - (this.cursor === this.value.length ? 1 : 0),
    );
    const mask = "*".repeat(Math.max(0, visibleLength));
    const beforeCursor = mask.slice(0, cursorInView);
    const atCursor = cursorInView < mask.length ? mask[cursorInView] : " ";
    const afterCursor = cursorInView < mask.length ? mask.slice(cursorInView + 1) : "";
    return [
      truncate(this.theme.fg("accent", this.theme.bold(titleWithoutPath(this.title))), width),
      truncate(`${prompt}${beforeCursor}\x1b[7m${atCursor}\x1b[27m${afterCursor}`, width),
      truncate(
        this.theme.fg(
          "dim",
          "Enter submit • Esc/Ctrl+C cancel • secret is not sent to chat history",
        ),
        width,
      ),
    ];
  }

  /** No-op required by Pi custom component lifecycle. */
  invalidate(): void {}

  /** Insert printable input as grapheme clusters so cursor movement does not split Unicode characters. */
  private insertText(text: string): void {
    const chars = graphemes(text);
    this.value.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
  }

  /** Delete one character before the cursor. */
  private deleteBackward(): void {
    if (this.cursor > 0) {
      this.value.splice(this.cursor - 1, 1);
      this.cursor--;
      this.tui.requestRender();
    }
  }

  /** Delete one character at the cursor. */
  private deleteForward(): void {
    if (this.cursor < this.value.length) {
      this.value.splice(this.cursor, 1);
      this.tui.requestRender();
    }
  }

  /** Move the cursor by a delta within the current secret buffer. */
  private moveCursor(delta: number): void {
    this.setCursor(this.cursor + delta);
  }

  /** Set the cursor position within the current secret buffer. */
  private setCursor(value: number): void {
    this.cursor = Math.max(0, Math.min(this.value.length, value));
    this.tui.requestRender();
  }

  /** Clear in-memory secret input before reporting cancellation. */
  private cancel(): void {
    this.value.fill("");
    this.value = [];
    this.cursor = 0;
    this.done(undefined);
  }
}

/** Split text into grapheme clusters for secret-input editing. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function")
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (segment) => segment.segment,
    );
  return Array.from(text);
}

/** Detect control characters that should not be inserted into the hidden prompt buffer. */
function hasControlChars(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

/** Truncate UI text defensively for narrow overlays. */
function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1));
}

/** Strip path separators from prompt titles so certificate paths do not appear in the overlay. */
function titleWithoutPath(title: string): string {
  return title.replace(/[\\/][^\s]*/g, "…");
}
