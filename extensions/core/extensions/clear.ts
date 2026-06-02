import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register `/clear` as a minimal alias for Pi's `/new` session command. */
export function registerClear(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
