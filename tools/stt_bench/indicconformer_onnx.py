"""On-device estimate for indicconformer_closed: export the CTC path to ONNX, quantise to int8, and measure
file size, peak RAM and one-thread latency on this machine, then check int8 choices against the torch model.

Usage (from the project root, venv active):
  python tools/stt_bench/indicconformer_onnx.py tools/stt_bench/fixtures/guruai-clips-20261115-000000.zip
  [--weights ~/.cache/indicconformer/finetuned/mr_ctc_readnet.pt]   (default: mr_ctc.pt)
ONNX files go next to the checkpoint (~/.cache/indicconformer/onnx/<weights stem>[.int8].onnx), outside the project.
Input to the ONNX model is the 80-mel feature matrix (1, 80, T); on a phone the features would be computed
natively (NeMo-style log-mel, see providers/indicconformer.py Features). Output: (T/4, 257) log-probs.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from bench import converted, lessons_for, load_manifest, open_export  # noqa: E402
from providers import indicconformer as ic  # noqa: E402

OUT = ic.NEMO.parent / "onnx"
CLIP_S = 2.0
RUNS = 20


def export(weights, fp32):
    import torch
    feats, net, _ = ic.load(weights)
    x = feats(torch.zeros(int(16000 * CLIP_S)).uniform_(-0.1, 0.1))
    OUT.mkdir(parents=True, exist_ok=True)
    t = torch.export.Dim("frames", min=16, max=3000)
    prog = torch.onnx.export(net, (x,), dynamo=True, input_names=["feats"], output_names=["logp"],
                             dynamic_shapes={"feats": {2: t}})
    prog.save(str(fp32), external_data=False)


def quantise(fp32, int8):
    """Dynamic int8, per-channel, MatMul weights only. Quantising every op (the default) changed 10/35 fixture
    choices; keeping the convolutions, the subsampling projection and the CTC head in fp32 changed 1/35."""
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic
    m = onnx.load(str(fp32), load_external_data=False)
    shapes = {i.name: tuple(i.dims) for i in m.graph.initializer}
    keep = [n.name for n in m.graph.node if n.op_type == "MatMul"
            and any(d in (ic.D_MODEL * 20, ic.VOCAB + 1) for x in n.input for d in shapes.get(x, ()))]
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8, per_channel=True,
                     op_types_to_quantize=["MatMul"], nodes_to_exclude=keep)


def session(path, threads=1):
    import onnxruntime as ort
    o = ort.SessionOptions()
    o.intra_op_num_threads = threads
    o.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), o, providers=["CPUExecutionProvider"])


PEAK = """
import resource, sys, numpy as np, onnxruntime as ort
base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.inter_op_num_threads = 1
s = ort.InferenceSession(sys.argv[1], o, providers=["CPUExecutionProvider"])
s.run(None, {"feats": np.random.randn(1, 80, int(sys.argv[2])).astype(np.float32)})
print(base, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
"""


def peak_mb(path, frames):
    """(peak RSS after load + one 2 s inference, RSS before loading) in MB, measured in a fresh process."""
    base, peak = map(int, subprocess.run([sys.executable, "-c", PEAK, str(path), str(frames)], capture_output=True,
                                         text=True, check=True).stdout.split())
    scale = 1 if sys.platform == "darwin" else 1024  # ru_maxrss: bytes on macOS, KiB on Linux
    return peak * scale / 2 ** 20, base * scale / 2 ** 20


def latency_ms(fn):
    fn()
    times = []
    for _ in range(RUNS):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1000)
    return sorted(times)[len(times) // 2]


def name(j):
    return j.choice if isinstance(j.choice, str) else j.choice.display


def main():
    import numpy as np
    import torch
    from evaluator import evaluate_choice
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="export zip or folder (synthetic fixture)")
    ap.add_argument("--weights", type=Path, default=ic.SLIM, help="mr_ctc.pt-format weights (default: base)")
    a = ap.parse_args()
    FP32, INT8 = OUT / f"{a.weights.stem}.onnx", OUT / f"{a.weights.stem}.int8.onnx"

    if not FP32.exists():
        export(a.weights, FP32)
    if not INT8.exists():
        quantise(FP32, INT8)

    feats, net, sp = ic.load(a.weights)
    torch.set_num_threads(1)
    wav = np.random.default_rng(0).uniform(-0.1, 0.1, int(16000 * CLIP_S)).astype(np.float32)
    x = feats(torch.from_numpy(wav))
    rows = [(f"torch fp32 ({a.weights.name})", a.weights, None, latency_ms(lambda: net(x)))]
    sessions = {}
    for label, path in (("ONNX fp32", FP32), ("ONNX int8 (MatMul weights, per channel)", INT8)):
        s = sessions[label] = session(path)
        rows.append((label, path, peak_mb(path, x.shape[2]), latency_ms(lambda: s.run(None, {"feats": x.numpy()}))))
    feat_ms = latency_ms(lambda: feats(torch.from_numpy(wav)))

    print(f"## On-device estimate (this Mac, 1 CPU thread, {CLIP_S:.0f} s clip = {x.shape[2]} feature frames)\n")
    print("| Model | File size | Peak RAM (process, after load + 1 run) | Latency p50 |")
    print("|---|---|---|---|")
    for label, path, mem, lat in rows:
        size = f"{path.stat().st_size / 2 ** 20:.0f} MB"
        m = f"{mem[0]:.0f} MB (python + onnxruntime alone {mem[1]:.0f} MB)" if mem else "n/a"
        print(f"| {label} | {size} | {m} | {lat:.0f} ms |")
    print(f"\nFeature extraction (torch, 1 thread): {feat_ms:.1f} ms per {CLIP_S:.0f} s clip.\n")

    # Choices on the fixture: torch vs ONNX fp32 vs ONNX int8
    with tempfile.TemporaryDirectory() as tmp:
        folder = open_export(a.source, Path(tmp) / "export")
        clips = load_manifest(folder)["clips"]
        lessons = lessons_for(clips)
        cache = Path(tmp) / "audio"
        cache.mkdir()
        agree = {k: 0 for k in sessions}
        drift = {k: 0.0 for k in sessions}  # largest change of any candidate's log-likelihood vs torch
        diffs = []
        for c in clips:
            w = ic.load_wav(converted(folder / c["file"], "wav16k", cache))
            f = feats(torch.from_numpy(w))
            cands = lessons[c["template_id"]].candidates()
            ref = ic.decide(net(f), w, cands, sp)
            for label, s in sessions.items():
                j = ic.decide(torch.from_numpy(s.run(None, {"feats": f.numpy()})[0]), w, cands, sp)
                same = name(j) == name(ref) and evaluate_choice(c, name(j)) == evaluate_choice(c, name(ref))
                agree[label] += same
                if not same:
                    diffs.append(f"{c['id']} {label}: {name(ref)} -> {name(j)}")
                if ref.scores and j.scores:
                    drift[label] = max(drift[label], max(abs(j.scores[k] - v) for k, v in ref.scores.items()))
    print("| Model | Same choice as torch on the fixture | Largest score change (nats) |\n|---|---|---|")
    for label, k in agree.items():
        print(f"| {label} | {k}/{len(clips)} | {drift[label]:.2f} |")
    if diffs:
        print("\n" + "\n".join(diffs))


if __name__ == "__main__":
    import torch
    with torch.no_grad():
        main()
