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
import statistics
from collections import Counter, defaultdict
from pathlib import Path


def _local(iso: str | None) -> dt.datetime | None:
    """Parse an ISO timestamp and convert to the local timezone.

    Session timestamps are stored as UTC; bucketing days/hours without converting
    would shift the "when you work" chart and day boundaries for non-UTC users.
    """
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso).astimezone()
    except ValueError:
        return None


def _date(iso: str | None) -> dt.date | None:
    d = _local(iso)
    return d.date() if d else None


def _hour(iso: str | None) -> int | None:
    d = _local(iso)
    return d.hour if d else None


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


def _percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile for short deterministic report summaries."""
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * pct)))
    return ordered[idx]


def _session_length_summary(minutes: list[float], abandoned: int = 0) -> dict:
    """Summarize active session durations to reveal context-window hygiene patterns.

    `abandoned` counts false starts (at most one prompt and under two active
    minutes), which would otherwise hide inside the <15m bucket.
    """
    nonzero = [m for m in minutes if m > 0]
    if not nonzero:
        return {"avg_min": 0, "median_min": 0, "p90_min": 0, "max_min": 0, "over_120_min": 0,
                "abandoned": abandoned, "buckets": {}}
    buckets = {
        "<15m": sum(1 for m in nonzero if m < 15),
        "15–60m": sum(1 for m in nonzero if 15 <= m < 60),
        "1–2h": sum(1 for m in nonzero if 60 <= m < 120),
        "2h+": sum(1 for m in nonzero if m >= 120),
    }
    over_120 = buckets["2h+"]
    interpretation = (
        "Many sessions crossed two hours; consider intentional context resets or summary handoffs."
        if over_120 >= max(3, len(nonzero) * 0.1)
        else "Session lengths look mostly bounded; keep using resets when a thread changes direction."
    )
    return {
        "avg_min": round(sum(nonzero) / len(nonzero), 1),
        "median_min": round(statistics.median(nonzero), 1),
        "p90_min": round(_percentile(nonzero, 0.9), 1),
        "max_min": round(max(nonzero), 1),
        "over_120_min": over_120,
        "abandoned": abandoned,
        "buckets": buckets,
        "interpretation": interpretation,
        "note": "Durations are active time (idle gaps over 30 min are excluded), not wall-clock span.",
    }


def _compaction_summary(totals: dict, sessions_total: int, with_compaction: int, with_auto: int) -> dict:
    """Summarize compaction activity, flagging auto-compaction as a hygiene signal.

    Claude Code records whether a compaction was automatic inline; Pi records the
    trigger when the bundled core extension persisted metadata from Pi's compaction
    event. Anything else is unknown-trigger.
    """
    total = totals["total"]
    unknown = total - totals["auto"] - totals["manual"]
    if total == 0:
        interpretation = "No compaction events detected in range — sessions stayed within their context windows."
    elif totals["auto"]:
        interpretation = (
            f"{totals['auto']} automatic compactions across {with_auto} sessions. Auto-compaction "
            "fires when context overflows mid-task and can silently drop detail; prefer compacting at "
            "clean checkpoints or starting a fresh session before the window fills."
        )
    else:
        interpretation = (
            f"{total} compactions across {with_compaction} sessions. Some agents or older Pi sessions "
            "do not persist the trigger, so unknown-trigger compactions may be mixed in."
        )
    return {
        "total": total,
        "auto": totals["auto"],
        "manual": totals["manual"],
        "threshold": totals.get("threshold", 0),
        "overflow": totals.get("overflow", 0),
        "unknown_trigger": unknown,
        "sessions_with_compaction": with_compaction,
        "sessions_with_auto": with_auto,
        "share_of_sessions": round(with_compaction / sessions_total, 2) if sessions_total else 0,
        "interpretation": interpretation,
    }


def _tokens_summary(totals: dict, sessions_total: int) -> dict:
    """Summarize best-effort token usage; cache reads are kept separate from work tokens."""
    work = totals["input"] + totals["output"]
    cache_read = totals["cache_read"]
    if work == 0:
        interpretation = "No token usage recorded in range, or the agents in use do not log it."
    else:
        ratio = cache_read / work if work else 0
        interpretation = (
            f"{work:,} work tokens (input+output) and {cache_read:,} cache-read tokens. "
            + (
                "Cache reads far exceed fresh work — usually this just reflects many turns with prompt "
                "caching doing its job; it only suggests context bloat if paired with heavy auto-compaction."
                if ratio >= 3
                else "Token use looks proportionate to the work done."
            )
        )
    return {
        "input": totals["input"],
        "output": totals["output"],
        "cache_read": cache_read,
        "work": work,
        "avg_work_per_session": round(work / sessions_total) if sessions_total else 0,
        "interpretation": interpretation,
        "note": "Best-effort: summed per-turn for Claude Code/Pi/OpenCode, from the final cumulative reading for Codex. Not billing-accurate.",
    }


def _trend(by_day: dict) -> dict | None:
    """Compare the first and second halves of the window for a simple trend signal.

    Splits at the calendar midpoint of the observed date span (not at the median
    active day, which would bias toward whichever half was busier).
    """
    if len(by_day) < 4:
        return None
    days = sorted(by_day)
    mid = days[0] + (days[-1] - days[0]) / 2
    first = [v for d, v in by_day.items() if d <= mid]
    second = [v for d, v in by_day.items() if d > mid]
    f_sessions = sum(v["sessions"] for v in first)
    s_sessions = sum(v["sessions"] for v in second)
    f_hours = sum(v["duration_hours"] for v in first)
    s_hours = sum(v["duration_hours"] for v in second)
    pct = round((s_sessions - f_sessions) / f_sessions * 100) if f_sessions else None
    return {
        "first_half": {"sessions": f_sessions, "duration_hours": round(f_hours, 1)},
        "second_half": {"sessions": s_sessions, "duration_hours": round(s_hours, 1)},
        "sessions_change_pct": pct,
    }


def _per_100(numerator: int, denominator: int) -> float:
    """Rate per 100 events, so friction is comparable across busy and quiet rows."""
    return round(numerator / denominator * 100, 1) if denominator else 0.0


def analyze(index: dict) -> dict:
    """Turn a sessions.json index into the analysis.json structure."""
    sessions = index.get("sessions", [])

    totals_friction = {"cancels": 0, "rejections": 0, "errors": 0}
    totals_compaction = {"total": 0, "auto": 0, "manual": 0, "threshold": 0, "overflow": 0}
    totals_tokens = {"input": 0, "output": 0, "cache_read": 0}
    sessions_with_compaction = 0
    sessions_with_auto = 0
    by_agent: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "duration_hours": 0.0, "tool_calls": 0, "user_prompts": 0,
                 "cancels": 0, "rejections": 0, "errors": 0,
                 "compactions": 0, "auto_compactions": 0, "manual_compactions": 0,
                 "threshold_compactions": 0, "overflow_compactions": 0, "tokens": 0}
    )
    by_project: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "duration_hours": 0.0, "agents": set(), "agent_counts": Counter(),
                 "cancels": 0, "rejections": 0, "errors": 0, "duration_minutes": [],
                 "tokens": 0, "tool_calls": 0}
    )
    by_day: dict[dt.date, dict] = defaultdict(lambda: {"sessions": 0, "duration_hours": 0.0})
    by_hour = [0] * 24
    by_weekday = [0] * 7  # Monday..Sunday, local time
    by_model: Counter = Counter()
    by_tool: dict[str, dict] = defaultdict(lambda: {"calls": 0, "errors": 0})
    active_days: set[dt.date] = set()
    total_duration_h = 0.0
    total_tool_calls = 0
    total_user_prompts = 0
    abandoned = 0
    session_minutes: list[float] = []

    for s in sessions:
        agent = s["agent"]
        # Prefer gap-capped active time; fall back to wall-clock span for old indexes.
        dur_min = s["active_min"] if "active_min" in s else s.get("duration_min", 0)
        dur_h = dur_min / 60.0
        fr = s.get("friction", {})
        cp = s.get("compaction", {})
        tok = s.get("tokens", {})
        session_tokens = tok.get("input", 0) + tok.get("output", 0)
        counts = s.get("counts", {})

        session_minutes.append(dur_min)
        if counts.get("user", 0) <= 1 and dur_min < 2:
            abandoned += 1
        for model in s.get("models", []):
            by_model[model] += 1
        for name, t in (s.get("tools") or {}).items():
            by_tool[name]["calls"] += t.get("calls", 0)
            by_tool[name]["errors"] += t.get("errors", 0)
        total_duration_h += dur_h
        total_tool_calls += counts.get("tool_calls", 0)
        total_user_prompts += counts.get("user", 0)
        for k in totals_friction:
            totals_friction[k] += fr.get(k, 0)
        for k in totals_compaction:
            totals_compaction[k] += cp.get(k, 0)
        for k in totals_tokens:
            totals_tokens[k] += tok.get(k, 0)
        if cp.get("total", 0):
            sessions_with_compaction += 1
        if cp.get("auto", 0):
            sessions_with_auto += 1

        a = by_agent[agent]
        a["sessions"] += 1
        a["duration_hours"] += dur_h
        a["tool_calls"] += counts.get("tool_calls", 0)
        a["user_prompts"] += counts.get("user", 0)
        for k in ("cancels", "rejections", "errors"):
            a[k] += fr.get(k, 0)
        a["compactions"] += cp.get("total", 0)
        a["auto_compactions"] += cp.get("auto", 0)
        a["manual_compactions"] += cp.get("manual", 0)
        a["threshold_compactions"] += cp.get("threshold", 0)
        a["overflow_compactions"] += cp.get("overflow", 0)
        a["tokens"] += session_tokens

        p = by_project[s.get("project", "(unknown)")]
        p["sessions"] += 1
        p["duration_hours"] += dur_h
        p["duration_minutes"].append(dur_min)
        p["agents"].add(agent)
        p["agent_counts"][agent] += 1
        p["cancels"] += fr.get("cancels", 0)
        p["rejections"] += fr.get("rejections", 0)
        p["errors"] += fr.get("errors", 0)
        p["tokens"] += session_tokens
        p["tool_calls"] += counts.get("tool_calls", 0)

        d = _date(s.get("start"))
        if d:
            active_days.add(d)
            by_day[d]["sessions"] += 1
            by_day[d]["duration_hours"] += dur_h
            by_weekday[d.weekday()] += 1
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
            "duration_min": s["active_min"] if "active_min" in s else s.get("duration_min", 0),
            "tool_calls": s.get("counts", {}).get("tool_calls", 0),
            # Rate column: absolute counts favor long sessions, so show both.
            "per_100_tools": _per_100(
                s["friction"]["cancels"] + s["friction"]["rejections"] + s["friction"]["errors"],
                s.get("counts", {}).get("tool_calls", 0),
            ),
            "first_user_prompt": s["first_user_prompt"],
        }
        for s in ranked
        if (s["friction"]["cancels"] + s["friction"]["rejections"] + s["friction"]["errors"]) > 0
    ][:15]

    busiest_date, busiest_stats = max(
        by_day.items(), key=lambda kv: kv[1]["sessions"], default=(None, None)
    )

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
        "friction_buckets": {
            "user_interruption_cancel": totals_friction["cancels"],
            "permission_rejection": totals_friction["rejections"],
            "tool_runtime_error": totals_friction["errors"],
        },
        "session_lengths": _session_length_summary(session_minutes, abandoned),
        "compaction": _compaction_summary(
            totals_compaction, len(sessions), sessions_with_compaction, sessions_with_auto
        ),
        "tokens": _tokens_summary(totals_tokens, len(sessions)),
        "busiest_day": (
            {"date": busiest_date.isoformat(), "sessions": busiest_stats["sessions"]}
            if busiest_date is not None and busiest_stats is not None else None
        ),
        "by_agent": sorted(
            ({"agent": k, **v, "duration_hours": round(v["duration_hours"], 1),
              "friction_per_100_tools": _per_100(
                  v["cancels"] + v["rejections"] + v["errors"], v["tool_calls"]),
              "tools_per_prompt": round(v["tool_calls"] / v["user_prompts"], 1)
              if v["user_prompts"] else 0}
             for k, v in by_agent.items()),
            key=lambda x: x["sessions"], reverse=True,
        ),
        "by_model": [
            {"model": m, "sessions": c} for m, c in by_model.most_common()
        ],
        "by_tool": sorted(
            ({"tool": k, "calls": v["calls"], "errors": v["errors"],
              "error_pct": _per_100(v["errors"], v["calls"])}
             for k, v in by_tool.items()),
            key=lambda x: x["calls"], reverse=True,
        )[:15],
        "by_project": sorted(
            ({"project": k, "sessions": v["sessions"],
              "duration_hours": round(v["duration_hours"], 1),
              "avg_duration_min": round(sum(v["duration_minutes"]) / len(v["duration_minutes"]), 1)
              if v["duration_minutes"] else 0,
              "dominant_agent": v["agent_counts"].most_common(1)[0][0] if v["agent_counts"] else None,
              "agents": sorted(v["agents"]),
              "cancels": v["cancels"], "rejections": v["rejections"], "errors": v["errors"],
              "friction_per_100_tools": _per_100(
                  v["cancels"] + v["rejections"] + v["errors"], v["tool_calls"]),
              "tokens": v["tokens"]}
             for k, v in by_project.items()),
            key=lambda x: x["sessions"], reverse=True,
        )[:20],
        "by_day": [
            {"date": d.isoformat(), "sessions": by_day[d]["sessions"],
             "duration_hours": round(by_day[d]["duration_hours"], 1)}
            for d in sorted(by_day)
        ],
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "trend": _trend(by_day),
        "friction_support": index.get("friction_support") or {},
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
