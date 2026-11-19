"""Voice the demo lesson lines with ElevenLabs, using its character timestamps for visemes.

Usage: python tools/gen_voice_el.py --env PATH_TO_.env [--set round1|round2] [--model eleven_v4]
Reads ELEVENLABS_API_KEY from the given .env. Writes design/voice/<set dir>/<voice>/<line>.mp3
and design/voice/visemes-<set>.json in the same shape as visemes.json.
round1: plain text, default settings. round2: audio tags per line and the expressive stability setting.
"""
import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from gen_voice import IND_VOWELS, LINES, VIRAMA, viseme_pair

OUT = Path(__file__).resolve().parent.parent / "design" / "voice"

# Same lines as LINES with v4 audio tags for delivery. Tags are not spoken.
TAGGED = {
    "hello": "[excited] नमस्कार! [cheerfully] चल, आज आपण एक नवीन शब्द शिकूया.",
    "teach": "[playfully] शब्द आहे कॅट. [slowly] कॅट. [excited] आता तू स्पेलिंग सांग!",
    "nohear": "[curious] मला ऐकू आलं नाही, [gently] पुन्हा सांग.",
    "tryagain": "[warmly] जवळजवळ बरोबर! [encouragingly] चल, पुन्हा प्रयत्न करूया.",
    "hint": "[mischievously] ही घे एक मदत. [whispers] पहिलं अक्षर आहे, सी.",
    "correct": "[laughs] [excited] शाब्बास! अगदी बरोबर!",
    "bye": "[happily] आजचा अभ्यास संपला! [cheerfully] उद्या भेटूया.",
}

SETS = {  # set -> (out dir, tagged, stability or None, {slug: (shared-library voice id, label)})
    "round1": ("el", False, None, {
        "amogh": ("MS9k8hkoIVOG69Xpk4BA", "Amogh M (male, casual and funny)"),
        "vardaan": ("ritE7mWIE55SDe0J11Kk", "Vardaan (young male, bright)"),
        "mukta": ("3IWTjbo2MgKIPd81jGhM", "Mukta Parab (young female, cute)"),
    }),
    "round2": ("el2", True, 0.0, {
        "amit": ("NbvR1eY6Q8ivACdEO8PV", "Amit (children's cartoon character, Hindi library voice)"),
        "vardan": ("bBG9wwa23659EgIkMbc1", "Vardan (fun kids-show character, Hindi library voice)"),
        "omar": ("srEfhy4AF67Mw9SpTVFd", "Omar J (energetic, animated, Hindi library voice)"),
        "mukta": ("3IWTjbo2MgKIPd81jGhM", "Mukta Parab, directed (Marathi library voice)"),
    }),
}
PAUSE = " ,.!?\n"


def load_env(path):
    for line in Path(path).expanduser().read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))


def tts(voice_id, text, model, stability=None):
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_64"
    body = {"text": text, "model_id": model, "language_code": "mr"}
    if stability is not None:  # v3/v4: 0.0 creative, 0.5 natural, 1.0 robust
        body["voice_settings"] = {"stability": stability}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # 409: parallel first use of a library voice races its auto-add to the account.
            if e.code not in (409, 429) or attempt == 4:
                raise
            time.sleep(5 * (attempt + 1))


def timeline(al):
    """Visemes from per-character times: onset consonant at the akshara start, then its vowel."""
    chars, st, en = al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]
    groups, cur, in_tag, laughs = [], [], False, []
    for i, ch in enumerate(chars):
        if ch == "[" or in_tag:  # audio tags are not spoken, except a laugh opens the mouth
            if ch == "[" and "".join(chars[i:i + 8]) == "[laughs]":
                laughs.append(i)
            in_tag = ch != "]"
            continue
        if ch in PAUSE:
            if cur:
                groups.append(cur)
                cur = []
            continue
        is_cons = "क" <= ch <= "ह" or ch == "ळ"
        if (is_cons or ch in IND_VOWELS) and cur and chars[cur[-1]] != VIRAMA:
            groups.append(cur)
            cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    events, prev_end = [], 0.0
    for i in laughs:
        events += [[round(st[i], 3), "AA"], [round(en[i + 7], 3), "rest"]]
        prev_end = en[i + 7]
    for g in groups:
        t0, t1 = st[g[0]], en[g[-1]]
        if events and t0 - prev_end > 0.12:  # audible gap: close the mouth
            events.append([round(prev_end, 3), "rest"])
        onset, vowel = viseme_pair("".join(chars[i] for i in g))
        if onset:
            events.append([round(t0, 3), onset])
            events.append([round(t0 + min(0.06, (t1 - t0) * 0.4), 3), vowel])
        else:
            events.append([round(t0, 3), vowel])
        prev_end = t1
    events.append([round(prev_end, 3), "rest"])
    return events


def job(set_name, slug, line, model):
    out_dir, tagged, stability, voices = SETS[set_name]
    d = OUT / out_dir / slug
    d.mkdir(parents=True, exist_ok=True)
    raw = d / f"{line}.json"
    if raw.exists():  # reuse an earlier response; credits are not spent twice
        data = json.loads(raw.read_text())
    else:
        data = tts(voices[slug][0], (TAGGED if tagged else LINES)[line], model, stability)
        (d / f"{line}.mp3").write_bytes(base64.b64decode(data["audio_base64"]))
        raw.write_text(json.dumps({"alignment": data["alignment"]}, ensure_ascii=False))
    al = data["alignment"]
    return slug, line, {"duration": round(al["character_end_times_seconds"][-1] + 0.15, 3), "events": timeline(al)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--set", default="round2", choices=SETS)
    ap.add_argument("--model", default="eleven_v4")
    a = ap.parse_args()
    load_env(a.env)
    voices = SETS[a.set][3]
    result = {s: {} for s in voices}
    with ThreadPoolExecutor(3) as ex:
        for f in [ex.submit(job, a.set, s, l, a.model) for s in voices for l in LINES]:
            try:
                s, l, tl = f.result()
                result[s][l] = tl
                print("ok", s, l, tl["duration"], len(tl["events"]))
            except Exception as e:
                print("FAIL", e, getattr(e, "read", lambda: b"")()[:300])
    name = "visemes-el.json" if a.set == "round1" else f"visemes-{SETS[a.set][0]}.json"
    (OUT / name).write_text(json.dumps(
        {"lines": LINES, "voices": {s: v[1] for s, v in voices.items()}, "clips": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
