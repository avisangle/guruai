"""The four pilot gate targets (PRD Goals), per pilot week, from session summaries (TDD 2.9)."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

# Families are in India: a session's date is its IST calendar date (D-GURU-39-pilot-day-ist).
IST = timezone(timedelta(hours=5, minutes=30))

# target -> (label, "min" or "max", percent)
TARGETS = {
    "lessons_finished": ("Lessons finished without a parent stepping in", "min", 70),
    "false_praise": ("False praise on hand-labelled clips", "max", 5),
    "active_families": ("Families with 3 or more sessions in the week", "min", 50),
    "revision_kept": ("Mastered items correct at next-day revision", "min", 80),
}
FALSE_LABELS = {"wrong", "silent"}


def session_date(s: dict) -> date:
    return datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(IST).date()


def pilot_week(s: dict, start: date) -> int:
    return (session_date(s) - start).days // 7 + 1


def clip_path(s: dict, a: dict) -> str:
    """A clip's path relative to the local copy of uploads/ (TDD 2.8)."""
    return f"{s['device_id']}/{s['child_code']}/{s['session_id']}/{a['clip']}"


def _result(target: str, hits: int, n: int, tap: int | None = None) -> dict:
    _, kind, pct = TARGETS[target]
    if n == 0:
        value = passed = None
    else:
        value = hits / n
        # Integer comparison, so a value exactly on the line (7 of 10, 1 of 20) is not lost to rounding.
        passed = hits * 100 >= pct * n if kind == "min" else hits * 100 <= pct * n
    r = {"value": value, "n": n, "hits": hits, "passed": passed}
    if tap is not None:
        r["tap"] = tap
    return r


def compute(summaries: list[dict], start: date, labels: dict[str, str] | None = None) -> dict:
    """{week: {target: {value, n, hits, passed[, tap]}}} for weeks 1 to the last week with a session.

    Sessions dated before `start` are outside the pilot and ignored."""
    labels = labels or {}
    by_week: dict[int, list[dict]] = defaultdict(list)
    for s in summaries:
        week = pilot_week(s, start)
        if week >= 1:
            by_week[week].append(s)
    families = {s["device_id"] for ss in by_week.values() for s in ss}

    out = {}
    for week in range(1, max(by_week, default=0) + 1):
        sessions = by_week.get(week, [])
        lessons = [(s, l) for s in sessions for l in s["lessons"]]
        answers = [(s, a) for s in sessions for a in s["answers"]]

        finished = sum(1 for s, l in lessons
                       if l["finished"] and l["items_resolved"] == l["items_total"] and not s["parent_helps"])

        labelled = [(a, labels[clip_path(s, a)]) for s, a in answers if a.get("clip") and clip_path(s, a) in labels]
        praise = [(a, lab) for a, lab in labelled if a["decided_by"] == "shekru"]

        revision = [a for _, a in answers if a["phase"] == "revision" and a.get("revision_interval_days") == 1]
        kept = [a for a in revision if a["decided_by"] == "shekru"]

        per_family = Counter(s["device_id"] for s in sessions)

        out[week] = {
            "lessons_finished": _result("lessons_finished", finished, len(lessons)),
            "false_praise": _result(
                "false_praise",
                sum(1 for a, lab in praise if a["heard_kind"] == "correct" and lab in FALSE_LABELS),
                len(praise),
                tap=len(labelled) - len(praise),
            ),
            "active_families": _result("active_families", sum(1 for c in per_family.values() if c >= 3), len(families)),
            "revision_kept": _result(
                "revision_kept",
                sum(1 for a in kept if a["heard_kind"] == "correct"),
                len(kept),
                tap=len(revision) - len(kept),
            ),
        }
    return out
