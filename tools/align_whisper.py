"""Local forced alignment of a known script to audio with Whisper (stable-ts), then visemes.

Whisper gives word timings; aksharas inside a word are spread evenly across it.
Usage as a module: aligned_events(mp3, text) -> [[t, viseme], ...]
Usage as a script: python tools/align_whisper.py --eval  (scores against ElevenLabs' own timestamps)
"""
import json
import sys
from functools import lru_cache
from pathlib import Path

from gen_voice import aksharas, viseme_pair

MODEL = "large-v3-turbo"


@lru_cache(1)
def model():
    import stable_whisper
    return stable_whisper.load_model(MODEL)


def word_times(mp3, text):
    res = model().align(str(mp3), text, language="mr", verbose=None)
    return [(w.word.strip(), w.start, w.end) for w in res.all_words() if w.word.strip()]


def aligned_events(mp3, text):
    events, prev_end = [], 0.0
    for word, t0, t1 in word_times(mp3, text):
        aks = [a for a in aksharas(word) if a != "|"]
        if not aks or t1 <= t0:
            continue
        if events and t0 - prev_end > 0.12:  # audible gap: close the mouth
            events.append([round(prev_end, 3), "rest"])
        step = (t1 - t0) / len(aks)
        for k, ak in enumerate(aks):
            t = t0 + k * step
            onset, vowel = viseme_pair(ak)
            if onset:
                events += [[round(t, 3), onset], [round(t + min(0.06, step * 0.4), 3), vowel]]
            else:
                events.append([round(t, 3), vowel])
        prev_end = t1
    events.append([round(prev_end, 3), "rest"])
    return events


def el_word_starts(al):
    """Word start times from ElevenLabs character alignment, skipping [tags]."""
    out, cur, start, in_tag = [], "", None, False
    for ch, t in zip(al["characters"], al["character_start_times_seconds"]):
        if ch == "[" or in_tag:
            in_tag = ch != "]"
            continue
        if ch in " ,.!?\n":
            if cur:
                out.append((cur, start))
            cur, start = "", None
            continue
        if start is None:
            start = t
        cur += ch
    if cur:
        out.append((cur, start))
    return out


def evaluate():
    from gen_voice import LINES
    root = Path(__file__).resolve().parent.parent / "design" / "voice"
    errs = []
    for clip in sorted((root / "el2").glob("*/*.json")) + sorted((root / "el").glob("*/*.json")):
        truth = el_word_starts(json.loads(clip.read_text())["alignment"])
        got = word_times(clip.with_suffix(".mp3"), LINES[clip.stem])
        if len(got) != len(truth):
            print("word count differs", clip, len(got), len(truth))
            continue
        e = [abs(g[1] - t[1]) for g, t in zip(got, truth)]
        errs += e
        print(f"{clip.parent.name}/{clip.stem}: mean {sum(e)/len(e)*1000:.0f} ms, max {max(e)*1000:.0f} ms")
    errs.sort()
    print(f"ALL {len(errs)} words: median {errs[len(errs)//2]*1000:.0f} ms, p90 {errs[int(len(errs)*.9)]*1000:.0f} ms, max {errs[-1]*1000:.0f} ms")


if __name__ == "__main__" and "--eval" in sys.argv:
    evaluate()
