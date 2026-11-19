"""Build a small synthetic clip export (docs/clip-export.md format) from Shekru's lesson audio.

Adult cartoon voice only, never children. Clips are cut at Whisper word times snapped to the
loudness segments of each line, so a clip holds whole words with a little silence around them.
Usage: python tools/stt_bench/make_fixture.py   -> tools/stt_bench/fixtures/guruai-clips-20261115-000000.zip
"""
import json
import subprocess
import sys
import tempfile
import wave
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from align_whisper import word_times  # noqa: E402
from gen_voice import lesson_lines, voiced_segments  # noqa: E402

LESSON = ROOT / "content" / "lessons" / "kg-mr-swar-1.json"
AUDIO = ROOT / "content" / "audio" / "shekru"
STAMP = "20261115-000000"
OUT = Path(__file__).resolve().parent / "fixtures" / f"guruai-clips-{STAMP}.zip"
PAIRS = {"i": "ii", "ii": "i", "u": "uu", "uu": "u", "a": "aa", "aa": "a"}


def load(line):
    with wave.open(str(AUDIO / f"{line}.wav")) as w:
        rate = w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return samples, rate


def span(line, text, first, last=None):
    """(start, end) s covering Whisper words first..last, snapped to loudness segments plus padding."""
    samples, rate = load(line)
    segs, _, _ = voiced_segments(samples, rate)
    words = word_times(AUDIO / f"{line}.mp3", text)
    t0, t1 = words[first][1], words[last if last is not None else first][2]

    def hits(a, b):  # segments overlapping (a, b) by at least 30% of their own length
        return [i for i, (s, e) in enumerate(segs) if min(e, b) - max(s, a) > 0.3 * (e - s)]

    idx = hits(t0, t1) or [min(range(len(segs)), key=lambda i: abs(sum(segs[i]) / 2 - (t0 + t1) / 2))]
    lo, hi = min(idx), max(idx)
    prev_end = segs[lo - 1][1] if lo else 0.0
    next_start = segs[hi + 1][0] if hi + 1 < len(segs) else len(samples) / rate
    start = max(segs[lo][0] - 0.25, (prev_end + segs[lo][0]) / 2)
    end = min(segs[hi][1] + 0.25, (segs[hi][1] + next_start) / 2)
    return start, end


def encode(src_args, dest):
    """Encode to m4a/AAC mono 16 kHz, as an Android recorder would produce."""
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src_args, "-ac", "1", "-ar", "16000",
                    "-c:a", "aac", "-b:a", "32k", str(dest)], check=True)


def main():
    lesson = json.loads(LESSON.read_text())
    lines = lesson_lines([LESSON])
    tid = lesson["template_id"]
    items = {it["id"]: it for it in lesson["items"]}
    specs = []  # (item id, kind, label, ffmpeg source args, seconds)

    def cut(item_for_label, kind, label, line, first, last=None):
        key = f"{tid}.{line}"
        a, b = span(key, lines[key], first, last)
        specs.append((item_for_label, kind, label, ["-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(AUDIO / f"{key}.wav")], b - a))

    for iid in items:
        cut(iid, "teach", "correct", f"{iid}.teach", 2)        # "हे बघ, अ." -> अ
        cut(iid, "quiz", "correct", f"{iid}.correct", -2)      # "..., अ, अननसाचा!" -> अ
        cut(iid, "quiz", "correct", f"{iid}.correct", -2, -1)  # -> अ, अननसाचा
        cut(iid, "quiz", "correct", f"{iid}.hint", 4)          # "... अननस! ..." -> अननस
    for iid, other in PAIRS.items():                           # partner letter under this item
        cut(iid, "quiz", "wrong", f"{other}.teach", 2)
    cut("u", "quiz", "wrong", "a.correct", 0)                  # शाब्बास
    cut("aa", "quiz", "wrong", "a.hint", 4)                    # अननस for आ
    for iid, kind, src, secs in [
        ("a", "quiz", "anullsrc=r=16000:cl=mono", 1.5),
        ("ii", "quiz", "anoisesrc=r=16000:color=white:amplitude=0.003", 2.0),
        ("uu", "teach", "anoisesrc=r=16000:color=brown:amplitude=0.02", 1.8),
    ]:
        specs.append((iid, kind, "silent", ["-f", "lavfi", "-t", str(secs), "-i", src], secs))

    clips = []
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(OUT, "w", zipfile.ZIP_STORED) as z:
        for n, (iid, kind, label, src, secs) in enumerate(specs, 1):
            it = items[iid]
            cid = f"c-{STAMP}-{n:03d}"
            dest = Path(tmp) / f"{cid}.m4a"
            encode(src, dest)
            z.write(dest, f"clips/{cid}.m4a")
            clips.append({
                "id": cid, "file": f"clips/{cid}.m4a", "child": "SYN", "age": None,
                "template_id": tid, "item_id": iid, "item_key": it["item_key"], "display": it["display"],
                "expected": it["assessment"]["expected"], "accepted_variants": it["assessment"]["accepted_variants"],
                "kind": kind, "label": label, "recorded_at": "2026-11-15T00:00:00Z", "duration_ms": round(secs * 1000),
            })
        manifest = {"format": 1, "exported_at": "2026-11-15T00:00:00Z", "app_version": "synthetic", "clips": clips}
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"{len(clips)} clips -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
