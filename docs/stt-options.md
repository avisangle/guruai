# Children's speech recognition: how others do it, Marathi options

Researched 2026-11-15 (sources inline). Child-use terms per provider: `docs/provider-terms.md`. Benchmark: `tools/stt_bench/`.

## How child-focused apps do it

- **Google Read Along** (supports Marathi): Google's speech recognition, mostly on-device. Tuned to favour accepting borderline answers over strictness, because that keeps children encouraged ([Android Dev blog](https://android-developers.googleblog.com/2020/06/on-device-ML-design-insights.html)). No public API.
- **Wadhwani AI Vaachan Samiksha** (oral reading fluency, Gujarat): an ensemble of public Indian-language ASR models fine-tuned on annotated child recordings, aligned to the expected text; 87.4% word agreement with teachers ([MIT Solve](https://solve.mit.edu/solutions/87925)). Government deployments only.
- **Pratham (ASER / PadhAI)**: custom ASR. On Hindi child word reading, Google STT scored 49.7%; a small classifier trained on their own clips scored 81% ([Gopal 2021](https://aclanthology.org/2021.icnlsp-1.23.pdf)).
- **Amira Learning**: explicitly not ASR; detects reading errors against the expected text, trained on 100,000+ hours of child speech.
- **SoapBox Labs** (child speech API): English/Spanish only, and no new external contracts since its 2023 acquisition.
- **Microsoft Reading Coach** supports Marathi; Azure's public Pronunciation Assessment does not list mr-IN.

Pattern: the strong tools judge speech **against the known expected answer**, not by open transcription, and they lean lenient.

## Options we can use for Marathi

| Option | Licence / access | Cost | On-device | Note |
|---|---|---|---|---|
| AI4Bharat IndicConformer (Marathi, ~120M, CTC head) | MIT | free | yes on a Galaxy S25+ (2026-11-16: 137 MB int8, model 0.2 s p50 per answer on 2 threads, +200 MB memory once loaded); low-end phones untested | adult-trained; suits closed-set scoring; phone run = Mac run on accuracy (docs/android-sr-probe.md) |
| Sarvam STT | commercial, parental consent | ₹1.5 to 2 per session | no | tested: 21/32 synthetic, 0.19 s |
| IndicWav2Vec + small classifier on our clips | MIT | free | yes | needs labelled clips; Pratham ReadNet (Hindi/Marathi children, CC-BY-NC) could help |
| Azure Speech mr-IN | commercial; child terms partly checked | ~₹6 per session | no | no mr-IN pronunciation assessment |
| Android on-device SpeechRecognizer mr-IN | platform API | free | no Marathi | probed 2026-11-16 on a Galaxy S25+ (Android 17, API 37, default service `com.google.android.tts`): the on-device recognizer lists 31 locales, of Indian ones only en-IN and hi-IN; no `mr*` tag, and the offline model download for mr-IN fails with error 12 (language not supported); Gboard has no offline speech option and the Google app offers only English (India) for voice. Cloud mode would send child audio to Google. Recheck with `docs/android-sr-probe.md` |
| Google Cloud STT Chirp 3 / short | commercial | ~$0.06 per session | no | Chirp 3 terms unclear; short weak on letters |
| Bhashini | PoC only per its docs | n/a | no | not for production without agreement |
| Meta MMS, Vosk, Whisper family | NC licence / no Marathi / hallucinates | | | deprioritised |

Reported accuracy on young children's letter names (English): 90 to 93% agreement with humans, against 95% human-to-human. No published figure for Marathi vowel-length pairs.

## Shortlist to benchmark on real children's clips

1. IndicConformer Marathi as a closed-set scorer (align the expected answer and distractors; add a vowel-length check).
2. Sarvam STT with fuzzy match against the closed set (baseline).
3. A small classifier on embeddings, trained on our clips (plus ReadNet if Pratham allows).
4. Azure Speech mr-IN.
5. ~~Android on-device recognizer~~: no on-device Marathi (table above).
