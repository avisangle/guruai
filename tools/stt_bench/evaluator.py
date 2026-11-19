"""Judges a transcript (or a closed-set choice) against a lesson item: correct / wrong / unclear.

Port of app/src/lesson/evaluator.ts (exact match against expected + accepted_variants) with
extra normalisation, applied the same way to the transcript and to every accepted answer.
Kept self-contained (stdlib only) so the rules can move into the app as they are.

Normalisation rules, in order (README.md lists them with examples):
 N1  Unicode NFC (as the app).
 N2  Drop non-speech tags in brackets: [laughter], (हसणे), {noise}, <unk>, and the music sign.
 N3  Drop invisible characters: ZWJ, ZWNJ, zero-width space, BOM, soft hyphen, avagraha (ऽ).
 N4  Nukta removed (NFD, strip U+093C, NFC again), so precomposed nukta letters fold to the base letter.
 N5  Chandrabindu (ँ) becomes anusvara (ं).
 N6  A nasal consonant with virama before a consonant (ङ् ञ् ण् न् म्) becomes anusvara: उन्दीर -> उंदीर.
 N7  Punctuation and symbols (Unicode P* and S*, incl. danda । and ॥) become spaces; whitespace collapsed.
 N8  Latin is lowercased and whole romanised vowel tokens are mapped: a->अ, aa/ā->आ, i->इ, ii/ee/ī->ई,
     u->उ, uu/oo/ū->ऊ. Other Latin words are left as they are (so they never match).
 N9  A token repeated back to back is kept once: "अ अ" -> "अ".
Vowel length is never folded: इ/ई and उ/ऊ stay distinct, which is the point of the lesson.

Verdicts:
 - transcript empty after normalisation -> unclear (the app treats this as silence and asks again)
 - equal to a normalised expected answer or accepted variant -> correct
 - anything else -> wrong (no partial or substring match: "अ आ इ" must not pass for अ)
"""
import re
import unicodedata

CORRECT, WRONG, UNCLEAR = "correct", "wrong", "unclear"
# Closed-set choices besides the item answers.
OTHER, NOTHING = "other", "nothing"

_TAGS = re.compile(r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>|[♪♫]")
_INVISIBLE = dict.fromkeys(map(ord, "​‌‍﻿­ऽ"))
_NUKTA = "़"
_NASAL_VIRAMA = re.compile("[ङञणनम]्(?=[क-हळ])")
_LATIN = {"a": "अ", "aa": "आ", "ā": "आ", "i": "इ", "ii": "ई", "ee": "ई", "ī": "ई",
          "u": "उ", "uu": "ऊ", "oo": "ऊ", "ū": "ऊ"}


def normalise(text: str) -> str:
    s = unicodedata.normalize("NFC", text or "")                               # N1
    s = _TAGS.sub(" ", s)                                                      # N2
    s = s.translate(_INVISIBLE)                                                # N3
    s = unicodedata.normalize("NFC", unicodedata.normalize("NFD", s).replace(_NUKTA, ""))  # N4
    s = s.replace("ँ", "ं")                                          # N5
    s = _NASAL_VIRAMA.sub("ं", s)                                         # N6
    s = "".join(" " if unicodedata.category(c)[0] in "PSZC" else c for c in s)  # N7
    tokens = [_LATIN.get(t, t) for t in s.lower().split()]                     # N8 (lower() leaves Devanagari alone)
    out = [t for i, t in enumerate(tokens) if i == 0 or t != tokens[i - 1]]   # N9
    return " ".join(out)


def accepted(item: dict) -> set:
    return {normalise(a) for a in item["expected"] + item["accepted_variants"] + item.get("also_correct", [])}


def evaluate(item: dict, transcript: str) -> str:
    """item: a manifest clip or lesson item with expected and accepted_variants."""
    said = normalise(transcript)
    if not said:
        return UNCLEAR
    return CORRECT if said in accepted(item) else WRONG


def evaluate_choice(item: dict, choice: str, unsure: bool = False) -> str:
    """Closed-set answer: one of the lesson's letters, OTHER or NOTHING. unsure: the model is unsure what it
    heard (faint audio), so a wrong verdict becomes unclear and the child is asked again, not told "wrong"."""
    if choice == NOTHING:
        return UNCLEAR
    if choice == item.get("display"):  # English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
        return CORRECT
    verdict = WRONG if choice == OTHER else evaluate(item, choice)
    return UNCLEAR if unsure and verdict == WRONG else verdict
