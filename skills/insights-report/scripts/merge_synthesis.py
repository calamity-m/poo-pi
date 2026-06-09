#!/usr/bin/env python3
"""Draft-merge per-batch synthesis JSON files without model calls.

The helper is intentionally conservative: it groups items by normalized title text,
combines session counts/projects, preserves the first wording, and emits a valid
synthesis.json draft for the orchestrating agent to review and polish.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

STOPWORDS = {"and", "the", "a", "an", "of", "for", "to", "in", "on", "with", "work", "ux", "ui"}


def _key(title: str) -> str:
    """Normalize a synthesis title for conservative grouping."""
    words = re.findall(r"[a-z0-9]+", title.lower())
    kept = [w for w in words if w not in STOPWORDS]
    return " ".join(kept[:4]) or title.lower().strip()


def _merge_themes(files: list[dict]) -> list[dict]:
    """Merge themes with identical normalized keys."""
    grouped: dict[str, dict] = {}
    for data in files:
        for theme in data.get("themes", []) or []:
            key = _key(theme.get("title", ""))
            cur = grouped.setdefault(key, {**theme, "projects": [], "sessions": 0})
            cur["sessions"] += int(theme.get("sessions") or 0)
            cur["projects"] = sorted(set(cur.get("projects", [])) | set(theme.get("projects", []) or []))
    return sorted(grouped.values(), key=lambda t: t.get("sessions", 0), reverse=True)


def _merge_cross_session(files: list[dict]) -> list[dict]:
    """Merge cross-session threads with identical normalized titles."""
    grouped: dict[str, dict] = {}
    for data in files:
        for th in data.get("cross_session_threads", []) or []:
            key = _key(th.get("title", ""))
            cur = grouped.setdefault(key, {**th, "projects": [], "session_count": 0, "compactions": 0})
            cur["session_count"] += int(th.get("session_count") or 0)
            cur["compactions"] += int(th.get("compactions") or 0)
            cur["projects"] = sorted(set(cur.get("projects", [])) | set(th.get("projects", []) or []))
    return sorted(grouped.values(), key=lambda t: t.get("session_count", 0), reverse=True)


def _merge_named(items: list[dict], field: str) -> list[dict]:
    """Deduplicate recommendation or friction objects by normalized label."""
    out: dict[str, dict] = {}
    for item in items:
        key = _key(item.get(field, ""))
        out.setdefault(key, item)
    return list(out.values())


def merge(paths: list[Path]) -> dict:
    """Merge batch synthesis files into a draft schema-version-3 synthesis object.

    Unreadable or invalid batch files are skipped and counted in
    ``metadata.failed_batches`` so coverage gaps are visible in the report
    instead of silently killing the merge.
    """
    loaded: list[dict] = []
    failed = 0
    for p in paths:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            failed += 1
            print(f"  ! skipping unreadable batch {p}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            failed += 1
            print(f"  ! skipping non-object batch {p}", file=sys.stderr)
            continue
        loaded.append(data)
    friction = [p for data in loaded for p in (data.get("friction_patterns", []) or [])]
    recommendations = [r for data in loaded for r in (data.get("recommendations", []) or [])]
    project_insights = [p for data in loaded for p in (data.get("project_insights", []) or [])]
    fragmented = [f for data in loaded for f in (data.get("fragmented_sessions", []) or [])]
    digest_count = sum(int((data.get("metadata") or {}).get("digest_count") or 0) for data in loaded)
    return {
        "schema_version": 3,
        "themes": _merge_themes(loaded)[:10],
        "cross_session_threads": _merge_cross_session(loaded)[:8],
        "fragmented_sessions": fragmented[:12],
        "friction_patterns": _merge_named(friction, "pattern")[:8],
        "recommendations": _merge_named(recommendations, "title")[:8],
        "project_insights": _merge_named(project_insights, "project")[:12],
        "metadata": {
            "digest_count": digest_count,
            "batch_count": len(paths),
            "failed_batches": failed,
            "merge_helper": "scripts/merge_synthesis.py",
        },
    }


def main() -> int:
    """CLI entry point for the draft merge helper."""
    ap = argparse.ArgumentParser(description="Merge synth-batch-*.json into draft synthesis.json")
    ap.add_argument("inputs", nargs="+", help="Batch synthesis JSON files")
    ap.add_argument("--out", required=True, help="Path to write merged synthesis JSON")
    args = ap.parse_args()

    paths = [Path(p) for p in args.inputs]
    draft = merge(paths)
    Path(args.out).write_text(json.dumps(draft, indent=2), encoding="utf-8")
    failed = draft["metadata"]["failed_batches"]
    suffix = f" ({failed} failed batch{'es' if failed != 1 else ''} skipped)" if failed else ""
    print(f"Merged {len(paths) - failed} of {len(paths)} batch files -> {args.out}{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
