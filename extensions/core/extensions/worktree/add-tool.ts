import { execFile } from "node:child_process";
import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TSchema, Static } from "typebox";
import { Type } from "typebox";

import { readCoreWorktreeSettings } from "../../config/persistence.ts";
import {
  DEFAULT_MANAGED_ROOT,
  chooseSanitizedLabel,
  isUnderManagedRoot,
  repoNamespace,
  requireAbsoluteManagedRoot,
  reserveUniqueDirectory,
} from "./path-policy.ts";

/** Bounded timeout (ms) for the mutating `git worktree add` execution. */
const GIT_TIMEOUT_MS = 120_000;

/** Supported worktree creation modes; each has distinct required Git semantics. */
export const WORKTREE_MODES = ["existing_branch", "detached", "new_branch"] as const;

/**
 * Parameter schema for `add_git_worktree`. Each mode requires a distinct set of
 * fields (see the mode validation below); the destination is always chosen
 * under the configured managed root and is never model-supplied.
 */
export const addGitWorktreeSchema = Type.Object({
  mode: StringEnum(WORKTREE_MODES, {
    description:
      "Creation mode: existing_branch (checkout an existing local branch), detached (detached HEAD at a ref), or new_branch (create a branch from a start point).",
  }),
  branch: Type.Optional(
    Type.String({ description: "existing_branch mode: name of an existing local branch." }),
  ),
  ref: Type.Optional(
    Type.String({ description: "detached mode: commit-ish to check out with a detached HEAD." }),
  ),
  branchName: Type.Optional(
    Type.String({ description: "new_branch mode: name of the new branch to create." }),
  ),
  startPoint: Type.Optional(
    Type.String({ description: "new_branch mode: commit-ish the new branch starts from." }),
  ),
  label: Type.Optional(
    Type.String({ description: "Optional label for the managed worktree directory name." }),
  ),
  repoPath: Type.Optional(
    Type.String({
      description:
        "Optional path inside the source repository; resolved through Git. Defaults to the session cwd.",
    }),
  ),
}) satisfies TSchema;

export type AddGitWorktreeInput = Static<typeof addGitWorktreeSchema>;

/** Structured tool error carrying a concise, model-readable message. */
class WorktreeToolError extends Error {}

/**
 * Register `add_git_worktree`, the model-callable primitive that creates a Git
 * worktree under a managed root in a predictable location.
 *
 * Permission note: custom mutating tools are gated coarsely. `add_git_worktree`
 * resolves to `kind: "other"` in `permissions/enforcement.ts`, which defaults to
 * ask in safe/trusted and can only be allowed/denied wholesale by tool name —
 * there is no path/arg-aware gating, and audit text does not reflect the internal
 * `git` execution or the destination path.
 */
export function registerAddGitWorktree(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "add_git_worktree",
    label: "Add Git Worktree",
    description:
      "Create a Git worktree under a managed root for an existing local branch, a detached ref, or a new branch. Mutates the filesystem.",
    promptSnippet:
      "Create a Git worktree in a managed location instead of running ad-hoc `git worktree add`.",
    promptGuidelines: [
      "Use add_git_worktree to create worktrees in a predictable managed location rather than `bash git worktree add`.",
      "Pick mode existing_branch, detached, or new_branch and supply only that mode's fields.",
      "The destination directory is always chosen under the configured managed root; you cannot set an arbitrary path.",
    ],
    parameters: addGitWorktreeSchema as TSchema,
    async execute(_toolCallId, params: AddGitWorktreeInput, signal, _onUpdate, ctx) {
      try {
        const result = await createManagedWorktree(params, ctx.cwd, signal);
        return {
          content: [{ type: "text", text: formatSuccess(result) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}

/** Concise success result returned to the model and recorded as tool details. */
interface CreatedWorktree {
  destination: string;
  repoRoot: string;
  mode: (typeof WORKTREE_MODES)[number];
  branch?: string;
  ref?: string;
}

/**
 * Core creation flow: resolve the source repo, compute the managed destination,
 * validate mode fields and branch/ref input, reserve the destination, and run
 * the mutating Git command with cancellation/timeout support.
 */
async function createManagedWorktree(
  params: AddGitWorktreeInput,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<CreatedWorktree> {
  const repoRoot = await resolveGitTopLevel(params.repoPath ?? cwd, signal);
  if (!repoRoot) {
    throw new WorktreeToolError(
      `Not a Git repository: ${resolve(params.repoPath ?? cwd)}. add_git_worktree requires a Git source repository.`,
    );
  }

  const settings = await readCoreWorktreeSettings(cwd);
  const managedRoot = requireAbsoluteManagedRoot(settings?.root ?? DEFAULT_MANAGED_ROOT);
  if (isUnderManagedRoot(managedRoot, repoRoot)) {
    throw new WorktreeToolError(
      `Configured worktrees.root (${managedRoot}) is inside the source repository (${repoRoot}); choose a root outside the repository.`,
    );
  }

  validateModeFields(params);
  await validateBranchOrRef(repoRoot, params, signal);

  const base = resolve(managedRoot, repoNamespace(repoRoot));
  const label = chooseSanitizedLabel(params.label, fallbackLabelInput(params));
  const destination = await reserveUniqueDirectory(base, label);
  if (!isUnderManagedRoot(destination, base)) {
    await cleanupReservation(destination);
    throw new WorktreeToolError(`Reserved destination escaped the managed root: ${destination}`);
  }

  const args = buildGitWorktreeAddArgs(repoRoot, destination, params);
  try {
    await runGit(args, signal);
  } catch (error) {
    await cleanupReservation(destination);
    throw error;
  }

  return {
    destination,
    repoRoot,
    mode: params.mode,
    ...(params.mode === "detached" ? { ref: params.ref } : {}),
    ...(params.mode === "existing_branch" ? { branch: params.branch } : {}),
    ...(params.mode === "new_branch" ? { branch: params.branchName } : {}),
  };
}

/** Validate that exactly the fields for the chosen mode are present. */
function validateModeFields(params: AddGitWorktreeInput): void {
  const present = (value: string | undefined): boolean =>
    value !== undefined && value.trim() !== "";
  const require = (field: string, value: string | undefined): void => {
    if (!present(value)) throw new WorktreeToolError(`${params.mode} mode requires "${field}".`);
  };
  const forbid = (field: string, value: string | undefined): void => {
    if (present(value)) {
      throw new WorktreeToolError(`${params.mode} mode must not set "${field}".`);
    }
  };

  if (params.mode === "existing_branch") {
    require("branch", params.branch);
    forbid("ref", params.ref);
    forbid("branchName", params.branchName);
    forbid("startPoint", params.startPoint);
  } else if (params.mode === "detached") {
    require("ref", params.ref);
    forbid("branch", params.branch);
    forbid("branchName", params.branchName);
    forbid("startPoint", params.startPoint);
  } else {
    require("branchName", params.branchName);
    require("startPoint", params.startPoint);
    forbid("branch", params.branch);
    forbid("ref", params.ref);
  }
}

/** Validate that the branch/ref input is usable before mutating the filesystem. */
async function validateBranchOrRef(
  repoRoot: string,
  params: AddGitWorktreeInput,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (params.mode === "existing_branch") {
    const branch = params.branch as string;
    if (!(await refExists(repoRoot, `refs/heads/${branch}`, signal))) {
      throw new WorktreeToolError(`Local branch "${branch}" does not exist.`);
    }
    return;
  }
  if (params.mode === "detached") {
    const ref = params.ref as string;
    if (!(await commitishExists(repoRoot, ref, signal))) {
      throw new WorktreeToolError(`Ref "${ref}" could not be resolved to a commit.`);
    }
    return;
  }
  const branchName = params.branchName as string;
  const startPoint = params.startPoint as string;
  if (!(await validBranchName(repoRoot, branchName, signal))) {
    throw new WorktreeToolError(`Invalid new branch name: "${branchName}".`);
  }
  if (!(await commitishExists(repoRoot, startPoint, signal))) {
    throw new WorktreeToolError(`Start point "${startPoint}" could not be resolved to a commit.`);
  }
}

/** Build the `git worktree add` argument list for the requested mode. */
function buildGitWorktreeAddArgs(
  repoRoot: string,
  destination: string,
  params: AddGitWorktreeInput,
): string[] {
  const base = ["-C", repoRoot, "worktree", "add"];
  if (params.mode === "existing_branch") {
    return [...base, destination, params.branch as string];
  }
  if (params.mode === "detached") {
    return [...base, "--detach", destination, params.ref as string];
  }
  return [...base, "-b", params.branchName as string, destination, params.startPoint as string];
}

/** Choose the deterministic fallback label input from mode-specific fields. */
function fallbackLabelInput(params: AddGitWorktreeInput): string | undefined {
  if (params.mode === "existing_branch") return params.branch;
  if (params.mode === "detached") return params.ref;
  return params.branchName;
}

/** Result of a completed Git invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the child-process environment for Git, stripping repository-scoping
 * `GIT_*` variables. These (set by an outer Git hook, for example) would
 * otherwise override the explicit `-C <repoRoot>` target and point Git at the
 * wrong repository/index.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const {
    GIT_ALTERNATE_OBJECT_DIRECTORIES,
    GIT_COMMON_DIR,
    GIT_DIR,
    GIT_INDEX_FILE,
    GIT_NAMESPACE,
    GIT_OBJECT_DIRECTORY,
    GIT_WORK_TREE,
    ...env
  } = process.env;
  return env;
}

/**
 * Run Git as a cancellable child process with a bounded timeout. Resolves with
 * the exit code and captured output; never rejects on a non-zero exit. Rejects
 * only on cancellation, timeout, or spawn failure.
 */
function execGit(args: string[], signal: AbortSignal | undefined): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new WorktreeToolError("add_git_worktree cancelled."));
      return;
    }
    execFile(
      "git",
      args,
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err && err.name === "AbortError") {
          reject(new WorktreeToolError("add_git_worktree cancelled."));
          return;
        }
        if (err && err.killed) {
          reject(new WorktreeToolError(`git timed out after ${GIT_TIMEOUT_MS}ms.`));
          return;
        }
        if (err && typeof err.code !== "number") {
          reject(new WorktreeToolError(`failed to run git: ${err.message}`));
          return;
        }
        resolvePromise({
          code: typeof err?.code === "number" ? err.code : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

/** Run a mutating Git command, raising a tool error with stderr on failure. */
async function runGit(args: string[], signal: AbortSignal | undefined): Promise<void> {
  const result = await execGit(args, signal);
  if (result.code !== 0) {
    throw new WorktreeToolError(
      `git worktree add failed: ${result.stderr.trim() || "unknown error"}`,
    );
  }
}

/** Resolve the Git top-level directory for a path, or null when not a repo. */
async function resolveGitTopLevel(
  dir: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    const result = await execGit(
      ["-C", resolve(dir), "rev-parse", "--path-format=absolute", "--show-toplevel"],
      signal,
    );
    if (result.code !== 0) return null;
    const top = result.stdout.trim();
    return top ? resolve(top) : null;
  } catch {
    return null;
  }
}

/** Return whether a fully-qualified ref exists in the repository. */
async function refExists(
  repoRoot: string,
  ref: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await execGit(
    ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}`],
    signal,
  );
  return result.code === 0;
}

/** Return whether a ref resolves to a commit object. */
async function commitishExists(
  repoRoot: string,
  ref: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await execGit(
    ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    signal,
  );
  return result.code === 0;
}

/** Return whether a string is a valid new branch name per Git's own rules. */
async function validBranchName(
  repoRoot: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await execGit(["-C", repoRoot, "check-ref-format", "--branch", name], signal);
  return result.code === 0;
}

/** Remove an empty reservation directory, ignoring failures (best-effort cleanup). */
async function cleanupReservation(destination: string): Promise<void> {
  try {
    await rmdir(destination);
  } catch {
    // Git may have populated the directory, or another process removed it; ignore.
  }
}

/** Format a concise human/model-readable success message. */
function formatSuccess(result: CreatedWorktree): string {
  const target =
    result.mode === "detached" ? `detached at ${result.ref}` : `branch ${result.branch}`;
  return `Created worktree (${target}) at ${result.destination}`;
}

/** Expose internal flow for focused integration tests. */
export const __addWorktreeForTest = {
  createManagedWorktree,
  buildGitWorktreeAddArgs,
  validateModeFields,
} satisfies Record<string, unknown>;
