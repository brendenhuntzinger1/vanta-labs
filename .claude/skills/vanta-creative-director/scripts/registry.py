#!/usr/bin/env python3
"""Creative history for Vanta Labs advertising.

The point of this ledger is NEGATIVE knowledge. Remembering what won is easy —
the winner is running. What gets lost between sessions is what already failed,
and a creative system without that memory re-proposes a dead hook every few
weeks with slightly different words, spending real money to re-learn the same
thing. `similar` exists to make that impossible to do accidentally.

Append-only by design: a concept's metrics history is never overwritten, so
"this looked good in week one and decayed by week three" stays visible. That
decay curve is usually more useful than any single snapshot of it.

Storage is a JSON file next to this script. No database, no credentials, no
network — this must stay usable from any session with a filesystem.

Usage:
  registry.py add      --file concept.json
  registry.py similar  --hook "text"  [--threshold 0.35]
  registry.py record   --id vl-doc-001 --metrics metrics.json
  registry.py status   --id vl-doc-001 --set winner [--note "..."]
  registry.py list     [--status testing] [--archetype ugc_talking_head]
  registry.py report
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parent.parent / "creative-history.json"

VALID_STATUS = {"draft", "testing", "winner", "scaling", "fatiguing", "retired", "ineligible"}

# Words too common in this brand's copy to carry any signal when comparing
# hooks. Without this, every documentation-led hook looks like every other one
# purely because they all say "batch" and "COA".
STOPWORDS = {
    "the", "a", "an", "your", "our", "this", "that", "is", "are", "was", "to", "of",
    "and", "or", "for", "in", "on", "it", "we", "you", "with", "at", "by", "from",
    "vanta", "labs", "peptide", "peptides", "research",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    if not REGISTRY_PATH.exists():
        return {"version": 1, "concepts": []}
    try:
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        # Refuse rather than silently starting a fresh ledger — losing the
        # history of what failed is the one outcome this tool exists to prevent.
        sys.exit(f"Registry at {REGISTRY_PATH} is corrupt ({exc}). Fix or move it; refusing to overwrite.")


def _save(data: dict) -> None:
    REGISTRY_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {w for w in words if w not in STOPWORDS and len(w) > 2}


# Calibrated, not guessed. Measured against hand-labelled pairs of hooks:
# genuine rewrites of the same angle scored 0.48-0.63, unrelated hooks scored
# 0.09-0.15. 0.35 sits in that gap with margin either side. The first draft used
# 0.55 and silently failed to flag "search your batch number" against "type in
# your lot number" — a false negative here is the exact failure this tool exists
# to prevent, so the threshold is deliberately set to over-warn rather than miss.
SIMILARITY_THRESHOLD = 0.35


def _similarity(a: str, b: str) -> float:
    """Blend token overlap with sequence similarity.

    Jaccard alone misses reordered phrasings of the same idea; SequenceMatcher
    alone over-rewards shared boilerplate. Together they catch the case that
    actually matters: the same angle rewritten to look new.
    """
    ta, tb = _tokens(a), _tokens(b)
    jaccard = len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0
    ratio = SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()
    return round(0.6 * jaccard + 0.4 * ratio, 3)


def cmd_add(args) -> None:
    concept = json.loads(Path(args.file).read_text(encoding="utf-8"))
    for field in ("concept_id", "archetype", "hook"):
        if not concept.get(field):
            sys.exit(f"Concept is missing required field: {field}")

    data = _load()
    if any(c["concept_id"] == concept["concept_id"] for c in data["concepts"]):
        sys.exit(f"{concept['concept_id']} already registered. Use `record` or `status`.")

    near = [
        {"concept_id": c["concept_id"], "status": c.get("status"), "hook": c.get("hook"), "score": s}
        for c in data["concepts"]
        if (s := _similarity(concept["hook"], c.get("hook", ""))) >= SIMILARITY_THRESHOLD
    ]

    concept.setdefault("status", "draft")
    concept["registered_at"] = _now()
    concept["metrics_history"] = []
    concept["status_history"] = [{"status": concept["status"], "at": _now(), "note": "registered"}]
    data["concepts"].append(concept)
    _save(data)

    out = {"registered": concept["concept_id"], "status": concept["status"]}
    if near:
        # Surfaced loudly: registering something close to a retired angle is the
        # exact mistake this ledger exists to catch.
        out["warning"] = "Similar hooks already exist — check these before testing"
        out["similar"] = sorted(near, key=lambda x: -x["score"])
    print(json.dumps(out, indent=2))


def cmd_similar(args) -> None:
    data = _load()
    matches = [
        {
            "concept_id": c["concept_id"],
            "status": c.get("status"),
            "archetype": c.get("archetype"),
            "hook": c.get("hook"),
            "score": s,
        }
        for c in data["concepts"]
        if (s := _similarity(args.hook, c.get("hook", ""))) >= args.threshold
    ]
    matches.sort(key=lambda x: -x["score"])
    retired = [m for m in matches if m["status"] in {"retired", "ineligible"}]
    print(json.dumps({
        "query": args.hook,
        "matches": matches,
        "already_failed": retired,
        "verdict": "DO NOT RE-PROPOSE without explaining what is different" if retired else "clear",
    }, indent=2))


def cmd_record(args) -> None:
    data = _load()
    for concept in data["concepts"]:
        if concept["concept_id"] == args.id:
            metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))
            metrics["recorded_at"] = _now()
            # Appended, never replaced: the decay curve matters more than any
            # single snapshot of it.
            concept.setdefault("metrics_history", []).append(metrics)
            _save(data)
            print(json.dumps({
                "concept_id": args.id,
                "snapshots": len(concept["metrics_history"]),
                "latest": metrics,
            }, indent=2))
            return
    sys.exit(f"Unknown concept: {args.id}")


def cmd_status(args) -> None:
    if args.set not in VALID_STATUS:
        sys.exit(f"Invalid status '{args.set}'. One of: {', '.join(sorted(VALID_STATUS))}")
    data = _load()
    for concept in data["concepts"]:
        if concept["concept_id"] == args.id:
            concept["status"] = args.set
            concept.setdefault("status_history", []).append(
                {"status": args.set, "at": _now(), "note": args.note or ""}
            )
            _save(data)
            print(json.dumps({"concept_id": args.id, "status": args.set}, indent=2))
            return
    sys.exit(f"Unknown concept: {args.id}")


def cmd_list(args) -> None:
    data = _load()
    rows = data["concepts"]
    if args.status:
        rows = [c for c in rows if c.get("status") == args.status]
    if args.archetype:
        rows = [c for c in rows if c.get("archetype") == args.archetype]
    print(json.dumps([
        {
            "concept_id": c["concept_id"],
            "archetype": c.get("archetype"),
            "status": c.get("status"),
            "hook": c.get("hook"),
            "snapshots": len(c.get("metrics_history", [])),
        }
        for c in rows
    ], indent=2))


def cmd_report(args) -> None:
    data = _load()
    concepts = data["concepts"]
    by_status: dict[str, int] = {}
    by_archetype: dict[str, dict[str, int]] = {}
    for c in concepts:
        status = c.get("status", "draft")
        arch = c.get("archetype", "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        bucket = by_archetype.setdefault(arch, {"total": 0, "winner": 0, "retired": 0})
        bucket["total"] += 1
        if status in {"winner", "scaling"}:
            bucket["winner"] += 1
        if status in {"retired", "ineligible"}:
            bucket["retired"] += 1

    print(json.dumps({
        "total_concepts": len(concepts),
        "by_status": by_status,
        "by_archetype": by_archetype,
        # The list a fresh session should read first.
        "retired_hooks": [c.get("hook") for c in concepts if c.get("status") in {"retired", "ineligible"}],
    }, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Vanta Labs creative history")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("add"); p.add_argument("--file", required=True); p.set_defaults(func=cmd_add)
    p = sub.add_parser("similar"); p.add_argument("--hook", required=True)
    p.add_argument("--threshold", type=float, default=SIMILARITY_THRESHOLD); p.set_defaults(func=cmd_similar)
    p = sub.add_parser("record"); p.add_argument("--id", required=True)
    p.add_argument("--metrics", required=True); p.set_defaults(func=cmd_record)
    p = sub.add_parser("status"); p.add_argument("--id", required=True)
    p.add_argument("--set", required=True); p.add_argument("--note"); p.set_defaults(func=cmd_status)
    p = sub.add_parser("list"); p.add_argument("--status"); p.add_argument("--archetype")
    p.set_defaults(func=cmd_list)
    p = sub.add_parser("report"); p.set_defaults(func=cmd_report)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
