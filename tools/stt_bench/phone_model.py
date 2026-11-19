"""Phone model for indicconformer_closed: one ONNX graph from 16 kHz waveform to Marathi CTC log-probs.

The NeMo mel features (providers/indicconformer.py Features) are rebuilt without torch.stft so they export
cleanly: preemphasis, zero padding of n_fft/2 each side (stft center=True), then one strided Conv1d whose
514 kernels are the 400-sample hann window (zero-padded to 512, centred, as torch.stft does) times the DFT
cosines and sines, then power, the checkpoint's 80-mel filterbank, log and per-feature normalisation.
Quantised like indicconformer_onnx.py (int8 MatMul weights; subsampling projection, CTC head and the
filterbank stay fp32).

Usage (project root, venv active):
  python tools/stt_bench/phone_model.py [export ...] [--phone results-ic.json]
    export ...: zips/folders to compare choices on (torch model vs this ONNX model)
    --phone: also compare with the phone's own run (android_probe.py pull): same choice and scores expected
Writes ~/.cache/indicconformer/onnx/mr_ctc_wav.int8.onnx (pushed to the phone by android_probe.py push-model).
"""
import argparse
import math
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from bench import converted, lessons_for, load_manifest, open_export  # noqa: E402
from indicconformer_onnx import OUT, name, session  # noqa: E402
from providers import indicconformer as ic  # noqa: E402

FP32, INT8 = OUT / "mr_ctc_wav.onnx", OUT / "mr_ctc_wav.int8.onnx"
N_FFT, HOP, WIN = 512, 160, 400


def wav_model():
    import torch
    from torch import nn

    feats, net, sp = ic.load(ic.SLIM)

    class WavFeatures(nn.Module):
        def __init__(self):
            super().__init__()
            win = torch.zeros(N_FFT)
            off = (N_FFT - WIN) // 2
            win[off:off + WIN] = feats.window
            n = torch.arange(N_FFT, dtype=torch.float64)
            k = torch.arange(N_FFT // 2 + 1, dtype=torch.float64).unsqueeze(1)
            ang = 2 * math.pi * k * n / N_FFT
            kern = torch.cat([torch.cos(ang), -torch.sin(ang)]) * win.double()
            self.register_buffer("kern", kern.float().unsqueeze(1))  # (514, 1, 512)
            self.register_buffer("fb", feats.fb.clone())

        def forward(self, wav):  # (1, N) -> (1, 80, 1 + N // 160)
            x = torch.cat([wav[:, :1], wav[:, 1:] - 0.97 * wav[:, :-1]], 1)
            x = nn.functional.pad(x, (N_FFT // 2, N_FFT // 2)).unsqueeze(1)
            s = nn.functional.conv1d(x, self.kern, stride=HOP)  # (1, 514, T)
            re, im = s[:, : N_FFT // 2 + 1], s[:, N_FFT // 2 + 1:]
            m = torch.log(self.fb @ (re * re + im * im) + 2 ** -24)
            return (m - m.mean(2, keepdim=True)) / (m.std(2, keepdim=True) + 1e-5)

    class WavCTC(nn.Module):
        def __init__(self):
            super().__init__()
            self.features, self.net = WavFeatures(), net

        def forward(self, wav):
            return self.net(self.features(wav))

    return WavCTC().eval(), feats, net, sp


def export(model):
    import torch
    OUT.mkdir(parents=True, exist_ok=True)
    n = torch.export.Dim("samples", min=1600, max=480000)  # 0.1 s .. 30 s
    prog = torch.onnx.export(model, (torch.zeros(1, 32000).uniform_(-0.1, 0.1),), dynamo=True,
                             input_names=["wav"], output_names=["logp"], dynamic_shapes={"wav": {1: n}})
    prog.save(str(FP32), external_data=False)


def quantise():
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic
    m = onnx.load(str(FP32), load_external_data=False)
    shapes = {i.name: tuple(i.dims) for i in m.graph.initializer}
    keep = [n.name for n in m.graph.node if n.op_type == "MatMul"
            and any(d in (ic.D_MODEL * 20, ic.VOCAB + 1) for x in n.input for d in shapes.get(x, ()))]
    quantize_dynamic(str(FP32), str(INT8), weight_type=QuantType.QInt8, per_channel=True,
                     op_types_to_quantize=["MatMul"], nodes_to_exclude=keep)


def main():
    import numpy as np
    import torch
    from evaluator import evaluate_choice
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", type=Path, nargs="*")
    ap.add_argument("--phone", type=Path, help="pulled results-ic file to compare with")
    a = ap.parse_args()
    import json
    phone = json.loads(a.phone.read_text())["clips"] if a.phone else {}
    p_n, p_same, p_drift, p_diffs = 0, 0, 0.0, []
    model, feats, net, sp = wav_model()
    if not FP32.exists():
        export(model)
    if not INT8.exists():
        quantise()
    print(f"{INT8} {INT8.stat().st_size / 2 ** 20:.0f} MB")
    s = session(INT8)

    worst_feat, n, agree, diffs = 0.0, 0, 0, []
    with tempfile.TemporaryDirectory() as tmp:
        for i, src in enumerate(a.exports):
            folder = open_export(src, Path(tmp) / f"e{i}")
            clips = load_manifest(folder)["clips"]
            lessons = lessons_for(clips)
            cache = Path(tmp) / f"a{i}"
            cache.mkdir()
            for c in clips:
                w = ic.load_wav(converted(folder / c["file"], "wav16k", cache))
                t = torch.from_numpy(w)
                ref_f = feats(t)
                worst_feat = max(worst_feat, float((model.features(t.unsqueeze(0)) - ref_f).abs().max()))
                cands = lessons[c["template_id"]].candidates()
                ref = ic.decide(net(ref_f), w, cands, sp)
                j = ic.decide(torch.from_numpy(s.run(None, {"wav": w[None, :]})[0]), w, cands, sp)
                same = name(j) == name(ref) and evaluate_choice(c, name(j)) == evaluate_choice(c, name(ref))
                n += 1
                agree += same
                pr = phone.get(c["id"])
                if pr and not pr.get("error"):
                    p_n += 1
                    p_same += pr["choice"] == name(j)
                    if pr["choice"] != name(j):
                        p_diffs.append(f"{c['id']}: mac {name(j)} -> phone {pr['choice']} ({j.note})")
                    if j.scores and pr["scores"]:
                        for k, v in j.scores.items():  # JSON null: -Infinity (answer longer than the clip allows)
                            ph = pr["scores"][k]
                            if ph is None or math.isinf(v):
                                p_drift = p_drift if (ph is None) == math.isinf(v) else math.inf
                            else:
                                p_drift = max(p_drift, abs(ph - v))
                if not same:
                    diffs.append(f"{c['id']}: torch {name(ref)} -> phone model {name(j)}")
    if n:
        print(f"features: largest difference from torch.stft features {worst_feat:.4f} (normalised units)")
        print(f"same choice as the torch model: {agree}/{n}")
        print("\n".join(diffs))
    if phone:
        print(f"phone vs mac (same ONNX model): same choice {p_same}/{p_n}, largest score difference {p_drift:.3f} nats")
        print("\n".join(p_diffs))


if __name__ == "__main__":
    import torch
    with torch.no_grad():
        main()
