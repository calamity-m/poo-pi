#!/usr/bin/env python3
"""Render a styled, self-contained HTML report from analysis.json (+ optional synthesis).

This is the deterministic presentation stage: given the same analysis.json and
synthesis.json it always produces the same HTML. It fills assets/report_template.html
with stat cards, activity charts, agent/project tables, session-length diagnostics,
recommendations, and friction sections. Qualitative themes, project insights,
recommendations, and friction patterns come from synthesis.json; if it is absent
those sections render friendly placeholders so the report still stands on its own.

synthesis.json shape (all optional):
  {
    "schema_version": 3,
    "themes": [{"title": str, "summary": str, "projects": [str], "sessions": int}],
    "cross_session_threads": [{
      "title": str, "summary": str, "projects": [str],
      "session_count": int, "compactions": int
    }],
    "fragmented_sessions": [{
      "session": str, "agent": str, "project": str, "topics": [str], "note": str
    }],
    "friction_patterns": [{"pattern": str, "detail": str}],
    "recommendations": [{"title": str, "why": str, "next_step": str}],
    "project_insights": [{
      "project": str,
      "dominant_theme": str,
      "suggested_workflow_improvement": str
    }],
    "metadata": {"digest_count": int, "batch_count": int, "failed_batches": int}
  }
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "report_template.html"


def esc(x) -> str:
    """HTML-escape a value for safe insertion into the report template."""
    return html.escape(str(x), quote=True)


def stat_cards(t: dict) -> str:
    """Render the top-level metric cards."""
    cards = [
        ("Sessions", t.get("sessions", 0), ""),
        ("Active hours", t.get("duration_hours", 0), ""),
        ("Active days", t.get("active_days", 0), ""),
        ("Longest streak", f'{t.get("longest_streak_days", 0)}d', ""),
        ("Projects", t.get("projects", 0), ""),
        ("Prompts sent", t.get("user_prompts", 0), ""),
        ("Tool calls", t.get("tool_calls", 0), ""),
    ]
    return "".join(
        f'<div class="card {cls}"><div class="num">{esc(num)}</div><div class="lbl">{esc(lbl)}</div></div>'
        for lbl, num, cls in cards
    )


def activity_chart(by_day: list[dict]) -> str:
    """Render a sessions-per-day bar chart."""
    if not by_day:
        return '<span class="empty">No activity in range.</span>'
    peak = max((d["sessions"] for d in by_day), default=1) or 1
    step = max(1, len(by_day) // 10)
    bars = []
    for i, d in enumerate(by_day):
        h = max(2, round(d["sessions"] / peak * 100))
        label = f'<span>{esc(d["date"][5:])}</span>' if i % step == 0 else ""
        bars.append(
            f'<div class="bar" style="height:{h}%" '
            f'title="{esc(d["date"])}: {d["sessions"]} sessions, {d["duration_hours"]}h">{label}</div>'
        )
    return "".join(bars)


def hour_chart(by_hour: list[int]) -> str:
    """Render a start-hour histogram."""
    peak = max(by_hour, default=1) or 1
    return "".join(
        f'<div class="hbar" style="height:{max(2, round(c / peak * 100))}%" '
        f'title="{h:02d}:00 — {c} sessions"></div>'
        for h, c in enumerate(by_hour)
    )


def _friction_cell(agent: str, counter: str, value, support: dict) -> str:
    """Render a friction count, or an n/a dash when the agent never records it.

    Without this, an untracked counter renders as 0 and reads as "no friction".
    """
    agent_support = support.get(agent)
    if agent_support is not None and not agent_support.get(counter, True):
        return "<td class='num muted' title='Not recorded by this agent'>—</td>"
    return f"<td class='num'>{esc(value)}</td>"


def agent_table(by_agent: list[dict], support: dict | None = None) -> str:
    """Render the per-agent breakdown table with rates and n/a for untracked counters."""
    support = support or {}
    rows = "".join(
        f"<tr><td>{esc(a['agent'])}</td>"
        f"<td class='num'>{a['sessions']}</td>"
        f"<td class='num'>{a['duration_hours']}</td>"
        f"<td class='num'>{a['tool_calls']}</td>"
        f"<td class='num'>{a.get('tools_per_prompt', '')}</td>"
        + _friction_cell(a["agent"], "cancels", a["cancels"], support)
        + _friction_cell(a["agent"], "rejections", a["rejections"], support)
        + _friction_cell(a["agent"], "errors", a["errors"], support)
        + f"<td class='num'>{a.get('friction_per_100_tools', '')}</td></tr>"
        for a in by_agent
    )
    return (
        "<table><thead><tr><th>Agent</th><th class='num'>Sessions</th>"
        "<th class='num'>Hours</th><th class='num'>Tool calls</th>"
        "<th class='num'>Tools/prompt</th>"
        "<th class='num'>Cancels</th><th class='num'>Rejections</th>"
        "<th class='num'>Errors</th><th class='num'>Friction/100 tools</th>"
        f"</tr></thead><tbody>{rows}</tbody></table>"
        '<p class="note">— means the agent does not record that counter, '
        "so 0 would be misleading. Rates make agents comparable regardless of volume.</p>"
    )


def project_table(by_project: list[dict]) -> str:
    """Render the compact per-project table."""
    rows = "".join(
        f"<tr><td>{esc(p['project'])}</td>"
        f"<td class='num'>{p['sessions']}</td>"
        f"<td class='num'>{p['duration_hours']}</td>"
        f"<td>{''.join(f'<span class=tag>{esc(a)}</span>' for a in p.get('agents', []))}</td>"
        f"<td class='num'>{p.get('cancels', 0) + p.get('rejections', 0) + p.get('errors', 0)}</td>"
        f"<td class='num'>{p.get('friction_per_100_tools', '')}</td></tr>"
        for p in by_project
    )
    return (
        "<table><thead><tr><th>Project</th><th class='num'>Sessions</th>"
        "<th class='num'>Hours</th><th>Agents</th>"
        "<th class='num'>Friction</th><th class='num'>Per 100 tools</th>"
        f"</tr></thead><tbody>{rows}</tbody></table>"
    )


def models_section(by_model: list[dict]) -> str:
    """Render which models were used and in how many sessions."""
    if not by_model:
        return '<p class="empty">No model information recorded in range.</p>'
    return "<div>" + "".join(
        f'<span class="tag">{esc(m["model"])}: {esc(m["sessions"])} sessions</span>'
        for m in by_model
    ) + "</div>"


def tools_section(by_tool: list[dict]) -> str:
    """Render top tools by call volume with their error rates."""
    if not by_tool:
        return '<p class="empty">No tool usage recorded in range.</p>'
    rows = "".join(
        f"<tr><td>{esc(t['tool'])}</td>"
        f"<td class='num'>{t['calls']}</td>"
        f"<td class='num'>{t['errors']}</td>"
        f"<td class='num'>{t['error_pct']}%</td></tr>"
        for t in by_tool
    )
    return (
        "<table><thead><tr><th>Tool</th><th class='num'>Calls</th>"
        "<th class='num'>Errors</th><th class='num'>Error rate</th>"
        f"</tr></thead><tbody>{rows}</tbody></table>"
    )


_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def weekday_chart(by_weekday: list[int]) -> str:
    """Render a Monday-to-Sunday session histogram."""
    if not by_weekday or not any(by_weekday):
        return ""
    peak = max(by_weekday) or 1
    return "".join(
        f'<div class="hbar" style="height:{max(2, round(c / peak * 100))}%" '
        f'title="{_WEEKDAYS[i]} — {c} sessions"></div>'
        for i, c in enumerate(by_weekday)
    )


def trend_note(trend: dict | None) -> str:
    """Render a first-half vs second-half comparison of the window."""
    if not trend:
        return ""
    f, s = trend.get("first_half", {}), trend.get("second_half", {})
    pct = trend.get("sessions_change_pct")
    direction = ""
    if pct is not None:
        direction = f" — {'up' if pct >= 0 else 'down'} {abs(pct)}% in the second half"
    return (
        f'<p class="note">Trend: {f.get("sessions", 0)} sessions ({f.get("duration_hours", 0)}h) '
        f'in the first half of the window vs {s.get("sessions", 0)} ({s.get("duration_hours", 0)}h) '
        f"in the second{esc(direction)}.</p>"
    )


def session_length_section(lengths: dict) -> str:
    """Render session-length diagnostics that indicate context-window hygiene."""
    if not lengths:
        return '<p class="empty">No session length data available.</p>'
    cards = [
        ("Average", f'{lengths.get("avg_min", 0)}m'),
        ("Median", f'{lengths.get("median_min", 0)}m'),
        ("P90", f'{lengths.get("p90_min", 0)}m'),
        ("Longest", f'{lengths.get("max_min", 0)}m'),
        ("2h+ sessions", lengths.get("over_120_min", 0)),
        ("Abandoned starts", lengths.get("abandoned", 0)),
    ]
    cards_html = "".join(
        f'<div class="card"><div class="num">{esc(v)}</div><div class="lbl">{esc(k)}</div></div>'
        for k, v in cards
    )
    buckets = lengths.get("buckets", {})
    bucket_html = "".join(
        f'<span class="tag">{esc(k)}: {esc(v)}</span>'
        for k, v in buckets.items()
    )
    note = lengths.get("interpretation") or "Long sessions can indicate deep flow, but repeated 2h+ sessions may deserve deliberate context resets."
    sub = lengths.get("note", "")
    sub_html = f'<p class="note">{esc(sub)}</p>' if sub else ""
    return f'<div class="cards">{cards_html}</div><p class="note">{esc(note)}</p><div>{bucket_html}</div>{sub_html}'


def _humanize(n: int | float) -> str:
    """Compact large token counts (e.g. 1234567 -> '1.2M') for stat cards."""
    n = int(n or 0)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def tokens_section(tokens: dict, by_agent: list[dict]) -> str:
    """Render best-effort token usage, keeping cache reads separate from work tokens."""
    if not tokens:
        return '<p class="empty">No token data available.</p>'
    cards = [
        ("Work tokens", _humanize(tokens.get("work", 0))),
        ("Input", _humanize(tokens.get("input", 0))),
        ("Output", _humanize(tokens.get("output", 0))),
        ("Cache reads", _humanize(tokens.get("cache_read", 0))),
        ("Avg / session", _humanize(tokens.get("avg_work_per_session", 0))),
    ]
    cards_html = "".join(
        f'<div class="card"><div class="num">{esc(v)}</div><div class="lbl">{esc(k)}</div></div>'
        for k, v in cards
    )
    tags = "".join(
        f'<span class="tag">{esc(a["agent"])}: {esc(_humanize(a.get("tokens", 0)))}</span>'
        for a in by_agent
        if a.get("tokens", 0)
    )
    note = tokens.get("interpretation", "")
    sub = tokens.get("note", "")
    tags_html = f"<div>{tags}</div>" if tags else ""
    sub_html = f'<p class="note">{esc(sub)}</p>' if sub else ""
    return f'<div class="cards">{cards_html}</div><p class="note">{esc(note)}</p>{tags_html}{sub_html}'


def compaction_section(compaction: dict, by_agent: list[dict]) -> str:
    """Render compaction diagnostics, highlighting auto-compaction as a hygiene risk."""
    if not compaction:
        return '<p class="empty">No compaction data available.</p>'
    cards = [
        ("Compactions", compaction.get("total", 0), ""),
        ("Auto", compaction.get("auto", 0), "warn" if compaction.get("auto") else ""),
        ("Manual", compaction.get("manual", 0), ""),
        ("Threshold", compaction.get("threshold", 0), "warn" if compaction.get("threshold") else ""),
        ("Overflow", compaction.get("overflow", 0), "bad" if compaction.get("overflow") else ""),
        ("Unknown trigger", compaction.get("unknown_trigger", 0), ""),
        ("Sessions affected", compaction.get("sessions_with_compaction", 0), ""),
    ]
    cards_html = "".join(
        f'<div class="card {cls}"><div class="num">{esc(v)}</div><div class="lbl">{esc(k)}</div></div>'
        for k, v, cls in cards
    )
    tags = "".join(
        f'<span class="tag">{esc(a["agent"])}: {esc(a.get("compactions", 0))}'
        + _compaction_agent_suffix(a)
        + "</span>"
        for a in by_agent
        if a.get("compactions", 0)
    )
    note = compaction.get("interpretation", "")
    tags_html = f"<div>{tags}</div>" if tags else ""
    return f'<div class="cards">{cards_html}</div><p class="note">{esc(note)}</p>{tags_html}'


def _compaction_agent_suffix(agent: dict) -> str:
    """Render known compaction trigger counts for one agent tag."""
    parts = []
    if agent.get("auto_compactions"):
        parts.append(f"auto {esc(agent['auto_compactions'])}")
    if agent.get("manual_compactions"):
        parts.append(f"manual {esc(agent['manual_compactions'])}")
    if agent.get("threshold_compactions"):
        parts.append(f"threshold {esc(agent['threshold_compactions'])}")
    if agent.get("overflow_compactions"):
        parts.append(f"overflow {esc(agent['overflow_compactions'])}")
    return f" ({', '.join(parts)})" if parts else ""


def friction_cards(friction: dict) -> str:
    """Render top-level deterministic friction counters."""
    items = [
        ("Cancels", friction.get("cancels", 0), "warn"),
        ("Rejections", friction.get("rejections", 0), "bad"),
        ("Errors", friction.get("errors", 0), "warn"),
    ]
    return "".join(
        f'<div class="card {cls}"><div class="num">{n}</div><div class="lbl">{esc(lbl)}</div></div>'
        for lbl, n, cls in items
    )


def friction_buckets_section(buckets: dict) -> str:
    """Render deterministic friction buckets from analysis.json."""
    if not buckets:
        return ""
    labels = {
        "user_interruption_cancel": "User interruption / cancel",
        "permission_rejection": "Permission rejection",
        "tool_runtime_error": "Tool/runtime error",
    }
    return "".join(
        f'<span class="tag friction-tag">{esc(labels.get(k, k))}: {esc(v)}</span>'
        for k, v in buckets.items()
        if v
    )


def friction_table(rows: list[dict]) -> str:
    """Render the highest-friction sessions table."""
    if not rows:
        return '<p class="empty">No cancels, rejections, or errors in range — smooth sailing.</p>'
    body = "".join(
        f"<tr><td>{esc(s['agent'])}</td><td>{esc(s['project'])}</td>"
        f"<td class='num'>{s['cancels']}</td><td class='num'>{s['rejections']}</td>"
        f"<td class='num'>{s['errors']}</td><td class='num'>{s.get('per_100_tools', '')}</td>"
        f"<td class='num'>{s.get('duration_min', '')}</td>"
        f"<td class='prompt' title=\"{esc(s['first_user_prompt'])}\">{esc(s['first_user_prompt'])}</td></tr>"
        for s in rows
    )
    return (
        "<table><thead><tr><th>Agent</th><th>Project</th>"
        "<th class='num'>Cancels</th><th class='num'>Rej.</th><th class='num'>Err.</th>"
        "<th class='num'>Per 100 tools</th>"
        f"<th class='num'>Min.</th><th>Prompt</th></tr></thead><tbody>{body}</tbody></table>"
    )


def themes_section(synth: dict | None) -> str:
    """Render synthesized work themes."""
    themes = (synth or {}).get("themes") or []
    if not themes:
        return ('<p class="empty">No qualitative synthesis available. Run the sub-agent '
                "synthesis step and pass --synthesis to populate this section.</p>")
    out = []
    for th in themes:
        projects = "".join(f'<span class="tag">{esc(p)}</span>' for p in th.get("projects", []))
        sub = []
        if th.get("sessions"):
            sub.append(f'{th["sessions"]} sessions')
        sub_txt = f'<div class="sub">{" · ".join(sub)} {projects}</div>' if (sub or projects) else ""
        out.append(
            f'<div class="theme"><h3>{esc(th.get("title", "Theme"))}</h3>'
            f'<div>{esc(th.get("summary", ""))}</div>{sub_txt}</div>'
        )
    return "".join(out)


def cross_session_threads_section(synth: dict | None) -> str:
    """Render issues/efforts that spanned multiple sessions."""
    threads = (synth or {}).get("cross_session_threads") or []
    if not threads:
        return ('<p class="empty">No cross-session threads identified — work mostly stayed within '
                "single sessions, or synthesis was skipped.</p>")
    out = []
    for th in threads:
        projects = "".join(f'<span class="tag">{esc(p)}</span>' for p in th.get("projects", []))
        sub = []
        if th.get("session_count"):
            sub.append(f'{th["session_count"]} sessions')
        if th.get("compactions"):
            sub.append(f'{th["compactions"]} compactions')
        sub_txt = f'<div class="sub">{" · ".join(sub)} {projects}</div>' if (sub or projects) else ""
        out.append(
            f'<div class="theme"><h3>{esc(th.get("title", "Thread"))}</h3>'
            f'<div>{esc(th.get("summary", ""))}</div>{sub_txt}</div>'
        )
    return "".join(out)


def fragmented_sessions_section(synth: dict | None) -> str:
    """Render sessions that mixed multiple unrelated issues."""
    frags = (synth or {}).get("fragmented_sessions") or []
    if not frags:
        return ('<p class="empty">No fragmented sessions flagged — sessions generally stayed on a '
                "single topic.</p>")
    out = []
    for f in frags:
        topics = "".join(f'<span class="tag">{esc(t)}</span>' for t in f.get("topics", []))
        head = " · ".join(x for x in (f.get("agent"), f.get("project"), f.get("session")) if x)
        out.append(
            f'<div class="pattern"><h3>{esc(head or "Session")}</h3>'
            f'<div>{esc(f.get("note", ""))}</div>'
            + (f'<div class="sub">{topics}</div>' if topics else "")
            + "</div>"
        )
    return "".join(out)


def _deterministic_recommendations(analysis: dict) -> list[dict]:
    """Create basic recommendations from deterministic counters when synthesis omits them."""
    recs = []
    lengths = analysis.get("session_lengths", {})
    friction = analysis.get("friction", {})
    if lengths.get("over_120_min", 0):
        recs.append({
            "title": "Reset context deliberately during long threads",
            "why": f'{lengths.get("over_120_min")} sessions exceeded two hours, which can make context stale.',
            "next_step": "When a task changes direction, ask the agent for a handoff summary and start a fresh session.",
        })
    if friction.get("cancels", 0):
        recs.append({
            "title": "Review what triggered interrupted runs",
            "why": f'{friction.get("cancels", 0)} cancels were recorded — many are normal steering, but clusters in one project or task can mean runs drifting off-track.',
            "next_step": "Skim the highest-friction sessions table; where cancels cluster, ask for assumptions and a short plan before implementation.",
        })
    if friction.get("rejections", 0) or friction.get("errors", 0):
        recs.append({
            "title": "Add safer pre-flight checks around tools",
            "why": f'{friction.get("rejections", 0)} rejections and {friction.get("errors", 0)} errors point to avoidable tool friction.',
            "next_step": "Have agents inspect permissions, paths, and validation commands before making risky edits or calls.",
        })
    return recs[:3]


def recommendations_section(analysis: dict, synth: dict | None) -> str:
    """Render concrete recommendations from synthesis.json or deterministic fallback rules."""
    recs = (synth or {}).get("recommendations") or _deterministic_recommendations(analysis)
    if not recs:
        return '<p class="empty">No recommendations available for this range.</p>'
    return "".join(
        f'<div class="recommendation"><h3>{esc(r.get("title", "Recommendation"))}</h3>'
        f'<p><strong>Why:</strong> {esc(r.get("why", ""))}</p>'
        f'<p><strong>Next:</strong> {esc(r.get("next_step", ""))}</p></div>'
        for r in recs
    )


def project_insight_cards(analysis: dict, synth: dict | None) -> str:
    """Render compact per-project workflow insight cards."""
    by_name = {p.get("project"): p for p in (synth or {}).get("project_insights", [])}
    projects = analysis.get("by_project", [])[:6]
    if not projects:
        return '<p class="empty">No project activity in range.</p>'
    cards = []
    for p in projects:
        name = p["project"]
        insight = by_name.get(name, {})
        friction = p.get("cancels", 0) + p.get("rejections", 0) + p.get("errors", 0)
        common_agent = p.get("dominant_agent") or (p.get("agents") or ["?"])[0]
        theme = insight.get("dominant_theme") or "See synthesized themes"
        suggestion = insight.get("suggested_workflow_improvement") or "Use the friction/session-length sections to choose a workflow improvement."
        cards.append(
            f'<div class="project-card"><h3>{esc(name)}</h3>'
            f'<div class="sub">{esc(p.get("sessions", 0))} sessions · {esc(p.get("duration_hours", 0))}h · {esc(common_agent)}</div>'
            f'<p><strong>Dominant theme:</strong> {esc(theme)}</p>'
            f'<p><strong>Friction score:</strong> {esc(friction)}</p>'
            f'<p><strong>Improve:</strong> {esc(suggestion)}</p></div>'
        )
    return '<div class="project-grid">' + "".join(cards) + '</div>'


def friction_patterns(synth: dict | None) -> str:
    """Render synthesized friction patterns."""
    pats = (synth or {}).get("friction_patterns") or []
    if not pats:
        return ""
    out = []
    for p in pats:
        out.append(
            f'<div class="pattern"><h3>{esc(p.get("pattern", "Pattern"))}</h3>'
            f'<div>{esc(p.get("detail", ""))}</div></div>'
        )
    return "".join(out)


def synthesis_metadata(analysis: dict, synth: dict | None, batches: list | None) -> str:
    """Render hidden/details metadata about synthesis coverage and batching."""
    meta = dict((synth or {}).get("metadata") or {})
    if batches is not None:
        meta.setdefault("batch_count", len(batches))
        meta.setdefault("digest_count", sum(int(b.get("count", 0)) for b in batches if isinstance(b, dict)))
        meta.setdefault("failed_batches", sum(1 for b in batches if isinstance(b, dict) and b.get("failed")))
    meta.setdefault("synthesis_used", bool(synth))
    meta.setdefault("schema_version", (synth or {}).get("schema_version", 1 if synth else None))
    meta.setdefault("sessions_analyzed", analysis.get("totals", {}).get("sessions", 0))
    rows = "".join(f'<li><strong>{esc(k)}:</strong> {esc(v)}</li>' for k, v in meta.items())
    return f'<details class="metadata"><summary>Synthesis coverage metadata</summary><ul>{rows}</ul></details>'


def render(analysis: dict, synth: dict | None, batches: list | None = None) -> str:
    """Render complete HTML from analysis, optional synthesis, and optional batch metadata."""
    t = analysis["totals"]
    window = analysis.get("window", {})
    since = window.get("since")
    span = f"since {since[:10]}" if since else f"last {window.get('days', '?')} days"
    busiest = analysis.get("busiest_day")
    subtitle = (
        f"{t['sessions']} sessions across {t['projects']} projects · {span}"
        + (f" · busiest day {busiest['date']} ({busiest['sessions']} sessions)" if busiest else "")
    )

    repl = {
        "{{TITLE}}": "Coding Agent Insights",
        "{{SUBTITLE}}": esc(subtitle),
        "{{GENERATED_AT}}": esc(analysis.get("generated_at", dt.datetime.now().isoformat())[:19]),
        "{{STAT_CARDS}}": stat_cards(t),
        "{{ACTIVITY_CHART}}": activity_chart(analysis.get("by_day", [])),
        "{{TREND_NOTE}}": trend_note(analysis.get("trend")),
        "{{HOUR_CHART}}": hour_chart(analysis.get("by_hour", [0] * 24)),
        "{{WEEKDAY_CHART}}": weekday_chart(analysis.get("by_weekday", [])),
        "{{AGENT_TABLE}}": agent_table(
            analysis.get("by_agent", []), analysis.get("friction_support")
        ),
        "{{MODELS_SECTION}}": models_section(analysis.get("by_model", [])),
        "{{TOOLS_SECTION}}": tools_section(analysis.get("by_tool", [])),
        "{{PROJECT_TABLE}}": project_table(analysis.get("by_project", [])),
        "{{SESSION_LENGTH_SECTION}}": session_length_section(analysis.get("session_lengths", {})),
        "{{COMPACTION_SECTION}}": compaction_section(
            analysis.get("compaction", {}), analysis.get("by_agent", [])
        ),
        "{{TOKENS_SECTION}}": tokens_section(
            analysis.get("tokens", {}), analysis.get("by_agent", [])
        ),
        "{{PROJECT_INSIGHTS}}": project_insight_cards(analysis, synth),
        "{{THEMES_SECTION}}": themes_section(synth),
        "{{CROSS_SESSION_THREADS}}": cross_session_threads_section(synth),
        "{{FRAGMENTED_SESSIONS}}": fragmented_sessions_section(synth),
        "{{RECOMMENDATIONS_SECTION}}": recommendations_section(analysis, synth),
        "{{FRICTION_CARDS}}": friction_cards(analysis.get("friction", {})),
        "{{FRICTION_BUCKETS}}": friction_buckets_section(analysis.get("friction_buckets", {})),
        "{{FRICTION_PATTERNS}}": friction_patterns(synth),
        "{{FRICTION_TABLE}}": friction_table(analysis.get("top_friction_sessions", [])),
        "{{SYNTHESIS_METADATA}}": synthesis_metadata(analysis, synth, batches),
    }
    out = TEMPLATE.read_text(encoding="utf-8")
    for k, v in repl.items():
        out = out.replace(k, v)
    return out


def main() -> int:
    """CLI entry point for rendering a report."""
    ap = argparse.ArgumentParser(description="Render analysis.json into a styled HTML report.")
    ap.add_argument("--analysis", required=True, help="Path to analysis.json from analyze.py")
    ap.add_argument("--synthesis", help="Optional synthesis.json with themes/recommendations")
    ap.add_argument("--batches", help="Optional batches.json with synthesis batch metadata")
    ap.add_argument("--out", required=True, help="Path to write the HTML report")
    args = ap.parse_args()

    analysis = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    synth = None
    if args.synthesis and Path(args.synthesis).exists():
        synth = json.loads(Path(args.synthesis).read_text(encoding="utf-8"))
    batches = None
    if args.batches and Path(args.batches).exists():
        batches = json.loads(Path(args.batches).read_text(encoding="utf-8"))

    Path(args.out).write_text(render(analysis, synth, batches), encoding="utf-8")
    print(f"Wrote report -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
