import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Default managed root used when `worktrees.root` is not configured. */
export const DEFAULT_MANAGED_ROOT = "~/.pi/worktrees";

/** Fallback label used when no usable label or branch/ref input is available. */
const FALLBACK_LABEL = "worktree";

/** Maximum collision-suffix attempts before reservation gives up. */
const MAX_RESERVATION_ATTEMPTS = 1000;

/**
 * Expand a leading `~` (or `~/...`) to the current user's home directory.
 * Only a leading tilde is expanded; embedded tildes are left untouched.
 */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Require an absolute managed-root path after home expansion, returning the
 * resolved absolute path. Throws when the expanded value is not absolute, since
 * a relative managed root would resolve unpredictably per process cwd.
 */
export function requireAbsoluteManagedRoot(input: string): string {
  const expanded = expandHome(input);
  if (!isAbsolute(expanded)) {
    throw new Error(`worktrees.root must resolve to an absolute path, got "${input}"`);
  }
  return resolve(expanded);
}

/**
 * Sanitize an arbitrary string into a filesystem-safe label segment.
 * Keeps alphanumerics, dot, underscore, and dash; collapses other runs to a
 * single dash; trims leading/trailing separators; falls back to `worktree`.
 */
export function sanitizeLabel(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : FALLBACK_LABEL;
}

/** Return a short, stable hex hash of the resolved Git top-level path. */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Build a readable, collision-resistant repository namespace directory name,
 * combining the sanitized basename with a stable short hash of the repo root.
 */
export function repoNamespace(repoRoot: string): string {
  const resolved = resolve(repoRoot);
  return `${sanitizeLabel(basename(resolved) || resolved)}-${shortHash(resolved)}`;
}

/**
 * Choose a sanitized label from an explicit label or mode-specific fallback
 * input (branch / branchName / ref), never escaping a single path segment.
 */
export function chooseSanitizedLabel(
  explicit: string | undefined,
  fallbackInput: string | undefined,
): string {
  const source = explicit?.trim() || fallbackInput?.trim() || FALLBACK_LABEL;
  return sanitizeLabel(source);
}

/**
 * Return true only when `candidate` resolves to `root` itself or a descendant,
 * using full path-segment containment (not a string prefix). Mirrors the
 * `isUnderWorktreesDir` helper in `lib/worktree.ts`.
 */
export function isUnderManagedRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  return !rel.startsWith("..") && !rel.split(sep).includes("..");
}

/**
 * Atomically reserve a unique destination directory under `baseDir`.
 *
 * Missing parents are created first (recursive). The final leaf is then
 * reserved with a non-recursive `mkdir`, which fails with `EEXIST` when the
 * directory already exists; on conflict a numeric suffix is appended and the
 * attempt retried. The non-recursive `mkdir` is the lock: `recursive: true`
 * would not surface `EEXIST` and could not provide race protection.
 *
 * @returns the absolute reserved destination path (an empty directory).
 */
export async function reserveUniqueDirectory(baseDir: string, label: string): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt++) {
    const candidateLabel = attempt === 0 ? label : `${label}-${attempt + 1}`;
    const candidate = join(baseDir, candidateLabel);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not reserve a unique worktree directory under ${baseDir}`);
}

/** Expose pure/internal helpers for focused tests. */
export const __worktreePolicyForTest = {
  expandHome,
  requireAbsoluteManagedRoot,
  sanitizeLabel,
  shortHash,
  repoNamespace,
  chooseSanitizedLabel,
  isUnderManagedRoot,
  reserveUniqueDirectory,
} satisfies Record<string, unknown>;
