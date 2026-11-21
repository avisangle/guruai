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

classify() ports the app's Heard classification (classify() in app/src/asr/lessonJudge.ts) and
listen_keep() its quiz prompt exclusion; the bench's verdict is VERDICT of the Heard kind.
"""
import re
import unicodedata

CORRECT, WRONG, UNCLEAR = "correct", "wrong", "unclear"
# Heard kind -> verdict, as lessonJudge.ts: a meaning is one of the item's accepted answers, so correct.
VERDICT = {"correct": CORRECT, "meaning": CORRECT, "wrong": WRONG, "silent": UNCLEAR}
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


def swaps(text: str) -> list:
    """A 4-year-old's forms of an answer, in the app's order: word-final चा said सा, र said ल, both
    (childSwaps in app/src/asr/judge.ts, D-GURU-3-child-sound-swaps)."""
    cha = re.sub(r"चा(?=\s|$)", "सा", text)
    return [cha, text.replace("र", "ल"), cha.replace("र", "ल")]


def listen_keep(clip: dict):
    """Candidate filter for the clip's listen, as listenCandidates() in the app: a quiz drops answers that
    are whole words of its prompt (the clip's `prompt`), so a child echoing the hint word is not praised.
    Teach clips and clips without a prompt keep all."""
    if clip.get("kind") != "quiz" or not clip.get("prompt"):
        return lambda text: True
    prompt = f" {normalise(clip['prompt'])} "
    return lambda text: f" {normalise(text)} " not in prompt


def classify(item: dict, choice: str, text: str | None = None, unsure: bool = False) -> dict:
    """The judge's choice against the asked item, as the app's Heard: kind correct, meaning (the item's
    answer in another language, with its lang), wrong or silent. item: flat lesson item with display,
    target_lang, expected, accepted_variants, also_correct, langs. text: the chosen candidate's text (None
    for OTHER and NOTHING). unsure: anything but correct is silent (D-STT-unsure-not-wrong)."""
    if choice == NOTHING:
        return {"kind": "silent", "by": "shekru"}
    heard = _match(item, choice, text)
    return {"kind": "silent", "by": "shekru", "unsure": True} if unsure and heard["kind"] != "correct" else heard


def _match(item, choice, text):
    if not text:  # English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
        return {"kind": "correct" if choice == item["display"] else "wrong", "by": "shekru"}
    target = item.get("target_lang")
    correct = {"kind": "correct", "by": "shekru", "text": text, "lang": target}
    said = normalise(text)
    # An answer said as itself, else with a child sound swap the judge credited to this item: "ल" chosen
    # as the ल item is not र said with a swap. Originals first, each form once (as childSwaps).
    answers = list(dict.fromkeys(item["expected"] + item["accepted_variants"]))
    forms = {a: a for a in answers}
    for a in answers:
        for s in swaps(a):
            forms.setdefault(s, a)
    own = next((o for s, o in forms.items() if normalise(s) == said and (s == o or choice == item["display"])), None)
    if own:
        langs = item.get("langs", {}).get(own, [target])  # D-GURU-2-answer-language-tags
        return correct if target in langs else {"kind": "meaning", "by": "shekru", "text": text, "lang": langs[0]}
    if choice == item["display"] or any(normalise(a) == said for a in item.get("also_correct", [])):
        return correct  # D-STT-lenient-vowel-length
    return {"kind": "wrong", "by": "shekru", "text": text}
