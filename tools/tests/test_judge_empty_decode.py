"""GURU-42 rule A: in providers/indicconformer.py, decide() returns NOTHING once the model has run and the
greedy decode has no tokens, whatever the best candidate's margin (D-GURU-42-noise-is-not-an-answer).

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/tests/test_judge_empty_decode.py

Synthetic only: no audio file, no model. The log-probs are the seeded matrices of the matching tests in
app/src/asr/judge.test.ts; the tokenizer is a stand-in built from golden.json's pieces and token ids, so the
checkpoint's tokenizer is not needed.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "stt_bench"))
import evaluator  # noqa: E402
from providers import indicconformer as ic  # noqa: E402
from providers.base import Candidate  # noqa: E402

GOLDEN = json.loads((ROOT / "app" / "src" / "asr" / "__fixtures__" / "golden.json").read_text())
ID_A = 11  # "▁अ", the whole answer "अ"


class Sp:
    """sentencepiece stand-in: golden.json's ids for every text the judge scores, and its pieces."""
    pieces = GOLDEN["pieces"]
    tokens = GOLDEN["tokens"]

    def encode(self, text):
        return list(self.tokens[text])

    def id_to_piece(self, k):
        return self.pieces[k]

    def decode(self, ids):
        return "".join(" ⁇ " if self.pieces[k] == "<unk>" else self.pieces[k] for k in ids).removeprefix("▁").replace("▁", " ")


def matrix(frames, row):
    """frames x 257 log-probs: the given ids at the given probabilities, the rest sharing what is left."""
    x = np.zeros((frames, ic.VOCAB + 1))
    for t in range(frames):
        p = row(t)
        x[t, :] = math.log((1 - sum(p.values())) / (ic.VOCAB + 1 - len(p)))
        for k, v in p.items():
            x[t, k] = math.log(v)
    return torch.from_numpy(x).float()


def noise():
    """Blank wins every frame (empty decode), but "अ" is close behind on all 30 frames."""
    return matrix(30, lambda t: {ic.BLANK: 0.6, ID_A: 0.35})


LOUD = (0.3 * np.sin(2 * np.pi * 220 * np.arange(16000) / 16000)).astype(np.float32)
CANDS = [Candidate(c["item_id"], c["display"], c["text"]) for c in GOLDEN["candidates"]]


@pytest.fixture(autouse=True)
def swaps_on(monkeypatch):
    monkeypatch.setattr(ic, "CHILD_SWAPS", True)  # as the app and phone_golden.py


def best_margin(lp, sp):
    """As decide() computes it: the best-scoring candidate's margin per token, said once or repeated."""
    texts = [c.text for c in ic.child_swaps(CANDS)]
    free_ids, _ = ic.greedy(lp, sp)
    *lls, free_ll = ic.ctc_ll(lp, [sp.encode(t) for t in texts] + [free_ids])
    ids = sp.encode(texts[max(range(len(texts)), key=lambda i: lls[i])])
    reps = [ids * k for k in range(1, ic.REPEATS + 1)]
    return min((free_ll - ll) / max(1, len(r)) for r, ll in zip(reps, ic.ctc_ll(lp, reps)))


def test_empty_free_decode_on_a_sounding_clip_is_nothing_even_under_the_margin():
    sp, lp = Sp(), noise()
    # Preconditions: the model runs (not a quiet clip), decodes nothing, and the closest answer is under the margin.
    assert float((ic.frame_db(LOUD) > ic.SPEECH_DBFS).sum()) * 0.01 >= ic.MIN_SPEECH_S
    assert ic.greedy(lp, sp)[0] == []
    assert best_margin(lp, sp) <= ic.OTHER_MARGIN_PER_TOKEN
    j = ic.decide(lp, LOUD, CANDS, sp, length_feature=False)
    assert j.choice == evaluator.NOTHING
    assert j.transcript == ""


def test_non_empty_free_decode_under_the_margin_still_takes_the_closest_answer():
    sp = Sp()
    m = GOLDEN["pieces"].index("▁म")  # outside the golden lesson
    lp = matrix(30, lambda t: {m: 0.5, ID_A: 0.45, ic.BLANK: 0.04} if t == 15 else {ic.BLANK: 0.6, ID_A: 0.35})
    assert ic.greedy(lp, sp)[0] == [m]
    assert best_margin(lp, sp) <= ic.OTHER_MARGIN_PER_TOKEN
    j = ic.decide(lp, LOUD, CANDS, sp, length_feature=False)
    assert j.transcript == "म"
    assert isinstance(j.choice, Candidate) and (j.choice.display, j.choice.text) == ("अ", "अ")
