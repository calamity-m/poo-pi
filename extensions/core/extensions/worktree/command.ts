import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readCoreWorktreeSettings } from "../../config/persistence.ts";
import {
  DEFAULT_MANAGED_ROOT,
  isUnderManagedRoot,
  requireAbsoluteManagedRoot,
} from "./path-policy.ts";

/** Parsed row from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  /** Absolute worktree path. */
  path: string;
  /** Current HEAD commit SHA if reported by Git. */
  head?: string;
  /** Current branch ref name if attached. */
  branch?: string;
  /** Whether Git marks the worktree as bare. */
  bare: boolean;
  /** Whether this entry matches the command cwd's top-level checkout path. */
  current: boolean;
  /** Whether this entry lives under the configured managed worktree root. */
  managed: boolean;
  /** Compact deterministic display label. */
  label: string;
}

/** Register `/worktree`, a list-only Git worktree command. */
export function registerWorktree(pi: ExtensionAPI): void {
  pi.registerCommand("worktree", {
    description: "List linked Git worktrees for the current repository",
    handler: async (_args, ctx) => {
      await handleWorktreeCommand(ctx);
    },
  });
}

/** List repository worktrees and display them to the user. */
async function handleWorktreeCommand(ctx: ExtensionCommandContext): Promise<void> {
  const output = gitText(ctx.cwd, ["worktree", "list", "--porcelain"]);
  if (output === null) {
    notify(ctx, "Not in a Git repository.", "warning");
    return;
  }

  const currentRoot = gitText(ctx.cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const managedRoot = await resolveManagedRoot(ctx.cwd);
  const entries = parseWorktreeList(output, currentRoot ?? undefined, managedRoot);
  const linked = entries.filter((entry) => !entry.current && !entry.bare);
  if (linked.length === 0) {
    notify(ctx, "No linked Git worktrees found for this repository.", "info");
    return;
  }

  notify(ctx, formatWorktreeList(entries).join("\n"), "info");
}

/**
 * Resolve the configured managed worktree root to an absolute path for marking,
 * returning undefined when the configured value is unusable (no marking).
 */
async function resolveManagedRoot(cwd: string): Promise<string | undefined> {
  try {
    const settings = await readCoreWorktreeSettings(cwd);
    return requireAbsoluteManagedRoot(settings?.root ?? DEFAULT_MANAGED_ROOT);
  } catch {
    return undefined;
  }
}

/** Parse porcelain worktree-list output into display entries. */
function parseWorktreeList(
  output: string,
  currentRoot?: string,
  managedRoot?: string,
): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> | undefined;

  const push = () => {
    if (!current?.path) return;
    const path = resolve(current.path);
    entries.push({
      path,
      head: current.head,
      branch: current.branch,
      bare: current.bare ?? false,
      current: currentRoot ? path === resolve(currentRoot) : false,
      managed: managedRoot ? isUnderManagedRoot(path, managedRoot) : false,
      label: basename(path) || path,
    });
  };

  for (const line of output.split(/\r?\n/)) {
    if (line === "") {
      push();
      current = undefined;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      push();
      current = { path: value, bare: false, current: false, label: "" };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "bare") {
      current.bare = true;
    }
  }
  push();
  return entries;
}

/** Format worktree entries as a concise command result. */
function formatWorktreeList(entries: WorktreeListEntry[]): string[] {
  return [
    "Git worktrees:",
    ...entries.map((entry) => {
      const marker = entry.current ? "*" : " ";
      const branch = entry.branch ?? (entry.head ? entry.head.slice(0, 7) : "unknown");
      const bare = entry.bare ? " bare" : "";
      const managed = entry.managed ? " managed" : "";
      return `${marker} ${entry.label} [${branch}${bare}${managed}] ${entry.path}`;
    }),
  ];
}

/** Notify through the TUI when available, otherwise print to stdout. */
function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

/** Run a Git command and return trimmed stdout, swallowing expected failures. */
function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Expose pure helpers for focused unit tests. */
export const __worktreeCommandForTest = {
  parseWorktreeList,
  formatWorktreeList,
} satisfies Record<string, unknown>;
