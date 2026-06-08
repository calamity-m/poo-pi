import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  __worktreeForTest,
  clearLinkedWorktreeCache,
  resolveLinkedWorktree,
} from "../extensions/core/lib/worktree.ts";
import { __worktreeCommandForTest } from "../extensions/core/extensions/worktree/command.ts";
import { __worktreeContextForTest } from "../extensions/core/extensions/worktree/context.ts";
import { __worktreePolicyForTest } from "../extensions/core/extensions/worktree/path-policy.ts";
import { __addWorktreeForTest } from "../extensions/core/extensions/worktree/add-tool.ts";

const { isUnderWorktreesDir } = __worktreeForTest;
const { parseWorktreeList, formatWorktreeList } = __worktreeCommandForTest;
const { appendSystemPromptNote, formatWorktreePromptNote } = __worktreeContextForTest;
const {
  expandHome,
  requireAbsoluteManagedRoot,
  sanitizeLabel,
  shortHash,
  repoNamespace,
  chooseSanitizedLabel,
  isUnderManagedRoot,
  reserveUniqueDirectory,
} = __worktreePolicyForTest;
const { createManagedWorktree, validateModeFields } = __addWorktreeForTest;

function tmp() {
  return mkdtempSync(join(tmpdir(), "poo-pi-worktree-"));
}

function git(cwd, args) {
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
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "pi@example.test"]);
  git(dir, ["config", "user.name", "Pi Test"]);
  writeFileSync(join(dir, "README.md"), "test\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
}

test("resolveLinkedWorktree returns null outside Git and in the main checkout", () => {
  const dir = tmp();
  try {
    clearLinkedWorktreeCache();
    assert.equal(resolveLinkedWorktree(dir), null);
    initRepo(dir);
    clearLinkedWorktreeCache();
    assert.equal(resolveLinkedWorktree(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveLinkedWorktree detects linked worktrees with label, root, and branch", () => {
  const dir = tmp();
  const linked = join(tmp(), "feature-copy");
  try {
    initRepo(dir);
    git(dir, ["worktree", "add", "-b", "feature", linked]);
    clearLinkedWorktreeCache();

    const info = resolveLinkedWorktree(linked);
    assert.equal(info?.label, "feature-copy");
    assert.equal(info?.root, linked);
    assert.equal(info?.cwd, linked);
    assert.equal(info?.branch, "feature");
    assert.ok(info?.gitDir.includes(`${info.commonGitDir}/worktrees/`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("resolveLinkedWorktree normalizes detached HEAD to the short commit SHA", () => {
  const dir = tmp();
  const linked = join(tmp(), "detached-copy");
  try {
    initRepo(dir);
    const head = git(dir, ["rev-parse", "--short", "HEAD"]);
    git(dir, ["worktree", "add", "--detach", linked, "HEAD"]);
    clearLinkedWorktreeCache();

    assert.equal(resolveLinkedWorktree(linked)?.branch, head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("resolveLinkedWorktree does not misclassify submodules or bare repositories", () => {
  const sub = tmp();
  const superRepo = tmp();
  const bare = tmp();
  try {
    initRepo(sub);
    initRepo(superRepo);
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "nested"]);
    git(superRepo, ["commit", "-m", "add submodule"]);
    git(bare, ["init", "--bare"]);
    clearLinkedWorktreeCache();

    assert.equal(resolveLinkedWorktree(join(superRepo, "nested")), null);
    assert.equal(resolveLinkedWorktree(bare), null);
  } finally {
    rmSync(sub, { recursive: true, force: true });
    rmSync(superRepo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("isUnderWorktreesDir only accepts paths below the common worktrees directory", () => {
  assert.equal(isUnderWorktreesDir("/repo/.git/worktrees/wt", "/repo/.git"), true);
  assert.equal(isUnderWorktreesDir("/repo/.git/modules/sub", "/repo/.git"), false);
  assert.equal(isUnderWorktreesDir("/repo/other", "/repo/.git"), false);
});

test("parseWorktreeList handles a single-checkout repository", () => {
  const entries = parseWorktreeList(
    ["worktree /repo/main", "HEAD abcdef1234567890", "branch refs/heads/main", ""].join("\n"),
    "/repo/main",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].current, true);
  assert.equal(entries.filter((entry) => !entry.current && !entry.bare).length, 0);
});

test("parseWorktreeList marks the current worktree and formats entries", () => {
  const output = [
    "worktree /repo/main",
    "HEAD abcdef1234567890",
    "branch refs/heads/main",
    "",
    "worktree /repo-linked/feature",
    "HEAD 123456abcdef",
    "branch refs/heads/feature",
    "",
  ].join("\n");

  const entries = parseWorktreeList(output, "/repo/main");
  assert.deepEqual(
    entries.map((entry) => ({ label: entry.label, branch: entry.branch, current: entry.current })),
    [
      { label: "main", branch: "main", current: true },
      { label: "feature", branch: "feature", current: false },
    ],
  );
  assert.deepEqual(formatWorktreeList(entries), [
    "Git worktrees:",
    "* main [main] /repo/main",
    "  feature [feature] /repo-linked/feature",
  ]);
});

test("formatWorktreeList keeps absolute paths visible for duplicate labels", () => {
  const entries = parseWorktreeList(
    [
      "worktree /repo/main",
      "HEAD abcdef1234567890",
      "branch refs/heads/main",
      "",
      "worktree /tmp/a/dup",
      "HEAD 123456abcdef",
      "branch refs/heads/a",
      "",
      "worktree /tmp/b/dup",
      "HEAD fedcba654321",
      "branch refs/heads/b",
      "",
    ].join("\n"),
    "/repo/main",
  );

  assert.deepEqual(formatWorktreeList(entries).slice(2), [
    "  dup [a] /tmp/a/dup",
    "  dup [b] /tmp/b/dup",
  ]);
});

// ── Path policy helpers ─────────────────────────────────────────────────────

test("expandHome expands only a leading tilde", () => {
  assert.equal(expandHome("~"), homedir());
  assert.ok(expandHome("~/foo").endsWith(join("", "foo")));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("rel/~/x"), "rel/~/x");
});

test("requireAbsoluteManagedRoot rejects relative roots and resolves tilde", () => {
  assert.throws(() => requireAbsoluteManagedRoot("relative/dir"), /absolute/);
  assert.ok(requireAbsoluteManagedRoot("~/.pi/worktrees").startsWith("/"));
  assert.equal(requireAbsoluteManagedRoot("/managed/root"), "/managed/root");
});

test("sanitizeLabel keeps safe characters and falls back", () => {
  assert.equal(sanitizeLabel("feature/cool branch"), "feature-cool-branch");
  assert.equal(sanitizeLabel("../escape"), "escape");
  assert.equal(sanitizeLabel("  "), "worktree");
  assert.equal(sanitizeLabel("keep_dot.v1-2"), "keep_dot.v1-2");
});

test("shortHash is stable and 8 hex chars", () => {
  assert.match(shortHash("/repo"), /^[0-9a-f]{8}$/);
  assert.equal(shortHash("/repo"), shortHash("/repo"));
  assert.notEqual(shortHash("/repo/a"), shortHash("/repo/b"));
});

test("repoNamespace distinguishes same-basename repositories", () => {
  const a = repoNamespace("/tmp/alpha/project");
  const b = repoNamespace("/tmp/beta/project");
  assert.ok(a.startsWith("project-"));
  assert.ok(b.startsWith("project-"));
  assert.notEqual(a, b);
});

test("chooseSanitizedLabel prefers explicit then fallback then default", () => {
  assert.equal(chooseSanitizedLabel("My Label", "branch"), "My-Label");
  assert.equal(chooseSanitizedLabel(undefined, "feature/x"), "feature-x");
  assert.equal(chooseSanitizedLabel(undefined, undefined), "worktree");
});

test("isUnderManagedRoot uses full-segment containment", () => {
  assert.equal(isUnderManagedRoot("/root/a/b", "/root"), true);
  assert.equal(isUnderManagedRoot("/root", "/root"), true);
  assert.equal(isUnderManagedRoot("/root/../escape", "/root"), false);
  assert.equal(isUnderManagedRoot("/rootother", "/root"), false);
});

test("reserveUniqueDirectory creates parents and resolves collisions", async () => {
  const base = join(tmp(), "ns");
  try {
    const first = await reserveUniqueDirectory(base, "label");
    const second = await reserveUniqueDirectory(base, "label");
    assert.equal(first, join(base, "label"));
    assert.equal(second, join(base, "label-2"));
    assert.ok(existsSync(first));
    assert.ok(existsSync(second));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── validateModeFields ──────────────────────────────────────────────────────

test("validateModeFields enforces the mode field matrix", () => {
  assert.doesNotThrow(() => validateModeFields({ mode: "existing_branch", branch: "main" }));
  assert.doesNotThrow(() => validateModeFields({ mode: "detached", ref: "HEAD" }));
  assert.doesNotThrow(() =>
    validateModeFields({ mode: "new_branch", branchName: "n", startPoint: "main" }),
  );

  assert.throws(() => validateModeFields({ mode: "existing_branch" }), /requires "branch"/);
  assert.throws(
    () => validateModeFields({ mode: "existing_branch", branch: "b", ref: "x" }),
    /must not set "ref"/,
  );
  assert.throws(() => validateModeFields({ mode: "detached" }), /requires "ref"/);
  assert.throws(() => validateModeFields({ mode: "new_branch", branchName: "n" }), /startPoint/);
});

// ── add_git_worktree integration ────────────────────────────────────────────

function writeManagedRoot(repo, root) {
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(
    join(repo, ".pi", "core-settings.json"),
    JSON.stringify({ version: 1, worktrees: { root } }),
  );
}

function branchOf(dir) {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

test("createManagedWorktree creates an existing-branch worktree under the managed root", async () => {
  const repo = tmp();
  const root = tmp();
  try {
    initRepo(repo);
    git(repo, ["branch", "feature"]);
    writeManagedRoot(repo, root);

    const result = await createManagedWorktree(
      { mode: "existing_branch", branch: "feature" },
      repo,
      undefined,
    );
    assert.ok(isUnderManagedRoot(result.destination, root));
    assert.ok(result.destination.includes(`${basename(repo)}-`));
    assert.equal(result.branch, "feature");
    assert.equal(branchOf(result.destination), "feature");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createManagedWorktree creates a detached worktree", async () => {
  const repo = tmp();
  const root = tmp();
  try {
    initRepo(repo);
    writeManagedRoot(repo, root);

    const result = await createManagedWorktree(
      { mode: "detached", ref: "HEAD", label: "det" },
      repo,
      undefined,
    );
    assert.equal(result.mode, "detached");
    assert.ok(isUnderManagedRoot(result.destination, root));
    assert.equal(branchOf(result.destination), "HEAD");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createManagedWorktree creates a new branch from a start point", async () => {
  const repo = tmp();
  const root = tmp();
  try {
    initRepo(repo);
    writeManagedRoot(repo, root);

    const result = await createManagedWorktree(
      { mode: "new_branch", branchName: "fresh", startPoint: "main" },
      repo,
      undefined,
    );
    assert.equal(result.branch, "fresh");
    assert.equal(branchOf(result.destination), "fresh");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createManagedWorktree rejects a non-Git source", async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      createManagedWorktree({ mode: "detached", ref: "HEAD" }, dir, undefined),
      /Not a Git repository/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createManagedWorktree rejects a managed root inside the repository", async () => {
  const repo = tmp();
  try {
    initRepo(repo);
    writeManagedRoot(repo, join(repo, "wt"));
    await assert.rejects(
      createManagedWorktree({ mode: "detached", ref: "HEAD" }, repo, undefined),
      /inside the source repository/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createManagedWorktree rejects an unknown local branch", async () => {
  const repo = tmp();
  const root = tmp();
  try {
    initRepo(repo);
    writeManagedRoot(repo, root);
    await assert.rejects(
      createManagedWorktree({ mode: "existing_branch", branch: "ghost" }, repo, undefined),
      /does not exist/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createManagedWorktree rejects an invalid mode/field combination", async () => {
  const repo = tmp();
  const root = tmp();
  try {
    initRepo(repo);
    writeManagedRoot(repo, root);
    await assert.rejects(
      createManagedWorktree({ mode: "detached", ref: "HEAD", branch: "main" }, repo, undefined),
      /must not set "branch"/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatWorktreePromptNote and appendSystemPromptNote build concise prompt context", () => {
  const note = formatWorktreePromptNote({
    cwd: "/repo-linked/feature/src",
    root: "/repo-linked/feature",
    label: "feature",
    branch: "topic",
    gitDir: "/repo/.git/worktrees/feature",
    commonGitDir: "/repo/.git",
  });

  assert.equal(appendSystemPromptNote("Existing", note), `Existing\n\n${note}`);
  assert.ok(note.includes("Linked worktree: feature"));
  assert.ok(note.includes("Current Pi working directory: /repo-linked/feature/src"));
});
