"""Reference data for the app's TypeScript port of the closed-set judge (app/src/asr/*.test.ts).

Writes app/src/asr/__fixtures__/golden.json: the Marathi tokenizer pieces, sentencepiece decodes,
evaluator.normalise outputs, and decide() results (providers/indicconformer.py, child sound swaps on)
on small seeded log-prob matrices, with the token ids of every text decide() scored. Run again after
changing either side (project root, venv active):
  python tools/stt_bench/phone_golden.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import evaluator  # noqa: E402
from providers import indicconformer as ic  # noqa: E402
from providers.base import Candidate  # noqa: E402

OUT = HERE.parents[1] / "app" / "src" / "asr" / "__fixtures__" / "golden.json"
T = 30
TEXTS = ["अ", "आ", "इ", "ई", "अ अननसाचा", "आ आगगाडीचा", "क", "ख", "अ फॉर अननस"]
NORMALISE = ["अ।", " आ  आ ", "क़", "उन्दीर", "हँस", "[laughter] अ", "AA", "ee", "अ‍ब", "अ, आ!"]


def main():
    import numpy as np
    import torch
    _, _, sp = ic.load(ic.SLIM)
    ic.CHILD_SWAPS = True  # the app always swaps, whatever STT_BENCH_IC_CHILD_SWAPS says
    rng = np.random.default_rng(7)
    cands = [Candidate(t.split()[0], t.split()[0], t) for t in TEXTS]  # item = the letter
    ids = {t: sp.encode(t) for t in TEXTS}

    def logp_for(path_ids=None, noise=None, boost=12):
        """Seeded log-probs; with path_ids, frames favour those tokens (blank between) so the decode is known."""
        x = rng.normal(0, noise or (3.0 if path_ids is None else 1.0), (T, ic.VOCAB + 1))
        if path_ids is not None:
            seq = [ic.BLANK]
            for k in path_ids:
                seq += [k, ic.BLANK]
            for f in range(T):
                x[f, seq[min(len(seq) - 1, f * len(seq) // T)]] += boost
        x = torch.from_numpy(np.round(x, 3)).float().log_softmax(-1)
        return torch.from_numpy(np.round(x.numpy(), 4)).float()  # what the test reads back

    def wav(level):
        t = np.arange(16000) / 16000
        return (level * np.sin(2 * np.pi * 220 * t)).astype(np.float32)

    cases = []
    for label, path, level, *noise in [("free decode is a candidate", ids["आ"], 0.3),
                               ("phrase candidate", ids["अ अननसाचा"], 0.3),
                               ("phrase said twice", ids["अ अननसाचा"] * 2, 0.3),
                               ("phrase said twice, a sound between", ids["अ अननसाचा"] + sp.encode("म") + ids["अ अननसाचा"], 0.3),
                               ("random: other or a candidate", None, 0.3),
                               ("random 2", None, 0.3),
                               ("silent clip", ids["क"], 0.001),
                               ("tokens outside the lesson", sp.encode("म"), 0.3),
                               ("letter for a word outside the lesson", ids["अ"] + sp.encode("फॉर गुड"), 0.3),
                               ("unsure: one weak token in weak blanks (faint clip)", sp.encode("म"), 0.3, 0.3, 2),
                               ("child sound swap: चा said सा", sp.encode("आ आगगाडीसा"), 0.3)]:
        lp = logp_for(path, *noise)
        w = wav(level)
        j = ic.decide(lp, w, cands, sp, length_feature=False)
        choice, text = (j.choice, None) if isinstance(j.choice, str) else (j.choice.display, j.choice.text)
        cases.append({"label": label, "logp": [round(v, 4) for v in lp.flatten().tolist()], "frames": T,
                      "level": level, "choice": choice, "text": text, "free": j.transcript, "unsure": j.unsure,
                      "scores": {k: round(v, 4) for k, v in j.scores.items()}})

    decodes = [[int(k) for k in rng.integers(0, ic.VOCAB, 6)] for _ in range(5)] + [ids["अ अननसाचा"], [0, 11]]
    out = {
        "pieces": [sp.id_to_piece(i) for i in range(ic.VOCAB)],
        "candidates": [{"item_id": c.item_id, "display": c.display, "text": c.text, "ids": ids[c.text]} for c in cands],
        "tokens": {c.text: sp.encode(c.text) for c in ic.child_swaps(cands)},
        "decode": [{"ids": d, "text": sp.decode(d)} for d in decodes],
        "normalise": [{"in": s, "out": evaluator.normalise(s)} for s in NORMALISE],
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False))
    print(f"{OUT} {OUT.stat().st_size // 1024} KB; choices: {[c['choice'] for c in cases]}")


if __name__ == "__main__":
    main()
