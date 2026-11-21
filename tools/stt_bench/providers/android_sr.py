"""Results of on-device runs in the app probe (docs/android-sr-probe.md): Android's recognizer (mr-IN) and our IndicConformer judge.

The phone does the work (app probe screen, docs/android-sr-probe.md); this adapter only looks up
each clip in the pulled results file named by ANDROID_SR_RESULTS. "plain" is open dictation,
"biased" passes every lesson answer as contextualStrings. Latency is the phone's own.
"""
import json
import os
from pathlib import Path

from .base import Output, Provider


class AndroidSR(Provider):
    name = "android_sr"
    mode = "plain"
    external = False  # on-device recognizer; audio stays on the phone
    pricing = "android_sr"

    def missing(self):
        p = os.environ.get("ANDROID_SR_RESULTS")
        if not p or not Path(p).is_file():
            return "ANDROID_SR_RESULTS does not name a pulled probe results file"
        return None

    def prepare(self):
        self.results = json.loads(Path(os.environ["ANDROID_SR_RESULTS"]).read_text())["clips"]

    def run(self, path, clip, lesson):
        r = self.results.get(clip["id"], {}).get(self.mode)
        if r is None:
            raise LookupError(f"no {self.mode} result for this clip on the phone")
        best = " ".join(f[0]["transcript"] for f in r["finals"] if f).strip()
        alts = " | ".join(a["transcript"] for f in r["finals"] for a in f)
        if r["error"] and not best and r["error"] != "nomatch":
            raise RuntimeError(r["error"])
        return Output(best, transcript=alts, note=r["error"], latency_ms=r["ms"])


class AndroidSRBiased(AndroidSR):
    name = "android_sr_biased"
    mode = "biased"


class IndicConformerPhone(Provider):
    """indicconformer_closed as run on the phone (app/src/asr, phone_model.py weights), read from the pulled
    results file named by ANDROID_IC_RESULTS. Latency is the phone's read + model + judge time."""
    name = "indicconformer_phone"
    external = False
    pricing = "indicconformer"

    def missing(self):
        p = os.environ.get("ANDROID_IC_RESULTS")
        if not p or not Path(p).is_file():
            return "ANDROID_IC_RESULTS does not name a pulled probe results-ic file"
        return None

    def prepare(self):
        self.results = json.loads(Path(os.environ["ANDROID_IC_RESULTS"]).read_text())["clips"]

    def run(self, path, clip, lesson):
        r = self.results.get(clip["id"])
        if r is None:
            raise LookupError("no result for this clip on the phone")
        if r.get("error"):
            raise RuntimeError(r["error"])
        scores = {k: float("-inf") if v is None else v for k, v in r["scores"].items()}  # JSON null: -Infinity
        return Output(r["choice"], closed=True, transcript=r["free"], note=r["note"], scores=scores or None,
                      latency_ms=sum(r["ms"].values()))


class IndicConformerShadow(Provider):
    """The judge's own verdict saved with each clip during the lesson (manifest field `judge`,
    docs/clip-export.md). Clips without it (older exports, no model on the phone) are errors."""
    name = "indicconformer_shadow"
    external = False
    pricing = "indicconformer"

    def run(self, path, clip, lesson):
        j = clip.get("judge")
        if not j:
            raise LookupError("clip has no judge field")
        if j.get("error"):
            raise RuntimeError(j["error"])
        return Output(j["choice"], closed=True, transcript=j["free"], note=j["note"], latency_ms=j["ms"],
                      matched=clip.get("matched_text", ""))
