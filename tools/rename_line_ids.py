"""Rename voiced shared lines to their TDD 2.4 family ids (GURU-11).

Usage: python tools/rename_line_ids.py [--audio DIR]   (default: content/audio)

Renames <DIR>/<tutor>/<old>.* (mp3, wav, and gen_voice's .prev/.rejectN takes) to <new>.* in every
tutor folder, and the matching keys in <DIR>/visemes.json (`lines` and each tutor's `clips`).
The text is unchanged, so the clips stay valid. Safe to run again: ids already renamed are skipped.
Stops without changing anything if a new id is already taken.
"""
import argparse
import json
import sys
from pathlib import Path

RENAMES = {
    "ok_1": "praise_first_1",
    "ok_2": "praise_first_2",
    "ok_3": "praise_first_3",
    "wrong_1": "tryagain_1",
    "wrong_2": "tryagain_2",
    "nohear": "nohear_1",
}


def renamed(d, where, clashes):
    clashes += [f"{where}: both {o} and {n}" for o, n in RENAMES.items() if o in d and n in d]
    return {RENAMES.get(k, k): v for k, v in d.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--audio", type=Path, default=Path(__file__).resolve().parent.parent / "content" / "audio")
    audio = ap.parse_args().audio

    moves, clashes = [], []
    for tutor in sorted(p for p in audio.iterdir() if p.is_dir()):
        for f in sorted(tutor.iterdir()):
            stem, dot, rest = f.name.partition(".")  # also <id>.prev.wav, <id>.rejectN.wav
            if stem in RENAMES:
                dest = tutor / f"{RENAMES[stem]}{dot}{rest}"
                if dest.exists():
                    clashes.append(f"{dest} exists")
                else:
                    moves.append((f, dest))

    vis_path = audio / "visemes.json"
    vis = json.loads(vis_path.read_text(encoding="utf8")) if vis_path.exists() else None
    if vis is not None:
        vis["lines"] = renamed(vis.get("lines", {}), "visemes.json lines", clashes)
        vis["clips"] = {t: renamed(c, f"visemes.json clips.{t}", clashes) for t, c in vis.get("clips", {}).items()}

    if clashes:
        sys.exit("nothing renamed, new ids already taken:\n  " + "\n  ".join(clashes))
    for src, dest in moves:
        src.rename(dest)
    if vis is not None:
        vis_path.write_text(json.dumps(vis, ensure_ascii=False), encoding="utf8")
    print(f"renamed {len(moves)} file(s) in {audio}")


if __name__ == "__main__":
    main()
