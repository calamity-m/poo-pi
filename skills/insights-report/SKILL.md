---
name: insights-report
description: >-
  Generate a styled HTML report of how the user has been using their coding
  agents.
disable-model-invocation: true
---

# Insights

Produce a deterministic, styled HTML report about the user's coding-agent usage
by scanning their local session history across **Claude Code, Codex, Pi, and
OpenCode**, then layering in a short qualitative synthesis of what they worked on
and where they hit friction.

The design splits cleanly into **deterministic scripts** (discovery, stats,
rendering — fully reproducible, no model variance) and **sub-agent synthesis**
(reading condensed digests to name themes and friction patterns). Keep the
heavy reading off the main thread: you orchestrate, sub-agents read transcripts,
and the report is assembled from small JSON artifacts. This is what keeps the
report cheap and your context window clean.

## Pipeline

Run these four stages in order. All scripts are standard-library Python 3 and
live in `scripts/` next to this file. Use a scratch workspace (default below) to
hold the intermediate artifacts.

```text
1. fetch   -> sessions.json + digests/   verify: "Wrote N sessions"
2. analyze -> analysis.json              verify: "Analyzed N sessions"
3. synth   -> synthesis.json             verify: themes[] populated (sub-agents)
4. render  -> report.html                verify: file opens, no {{ }} placeholders
```

Let `WS` be a workspace directory, e.g. `WS=$(mktemp -d)/insights-report` or a path the
user names. Substitute the real path to this skill's `scripts/` directory.

### 1. Fetch sessions

```bash
python3 scripts/fetch_sessions.py --out-dir "$WS" --days 30
```

This discovers and normalizes every session into `$WS/sessions.json` (lightweight
metadata + counts + friction) and writes one condensed transcript per session
into `$WS/digests/`. Useful flags:

- `--agent {all,claude-code,codex,pi,opencode}` — limit to one agent (default `all`).
- `--days N` — only sessions from the last N days (default 30; `0` = all time).
- `--since YYYY-MM-DD` — explicit start date (overrides `--days`).
- `--project SUBSTR` / `--cwd SUBSTR` — filter to a project or working directory.

Match the flags to the user's ask. "This week" → `--days 7`. "My work on
acme-api" → `--project acme-api`. Default to `--days 30` if unspecified, and tell
the user the window you chose.

### 2. Analyze

```bash
python3 scripts/analyze.py --sessions "$WS/sessions.json" --out "$WS/analysis.json"
```

Pure aggregation: totals, activity by day, hour-of-day histogram, per-agent and
per-project breakdowns, and the highest-friction sessions. No model involved.

### 3. Synthesize (sub-agents)

This is the only stage that reads transcripts, and it is why sub-agents matter:
the digests can total hundreds of KB, which you must not pull into the main
context. Instead, **fan the digests out to sub-agents** and collect back a small
JSON.

1. List the digest files and the friction leaders:
   ```bash
   ls "$WS/digests" | wc -l
   python3 -c "import json;d=json.load(open('$WS/analysis.json'));print(json.dumps(d['top_friction_sessions'],indent=1))"
   ```
2. Split the digest files into batches (aim for ~15–25 digests per sub-agent, or
   one sub-agent per project for large histories). Spawn the sub-agents **in
   parallel** using whatever sub-agent / task mechanism the host agent provides.
   Give each the prompt in `references/synthesis-agent.md`, pointing it at its
   batch of digest files and a per-batch output path
   (e.g. `$WS/synth-batch-1.json`).
3. Merge the per-batch JSON into a single `$WS/synthesis.json`. Deduplicate and
   combine themes that clearly describe the same work; keep 4–8 themes total and
   the 2–4 most important friction patterns. The merged file must match the
   schema in `references/synthesis-agent.md`.

If the host agent cannot spawn sub-agents, fall back to reading digests yourself
in small batches and writing `synthesis.json` directly — but prefer sub-agents,
since unsynthesized transcripts otherwise flood your context. The synthesis stage
is optional: `render` produces a complete report without it, just without the
"What you worked on" narrative.

### 4. Render

```bash
python3 scripts/render_report.py \
  --analysis "$WS/analysis.json" \
  --synthesis "$WS/synthesis.json" \
  --out "$WS/report.html"
```

Omit `--synthesis` if you skipped stage 3. The script fills
`assets/report_template.html` deterministically — the same inputs always yield
the same HTML. Confirm there are no leftover `{{ }}` placeholders, then give the
user the absolute path to `report.html` (and offer to open it).

## Notes

- **Privacy:** everything runs locally against the user's own session files; no
  data leaves the machine. Don't paste raw transcript contents back to the user
  unless they ask — the report and digests already summarize them.
- **Missing agents:** if an agent has no local history the fetch step simply
  reports `0 sessions` for it; that is expected, not an error.
- **Friction semantics differ per agent** (e.g. Pi records cancels as a stop
  reason, Claude Code as an interrupt marker). See
  `references/session-formats.md` for exactly what each counter measures and its
  known limitations before explaining numbers to the user.
- **Extending to a new agent:** add a parser in `fetch_sessions.py` that returns
  the common `Session`/`Message` shape and register it in `AGENT_PARSERS`; the
  rest of the pipeline needs no changes.
