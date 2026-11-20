"""Token ids of every lesson answer for the app's on-device judge (app/src/asr).

The app has no sentencepiece, so the Marathi tokenizer runs here: every expected answer and accepted
variant in content/lessons/*.json and its child sound swaps (child_swaps), plus the 256 pieces (to read
the model's free decode). Run after
changing lesson answers; app/src/asr/lessonJudge.test.ts fails while an answer has no tokens.
  python tools/stt_bench/asr_tokens.py      (project root, venv active)
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from providers import indicconformer as ic  # noqa: E402
from providers.base import Candidate  # noqa: E402

ROOT = HERE.parents[1]
OUT = ROOT / "app" / "src" / "asr" / "generated" / "mr-tokens.json"


def main():
    sp = ic.load(ic.SLIM)[2]
    answers = {t for p in (ROOT / "content" / "lessons").glob("*.json")
               for it in json.loads(p.read_text())["items"]
               for t in it["assessment"]["expected"] + it["assessment"]["accepted_variants"]}
    texts = sorted(c.text for c in ic.child_swaps([Candidate("", "", t) for t in answers]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"pieces": [sp.id_to_piece(i) for i in range(ic.VOCAB)],
                               "tokens": {t: sp.encode(t) for t in texts}}, ensure_ascii=False) + "\n")
    print(f"{len(texts)} answers -> {OUT}")


if __name__ == "__main__":
    main()
