---
description: Reflect on recent project sessions and improve AGENTS.md guidance
argument-hint: "[focus]"
---

Reflect on prior Pi sessions for the current repository. If arguments are provided, use them as the focus: $ARGUMENTS

Goal: identify recurring agent behavior that should change, then make the smallest useful updates to `AGENTS.md`.

Process:

1. Locate relevant sessions:
   - Determine the current project directory with `pwd`.
   - Inspect `~/.pi/agent/sessions/` for session directories related to this working directory. Pi session paths usually replace `/` with `-`, e.g. `~/.pi/agent/sessions/--path-to-project--/`.
   - Prefer recent sessions for this repository. If there are many, sample enough to find patterns rather than reading everything.
   - Treat session contents as sensitive local data. Do not quote long private text; summarize only what is needed.
2. Analyze patterns:
   - Wins: behaviors that worked well and should be preserved.
   - Losses: places the user was frustrated, repeated instructions, corrections, or requests to redo work.
   - Repeated failures: tool failures, bad assumptions, stuck loops, over-broad edits, missed verification, or avoidable backtracking.
   - Separate one-off incidents from repeated patterns.
3. Propose changes before editing:
   - Summarize findings briefly, with evidence from session names/timestamps or high-level references.
   - Recommend only guidance that would have prevented repeated problems.
   - Prefer tightening or replacing existing `AGENTS.md` guidance over adding new sections.
4. Edit guidance surgically:
   - Keep `AGENTS.md` smaller when possible.
   - Remove or compress stale/duplicative guidance if adding new guidance.
   - If the findings require substantial detail, create a focused `docs/` file and link to it from `AGENTS.md` instead of growing `AGENTS.md` heavily.
   - Do not add process rules for isolated incidents.
5. Verify:
   - Re-read the changed files.
   - Report what changed, why, and any patterns intentionally not encoded.

Output format:

- Session scope inspected
- Key patterns found
- `AGENTS.md` / `docs/` changes made
- Follow-up recommendations, if any
