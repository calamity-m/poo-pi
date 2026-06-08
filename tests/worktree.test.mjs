import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __worktreeForTest,
  clearLinkedWorktreeCache,
  resolveLinkedWorktree,
} from "../extensions/core/lib/worktree.ts";
import { __worktreeCommandForTest } from "../extensions/core/extensions/worktree/command.ts";
import { __worktreeContextForTest } from "../extensions/core/extensions/worktree/context.ts";

const { isUnderWorktreesDir } = __worktreeForTest;
const { parseWorktreeList, formatWorktreeList } = __worktreeCommandForTest;
const { appendSystemPromptNote, formatWorktreePromptNote } = __worktreeContextForTest;

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
