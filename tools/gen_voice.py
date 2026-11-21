"""Generate the demo lesson lines per character with Gemini TTS, then a viseme timeline for each.

Usage: python tools/gen_voice.py [character ...] [--redo=line,...] [--el-env PATH_TO_.env] [--lesson PATH ...]
Writes design/voice/<character>/<line>.mp3 and design/voice/visemes.json.
With --lesson (repeatable), voices the shared prompt library plus those lessons' lines instead
(ids in content/README.md) into content/audio/<character>/ and content/audio/visemes.json.
Visemes come from local Whisper alignment (tools/align_whisper.py). With --el-env (an .env
holding ELEVENLABS_API_KEY), each clip is transcribed with ElevenLabs speech-to-text: a take that
drops or changes a script word is regenerated (Gemini's own additions, like a laugh, are kept;
existing takes are only reported, never replaced),
and alignment uses the words actually spoken.
Extra English words the transcript may write in Latin letters are mapped back via tools/voice_latin.json.
With --new, only lines that have no take yet are voiced (existing ones are not re-checked or re-aligned).
With --batch, takes come from Gemini Batch API jobs (own limits, not the 100 requests/day cap; half price):
one job per round for every line still needing a take, up to 3 rounds; the last round's take is kept.
"""
import base64
import io
import json
import os
import re
import sys
import unicodedata
import uuid
import subprocess
import time
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

MODEL = "gemini-3.8-flash-tts"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
OUT = Path(__file__).resolve().parent.parent / "design" / "voice"

VOICES = {  # character -> (voice, speaking style)
    "shekru": ("Puck", "a playful, bouncy young cartoon squirrel talking to a 5-year-old, warm and cheeky"),
    "tai": ("Leda", "a kind, cheerful 12-year-old older sister talking to a 5-year-old, warm and patient"),
    "pati": ("Sadachbia", "a gentle, slightly goofy friendly cartoon character talking to a 5-year-old"),
}

LINES = {  # line id -> Marathi text (Devanagari). Letter names are spelled out in Devanagari.
    "hello": "नमस्कार! चल, आज आपण एक नवीन शब्द शिकूया.",
    "teach": "शब्द आहे कॅट. कॅट. आता तू स्पेलिंग सांग!",
    "nohear": "मला ऐकू आलं नाही, पुन्हा सांग.",
    "tryagain": "जवळजवळ बरोबर! चल, पुन्हा प्रयत्न करूया.",
    "hint": "ही घे एक मदत. पहिलं अक्षर आहे, सी.",
    "correct": "शाब्बास! अगदी बरोबर!",
    "bye": "आजचा अभ्यास संपला! उद्या भेटूया.",
}

# --- viseme mapping -------------------------------------------------------
VOWEL_SIGNS = {"ा": "AA", "ि": "I", "ी": "EE", "ु": "OO", "ू": "OO", "े": "EE", "ै": "EE",
               "ो": "O", "ौ": "O", "ॅ": "AA", "ॉ": "O", "ृ": "I"}
IND_VOWELS = {"अ": "I", "आ": "AA", "इ": "I", "ई": "EE", "उ": "OO", "ऊ": "OO", "ए": "EE",
              "ऐ": "EE", "ओ": "O", "औ": "O", "ऑ": "O"}
LABIAL = set("पफबभम")
DENTAL = set("तथदधटठडढनणलळ")
LABIODENTAL = set("व")
VIRAMA, ANUSVARA = "्", "ं"


def aksharas(text):
    """Split Devanagari into rough syllables: consonant(+virama+consonant)*(+vowel sign)(+anusvara)."""
    out, cur = [], ""
    for ch in text:
        if ch in " ,.!?":
            if cur:
                out.append(cur)
                cur = ""
            if ch != " ":
                out.append("|")  # punctuation = pause
            continue
        is_cons = "क" <= ch <= "ह" or ch in "ळ"
        if (is_cons or ch in IND_VOWELS) and cur and not cur.endswith(VIRAMA):
            out.append(cur)
            cur = ""
        cur += ch
    if cur:
        out.append(cur)
    return out


def viseme_pair(ak):
    """Return (onset viseme or None, vowel viseme) for one akshara."""
    first = ak[0]
    onset = "MBP" if first in LABIAL else "FV" if first in LABIODENTAL else "LTD" if first in DENTAL else None
    vowel = IND_VOWELS.get(first)
    for ch in ak:
        if ch in VOWEL_SIGNS:
            vowel = VOWEL_SIGNS[ch]
    vowel = vowel or "I"  # inherent schwa: small open mouth
    if ak.endswith(ANUSVARA):
        vowel = vowel  # nasal close handled by the next onset
    return onset, vowel


def voiced_segments(samples, rate):
    frame = int(rate * 0.01)
    n = len(samples) // frame
    rms = np.sqrt(np.mean(samples[: n * frame].reshape(n, frame).astype(np.float64) ** 2, axis=1))
    thr = max(rms.max() * 0.08, 1e-6)
    on = rms > thr
    segs, start, gap = [], None, 0
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > 12:  # >120 ms of quiet closes a segment
                segs.append((start, i - gap + 1))
                start, gap = None, 0
    if start is not None:
        segs.append((start, n))
    return [(a / 100, b / 100) for a, b in segs if b - a > 4], rms, thr


def timeline(text, wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate = w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    segs, _, _ = voiced_segments(samples, rate)
    # Group aksharas into phrases at punctuation, phrases onto voiced segments in order.
    phrases, cur = [], []
    for a in aksharas(text):
        if a == "|":
            if cur:
                phrases.append(cur)
                cur = []
        else:
            cur.append(a)
    if cur:
        phrases.append(cur)
    flat = [a for p in phrases for a in p]
    total = sum(b - a for a, b in segs) or 1
    # Spread all aksharas over the concatenated voiced time, proportional to segment length.
    events, idx = [], 0
    for a, b in segs:
        share = round(len(flat) * (b - a) / total) if (a, b) != segs[-1] else len(flat) - idx
        share = max(1, min(share, len(flat) - idx)) if idx < len(flat) else 0
        if share == 0:
            continue
        step = (b - a) / share
        for k in range(share):
            t = a + k * step
            onset, vowel = viseme_pair(flat[idx + k])
            if onset:
                events.append([round(t, 3), onset])
                events.append([round(t + min(0.06, step * 0.35), 3), vowel])
            else:
                events.append([round(t, 3), vowel])
        idx += share
        events.append([round(b, 3), "rest"])
    return {"duration": round(len(samples) / rate, 3), "events": events}


# --- script check and forced alignment (ElevenLabs) -----------------------
# speech-to-text writes English words in Latin script; map them to the lessons' Devanagari spelling
LATIN = {"spelling": "स्पेलिंग", "for": "फॉर", "shabaas": "शाब्बास", "shabash": "शाब्बास", "shabbas": "शाब्बास"}
LATIN.update(zip("abcdefghijklmnopqrstuvwxyz", "ए बी सी डी ई एफ जी एच आय जे के एल एम एन ओ पी क्यू आर एस टी यू व्ही डबल्यू एक्स वाय झेड".split()))
LATIN.update(zip("apple ball cat dog elephant fish grapes hat icecream jeep kite lion mango nest orange parrot queen rabbit sun "
                 "tiger umbrella van watch x ray yoyo zebra".split(),
                 "ॲपल बॉल कॅट डॉग एलिफंट फिश ग्रेप्स हॅट आइस्क्रीम जीप काइट लायन मँगो नेस्ट ऑरेंज पॅरट क्वीन रॅबिट सन "
                 "टायगर अंब्रेला व्हॅन वॉच एक्स रे योयो झेब्रा".split()))
# new English words go in tools/voice_latin.json (Latin -> Devanagari); it wins over the pairs above
LATIN.update((k.lower(), v) for k, v in json.loads((Path(__file__).resolve().parent / "voice_latin.json").read_text()).items())
JOIN = [(r"\bice[\s-]*cream\b", "icecream"), (r"\byo[\s-]*yo\b", "yoyo"), (r"\bdouble[\s-]*(u|you)\b", "w"), (r"\b([A-Za-z]+)-(?=[A-Za-z])", r"\1 ")]  # "X-ray" -> "X ray"
SPELLING = {"शाबाश": "शाब्बास", "शबाश": "शाब्बास"}  # Scribe's spelling -> the script's


def latin_to_dev(s):
    for pat, rep in JOIN:
        s = re.sub(pat, rep, s, flags=re.I)
    s = re.sub(r"[A-Za-z]+", lambda m: LATIN.get(m.group().lower(), m.group()), s)
    s = re.sub(r"(\S)\s+(चं|ची|चा|चे)(?=[\s.,!?]|$)", r"\1\2", s)
    return re.sub("|".join(SPELLING), lambda m: SPELLING[m.group()], s)  # "Apple चं" -> "ॲपलचं"


def norm(s):
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)", "", unicodedata.normalize("NFC", s))  # drop [laughs]-style event tags
    s = latin_to_dev(s)
    return re.sub(r"[\s.,!?।'\"\-\u200d]", "", s)


def spoken_text(heard):
    """Speech-to-text output as Devanagari words: event tags dropped, English words mapped back."""
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", unicodedata.normalize("NFC", heard))
    return latin_to_dev(s).strip()


def edits(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (ca != cb))
    return d[-1]


def missing_words(script, heard):
    """Script words not found, in order, in what was heard. Extra words are allowed."""
    said = [norm(w) for w in spoken_text(heard).split()]
    missing, i = [], 0
    for w in (norm(x) for x in script.split()):
        # look a few words ahead; one-letter slack per 3 letters: transcribers vary spellings (शाबास / शाब्बास)
        j = next((k for k in range(i, min(i + 3, len(said))) if edits(said[k], w) <= max(1, len(w) // 3)), None)
        if j is None:
            missing.append(w)
        else:
            i = j + 1
    return missing


def el_form(path, url, fields):
    b = uuid.uuid4().hex
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode() for k, v in fields.items())
    body += f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode()
    body += Path(path).read_bytes() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def transcribe(mp3):
    return el_form(mp3, "https://api.elevenlabs.io/v1/speech-to-text",
                   {"model_id": "scribe_v2", "language_code": "mr", "tag_audio_events": "true"})["text"]


# --- TTS ------------------------------------------------------------------
def tts(text, voice, style):
    return wav_bytes(gemini(URL, tts_request(text, voice, style))["candidates"][0]["content"]["parts"][0]["inlineData"])


PREFETCHED = None  # --batch: (char, line) -> wav bytes from the current batch job


class NeedTake(Exception):
    """--batch: this line needs another take from the next batch round."""


def wav_bytes(part):
    raw = base64.b64decode(part["data"])
    if raw[:4] != b"RIFF":  # raw PCM fallback: wrap as 24 kHz mono WAV
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(raw)
        raw = buf.getvalue()
    return raw


def tts_request(text, voice, style):
    return {
        "contents": [{"role": "user", "parts": [{"text": text, "speech_metadata": {"style": style}}]}],
        "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"voice": voice}}},
    }


def gemini(url, body=None):
    req = urllib.request.Request(url, data=body and json.dumps(body).encode(), method="POST" if body else "GET",
                                 headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def batch_tts(jobs):
    """jobs: {(char, line): (text, voice, style)} -> {(char, line): wav bytes} via one Batch API job."""
    keys = list(jobs)
    reqs = [{"request": tts_request(*jobs[k]), "metadata": {"key": f"{k[0]}|{k[1]}"}} for k in keys]
    base = "https://generativelanguage.googleapis.com/v1beta"
    name = gemini(f"{base}/models/{MODEL}:batchGenerateContent",
                  {"batch": {"display_name": f"tts-{len(keys)}", "input_config": {"requests": {"requests": reqs}}}})["name"]
    print("batch", name, len(keys), "lines", flush=True)
    while True:
        b = gemini(f"{base}/{name}")
        state = b.get("metadata", {}).get("state", "")
        if state.endswith(("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED")):
            break
        time.sleep(30)
    out = {}
    for r in b.get("response", {}).get("inlinedResponses", {}).get("inlinedResponses", []):
        key = tuple(r.get("metadata", {}).get("key", "|").split("|", 1))
        try:
            out[key] = wav_bytes(r["response"]["candidates"][0]["content"]["parts"][0]["inlineData"])
        except (KeyError, IndexError):
            print("batch FAIL", key, json.dumps(r.get("error", r))[:300], flush=True)
    print("batch", state, len(out), "of", len(keys), flush=True)
    return out


def generate(text, voice, style, key=None):
    if PREFETCHED is not None:
        if key in PREFETCHED:
            return PREFETCHED.pop(key)
        raise NeedTake(key)
    for attempt in range(6):
        try:
            return tts(text, voice, style)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            if b"PerDay" in e.read():  # daily quota: waiting minutes won't help
                sys.exit("Gemini TTS daily quota used up; run again after it resets (--new skips voiced lines)")
            time.sleep(20 * (attempt + 1))


def job(char, line, redo, check, takes=4):
    voice, style = VOICES[char]
    d = OUT / char
    d.mkdir(parents=True, exist_ok=True)
    wav_p, mp3_p = d / f"{line}.wav", d / f"{line}.mp3"
    if wav_p.exists() and line in redo:  # keep the previous take for comparison
        wav_p.rename(d / f"{line}.prev.wav")
    note, said = "", LINES[line]
    fresh = not wav_p.exists()  # existing takes are only checked, never replaced (use --redo)
    for take in range(takes if check and fresh else 1):
        if not wav_p.exists():
            wav_p.write_bytes(generate(LINES[line], voice, style, (char, line)))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_p), "-ac", "1", "-b:a", "48k", str(mp3_p)], check=True)
        if not check:
            break
        heard = transcribe(mp3_p)
        miss = missing_words(LINES[line], heard)
        note = f"take {take + 1}, missing {miss}: {heard}"
        if not miss or take == takes - 1 or not fresh:
            said = spoken_text(heard) if not miss else LINES[line]  # failed check: the transcript can't be trusted for timing
            break
        wav_p.rename(d / f"{line}.reject{take + 1}.wav")  # a script word was dropped or changed: try again
    wav = wav_p.read_bytes()
    with wave.open(io.BytesIO(wav)) as w:
        duration = round(w.getnframes() / w.getframerate(), 3)
    from align_whisper import aligned_events  # lazy: align_whisper imports this module
    events = aligned_events(mp3_p, said)
    return char, line, {"duration": duration, "events": events}, note


def lesson_lines(paths):
    """Line id -> text for the shared prompt library plus each lesson's own and per-item lines."""
    content = Path(__file__).resolve().parent.parent / "content"
    lines = dict(json.loads((content / "prompts" / "mr.json").read_text())["lines"])
    for p in paths:
        les = json.loads(Path(p).read_text())
        tid = les["template_id"]
        lines.update({f"{tid}.{k}": v for k, v in les["lines"].items()})
        for it in les["items"]:
            lines.update({f"{tid}.{it['id']}.{k}": v for k, v in it["lines"].items()})
    return lines


def main():
    global LINES, OUT, PREFETCHED
    lessons = [sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--lesson"]
    if lessons:
        LINES, OUT = lesson_lines(lessons), Path(__file__).resolve().parent.parent / "content" / "audio"
    args = [a for a in sys.argv[1:] if not a.startswith("--") and a not in lessons]
    redo = next((a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--redo=")), [])
    env = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--el-env"), None)
    if env:
        from gen_voice_el import load_env
        load_env(env)
        args = [a for a in args if a != env]
    chars = args or list(VOICES)
    vis = OUT / "visemes.json"
    saved = json.loads(vis.read_text()) if vis.exists() else {"lines": {}, "clips": {}}
    result = saved["clips"]
    todo = [(c, l) for c in chars for l in LINES
            if "--new" not in sys.argv or l in redo or l not in result.get(c, {}) or not (OUT / c / f"{l}.wav").exists()]
    def run(todo, takes=4):
        """Voices and checks each line; returns the lines that need a take from the next batch round."""
        again = []
        with ThreadPoolExecutor(1) as ex:  # one at a time: the Whisper model is shared
            for (c, l), f in [((c, l), ex.submit(job, c, l, redo, bool(env), takes)) for c, l in todo]:
                try:
                    c, l, tl, note = f.result()
                    result.setdefault(c, {})[l] = tl
                    print("ok", c, l, tl["duration"], len(tl["events"]), note, flush=True)
                except NeedTake:
                    again.append((c, l))
                except Exception as e:
                    print("FAIL", e, getattr(e, "read", lambda: b"")()[:300], flush=True)
        return again

    if "--batch" in sys.argv:
        PREFETCHED = {}
        for rnd in range(3):
            if not todo:
                break
            PREFETCHED.update(batch_tts({(c, l): (LINES[l], *VOICES[c]) for c, l in todo}))
            todo = run(todo, takes=4 if rnd < 2 else 1)  # last round: keep the take even if the check fails
    else:
        run(todo)
    # keep the text of lines voiced in earlier runs (other lessons) so their audio isn't reported stale
    vis.write_text(json.dumps({"lines": {**saved["lines"], **LINES}, "clips": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
