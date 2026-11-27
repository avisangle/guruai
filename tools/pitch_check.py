"""Check new tutor takes against the existing ones by median pitch (GURU-55, D-GURU-55-take-pitch-check).

Usage: python tools/pitch_check.py <tutor audio dir> <new-takes file>
The file lists one path or id per line; the id is the file name less a .mp3 or .wav suffix
(ids themselves contain dots, `tpl_x.a.teach`). Takes are the .wav files
next to the .mp3s. `.prev.` and `.rejectN.` takes are ignored. Prints the old and new summaries
and one `LOW <hz> Hz  <id>` line per new take below the 5th percentile of the old takes.
Exit: 1 when any take is flagged, 0 when none, 2 when the folder has no old takes.
"""
import re
import sys
import wave
from pathlib import Path

import numpy as np

FRAME_S, HOP_S = 0.040, 0.010
MIN_HZ, MAX_HZ = 80, 600
VOICED = 0.5  # keep a frame when ac[lag] > VOICED * ac[0]
QUIET = 0.1  # skip frames whose peak is under this share of the clip's peak
STALE = re.compile(r"\.(prev|reject\d*)$")
AUDIO_EXT = re.compile(r"\.(mp3|wav)$")


def take_id(name):
    """A take's line id: its file name less a .mp3 or .wav suffix (ids contain dots)."""
    return AUDIO_EXT.sub("", Path(name).name)


def median_pitch(samples, rate):
    """Median voiced pitch in Hz by autocorrelation; None when no frame is voiced."""
    x = np.asarray(samples, dtype=np.float64)
    n, hop = int(rate * FRAME_S), int(rate * HOP_S)
    if len(x) < n or not np.abs(x).max():
        return None
    floor = QUIET * np.abs(x).max()
    lo, hi = int(rate / MAX_HZ), int(rate / MIN_HZ)
    found = []
    for s in range(0, len(x) - n + 1, hop):
        f = x[s:s + n]
        if np.abs(f).max() < floor:
            continue
        f = f - f.mean()
        ac = np.correlate(f, f, "full")[n - 1:]
        if ac[0] <= 0:
            continue
        lag = lo + int(np.argmax(ac[lo:hi + 1]))
        if ac[lag] > VOICED * ac[0]:
            found.append(rate / lag)
    return float(np.median(found)) if found else None


def take_pitch(path):
    with wave.open(str(path), "rb") as w:
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return median_pitch(samples, w.getframerate())


def low_takes(old, new, pct=5):
    """(cut, flagged): cut is the pct-th percentile of old pitches; flagged are new takes below it, lowest first."""
    cut = float(np.percentile(list(old.values()), pct))
    return cut, sorted(((i, hz) for i, hz in new.items() if hz < cut), key=lambda t: t[1])


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    folder, listing = Path(argv[0]), Path(argv[1])
    lines = [l.strip() for l in listing.read_text().splitlines() if l.strip()]
    new_ids = {i for i in map(take_id, lines) if not STALE.search(i)}
    old, new = {}, {}
    for p in sorted(folder.glob("*.wav")):
        i = take_id(p)
        if STALE.search(i):
            continue
        hz = take_pitch(p)
        if hz is not None:
            (new if i in new_ids else old)[i] = hz
    if not old:
        print(f"no old takes with a measurable pitch in {folder}", file=sys.stderr)
        return 2
    cut, flagged = low_takes(old, new)
    print(f"old takes: {len(old)}, median {np.median(list(old.values())):.0f} Hz, 5th pct {cut:.0f} Hz")
    med = f"{np.median(list(new.values())):.0f} Hz" if new else "n/a"
    print(f"new takes: {len(new)}, median {med}")
    for i, hz in flagged:
        print(f"LOW {hz:.0f} Hz  {i}")
    return 1 if flagged else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
