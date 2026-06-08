import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Session reasons that count as a "brand new" session: a cold launch and an
 * explicit `/new`. Resumes, forks, and reloads keep Pi's built-in header.
 */
const NEW_SESSION_REASONS: ReadonlySet<SessionStartEvent["reason"]> = new Set(["startup", "new"]);

/** Word rendered as the block-letter banner. Every char must exist in {@link FONT}. */
const TITLE = "POO-PI";

/** Package version read once from the bundled package.json (`?` if unavailable). */
const VERSION = readVersion();

/**
 * 5-row "ANSI Shadow"-style glyphs. Each glyph's rows are padded to a constant
 * width so rows can be concatenated column-aligned across letters.
 */
const FONT: Record<string, readonly string[]> = {
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "╚═╝     "],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  I: ["██╗", "██║", "██║", "██║", "╚═╝"],
  "-": ["       ", "       ", "██████╗", "╚═════╝", "       "],
};

/** Number of rows every glyph in {@link FONT} spans. */
const GLYPH_HEIGHT = 5;

/**
 * Register the core startup header. On a brand new session it replaces Pi's
 * built-in header with a centered block-letter banner plus a tagline box; on
 * resume/fork/reload it leaves the default header untouched.
 */
export function registerCoreHeader(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (!NEW_SESSION_REASONS.has(event.reason)) return;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const banner = renderWord(TITLE).map((line) =>
          theme.bold(theme.fg("accent", center(line, width))),
        );
        const blurb = [
          `poo-pi v${VERSION}`,
          `model: ${ctx.model?.id ?? "none"}`,
          "/help  list available commands",
        ];
        const box = renderBox(blurb, bannerWidth(TITLE)).map((line) =>
          theme.fg("muted", center(line, width)),
        );
        return [...banner, "", ...box];
      },
    }));
  });
}

/** Assemble a word into block-letter rows by joining each glyph's rows with a gap. */
function renderWord(word: string): string[] {
  const glyphs = [...word].map((char) => FONT[char] ?? FONT["-"]);
  return Array.from({ length: GLYPH_HEIGHT }, (_, row) =>
    glyphs.map((glyph) => glyph[row]).join(" "),
  );
}

/** Visible width of the rendered banner for `word` (rows are uniform width). */
function bannerWidth(word: string): number {
  return visibleWidth(renderWord(word)[0]);
}

/** Draw a bordered box of total width `width` containing one row per line. */
function renderBox(lines: string[], width: number): string[] {
  const inner = width - 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const body = lines.map((text) => `│${`  ${text}`.padEnd(inner).slice(0, inner)}│`);
  return [top, ...body, bottom];
}

/** Read the package version from the bundled package.json, three levels up from this module. */
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

/** Left-pad a line with spaces so its visible content sits centered in `width`. */
function center(line: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return " ".repeat(pad) + line;
}
