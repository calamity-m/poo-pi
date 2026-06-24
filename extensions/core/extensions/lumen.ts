import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Executable used for Lumen invocations. */
const LUMEN_BIN = process.env.LUMEN_BIN ?? "lumen";

/** Whether to open Lumen automatically after agent turns with local changes. */
const AUTO_REVIEW = process.env.LUMEN_AUTO_REVIEW === "1";

/** Result captured from a suspended Lumen invocation. */
interface LumenRun {
  /** Lumen process status, or null when spawning failed. */
  status: number | null;
  /** Annotation text emitted by Lumen on stdout after the user submits it. */
  output: string;
  /** Spawn error text, when Lumen could not be started. */
  error: string | null;
}

/** Runtime operations used by the review flow, injectable for focused tests. */
interface LumenReviewDeps {
  /** Clear the terminal after Pi releases control. */
  clearTerminal(): void;
  /** Return whether terminal handoff is available. */
  isInteractive(): boolean;
  /** Return whether Lumen has a diff worth opening. */
  hasUncommittedChanges(cwd: string): boolean;
  /** Run Lumen and return any submitted annotation output. */
  runLumenDiff(cwd: string, args: string[]): LumenRun;
}

/** Return true when the current Git worktree has staged, unstaged, or untracked changes. */
function hasUncommittedChanges(cwd: string): boolean {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

/** Parse `/lumen` arguments while allowing `/lumen diff` as the natural spelling. */
function parseLumenDiffArgs(args: string): string[] {
  const argv = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  return argv[0] === "diff" ? argv.slice(1) : argv;
}

/** Run `lumen diff` while capturing submitted annotations from stdout. */
function runLumenDiff(cwd: string, args: string[]): LumenRun {
  const result = spawnSync(LUMEN_BIN, ["diff", ...args], {
    cwd,
    // Lumen routes its TUI to /dev/tty when stdout is captured, so stdout can
    // carry only the submitted annotation text back to Pi.
    stdio: ["inherit", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    return { status: null, output: "", error: result.error.message };
  }

  return { status: result.status, output: (result.stdout ?? "").trim(), error: null };
}

/** Runtime operations used by default Lumen review commands. */
const defaultLumenReviewDeps: LumenReviewDeps = {
  clearTerminal: () => process.stdout.write("\x1b[2J\x1b[H"),
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  hasUncommittedChanges,
  runLumenDiff,
};

/** Suspend Pi's TUI, run Lumen, and inject submitted annotations as user input. */
async function reviewAndInject(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string[],
  options: { silentOnClean: boolean },
  deps: LumenReviewDeps = defaultLumenReviewDeps,
): Promise<void> {
  if (!ctx.hasUI || !deps.isInteractive()) {
    ctx.ui.notify("lumen diff requires interactive Pi TUI mode", "warning");
    return;
  }

  if (!deps.hasUncommittedChanges(ctx.cwd)) {
    if (!options.silentOnClean) {
      ctx.ui.notify("lumen: no uncommitted changes to review", "info");
    }
    return;
  }

  const result = await ctx.ui.custom<LumenRun>((tui, _theme, _keybindings, done) => {
    tui.stop();
    deps.clearTerminal();

    const run = deps.runLumenDiff(ctx.cwd, args);

    tui.start();
    tui.requestRender(true);
    done(run);

    return { render: () => [], invalidate: () => {} };
  });

  if (result.error) {
    ctx.ui.notify(`lumen: ${result.error}`, "error");
    return;
  }

  if (result.status !== 0) {
    ctx.ui.notify(`lumen exited with status ${result.status}`, "warning");
    return;
  }

  if (!result.output) return;

  await pi.sendUserMessage(result.output, { deliverAs: "followUp" });
}

/** Register Lumen review commands and optional automatic post-turn review. */
export function registerLumen(pi: ExtensionAPI): void {
  if (AUTO_REVIEW) {
    pi.on("agent_end", async (_event, ctx) => {
      try {
        await reviewAndInject(pi, ctx, [], { silentOnClean: true });
      } catch (err) {
        ctx.ui.notify(
          `lumen review failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    });
  }

  pi.registerCommand("lumen", {
    description: "Open Lumen diff; submitted annotations get sent to the agent",
    handler: async (args, ctx) => {
      try {
        await reviewAndInject(pi, ctx, parseLumenDiffArgs(args), { silentOnClean: false });
      } catch (err) {
        ctx.ui.notify(
          `lumen review failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}

/** Test-only exports for Lumen command parsing and review control flow. */
export const __lumenForTest = { hasUncommittedChanges, parseLumenDiffArgs, reviewAndInject };
