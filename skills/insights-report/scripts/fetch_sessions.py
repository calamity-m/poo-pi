#!/usr/bin/env python3
"""Discover and normalize coding-agent sessions into a single index + digests.

This script is intentionally dependency-free (Python 3 standard library only) so
the `insights` skill stays agnostic of any particular coding agent. It knows how
four agents store their sessions on disk and converts each into a common shape:

  - Claude Code : ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl  (one JSON event per line)
  - Codex       : ~/.codex/sessions/Y/M/D/rollout-*.jsonl        (typed payload lines)
  - Pi          : ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl (typed lines)
  - OpenCode    : ~/.local/share/opencode/opencode.db            (SQLite: session/message/part/permission)

Outputs (under --out-dir):
  - sessions.json            : list of per-session metadata, counts, and friction signals
  - digests/<agent>__<id>.md : condensed transcript for sub-agent synthesis (no raw dumps)

The deliberate split — lightweight index here, condensed digests for the LLM —
keeps the calling agent's context window clean: it never reads raw sessions.

See ../references/session-formats.md for the format and friction-signal details.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Per-session caps so digests stay small enough to fan out to sub-agents cheaply.
USER_TEXT_CAP = 600
ASSISTANT_TEXT_CAP = 220
DIGEST_CHAR_CAP = 9000
# Inter-message gaps above this are treated as idle when computing active time,
# so a session left open overnight does not count as hours of work.
ACTIVE_GAP_CAP_S = 30 * 60
PI_COMPACTION_METADATA_CUSTOM_TYPE = "poo-pi.compaction-metadata"


@dataclass
class Message:
    """One normalized turn in a session, agent-independent."""

    role: str  # user | assistant | tool | system
    ts: float | None  # epoch seconds, best effort
    text: str = ""
    tool_name: str | None = None
    is_error: bool = False


@dataclass
class Session:
    """Normalized session metadata plus its messages and friction tally."""

    agent: str
    session_id: str
    source_path: str
    cwd: str | None
    messages: list[Message] = field(default_factory=list)
    models: set[str] = field(default_factory=set)
    # Friction is partly agent-specific, so parsers fill it directly.
    cancels: int = 0
    rejections: int = 0
    errors: int = 0
    # Context-compaction events. Claude Code records trigger inline; Pi can record
    # it via a companion custom entry emitted by the bundled core extension.
    compactions: int = 0
    auto_compactions: int = 0
    manual_compactions: int = 0
    threshold_compactions: int = 0
    overflow_compactions: int = 0
    # Best-effort token usage. input/output are summed per-turn for Claude Code
    # (deduped by message id — CC repeats usage on every content-block line), Pi,
    # and OpenCode, but assigned from the latest cumulative reading for Codex; cache
    # reads are tracked separately because they inflate totals without being new work.
    tokens_input: int = 0
    tokens_output: int = 0
    tokens_cache_read: int = 0

    @property
    def project(self) -> str:
        return os.path.basename(self.cwd.rstrip("/")) if self.cwd else "(unknown)"

    @property
    def start(self) -> float | None:
        ts = [m.ts for m in self.messages if m.ts]
        return min(ts) if ts else None

    @property
    def end(self) -> float | None:
        ts = [m.ts for m in self.messages if m.ts]
        return max(ts) if ts else None

    @property
    def active_minutes(self) -> float:
        """Active time: inter-message gaps summed with idle gaps capped.

        Wall-clock span (end - start) overstates work for sessions left open or
        resumed later; this caps each gap at ACTIVE_GAP_CAP_S instead.
        """
        ts = sorted(m.ts for m in self.messages if m.ts)
        if len(ts) < 2:
            return 0.0
        return round(sum(min(b - a, ACTIVE_GAP_CAP_S) for a, b in zip(ts, ts[1:])) / 60.0, 1)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _iso(epoch: float | None) -> str | None:
    """Render an epoch as a UTC ISO-8601 string, or None."""
    if epoch is None:
        return None
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat()


def _parse_ts(value) -> float | None:
    """Best-effort parse of the many timestamp shapes agents emit -> epoch seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Heuristic: values past ~ year 2001 in ms are really milliseconds.
        return value / 1000.0 if value > 1e12 else float(value)
    if isinstance(value, str):
        s = value.strip().replace("Z", "+00:00")
        try:
            return dt.datetime.fromisoformat(s).timestamp()
        except ValueError:
            return None
    return None


# Markers for agent-injected text that masquerades as a user turn. Filtering these
# keeps "first user prompt" and digests focused on what the human actually asked.
_BOILERPLATE_PREFIXES = (
    "<environment_context",
    "<permissions",
    "<system-reminder",
    "<local-command",
    "<command-name",
    "# AGENTS.md",
    "Caveat:",
)


def _is_boilerplate(text: str) -> bool:
    """True if a user-role message is really injected scaffolding, not a human prompt."""
    return text.lstrip().startswith(_BOILERPLATE_PREFIXES)


def _blocks_to_text(content) -> tuple[str, list[dict]]:
    """Flatten a string or list-of-blocks into (text, tool_calls).

    Each tool call is `{"name": str, "id": str | None}`; the id lets callers
    match later tool_result blocks back to the originating call.
    """
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return "", []
    parts: list[str] = []
    tools: list[dict] = []
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t in ("text", "input_text", "output_text"):
            parts.append(b.get("text", ""))
        elif t == "thinking":
            parts.append(b.get("thinking", ""))
        elif t in ("tool_use", "tool_call"):
            tools.append({"name": b.get("name", "tool"), "id": b.get("id")})
        elif t == "tool_result":
            inner = b.get("content")
            if isinstance(inner, list):
                parts.append(_blocks_to_text(inner)[0])
            elif isinstance(inner, str):
                parts.append(inner)
    return "\n".join(p for p in parts if p), tools


# --------------------------------------------------------------------------- #
# Claude Code
# --------------------------------------------------------------------------- #

CC_CANCEL = re.compile(r"\[Request interrupted by user")
CC_REJECT = re.compile(r"The tool use was rejected")


def parse_claude_code(root: Path) -> list[Session]:
    """Parse ~/.claude/projects/**/*.jsonl session transcripts."""
    sessions: list[Session] = []
    for path in sorted(root.glob("*/*.jsonl")):
        sess = Session(
            agent="claude-code",
            session_id=path.stem,
            source_path=str(path),
            cwd=None,
        )
        # Claude Code writes one JSONL line per content block of an assistant turn,
        # repeating the same message id and usage on each; dedupe so tokens are
        # counted once per turn, not once per block (a ~2-3x inflation otherwise).
        seen_usage_ids: set[str] = set()
        # tool_use id -> its Message, so tool_result blocks fold into the call
        # instead of being counted as a second tool turn.
        tool_msgs: dict[str, Message] = {}
        for ev in _iter_jsonl(path):
            if ev.get("cwd") and not sess.cwd:
                sess.cwd = ev["cwd"]
            # Compaction is a system event, not a message; trigger is auto|manual.
            if ev.get("type") == "system" and ev.get("subtype") == "compact_boundary":
                sess.compactions += 1
                trigger = (ev.get("compactMetadata") or {}).get("trigger")
                if trigger == "auto":
                    sess.auto_compactions += 1
                elif trigger == "manual":
                    sess.manual_compactions += 1
                continue
            msg = ev.get("message")
            if not isinstance(msg, dict):
                continue
            ts = _parse_ts(ev.get("timestamp"))
            role = msg.get("role", "")
            text, tools = _blocks_to_text(msg.get("content"))
            if msg.get("model"):
                sess.models.add(msg["model"])
            # Friction lives inside message text for Claude Code.
            if CC_CANCEL.search(text):
                sess.cancels += text.count("[Request interrupted by user")
            sess.rejections += len(CC_REJECT.findall(text))
            if role == "assistant":
                u = msg.get("usage") or {}
                mid = msg.get("id")
                if u and (mid is None or mid not in seen_usage_ids):
                    if mid is not None:
                        seen_usage_ids.add(mid)
                    sess.tokens_input += u.get("input_tokens", 0)
                    sess.tokens_output += u.get("output_tokens", 0)
                    sess.tokens_cache_read += u.get("cache_read_input_tokens", 0)
                sess.messages.append(Message("assistant", ts, text[:ASSISTANT_TEXT_CAP]))
                for t in tools:
                    tm = Message("tool", ts, tool_name=t["name"])
                    sess.messages.append(tm)
                    if t.get("id"):
                        tool_msgs[t["id"]] = tm
            elif role == "user":
                # tool_result blocks arrive under role "user"; fold each into its
                # originating tool_use message so one call counts as one tool turn,
                # and surface its is_error flag as a tool error.
                content = msg.get("content")
                results = (
                    [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"]
                    if isinstance(content, list) else []
                )
                if results:
                    for b in results:
                        err = bool(b.get("is_error"))
                        if err:
                            sess.errors += 1
                        tm = tool_msgs.get(b.get("tool_use_id"))
                        if tm is not None:
                            tm.is_error = tm.is_error or err
                else:
                    sess.messages.append(Message("user", ts, text))
        if sess.messages:
            sessions.append(sess)
    return sessions


# --------------------------------------------------------------------------- #
# Codex
# --------------------------------------------------------------------------- #

def parse_codex(root: Path) -> list[Session]:
    """Parse ~/.codex/sessions/**/rollout-*.jsonl typed-payload transcripts."""
    sessions: list[Session] = []
    for path in sorted(root.glob("**/rollout-*.jsonl")):
        sess = Session(agent="codex", session_id=path.stem, source_path=str(path), cwd=None)
        for ev in _iter_jsonl(path):
            etype = ev.get("type")
            payload = ev.get("payload") or {}
            ts = _parse_ts(ev.get("timestamp"))
            if etype == "session_meta":
                sess.cwd = payload.get("cwd")
                sess.session_id = payload.get("id", sess.session_id)
                if payload.get("model"):
                    sess.models.add(payload["model"])
            elif etype == "event_msg":
                # turn_aborted is Codex's user-cancel signal.
                if payload.get("type") == "turn_aborted":
                    sess.cancels += 1
                # context_compacted marks a compaction; Codex records no trigger.
                elif payload.get("type") == "context_compacted":
                    sess.compactions += 1
                # token_count reports cumulative usage; the last reading is the
                # session total. Codex folds cached tokens into input_tokens.
                elif payload.get("type") == "token_count":
                    tu = (payload.get("info") or {}).get("total_token_usage") or {}
                    cached = tu.get("cached_input_tokens", 0)
                    sess.tokens_input = tu.get("input_tokens", 0) - cached
                    sess.tokens_output = tu.get("output_tokens", 0)
                    sess.tokens_cache_read = cached
            elif etype == "response_item":
                ptype = payload.get("type")
                if ptype == "message":
                    role = payload.get("role")
                    if role not in ("user", "assistant"):
                        continue  # skip developer/system scaffolding
                    text, _ = _blocks_to_text(payload.get("content"))
                    cap = USER_TEXT_CAP if role == "user" else ASSISTANT_TEXT_CAP
                    sess.messages.append(Message(role, ts, text[:cap]))
                elif ptype in ("function_call", "local_shell_call", "custom_tool_call"):
                    name = payload.get("name") or payload.get("tool") or "tool"
                    sess.messages.append(Message("tool", ts, tool_name=name))
        if sess.messages:
            sessions.append(sess)
    return sessions


# --------------------------------------------------------------------------- #
# Pi
# --------------------------------------------------------------------------- #

def parse_pi(root: Path) -> list[Session]:
    """Parse ~/.pi/agent/sessions/**/*.jsonl typed transcripts."""
    sessions: list[Session] = []
    for path in sorted(root.glob("*/*.jsonl")):
        sess = Session(agent="pi", session_id=path.stem, source_path=str(path), cwd=None)
        compaction_reasons: dict[str, str | None] = {}
        metadata_reasons: dict[str, str] = {}
        for ev in _iter_jsonl(path):
            etype = ev.get("type")
            if etype == "session":
                sess.cwd = ev.get("cwd")
                sess.session_id = ev.get("id", sess.session_id)
                continue
            if etype == "compaction":
                # Pi's native compaction entry currently omits the trigger, but keep
                # this path future-proof in case it is persisted later.
                cid = ev.get("id")
                compaction_reasons[cid if isinstance(cid, str) else str(len(compaction_reasons))] = ev.get("reason")
                continue
            if etype == "custom" and ev.get("customType") == PI_COMPACTION_METADATA_CUSTOM_TYPE:
                data = ev.get("data") or {}
                cid = data.get("compactionEntryId")
                reason = data.get("reason")
                if isinstance(cid, str) and isinstance(reason, str):
                    metadata_reasons[cid] = reason
                continue
            if etype != "message":
                continue
            m = ev.get("message") or {}
            ts = _parse_ts(m.get("timestamp") or ev.get("timestamp"))
            role = m.get("role")
            text, _ = _blocks_to_text(m.get("content"))
            if m.get("model"):
                sess.models.add(m["model"])
            if role == "assistant":
                # Pi records user cancels as a stopReason on the assistant turn.
                stop = m.get("stopReason")
                if stop == "aborted":
                    sess.cancels += 1
                elif stop == "error":
                    sess.errors += 1
                u = m.get("usage") or {}
                sess.tokens_input += u.get("input", 0)
                sess.tokens_output += u.get("output", 0)
                sess.tokens_cache_read += u.get("cacheRead", 0)
                # Tool turns come from toolResult lines (which carry name + error
                # status); counting content blocks too would double-count calls.
                sess.messages.append(Message("assistant", ts, text[:ASSISTANT_TEXT_CAP]))
            elif role == "user":
                sess.messages.append(Message("user", ts, text[:USER_TEXT_CAP]))
            elif role == "toolResult":
                is_err = bool(m.get("isError"))
                if is_err:
                    sess.errors += 1
                sess.messages.append(
                    Message("tool", ts, tool_name=m.get("toolName"), is_error=is_err)
                )
        for cid, inline_reason in compaction_reasons.items():
            _record_compaction_reason(sess, metadata_reasons.get(cid) or inline_reason)
        if sess.messages:
            sessions.append(sess)
    return sessions


def _record_compaction_reason(sess: Session, reason: str | None) -> None:
    """Increment Pi compaction counters from a persisted trigger reason."""
    sess.compactions += 1
    if reason == "manual":
        sess.manual_compactions += 1
    elif reason == "threshold":
        sess.threshold_compactions += 1
        sess.auto_compactions += 1
    elif reason == "overflow":
        sess.overflow_compactions += 1
        sess.auto_compactions += 1


# --------------------------------------------------------------------------- #
# OpenCode (SQLite)
# --------------------------------------------------------------------------- #

def parse_opencode(db_path: Path) -> list[Session]:
    """Parse the OpenCode SQLite store (session/message/part/permission tables).

    Newer OpenCode versions persist to SQLite; each row's ``data`` column holds a
    JSON blob. Implemented defensively because the schema varies across versions
    and may be empty. See references/session-formats.md.
    """
    sessions: list[Session] = []
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return sessions
    con.row_factory = sqlite3.Row
    try:
        # The session table uses explicit columns; message/part/permission store JSON in `data`.
        sess_by_id: dict[str, Session] = {}
        proj_to_sessions: dict[str, list[Session]] = {}
        for row in con.execute("SELECT id, project_id, directory FROM session"):
            s = Session(
                agent="opencode",
                session_id=row["id"] or "",
                source_path=str(db_path),
                cwd=row["directory"],
            )
            sess_by_id[s.session_id] = s
            proj_to_sessions.setdefault(row["project_id"] or "", []).append(s)

        for row in con.execute("SELECT session_id, data, time_created FROM message"):
            d = _loads(row["data"])
            s = sess_by_id.get(row["session_id"])
            if not s or not d:
                continue
            ts = _parse_ts(row["time_created"] or (d.get("time") or {}).get("created"))
            role = d.get("role", "")
            if d.get("modelID"):
                s.models.add(d["modelID"])
            # A compaction summary is an assistant message flagged summary == true
            # (boolean). User messages reuse `summary` for an unrelated diff object,
            # so require the literal True. OpenCode records no trigger.
            if role == "assistant" and d.get("summary") is True:
                s.compactions += 1
            if role == "assistant":
                tk = d.get("tokens") or {}
                s.tokens_input += tk.get("input", 0)
                s.tokens_output += tk.get("output", 0)
                s.tokens_cache_read += (tk.get("cache") or {}).get("read", 0)
            if role in ("user", "assistant"):
                s.messages.append(Message(role, ts, text=""))

        for row in con.execute("SELECT session_id, data FROM part"):
            d = _loads(row["data"])
            s = sess_by_id.get(row["session_id"])
            if not s or not d:
                continue
            ptype = d.get("type")
            if ptype == "text" and d.get("text"):
                # attach text to the most recent assistant/user message of the session
                for m in reversed(s.messages):
                    if m.role in ("user", "assistant") and not m.text:
                        cap = USER_TEXT_CAP if m.role == "user" else ASSISTANT_TEXT_CAP
                        m.text = d["text"][:cap]
                        break
            elif ptype == "tool":
                state = d.get("state") or {}
                is_err = state.get("status") == "error"
                if is_err:
                    s.errors += 1
                s.messages.append(
                    Message("tool", None, tool_name=d.get("tool"), is_error=is_err)
                )

        # Permission rows record approval prompts but key on project, not session,
        # so denied prompts are attributed to that project's first session (approximate).
        try:
            for row in con.execute("SELECT project_id, data FROM permission"):
                d = _loads(row["data"])
                if not d:
                    continue
                status = (d.get("status") or d.get("response") or "").lower()
                if status in ("denied", "reject", "rejected", "deny"):
                    group = proj_to_sessions.get(row["project_id"] or "")
                    if group:
                        group[0].rejections += 1
        except sqlite3.Error:
            pass

        sessions = [s for s in sess_by_id.values() if s.messages]
    except sqlite3.Error as e:
        print(f"  ! opencode: {e}", file=sys.stderr)
    finally:
        con.close()
    return sessions


def _loads(blob):
    """Tolerant JSON loader for SQLite text/blob columns."""
    if blob is None:
        return None
    if isinstance(blob, bytes):
        blob = blob.decode("utf-8", "replace")
    try:
        return json.loads(blob)
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------- #
# Shared
# --------------------------------------------------------------------------- #

def _iter_jsonl(path: Path):
    """Yield parsed JSON objects from a .jsonl file, skipping malformed lines."""
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError:
        return


AGENT_PARSERS = {
    "claude-code": lambda home: parse_claude_code(home / ".claude" / "projects"),
    "codex": lambda home: parse_codex(home / ".codex" / "sessions"),
    "pi": lambda home: parse_pi(home / ".pi" / "agent" / "sessions"),
    "opencode": lambda home: parse_opencode(
        home / ".local" / "share" / "opencode" / "opencode.db"
    ),
}

# Which friction counters each agent actually records. Downstream renderers use
# this to show "n/a" instead of a misleading 0 for untracked counters.
FRICTION_SUPPORT = {
    "claude-code": {"cancels": True, "rejections": True, "errors": True},
    "codex": {"cancels": True, "rejections": False, "errors": False},
    "pi": {"cancels": True, "rejections": False, "errors": True},
    "opencode": {"cancels": False, "rejections": True, "errors": True},
}


def build_digest(s: Session) -> str:
    """Render a condensed, capped transcript for sub-agent synthesis.

    When over budget, keeps the head and the tail of the conversation rather
    than only the head: friction, abandonment, and resolution cluster at the
    end of a session, so head-only truncation would bias synthesis.
    """
    header = [
        f"# {s.agent} session {s.session_id}",
        f"project: {s.project}  |  cwd: {s.cwd or '?'}",
        f"start: {_iso(s.start)}  |  cancels: {s.cancels}  rejections: {s.rejections}  errors: {s.errors}",
        f"compactions: {s.compactions} (auto: {s.auto_compactions}, manual: {s.manual_compactions}, threshold: {s.threshold_compactions}, overflow: {s.overflow_compactions})",
        f"tokens: {s.tokens_input + s.tokens_output} work ({s.tokens_input} in / {s.tokens_output} out, cache_read {s.tokens_cache_read})",
        "",
        "## Condensed transcript",
    ]
    segs: list[str] = []
    for m in s.messages:
        if m.role == "tool":
            segs.append(f"  ↳ tool: {m.tool_name}{' (error)' if m.is_error else ''}")
        elif m.text and not (m.role == "user" and _is_boilerplate(m.text)):
            segs.append(f"[{m.role}] {m.text.strip()}")
    budget = DIGEST_CHAR_CAP - sum(len(x) + 1 for x in header)
    if sum(len(x) + 1 for x in segs) <= budget:
        return "\n".join(header + segs)
    head_budget = int(budget * 0.6)
    tail_budget = budget - head_budget - 40  # reserve room for the omission marker
    head: list[str] = []
    used = 0
    for seg in segs:
        if used + len(seg) + 1 > head_budget:
            break
        head.append(seg)
        used += len(seg) + 1
    tail: list[str] = []
    used = 0
    for seg in reversed(segs[len(head):]):
        if used + len(seg) + 1 > tail_budget:
            break
        tail.insert(0, seg)
        used += len(seg) + 1
    omitted = len(segs) - len(head) - len(tail)
    return "\n".join(header + head + [f"… ({omitted} turns omitted) …"] + tail)


def session_record(s: Session, digest_rel: str) -> dict:
    """Build the lightweight sessions.json entry (counts + friction, no transcript)."""
    start, end = s.start, s.end
    duration_min = round((end - start) / 60.0, 1) if start and end else 0.0
    first_user = next(
        (m.text for m in s.messages if m.role == "user" and m.text and not _is_boilerplate(m.text)),
        "",
    )
    counts = {
        "user": sum(1 for m in s.messages if m.role == "user"),
        "assistant": sum(1 for m in s.messages if m.role == "assistant"),
        "tool_calls": sum(1 for m in s.messages if m.role == "tool"),
        "messages": len(s.messages),
    }
    tools: dict[str, dict] = {}
    for m in s.messages:
        if m.role != "tool":
            continue
        t = tools.setdefault(m.tool_name or "tool", {"calls": 0, "errors": 0})
        t["calls"] += 1
        t["errors"] += int(m.is_error)
    return {
        "agent": s.agent,
        "session_id": s.session_id,
        "source_path": s.source_path,
        "cwd": s.cwd,
        "project": s.project,
        "start": _iso(start),
        "end": _iso(end),
        "duration_min": duration_min,
        "active_min": s.active_minutes,
        "models": sorted(s.models),
        "counts": counts,
        "friction": {"cancels": s.cancels, "rejections": s.rejections, "errors": s.errors},
        "compaction": {
            "total": s.compactions,
            "auto": s.auto_compactions,
            "manual": s.manual_compactions,
            "threshold": s.threshold_compactions,
            "overflow": s.overflow_compactions,
        },
        "tokens": {
            "input": s.tokens_input,
            "output": s.tokens_output,
            "cache_read": s.tokens_cache_read,
            "total": s.tokens_input + s.tokens_output,
        },
        "tools": tools,
        "first_user_prompt": first_user[:USER_TEXT_CAP],
        "digest_file": digest_rel,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Normalize coding-agent sessions for the insights skill.")
    ap.add_argument("--out-dir", required=True, help="Directory to write sessions.json and digests/")
    ap.add_argument("--agent", default="all",
                    choices=["all", *AGENT_PARSERS.keys()], help="Which agent(s) to scan")
    ap.add_argument("--days", type=int, default=30,
                    help="Only include sessions started within the last N days (0 = all)")
    ap.add_argument("--since", help="Only include sessions on/after this date (YYYY-MM-DD); overrides --days")
    ap.add_argument("--project", help="Filter to sessions whose project (cwd basename) matches this substring")
    ap.add_argument("--cwd", help="Filter to sessions whose cwd matches this substring")
    ap.add_argument("--home", default=str(Path.home()), help="Home dir to scan (for testing)")
    args = ap.parse_args()

    cutoff: float | None = None
    if args.since:
        cutoff = dt.datetime.fromisoformat(args.since).replace(tzinfo=dt.timezone.utc).timestamp()
    elif args.days and args.days > 0:
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)).timestamp()

    home = Path(args.home)
    out_dir = Path(args.out_dir)
    digests_dir = out_dir / "digests"
    digests_dir.mkdir(parents=True, exist_ok=True)

    agents = list(AGENT_PARSERS) if args.agent == "all" else [args.agent]
    records: list[dict] = []
    for agent in agents:
        try:
            sessions = AGENT_PARSERS[agent](home)
        except Exception as e:  # one bad agent must not sink the run
            print(f"  ! {agent}: {e}", file=sys.stderr)
            continue
        kept = 0
        for s in sessions:
            # Filter on last activity, not start: a long-lived session resumed
            # inside the window is recent work even if it began before the cutoff.
            if cutoff and (s.end is None or s.end < cutoff):
                continue
            if args.project and args.project.lower() not in s.project.lower():
                continue
            if args.cwd and (not s.cwd or args.cwd.lower() not in s.cwd.lower()):
                continue
            digest_name = f"{agent}__{s.session_id}.md"
            (digests_dir / digest_name).write_text(build_digest(s), encoding="utf-8")
            records.append(session_record(s, f"digests/{digest_name}"))
            kept += 1
        print(f"  {agent}: {kept} sessions")

    records.sort(key=lambda r: r["start"] or "")
    index = {
        "generated_at": _iso(dt.datetime.now(dt.timezone.utc).timestamp()),
        "window": {"since": _iso(cutoff) if cutoff else None, "days": args.days},
        "filters": {"agent": args.agent, "project": args.project, "cwd": args.cwd},
        "friction_support": FRICTION_SUPPORT,
        "session_count": len(records),
        "sessions": records,
    }
    (out_dir / "sessions.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"Wrote {len(records)} sessions -> {out_dir / 'sessions.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
