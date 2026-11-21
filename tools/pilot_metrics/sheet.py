"""The hand-labelling sheet: a seeded sample of about 20% of sessions with clips, one row per clip answer."""
from __future__ import annotations

import csv
import hashlib

from metrics import clip_path

COLUMNS = [
    "clip_path", "session_id", "child_code", "template_id", "item_key",
    "expected", "judge_verdict", "matched_text", "decided_by", "human_label",
]
SEED = "guru-pilot-m1"
RATE = 0.2


def sampled(session_id: str) -> bool:
    """Each session's draw depends only on the seed and its id, so sessions arriving later
    never change which earlier sessions are in the sample."""
    h = hashlib.sha256(f"{SEED}:{session_id}".encode()).digest()
    return int.from_bytes(h[:8], "big") < RATE * 2**64


def rows(summaries: list[dict], labels: dict[str, str] | None = None) -> list[dict]:
    """Rows for the clips of sampled sessions, plus any clip already labelled, carrying the labels filled in."""
    labels = labels or {}
    out = []
    for s in sorted(summaries, key=lambda s: (s["started_at"], s["session_id"])):
        keep = sampled(s["session_id"])
        for a in s["answers"]:
            if not a.get("clip"):
                continue
            path = clip_path(s, a)
            if not (keep or path in labels):
                continue
            out.append({
                "clip_path": path,
                "session_id": s["session_id"],
                "child_code": s["child_code"],
                "template_id": a["template_id"],
                "item_key": a["item_key"],
                "expected": " | ".join(a["expected"]),
                "judge_verdict": a["heard_kind"],
                "matched_text": a.get("matched_text", ""),
                "decided_by": a["decided_by"],
                "human_label": labels.get(path, ""),
            })
    return out


def write(path, sheet_rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(sheet_rows)


def read_labels(path) -> dict[str, str]:
    """{clip_path: human_label} for rows with a filled label."""
    with open(path, newline="", encoding="utf-8") as f:
        return {r["clip_path"]: r["human_label"].strip().lower()
                for r in csv.DictReader(f) if r["human_label"].strip()}
