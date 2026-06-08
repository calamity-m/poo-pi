#!/usr/bin/env python3
"""Render a styled, self-contained HTML report from analysis.json (+ optional synthesis).

This is the deterministic presentation stage: given the same analysis.json and
synthesis.json it always produces the same HTML. It fills assets/report_template.html
with stat cards, an activity bar chart, an hour-of-day histogram, agent/project
tables, and the friction section. The qualitative "What you worked on" and friction
patterns come from synthesis.json (written by sub-agents); if it is absent those
sections render a friendly placeholder so the report still stands on its own.

synthesis.json shape (all optional):
  {
    "themes": [{"title": str, "summary": str, "projects": [str], "sessions": int}],
    "friction_patterns": [{"pattern": str, "detail": str}]
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
    return html.escape(str(x), quote=True)


def stat_cards(t: dict) -> str:
    cards = [
        ("Sessions", t["sessions"], ""),
        ("Active hours", t["duration_hours"], ""),
        ("Active days", t["active_days"], ""),
        ("Longest streak", f'{t["longest_streak_days"]}d', ""),
        ("Projects", t["projects"], ""),
        ("Prompts sent", t["user_prompts"], ""),
        ("Tool calls", t["tool_calls"], ""),
    ]
    return "".join(
        f'<div class="card {cls}"><div class="num">{esc(num)}</div><div class="lbl">{esc(lbl)}</div></div>'
        for lbl, num, cls in cards
    )


def activity_chart(by_day: list[dict]) -> str:
    if not by_day:
        return '<span class="empty">No activity in range.</span>'
    peak = max((d["sessions"] for d in by_day), default=1) or 1
    # Label sparsely so the x-axis stays readable.
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
    peak = max(by_hour, default=1) or 1
    return "".join(
        f'<div class="hbar" style="height:{max(2, round(c / peak * 100))}%" '
        f'title="{h:02d}:00 — {c} sessions"></div>'
        for h, c in enumerate(by_hour)
    )


def agent_table(by_agent: list[dict]) -> str:
    rows = "".join(
        f"<tr><td>{esc(a['agent'])}</td>"
        f"<td class='num'>{a['sessions']}</td>"
        f"<td class='num'>{a['duration_hours']}</td>"
        f"<td class='num'>{a['tool_calls']}</td>"
        f"<td class='num'>{a['cancels']}</td>"
        f"<td class='num'>{a['rejections']}</td>"
        f"<td class='num'>{a['errors']}</td></tr>"
        for a in by_agent
    )
    return (
        "<table><thead><tr><th>Agent</th><th class='num'>Sessions</th>"
        "<th class='num'>Hours</th><th class='num'>Tool calls</th>"
        "<th class='num'>Cancels</th><th class='num'>Rejections</th>"
        f"<th class='num'>Errors</th></tr></thead><tbody>{rows}</tbody></table>"
    )


def project_table(by_project: list[dict]) -> str:
    rows = "".join(
        f"<tr><td>{esc(p['project'])}</td>"
        f"<td class='num'>{p['sessions']}</td>"
        f"<td class='num'>{p['duration_hours']}</td>"
        f"<td>{''.join(f'<span class=tag>{esc(a)}</span>' for a in p['agents'])}</td>"
        f"<td class='num'>{p['cancels'] + p['rejections']}</td></tr>"
        for p in by_project
    )
    return (
        "<table><thead><tr><th>Project</th><th class='num'>Sessions</th>"
        "<th class='num'>Hours</th><th>Agents</th>"
        f"<th class='num'>Friction</th></tr></thead><tbody>{rows}</tbody></table>"
    )


def friction_cards(friction: dict) -> str:
    items = [
        ("Cancels", friction.get("cancels", 0), "warn"),
        ("Rejections", friction.get("rejections", 0), "bad"),
        ("Errors", friction.get("errors", 0), "warn"),
    ]
    return "".join(
        f'<div class="card {cls}"><div class="num">{n}</div><div class="lbl">{esc(lbl)}</div></div>'
        for lbl, n, cls in items
    )


def friction_table(rows: list[dict]) -> str:
    if not rows:
        return '<p class="empty">No cancels, rejections, or errors in range — smooth sailing.</p>'
    body = "".join(
        f"<tr><td>{esc(s['agent'])}</td><td>{esc(s['project'])}</td>"
        f"<td class='num'>{s['cancels']}</td><td class='num'>{s['rejections']}</td>"
        f"<td class='num'>{s['errors']}</td>"
        f"<td class='prompt' title=\"{esc(s['first_user_prompt'])}\">{esc(s['first_user_prompt'])}</td></tr>"
        for s in rows
    )
    return (
        "<table><thead><tr><th>Agent</th><th>Project</th>"
        "<th class='num'>Cancels</th><th class='num'>Rej.</th><th class='num'>Err.</th>"
        f"<th>Prompt</th></tr></thead><tbody>{body}</tbody></table>"
    )


def themes_section(synth: dict | None) -> str:
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


def friction_patterns(synth: dict | None) -> str:
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


def render(analysis: dict, synth: dict | None) -> str:
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
        "{{HOUR_CHART}}": hour_chart(analysis.get("by_hour", [0] * 24)),
        "{{AGENT_TABLE}}": agent_table(analysis.get("by_agent", [])),
        "{{PROJECT_TABLE}}": project_table(analysis.get("by_project", [])),
        "{{THEMES_SECTION}}": themes_section(synth),
        "{{FRICTION_CARDS}}": friction_cards(analysis.get("friction", {})),
        "{{FRICTION_PATTERNS}}": friction_patterns(synth),
        "{{FRICTION_TABLE}}": friction_table(analysis.get("top_friction_sessions", [])),
    }
    out = TEMPLATE.read_text(encoding="utf-8")
    for k, v in repl.items():
        out = out.replace(k, v)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Render analysis.json into a styled HTML report.")
    ap.add_argument("--analysis", required=True, help="Path to analysis.json from analyze.py")
    ap.add_argument("--synthesis", help="Optional synthesis.json with themes/friction_patterns")
    ap.add_argument("--out", required=True, help="Path to write the HTML report")
    args = ap.parse_args()

    analysis = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    synth = None
    if args.synthesis and Path(args.synthesis).exists():
        synth = json.loads(Path(args.synthesis).read_text(encoding="utf-8"))

    Path(args.out).write_text(render(analysis, synth), encoding="utf-8")
    print(f"Wrote report -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
