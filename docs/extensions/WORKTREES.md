# Worktrees

When Pi starts inside a linked Git worktree, the core footer adds a `wt:<label>` segment before the branch segment and each agent run receives a short system-prompt note with the worktree label, branch, root, and current Pi cwd. Ordinary repositories and non-Git directories keep the existing footer and prompt behavior. Custom footer templates configured through `/core-settings` must include `{worktree}` to display the linked-worktree label.

Run `/worktree` to list linked worktrees for the current repository; it is list-only and does not move the session cwd.
