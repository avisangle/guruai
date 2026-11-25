"""GURU-46: android_probe.probe_candidates sends the phone the candidates the Mac judge scores.

Run from the project root inside the venv:
    source venv/bin/activate && python -m pytest tools/tests/test_android_probe.py

Synthetic only: no audio, no model, no phone, no adb. `sp` is a fake SentencePiece with a fixed encode.

Real shapes, read from the source (D-GURU-3-child-sound-swaps):
- providers.base.Candidate(item_id, display, text), frozen dataclass.
- providers.indicconformer.child_swaps(candidates): originals first (one per text), then each
  candidate's evaluator.swaps(text) in order, each text once, same item_id and display.
  Applied by decide() only when indicconformer.CHILD_SWAPS is true.
- Probe manifest candidate entry: {"item_id", "display", "text", "ids"}.
Consumer: push() in android_probe.py (probe_candidates is its candidate builder, no dependents beyond it).
"""
import inspect
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "stt_bench"))
import android_probe  # noqa: E402
from providers import indicconformer as ic  # noqa: E402
from providers.base import Candidate  # noqa: E402

FIXED_IDS = [7, 8, 9]
KEYS = {"item_id", "display", "text", "ids"}


class FakeSp:
    """encode returns a fixed list, as the issue specifies."""

    def encode(self, text):
        return list(FIXED_IDS)


def mouse():
    return [Candidate("item-u", "उ", "उंदराचा")]


def test_contract_probe_candidates_shape_for_push():
    """Contract (push, GURU-46): probe_candidates(candidates, sp) -> list of dicts with exactly
    item_id, display, text, ids."""
    assert callable(getattr(android_probe, "probe_candidates", None))
    assert list(inspect.signature(android_probe.probe_candidates).parameters) == ["candidates", "sp"]
    out = android_probe.probe_candidates(mouse(), FakeSp())
    assert isinstance(out, list) and out
    for e in out:
        assert set(e) == KEYS
        assert isinstance(e["text"], str) and isinstance(e["ids"], list)


def test_includes_child_swaps_originals_first(monkeypatch):
    """The phone gets the lesson candidate plus its sound swaps, original first."""
    monkeypatch.setattr(ic, "CHILD_SWAPS", True)
    out = android_probe.probe_candidates(mouse(), FakeSp())
    texts = [e["text"] for e in out]
    assert texts[0] == "उंदराचा"
    assert set(texts) == {"उंदराचा", "उंदलाचा", "उंदरासा", "उंदलासा"}
    assert len(texts) == 4


def test_swaps_keep_item_id_display_and_encode_ids(monkeypatch):
    monkeypatch.setattr(ic, "CHILD_SWAPS", True)
    out = android_probe.probe_candidates(mouse(), FakeSp())
    assert all(e["item_id"] == "item-u" and e["display"] == "उ" for e in out)
    assert all(e["ids"] == FIXED_IDS for e in out)


def test_swaps_off_returns_only_original_candidates(monkeypatch):
    monkeypatch.setattr(ic, "CHILD_SWAPS", False)
    cands = [Candidate("a", "अ", "अननस"), Candidate("a", "अ", "अ")]
    out = android_probe.probe_candidates(cands, FakeSp())
    assert [(e["item_id"], e["display"], e["text"]) for e in out] == [("a", "अ", "अननस"), ("a", "अ", "अ")]


def test_texts_match_what_the_mac_judge_scores_in_order(monkeypatch):
    """Same set and order as ic.child_swaps, the list decide() scores with the default keep."""
    monkeypatch.setattr(ic, "CHILD_SWAPS", True)
    cands = [Candidate("a", "अ", "अननसाचा"), Candidate("u", "उ", "उंदराचा"), Candidate("u", "उ", "उंदराचा")]
    out = android_probe.probe_candidates(cands, FakeSp())
    expected = [(c.item_id, c.display, c.text) for c in ic.child_swaps(cands)]
    assert [(e["item_id"], e["display"], e["text"]) for e in out] == expected
