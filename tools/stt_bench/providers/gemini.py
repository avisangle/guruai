"""Gemini audio input via REST generateContent: open transcription and closed set."""
import base64
import json
import os

from .base import Lesson, Output, Provider, post_json

MODEL = os.environ.get("STT_BENCH_GEMINI_MODEL", "gemini-3.5-flash-lite")
URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
MIME = {".m4a": "audio/m4a", ".wav": "audio/wav", ".mp3": "audio/mp3", ".aac": "audio/aac",
        ".ogg": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm"}

CONTEXT = ("This is a short recording from a Marathi alphabet lesson for children aged 4 to 8 in Maharashtra. "
           "A child was asked to say a vowel letter aloud. Possible answers in this lesson (the letter alone, "
           "the letter with its picture word, or just the picture word):\n{choices}\n")
OPEN = CONTEXT + ("Transcribe exactly what the child says, in Devanagari. Do not correct it towards any answer: "
                  "keep vowel length exactly as heard (इ is short, ई is long; उ is short, ऊ is long). "
                  "If there is no speech, return an empty transcript.")
CLOSED = CONTEXT + ("Which letter did the child say? Vowel length matters: इ and ई are different answers, "
                    "as are उ and ऊ. Answer \"other\" if the child said something else or a different letter "
                    "not in the list, and \"nothing\" if there is no speech.")


def thinking(model):
    # Gemini 2.5 takes a budget; 3.x a level, and 3.8 Flash's lowest level is LOW.
    if "2.5" in model:
        return {"thinkingBudget": 0}
    return {"thinkingLevel": "LOW" if "3.8" in model else "MINIMAL"}


class Gemini(Provider):
    name = "gemini"
    audio = "original"
    pricing = "gemini"
    model = MODEL

    def missing(self):
        return None if os.environ.get("GEMINI_API_KEY") else "GEMINI_API_KEY not set"

    def _call(self, path, prompt, schema):
        body = {
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": MIME.get(path.suffix.lower(), "audio/wav"),
                                "data": base64.b64encode(path.read_bytes()).decode()}},
                {"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema,
                                 "thinkingConfig": thinking(self.model)},
        }
        data = post_json(URL.format(self.model), body, {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        parts = data["candidates"][0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        u = data.get("usageMetadata", {})
        tokens_in = u.get("promptTokenCount", 0)
        tokens_out = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
        return json.loads(text), (tokens_in, tokens_out)

    def run(self, path, clip, lesson: Lesson):
        from pricing import gemini_cost
        schema = {"type": "object", "properties": {"transcript": {"type": "string"}}, "required": ["transcript"]}
        out, tokens = self._call(path, OPEN.format(choices=lesson.described_choices()), schema)
        return Output(out["transcript"].strip(), cost=gemini_cost(self.model, *tokens),
                      note=f"{self.model} tokens in/out {tokens[0]}/{tokens[1]}")


class GeminiClosed(Gemini):
    name = "gemini_closed"

    def run(self, path, clip, lesson: Lesson):
        from evaluator import NOTHING, OTHER
        from pricing import gemini_cost
        schema = {"type": "object", "properties": {"choice": {"type": "string", "enum": lesson.choices() + [OTHER, NOTHING]}},
                  "required": ["choice"]}
        out, tokens = self._call(path, CLOSED.format(choices=lesson.described_choices()), schema)
        return Output(out["choice"], closed=True, cost=gemini_cost(self.model, *tokens),
                      note=f"{self.model} tokens in/out {tokens[0]}/{tokens[1]}")
