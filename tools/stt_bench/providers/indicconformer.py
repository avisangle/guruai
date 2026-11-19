"""AI4Bharat IndicConformer, Marathi (MIT): open greedy CTC transcript and closed-set CTC scoring, local CPU.

Checkpoint: indicconformer_stt_mr_hybrid_rnnt_large.nemo (17-layer Conformer, d_model 512, ~120M, hybrid
RNNT + CTC), linked from github.com/AI4Bharat/IndicConformerASR; the same model is the gated Hugging Face repo
ai4bharat/indicconformer_stt_mr_hybrid_ctc_rnnt_large. NeMo is not needed: this file rebuilds the CTC path
(NeMo's mel features, the Conformer encoder, the CTC head) in plain torch and loads the checkpoint's weights
with a strict state-dict match. The RNNT decoder is not used.

The checkpoint's tokenizer is AI4Bharat's 22-language aggregate (256 BPE tokens each) with a "multisoftmax"
CTC head: for Marathi only Marathi's 256 outputs plus blank are kept, then log-softmaxed (as their fork does).
"""
import io
import math
import os
import tarfile
import wave
from functools import cache
from pathlib import Path

from .base import Candidate, ClosedScorer, Judgement, Output, Provider

NEMO = Path(os.environ.get("INDICCONFORMER_NEMO", Path.home() / ".cache" / "indicconformer" /
                           "indicconformer_stt_mr_hybrid_rnnt_large.nemo"))
URL = "https://objectstore.e2enetworks.net/indicconformer/models/indicconformer_stt_mr_hybrid_rnnt_large.nemo"
SLIM = NEMO.with_name("mr_ctc.pt")           # CTC-path weights only, written on first use
TOKENIZER = NEMO.with_name("mr_tokenizer.model")
# ReadNet fine-tune (finetune_indicconformer.py), same format as mr_ctc.pt
FINETUNED = Path(os.environ.get("INDICCONFORMER_FT", NEMO.parent / "finetuned" / "mr_ctc_readnet.pt"))
LANGS = ["as", "bn", "brx", "doi", "kok", "gu", "hi", "kn", "ks", "mai", "ml", "mr", "mni", "ne", "or", "pa",
         "sa", "sat", "sd", "ta", "te", "ur"]  # aggregate tokenizer order (model_config.yaml)
VOCAB = 256                                  # tokens per language
OFFSET = LANGS.index("mr") * VOCAB           # Marathi's first id in the 5632-token aggregate
BLANK = VOCAB                                # blank index after keeping Marathi + blank
D_MODEL, N_LAYERS, N_HEADS, KERNEL = 512, 17, 8, 31
FRAME_S = 0.04                               # encoder frame: 10 ms features, 4x subsampling

# --- closed-set decision constants (uncalibrated: adult synthetic speech only; set a priori, tune on real clips)
SPEECH_DBFS = -40.0   # a 25 ms frame louder than this (RMS, dB full scale) counts as sound
MIN_SPEECH_S = 0.08   # less sound than this in the clip -> "nothing" without running the model
# "other" when the free greedy decode beats the best candidate by more than this many nats per token of
# that candidate (CTC log-likelihood ratio; per token so longer answers get proportionally more slack).
# 3.0 from the first sessions with a real child (docs/decisions/D-STT-other-margin.md)
OTHER_MARGIN_PER_TOKEN = float(os.environ.get("STT_BENCH_IC_MARGIN", "3.0"))
# Experiment (opt-in, STT_BENCH_IC_CHILD_SWAPS=1): also score each answer with a 4-year-old's sound swaps,
# word-final चा -> सा and र -> ल ("उंदराचा" said "उनलासा"), as more answers of the same item.
CHILD_SWAPS = os.environ.get("STT_BENCH_IC_CHILD_SWAPS", "0") == "1"
# An answer said up to this many times in a row ("डी फॉर डॉग डी फॉर डॉग") counts as said once.
REPEATS = int(os.environ.get("STT_BENCH_IC_REPEATS", "3"))
# The free decode scores below this per token: the model is unsure what it heard (faint audio), so a wrong
# verdict becomes unclear (D-STT-unsure-not-wrong). STT_BENCH_IC_UNSURE=-inf turns it off.
UNSURE_PER_TOKEN = float(os.environ.get("STT_BENCH_IC_UNSURE", "-10"))
# "<letter> for <any word>" ("ए फॉर एरोप्लेन"): the letter decides, the word is ignored (D-STT-letter-for-any-word).
ANY_WORD = os.environ.get("STT_BENCH_IC_ANY_WORD", "1") == "1"
FOR_WORDS = {"फॉर", "फोर", "फर"}  # how the model writes "for"
# Vowel length for bare इ/ई, उ/ऊ: when CTC barely separates the pair, decide by sounding duration.
# Opt-in (STT_BENCH_IC_LENGTH=1): on the synthetic fixture it changed no choice, and the adult voice's
# durations did not separate the pairs, so the threshold needs real children's clips first.
LENGTH_FEATURE = os.environ.get("STT_BENCH_IC_LENGTH", "0") == "1"
LENGTH_TIE = 2.0      # nats: below this pair margin CTC is treated as undecided
LENGTH_REL_DB = 25.0  # duration counts frames within this many dB of the clip's loudest frame
LONG_VOWEL_S = 0.40   # sounding at least this long -> the long vowel (ई, ऊ); shorter -> short (इ, उ)
LENGTH_PAIRS = {"इ": "ई", "ई": "इ", "उ": "ऊ", "ऊ": "उ"}
LONG = {"ई", "ऊ"}


# --- model ------------------------------------------------------------------
def _nn():
    import torch
    from torch import nn
    import torch.nn.functional as F

    class Features(nn.Module):
        """NeMo AudioToMelSpectrogramPreprocessor at inference: preemphasis 0.97, 512-point STFT (25 ms hann,
        10 ms hop), power, 80 slaney mels (the checkpoint's own filterbank), log(x + 2^-24), per-feature norm."""

        def __init__(self):
            super().__init__()
            self.register_buffer("fb", torch.zeros(80, 257))
            self.register_buffer("window", torch.zeros(400))

        def forward(self, wav):  # (N,) float in [-1, 1] -> (1, 80, T)
            x = torch.cat([wav[:1], wav[1:] - 0.97 * wav[:-1]])
            s = torch.stft(x, 512, 160, 400, window=self.window, center=True, pad_mode="constant", return_complex=True)
            m = torch.log(self.fb @ (s.real ** 2 + s.imag ** 2) + 2 ** -24)
            return ((m - m.mean(1, keepdim=True)) / (m.std(1, keepdim=True) + 1e-5)).unsqueeze(0)

    def rel_shift(x):  # Transformer-XL relative shift, as NeMo RelPositionMultiHeadAttention
        b, h, q, p = x.shape
        x = F.pad(x, (1, 0)).view(b, h, -1, q)
        return x[:, :, 1:].reshape(b, h, q, p)

    class Attention(nn.Module):
        def __init__(self):
            super().__init__()
            self.dk = D_MODEL // N_HEADS
            self.linear_q, self.linear_k, self.linear_v, self.linear_out = (nn.Linear(D_MODEL, D_MODEL) for _ in range(4))
            self.linear_pos = nn.Linear(D_MODEL, D_MODEL, bias=False)
            self.pos_bias_u = nn.Parameter(torch.zeros(N_HEADS, self.dk))
            self.pos_bias_v = nn.Parameter(torch.zeros(N_HEADS, self.dk))

        def forward(self, x, pos):
            b, t, _ = x.shape
            q = self.linear_q(x).view(b, t, N_HEADS, self.dk)
            k = self.linear_k(x).view(b, t, N_HEADS, self.dk).transpose(1, 2)
            v = self.linear_v(x).view(b, t, N_HEADS, self.dk).transpose(1, 2)
            p = self.linear_pos(pos).view(1, -1, N_HEADS, self.dk).transpose(1, 2)
            ac = (q + self.pos_bias_u).transpose(1, 2) @ k.transpose(-2, -1)
            bd = rel_shift((q + self.pos_bias_v).transpose(1, 2) @ p.transpose(-2, -1))[..., :t]
            a = ((ac + bd) / math.sqrt(self.dk)).softmax(-1)
            return self.linear_out((a @ v).transpose(1, 2).reshape(b, t, D_MODEL))

    class FeedForward(nn.Module):
        def __init__(self):
            super().__init__()
            self.linear1, self.linear2 = nn.Linear(D_MODEL, 4 * D_MODEL), nn.Linear(4 * D_MODEL, D_MODEL)

        def forward(self, x):
            return self.linear2(F.silu(self.linear1(x)))

    class Conv(nn.Module):  # pointwise convs held as Linear (same maths; lets int8 quantisation cover them)
        def __init__(self):
            super().__init__()
            self.pointwise_conv1 = nn.Linear(D_MODEL, 2 * D_MODEL)
            self.depthwise_conv = nn.Conv1d(D_MODEL, D_MODEL, KERNEL, padding=KERNEL // 2, groups=D_MODEL)
            self.batch_norm = nn.BatchNorm1d(D_MODEL)
            self.pointwise_conv2 = nn.Linear(D_MODEL, D_MODEL)

        def forward(self, x):
            x = F.glu(self.pointwise_conv1(x), dim=-1).transpose(1, 2)
            x = F.silu(self.batch_norm(self.depthwise_conv(x))).transpose(1, 2)
            return self.pointwise_conv2(x)

    class Layer(nn.Module):  # macaron Conformer block
        def __init__(self):
            super().__init__()
            for n in ("norm_feed_forward1", "norm_self_att", "norm_conv", "norm_feed_forward2", "norm_out"):
                setattr(self, n, nn.LayerNorm(D_MODEL))
            self.feed_forward1, self.feed_forward2 = FeedForward(), FeedForward()
            self.self_attn, self.conv = Attention(), Conv()

        def forward(self, x, pos):
            x = x + 0.5 * self.feed_forward1(self.norm_feed_forward1(x))
            x = x + self.self_attn(self.norm_self_att(x), pos)
            x = x + self.conv(self.norm_conv(x))
            x = x + 0.5 * self.feed_forward2(self.norm_feed_forward2(x))
            return self.norm_out(x)

    class PreEncode(nn.Module):  # "striding" subsampling, factor 4
        def __init__(self):
            super().__init__()
            self.conv = nn.Sequential(nn.Conv2d(1, D_MODEL, 3, 2, 1), nn.ReLU(), nn.Conv2d(D_MODEL, D_MODEL, 3, 2, 1), nn.ReLU())
            self.out = nn.Linear(D_MODEL * 20, D_MODEL)  # 80 mels -> 40 -> 20

        def forward(self, feats):  # (1, 80, T) -> (1, ceil(T/4), D)
            x = self.conv(feats.transpose(1, 2).unsqueeze(1))
            return self.out(x.transpose(1, 2).reshape(1, x.shape[2], -1))

    class CTCModel(nn.Module):
        """mel features (1, 80, T) -> Marathi CTC log-probs (T', 257); blank is the last column."""

        def __init__(self):
            super().__init__()
            self.pre_encode = PreEncode()
            self.layers = nn.ModuleList(Layer() for _ in range(N_LAYERS))
            self.ctc = nn.Linear(D_MODEL, VOCAB + 1)

        def forward(self, feats):
            x = self.pre_encode(feats) * math.sqrt(D_MODEL)  # xscaling
            t = x.shape[1]
            pos = torch.arange(t - 1, -t, -1, dtype=x.dtype, device=x.device).unsqueeze(1)  # relative positions t-1 .. -(t-1)
            div = torch.exp(torch.arange(0, D_MODEL, 2, dtype=x.dtype, device=x.device) * -(math.log(10000.0) / D_MODEL))
            pe = torch.stack([torch.sin(pos * div), torch.cos(pos * div)], -1).reshape(1, 2 * t - 1, D_MODEL)
            for layer in self.layers:
                x = layer(x, pe)
            return self.ctc(x)[0].log_softmax(-1)

    return Features, CTCModel


def _extract():
    """Write mr_ctc.pt (features, encoder and the Marathi rows of the CTC head) and the Marathi tokenizer."""
    import torch
    with tarfile.open(NEMO) as tar:
        names = {Path(m.name).name: m for m in tar.getmembers() if m.isfile()}
        cfg = tar.extractfile(names["model_config.yaml"]).read().decode()
        # the Marathi tokenizer: the model_path line under "    mr:" in the tokenizer section
        lines = cfg.split("\n")
        start = lines.index("    mr:")
        tok = next(l.split("nemo:")[1] for l in lines[start:start + 6] if l.strip().startswith("model_path"))
        TOKENIZER.write_bytes(tar.extractfile(names[tok]).read())
        sd = torch.load(io.BytesIO(tar.extractfile(names["model_weights.ckpt"]).read()), map_location="cpu",
                        weights_only=True)
    out = {"fb": sd["preprocessor.featurizer.fb"][0], "window": sd["preprocessor.featurizer.window"]}
    for k, v in sd.items():
        if k.startswith("encoder.") and ".pos_enc." not in k:
            k = k[len("encoder."):]
            out[k] = v.squeeze(-1) if "pointwise_conv" in k and k.endswith("weight") else v
    w, b = sd["ctc_decoder.decoder_layers.0.weight"].squeeze(-1), sd["ctc_decoder.decoder_layers.0.bias"]
    keep = list(range(OFFSET, OFFSET + VOCAB)) + [w.shape[0] - 1]  # Marathi tokens + blank (last)
    out["ctc.weight"], out["ctc.bias"] = w[keep].clone(), b[keep].clone()
    torch.save(out, SLIM)


def model():
    """(features, ctc model, sentencepiece tokenizer) of the base checkpoint, loaded once."""
    return load(SLIM)


@cache
def load(weights):
    """(features, ctc model, tokenizer) from a mr_ctc.pt-format file, loaded once per path."""
    import sentencepiece as spm
    import torch
    if not SLIM.exists() or not TOKENIZER.exists():
        _extract()
    Features, CTCModel = _nn()
    sd = torch.load(weights, map_location="cpu", weights_only=True)
    feats, net = Features(), CTCModel()
    feats.load_state_dict({k: sd.pop(k) for k in ("fb", "window")})
    net.load_state_dict(sd, strict=True)
    return feats.eval(), net.eval(), spm.SentencePieceProcessor(model_file=str(TOKENIZER))


def load_wav(path):
    import numpy as np
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono s16"
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def log_probs(wav, weights=SLIM):
    """16 kHz float waveform -> (T, 257) Marathi CTC log-probs (torch)."""
    import torch
    feats, net, _ = load(weights)
    with torch.no_grad():
        return net(feats(torch.from_numpy(wav)))


# --- decision ---------------------------------------------------------------
def frame_db(wav, win=400, hop=160):
    import numpy as np
    if len(wav) < win:
        wav = np.pad(wav, (0, win - len(wav)))
    n = 1 + (len(wav) - win) // hop
    frames = np.lib.stride_tricks.sliding_window_view(wav, win)[::hop][:n]
    return 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-12)


def greedy(logp, sp):
    ids, prev = [], None
    for k in logp.argmax(-1).tolist():
        if k != prev and k != BLANK:
            ids.append(k)
        prev = k
    return ids, sp.decode(ids)


def ctc_ll(logp, seqs):
    """Total CTC log-likelihood of each token sequence (all paths, all frames)."""
    import torch
    import torch.nn.functional as F
    n, t = len(seqs), logp.shape[0]
    flat = torch.tensor([k for s in seqs for k in s] or [0], dtype=torch.long)
    nll = F.ctc_loss(logp.unsqueeze(1).expand(t, n, -1), flat, torch.full((n,), t, dtype=torch.long),
                     torch.tensor([len(s) for s in seqs], dtype=torch.long), blank=BLANK, reduction="none")
    return (-nll).tolist()


def split_at_for(ids, piece):
    """Index of the first "for" word after the first word (a piece starting "▁" begins a word), or None."""
    starts = [i for i, k in enumerate(ids) if piece(k).startswith("▁")] + [len(ids)]
    for a, b in zip(starts, starts[1:]):
        if a > 0 and "".join(piece(k) for k in ids[a:b]).lstrip("▁") in FOR_WORDS:
            return a
    return None


def any_word(logp, free_ids, free_ll, candidates, tokens, piece):
    """Best letter name followed by the free decode's own "for <word>" tail, with its margin per token of the
    name (said once or repeated). None when the free decode has no "for" or the lesson no "<name> फॉर" answers."""
    k = split_at_for(free_ids, piece)
    names = [c for c in candidates if any(o.item_id == c.item_id and o.text.startswith(c.text + " फॉर ") for o in candidates)]
    if k is None or not names:
        return None
    tail = free_ids[k:]
    lls = ctc_ll(logp, [tokens[c.text] + tail for c in names])
    best = names[max(range(len(names)), key=lambda i: lls[i])]
    ids = tokens[best.text]
    reps = [ids * r + tail for r in range(1, REPEATS + 1)]
    return best, min((free_ll - ll) / max(1, len(ids) * r) for r, ll in zip(range(1, REPEATS + 1), ctc_ll(logp, reps)))


def child_swaps(candidates):
    """candidates plus their child-speech forms (CHILD_SWAPS), each text once, same item."""
    import re
    out = {c.text: c for c in candidates}
    for c in candidates:
        cha = re.sub(r"चा(?=\s|$)", "सा", c.text)
        for t in {cha, c.text.replace("र", "ल"), cha.replace("र", "ल")}:
            out.setdefault(t, Candidate(c.item_id, c.display, t))
    return list(out.values())


def decide(logp, wav, candidates, sp, length_feature=LENGTH_FEATURE):
    """Closed-set choice from CTC log-probs. Shared by the bench adapter and the ONNX check."""
    from evaluator import NOTHING, OTHER, normalise
    if CHILD_SWAPS:
        candidates = child_swaps(candidates)
    db = frame_db(wav)
    sounding = float((db > SPEECH_DBFS).sum()) * 0.01  # 10 ms hop
    if sounding < MIN_SPEECH_S:
        return Judgement(NOTHING, note=f"sound={sounding:.2f}s")
    tokens = {c.text: sp.encode(c.text) for c in candidates}
    free_ids, free = greedy(logp, sp)
    lls = ctc_ll(logp, list(tokens.values()) + [free_ids])
    scores, free_ll = dict(zip(tokens, lls[:-1])), lls[-1]
    best = max(candidates, key=lambda c: scores[c.text])
    # The closest answer, said once or repeated: whichever is nearest the free decode per token.
    ids = tokens[best.text]
    reps = [ids * k for k in range(1, REPEATS + 1)]
    margin = min((free_ll - ll) / max(1, len(r)) for r, ll in zip(reps, ctc_ll(logp, reps)))
    note = f"free={free!r} free_ll={free_ll:.2f} best={best.text!r} margin/token={margin:.2f}"
    j = Judgement(best, scores, free, note, unsure=free_ll / max(1, len(free_ids)) < UNSURE_PER_TOKEN)
    j.note += " unsure" if j.unsure else ""
    by_answer = {normalise(" ".join([c.text] * k)): c for k in range(1, REPEATS + 1) for c in candidates}
    if normalise(free) in by_answer:  # the free decode already is a lesson answer
        j.choice = by_answer[normalise(free)]
    elif margin > OTHER_MARGIN_PER_TOKEN:
        hit = any_word(logp, free_ids, free_ll, candidates, tokens, sp.id_to_piece) if ANY_WORD else None
        if not hit or hit[1] > OTHER_MARGIN_PER_TOKEN:
            j.choice = NOTHING if not free_ids else OTHER  # model heard no tokens at all: treat as no speech
            j.note += f" any_word={hit[0].text!r}:{hit[1]:.2f}" if hit else ""
            return j
        j.choice = hit[0]
        j.note += f" any_word={hit[0].text!r}:{hit[1]:.2f}"
    partner = LENGTH_PAIRS.get(j.choice.text)
    if partner in scores:
        dur = float((db > db.max() - LENGTH_REL_DB).sum()) * 0.01
        gap = scores[j.choice.text] - scores[partner]
        j.note += f" pair_gap={gap:.2f} dur={dur:.2f}s"
        if length_feature and abs(gap) < LENGTH_TIE:
            want_long = dur >= LONG_VOWEL_S
            pick = j.choice.text if (j.choice.text in LONG) == want_long else partner
            if pick != j.choice.text:
                j.note += f" length->{pick}"
                j.choice = next(c for c in candidates if c.text == pick)
    return j


# --- adapters ---------------------------------------------------------------
class _Base(Provider):
    external = False
    pricing = "indicconformer"

    def missing(self):
        if not NEMO.exists() and not SLIM.exists():
            return f"checkpoint not found at {NEMO}; download {URL} there (or set INDICCONFORMER_NEMO)"
        try:
            import sentencepiece  # noqa: F401
            import torch  # noqa: F401
        except ImportError:
            return "torch and sentencepiece needed in venv"
        return None

    weights = SLIM

    def prepare(self):
        load(self.weights)


class IndicConformer(_Base):
    """Open transcription: greedy CTC decode, no lesson context."""
    name = "indicconformer"

    def run(self, path, clip, lesson):
        logp = log_probs(load_wav(path))
        return Output(greedy(logp, model()[2])[1], note=f"frames={logp.shape[0]}")


class IndicConformerClosed(ClosedScorer, _Base):
    """Scores every lesson answer by CTC log-likelihood against the free greedy decode."""
    name = "indicconformer_closed"

    def judge(self, path, item, candidates):
        wav = load_wav(path)
        return decide(log_probs(wav, self.weights), wav, candidates, model()[2])


class IndicConformerClosedFT(IndicConformerClosed):
    """indicconformer_closed with the ReadNet fine-tuned weights (FINETUNED; INDICCONFORMER_FT overrides)."""
    name = "indicconformer_closed_ft"
    weights = FINETUNED

    def missing(self):
        return super().missing() or (None if FINETUNED.exists() else
                                     f"{FINETUNED} not found; run finetune_indicconformer.py")
