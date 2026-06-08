---
description: Work a GitHub issue end-to-end from research to PR
argument-hint: "<issue-url-or-#number>"
---

Work this issue end-to-end, hands off where possible.

Issue / instructions:
$ARGUMENTS

If no issue URL or issue number was provided above, stop and ask me for one before doing anything else.

## Operating model

Be autonomous and iterative. Research, implement, verify, commit, push, and open a PR/MR without waiting for approval unless you hit a real blocker.

Only stop and ask me when:

- the issue lacks enough information to choose correct behavior
- acceptance criteria conflict
- implementation requires credentials, secrets, paid services, or external access I have not provided
- the next step is destructive, irreversible, or a broad migration
- the issue is too large to finish safely in one PR/MR

## Working memory

Create and maintain a concise working memory document at:

```text
.pi/issue-flow/<issue-id-or-short-slug>.md
```

Use the issue number when known, e.g. `.pi/issue-flow/123-fix-login-timeout.md`. If there is no issue number, use a short kebab-case slug from the issue title or instructions.

The working memory document is not a deliverable and not a design plan. It exists so you can survive compaction, resume work, track acceptance criteria, and verify completion.

Create it after initial issue research, then update it at phase boundaries: after research, after choosing the approach, after implementation, after verification, after commit, and after PR/MR creation. Keep it compact; do not turn it into a diary.

Use this structure:

````md
# Issue Flow: <issue id/title>

## Source

- Issue: <url-or-reference>
- Branch: <branch-name>
- Worktree: <absolute path to worktree>
- PR/MR: <url once opened>

## Objective

<1-3 sentences summarizing what must be done.>

## Acceptance Criteria

- [ ] <criterion from the issue or directly inferred requirement>
- [ ] <criterion>

## Research Notes

- <important repo facts, relevant files, prior art, constraints>

## Working Approach

<short current implementation approach. Keep this practical, not architectural.>

## Progress

- [ ] Research issue
- [ ] Create worktree and branch
- [ ] Implement
- [ ] Run checks
- [ ] Review acceptance criteria
- [ ] Commit
- [ ] Push
- [ ] Open PR/MR
- [ ] Remove worktree

## Verification

Commands run:

```bash
<command>
```

Results:

- <pass/fail notes>

## Open Questions / Blockers

- <only unresolved things that genuinely block autonomous progress>
````

If context gets compacted or you become uncertain about prior work, reread this document before continuing.

## Flow

1. **Research** - view and understand the issue and instructions above. Extract the objective, acceptance criteria, constraints, and likely affected areas.

2. **Working memory** - create `.pi/issue-flow/<issue-id-or-short-slug>.md` using the structure above. Populate the source, objective, acceptance criteria, research notes, and initial progress.

3. **Worktree** - create an isolated git worktree for this issue from the repo root:

   ```bash
   git worktree add ../<type>-<short-slug> -b <type>/<short-slug>
   ```

   Do all implementation work inside that worktree directory. Record the branch name and absolute worktree path in the working memory document.

4. **Implement** - make the minimal change that satisfies every acceptance criterion in the issue. No scope creep. Update the working approach and progress as the work changes.

5. **Check** - before committing, go through the issue's acceptance criteria line by line. Close any gaps now, including required docs, config examples, and README mentions. Run the most relevant checks available. Record commands and results in the working memory document. Do not proceed until every criterion is met or a blocker is documented.

6. **Commit** - stage the relevant changes and write a conventional commit. Include `Closes #<n>` in the body when the issue number is known. Update progress.

7. **Push** - push the branch. Update progress.

8. **PR/MR** - open a pull request or merge request. Include a concise summary, verification notes, and the acceptance criteria checklist. Link or reference the working memory document only if useful; do not treat it as a user-facing deliverable.

9. **Cleanup** - once the PR/MR is open, remove the worktree from the repo root:

   ```bash
   git worktree remove ../<type>-<short-slug>
   ```

   Update the working memory document to mark the worktree removed.
