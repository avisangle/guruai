"""GURU-27: stt_bench word items, language tags and the word-item judge-test report.

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/tests/test_evaluator.py

Synthetic only: no audio, no model, no ffmpeg. A fake closed-set scorer "hears" a fixed text per clip,
and the word lesson is written to a temporary content/lessons/ (bench.ROOT is patched), so real
lessons and results/ are never touched.

Mirrors app/src/asr/lessonJudge.ts (GURU-18), read from the source, not assumed:
- classify(item, judgement, unsure) -> Heard: nothing -> silent; the asked item's answer in its target
  language, an also_correct text or the card letter -> correct with text and lang; the asked item's
  answer in another language -> meaning with that lang; else wrong with text; unsure and not correct
  -> silent with unsure. A child sound swap counts for the item only when the judge chose that item.
- Quiz listens drop candidates whose normalised text is a whole word of the normalised prompt; teach
  listens keep all. Verdict per Heard kind: correct/meaning -> correct, wrong -> wrong, silent -> unclear.
Clip manifest (docs/clip-export.md): `label_by` absent means the tester's tap; `item_key` is
<lang>:<kind>:<display>. The prompt text is read from the clip's `prompt` field.
"""
import inspect
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "stt_bench"))
import bench  # noqa: E402
import evaluator  # noqa: E402
from providers.base import ClosedScorer, Judgement  # noqa: E402

KINDS = {"correct", "meaning", "wrong", "silent"}
WORDS = "tpl_test_mixed_words_1"
SECTION = "## Word-item judge test"


def heard(item, choice, text=None, unsure=False):
    """evaluator.classify as a comparable dict: `by` and empty values dropped."""
    h = evaluator.classify(item, choice, text, unsure)
    return {k: v for k, v in h.items() if k != "by" and v not in (None, "", False)}


# Word items as in lessonJudge.test.ts: a Marathi-target word with a Hindi meaning, an English-target
# word with a Marathi meaning, plus a letter item in the same lesson.
WORD_LESSON = {
    "template_id": WORDS,
    "items": [
        {"id": "spoon", "item_key": "mr:word:चमचा", "display": "चमचा", "kind": "word", "target_lang": "mr",
         "assessment": {"mode": "say_word", "expected": ["चमचा"], "accepted_variants": ["चम्मच"],
                        "langs": {"चम्मच": ["hi"]}}},
        {"id": "mango", "item_key": "en:word:mango", "display": "Mango", "kind": "word", "target_lang": "en",
         "assessment": {"mode": "say_word", "expected": ["मँगो"], "accepted_variants": ["आंबा"],
                        "langs": {"आंबा": ["mr"]}}},
        {"id": "b", "item_key": "en:letter:B", "display": "B", "kind": "letter", "target_lang": "en",
         "assessment": {"mode": "say_word", "expected": ["बी"], "accepted_variants": ["बी फॉर बॉल", "बॉल"]}},
    ],
}
SPOON = {"display": "चमचा", "target_lang": "mr", "expected": ["चमचा"], "accepted_variants": ["चम्मच"],
         "also_correct": [], "langs": {"चम्मच": ["hi"]}}
MANGO = {"display": "Mango", "target_lang": "en", "expected": ["मँगो"], "accepted_variants": ["आंबा"],
         "also_correct": [], "langs": {"आंबा": ["mr"]}}


class Hears(ClosedScorer):
    """Fake closed scorer: for each clip (by file stem) it hears one text. It picks that candidate when it
    is offered, else "other"; evaluator.NOTHING means no speech. Records the candidates it was given."""
    name = "fake_closed"
    audio = "original"
    external = False
    pricing = "indicconformer"

    def __init__(self, said, unsure=()):
        self.said, self.unsure, self.seen = said, set(unsure), {}

    def judge(self, path, item, candidates):
        cid = Path(path).stem
        self.seen[cid] = [c.text for c in candidates]
        want = self.said[cid]
        if want == evaluator.NOTHING:
            return Judgement(evaluator.NOTHING)
        hit = next((c for c in candidates if c.text == want), None)
        return Judgement(hit or evaluator.OTHER, unsure=cid in self.unsure)


@pytest.fixture
def lessons_root(tmp_path, monkeypatch):
    """bench.ROOT with only the synthetic word lesson under content/lessons/."""
    d = tmp_path / "root" / "content" / "lessons"
    d.mkdir(parents=True)
    (d / f"{WORDS}.json").write_text(json.dumps(WORD_LESSON, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(bench, "ROOT", tmp_path / "root")
    return tmp_path


def clip(cid, item_id, label, kind="quiz", prompt="हे काय आहे? आता तू सांग!", label_by=None):
    it = next(i for i in WORD_LESSON["items"] if i["id"] == item_id)
    c = {"id": cid, "file": f"clips/{cid}.wav", "child": "C1", "age": 5, "template_id": WORDS,
         "item_id": item_id, "item_key": it["item_key"], "display": it["display"],
         "expected": it["assessment"]["expected"], "accepted_variants": it["assessment"]["accepted_variants"],
         "kind": kind, "label": label, "recorded_at": "2026-11-21T10:00:00Z", "duration_ms": 1500}
    if prompt is not None:
        c["prompt"] = prompt
    if label_by:
        c["label_by"] = label_by
    return c


def run(tmp, spec, unsure=()):
    """spec: [(clip dict, text heard)]. Returns (rows, summary text, fake provider)."""
    clips = [c for c, _ in spec]
    prov = Hears({c["id"]: said for c, said in spec}, unsure)
    lessons = bench.lessons_for(clips)
    cache = tmp / "cache"
    cache.mkdir(exist_ok=True)
    rows = bench.run_provider(prov, clips, tmp, lessons, cache)
    manifest = {"format": 1, "exported_at": "2026-11-21T10:05:00Z", "app_version": "test", "clips": clips}
    text = bench.summary(manifest, "synthetic", {prov.name: rows}, [], [prov], lessons)
    return rows, text, prov


def judge_section(text):
    assert SECTION in text, f"summary.md has no {SECTION!r} section"
    body = text.split(SECTION, 1)[1]
    return body.split("\n## ", 1)[0]


def verdict_after(line, number):
    """The first pass/fail word after `number` in the same table cell (or the line, if not a table)."""
    m = re.search(re.escape(number) + r"(?:(?!pass|fail)[^|])*\b(pass|fail)\b", line, re.IGNORECASE)
    return m and m.group(1).lower()


# --- classification, as classify() in the app ---------------------------------------------------
def test_classify_letters_like_the_app_correct_also_correct_card_letter_wrong_silent():
    mr = bench.lessons_for([])["tpl_kg_mr_swar_1"].items
    en = bench.lessons_for([])["tpl_kg_en_letters_1"].items
    assert heard(mr["a"], evaluator.NOTHING) == {"kind": "silent"}
    assert heard(mr["a"], "अ", "अ अननसाचा") == {"kind": "correct", "text": "अ अननसाचा", "lang": "mr"}
    assert heard(mr["i"], "ई", "ई") == {"kind": "correct", "text": "ई", "lang": "mr"}  # also_correct
    # English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
    assert heard(en["b"], "B", "बी फॉर बॉल") == {"kind": "correct", "text": "बी फॉर बॉल", "lang": "en"}
    assert heard(en["b"], "B")["kind"] == "correct"  # card letter, no text (phone/other scorers)
    assert heard(mr["a"], "आ", "आ") == {"kind": "wrong", "text": "आ"}
    assert heard(en["a"], "E", "ई फॉर एलिफंट") == {"kind": "wrong", "text": "ई फॉर एलिफंट"}
    assert heard(mr["a"], evaluator.OTHER) == {"kind": "wrong"}
    # child sound swap (चा -> सा) credited because the judge chose this item
    assert heard(SPOON, "चमचा", "चमसा") == {"kind": "correct", "text": "चमसा", "lang": "mr"}


def test_classify_meaning_with_language_and_unsure_is_silent_unless_correct():
    assert heard(SPOON, "चमचा", "चम्मच") == {"kind": "meaning", "text": "चम्मच", "lang": "hi"}
    assert heard(SPOON, "चमचा", "चमचा") == {"kind": "correct", "text": "चमचा", "lang": "mr"}
    assert heard(MANGO, "Mango", "आंबा") == {"kind": "meaning", "text": "आंबा", "lang": "mr"}
    assert heard(MANGO, "Mango", "मँगो") == {"kind": "correct", "text": "मँगो", "lang": "en"}
    assert heard(MANGO, "चमचा", "चमचा") == {"kind": "wrong", "text": "चमचा"}  # another item's answer
    # unsure (faint audio): anything but correct is silent and unsure; a right answer still counts
    assert heard(SPOON, "चमचा", "चम्मच", True) == {"kind": "silent", "unsure": True}
    assert heard(MANGO, evaluator.OTHER, None, True) == {"kind": "silent", "unsure": True}
    assert heard(MANGO, "Mango", "मँगो", True) == {"kind": "correct", "text": "मँगो", "lang": "en"}


# --- prompt exclusion through the bench ---------------------------------------------------------
def test_quiz_clip_drops_prompt_words_from_candidates_teach_and_promptless_keep_all(lessons_root):
    hint = "हे फळ इंग्लिशमध्ये मँगो आहे. बीज नाही! आता तू सांग!"
    spec = [
        (clip("q-echo", "mango", "wrong", "quiz", hint), "मँगो"),  # child echoes the hint word
        (clip("t-echo", "mango", "correct", "teach", hint), "मँगो"),  # repeat after me
        (clip("q-old", "mango", "correct", "quiz", None), "मँगो"),  # older export: no prompt field
        (clip("q-meaning", "mango", "correct", "quiz", hint), "आंबा"),
    ]
    rows, _, prov = run(lessons_root, spec)
    by = {r["clip"]: r for r in rows}
    assert not any(r["error"] for r in rows), [r["error"] for r in rows]

    assert "मँगो" not in prov.seen["q-echo"]
    # whole words only: "बी" stays although the prompt has "बीज"; other answers stay
    assert {"आंबा", "चमचा", "चम्मच", "बी", "बॉल"} <= set(prov.seen["q-echo"])
    assert (by["q-echo"]["heard"], by["q-echo"]["verdict"]) == ("wrong", "wrong")  # not praised

    assert "मँगो" in prov.seen["t-echo"] and "मँगो" in prov.seen["q-old"]
    assert (by["t-echo"]["heard"], by["t-echo"]["verdict"]) == ("correct", "correct")
    assert (by["q-old"]["heard"], by["q-old"]["verdict"]) == ("correct", "correct")
    # a meaning is the item's answer in another language: Heard meaning, verdict correct (as the app)
    assert (by["q-meaning"]["heard"], by["q-meaning"]["verdict"]) == ("meaning", "correct")


# --- the word-item judge-test section -----------------------------------------------------------
def judge_test_spec(accepted=4, false_praise=1):
    """5 tap-labelled correct word clips (`accepted` of them judged correct or meaning) and 20 tap-labelled
    wrong/silent word clips (`false_praise` of them judged correct), plus clips the section must ignore."""
    right = [("mango", "मँगो"), ("spoon", "चमचा"), ("spoon", "चम्मच"), ("mango", "आंबा"), ("spoon", "चमचा")]
    spec = [(clip(f"ok{i}", iid, "correct"), said if i < accepted else "something else")
            for i, (iid, said) in enumerate(right)]
    for i in range(20):
        label = "wrong" if i % 2 else "silent"
        said = "मँगो" if i < false_praise else (evaluator.NOTHING if label == "silent" else "चमचा")
        spec.append((clip(f"no{i}", "mango", label), said))
    # Ignored: judge-labelled word clips (not a check of the judge) and letter items.
    spec += [(clip("judge1", "mango", "wrong", label_by="judge"), "मँगो"),
             (clip("judge2", "spoon", "correct", label_by="judge"), "something else"),
             (clip("letter1", "b", "correct"), "something else"),
             (clip("letter2", "b", "wrong"), "बी")]
    return spec


def test_judge_test_section_counts_tap_labelled_word_clips_and_passes_at_the_targets(lessons_root):
    _, text, prov = run(lessons_root, judge_test_spec(accepted=4, false_praise=1))
    lines = [ln for ln in judge_section(text).splitlines() if prov.name in ln]
    assert lines, f"no {prov.name} line in the judge-test section:\n{judge_section(text)}"
    line = lines[0]
    # at least 80% accepted: 4/5 is exactly 80% -> pass; at most 5% false praise: 1/20 is exactly 5% -> pass
    assert "4/5 (80%)" in line and verdict_after(line, "4/5 (80%)") == "pass", line
    assert "1/20 (5%)" in line and verdict_after(line, "1/20 (5%)") == "pass", line


def test_judge_test_section_fails_below_targets_and_never_passes_without_word_clips(lessons_root):
    _, text, prov = run(lessons_root, judge_test_spec(accepted=3, false_praise=2))
    line = next(ln for ln in judge_section(text).splitlines() if prov.name in ln)
    assert verdict_after(line, "3/5 (60%)") == "fail", line
    assert verdict_after(line, "2/20 (10%)") == "fail", line

    # Only letter clips and judge-labelled word clips: nothing to judge the gate on.
    only = [(clip("l1", "b", "correct"), "बी"), (clip("l2", "b", "wrong"), "चमचा"),
            (clip("j1", "mango", "correct", label_by="judge"), "मँगो")]
    _, text, prov = run(lessons_root, only)
    section = judge_section(text)
    assert not re.search(r"\bpass\b", section, re.IGNORECASE), section
    assert "n/a" in section, section


# --- contract (shape only) ----------------------------------------------------------------------
def test_contract_word_and_meaning_classification_and_judge_test_section_shape(lessons_root):
    """What D-GURU-12-word-items-practice-only relies on to decide WORD_ITEMS_GATED (no consuming issue):
    evaluator.classify(item, choice, text, unsure) -> dict with a Heard kind; bench rows carry `heard`;
    summary.md has a 'Word-item judge test' section with the two gate numbers."""
    assert callable(getattr(evaluator, "classify", None))
    assert list(inspect.signature(evaluator.classify).parameters)[:4] == ["item", "choice", "text", "unsure"]
    h = evaluator.classify(MANGO, "Mango", "आंबा", False)
    assert isinstance(h, dict) and h.get("kind") in KINDS and isinstance(h.get("lang"), str)

    rows, text, prov = run(lessons_root, judge_test_spec())
    assert all(r["heard"] in KINDS for r in rows)
    assert "heard" in bench.COLUMNS
    section = judge_section(text)
    assert re.search(r"\d+/\d+ \(\d+%\)", section) and len(re.findall(r"\b(?:pass|fail)\b", section, re.I)) >= 2
