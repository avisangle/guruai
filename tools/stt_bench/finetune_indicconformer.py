"""Fine-tune the IndicConformer Marathi CTC path (providers/indicconformer.py) on ReadNet children's speech.

Input: the training set from readnet_trainset.py (~/.cache/readnet/train/{train,val}.jsonl + audio/).
Output: the best checkpoint by validation CER, in the same format as mr_ctc.pt (features buffers + encoder +
CTC head), to ~/.cache/indicconformer/finetuned/mr_ctc_readnet.pt. mr_ctc.pt is never written.

Recipe (small adult -> child domain shift):
- the rebuild has no padding masks, so each clip is its own forward pass (batch 1); gradients are accumulated
  over --accum clips per optimiser step
- frozen: the subsampling (pre_encode) and the lowest --freeze Conformer layers; BatchNorm stays in eval mode
  (running statistics from the adult checkpoint, unchanged); the rest and the CTC head train
- AdamW, linear warmup then cosine decay to 5% of --lr; gradient-norm clip 1.0
- SpecAugment on the log-mel features: 2 frequency masks up to 15 mels, time masks up to 5% of frames each,
  one per 2 s of audio
- CTC loss on the Marathi tokens (blank = 256), computed on CPU (no MPS kernel); encoder on MPS
- validation loss and greedy CER every --eval-every steps and at each epoch end; early stopping after
  --patience evaluations without a better CER

Usage (venv active):
  python tools/stt_bench/finetune_indicconformer.py --smoke            # 200 steps' timing, no checkpoint
  python tools/stt_bench/finetune_indicconformer.py --epochs 3
"""
import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from providers import indicconformer as ic  # noqa: E402

DATA = Path.home() / ".cache" / "readnet" / "train"
OUT = ic.FINETUNED


def load_split(path, max_s):
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    return [r for r in rows if 0.2 <= r["dur"] <= max_s]


def read_audio(root, row):
    import soundfile as sf
    import torch
    x, sr = sf.read(root / row["audio"], dtype="float32")
    assert sr == 16000 and x.ndim == 1
    return torch.from_numpy(x)


def spec_augment(f, rng):
    """f: (1, 80, T) normalised log-mels; masked to 0 (the per-feature mean)."""
    f = f.clone()
    t = f.shape[2]
    for _ in range(2):
        w = rng.randint(0, 15)
        s = rng.randint(0, 80 - w)
        f[:, s:s + w, :] = 0
    for _ in range(max(1, t // 200)):  # one per 2 s (100 feature frames per s)
        w = rng.randint(0, max(1, int(0.05 * t)))
        s = rng.randint(0, max(0, t - w))
        f[:, :, s:s + w] = 0
    return f


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[-1]


def ctc_loss(logp, target):
    """Per-token CTC loss of one clip; logp (T, 257) on any device, loss on CPU."""
    import torch
    import torch.nn.functional as F
    lp = logp.cpu().unsqueeze(1)
    return F.ctc_loss(lp, torch.tensor([target]), torch.tensor([lp.shape[0]]), torch.tensor([len(target)]),
                      blank=ic.BLANK, reduction="mean", zero_infinity=True)


def evaluate(net, feats, sp, rows, root, dev):
    """(mean per-token CTC loss, greedy CER over characters without spaces)."""
    import torch
    net.eval()
    loss, errs, chars = 0.0, 0, 0
    with torch.no_grad():
        for r in rows:
            logp = net(feats(read_audio(root, r)).to(dev))
            loss += ctc_loss(logp, sp.encode(r["text"])).item()
            hyp = ic.greedy(logp.cpu(), sp)[1].replace(" ", "")
            ref = r["text"].replace(" ", "")
            errs += edit_distance(hyp, ref)
            chars += len(ref)
    train_mode(net)
    return loss / len(rows), errs / chars


def train_mode(net):
    net.train()
    for m in net.modules():
        if isinstance(m, __import__("torch").nn.BatchNorm1d):
            m.eval()


def save(net, feats, path):
    import torch
    sd = {"fb": feats.fb, "window": feats.window, **{k: v.detach().cpu() for k, v in net.state_dict().items()}}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    torch.save(sd, tmp)
    tmp.rename(path)


def main():
    import torch
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=DATA)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=5e-5, help="peak learning rate")
    ap.add_argument("--warmup", type=int, default=150, help="optimiser steps")
    ap.add_argument("--accum", type=int, default=16, help="clips per optimiser step")
    ap.add_argument("--freeze", type=int, default=6, help="lowest Conformer layers kept frozen (of 17)")
    ap.add_argument("--max-seconds", type=float, default=20.0, help="skip longer clips")
    ap.add_argument("--eval-every", type=int, default=300, help="optimiser steps between validations")
    ap.add_argument("--patience", type=int, default=3, help="validations without a better CER before stopping")
    ap.add_argument("--max-hours", type=float, default=3.0, help="stop training after this wall-clock time")
    ap.add_argument("--smoke", action="store_true", help="time 200 clips forward+backward and 50 val clips, exit")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    if a.out.resolve() == ic.SLIM.resolve():
        sys.exit("refusing to overwrite mr_ctc.pt")

    rng = random.Random(a.seed)
    torch.manual_seed(a.seed)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    feats, net, sp = ic.load(ic.SLIM)  # cached, eval-mode base model; trained in place
    net.to(dev)
    for p in net.pre_encode.parameters():
        p.requires_grad = False
    for layer in net.layers[: a.freeze]:
        for p in layer.parameters():
            p.requires_grad = False
    params = [p for p in net.parameters() if p.requires_grad]
    print(f"torch {torch.__version__} on {dev}; trainable {sum(p.numel() for p in params) / 1e6:.1f}M of "
          f"{sum(p.numel() for p in net.parameters()) / 1e6:.1f}M")
    train_mode(net)

    train = load_split(a.data / "train.jsonl", a.max_seconds)
    val = load_split(a.data / "val.jsonl", a.max_seconds)
    print(f"train {len(train)} clips {sum(r['dur'] for r in train) / 3600:.2f} h; val {len(val)} clips")
    if a.smoke:
        train, val = train[:200], val[:50]

    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=1e-3)
    total = a.epochs * math.ceil(len(train) / a.accum)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / a.warmup) * (
        0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / max(1, total))))))

    t0 = time.time()
    if not a.smoke:
        vl, cer = evaluate(net, feats, sp, val, a.data, dev)
        print(f"base: val loss {vl:.3f} CER {cer:.3f} ({time.time() - t0:.0f} s)", flush=True)
        best, bad = (cer, vl), 0
    step, seen, run_loss, stop = 0, 0, 0.0, False
    t_train = time.time()
    for epoch in range(a.epochs):
        rng.shuffle(train)
        for i, r in enumerate(train):
            f = spec_augment(feats(read_audio(a.data, r)), rng).to(dev)
            loss = ctc_loss(net(f), sp.encode(r["text"]))
            (loss / a.accum).backward()
            run_loss += loss.item()
            seen += 1
            if seen % a.accum and i != len(train) - 1:
                continue
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 25 == 0:
                el = time.time() - t_train
                print(f"epoch {epoch + 1} step {step}/{total} train loss {run_loss / seen:.3f} "
                      f"lr {sched.get_last_lr()[0]:.2e} {seen / el:.1f} clips/s", flush=True)
                run_loss, seen, t_train = 0.0, 0, time.time()
            end = i == len(train) - 1
            if a.smoke or not (step % a.eval_every == 0 or end):
                continue
            vl, cer = evaluate(net, feats, sp, val, a.data, dev)
            note = ""
            if (cer, vl) < best:
                best, bad, note = (cer, vl), 0, " best, saved"
                save(net, feats, a.out)
            else:
                bad += 1
            print(f"epoch {epoch + 1} step {step}: val loss {vl:.3f} CER {cer:.3f}{note} "
                  f"({(time.time() - t0) / 60:.0f} min)", flush=True)
            t_train = time.time()
            if bad >= a.patience or time.time() - t0 > a.max_hours * 3600:
                stop = True
                break
        if stop or a.smoke:
            break
    if a.smoke:
        el = time.time() - t0
        t1 = time.time()
        vl, cer = evaluate(net, feats, sp, val, a.data, dev)
        ev = time.time() - t1
        dur = sum(r["dur"] for r in train)
        print(f"smoke: {len(train)} clips ({dur:.0f} s audio) in {el:.0f} s train; {len(val)} val clips in "
              f"{ev:.0f} s (loss {vl:.3f} CER {cer:.3f})")
        return
    print(f"done in {(time.time() - t0) / 60:.0f} min; best val CER {best[0]:.3f} loss {best[1]:.3f} -> {a.out}")


if __name__ == "__main__":
    main()
