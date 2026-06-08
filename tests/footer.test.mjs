import assert from "node:assert/strict";
import test from "node:test";

import { __footerForTest } from "../extensions/core/extensions/footer.ts";

const {
  renderFooter,
  renderPowerline,
  bgToFg,
  GLYPHS,
  POWERLINE,
  formatFooterContextUsage,
  permissionModeColors,
  subagentsSegment,
  contextPressureColors,
  CONTEXT_WARNING_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
} = __footerForTest;

/** Minimal truecolor theme stub mirroring the real Theme surface. */
const theme = {
  fg: (color, text) => `<fg:${color}>${text}\x1b[39m`,
  bg: (color, text) => `${bgAnsi(color)}${text}\x1b[49m`,
  bold: (text) => `*${text}*`,
  getBgAnsi: (color) => bgAnsi(color),
};

const BG = { red: "\x1b[48;2;1;0;0m", green: "\x1b[48;2;0;1;0m" };
function bgAnsi(color) {
  return BG[color] ?? "\x1b[48;2;9;9;9m";
}

test("bgToFg rewrites a background escape into a foreground escape", () => {
  assert.equal(bgToFg("\x1b[48;2;1;2;3m"), "\x1b[38;2;1;2;3m");
  assert.equal(bgToFg("\x1b[49m"), "\x1b[39m");
});

test("renderPowerline blends dividers between adjacent segment backgrounds", () => {
  const out = renderPowerline(theme, [
    { glyph: "A", label: "a", value: "1", fg: "accent", bg: "red" },
    { glyph: "B", label: "b", value: "2", fg: "accent", bg: "green" },
  ]);

  // Opening cap is the first segment's bg color used as a foreground.
  assert.ok(out.startsWith(`${bgToFg(BG.red)}${POWERLINE.capLeft}`));
  // Interior divider: previous bg as fg, next bg as bg.
  assert.ok(out.includes(`${bgToFg(BG.red)}${BG.green}${POWERLINE.divider}`));
  // Trailing divider falls back to the default terminal background.
  assert.ok(out.includes(`${bgToFg(BG.green)}\x1b[49m${POWERLINE.divider}`));
});

test("renderFooter keeps literal text outside the powerline run", () => {
  const segments = {
    model: [{ glyph: GLYPHS.model, label: "model", value: "x", fg: "success", bg: "green" }],
  };
  const out = renderFooter(" │ {model}", segments, theme);
  assert.ok(out.startsWith(" │ "));
  assert.ok(out.includes(GLYPHS.model));
});

test("renderFooter ignores unknown tokens by emitting them verbatim", () => {
  const out = renderFooter("{nope}", {}, theme);
  assert.equal(out, "{nope}");
});

test("formatFooterContextUsage shows compact tokens and percent", () => {
  assert.equal(
    formatFooterContextUsage({ tokens: 50_000, contextWindow: 1_000_000, percent: 5 }, undefined),
    "50k/1.0M 5%",
  );
});

test("formatFooterContextUsage falls back to the model window when usage is unavailable", () => {
  assert.equal(formatFooterContextUsage(undefined, 128_000), "?/128k ?");
});

test("permissionModeColors maps every mode to explicit severity colors", () => {
  assert.deepEqual(permissionModeColors("safe"), { fg: "success", bg: "toolSuccessBg" });
  assert.deepEqual(permissionModeColors("trusted"), { fg: "accent", bg: "selectedBg" });
  assert.deepEqual(permissionModeColors("permissive"), { fg: "warning", bg: "toolPendingBg" });
  assert.deepEqual(permissionModeColors("open"), { fg: "error", bg: "toolErrorBg" });
});

test("subagentsSegment is quiet when idle and visible when active", () => {
  assert.deepEqual(subagentsSegment(undefined), {
    glyph: GLYPHS.subagents,
    label: "subagents",
    value: "idle",
    fg: "muted",
    bg: "customMessageBg",
  });
  assert.deepEqual(subagentsSegment("subagents:writing tests"), {
    glyph: GLYPHS.subagents,
    label: "subagents",
    value: "writing tests",
    fg: "mdLink",
    bg: "toolPendingBg",
  });
});

test("contextPressureColors covers unknown, healthy, warning, and critical pressure", () => {
  assert.deepEqual(contextPressureColors(null), { fg: "warning", bg: "toolPendingBg" });
  assert.deepEqual(contextPressureColors(CONTEXT_WARNING_PERCENT - 1), {
    fg: "success",
    bg: "toolSuccessBg",
  });
  assert.deepEqual(contextPressureColors(CONTEXT_WARNING_PERCENT), {
    fg: "warning",
    bg: "toolPendingBg",
  });
  assert.deepEqual(contextPressureColors(CONTEXT_CRITICAL_PERCENT), {
    fg: "error",
    bg: "toolErrorBg",
  });
});
