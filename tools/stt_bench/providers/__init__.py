"""Speech-to-text adapters. Each one: missing() -> skip reason or None; run(path, clip, lesson) -> Output.
Closed-set judges subclass base.ClosedScorer and implement judge() instead. Register every adapter in ALL."""
from .android_sr import AndroidSR, AndroidSRBiased, IndicConformerPhone, IndicConformerShadow
from .elevenlabs_scribe import ElevenLabsScribe
from .gemini import Gemini, GeminiClosed
from .google_stt import GoogleSTT
from .indicconformer import IndicConformer, IndicConformerClosed, IndicConformerClosedFT
from .sarvam import Sarvam
from .whisper_local import WhisperLocal, WhisperLocalClosed

ALL = [WhisperLocal, WhisperLocalClosed, IndicConformer, IndicConformerClosed, IndicConformerClosedFT, Gemini, GeminiClosed, ElevenLabsScribe, Sarvam, GoogleSTT, AndroidSR, AndroidSRBiased, IndicConformerPhone, IndicConformerShadow]
BY_NAME = {p.name: p for p in ALL}
