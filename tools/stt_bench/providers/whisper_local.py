"""Local Whisper (stable-ts model large-v3-turbo, as tools/align_whisper.py): open transcription and closed set.

Clips are under 30 s, so each is one Whisper window decoded directly (whisper.decode), greedy and
length-capped. stable-ts's transcribe() was tried first: on one-letter clips Whisper loops
("इ. इ. इ. ...") and stable-ts then drops the whole segment, returning an empty transcript.
"""
import sys
from pathlib import Path

from .base import ClosedScorer, Judgement, Lesson, Output, Provider

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # tools/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # tools/stt_bench/

SAMPLE_LEN = 40       # max tokens per answer; stops repetition loops (answers are a few words)
NO_SPEECH = 0.6       # Whisper's own silence rule: no-speech prob above this and avg logprob below -1
# Closed set: "other" only when the free decode beats the best lesson answer by this many nats
# (total log-probability). Uncalibrated; tune on real clips.
OTHER_MARGIN = 3.0


def _model():
    from align_whisper import model  # shared, cached stable-ts model
    return model()


def _decode(path, prompt=None):
    import whisper
    m = _model()
    mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(whisper.load_audio(str(path))),
                                      n_mels=m.dims.n_mels).to(m.device)
    res = whisper.decode(m, mel, whisper.DecodingOptions(language="mr", temperature=0.0, sample_len=SAMPLE_LEN,
                                                         prompt=prompt, without_timestamps=True, fp16=False))
    silent = res.no_speech_prob > NO_SPEECH and res.avg_logprob < -1.0
    return m, mel, res, silent


class WhisperLocal(Provider):
    name = "whisper_local"
    external = False
    pricing = "whisper_local"

    def missing(self):
        try:
            import stable_whisper  # noqa: F401
        except ImportError:
            return "stable-ts not installed in venv"
        return None

    def prepare(self):
        _model()

    def run(self, path, clip, lesson: Lesson):
        # Prompt: every lesson answer as its own sentence (a comma list makes Whisper continue the list).
        # Never just the asked item, so the bias is neutral across items.
        prompt = " ".join(f"{a}." for a in lesson.answers())
        _, _, res, silent = _decode(path, prompt)
        return Output("" if silent else res.text.strip(),
                      note=f"no_speech={res.no_speech_prob:.2f} avg_lp={res.avg_logprob:.2f}")


class WhisperLocalClosed(ClosedScorer, WhisperLocal):
    """Scores each lesson answer as a forced decode of the clip and picks the most likely letter."""
    name = "whisper_local_closed"

    def judge(self, path, item, candidates):
        import torch
        from whisper.tokenizer import get_tokenizer
        from evaluator import NOTHING, OTHER, normalise

        m, mel, free, silent = _decode(path)  # unprompted free decode: the "something else" baseline
        free_lp = free.avg_logprob * (len(free.tokens) + 1)  # decode() averages over tokens + eot
        note = f"free={free.text.strip()!r} lp={free_lp:.1f} no_speech={free.no_speech_prob:.2f}"
        if silent or not normalise(free.text):
            return Judgement(NOTHING, transcript=free.text.strip(), note=note)

        tok = get_tokenizer(m.is_multilingual, num_languages=m.num_languages, language="mr", task="transcribe")
        prefix = list(tok.sot_sequence_including_notimestamps)
        scores = {}
        with torch.no_grad():
            feats = m.embed_audio(mel.unsqueeze(0))
            for c in candidates:
                seq = prefix + tok.encode(" " + c.text) + [tok.eot]
                logp = m.logits(torch.tensor([seq[:-1]], device=m.device), feats)[0].float().log_softmax(-1)
                scores[c.text] = sum(logp[len(prefix) - 1 + k, t].item() for k, t in enumerate(seq[len(prefix):]))
        best = max(candidates, key=lambda c: scores[c.text])  # first of equal maxima, as before
        note += f" best={best.text!r} lp={scores[best.text]:.1f}"
        j = Judgement(best, scores, free.text.strip(), note)
        by_answer = {normalise(c.text): c for c in candidates}
        if normalise(free.text) in by_answer:  # the free decode already is a lesson answer
            j.choice = by_answer[normalise(free.text)]
        elif free_lp - scores[best.text] > OTHER_MARGIN:
            j.choice = OTHER
        return j
