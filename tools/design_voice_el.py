"""Design candidate voices for a character with ElevenLabs Voice Design and save them to the account.

Usage: python tools/design_voice_el.py --env PATH_TO_.env [--name Shekru]
Writes design/voice/el-design/<name>.json mapping slug -> voice id, plus preview MP3s.
"""
import argparse
import base64
import json
import os
import urllib.request
from pathlib import Path

from gen_voice_el import load_env

OUT = Path(__file__).resolve().parent.parent / "design" / "voice" / "el-design"
API = "https://api.elevenlabs.io/v1"

BRIEFS = {
    "Shekru": (
        "A playful, bouncy, cheeky cartoon squirrel character from an animated children's show, speaking Marathi "
        "with a natural native Maharashtrian accent. Bright, light, slightly high-pitched youthful voice, very "
        "expressive and animated, giggly and warm, full of energy and curiosity, talking kindly to a five-year-old."
    ),
}
SAMPLE = ("नमस्कार! चल, आज आपण एक नवीन शब्द शिकूया. शब्द आहे कॅट. कॅट. आता तू स्पेलिंग सांग! "
          "शाब्बास! अगदी बरोबर! आजचा अभ्यास संपला! उद्या भेटूया.")


def post(path, body):
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST", headers={
        "xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--name", default="Shekru")
    a = ap.parse_args()
    load_env(a.env)
    OUT.mkdir(parents=True, exist_ok=True)
    rec = OUT / f"{a.name.lower()}.json"
    if rec.exists():
        print(rec.read_text())
        return
    d = post("/text-to-voice/design?output_format=mp3_44100_64", {
        "voice_description": BRIEFS[a.name], "model_id": "eleven_ttv_v3", "text": SAMPLE, "guidance_scale": 4})
    voices = {}
    for i, p in enumerate(d["previews"]):
        slug = f"{a.name.lower()}-{chr(97 + i)}"
        (OUT / f"{slug}-preview.mp3").write_bytes(base64.b64decode(p["audio_base_64"] if "audio_base_64" in p else p["audio_base64"]))
        v = post("/text-to-voice", {"voice_name": f"GuruAI {a.name} {chr(65 + i)}",
                                    "voice_description": BRIEFS[a.name], "generated_voice_id": p["generated_voice_id"]})
        voices[slug] = v["voice_id"]
        print("created", slug)
    rec.write_text(json.dumps(voices, indent=1))


if __name__ == "__main__":
    main()
