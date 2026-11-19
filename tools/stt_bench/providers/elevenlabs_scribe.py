"""ElevenLabs Scribe speech-to-text (scribe_v2, Marathi), same call as tools/gen_voice.py."""
import os

from .base import Lesson, Output, Provider, post_multipart

URL = "https://api.elevenlabs.io/v1/speech-to-text"


class ElevenLabsScribe(Provider):
    name = "elevenlabs_scribe"
    audio = "original"

    def missing(self):
        return None if os.environ.get("ELEVENLABS_API_KEY") else "ELEVENLABS_API_KEY not set (pass --el-env PATH)"

    def run(self, path, clip, lesson: Lesson):
        # No keyterms: they add a surcharge, and the plain model is the baseline asked for.
        data = post_multipart(URL, {"model_id": "scribe_v2", "language_code": "mr", "tag_audio_events": "false"},
                              path, {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
        return Output(data.get("text", "").strip())
