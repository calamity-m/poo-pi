# Worktrees

When Pi starts inside a linked Git worktree, the core footer adds a `wt:<label>` segment before the branch segment and each agent run receives a short system-prompt note with the worktree label, branch, root, and current Pi cwd. Ordinary repositories and non-Git directories keep the existing footer and prompt behavior. Custom footer templates configured through `/core-settings` must include `{worktree}` to display the linked-worktree label.

## Listing worktrees

Run `/worktree` to list linked worktrees for the **current repository**; it is list-only and does not move the session cwd. Entries that live under the configured managed root are tagged with a `managed` marker, and absolute paths stay visible so duplicate labels remain distinguishable.

## Creating worktrees

The `add_git_worktree` tool creates a Git worktree under a managed root in a predictable location, instead of relying on ad-hoc `git worktree add` commands that land in inconsistent directories. The tool mutates the filesystem.

### Managed root

Worktrees are created under `<root>/<repo-namespace>/<label>`:

- `<root>` defaults to `~/.pi/worktrees` and is configurable per-project (see below).
- `<repo-namespace>` combines the sanitized repository basename with a short stable hash of the resolved Git top-level path (for example `poo-pi-a1b2c3d4`), so unrelated repositories with the same basename never collide.
- `<label>` is derived from the optional `label` argument or the branch/ref input, sanitized to a single safe path segment; collisions get a numeric suffix.

The destination is always chosen under the managed root — callers cannot supply an arbitrary destination path.

### Modes

The tool requires an explicit `mode`. Supply only that mode's fields:

| Mode              | Required fields            | Git shape                                                      |
| ----------------- | -------------------------- | -------------------------------------------------------------- |
| `existing_branch` | `branch`                   | `git worktree add <managed-path> <branch>`                     |
| `detached`        | `ref`                      | `git worktree add --detach <managed-path> <ref>`               |
| `new_branch`      | `branchName`, `startPoint` | `git worktree add -b <branchName> <managed-path> <startPoint>` |

`existing_branch` means an existing **local** branch; remote-tracking branch auto-creation is not supported. The tool verifies branch/ref input before mutating the filesystem and surfaces Git's error if a branch is already checked out in another worktree.

All modes accept an optional `label` (managed directory name) and an optional `repoPath` (a path inside the source repository, resolved through Git; defaults to the session cwd).

### Examples

Existing local branch:

```json
{ "mode": "existing_branch", "branch": "feature-x" }
```

Detached ref, with an explicit label:

```json
{ "mode": "detached", "ref": "v1.2.0", "label": "release-check" }
```

New branch from a start point, in another repository:

```json
{
  "mode": "new_branch",
  "branchName": "hotfix",
  "startPoint": "main",
  "repoPath": "/path/to/other/repo"
}
```

### Settings

`worktrees.root` lives in the project-local `.pi/core-settings.json`. Edit it through the **Managed worktree root** row in `/core-settings`, or directly through `/core-settings edit`:

```json
{
  "version": 1,
  "worktrees": {
    "root": "~/.pi/worktrees"
  }
}
```

Both `add_git_worktree` and `/worktree` read this same setting. A leading `~` is expanded; the value must resolve to an absolute path and must not be inside the source repository.

### Permission note

`add_git_worktree` is a custom mutating tool, not a `bash` call. Permission gating is coarse: it is classified as a generic tool (`kind: "other"`), defaults to ask in safe/trusted mode, and can only be allowed or denied wholesale by tool name. There is no path- or argument-aware gating, and audit text does not reflect the internal `git` execution or the destination path.

### MVP boundary

Removal is out of scope for now: there is no `remove_git_worktree` tool. Delete managed worktrees with native Git (`git worktree remove <path>`).
