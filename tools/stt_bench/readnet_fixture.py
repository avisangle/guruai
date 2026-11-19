"""Build a clip export (docs/clip-export.md format) from Pratham's ReadNet Marathi letters.

ReadNet (huggingface.co/datasets/PrathamOrgAI/ReadNet, CC BY-NC 4.0, credit Pratham Education
Foundation): children aged 5 to 16 reading ASER letter sheets. MR_Letters.csv has one row per
clip: the wav URL and the annotator's transcript of what the child said. The file name ends in
<sheet>_L_<position>; each position always shows the same letter, so the expected letter is the
most common transcript at that position. Labels:
  transcript == expected letter      -> correct
  transcript is another single letter -> wrong (that letter goes in `said`)
  transcript "-"                      -> silent (the annotator's mark for no answer; unverified)
  anything else (phrases, repeats)    -> left out
Correct clips are sampled per letter, one per child where possible; every wrong clip is kept.

Usage: python tools/stt_bench/readnet_fixture.py [--per-letter 10] [--silent 40]
  -> ~/.cache/readnet/fixture-mr-letters/{manifest.json,clips/}  (pass that folder to bench.py)
Download MR_Letters.csv first:
  curl -L -o ~/.cache/readnet/MR_Letters.csv \
    https://huggingface.co/datasets/PrathamOrgAI/ReadNet/resolve/main/MR_Letters.csv
"""
import argparse
import csv
import json
import random
import re
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

CACHE = Path.home() / ".cache" / "readnet"
TEMPLATE = "readnet_mr_letters"
POS = re.compile(r"^([0-9a-f-]{36})_MR_(S\d+_L_\d+)\.wav$")
LETTER = re.compile(r"^[क-हक़-य़]़?$")  # one consonant, optional nukta
QUOTES = str.maketrans("", "", "'\"()")


def load(csv_path):
    """[(url, child, position, transcript)] for Marathi rows."""
    out = []
    with open(csv_path, encoding="utf-8-sig") as f:
        for url, text in list(csv.reader(f))[1:]:
            m = POS.match(url.rsplit("/", 1)[1])
            if m:
                out.append((url, m.group(1), m.group(2), text.strip().translate(QUOTES).strip()))
    return out


def label(text, expected):
    if text == expected:
        return "correct", None
    if text == "-":
        return "silent", None
    if LETTER.match(text):
        return "wrong", text
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, default=CACHE / "MR_Letters.csv")
    ap.add_argument("--out", type=Path, default=CACHE / "fixture-mr-letters")
    ap.add_argument("--per-letter", type=int, default=10, help="correct clips per letter")
    ap.add_argument("--silent", type=int, default=40, help="silent clips in total")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    rows = load(a.csv)
    expected = {p: Counter(t for _, _, q, t in rows if q == p).most_common(1)[0][0] for p in {r[2] for r in rows}}
    rng = random.Random(a.seed)
    rng.shuffle(rows)

    picked, used_children, per_letter, silent = [], set(), defaultdict(int), 0
    skipped = Counter()
    # wrong clips first (all of them), then correct ones preferring unseen children, then silent
    for want in ("wrong", "correct", "silent"):
        for fresh_only in (True, False):
            for url, child, pos, text in rows:
                lab, said = label(text, expected[pos])
                if lab != want or any(p["url"] == url for p in picked):
                    continue
                if fresh_only and child in used_children and want != "wrong":
                    continue
                if want == "correct" and per_letter[expected[pos]] >= a.per_letter:
                    continue
                if want == "silent" and silent >= a.silent:
                    continue
                per_letter[expected[pos]] += want == "correct"
                silent += want == "silent"
                used_children.add(child)
                picked.append({"url": url, "child": child, "pos": pos, "label": lab, "said": said})
    for _, _, pos, text in rows:
        if label(text, expected[pos])[0] is None:
            skipped[text] += 1

    clips_dir = a.out / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    def fetch(p):
        dest = clips_dir / f"rn-{p['child'][:8]}-{p['pos']}.wav"
        if not dest.exists():
            with urllib.request.urlopen(p["url"], timeout=60) as r:
                dest.write_bytes(r.read())
        return dest

    with ThreadPoolExecutor(8) as ex:
        paths = list(ex.map(fetch, picked))

    clips = []
    for p, path in zip(picked, paths):
        letter = expected[p["pos"]]
        clips.append({
            "id": path.stem, "file": f"clips/{path.name}", "child": p["child"][:8], "age": None,
            "template_id": TEMPLATE, "item_id": letter, "item_key": f"mr:letter:{letter}", "display": letter,
            "expected": [letter], "accepted_variants": [], "kind": "quiz", "label": p["label"],
            "said": p["said"], "recorded_at": None, "duration_ms": None, "source": f"ReadNet {p['pos']}",
        })
    manifest = {"format": 1, "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "app_version": "readnet-fixture",
                "source": "Pratham ReadNet MR_Letters (CC BY-NC 4.0, Pratham Education Foundation)",
                "clips": clips}
    (a.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    labs = Counter(c["label"] for c in clips)
    print(f"{len(clips)} clips ({dict(labs)}), {len({c['child'] for c in clips})} children, "
          f"{len(set(expected.values()))} letters -> {a.out}")
    print(f"left out {sum(skipped.values())} rows with other transcripts, e.g. {skipped.most_common(5)}")


if __name__ == "__main__":
    main()
