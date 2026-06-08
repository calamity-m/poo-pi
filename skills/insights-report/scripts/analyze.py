#!/usr/bin/env python3
"""Aggregate a sessions.json index into deterministic statistics for the report.

Reads the output of fetch_sessions.py and produces analysis.json: totals, activity
over time, per-agent and per-project breakdowns, an hour-of-day histogram, and a
ranked list of the most friction-heavy sessions. Everything here is pure counting —
no LLM, fully reproducible — so the qualitative synthesis stays a separate concern.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path


def _date(iso: str | None) -> dt.date | None:
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso).date()
    except ValueError:
        return None


def _hour(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso).hour
    except ValueError:
        return None


def _longest_streak(days: set[dt.date]) -> int:
    """Longest run of consecutive active days."""
    if not days:
        return 0
    ordered = sorted(days)
    best = run = 1
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if (cur - prev).days == 1 else 1
        best = max(best, run)
    return best


def analyze(index: dict) -> dict:
    """Turn a sessions.json index into the analysis.json structure."""
    sessions = index.get("sessions", [])

    totals_friction = {"cancels": 0, "rejections": 0, "errors": 0}
    by_agent: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "duration_hours": 0.0, "tool_calls": 0,
                 "cancels": 0, "rejections": 0, "errors": 0}
    )
    by_project: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "duration_hours": 0.0, "agents": set(),
                 "cancels": 0, "rejections": 0}
    )
    by_day: dict[dt.date, dict] = defaultdict(lambda: {"sessions": 0, "duration_hours": 0.0})
    by_hour = [0] * 24
    active_days: set[dt.date] = set()
    total_duration_h = 0.0
    total_tool_calls = 0
    total_user_prompts = 0

    for s in sessions:
        agent = s["agent"]
        dur_h = s.get("duration_min", 0) / 60.0
        fr = s.get("friction", {})
        counts = s.get("counts", {})

        total_duration_h += dur_h
        total_tool_calls += counts.get("tool_calls", 0)
        total_user_prompts += counts.get("user", 0)
        for k in totals_friction:
            totals_friction[k] += fr.get(k, 0)

        a = by_agent[agent]
        a["sessions"] += 1
        a["duration_hours"] += dur_h
        a["tool_calls"] += counts.get("tool_calls", 0)
        for k in ("cancels", "rejections", "errors"):
            a[k] += fr.get(k, 0)

        p = by_project[s.get("project", "(unknown)")]
        p["sessions"] += 1
        p["duration_hours"] += dur_h
        p["agents"].add(agent)
        p["cancels"] += fr.get("cancels", 0)
        p["rejections"] += fr.get("rejections", 0)

        d = _date(s.get("start"))
        if d:
            active_days.add(d)
            by_day[d]["sessions"] += 1
            by_day[d]["duration_hours"] += dur_h
        h = _hour(s.get("start"))
        if h is not None:
            by_hour[h] += 1

    # Rank sessions by total friction for a "where it hurt" table.
    ranked = sorted(
        sessions,
        key=lambda s: s["friction"]["cancels"] + s["friction"]["rejections"] + s["friction"]["errors"],
        reverse=True,
    )
    top_friction = [
        {
            "agent": s["agent"],
            "project": s["project"],
            "session_id": s["session_id"],
            "start": s["start"],
            "cancels": s["friction"]["cancels"],
            "rejections": s["friction"]["rejections"],
            "errors": s["friction"]["errors"],
            "first_user_prompt": s["first_user_prompt"],
        }
        for s in ranked
        if (s["friction"]["cancels"] + s["friction"]["rejections"] + s["friction"]["errors"]) > 0
    ][:15]

    busiest = max(by_day.items(), key=lambda kv: kv[1]["sessions"], default=(None, None))

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "window": index.get("window", {}),
        "filters": index.get("filters", {}),
        "totals": {
            "sessions": len(sessions),
            "messages": sum(s.get("counts", {}).get("messages", 0) for s in sessions),
            "user_prompts": total_user_prompts,
            "tool_calls": total_tool_calls,
            "duration_hours": round(total_duration_h, 1),
            "active_days": len(active_days),
            "longest_streak_days": _longest_streak(active_days),
            "projects": len(by_project),
        },
        "friction": totals_friction,
        "busiest_day": (
            {"date": busiest[0].isoformat(), "sessions": busiest[1]["sessions"]}
            if busiest[0] else None
        ),
        "by_agent": sorted(
            ({"agent": k, **v, "duration_hours": round(v["duration_hours"], 1)}
             for k, v in by_agent.items()),
            key=lambda x: x["sessions"], reverse=True,
        ),
        "by_project": sorted(
            ({"project": k, "sessions": v["sessions"],
              "duration_hours": round(v["duration_hours"], 1),
              "agents": sorted(v["agents"]),
              "cancels": v["cancels"], "rejections": v["rejections"]}
             for k, v in by_project.items()),
            key=lambda x: x["sessions"], reverse=True,
        )[:20],
        "by_day": [
            {"date": d.isoformat(), "sessions": by_day[d]["sessions"],
             "duration_hours": round(by_day[d]["duration_hours"], 1)}
            for d in sorted(by_day)
        ],
        "by_hour": by_hour,
        "top_friction_sessions": top_friction,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Aggregate sessions.json into analysis.json.")
    ap.add_argument("--sessions", required=True, help="Path to sessions.json from fetch_sessions.py")
    ap.add_argument("--out", required=True, help="Path to write analysis.json")
    args = ap.parse_args()

    index = json.loads(Path(args.sessions).read_text(encoding="utf-8"))
    analysis = analyze(index)
    Path(args.out).write_text(json.dumps(analysis, indent=2), encoding="utf-8")
    t = analysis["totals"]
    print(f"Analyzed {t['sessions']} sessions across {t['projects']} projects "
          f"({t['active_days']} active days) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
