# Synthesis sub-agent prompt

Use this as the task prompt for each synthesis sub-agent in stage 3. Each
sub-agent reads a batch of digest files and returns a small JSON file — it never
returns raw transcript text. Fill in the bracketed values before spawning.

---

You are summarizing coding-agent sessions for an insights report. Read each of
these condensed session digests:

```
[absolute paths to this batch's digest files, e.g.
 /path/WS/digests/pi__019e....md
 /path/WS/digests/codex__rollout-....md]
```

Each digest has a header (agent, project, friction counts, **compaction counts**)
and a condensed transcript of the conversation. Your job is to identify **what the
user actually worked on**, **where they hit friction**, **which issues spanned
multiple sessions**, and **which single sessions sprawled across unrelated
issues**, then write the findings to:

```
[per-batch output path, e.g. /path/WS/synth-batch-1.json]
```

Write only this JSON, matching this schema exactly:

```json
{
  "schema_version": 3,
  "themes": [
    {
      "title": "Short noun phrase naming a body of work",
      "summary": "1–2 sentences on what was done and why, grounded in the digests.",
      "projects": ["project-name"],
      "sessions": 0
    }
  ],
  "cross_session_threads": [
    {
      "title": "Short name for one issue/effort that continued across sessions",
      "summary": "1–2 sentences: what the issue was and how it carried across sessions.",
      "projects": ["project-name"],
      "session_count": 0,
      "compactions": 0
    }
  ],
  "fragmented_sessions": [
    {
      "session": "first-prompt snippet or session id from the digest header",
      "agent": "claude-code|codex|pi|opencode",
      "project": "project-name",
      "topics": ["unrelated topic A", "unrelated topic B"],
      "note": "1 sentence on how the session jumped between unrelated issues."
    }
  ],
  "friction_patterns": [
    {
      "pattern": "Short label for a recurring friction",
      "detail": "1–2 sentences: what happened, in which projects, how often."
    }
  ],
  "recommendations": [
    {
      "title": "Short imperative recommendation",
      "why": "One sentence grounded in stats or friction patterns.",
      "next_step": "Concrete action the user or future agent can take."
    }
  ],
  "project_insights": [
    {
      "project": "project-name",
      "dominant_theme": "Compact label for the main work in this project",
      "suggested_workflow_improvement": "One concrete process or repo-practice improvement"
    }
  ],
  "metadata": {
    "digest_count": 0,
    "batch_count": 1,
    "failed_batches": 0
  }
}
```

Guidance:

- Group related sessions into a handful of meaningful themes (aim for 3–6 in this
  batch), not one theme per session. `sessions` is the count of digests that fed
  the theme.
- For `cross_session_threads`, identify a single issue or effort that the user
  resumed across **two or more** sessions — e.g. the same bug, feature, or
  investigation picked up again later, often in the same project and frequently
  right after a compaction. Set `session_count` to how many digests it spans and
  `compactions` to the sum of compactions in those digests (from the headers). Omit
  the array if nothing genuinely continued across sessions; do not list ordinary
  single-session themes here.
- For `fragmented_sessions`, flag individual sessions whose transcript jumped
  between **unrelated** issues (e.g. a bug fix, then unrelated docs, then a
  different project's feature) rather than one coherent task. List the distinct
  `topics` and a short `note`. This is a per-session observation; only include
  clear cases, and leave the array empty if sessions were mostly focused.
- For `friction_patterns`, focus on cancels, rejected tool calls, and repeated
  errors visible in the digests — look for _patterns_ (e.g. "edits rejected then
  reworked", "long debugging loops in project X"), not one-offs. Omit the array
  or leave it empty if nothing notable stands out.
- For `recommendations`, suggest behavior changes the user or future agents could
  action: use hooks, update documentation, change prompt style, clear context,
  add smoke harnesses, update AGENTS.md, or continue effective practices. Keep
  them grounded in the batch; do not make generic productivity advice.
- For `project_insights`, include only projects visible in this batch. Keep each
  suggested workflow improvement short enough for a compact report card.
- Set `metadata.digest_count` to the number of digest files you read.
- Be concrete and grounded in the digests. Do not invent specifics that are not
  present. Keep summaries tight; this feeds a one-page report.
- Output only the JSON file. Do not echo transcript contents back.
