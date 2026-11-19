"""Google Cloud Speech-to-Text v2 recognize, with the lesson answers as an inline phrase set.
Docs: https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers/recognize
v2 takes an OAuth bearer token, not an API key: export GOOGLE_STT_ACCESS_TOKEN=$(gcloud auth print-access-token)
"""
import base64
import os

from .base import Lesson, Output, Provider, post_json

MODEL = os.environ.get("GOOGLE_STT_MODEL", "chirp_3")         # Marathi on chirp_3 is Preview; "short" is the GA fallback
LOCATION = os.environ.get("GOOGLE_STT_LOCATION", "us")        # chirp_3: us or eu; short: global
BOOST = 10                                                    # allowed range 0 to 20


class GoogleSTT(Provider):
    name = "google_stt"
    audio = "wav16k"

    def missing(self):
        need = [k for k in ("GOOGLE_CLOUD_PROJECT", "GOOGLE_STT_ACCESS_TOKEN") if not os.environ.get(k)]
        return f"{' and '.join(need)} not set" if need else None

    def run(self, path, clip, lesson: Lesson):
        host = "speech.googleapis.com" if LOCATION == "global" else f"{LOCATION}-speech.googleapis.com"
        url = (f"https://{host}/v2/projects/{os.environ['GOOGLE_CLOUD_PROJECT']}"
               f"/locations/{LOCATION}/recognizers/_:recognize")
        body = {
            "config": {
                "autoDecodingConfig": {}, "languageCodes": ["mr-IN"], "model": MODEL,
                "adaptation": {"phraseSets": [{"inlinePhraseSet": {
                    "phrases": [{"value": a, "boost": BOOST} for a in lesson.answers()]}}]},
            },
            "content": base64.b64encode(path.read_bytes()).decode(),
        }
        data = post_json(url, body, {"Authorization": f"Bearer {os.environ['GOOGLE_STT_ACCESS_TOKEN']}"})
        text = " ".join(r["alternatives"][0].get("transcript", "") for r in data.get("results", [])
                        if r.get("alternatives"))
        return Output(text.strip(), note=f"billed {data.get('metadata', {}).get('totalBilledDuration', '?')}")
