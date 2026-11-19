"""List prices used for the cost estimate, each with its official source and the date it was read.

Re-check every price before a decision; pages change. Session cost = cost per second of audio
in the run x SESSION_AUDIO_S, so per-request rounding shows up in proportion to clip length.
"""
import math

CHECKED = "2026-11-15"
SESSION_AUDIO_S = 240  # about 4 minutes of child audio per session (product blueprint)

# per_min: price per audio minute; round_s: each request rounded up to this many seconds (0: exact).
PRICES = {
    "whisper_local": {
        "currency": "USD", "per_min": 0.0, "round_s": 0, "source": "n/a",
        "price": "no API fee; runs on own hardware (large-v3-turbo is too big to run on a low-end phone)",
    },
    "indicconformer": {
        "currency": "USD", "per_min": 0.0, "round_s": 0, "source": "n/a",
        "price": "no API fee; ~120M-parameter model, small enough to try on a phone (see README)",
    },
    "android_sr": {
        "currency": "USD", "per_min": 0.0, "round_s": 0, "source": "n/a",
        "price": "no fee; Android's on-device recognizer, runs on the phone",
    },
    "elevenlabs_scribe": {
        "currency": "USD", "per_min": 0.20 / 60, "round_s": 1, "source": "https://elevenlabs.io/pricing/api",
        "price": "Scribe v2 batch $0.20 per audio hour, metered per second (rounding up to 1 s assumed; "
                 "not stated); keyterms would add $0.05/hour (not used)",
    },
    "sarvam": {
        "currency": "INR", "per_min": 0.49, "round_s": 1, "source": "https://docs.sarvam.ai/api/getting-started/pricing",
        "price": "₹0.49 per audio minute pay-as-you-go, excl. GST, billed per second; no USD price published",
    },
    "google_stt": {
        "currency": "USD", "per_min": 0.016, "round_s": 1, "source": "https://cloud.google.com/speech-to-text/pricing",
        "price": "v2 standard $0.016/min (first 500k min/month), each request rounded up to 1 s; "
                 "the page does not name chirp_3 explicitly",
    },
}

# Gemini: USD per 1M tokens (input, output incl. thinking), paid standard tier. Audio is 32 tokens/s.
GEMINI_SOURCE = "https://aistudio.google.com/docs/pricing"
GEMINI = {
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.30, 0.40),
    "gemini-3.8-flash": (0.75, 3.75),  # rises to 1.50 / 7.50 on 2027-01-01
    "gemini-3.6-flash": (0.75, 3.75),
}


def gemini_cost(model, tokens_in, tokens_out):
    if model not in GEMINI:
        return None
    p_in, p_out = GEMINI[model]
    return (tokens_in * p_in + tokens_out * p_out) / 1e6


def by_duration(key, seconds):
    p = PRICES.get(key)
    if not p:
        return None
    billed = math.ceil(seconds / p["round_s"]) * p["round_s"] if p["round_s"] else seconds
    return billed / 60 * p["per_min"]


def describe(key, model=None):
    """(currency, price text, source) for the summary."""
    if key == "gemini":
        p_in, p_out = GEMINI.get(model, (None, None))
        text = (f"{model}: ${p_in} per 1M input tokens (audio 32 tokens/s), ${p_out} per 1M output tokens incl. "
                f"thinking; paid tier" if p_in is not None else f"{model}: no price in pricing.py")
        return "USD", text, GEMINI_SOURCE
    p = PRICES[key]
    return p["currency"], p["price"], p["source"]
