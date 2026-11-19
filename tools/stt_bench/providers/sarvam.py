"""Sarvam AI speech-to-text (saaras:v4, mr-IN) with the lesson answers as keyterms.
Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
"""
import json
import os

from .base import Lesson, Output, Provider, post_multipart

URL = "https://api.sarvam.ai/speech-to-text"


class Sarvam(Provider):
    name = "sarvam"
    audio = "wav16k"  # 16 kHz is Sarvam's recommended rate

    def missing(self):
        return None if os.environ.get("SARVAM_API_KEY") else "SARVAM_API_KEY not set"

    def run(self, path, clip, lesson: Lesson):
        fields = {"model": "saaras:v4", "language_code": "mr-IN", "mode": "transcribe",
                  "keyterms": json.dumps(lesson.answers()[:50], ensure_ascii=False)}  # API limit: 50 terms
        data = post_multipart(URL, fields, path, {"api-subscription-key": os.environ["SARVAM_API_KEY"]})
        return Output(data.get("transcript", "").strip())
