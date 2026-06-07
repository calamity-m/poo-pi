import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildSkillIndex, normalizeSkillPath, toSkillRow } from "./discovery.ts";
import { SkillsPanel } from "./panel.ts";
import { readSkillStats, recordSkillUsage } from "./stats.ts";

/** Register skill browsing and usage tracking commands/events. */
export function registerSkills(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => {
    const match = event.text.match(/^\/skill:([^\s]+)(?:\s|$)/);
    if (!match) return;

    const skill = buildSkillIndex(pi, ctx.cwd).byName.get(match[1]);
    if (!skill) return;

    recordSkillUsage(skill.name, skill.path, "user");
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("read", event)) return;

    const path = normalizeSkillPath(event.input.path, ctx.cwd);
    const skill = buildSkillIndex(pi, ctx.cwd).byPath.get(path);
    if (!skill) return;

    recordSkillUsage(skill.name, skill.path, "agent");
  });

  pi.registerCommand("skills", {
    description: "Browse available skills by source",
    handler: async (_args, ctx) => {
      const stats = readSkillStats();
      const skills = pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => toSkillRow(command, stats));
      if (skills.length === 0) {
        ctx.ui.notify("No skills available", "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          skills.map((skill) => `${skill.name} (${skill.scope}, ${skill.status})`).join("\n"),
          "info",
        );
        return;
      }

      const command = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        return new SkillsPanel(skills, tui, theme, done);
      });

      if (command) {
        ctx.ui.setEditorText(command);
        ctx.ui.notify("Skill command loaded. Add instructions and submit when ready.", "info");
      }
    },
  });
}
