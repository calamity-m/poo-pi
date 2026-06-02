import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const resources = {
  extensions: ["extensions/poo-pi.ts", "extensions/core/index.ts"],
  skills: ["skills/pi-package-maintainer/SKILL.md", "skills/surgical-refactor/SKILL.md"],
  prompts: ["prompts/review.md", "prompts/plan.md", "prompts/release-check.md"],
  themes: ["themes/poo-dark.json", "themes/poo-light.json"],
};

export default function pooPi(pi: ExtensionAPI) {
  pi.registerCommand("poo-pi", {
    description: "Show the resources provided by the poo-pi package",
    handler: async (_args, ctx) => {
      const lines = [
        "poo-pi package resources:",
        `- extensions: ${resources.extensions.join(", ")}`,
        `- skills: ${resources.skills.join(", ")}`,
        `- prompts: ${resources.prompts.join(", ")}`,
        `- themes: ${resources.themes.join(", ")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "poo_pi_package_info",
    label: "Poo Pi Package Info",
    description: "List the extensions, skills, prompts, and themes bundled with the poo-pi package.",
    promptSnippet: "List bundled poo-pi package resources when asked about this package.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(resources, null, 2),
          },
        ],
        details: resources,
      };
    },
  });

}
