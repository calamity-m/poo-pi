#!/usr/bin/env python3
"""Fixture-based tests for the insights-report pipeline scripts.

Each test builds a tiny synthetic session store (JSONL / SQLite) and checks the
parsers, aggregation, digesting, merging, and rendering against known-good
numbers. Run from the skill directory:

    python3 -m unittest discover -s scripts/tests
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

import analyze as analyze_mod  # noqa: E402
import fetch_sessions as fetch  # noqa: E402
import merge_synthesis  # noqa: E402
import render_report  # noqa: E402


def setUpModule() -> None:
    """Pin the local timezone so local-time bucketing assertions are stable."""
    os.environ["TZ"] = "Australia/Sydney"  # UTC+10 in June (no DST)
    time.tzset()


def _write_jsonl(path: Path, events: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")


class ClaudeCodeParserTest(unittest.TestCase):
    """Covers usage dedupe, tool_result folding/errors, cancels, compaction."""

    def _parse(self, events: list[dict]) -> fetch.Session:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_jsonl(root / "proj" / "abc.jsonl", events)
            sessions = fetch.parse_claude_code(root)
        self.assertEqual(len(sessions), 1)
        return sessions[0]

    def test_usage_deduped_by_message_id(self) -> None:
        usage = {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 1000}
        s = self._parse([
            {"cwd": "/h/proj-a", "timestamp": "2026-06-01T00:00:00Z",
             "message": {"role": "user", "content": "fix the bug"}},
            # Same turn split across two lines (text block, then tool_use block):
            # usage repeats and must be counted once.
            {"timestamp": "2026-06-01T00:01:00Z",
             "message": {"id": "m1", "role": "assistant", "usage": usage,
                         "content": [{"type": "text", "text": "working"}]}},
            {"timestamp": "2026-06-01T00:01:05Z",
             "message": {"id": "m1", "role": "assistant", "usage": usage,
                         "content": [{"type": "tool_use", "name": "Bash", "id": "tu1"}]}},
        ])
        self.assertEqual(s.tokens_input, 100)
        self.assertEqual(s.tokens_output, 50)
        self.assertEqual(s.tokens_cache_read, 1000)

    def test_tool_result_folds_into_call_and_counts_error(self) -> None:
        s = self._parse([
            {"cwd": "/h/proj-a", "timestamp": "2026-06-01T00:00:00Z",
             "message": {"role": "user", "content": "run it"}},
            {"timestamp": "2026-06-01T00:01:00Z",
             "message": {"id": "m1", "role": "assistant",
                         "content": [{"type": "tool_use", "name": "Bash", "id": "tu1"}]}},
            {"timestamp": "2026-06-01T00:02:00Z",
             "message": {"role": "user",
                         "content": [{"type": "tool_result", "tool_use_id": "tu1",
                                      "is_error": True, "content": "boom"}]}},
        ])
        tool_msgs = [m for m in s.messages if m.role == "tool"]
        self.assertEqual(len(tool_msgs), 1)  # call + result = one tool turn
        self.assertTrue(tool_msgs[0].is_error)
        self.assertEqual(s.errors, 1)

    def test_cancels_and_auto_compaction(self) -> None:
        s = self._parse([
            {"cwd": "/h/proj-a", "timestamp": "2026-06-01T00:00:00Z",
             "message": {"role": "user", "content": "go"}},
            {"type": "system", "subtype": "compact_boundary",
             "compactMetadata": {"trigger": "auto"}},
            {"timestamp": "2026-06-01T00:03:00Z",
             "message": {"role": "user", "content": "[Request interrupted by user]"}},
        ])
        self.assertEqual(s.cancels, 1)
        self.assertEqual(s.compactions, 1)
        self.assertEqual(s.auto_compactions, 1)


class PiParserTest(unittest.TestCase):
    def test_friction_tokens_and_single_tool_turns(self) -> None:
        events = [
            {"type": "session", "id": "s1", "cwd": "/h/proj-b"},
            {"type": "message", "message": {
                "role": "user", "timestamp": 1750000000000,
                "content": [{"type": "text", "text": "hello"}]}},
            {"type": "message", "message": {
                "role": "assistant", "timestamp": 1750000060000, "stopReason": "aborted",
                "model": "m1", "usage": {"input": 10, "output": 5, "cacheRead": 7},
                "content": [{"type": "text", "text": "hi"},
                            {"type": "tool_call", "name": "bash"}]}},
            {"type": "message", "message": {
                "role": "toolResult", "timestamp": 1750000120000,
                "toolName": "bash", "isError": True}},
            {"type": "compaction", "tokensBefore": 1},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_jsonl(root / "proj" / "x.jsonl", events)
            sessions = fetch.parse_pi(root)
        self.assertEqual(len(sessions), 1)
        s = sessions[0]
        self.assertEqual(s.cancels, 1)
        self.assertEqual(s.errors, 1)  # toolResult isError
        self.assertEqual(s.compactions, 1)
        self.assertEqual((s.tokens_input, s.tokens_output, s.tokens_cache_read), (10, 5, 7))
        # toolResult is the canonical tool turn; assistant tool_call blocks don't double it.
        self.assertEqual(sum(1 for m in s.messages if m.role == "tool"), 1)

    def test_compaction_metadata_distinguishes_pi_triggers(self) -> None:
        events = [
            {"type": "session", "id": "s1", "cwd": "/h/proj-b"},
            {"type": "message", "message": {
                "role": "user", "timestamp": 1750000000000,
                "content": [{"type": "text", "text": "hello"}]}},
            {"type": "compaction", "id": "c-manual", "tokensBefore": 1},
            {"type": "custom", "customType": fetch.PI_COMPACTION_METADATA_CUSTOM_TYPE,
             "data": {"compactionEntryId": "c-manual", "reason": "manual", "willRetry": False}},
            {"type": "compaction", "id": "c-threshold", "tokensBefore": 2},
            {"type": "custom", "customType": fetch.PI_COMPACTION_METADATA_CUSTOM_TYPE,
             "data": {"compactionEntryId": "c-threshold", "reason": "threshold", "willRetry": False}},
            {"type": "compaction", "id": "c-overflow", "tokensBefore": 3},
            {"type": "custom", "customType": fetch.PI_COMPACTION_METADATA_CUSTOM_TYPE,
             "data": {"compactionEntryId": "c-overflow", "reason": "overflow", "willRetry": True}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_jsonl(root / "proj" / "x.jsonl", events)
            sessions = fetch.parse_pi(root)
        s = sessions[0]
        self.assertEqual(s.compactions, 3)
        self.assertEqual(s.manual_compactions, 1)
        self.assertEqual(s.auto_compactions, 2)
        self.assertEqual(s.threshold_compactions, 1)
        self.assertEqual(s.overflow_compactions, 1)


class CodexParserTest(unittest.TestCase):
    def test_cumulative_tokens_and_cancel(self) -> None:
        events = [
            {"type": "session_meta", "timestamp": "2026-06-01T00:00:00Z",
             "payload": {"id": "c1", "cwd": "/h/proj-c", "model": "gpt"}},
            {"type": "response_item", "timestamp": "2026-06-01T00:00:10Z",
             "payload": {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "do thing"}]}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": 100, "cached_input_tokens": 40,
                                      "output_tokens": 20}}}},
            {"type": "event_msg", "payload": {"type": "turn_aborted"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": 200, "cached_input_tokens": 80,
                                      "output_tokens": 50}}}},
            {"type": "response_item", "timestamp": "2026-06-01T00:01:00Z",
             "payload": {"type": "function_call", "name": "shell"}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_jsonl(root / "2026" / "06" / "01" / "rollout-1.jsonl", events)
            sessions = fetch.parse_codex(root)
        self.assertEqual(len(sessions), 1)
        s = sessions[0]
        # Last cumulative reading wins; fresh input excludes cached.
        self.assertEqual((s.tokens_input, s.tokens_output, s.tokens_cache_read), (120, 50, 80))
        self.assertEqual(s.cancels, 1)


class OpenCodeParserTest(unittest.TestCase):
    def test_errors_rejections_and_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "opencode.db"
            con = sqlite3.connect(db)
            con.executescript(
                "CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT);"
                "CREATE TABLE message (session_id TEXT, data TEXT, time_created INTEGER);"
                "CREATE TABLE part (session_id TEXT, data TEXT);"
                "CREATE TABLE permission (project_id TEXT, data TEXT);"
            )
            con.execute("INSERT INTO session VALUES ('s1', 'p1', '/h/proj-d')")
            con.execute(
                "INSERT INTO message VALUES ('s1', ?, 1750000000000)",
                (json.dumps({"role": "assistant", "modelID": "m",
                             "tokens": {"input": 9, "output": 4, "cache": {"read": 2}}}),),
            )
            con.execute(
                "INSERT INTO part VALUES ('s1', ?)",
                (json.dumps({"type": "tool", "tool": "bash",
                             "state": {"status": "error"}}),),
            )
            con.execute(
                "INSERT INTO permission VALUES ('p1', ?)",
                (json.dumps({"status": "denied"}),),
            )
            con.commit()
            con.close()
            sessions = fetch.parse_opencode(db)
        self.assertEqual(len(sessions), 1)
        s = sessions[0]
        self.assertEqual(s.errors, 1)
        self.assertEqual(s.rejections, 1)
        self.assertEqual((s.tokens_input, s.tokens_output, s.tokens_cache_read), (9, 4, 2))


class SessionShapeTest(unittest.TestCase):
    def _session(self, ts_list: list[float]) -> fetch.Session:
        s = fetch.Session(agent="pi", session_id="x", source_path="x", cwd="/h/p")
        for i, ts in enumerate(ts_list):
            s.messages.append(fetch.Message("user" if i % 2 == 0 else "assistant", ts, f"t{i}"))
        return s

    def test_active_minutes_caps_idle_gaps(self) -> None:
        # 10 min of work, then a 2 h idle gap (capped at 30 min), then 5 min.
        base = 1750000000.0
        s = self._session([base, base + 600, base + 600 + 7200, base + 600 + 7200 + 300])
        self.assertEqual(s.active_minutes, 10 + 30 + 5)

    def test_digest_keeps_head_and_tail(self) -> None:
        s = fetch.Session(agent="pi", session_id="x", source_path="x", cwd="/h/p")
        s.messages.append(fetch.Message("user", 1.0, "FIRST-MARKER " + "a" * 200))
        for i in range(200):
            s.messages.append(fetch.Message("assistant", float(i + 2), f"mid {i} " + "b" * 100))
        s.messages.append(fetch.Message("user", 999.0, "LAST-MARKER " + "c" * 200))
        digest = fetch.build_digest(s)
        self.assertLessEqual(len(digest), fetch.DIGEST_CHAR_CAP + 100)
        self.assertIn("FIRST-MARKER", digest)
        self.assertIn("LAST-MARKER", digest)
        self.assertIn("turns omitted", digest)


class WindowFilterTest(unittest.TestCase):
    def test_window_matches_last_activity(self) -> None:
        now_ms = int(time.time() * 1000)
        old_ms = now_ms - 60 * 86400 * 1000
        resumed = [  # started 60 days ago, resumed today -> must be kept
            {"type": "session", "id": "s-old-start", "cwd": "/h/proj-e"},
            {"type": "message", "message": {"role": "user", "timestamp": old_ms,
                                            "content": [{"type": "text", "text": "start"}]}},
            {"type": "message", "message": {"role": "user", "timestamp": now_ms,
                                            "content": [{"type": "text", "text": "resume"}]}},
        ]
        stale = [  # all activity 60 days ago -> must be dropped
            {"type": "session", "id": "s-stale", "cwd": "/h/proj-e"},
            {"type": "message", "message": {"role": "user", "timestamp": old_ms,
                                            "content": [{"type": "text", "text": "old"}]}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            home, out = Path(tmp) / "home", Path(tmp) / "out"
            _write_jsonl(home / ".pi" / "agent" / "sessions" / "p" / "a.jsonl", resumed)
            _write_jsonl(home / ".pi" / "agent" / "sessions" / "p" / "b.jsonl", stale)
            argv = ["fetch_sessions.py", "--out-dir", str(out), "--agent", "pi",
                    "--days", "30", "--home", str(home)]
            with mock.patch.object(sys, "argv", argv):
                fetch.main()
            index = json.loads((out / "sessions.json").read_text(encoding="utf-8"))
        ids = [s["session_id"] for s in index["sessions"]]
        self.assertEqual(ids, ["s-old-start"])
        self.assertIn("friction_support", index)


class AnalyzeTest(unittest.TestCase):
    @staticmethod
    def _session(**over) -> dict:
        base = {
            "agent": "pi", "session_id": "s", "project": "proj", "cwd": "/h/proj",
            "start": "2026-06-09T20:00:00+00:00", "end": "2026-06-09T21:00:00+00:00",
            "duration_min": 60.0, "active_min": 45.0, "models": ["model-a"],
            "counts": {"user": 5, "assistant": 5, "tool_calls": 20, "messages": 30},
            "friction": {"cancels": 1, "rejections": 0, "errors": 1},
            "compaction": {"total": 0, "auto": 0, "manual": 0, "threshold": 0, "overflow": 0},
            "tokens": {"input": 100, "output": 50, "cache_read": 0, "total": 150},
            "tools": {"bash": {"calls": 15, "errors": 1}, "edit": {"calls": 5, "errors": 0}},
            "first_user_prompt": "do the thing",
        }
        base.update(over)
        return base

    def test_local_timezone_bucketing(self) -> None:
        # 2026-06-09 20:00 UTC == 2026-06-10 06:00 in Australia/Sydney (UTC+10).
        analysis = analyze_mod.analyze({"sessions": [self._session()]})
        self.assertEqual(analysis["by_hour"][6], 1)
        self.assertEqual(analysis["by_day"][0]["date"], "2026-06-10")
        self.assertEqual(analysis["by_weekday"][2], 1)  # 2026-06-10 is a Wednesday

    def test_active_time_models_tools_rates_and_abandoned(self) -> None:
        sessions = [
            self._session(),
            self._session(session_id="ghost", active_min=0.5, duration_min=300.0,
                          counts={"user": 1, "assistant": 1, "tool_calls": 0, "messages": 2},
                          friction={"cancels": 0, "rejections": 0, "errors": 0},
                          tools={}, models=["model-b"]),
        ]
        analysis = analyze_mod.analyze({"sessions": sessions,
                                        "friction_support": fetch.FRICTION_SUPPORT})
        # Active time (45.0 + 0.5 min), not wall-clock span (60 + 300 min).
        self.assertAlmostEqual(analysis["totals"]["duration_hours"], round(45.5 / 60, 1))
        self.assertEqual(analysis["session_lengths"]["abandoned"], 1)
        self.assertEqual({m["model"] for m in analysis["by_model"]}, {"model-a", "model-b"})
        bash = next(t for t in analysis["by_tool"] if t["tool"] == "bash")
        self.assertEqual((bash["calls"], bash["errors"]), (15, 1))
        agent = analysis["by_agent"][0]
        self.assertEqual(agent["friction_per_100_tools"], 10.0)  # 2 friction / 20 tools
        self.assertEqual(analysis["friction_support"]["pi"]["errors"], True)

    def test_trend_splits_window(self) -> None:
        sessions = [
            self._session(start=f"2026-06-0{d}T01:00:00+00:00",
                          end=f"2026-06-0{d}T02:00:00+00:00")
            for d in (1, 2, 7, 8)
        ]
        trend = analyze_mod.analyze({"sessions": sessions})["trend"]
        self.assertIsNotNone(trend)
        self.assertEqual(trend["first_half"]["sessions"], 2)
        self.assertEqual(trend["second_half"]["sessions"], 2)

    def test_compaction_reason_breakdown(self) -> None:
        session = self._session(compaction={
            "total": 3,
            "auto": 2,
            "manual": 1,
            "threshold": 1,
            "overflow": 1,
        })
        analysis = analyze_mod.analyze({"sessions": [session]})
        self.assertEqual(analysis["compaction"]["manual"], 1)
        self.assertEqual(analysis["compaction"]["threshold"], 1)
        self.assertEqual(analysis["compaction"]["overflow"], 1)
        agent = analysis["by_agent"][0]
        self.assertEqual(agent["manual_compactions"], 1)
        self.assertEqual(agent["overflow_compactions"], 1)


class MergeSynthesisTest(unittest.TestCase):
    def test_bad_batch_is_skipped_and_counted(self) -> None:
        good = {
            "schema_version": 3,
            "themes": [{"title": "API work", "summary": "s", "projects": ["p"], "sessions": 2}],
            "metadata": {"digest_count": 2, "batch_count": 1, "failed_batches": 0},
        }
        with tempfile.TemporaryDirectory() as tmp:
            p1 = Path(tmp) / "b1.json"
            p2 = Path(tmp) / "b2.json"
            p1.write_text(json.dumps(good), encoding="utf-8")
            p2.write_text("not json{", encoding="utf-8")
            merged = merge_synthesis.merge([p1, p2])
        self.assertEqual(merged["metadata"]["failed_batches"], 1)
        self.assertEqual(merged["metadata"]["batch_count"], 2)
        self.assertEqual(len(merged["themes"]), 1)


class RenderTest(unittest.TestCase):
    def test_end_to_end_render_has_no_placeholders(self) -> None:
        analysis = analyze_mod.analyze({
            "sessions": [AnalyzeTest._session()],
            "window": {"since": None, "days": 30},
            "friction_support": fetch.FRICTION_SUPPORT,
        })
        html_out = render_report.render(analysis, None)
        self.assertNotIn("{{", html_out)
        # Codex never tracks errors: an all-agents report must show n/a, not 0 —
        # here the single pi session does track errors, so no dash in its row.
        self.assertIn("Friction/100 tools", html_out)
        self.assertIn("model-a", html_out)

    def test_untracked_counter_renders_dash(self) -> None:
        cell = render_report._friction_cell(
            "codex", "errors", 0, fetch.FRICTION_SUPPORT
        )
        self.assertIn("—", cell)
        tracked = render_report._friction_cell(
            "pi", "errors", 3, fetch.FRICTION_SUPPORT
        )
        self.assertIn(">3<", tracked)


if __name__ == "__main__":
    unittest.main()
