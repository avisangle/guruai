"""Move clips to the app's recognizer probe over USB and fetch its results (docs/android-sr-probe.md).

  python tools/stt_bench/android_probe.py push <export.zip|folder>... [--limit N] [--force]
  python tools/stt_bench/android_probe.py push-model     # phone_model.py output -> the app's files/models/
  python tools/stt_bench/android_probe.py pull
Clips are converted to 16 kHz mono WAV and streamed straight into the app's private files
(adb exec-in + run-as, debug builds only), so they never sit in shared phone storage.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bench import converted, lessons_for, load_manifest, open_export  # noqa: E402

PKG = "com.guruai.app"
DIR = "files/probe"  # expo-file-system Paths.document is the app's files/ dir
RESULTS = ("results.json", "results-ic.json")  # Android recognizer, on-device IndicConformer
ADB = os.environ.get("ADB") or shutil.which("adb") or "/opt/homebrew/share/android-commandlinetools/platform-tools/adb"


def adb(*args, stdin=None, check=True):
    return subprocess.run([ADB, *args], input=stdin, capture_output=True, check=check)


def run_as(cmd, stdin=None, check=True):
    return adb("exec-in" if stdin is not None else "exec-out", "run-as", PKG, "sh", "-c", cmd,
               stdin=stdin, check=check)


def ok(cmd):
    """True when cmd succeeds as the app. exec-out does not pass back the remote exit code, so echo it."""
    return run_as(f"{cmd} && echo OK", check=False).stdout.strip().endswith(b"OK")


def need_phone():
    r = adb("get-state", check=False)
    if r.returncode or r.stdout.strip() != b"device":
        sys.exit("no phone: connect it by USB with USB debugging on (" + r.stderr.decode().strip() + ")")
    if not ok("true"):
        sys.exit(f"run-as {PKG} failed: is the GuruAI development build installed?")


def probe_candidates(candidates, sp):
    """The candidates the Mac judge scores: the lesson's plus child sound swaps (D-GURU-3), with token ids."""
    from providers import indicconformer as ic
    cs = ic.child_swaps(candidates) if ic.CHILD_SWAPS else candidates
    return [{"item_id": k.item_id, "display": k.display, "text": k.text, "ids": sp.encode(k.text)} for k in cs]


def push(a):
    need_phone()
    if any(ok(f"test -f {DIR}/{r}") for r in RESULTS) and not a.force:
        sys.exit("the phone already holds probe results: run `pull` first, or pass --force to discard them")
    from providers import indicconformer as ic
    sp = ic.load(ic.SLIM)[2]
    with tempfile.TemporaryDirectory() as tmp:
        sets = []  # (folder, clips) per export; results are keyed by clip id, so ids must not repeat
        for i, src in enumerate(a.source):
            folder = open_export(src, Path(tmp) / f"export{i}")
            clips = load_manifest(folder)["clips"]
            sets.append((folder, clips[: a.limit] if a.limit else clips))
        ids = [c["id"] for _, clips in sets for c in clips]
        if len(ids) != len(set(ids)):
            sys.exit("clip ids repeat across these exports; push them separately")
        cache = Path(tmp) / "audio"
        cache.mkdir()
        run_as(f"rm -rf {DIR} && mkdir -p {DIR}/clips")
        out = []
        for folder, clips in sets:
            lessons = lessons_for(clips)
            for c in clips:
                cands = probe_candidates(lessons[c["template_id"]].candidates(), sp)
                wav = converted(folder / c["file"], "wav16k", cache)
                run_as(f"cat > {DIR}/clips/{c['id']}.wav", stdin=wav.read_bytes())
                out.append({"id": c["id"], "file": f"clips/{c['id']}.wav",
                            "hints": lessons[c["template_id"]].answers(), "candidates": cands})
                print(f"\r  pushed {len(out)}/{len(ids)}", end="", flush=True)
        pieces = [sp.id_to_piece(i) for i in range(ic.VOCAB)]
        manifest = json.dumps({"source": [str(s) for s in a.source], "clips": out, "pieces": pieces},
                              ensure_ascii=False).encode()
        run_as(f"cat > {DIR}/manifest.json", stdin=manifest)
    print(f"\n{len(out)} clips on the phone. Open the probe screen (guruai://probe), tap refresh, then run clips.")


def push_model(a):
    from phone_model import INT8
    need_phone()
    if not INT8.exists():
        sys.exit(f"{INT8} not found: run tools/stt_bench/phone_model.py first")
    run_as("mkdir -p files/models")
    run_as("cat > files/models/mr_ctc_wav.int8.onnx", stdin=INT8.read_bytes())
    size = run_as("wc -c < files/models/mr_ctc_wav.int8.onnx").stdout.decode().strip()
    print(f"model on the phone: {size} bytes (local {INT8.stat().st_size})")


def pull(a):
    need_phone()
    a.out.mkdir(parents=True, exist_ok=True)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    found = False
    for name, env, provs in (("results.json", "ANDROID_SR_RESULTS", "android_sr,android_sr_biased"),
                             ("results-ic.json", "ANDROID_IC_RESULTS", "indicconformer_phone")):
        if not ok(f"test -f {DIR}/{name}"):
            continue
        found = True
        res = json.loads(run_as(f"cat {DIR}/{name}").stdout)
        dest = a.out / f"android-{name.replace('results', 'probe').replace('.json', '')}-{stamp}.json"
        dest.write_text(json.dumps(res, ensure_ascii=False, indent=1))
        head = {k: v for k, v in res.items() if k != "clips"}
        print(json.dumps(head, indent=1))
        print(f"{len(res['clips'])} clips with results -> {dest}")
        print(f"score: {env}={dest} python tools/stt_bench/bench.py <each pushed export> --providers {provs}\n")
    if not found:
        sys.exit("no results on the phone yet")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push")
    p.add_argument("source", type=Path, nargs="+", help="one or more exports, pushed as one set")
    p.add_argument("--limit", type=int, help="first N clips of each export")
    p.add_argument("--force", action="store_true", help="discard results already on the phone")
    p.set_defaults(fn=push)
    sub.add_parser("push-model").set_defaults(fn=push_model)
    q = sub.add_parser("pull")
    q.add_argument("--out", type=Path, default=HERE / "results")
    q.set_defaults(fn=pull)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
