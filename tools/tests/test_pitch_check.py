"""GURU-55: tools/pitch_check.py, the check of new tutor takes against the existing ones.

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/tests/test_pitch_check.py

No network, no ffmpeg. Every wav is synthetic and written under tmp_path; content/audio/
is never read.

Sources, read and not assumed:
- tools/gen_voice.py wav_bytes: Gemini returns 24 kHz 16-bit mono PCM; takes sit as <id>.wav
  next to <id>.mp3; `--redo` keeps the old one as <id>.prev.wav.
- GURU-55 Technical notes: 40 ms frames, 10 ms hop, skip frames under 10% of the clip peak,
  lag range rate/600 .. rate/80, keep a frame when ac[lag] > 0.5 * ac[0], median of kept frames.

Handoff `output_for_dependents` is encoded in test_contract_for_dependents.
"""
import importlib
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

RATE = 24000


def pc():
    return importlib.import_module("pitch_check")


def tone(hz, seconds=1.0, rate=RATE):
    """Harmonic tone, int16: fundamental plus four overtones at 1/k amplitude."""
    t = np.arange(int(rate * seconds)) / rate
    wave_ = sum(np.sin(2 * np.pi * hz * k * t) / k for k in range(1, 6))
    return (wave_ / np.abs(wave_).max() * 12000).astype(np.int16)


def write_wav(path, samples, rate=RATE):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.asarray(samples, dtype=np.int16).tobytes())


def test_contract_for_dependents():
    """output_for_dependents: median_pitch, take_pitch, low_takes, main exist (shape only)."""
    m = pc()
    for name in ("median_pitch", "take_pitch", "low_takes", "main"):
        assert callable(getattr(m, name)), name
    assert isinstance(m.median_pitch(tone(250), RATE), float)
    cut, flagged = m.low_takes({"a": 250.0, "b": 260.0}, {"c": 100.0})
    assert isinstance(cut, float) and isinstance(flagged, list)
    assert flagged and isinstance(flagged[0], tuple) and len(flagged[0]) == 2


def test_median_pitch_of_250hz_tone_and_silence():
    m = pc()
    hz = m.median_pitch(tone(250), RATE)
    assert hz == pytest.approx(250, rel=0.03)
    assert m.median_pitch(np.zeros(RATE, dtype=np.int16), RATE) is None


def test_take_pitch_reads_a_16bit_mono_wav(tmp_path):
    p = tmp_path / "x.wav"
    write_wav(p, tone(300))
    assert pc().take_pitch(p) == pytest.approx(300, rel=0.03)


def test_low_takes_flags_only_below_the_fifth_percentile_sorted_ascending():
    m = pc()
    old = {f"o{i}": 230.0 + i * 10 for i in range(8)}  # 230 .. 300
    cut, flagged = m.low_takes(old, {"low": 180.0, "ok": 260.0})
    assert cut == pytest.approx(float(np.percentile(list(old.values()), 5)))
    assert flagged == [("low", 180.0)]  # 260 is under the median (265) but above the cut
    _, flagged = m.low_takes(old, {"a": 190.0, "b": 150.0, "c": 170.0, "high": 400.0})
    assert [i for i, _ in flagged] == ["b", "c", "a"]


def make_folder(tmp_path, new_hz):
    """Old takes 230..300 Hz, a stray .prev and .reject take at 150 Hz, plus the new takes."""
    d = tmp_path / "shekru"
    d.mkdir()
    for i in range(8):
        write_wav(d / f"old_{i}.wav", tone(230 + i * 10, 0.5))
    write_wav(d / "old_0.prev.wav", tone(150, 0.5))
    write_wav(d / "gone.reject1.wav", tone(150, 0.5))
    for name, hz in new_hz.items():
        write_wav(d / f"{name}.wav", tone(hz, 0.5))
    listing = tmp_path / "new.txt"
    listing.write_text("".join(f"{d}/{n}.mp3\n" for n in new_hz) + f"{d}/gone.reject1.mp3\n{d}/old_0.prev.mp3\n")
    return d, listing


def test_cli_exits_1_and_prints_low_line_per_flagged_take(tmp_path, capsys):
    d, listing = make_folder(tmp_path, {"react_1": 180, "praise_2": 260, "tryagain_2": 170})
    assert pc().main([str(d), str(listing)]) == 1
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert any(l.startswith("old takes: 8") for l in lines)  # .prev and .reject ignored
    assert any(l.startswith("new takes: 3") for l in lines)  # .prev and .reject ignored
    low = [l for l in lines if l.startswith("LOW ")]
    assert [l.split()[-1] for l in low] == ["tryagain_2", "react_1"]  # lowest first
    assert all(" Hz  " in l for l in low)
    assert "praise_2" not in out.replace("new takes", "")


def test_cli_exits_0_when_nothing_is_flagged(tmp_path, capsys):
    d, listing = make_folder(tmp_path, {"praise_2": 260})
    assert pc().main([str(d), str(listing)]) == 0
    assert "LOW" not in capsys.readouterr().out


def test_cli_fails_with_a_message_when_there_are_no_old_takes(tmp_path, capsys):
    d = tmp_path / "shekru"
    d.mkdir()
    write_wav(d / "only_new.wav", tone(250, 0.5))
    write_wav(d / "x.prev.wav", tone(250, 0.5))
    listing = tmp_path / "new.txt"
    listing.write_text(f"{d}/only_new.mp3\n")
    assert pc().main([str(d), str(listing)]) == 2
    captured = capsys.readouterr()
    assert "old takes" in (captured.out + captured.err).lower()


# Edges a clean 250 Hz tone does not reach: frame length, lag range, voicing threshold.

def test_median_pitch_reads_both_ends_of_the_range():
    """90 Hz needs 40 ms frames (a 20 ms frame keeps under half the period overlap) and a 0.5 cut;
    500 Hz needs the lag range to reach 600 Hz."""
    m = pc()
    assert m.median_pitch(tone(90), RATE) == pytest.approx(90, rel=0.03)
    assert m.median_pitch(tone(500), RATE) == pytest.approx(500, rel=0.03)


def test_median_pitch_never_reports_outside_80_to_600_hz():
    m = pc()
    for hz in (60, 700):
        got = m.median_pitch(tone(hz), RATE)
        assert got is None or 80 <= got <= 600, (hz, got)


def test_median_pitch_skips_frames_less_than_half_periodic():
    """A 250 Hz tone under noise of 1.5 times its power autocorrelates to about 0.36 at its period."""
    t = tone(250).astype(np.float64)
    noise = np.random.default_rng(0).standard_normal(len(t))
    noise *= np.sqrt((t ** 2).mean() * 1.5 / (noise ** 2).mean())
    assert pc().median_pitch(t + noise, RATE) is None


def test_median_pitch_measures_a_50_ms_clip():
    """Two 40 ms frames fit in 50 ms; a longer frame would not fit and give None."""
    assert pc().median_pitch(tone(250, 0.05), RATE) == pytest.approx(250, rel=0.03)


def test_cli_takes_bare_ids_that_contain_dots(tmp_path, capsys):
    """Lesson and item ids contain dots; a bare id must not lose its last part as a suffix."""
    d, _ = make_folder(tmp_path, {"tpl_x.a.react_1": 180, "tpl_x.lesson.intro": 260})
    listing = tmp_path / "ids.txt"
    listing.write_text("tpl_x.a.react_1\ntpl_x.lesson.intro\n")
    assert pc().main([str(d), str(listing)]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert any(l.startswith("old takes: 8") for l in lines)
    assert any(l.startswith("new takes: 2") for l in lines)
    assert [l.split()[-1] for l in lines if l.startswith("LOW ")] == ["tpl_x.a.react_1"]
