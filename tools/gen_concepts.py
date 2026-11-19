"""Generate character concept sheets with Gemini (Nano Banana Pro).

Usage: python tools/gen_concepts.py [character ...] [--only hero,turnaround,expressions,mouths]
Needs GEMINI_API_KEY. Writes PNGs to design/characters/<character>/.
"""
import base64
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

MODEL = "gemini-3-pro-image"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
ROOT = Path(__file__).resolve().parent.parent / "design" / "characters"

STYLE = (
    "Flat 2D vector character art for a children's learning app for ages 4 to 8 in Maharashtra, India. "
    "Clean geometric shapes, soft rounded forms, flat colour fills with at most one soft shadow tone per colour, "
    "no gradients, no texture, no black outlines (use slightly darker same-hue edges only where needed). "
    "Big head, short body, large friendly eyes and a large clearly readable mouth. "
    "Every part (head, eyes, brows, mouth, arms, legs, tail) is a separate clean shape so it can be cut into layers "
    "and rigged with bones in Rive. Plain pure white background. No words, no labels, no watermark."
)

CHARACTERS = {
    "shekru": (
        "Shekru, a young Indian giant squirrel (Ratufa indica, the state animal of Maharashtra). "
        "Deep maroon back and shoulders, warm orange-tan head, arms and legs, cream face, chest and belly, "
        "a huge bushy maroon tail with a cream tip that curls up behind it, small rounded ears with little tufts, "
        "big dark shiny eyes with white highlights, a small pink nose, two tiny front teeth visible when smiling. "
        "Stands upright like a child. Wears a small leaf-green cloth shoulder bag. Curious, cheeky, playful."
    ),
    "tai": (
        "Tai, a cheerful 12-year-old Maharashtrian girl who acts as a kind older sister to young children. "
        "Warm medium-brown skin, round friendly face, big dark eyes, long black hair in two braids tied with "
        "marigold-orange ribbons, wearing a simple teal kurta with small white dots over cream leggings and "
        "brown sandals. Holds a short piece of white chalk. No bindi, no jewellery, no religious symbols. "
        "Warm, patient, encouraging."
    ),
    "pati": (
        "Pati, a living old-fashioned Indian school slate (paati) as a character. The body is a rectangular "
        "black-green chalk slate with rounded corners inside a thick warm-brown wooden frame. The face sits on "
        "the upper half of the slate surface: two big round eyes and a wide mouth drawn as solid shapes. The lower "
        "half of the slate shows one large hand-written chalk Devanagari letter अ. Small stubby wooden arms and "
        "legs, one hand holding a white chalk stick. A tiny chalk dust puff near the chalk. Friendly, gentle, a bit goofy."
    ),
}

SHEETS = {
    "hero": ("1:1", "A single full-body hero illustration of the character, three-quarter view, waving hello with a big smile, centred."),
    "turnaround": ("16:9", "A character turnaround model sheet of this exact character: front view, three-quarter view, side view and back view, full body, standing in a neutral pose, all four at the same scale on one line, evenly spaced."),
    "expressions": ("16:9", "An expression and pose sheet of this exact character in a 3 by 3 grid of full-body poses: "
                    "1 calm idle smile, 2 talking mid-sentence, 3 listening intently leaning forward with a hand cupped to the ear, "
                    "4 thinking with eyes looking up, 5 celebrating with a jump and arms up, 6 gently encouraging 'try again' with a soft smile and open palm, "
                    "7 giving a hint by pointing to the side, 8 puzzled 'I didn't hear you' with head tilted, 9 waving goodbye. Same character, same proportions in every cell."),
    "mouths": ("16:9", "A lip-sync mouth chart for this exact character: nine close-up heads in a 3 by 3 grid, identical except the mouth shape: "
               "1 closed rest, 2 wide open 'aa', 3 wide smile 'ee', 4 small open 'i', 5 round 'o', 6 small round pursed 'oo', "
               "7 lips pressed 'm b p', 8 top teeth on lower lip 'f v', 9 tongue behind teeth 'l t d'."),
}


def call(parts, aspect):
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"],
                             "imageConfig": {"aspectRatio": aspect, "imageSize": "2K"}},
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers={
        "x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    for p in data["candidates"][0]["content"]["parts"]:
        if "inlineData" in p:
            return base64.b64decode(p["inlineData"]["data"])
    raise RuntimeError(f"no image returned: {json.dumps(data)[:500]}")


def make(name, sheet):
    out = ROOT / name / f"{sheet}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    aspect, ask = SHEETS[sheet]
    parts = [{"text": f"{STYLE}\n\nCharacter: {CHARACTERS[name]}\n\n{ask}"}]
    hero = ROOT / name / "hero.png"
    if sheet != "hero":
        # Hero image anchors the character's look across sheets.
        parts.append({"inline_data": {"mime_type": "image/png", "data": base64.b64encode(hero.read_bytes()).decode()}})
        parts[0]["text"] += " Match the attached reference image of the character exactly."
    out.write_bytes(call(parts, aspect))
    return str(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--only=")), list(SHEETS))
    names = args or list(CHARACTERS)
    with ThreadPoolExecutor(6) as ex:
        if "hero" in only:
            for r in ex.map(lambda n: make(n, "hero"), names):
                print("ok", r)
        rest = [(n, s) for n in names for s in only if s != "hero"]
        futs = [ex.submit(make, n, s) for n, s in rest]
        for f in futs:
            try:
                print("ok", f.result())
            except Exception as e:  # keep the other sheets going
                print("FAIL", e)


if __name__ == "__main__":
    main()
