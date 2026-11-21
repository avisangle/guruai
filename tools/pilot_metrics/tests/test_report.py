"""GURU-39: pilot gate metrics and labelling sheet.

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/pilot_metrics/tests/test_report.py

Every summary, clip and label here is synthetic and built in the test; no real child data.

Input shape read from the real sources, not assumed:
- app/src/upload/summary.ts (buildSessionSummary, TDD 2.9): top level format, app_version, device_id,
  child_code, session_id, started_at, ended_at, end_reason, parent_helps (bool), judge_check,
  judge_p90_ms, class, medium, style_level, lessons[], answers[].
  lessons[]: template_id, started_at, ended_at, finished, items_total, items_resolved.
  answers[]: at, template_id, item_key, item_kind, target_lang, phase, heard_kind, matched_text?,
  matched_lang?, expected[], decided_by, attempt, unsure, counts, revision_interval_days?, clip?
- app/src/lesson/types.ts: DecidedBy = 'shekru' | 'tap'; heard_kind is correct|meaning|wrong|silent.
- Upload key (TDD 2.8, GURU-38): uploads/<device_id>/<child_code>/<session_id>/<name>; --source is a
  local copy of uploads/, so a clip lives at <source>/<device_id>/<child_code>/<session_id>/<clip>.

Pinned contract for /implement:
- metrics.compute(summaries, start: date, labels: dict[clip_path, human_label] | None = None)
  -> {week: {target: result}}; targets "lessons_finished", "false_praise", "active_families",
  "revision_kept"; result keys "value" (float, None when n == 0), "n", "hits", "passed"
  (bool, None when n == 0); "false_praise" and "revision_kept" also carry "tap" (count).
- clip_path = "<device_id>/<child_code>/<session_id>/<clip>", relative to --source.
- sheet.read_labels(path) -> {clip_path: human_label} for rows with a filled label.
"""
import csv
import importlib
import json
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parent.parent
ROOT = PKG.parent.parent
REPORT = PKG / "report.py"
START = date(2026, 12, 1)
COLUMNS = [
    "clip_path", "session_id", "child_code", "template_id", "item_key",
    "expected", "judge_verdict", "matched_text", "decided_by", "human_label",
]

sys.path.insert(0, str(PKG))


def mod(name):
    """Import a pilot_metrics module at test time, so a missing one fails its own tests only."""
    return importlib.import_module(name)


def at(day_offset, hour="06:30"):
    # 06:30Z is 12:00 IST: the same calendar date in either zone.
    return f"{(START + timedelta(days=day_offset)).isoformat()}T{hour}:00Z"


def lesson(finished=True, total=6, resolved=6, tid="tpl_kg_mr_letters_1"):
    return {"template_id": tid, "started_at": "", "ended_at": "", "finished": finished,
            "items_total": total, "items_resolved": resolved}


def answer(heard_kind="correct", decided_by="shekru", phase="quiz", clip=None, interval=None,
           item_key="mr.letter.ka", tid="tpl_kg_mr_letters_1", matched_text="क"):
    a = {"at": "", "template_id": tid, "item_key": item_key, "item_kind": "letter", "target_lang": "mr",
         "phase": phase, "heard_kind": heard_kind, "expected": ["क"], "decided_by": decided_by,
         "attempt": 1, "unsure": False, "counts": True}
    if matched_text is not None:  # summary.ts omits matched_* when the judge matched nothing
        a.update(matched_text=matched_text, matched_lang="mr")
    if interval is not None:
        a["revision_interval_days"] = interval
    if clip is not None:
        a["clip"] = clip
    return a


def summary(device, child, session, day_offset, parent_helps=False, lessons=(), answers=()):
    for a in answers:
        a["at"] = at(day_offset, "06:35")
    return {"format": 1, "app_version": "1.0.0", "device_id": device, "child_code": child,
            "session_id": session, "started_at": at(day_offset), "ended_at": at(day_offset, "06:50"),
            "end_reason": "goodbye", "parent_helps": parent_helps, "judge_check": "ok",
            "judge_p90_ms": 410, "class": "UKG", "medium": "en", "style_level": "mr_led",
            "lessons": list(lessons), "answers": list(answers)}


def clip_path(s, clip):
    return f"{s['device_id']}/{s['child_code']}/{s['session_id']}/{clip}"


def write_source(root, summaries):
    """Lay summaries and their clip files out as the bucket's uploads/ prefix (TDD 2.8)."""
    for s in summaries:
        folder = root / s["device_id"] / s["child_code"] / s["session_id"]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "summary.json").write_text(json.dumps(s, ensure_ascii=False))
        for a in s["answers"]:
            if "clip" in a:
                (folder / a["clip"]).write_bytes(b"RIFF\x00\x00\x00\x00WAVE")


def clip_sessions(first, count, prefix="s"):
    """`count` sessions over 5 devices, each with two clip answers and one answer without a clip."""
    out = []
    for i in range(first, first + count):
        sid = f"{prefix}{i:03d}"
        out.append(summary(f"dev{i % 5}", f"K{i % 5}Q", sid, i % 28, answers=[
            answer("correct", clip=f"c-{sid}-001.wav", item_key="mr.letter.ka"),
            answer("wrong", clip=f"c-{sid}-002.wav", item_key="mr.letter.kha", matched_text="ग"),
            answer("silent", item_key="mr.letter.ga", matched_text=None),
        ]))
    return out


def run(*args):
    return subprocess.run([sys.executable, str(REPORT), *map(str, args)], cwd=ROOT,
                          capture_output=True, text=True, timeout=60)


def read_sheet(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


# --- Behaviour -------------------------------------------------------------------------------


def test_lessons_finished_target_by_pilot_week_counts_parent_helps_as_stepping_in():
    m = mod("metrics")
    summaries = [
        # Week 1 (days 0-6): one passing lesson out of four.
        summary("dev1", "K1", "s1", 0, lessons=[lesson(), lesson(resolved=5), lesson(finished=False, resolved=2)]),
        summary("dev1", "K1", "s2", 6, parent_helps=True, lessons=[lesson()]),
        # Week 2 starts on day 7: 7 of 10 pass, exactly the 70% target.
        summary("dev2", "K2", "s3", 7, lessons=[lesson()] * 7 + [lesson(resolved=4)] * 2 + [lesson(finished=False, resolved=0)]),
    ]
    r = m.compute(summaries, START)
    w1, w2 = r[1]["lessons_finished"], r[2]["lessons_finished"]
    assert (w1["n"], w1["hits"], w1["passed"]) == (4, 1, False)
    assert w1["value"] == pytest.approx(0.25)
    assert (w2["n"], w2["hits"], w2["passed"]) == (10, 7, True)
    assert w2["value"] == pytest.approx(0.7)


def test_false_praise_uses_only_labelled_shekru_answers_and_counts_tap_separately():
    m = mod("metrics")
    wk1 = summary("dev1", "K1", "s1", 2, answers=[
        answer("correct", clip="c1.wav"),                   # labelled wrong: false praise
        answer("correct", clip="c2.wav"),                   # labelled silent: false praise
        answer("correct", clip="c3.wav"),                   # labelled correct
        answer("wrong", clip="c4.wav"),                     # labelled wrong
        answer("wrong", clip="c5.wav"),                     # labelled correct: a miss, not praise
        answer("correct", clip="c6.wav"),                   # never labelled: outside the sample
        answer("correct", decided_by="tap", clip="c7.wav"), # tap: excluded, counted apart
        answer("correct"),                                  # no clip
    ])
    wk2 = summary("dev1", "K1", "s2", 8, answers=[answer("correct", clip=f"d{i}.wav") for i in range(20)])
    wk3 = summary("dev1", "K1", "s3", 15, answers=[answer("correct", clip="e1.wav")])
    labels = {clip_path(wk1, c): lab for c, lab in [
        ("c1.wav", "wrong"), ("c2.wav", "silent"), ("c3.wav", "correct"),
        ("c4.wav", "wrong"), ("c5.wav", "correct"), ("c7.wav", "wrong")]}
    labels.update({clip_path(wk2, f"d{i}.wav"): ("wrong" if i == 0 else "correct") for i in range(20)})

    r = m.compute([wk1, wk2, wk3], START, labels=labels)
    w1, w2, w3 = (r[w]["false_praise"] for w in (1, 2, 3))
    assert (w1["n"], w1["hits"], w1["tap"], w1["passed"]) == (5, 2, 1, False)
    assert w1["value"] == pytest.approx(0.4)
    # 1 in 20 is exactly the 5% ceiling, which passes.
    assert (w2["n"], w2["hits"], w2["tap"], w2["passed"]) == (20, 1, 0, True)
    assert w2["value"] == pytest.approx(0.05)
    # A week with no labelled answers has no figure rather than a 0% pass.
    assert (w3["n"], w3["value"], w3["passed"]) == (0, None, None)


def test_active_families_are_device_ids_with_three_or_more_sessions_in_the_week():
    m = mod("metrics")
    days = {
        ("devA", "KA"): [21, 23, 25],
        ("devB", "KB"): [0, 1, 2, 3, 4, 22, 24],
        ("devC", "KX"): [21, 22],          # devC's two children: one family, 4 sessions in week 4
        ("devC", "KY"): [26, 27],
        ("devD", "KD"): [1],
    }
    summaries = [summary(dev, child, f"{dev}-{child}-{d}", d) for (dev, child), ds in days.items() for d in ds]
    r = m.compute(summaries, START)
    w4, w1 = r[4]["active_families"], r[1]["active_families"]
    # Every family seen in the pilot is in the denominator, active that week or not.
    assert (w4["n"], w4["hits"], w4["passed"]) == (4, 2, True)
    assert w4["value"] == pytest.approx(0.5)
    assert (w1["n"], w1["hits"]) == (4, 1)


def test_revision_kept_uses_next_day_shekru_revision_answers_only():
    m = mod("metrics")
    wk1 = summary("dev1", "K1", "s1", 1, answers=[
        *[answer("correct", phase="revision", interval=1) for _ in range(4)],
        answer("silent", phase="revision", interval=1),
        answer("wrong", phase="revision", interval=3),               # not next-day
        answer("wrong", phase="quiz"),                               # not revision
        answer("wrong", phase="revision", interval=1, decided_by="tap"),
    ])
    wk2 = summary("dev1", "K1", "s2", 9, answers=[
        *[answer("correct", phase="revision", interval=1) for _ in range(3)],
        answer("wrong", phase="revision", interval=1),
    ])
    r = m.compute([wk1, wk2], START)
    w1, w2 = r[1]["revision_kept"], r[2]["revision_kept"]
    assert (w1["n"], w1["hits"], w1["tap"], w1["passed"]) == (5, 4, 1, True)
    assert w1["value"] == pytest.approx(0.8)
    assert (w2["n"], w2["hits"], w2["tap"], w2["passed"]) == (4, 3, 0, False)


def test_labelling_sheet_samples_about_a_fifth_of_clip_sessions_one_row_per_clip(tmp_path):
    src = tmp_path / "uploads"
    with_clips = clip_sessions(0, 50)
    without = [summary("dev9", "K9Q", f"n{i:03d}", i, answers=[answer("correct")]) for i in range(10)]
    write_source(src, with_clips + without)
    by_session = {s["session_id"]: s for s in with_clips}

    sheet = tmp_path / "sheet.csv"
    res = run("--source", src, "--start", START, "--sheet-out", sheet, "--out", tmp_path / "report.md")
    assert res.returncode == 0, res.stderr
    header, rows = read_sheet(sheet)
    assert header == COLUMNS
    sampled = {r["session_id"] for r in rows}
    assert sampled <= set(by_session)                 # only sessions that have clips
    assert 5 <= len(sampled) <= 15                    # about 20% of 50
    for sid in sampled:
        s = by_session[sid]
        mine = [r for r in rows if r["session_id"] == sid]
        assert sorted(r["clip_path"] for r in mine) == sorted(clip_path(s, a["clip"]) for a in s["answers"] if "clip" in a)
    for r in rows:
        s = by_session[r["session_id"]]
        a = next(a for a in s["answers"] if a.get("clip") and r["clip_path"].endswith("/" + a["clip"]))
        assert (src / r["clip_path"]).is_file()
        assert (r["child_code"], r["template_id"], r["item_key"]) == (s["child_code"], a["template_id"], a["item_key"])
        assert (r["judge_verdict"], r["matched_text"], r["decided_by"]) == (a["heard_kind"], a["matched_text"], a["decided_by"])
        assert "क" in r["expected"]
        assert r["human_label"] == ""

    # Seeded: the same source gives the same sheet.
    again = tmp_path / "again.csv"
    assert run("--source", src, "--start", START, "--sheet-out", again).returncode == 0
    assert again.read_bytes() == sheet.read_bytes()

    # Local pilot data stays out of git (public repo).
    ignored = subprocess.run(["git", "check-ignore", "-q", "tools/pilot_metrics/data/uploads/summary.json"], cwd=ROOT)
    assert ignored.returncode == 0


def test_rerun_keeps_sampled_sessions_and_reads_filled_labels(tmp_path):
    sh = mod("sheet")
    src = tmp_path / "uploads"
    write_source(src, clip_sessions(0, 50))
    first = tmp_path / "first.csv"
    assert run("--source", src, "--start", START, "--sheet-out", first).returncode == 0

    header, rows = read_sheet(first)
    rows[0]["human_label"], rows[1]["human_label"] = "wrong", "correct"
    with open(first, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)
    assert sh.read_labels(first) == {rows[0]["clip_path"]: "wrong", rows[1]["clip_path"]: "correct"}

    # More sessions arrive; the next run keeps every session already sampled.
    write_source(src, clip_sessions(50, 50, prefix="t"))
    second, labelled, unlabelled = tmp_path / "second.csv", tmp_path / "a.md", tmp_path / "b.md"
    res = run("--source", src, "--start", START, "--labels", first, "--sheet-out", second, "--out", labelled)
    assert res.returncode == 0, res.stderr
    kept = {r["session_id"] for r in rows}
    now = {r["session_id"] for r in read_sheet(second)[1]}
    assert kept <= now
    assert len(now) > len(kept)

    # The filled labels reach the report.
    assert run("--source", src, "--start", START, "--out", unlabelled).returncode == 0
    assert labelled.read_text() != unlabelled.read_text()


# --- Contract for dependents ----------------------------------------------------------------


def test_contract_report_cli_writes_markdown_targets_per_week_and_labelling_csv(tmp_path):
    """Output for dependents (GURU-39 Handoff; consumer: the pilot gate review at end of M1):
    `python tools/pilot_metrics/report.py` producing a Markdown report of the four pilot targets
    per pilot week and a labelling CSV. Shape only."""
    help_text = run("--help")
    assert help_text.returncode == 0
    for flag in ("--source", "--start", "--labels", "--sheet-out", "--out", "--r2"):
        assert flag in help_text.stdout

    src = tmp_path / "uploads"
    write_source(src, clip_sessions(0, 5) + [summary("dev1", "K1Q", "w1", 1, lessons=[lesson()])])
    out, sheet = tmp_path / "report.md", tmp_path / "sheet.csv"
    res = run("--source", src, "--start", START, "--sheet-out", sheet, "--out", out)
    assert res.returncode == 0, res.stderr

    text = out.read_text(encoding="utf-8")
    assert text.lstrip().startswith("#")
    assert "week 1" in text.lower()
    for target in ("70%", "5%", "50%", "80%"):
        assert target in text
    assert "pass" in text.lower() or "fail" in text.lower()
    assert read_sheet(sheet)[0] == COLUMNS
