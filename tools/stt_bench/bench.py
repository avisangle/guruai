"""Speech-to-text benchmark: runs each provider on the same labelled clips and reports how well it decides answers.

Usage (from the project root, venv active):
  python tools/stt_bench/bench.py <export.zip|folder> [--providers a,b] [--limit N]
                                  [--el-env PATH] [--allow-external] [--out DIR]
Input format: docs/clip-export.md. Output: <out>/<timestamp>/clips.csv and summary.md.
"""
import argparse
import csv
import json
import math
import subprocess
import sys
import tempfile
import time
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

import evaluator  # noqa: E402
import pricing  # noqa: E402
from providers import ALL, BY_NAME  # noqa: E402
from providers.base import Lesson  # noqa: E402

PAIRS = {"इ/ई": {"i", "ii"}, "उ/ऊ": {"u", "uu"}}
# Word items stay practice-only until a tap-mode test passes both (PRD Language design 9).
WORD_ACCEPT_MIN, WORD_FALSE_PRAISE_MAX = 80, 5  # percent
COLUMNS = ["clip", "child", "item", "kind", "label", "provider", "output", "verdict", "heard", "latency_ms", "error",
           "normalised", "cost", "note", "transcript", "scores"]


# --- input ----------------------------------------------------------------
def open_export(src: Path, tmp: Path) -> Path:
    """Folder holding manifest.json and clips/. A zip is extracted (manifest and clips/ only)."""
    if src.is_dir():
        return src
    with zipfile.ZipFile(src) as z:
        for name in z.namelist():
            parts = Path(name).parts
            if name == "manifest.json" or (len(parts) == 2 and parts[0] == "clips" and parts[1] not in ("", "..")):
                z.extract(name, tmp)
    return tmp


def load_manifest(folder: Path):
    m = json.loads((folder / "manifest.json").read_text())
    if m.get("format") != 1:
        sys.exit(f"unsupported manifest format {m.get('format')!r} (expected 1)")
    return m


def key_part(clip, i):
    """Part i of the clip's item_key, <lang>:<kind>:<display> (docs/clip-export.md), or None."""
    parts = clip.get("item_key", "").split(":")
    return parts[i] if len(parts) > i and parts[i] else None


def lessons_for(clips):
    """template_id -> Lesson, from content/lessons/*.json plus anything only the manifest knows."""
    out = {}
    for p in sorted((ROOT / "content" / "lessons").glob("*.json")):
        les = json.loads(p.read_text())
        out[les["template_id"]] = Lesson(les["template_id"], {
            it["id"]: {"display": it["display"], "target_lang": it.get("target_lang"),
                       "expected": it["assessment"]["expected"],
                       "accepted_variants": it["assessment"]["accepted_variants"],
                       "also_correct": it["assessment"].get("also_correct", []),
                       "langs": it["assessment"].get("langs", {})} for it in les["items"]})
    for c in clips:
        les = out.setdefault(c["template_id"], Lesson(c["template_id"]))
        les.items.setdefault(c["item_id"], {"target_lang": key_part(c, 0),
                                            **{k: c[k] for k in ("display", "expected", "accepted_variants")}})
    return out


def duration_s(clip, path: Path):
    if clip.get("duration_ms"):
        return clip["duration_ms"] / 1000
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def converted(path: Path, fmt: str, cache: Path) -> Path:
    if fmt == "original":
        return path
    dest = cache / f"{path.stem}.{fmt}.wav"
    if not dest.exists():  # wav16k: 16 kHz mono 16-bit PCM
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", str(dest)], check=True)
    return dest


# --- run ------------------------------------------------------------------
def run_provider(prov, clips, folder, lessons, cache):
    rows = []
    for n, c in enumerate(clips, 1):
        src = folder / c["file"]
        row = {"clip": c["id"], "child": c["child"], "item": c["item_id"], "kind": c["kind"], "label": c["label"],
               "provider": prov.name, "output": "", "verdict": "", "heard": "", "latency_ms": "", "error": "",
               "normalised": "", "cost": "", "note": "", "transcript": "", "scores": "", "_dur": duration_s(c, src)}
        try:
            audio = converted(src, prov.audio, cache)
            t0 = time.perf_counter()
            out = prov.run(audio, c, lessons[c["template_id"]])
            row["latency_ms"] = out.latency_ms if out.latency_ms is not None else round((time.perf_counter() - t0) * 1000)
            row["output"], row["note"], row["transcript"] = out.text, out.note, out.transcript
            if out.scores:  # closed scorers: every candidate's score, best first
                ranked = sorted(out.scores.items(), key=lambda kv: -kv[1])
                row["scores"] = json.dumps({k: round(v, 3) for k, v in ranked}, ensure_ascii=False)
            row["normalised"] = evaluator.normalise(out.text) if not out.closed else out.text
            item = lessons[c["template_id"]].items[c["item_id"]]  # judged by the current lesson's rules
            if out.closed:  # scorers that report no candidate text: the choice itself stands for it
                text = out.matched or (None if out.text in (evaluator.OTHER, evaluator.NOTHING) else out.text)
                heard = evaluator.classify(item, out.text, text, out.unsure)
            else:  # a transcript: only an answer said as itself counts (no judge choice credits a sound swap)
                heard = evaluator.classify(item, evaluator.OTHER if row["normalised"] else evaluator.NOTHING, out.text)
            row["heard"], row["verdict"] = heard["kind"], evaluator.VERDICT[heard["kind"]]
            cost = out.cost if out.cost is not None else pricing.by_duration(prov.pricing or prov.name, row["_dur"])
            row["cost"] = "" if cost is None else f"{cost:.8f}"
        except Exception as e:  # one failed clip must not stop the run
            row["error"] = f"{type(e).__name__}: {e}"[:300]
        print(f"  {prov.name} {n}/{len(clips)} {c['id']} {c['item_id']}/{c['label']}: "
              f"{row['output']!r} -> {row['verdict'] or 'ERROR ' + row['error']}", flush=True)
        rows.append(row)
    return rows


# --- summary --------------------------------------------------------------
def frac(k, n):
    return f"{k}/{n} ({100 * k / n:.0f}%)" if n else "n/a"


def pct(values, q):
    if not values:
        return None
    v = sorted(values)
    return v[max(0, math.ceil(q * len(v)) - 1)]


def metrics(rows):
    ok = [r for r in rows if not r["error"]]
    said = [r for r in ok if r["label"] != "silent"]
    right = [r for r in ok if r["label"] == "correct"]
    wrong = [r for r in ok if r["label"] == "wrong"]
    silent = [r for r in ok if r["label"] == "silent"]
    m = {
        "n": len(rows), "errors": len(rows) - len(ok),
        "agree": (sum(r["verdict"] == r["label"] for r in said), len(said)),
        "fa": (sum(r["verdict"] == "correct" for r in wrong), len(wrong)),
        "fr": (sum(r["verdict"] != "correct" for r in right), len(right)),
        "fr_unclear": sum(r["verdict"] == "unclear" for r in right),
        "silence": (sum(r["verdict"] == "unclear" for r in silent), len(silent)),
        "silence_correct": sum(r["verdict"] == "correct" for r in silent),  # praised for saying nothing
    }
    for pair, ids in PAIRS.items():
        ps = [r for r in said if r["item"] in ids]
        m[pair] = {"agree": (sum(r["verdict"] == r["label"] for r in ps), len(ps)),
                   "fa": (sum(r["verdict"] == "correct" for r in ps if r["label"] == "wrong"),
                          sum(r["label"] == "wrong" for r in ps)),
                   "fr": (sum(r["verdict"] != "correct" for r in ps if r["label"] == "correct"),
                          sum(r["label"] == "correct" for r in ps))}
    lat = [r["latency_ms"] for r in ok]
    m["p50"], m["p90"] = pct(lat, 0.5), pct(lat, 0.9)
    costs = [r for r in ok if r["cost"] != ""]
    secs = sum(r["_dur"] for r in costs)
    m["session_cost"] = (sum(float(r["cost"]) for r in costs) / secs * pricing.SESSION_AUDIO_S
                         if costs and len(costs) == len(ok) and secs else None)
    m["items"] = defaultdict(lambda: [0, 0])
    for r in said:
        m["items"][r["item"]][0] += r["verdict"] == r["label"]
        m["items"][r["item"]][1] += 1
    return m


def money(value, currency):
    if value is None:
        return "n/a"
    sym = {"USD": "$", "INR": "₹"}.get(currency, currency + " ")
    return f"{sym}{value:.4f}" if value else f"{sym}0"


def judge_labelled(clips):
    return sum(c.get("label_by") == "judge" for c in clips)


def word_test(rows, word_clips):
    """(accepted, false praise) as (k, n) over the given clips without a provider error: labelled correct
    and judged correct (a meaning included), labelled wrong or silent and judged correct."""
    ok = [r for r in rows if r["clip"] in word_clips and not r["error"]]
    right = [r for r in ok if r["label"] == "correct"]
    rest = [r for r in ok if r["label"] != "correct"]
    return (sum(r["verdict"] == "correct" for r in right), len(right)), (sum(r["verdict"] == "correct" for r in rest), len(rest))


def gate(k, n, met):
    return f"{frac(k, n)} {'pass' if met else 'fail'}" if n else "n/a"


def summary(manifest, src, by_prov, skipped, provs, lessons):
    clips = manifest["clips"]
    labels = defaultdict(int)
    for c in clips:
        labels[c["label"]] += 1
    L = [f"# Speech-to-text benchmark, {datetime.now():%Y-%m-%d %H:%M}", "",
         f"Source: `{src}` (exported {manifest.get('exported_at')}, app {manifest.get('app_version')}). "
         f"{len(clips)} clips: " + ", ".join(f"{k} {v}" for k, v in sorted(labels.items())) + ". "
         f"Children: {len({c['child'] for c in clips})}.", "",
         *([f"**{judge_labelled(clips)} clips are labelled by the app's own judge** (`label_by: judge`, docs/clip-export.md): "
            "agreement on them shows how often this provider matches the phone, not whether the child was right.", ""]
           if judge_labelled(clips) else []),
         "Verdicts come from `evaluator.py` (README: How verdicts are computed). Rates are over clips without "
         "a provider error. Small counts: read k/n, not just the percentage.", "",
         "| Provider | Agreement (said something) | False accept (said wrong, judged correct) | "
         "False reject (said correct, judged wrong or unclear) | Silence detected | इ/ई agreement | उ/ऊ agreement "
         "| Latency p50 / p90 | Cost per session | Errors |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    ms = {}
    for p in provs:
        if p.name not in by_prov:
            continue
        m = ms[p.name] = metrics(by_prov[p.name])
        cur = pricing.describe(p.pricing or p.name, getattr(p, "model", None))[0]
        fr = frac(*m["fr"]) + (f", {m['fr_unclear']} unclear" if m["fr_unclear"] else "")
        sil = frac(*m["silence"]) + (f", {m['silence_correct']} judged correct" if m["silence_correct"] else "")
        lat = f"{m['p50']} / {m['p90']} ms" if m["p50"] is not None else "n/a"
        L.append(f"| {p.name} | {frac(*m['agree'])} | {frac(*m['fa'])} | {fr} | {sil} | "
                 f"{frac(*m['इ/ई']['agree'])} | {frac(*m['उ/ऊ']['agree'])} | {lat} | "
                 f"{money(m['session_cost'], cur)} | {m['errors']}/{m['n']} |")
    L += ["", "False accepts are the worst error: the child hears praise for a wrong answer.", "",
          "## Word-item judge test", "",
          f"Word items stay practice-only (`WORD_ITEMS_GATED`, D-GURU-12-word-items-practice-only) until at least "
          f"{WORD_ACCEPT_MIN}% of correct answers are accepted and at most {WORD_FALSE_PRAISE_MAX}% of wrong or silent "
          "answers are judged correct (PRD Language design 9). Counted over tap-labelled clips of word items "
          "(no `label_by`) without a provider error; a meaning counts as accepted.", "",
          f"| Provider | Correct answers accepted (at least {WORD_ACCEPT_MIN}%) | "
          f"False praise (said wrong or nothing, judged correct; at most {WORD_FALSE_PRAISE_MAX}%) |", "|---|---|---|"]
    words = {c["id"] for c in clips if not c.get("label_by") and key_part(c, 1) == "word"}
    for name in ms:
        (ak, an), (fk, fn) = word_test(by_prov[name], words)
        L.append(f"| {name} | {gate(ak, an, 100 * ak >= WORD_ACCEPT_MIN * an)} | "
                 f"{gate(fk, fn, 100 * fk <= WORD_FALSE_PRAISE_MAX * fn)} |")
    L += ["", "## Length pairs", "", "| Provider | इ/ई false accept | इ/ई false reject | उ/ऊ false accept | उ/ऊ false reject |",
          "|---|---|---|---|---|"]
    for name, m in ms.items():
        L.append(f"| {name} | {frac(*m['इ/ई']['fa'])} | {frac(*m['इ/ई']['fr'])} | "
                 f"{frac(*m['उ/ऊ']['fa'])} | {frac(*m['उ/ऊ']['fr'])} |")
    items = list(dict.fromkeys(c["item_id"] for c in clips))
    disp = {iid: it["display"] for les in lessons.values() for iid, it in les.items.items()}
    L += ["", "## Agreement per item (said something)", "",
          "| Item | " + " | ".join(ms) + " |", "|---|" + "---|" * len(ms)]
    for iid in items:
        L.append(f"| {disp.get(iid, iid)} ({iid}) | " + " | ".join(frac(*ms[n]['items'][iid]) for n in ms) + " |")
    L += ["", f"## Prices (read {pricing.CHECKED})", "",
          f"Cost per session = run cost per second of audio x {pricing.SESSION_AUDIO_S} s (about 4 minutes of "
          "child audio, per the blueprint). Gemini cost uses the token counts each response reported.", "",
          "| Provider | Price | Source |", "|---|---|---|"]
    seen = set()
    for p in provs:
        key = (p.pricing or p.name, getattr(p, "model", None))
        if key in seen:
            continue
        seen.add(key)
        _, text, url = pricing.describe(*key)
        L.append(f"| {key[0]} | {text} | {url} |")
    if skipped:
        L += ["", "## Skipped", ""] + [f"- {n}: {why}" for n, why in skipped]
    L += ["", "## Notes", "",
          "- Verdicts are the raw item judgement. In a teach turn the app passes any speech (only silence vs "
          "speech matters there), so teach-turn verdicts matter for the quiz-style judgement only.",
          "- Silence detected: a clip labelled silent judged unclear (empty transcript or closed-set \"nothing\"). "
          "A silent clip judged correct is listed too: in a quiz the child would be praised for saying nothing.",
          "- `wrong` clips are what testers marked wrong; what the child said instead is unknown."]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="export zip or unpacked folder")
    ap.add_argument("--providers", help="comma list; default all: " + ",".join(BY_NAME))
    ap.add_argument("--limit", type=int, help="only the first N clips")
    ap.add_argument("--el-env", help=".env holding ELEVENLABS_API_KEY")
    ap.add_argument("--allow-external", action="store_true",
                    help="allow sending clips to external services (needs parent consent for real clips)")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    a = ap.parse_args()

    if a.el_env:
        from gen_voice_el import load_env
        load_env(a.el_env)
    names = a.providers.split(",") if a.providers else list(BY_NAME)
    unknown = [n for n in names if n not in BY_NAME]
    if unknown:
        sys.exit(f"unknown provider(s) {unknown}; choose from {list(BY_NAME)}")
    provs = [BY_NAME[n]() for n in names]

    with tempfile.TemporaryDirectory() as tmp:
        folder = open_export(a.source, Path(tmp) / "export")
        manifest = load_manifest(folder)
        clips = manifest["clips"][: a.limit] if a.limit else manifest["clips"]
        manifest = {**manifest, "clips": clips}
        if judge_labelled(clips):
            print(f"warning: {judge_labelled(clips)}/{len(clips)} clips are labelled by the app's judge, not a tester", file=sys.stderr)
        lessons = lessons_for(clips)
        cache = Path(tmp) / "audio"
        cache.mkdir()
        by_prov, skipped = {}, []
        for p in provs:
            why = p.missing() or (None if a.allow_external or not p.external else
                                  "external service; pass --allow-external (real clips need parent consent first)")
            if why:
                print(f"SKIP {p.name}: {why}")
                skipped.append((p.name, why))
                continue
            print(f"RUN {p.name} on {len(clips)} clips")
            p.prepare()
            by_prov[p.name] = run_provider(p, clips, folder, lessons, cache)

    stamp, n = datetime.now().strftime("%Y%m%d-%H%M%S"), 1
    a.out.mkdir(parents=True, exist_ok=True)
    while True:  # runs started in the same second get -2, -3, ...
        out = a.out / (stamp if n == 1 else f"{stamp}-{n}")
        try:
            out.mkdir()
            break
        except FileExistsError:
            n += 1
    with open(out / "clips.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, COLUMNS, extrasaction="ignore")
        w.writeheader()
        for rows in by_prov.values():
            w.writerows(rows)
    text = summary(manifest, a.source, by_prov, skipped, provs, lessons)
    (out / "summary.md").write_text(text, encoding="utf-8")
    print(text)
    print(f"wrote {out}/clips.csv and summary.md")


if __name__ == "__main__":
    main()
