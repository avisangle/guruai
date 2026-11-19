# D-STT: Run IndicConformer on the phone through our own Expo module, features inside the ONNX graph
**Status:** Accepted
**Date:** 2026-11-16
**Issue:** none (step 3 of the on-device judging plan, after the Android recognizer probe found no offline Marathi)
**Confluence:** none

**Decision:** The phone runs `mr_ctc_wav.int8.onnx` (tools/stt_bench/phone_model.py) through a local Expo module, `app/modules/guru-asr`, that wraps Microsoft's `onnxruntime-android` pinned to the version that exported and checked the model (1.32.0). The model takes 16 kHz waveform samples: the NeMo mel features are part of the graph. CTC scoring and the closed-set decision are TypeScript (`app/src/asr`), tested against the Python judge.

**Why:**
- `onnxruntime-react-native` 1.24.3 is a legacy bridge module and its Gradle file pulls `onnxruntime-android:latest.integration`, so every build could get a different runtime; its support for React Native 0.88's architecture is unproven. The Expo module is about 60 lines of Kotlin with a pinned dependency.
- Features in the graph: no signal-processing code to port and keep in step, and the Mac checks the exact file the phone runs (features match torch to 1e-4).
- Decision logic in TypeScript: unit-tested on the Mac with Jest against goldens from the Python code (`tools/stt_bench/phone_golden.py`), and later shared with the lesson engine.

**Rejected:**
- `onnxruntime-react-native`: unpinned runtime, legacy bridge.
- Android's built-in recognizer: no offline Marathi (docs/stt-options.md).
- Feature extraction in TypeScript or Kotlin: a second implementation of NeMo's preprocessing to keep identical.

**Impact:**
- Adding or changing native code needs a new EAS build; the JavaScript side reloads from the Mac.
- Changing `phone_model.py`, the judge constants or `evaluator.normalise` means regenerating the goldens and keeping `app/src/asr` in step (the tests fail otherwise).
- The int8 waveform model makes a different choice from the torch model on 12 of 362 ReadNet clips (the earlier feature-input int8 model: 5); all close neighbour-consonant calls.
