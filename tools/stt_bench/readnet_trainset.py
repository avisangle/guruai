"""Build the IndicConformer fine-tuning set from Pratham's ReadNet Marathi letters and words.

ReadNet (huggingface.co/datasets/PrathamOrgAI/ReadNet, CC BY-NC 4.0, credit Pratham Education Foundation;
Pratham allowed GuruAI to fine-tune on it). MR_Letters.csv and MR_Words.csv: one row per clip, the wav URL
(<child uuid>_MR_<sheet>_L|WD_<pos>.wav) and the annotator's transcript of what the child said.

Held out: every child of the bench fixture (readnet_fixture.py; its manifest keeps the first 8 hex digits of
the uuid, so any child with that prefix is dropped), in both CSVs. The rest is split by child: about 5% of
children (by a hash of the uuid) go to validation.

Transcript cleaning (see clean()): NFC; quotes, parentheses and trailing , . dropped; "-" (no valid answer),
rows holding "_" (annotator notes such as फणस_फ), other symbols, digits or Latin dropped; pure repeats joined
by "-" or spaces kept as the repeated word with spaces (र-र -> "र र", what the child said); hyphenated rows
whose parts differ (self-corrections, sounding out, annotator alternatives: कोस-कोळसा, प-पतंग, ध -ड) dropped;
rows from Hindi sheets (_HI_) dropped; every kept text must round-trip the Marathi tokenizer without <unk>.

Audio: downloaded with a thread pool (resumable: existing files are skipped), downmixed to mono like
ffmpeg -ac 1, stored as 16 kHz FLAC under ~/.cache/readnet/train/audio/. Manifests train.jsonl and val.jsonl
({audio, text, child, dur, source}) list only clips that downloaded.

Usage: python -I tools/stt_bench/readnet_trainset.py [--workers 8] [--limit N]
"""
import argparse
import csv
import hashlib
import io
import json
import re
import sys
import unicodedata
import urllib.request
import wave
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "readnet"
NAME = re.compile(r"^([0-9a-f-]{36})_([A-Z]+)_(S\d+_(?:L|WD)_\d+)\.wav$")
DEVA_WORD = re.compile(r"^[ऀ-ॣॱ-ॿ]+$")  # Devanagari letters and signs, no digits/danda
DROP_CHARS = str.maketrans("", "", "'\"“”‘’()")
VAL_PCT = 5


def clean(text):
    """Training transcript, or None to drop the row (rules in the module docstring)."""
    t = unicodedata.normalize("NFC", text).translate(DROP_CHARS).strip().rstrip(",.").strip()
    if not t or t == "-" or "_" in t:
        return None
    parts = [p for p in re.split(r"[\s-]+", t) if p]
    if not parts or not all(DEVA_WORD.match(p) for p in parts) or len(set(parts)) != 1:
        return None
    return " ".join(parts)


def split_of(child):
    return "val" if int(hashlib.sha1(child.encode()).hexdigest(), 16) % 100 < VAL_PCT else "train"


def to_flac(data, dest):
    """WAV bytes -> mono 16 kHz FLAC; returns duration in s."""
    import numpy as np
    import soundfile as sf
    with wave.open(io.BytesIO(data)) as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        if sr != 16000 or sw != 2 or ch not in (1, 2):
            raise ValueError(f"unexpected wav {sr} Hz, {ch} ch, {8 * sw} bit")
        x = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, ch)
    mono = x.mean(1).round().astype(np.int16) if ch == 2 else x[:, 0]
    tmp = dest.with_suffix(".part")
    sf.write(tmp, mono, 16000, format="FLAC", subtype="PCM_16")
    tmp.rename(dest)
    return len(mono) / 16000


def main():
    import sentencepiece as spm
    sys.path.insert(0, str(HERE))
    from providers.indicconformer import TOKENIZER

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, nargs="+", default=[CACHE / "MR_Letters.csv", CACHE / "MR_Words.csv"])
    ap.add_argument("--fixture", type=Path, default=CACHE / "fixture-mr-letters" / "manifest.json")
    ap.add_argument("--out", type=Path, default=CACHE / "train")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, help="only the first N kept rows (smoke test)")
    a = ap.parse_args()

    sp = spm.SentencePieceProcessor(model_file=str(TOKENIZER))
    held = {c["child"] for c in json.loads(a.fixture.read_text())["clips"]}
    rows, why = [], Counter()
    for path in a.csv:
        with open(path, encoding="utf-8-sig") as f:
            for url, text in list(csv.reader(f))[1:]:
                m = NAME.match(url.rsplit("/", 1)[1])
                if not m or m.group(2) != "MR":
                    why["not a Marathi sheet"] += 1
                    continue
                child = m.group(1)
                if child[:8] in held:
                    why["fixture child (held out)"] += 1
                    continue
                t = clean(text)
                if t is None:
                    why["transcript dropped"] += 1
                    continue
                ids = sp.encode(t)
                if sp.unk_id() in ids or sp.decode(ids) != t:
                    why["not covered by tokenizer"] += 1
                    continue
                why["repeat kept as words"] += " " in t
                rows.append({"url": url, "text": t, "child": child, "source": f"{path.stem} {m.group(3)}",
                             "audio": f"audio/{child}_{m.group(3)}.flac"})
    rows = rows[: a.limit] if a.limit else rows
    print(f"{len(rows)} rows kept; {dict(why)}")

    (a.out / "audio").mkdir(parents=True, exist_ok=True)

    def fetch(r):
        dest = a.out / r["audio"]
        if not dest.exists():
            with urllib.request.urlopen(r["url"], timeout=60) as resp:
                data = resp.read()
            to_flac(data, dest)
        import soundfile as sf
        return sf.info(dest).frames / 16000

    done, failed = [], Counter()
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(fetch, r): r for r in rows}
        for n, fut in enumerate(as_completed(futs), 1):
            r = futs[fut]
            try:
                done.append({**{k: r[k] for k in ("audio", "text", "child", "source")}, "dur": round(fut.result(), 3)})
            except Exception as e:  # rerun to retry
                failed[f"{type(e).__name__}: {e}"[:80]] += 1
            if n % 500 == 0:
                print(f"  {n}/{len(rows)} ({sum(failed.values())} failed)", flush=True)
    for p in (a.out / "audio").glob("*.part"):
        p.unlink()

    done.sort(key=lambda r: r["audio"])
    for split in ("train", "val"):
        part = [r for r in done if split_of(r["child"]) == split]
        with open(a.out / f"{split}.jsonl", "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in part)
        kinds = Counter("letters" if "_L_" in r["source"] else "words" for r in part)
        print(f"{split}: {len(part)} clips ({dict(kinds)}), {sum(r['dur'] for r in part) / 3600:.2f} h, "
              f"{len({r['child'] for r in part})} children")
    if failed:
        print(f"failed {sum(failed.values())} (rerun to retry): {failed.most_common(5)}")


if __name__ == "__main__":
    main()
