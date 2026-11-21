"""GURU-17: gen_voice.py for content schema v2.

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/tests/test_gen_voice.py

No network, no TTS, no ffmpeg: batch_tts and job are replaced with fakes, and main()
runs against a temporary tree so the real content/audio/ is never touched.

Schema read from the real sources, not assumed:
- app/src/lesson/types.ts: lesson `lines`/`captions`, item `lines`/`captions` (Record<string, string>);
  word lines teach_mr_led, teach_en_led, ask, hint, correct, ack_meaning, model_mr; both kinds react_1, react_2?
- content/prompts/mr.json: {"_about", "lines", "captions"}
- ids (content/README.md, lesson "audio" note): shared id as is, <template_id>.<line>, <template_id>.<item id>.<line>
"""
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "word-lesson.json"
VOICE_LATIN = TOOLS / "voice_latin.json"

sys.path.insert(0, str(TOOLS))
import gen_voice as gv  # noqa: E402

WORD_LINES = ["teach_mr_led", "teach_en_led", "ask", "hint", "correct", "ack_meaning", "model_mr", "react_1"]
LETTER_LINES = ["teach", "hint", "correct", "react_1"]


def fixture():
    return json.loads(FIXTURE.read_text())


def load_copy(tmp_path, pairs):
    """Import a copy of gen_voice.py whose sibling tools/voice_latin.json holds `pairs`."""
    tools = tmp_path / "tools"
    tools.mkdir()
    shutil.copy(TOOLS / "gen_voice.py", tools / "gen_voice.py")
    (tools / "voice_latin.json").write_text(json.dumps(pairs, ensure_ascii=False))
    spec = importlib.util.spec_from_file_location("gen_voice_copy", tools / "gen_voice.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_lesson_lines_voices_every_v2_line_of_word_and_letter_items():
    les = fixture()
    tid = les["template_id"]
    lines = gv.lesson_lines([str(FIXTURE)])
    for name, text in les["lines"].items():
        assert lines[f"{tid}.{name}"] == text
    by_id = {it["id"]: it for it in les["items"]}
    for item_id in ("apple", "banana"):
        for name in WORD_LINES:
            assert lines[f"{tid}.{item_id}.{name}"] == by_id[item_id]["lines"][name]
    assert lines[f"{tid}.apple.react_2"] == by_id["apple"]["lines"]["react_2"]
    for name in LETTER_LINES:
        assert lines[f"{tid}.b.{name}"] == by_id["b"]["lines"][name]


def test_lesson_lines_never_voices_captions_or_absent_lines():
    les = fixture()
    tid = les["template_id"]
    lines = gv.lesson_lines([str(FIXTURE)])
    prompts = json.loads((ROOT / "content" / "prompts" / "mr.json").read_text())
    captions = [*les["captions"].values(), *prompts.get("captions", {}).values()]
    captions += [c for it in les["items"] for c in it.get("captions", {}).values()]
    voiced = set(lines.values())
    assert [c for c in captions if c in voiced] == []
    assert not any("captions" in k.split(".") for k in lines)
    # banana has no react_2: no id is invented for it
    assert f"{tid}.banana.react_2" not in lines


def test_voice_latin_pairs_merge_over_builtin_latin(tmp_path):
    mod = load_copy(tmp_path, {"for": "फोर", "banana": "बनाना"})
    assert mod.LATIN["for"] == "फोर"  # the file wins over the built-in "फॉर"
    assert mod.LATIN["banana"] == "बनाना"
    assert mod.LATIN["apple"] == "ॲपल"  # built-in pairs the file does not name are kept
    assert mod.latin_to_dev("A for Apple") == "ए फोर ॲपल"


def test_take_check_accepts_new_english_word_and_still_flags_unknown_ones(tmp_path):
    mod = load_copy(tmp_path, {"banana": "बनाना"})
    # Scribe writes English words in Latin letters
    assert mod.missing_words("बनाना म्हणजे काय?", "Banana म्हणजे काय?") == []
    # a word in neither the built-in map nor voice_latin.json is still reported
    assert mod.missing_words("किवी म्हणजे काय?", "Kiwi म्हणजे काय?") == ["किवी"]


def test_new_batch_voices_only_lines_without_a_take(tmp_path, monkeypatch):
    les = fixture()
    tid = les["template_id"]
    (tmp_path / "content" / "prompts").mkdir(parents=True)
    (tmp_path / "content" / "prompts" / "mr.json").write_text(json.dumps(
        {"lines": {"praise_first_1": "छान!", "bye_1": "उद्या भेटूया!"},
         "captions": {"bye_1": "See you tomorrow!"}}, ensure_ascii=False))
    banana = {f"{tid}.banana.{n}" for n in WORD_LINES}
    all_ids = set(gv.lesson_lines([str(FIXTURE)]))  # real prompts; only used to derive lesson ids
    lesson_ids = {i for i in all_ids if i.startswith(f"{tid}.")}
    voiced_before = (lesson_ids - banana) | {"praise_first_1", "bye_1"}
    audio = tmp_path / "content" / "audio"
    (audio / "shekru").mkdir(parents=True)
    for i in voiced_before:
        (audio / "shekru" / f"{i}.wav").write_bytes(b"RIFF")
    clip = {"duration": 1.0, "events": []}
    (audio / "visemes.json").write_text(json.dumps(
        {"lines": {}, "clips": {"shekru": {i: clip for i in voiced_before}}}))

    sent, checked = {}, []

    def fake_batch(jobs):
        sent.update(jobs)
        return {k: b"RIFF" for k in jobs}

    def fake_job(char, line, redo, check, takes=4):
        checked.append(line)
        return char, line, clip, ""

    for name in ("LINES", "OUT", "PREFETCHED"):
        monkeypatch.setattr(gv, name, getattr(gv, name))  # restored after the test
    monkeypatch.setattr(gv, "__file__", str(tmp_path / "tools" / "gen_voice.py"))
    monkeypatch.setattr(gv, "batch_tts", fake_batch)
    monkeypatch.setattr(gv, "job", fake_job)
    monkeypatch.setattr(sys, "argv", ["gen_voice.py", "shekru", "--new", "--batch", "--lesson", str(FIXTURE)])
    gv.main()

    assert {line for _, line in sent} == banana
    assert {c for c, _ in sent} == {"shekru"}
    assert set(checked) == banana
    item = next(it for it in les["items"] if it["id"] == "banana")
    for name in WORD_LINES:  # the voice text goes to TTS, never the caption
        assert sent[("shekru", f"{tid}.banana.{name}")][0] == item["lines"][name]
    saved = json.loads((audio / "visemes.json").read_text())["clips"]["shekru"]
    assert set(saved) == voiced_before | banana


def test_contract_output_for_dependents_shape():
    """Output for dependents (owner voicing runs; no story consumes it): `gen_voice.py --lesson`
    voices every v2 line and every shared family; extra pairs come from tools/voice_latin.json."""
    les = fixture()
    tid = les["template_id"]
    lines = gv.lesson_lines([str(FIXTURE)])
    assert isinstance(lines, dict)
    assert all(isinstance(k, str) and isinstance(v, str) for k, v in lines.items())
    for name in ["teach_mr_led", "teach_en_led", "ask", "ack_meaning", "model_mr", "react_1", "react_2"]:
        assert f"{tid}.apple.{name}" in lines
    shared = json.loads((ROOT / "content" / "prompts" / "mr.json").read_text())["lines"]
    assert set(shared) <= set(lines)  # every shared family keeps its prompt-library id

    pairs = json.loads(VOICE_LATIN.read_text())
    assert isinstance(pairs, dict) and pairs
    assert all(isinstance(k, str) and isinstance(v, str) for k, v in pairs.items())
    assert all(gv.LATIN[k.lower()] == v for k, v in pairs.items())
