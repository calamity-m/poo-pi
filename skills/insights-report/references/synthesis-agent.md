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

Each digest has a header (agent, project, friction counts) and a condensed
transcript of the conversation. Your job is to identify **what the user actually
worked on** and **where they hit friction**, then write the findings to:

```
[per-batch output path, e.g. /path/WS/synth-batch-1.json]
```

Write only this JSON, matching this schema exactly:

```json
{
  "themes": [
    {
      "title": "Short noun phrase naming a body of work",
      "summary": "1–2 sentences on what was done and why, grounded in the digests.",
      "projects": ["project-name"],
      "sessions": 0
    }
  ],
  "friction_patterns": [
    {
      "pattern": "Short label for a recurring friction",
      "detail": "1–2 sentences: what happened, in which projects, how often."
    }
  ]
}
```

Guidance:

- Group related sessions into a handful of meaningful themes (aim for 3–6 in this
  batch), not one theme per session. `sessions` is the count of digests that fed
  the theme.
- For `friction_patterns`, focus on cancels, rejected tool calls, and repeated
  errors visible in the digests — look for _patterns_ (e.g. "edits rejected then
  reworked", "long debugging loops in project X"), not one-offs. Omit the array
  or leave it empty if nothing notable stands out.
- Be concrete and grounded in the digests. Do not invent specifics that are not
  present. Keep summaries tight; this feeds a one-page report.
- Output only the JSON file. Do not echo transcript contents back.
