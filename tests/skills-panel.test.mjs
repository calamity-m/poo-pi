import assert from "node:assert/strict";
import test from "node:test";

import { SkillsPanel } from "../extensions/core/extensions/skills/panel.ts";

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function buildSkill(index) {
  return {
    name: `skill-${String(index).padStart(2, "0")}`,
    description: `Skill ${index}`,
    path: `/tmp/skill-${index}/SKILL.md`,
    scope: "project",
    status: "on",
    tokens: index,
    stats: { userUsed: 0, agentLoaded: 0, paths: [] },
  };
}

function visibleLines(panel) {
  return panel.render(100).join("\n");
}

test("/skills keeps the scope heading visible when returning to the top of a scrolled group", () => {
  const panel = new SkillsPanel(
    Array.from({ length: 30 }, (_value, index) => buildSkill(index)),
    { requestRender: () => {} },
    theme,
    () => {},
  );

  for (let index = 0; index < 25; index++) panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[H");

  assert.match(visibleLines(panel), /PROJECT SKILLS/);
});
