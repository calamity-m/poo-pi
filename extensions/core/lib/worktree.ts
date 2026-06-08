import { execFileSync } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";

/** Normalized metadata for a linked Git worktree detected from a cwd. */
export interface LinkedWorktreeInfo {
  /** Absolute cwd Pi used when resolving the worktree. */
  cwd: string;
  /** Absolute root path of the linked worktree checkout. */
  root: string;
  /** Compact deterministic label for footer/UI display. */
  label: string;
  /** Current branch name, or short commit SHA when HEAD is detached. */
  branch: string;
  /** Absolute per-worktree git directory. */
  gitDir: string;
  /** Absolute common git directory for the repository. */
  commonGitDir: string;
}

/** Options controlling cache behavior for linked-worktree resolution. */
export interface ResolveLinkedWorktreeOptions {
  /** Ignore any cached entry and re-run Git plumbing. */
  refresh?: boolean;
}

/** Cache entry stored per absolute cwd for the current extension process. */
type WorktreeCacheEntry = LinkedWorktreeInfo | null;

/** Session-scoped detection cache; callers invalidate it on known branch/cwd changes. */
const worktreeCache = new Map<string, WorktreeCacheEntry>();

/** Resolve linked-worktree metadata for a cwd, returning null outside linked worktrees. */
export function resolveLinkedWorktree(
  cwd: string,
  options: ResolveLinkedWorktreeOptions = {},
): LinkedWorktreeInfo | null {
  const key = resolve(cwd);
  if (!options.refresh && worktreeCache.has(key)) return worktreeCache.get(key) ?? null;
  const value = detectLinkedWorktree(key);
  worktreeCache.set(key, value);
  return value;
}

/** Clear cached worktree metadata, either for one cwd or for all known cwd entries. */
export function clearLinkedWorktreeCache(cwd?: string): void {
  if (cwd === undefined) {
    worktreeCache.clear();
    return;
  }
  worktreeCache.delete(resolve(cwd));
}

/** Run the Git plumbing needed to classify a cwd as a linked worktree. */
function detectLinkedWorktree(cwd: string): LinkedWorktreeInfo | null {
  const paths = gitLines(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (!paths || paths.length < 3) return null;

  const [rootRaw, gitDirRaw, commonGitDirRaw] = paths;
  const root = resolve(rootRaw);
  const gitDir = resolve(gitDirRaw);
  const commonGitDir = resolve(commonGitDirRaw);
  if (gitDir === commonGitDir) return null;
  if (!isUnderWorktreesDir(gitDir, commonGitDir)) return null;

  const branch = resolveBranch(cwd);
  if (!branch) return null;

  return {
    cwd,
    root,
    label: basename(root) || root,
    branch,
    gitDir,
    commonGitDir,
  };
}

/** Return true only for Git's linked-worktree administrative directories. */
function isUnderWorktreesDir(gitDir: string, commonGitDir: string): boolean {
  const rel = relative(resolve(commonGitDir, "worktrees"), gitDir);
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..");
}

/** Resolve the current branch, normalizing detached HEAD to a short commit SHA. */
function resolveBranch(cwd: string): string | null {
  const branch = gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  if (branch !== "HEAD") return branch;
  return gitText(cwd, ["rev-parse", "--short", "HEAD"]);
}

/** Run a Git command and return trimmed stdout lines, swallowing expected failures. */
function gitLines(cwd: string, args: string[]): string[] | null {
  const text = gitText(cwd, args);
  return text === null ? null : text.split(/\r?\n/).filter((line) => line.length > 0);
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

/** Expose pure/internal helpers for focused tests. */
export const __worktreeForTest = {
  isUnderWorktreesDir,
} satisfies Record<string, unknown>;
