# Speech-to-text benchmark

Runs every candidate speech-to-text provider on the same labelled answer clips and reports which one decides a child's answer best. The input is the clip export from the app's recording mode ([docs/clip-export.md](../../docs/clip-export.md)).

## Run

From the project root:

```sh
source venv/bin/activate
python tools/stt_bench/bench.py guruai-clips-20261120-101500.zip                  # local providers only (external ones are skipped)
python tools/stt_bench/bench.py export.zip --allow-external --el-env PATH/.env    # every provider with a key
python tools/stt_bench/bench.py export/ --providers gemini_closed,whisper_local_closed --limit 20
```

| Option | Meaning |
|---|---|
| `source` | the export zip, or a folder holding `manifest.json` and `clips/` |
| `--providers a,b` | which adapters to run (default: all) |
| `--limit N` | only the first N clips of the manifest |
| `--allow-external` | allow sending audio to external services. Without it only local providers run (`whisper_local*`, `indicconformer*`). Real children's clips need the parent's consent for this and a check of the provider's data terms first ([docs/clip-export.md](../../docs/clip-export.md#privacy)) |
| `--el-env PATH` | an `.env` file holding `ELEVENLABS_API_KEY`, loaded with `load_env` from `tools/gen_voice_el.py` |
| `--out DIR` | results root (default `tools/stt_bench/results/`) |

Output goes to `results/<YYYYMMDD-HHMMSS>/`:
- `clips.csv`: one row per clip and provider: `clip, child, item, kind, label, provider, output` (transcript or closed-set choice), `verdict, heard` (the app's classification, see [How verdicts are computed](#how-verdicts-are-computed)), `latency_ms, error`, then `normalised` (the transcript after the rules below), `cost` (in the provider's pricing currency), `note` (provider detail, such as Whisper's scores or Gemini's token counts), and for closed-set scorers `transcript` (their free decode, if any) and `scores` (every candidate answer's score as JSON, best first).
- `summary.md`: the tables described under [Reading the summary](#reading-the-summary).

Extracted and converted audio lives in a temporary folder that is deleted when the run ends. Nothing is cached between runs.

## Providers

Each adapter in `providers/` has the same interface: `missing()` returns why it can't run (or `None`), `prepare()` loads models before timing starts, and `run(path, clip, lesson)` returns an `Output` holding a transcript, or a choice when `closed=True`. Closed-set judges subclass `ClosedScorer` instead and implement `judge()` (see [Adding a closed-set scorer](#adding-a-closed-set-scorer)). A provider without its key or model is skipped with a message and listed under "Skipped" in the summary.

| Name | What it does | Needs | Audio sent |
|---|---|---|---|
| `whisper_local` | stable-ts `large-v3-turbo` (same model as `tools/align_whisper.py`), language `mr`. One greedy decode of the clip, capped at 40 tokens, prompted with every lesson answer as a sentence (`अ. आ. ... अननस.`) | venv | 16 kHz mono WAV, local |
| `whisper_local_closed` | Closed set with the same model: scores every lesson answer as a forced decode of the clip and picks the letter with the highest total log-probability. "nothing" when Whisper's no-speech rule fires or its free decode is empty; "other" when its unprompted free decode beats the best answer by more than 3 nats (`OTHER_MARGIN`, uncalibrated) | venv | local |
| `indicconformer` | AI4Bharat IndicConformer Marathi (`indicconformer_stt_mr_hybrid_rnnt_large`, ~115M, MIT), greedy CTC decode, no lesson context. Torch rebuild of the CTC path, no NeMo ([below](#indicconformer)) | venv + checkpoint | 16 kHz mono WAV, local |
| `indicconformer_closed` | Same model as a closed-set scorer: every lesson answer scored by CTC log-likelihood; "nothing" on no sound, "other" when the free greedy decode is clearly more likely ([below](#indicconformer)) | as above | local |
| `indicconformer_closed_ft` | `indicconformer_closed` with the weights fine-tuned on ReadNet children ([below](#fine-tuning-on-readnet)); skipped until that file exists | as above + `~/.cache/indicconformer/finetuned/mr_ctc_readnet.pt` (or `INDICCONFORMER_FT`) | local |
| `gemini` | Gemini `generateContent` with inline audio, JSON output `{transcript}`. Model `gemini-3.5-flash-lite`, thinking at its minimum | `GEMINI_API_KEY`; optional `STT_BENCH_GEMINI_MODEL` | clip as exported (m4a) |
| `gemini_closed` | Same model, JSON output `{choice}` restricted to the lesson letters, `other` and `nothing` | as above | as above |
| `elevenlabs_scribe` | Scribe `scribe_v2`, `language_code=mr`, no keyterms | `ELEVENLABS_API_KEY` (via `--el-env`) | as exported |
| `sarvam` | Sarvam `saaras:v4`, `mr-IN`, `mode=transcribe`, lesson answers as `keyterms`. Key in the project `.env` (pass `--el-env .env`) | `SARVAM_API_KEY` | 16 kHz mono WAV |
| `android_sr`, `android_sr_biased` | Android's on-device recognizer, `mr-IN`, run on the phone by the app's probe screen; `_biased` passes the lesson answers as `contextualStrings`. The adapter only reads the pulled results ([docs/android-sr-probe.md](../../docs/android-sr-probe.md)) | `ANDROID_SR_RESULTS` (pulled results file) | on the phone, never off it |
| `indicconformer_phone` | `indicconformer_closed` as the app runs it on the phone (int8 waveform-input model from `phone_model.py`, TypeScript judge in `app/src/asr`); the adapter only reads the pulled results ([docs/android-sr-probe.md](../../docs/android-sr-probe.md)) | `ANDROID_IC_RESULTS` (pulled results-ic file) | on the phone, never off it |
| `indicconformer_shadow` | The verdict the app's judge saved with each clip during the lesson (manifest `judge`, [docs/clip-export.md](../../docs/clip-export.md)); clips without one are errors | an export recorded with the model on the phone | none (reads the manifest) |
| `google_stt` | Cloud Speech-to-Text v2 `recognize`, model `chirp_3` in `us` (Marathi is Preview there), lesson answers as an inline phrase set with boost 10. Runs in GCP project `gen-lang-client-0254681317`; `long` rejects this config for mr-IN | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_STT_ACCESS_TOKEN` (v2 takes an OAuth token, not an API key: `export GOOGLE_STT_ACCESS_TOKEN=$(gcloud auth print-access-token)`); optional `GOOGLE_STT_MODEL`, `GOOGLE_STT_LOCATION` (`short` + `global` is the GA alternative) | 16 kHz mono WAV |

Prompts, keyterms, phrase hints and closed sets always hold the whole lesson's answers, never only the item being asked. Biasing a provider towards the asked answer would make it accept more, and false accepts are the error that matters most.

The closed-set lesson comes from `content/lessons/*.json` (matched by `template_id`), plus any item that only the manifest knows.

## IndicConformer

Checkpoint: `indicconformer_stt_mr_hybrid_rnnt_large.nemo` (17-layer Conformer, d_model 512, hybrid RNNT + CTC, trained on adult Indian speech). Download it once from the link in [AI4Bharat's IndicConformerASR README](https://github.com/AI4Bharat/IndicConformerASR) to `~/.cache/indicconformer/` (523 MB; or set `INDICCONFORMER_NEMO`):

```sh
mkdir -p ~/.cache/indicconformer && curl -o ~/.cache/indicconformer/indicconformer_stt_mr_hybrid_rnnt_large.nemo \
  https://objectstore.e2enetworks.net/indicconformer/models/indicconformer_stt_mr_hybrid_rnnt_large.nemo
```

The same model is the Hugging Face repo `ai4bharat/indicconformer_stt_mr_hybrid_ctc_rnnt_large`, which is gated (log in and accept the terms). First use writes `mr_ctc.pt` (CTC path only) and `mr_tokenizer.model` next to the checkpoint.

NeMo is not installed. `providers/indicconformer.py` rebuilds the CTC path in plain torch (NeMo's log-mel features, the Conformer encoder, the CTC head) and loads the checkpoint's weights with a strict state-dict match; it needs only `torch` and `sentencepiece`. The checkpoint's tokenizer is a 22-language aggregate (256 BPE tokens each); for Marathi only Marathi's 256 CTC outputs plus blank are kept and log-softmaxed, as AI4Bharat's "multisoftmax" head does. One encoder frame is 40 ms.

`indicconformer_closed` decides in this order (constants at the top of the file, all uncalibrated, set before seeing results):
1. **No sound**: fewer than 80 ms of 25 ms frames louder than -40 dBFS → `nothing`, without running the model.
2. **Scores**: every candidate answer of the lesson (each item's `expected` and `accepted_variants`, tokenised with the Marathi tokenizer) gets its total CTC log-likelihood (`torch.nn.functional.ctc_loss`, all alignments, all frames). All candidates explain the same frames, so totals compare directly; per-token averaging would favour long answers. The best candidate wins. **Child sound swaps:** each answer is also scored as a 4-year-old says it, with word-final चा said सा, र said ल, and both ("उंदराचा" as "उंदलासा"), as more answers of the same item; on by default, as in the app (`childSwaps` in `app/src/asr/judge.ts`), and `STT_BENCH_IC_CHILD_SWAPS=0` turns it off ([D-GURU-3-child-sound-swaps](../../docs/decisions/D-GURU-3-child-sound-swaps.md)).
3. **Nothing heard**: if the greedy CTC decode is empty (the model heard no tokens), the choice is `nothing`, whatever the margin ([D-GURU-42-noise-is-not-an-answer](../../docs/decisions/D-GURU-42-noise-is-not-an-answer.md)).
4. **Free decode as a lesson answer**: if the greedy CTC decode, normalised (`evaluator.normalise`), equals a candidate, or a candidate said 2 or 3 times in a row, that candidate is chosen.
5. **Something else**: otherwise, if the greedy decode's log-likelihood beats the best candidate's by more than 3.0 nats per token of that candidate (`OTHER_MARGIN_PER_TOKEN`, [D-STT-other-margin](../../docs/decisions/D-STT-other-margin.md)), the choice is `other`. The best candidate is also scored said 2 and 3 times in a row (`REPEATS`, `STT_BENCH_IC_REPEATS=1` turns it off), and the smallest margin per token of the three counts; repeats never change which candidate is best ([D-STT-repeated-answers](../../docs/decisions/D-STT-repeated-answers.md)).
6. **Letter for any word**: when step 5 says `other` and the greedy decode holds "फॉर", "फोर" or "फर" after its first word, each letter name with a "<name> फॉर <word>" answer is scored followed by the decode's own tail from "for" on; the best wins if its margin per token of the name is within 3.0 (`STT_BENCH_IC_ANY_WORD=0` turns it off, [D-STT-letter-for-any-word](../../docs/decisions/D-STT-letter-for-any-word.md)).
7. **Unsure**: if the greedy decode scores below -10 nats per token (`UNSURE_PER_TOKEN`, `STT_BENCH_IC_UNSURE=-inf` turns it off), the judgement is marked unsure and `evaluator.classify` turns anything but correct into silent (verdict unclear); a correct one stays correct ([D-STT-unsure-not-wrong](../../docs/decisions/D-STT-unsure-not-wrong.md)).
8. **Vowel length** (opt-in, `STT_BENCH_IC_LENGTH=1`): when the choice is a bare इ/ई or उ/ऊ and its pair partner scores within 2 nats, the time the clip sounds within 25 dB of its loudest frame decides: 0.40 s or more is the long vowel. On the synthetic fixture it changed no choice, and the adult voice's durations did not separate the pairs, so it stays off until real children's clips can set the threshold.

`indicconformer` (open) has no sound check: it shows what the model alone does, including on silence.

### On-device estimate

`indicconformer_onnx.py` exports the CTC path (mel features in, log-probs out) to ONNX with the torch dynamo exporter, quantises it to int8 with ONNX Runtime's dynamic quantisation (MatMul weights only, per channel; the convolutions, the subsampling projection and the CTC head stay fp32, because quantising everything changed 10 of 35 fixture choices), and reports file size, peak RAM and one-thread latency on a 2 s clip, then checks that the ONNX fp32 and int8 models make the same choices as torch on the fixture. Files go to `~/.cache/indicconformer/onnx/`.

```sh
python tools/stt_bench/indicconformer_onnx.py tools/stt_bench/fixtures/guruai-clips-20261115-000000.zip
```

It measures this Mac's CPU, not a phone's. On Android the int8 model would run in ONNX Runtime (Android package, CPU or XNNPACK) or sherpa-onnx (it runs NeMo CTC models, but expects its own export layout: a length input and feature metadata); the log-mel features, the sound check and the CTC scoring (a forward-algorithm pass over a few dozen short candidates) would be ported to Kotlin or C++. Untested on a phone.

## Adding a closed-set scorer

A closed-set scorer judges a clip against the lesson's known answers instead of transcribing it. To add one (for example a classifier trained on our own clips):

1. Create `providers/<name>.py` with a subclass of `ClosedScorer` (`providers/base.py`). Set `name`, `external` (`False` if audio stays on this machine; external ones need `--allow-external`), `audio` (`"wav16k"` or `"original"`) and `pricing` (a key in `pricing.py`; add one if needed). Implement `missing()` (why it can't run, or `None`), `prepare()` (load the model before timing starts) and:
   ```python
   def judge(self, path, item, candidates) -> Judgement:
       # candidates: every Candidate(item_id, display, text) of the lesson: each letter, letter + word, word;
       #   on a quiz clip without the answers that are whole words of its prompt (see How verdicts are computed)
       # return Judgement(choice, scores, transcript, note)
       #   choice: one of the candidates, evaluator.OTHER or evaluator.NOTHING
       #   scores: {candidate.text: score}, higher is more likely (written to the CSV)
       #   transcript: the scorer's own free decode, if it has one
   ```
   `item` is the asked item, for diagnostics only. The choice must not lean towards it: the scorer always weighs the whole lesson (see Providers above).
2. Add the class to `ALL` in `providers/__init__.py`. It can then be named in `--providers` next to any other adapter, and the summary lists it as one more row.

`ClosedScorer.run()` turns the choice into the item's letter and keeps the chosen candidate's text (`Output.matched`) for the classification, so the existing evaluator and summary need no change. `whisper_local_closed` and `indicconformer_closed` are examples; `gemini_closed` predates the interface and returns its choice directly from `run()`.

## How verdicts are computed

`evaluator.py` is the single place for this. It ports `app/src/lesson/evaluator.ts` (exact match against `expected` + `accepted_variants` + `also_correct`, case by case) and adds normalisation. Clips are judged against the item in the current `content/lessons/*.json` (the manifest's copy only when the lesson file has no such template), so a rule change applies to old exports too. Closed-set candidates come from `expected` + `accepted_variants` only, so a judge's choice still names the letter it heard; with `also_correct` (इ↔ई, उ↔ऊ) a bare pair confusion (`इ` chosen for ई) is then judged correct, and the length-pair tables count it as a false accept. The same rules apply to the transcript and to every accepted answer before comparing.

| Rule | What | Example |
|---|---|---|
| N1 | Unicode NFC (as the app) | decomposed and composed forms match |
| N2 | Drop non-speech tags in brackets and music signs | `(हसणे) उ` → `उ`, `[laughter]` → empty |
| N3 | Drop invisible characters: ZWJ, ZWNJ, zero-width space, BOM, soft hyphen, avagraha `ऽ` | `उ‍` → `उ`, `आऽ` → `आ` |
| N4 | Remove nukta, so nukta letters fold to the base letter | `ड़` → `ड` |
| N5 | Chandrabindu becomes anusvara | `उँदीर` → `उंदीर` |
| N6 | Nasal consonant + virama before a consonant becomes anusvara | `उन्दीर` → `उंदीर` |
| N7 | Punctuation and symbols (Unicode P* and S*, including `।` `॥`) become spaces; whitespace collapsed | `अ, अननसाचा!` → `अ अननसाचा` |
| N8 | Latin lowercased; whole romanised vowel tokens mapped: `a`→अ, `aa`/`ā`→आ, `i`→इ, `ii`/`ee`/`ī`→ई, `u`→उ, `uu`/`oo`/`ū`→ऊ. Other Latin words stay as they are (and never match). `e` and `o` are not mapped: they are ambiguous | `U` → `उ` |
| N9 | A word repeated back to back is kept once | `अ अ` → `अ`, `इ. इ. इ.` → `इ` |

Vowel length is never folded: `इ`/`ई` and `उ`/`ऊ` stay different.

Verdict:
- empty after normalisation → `unclear` (the app treats this as silence and asks again)
- equal to a normalised expected answer or variant → `correct`
- anything else → `wrong`. There is no substring or fuzzy match, so `अ आ इ` does not pass for अ.

Each clip is classified as the app does (`classify()` in `app/src/asr/lessonJudge.ts`, ported as `evaluator.classify`), into the `heard` column, and the verdict follows from it:

| Heard | When | Verdict |
|---|---|---|
| `silent` | closed-set `nothing` or an empty transcript; also anything but `correct` when the scorer is unsure | `unclear` |
| `correct` | one of the asked item's answers in its `target_lang`, an `also_correct` text, or the item's own letter | `correct` |
| `meaning` | one of the asked item's answers in another language (`assessment.langs`, D-GURU-2-answer-language-tags), with that language | `correct` |
| `wrong` | anything else: another item's answer, `other`, a transcript that is no answer | `wrong` |

A closed-set choice is classified by the chosen candidate's text (closed scorers that report none, such as `gemini_closed`, by the choice itself). A child sound swap (D-GURU-3-child-sound-swaps) counts for the asked item only when the judge chose that item; a transcript has no choice, so it counts only as an answer said as itself.

Prompt exclusion, as the app's quiz listen: on a `quiz` clip with a `prompt` field, every answer whose normalised text is a whole word (or run of words) of the normalised prompt is dropped from the candidates before the scorer runs, and `indicconformer_closed` drops such texts again after adding the sound swaps. Teach clips and clips without `prompt` keep every candidate. For the app side of `prompt`, see bug.md (2026-11-21).

The benchmark records the raw verdict. The app then maps it with `toAnswer`: in a teach turn any verdict except `unclear` counts as correct, because teach turns only check that the child spoke.

## Reading the summary

Labels come from the tester: `correct`, `wrong` or `silent`. Each rate shows `k/n` and is computed over clips the provider returned without an error. Errors are counted separately.

| Column | Definition |
|---|---|
| Agreement (said something) | clips labelled `correct` or `wrong` where the verdict equals the label. `unclear` counts as disagreement |
| False accept | labelled `wrong`, judged `correct`. The worst error: the child is praised for a wrong answer and learns it |
| False reject | labelled `correct`, judged `wrong` or `unclear`. Annoying (the tutor asks again or hints), but it teaches nothing false. The count of `unclear` is shown alongside |
| Silence detected | labelled `silent`, judged `unclear`. Silent clips judged `correct` are counted alongside: in a quiz that praises a child for saying nothing |
| इ/ई, उ/ऊ agreement | agreement on items `i`, `ii` and `u`, `uu` only. The "Length pairs" table splits them into false accept and false reject |
| Latency p50 / p90 | wall time of the provider call, after audio conversion and model loading. Local Whisper latency is this machine's CPU time, not a phone's. API latency includes the network from here |
| Cost per session | the run's cost per second of audio × 240 s (about 4 minutes of child audio per session, from the blueprint). Per-request rounding is included in proportion to clip length. Gemini is priced from the token counts each response reported. Currency is the provider's own (Sarvam publishes INR only) |

**Word-item judge test.** Word items stay practice-only until a tap-mode test shows at least 80% of correct answers accepted and at most 5% false praise (PRD Language design 9, D-GURU-12-word-items-practice-only). This section counts only tap-labelled clips (no `label_by`) of word items (`item_key` kind `word`) without a provider error. *Correct answers accepted*: labelled `correct`, verdict `correct` (a `meaning` included). *False praise*: labelled `wrong` or `silent`, verdict `correct`. Each shows `k/n (pct)` and pass or fail; exactly 80% and exactly 5% pass, and no word clips shows `n/a` (D-GURU-27-word-test-meaning-counts).

The summary also has agreement per item, the price table with source URL and the date each price was read (`pricing.py`), and skipped providers.

To compare providers, look at false accepts first (keep it near zero), then false rejects, then the length pairs, then cost and latency. With a few dozen clips, one clip moves a rate by several points. Read the counts.

## Synthetic fixture

`fixtures/guruai-clips-20261115-000000.zip` is a 35-clip export in the documented format, made by `make_fixture.py` from Shekru's lesson audio (an adult cartoon voice, not a child's):
- 24 `correct`: for each letter, the letter from its `teach` line, the letter and the letter plus picture word from its `correct` line, and the picture word from its `hint` line
- 8 `wrong`: each pair partner under the other letter (इ↔ई, उ↔ऊ, अ↔आ), plus `शाब्बास` under उ and `अननस` under आ
- 3 `silent`: digital silence, low white noise, low brown noise

It only shows that the harness runs end to end. Its numbers say nothing about how a provider handles children's speech. Rebuild it with `python tools/stt_bench/make_fixture.py`.

## ReadNet fixture (real children, consonants)

`readnet_fixture.py` builds an export-format folder from Pratham's ReadNet Marathi letters ([dataset](https://huggingface.co/datasets/PrathamOrgAI/ReadNet), CC BY-NC 4.0, credit: Pratham Education Foundation; not gated). The clips are children aged 5 to 16 reading ASER letter sheets on a phone in the field. The sheets hold 29 consonants and almost no vowels, so the set tests child speech and letter confusions, not this lesson's vowel pairs.

```sh
mkdir -p ~/.cache/readnet && curl -L -o ~/.cache/readnet/MR_Letters.csv \
  https://huggingface.co/datasets/PrathamOrgAI/ReadNet/resolve/main/MR_Letters.csv
python tools/stt_bench/readnet_fixture.py            # -> ~/.cache/readnet/fixture-mr-letters/
python tools/stt_bench/bench.py ~/.cache/readnet/fixture-mr-letters --providers indicconformer_closed
```

Each sheet position always shows the same letter, so the expected letter is the most common transcript there. A clip is `correct` when the annotator's transcript is that letter, `wrong` when it is another single letter (kept in an extra `said` field), and `silent` when it is `-`. `-` marks "no valid answer" and many such clips hold sound, so the silence column is not meaningful on this set. Phrases and repeats (`ब-बदकाचा`, `र-र`) are left out. Defaults: 10 correct clips per letter, every wrong clip, 40 silent, one clip per child where possible. All 29 letters form one closed set (`template_id` `readnet_mr_letters`). The audio stays in `~/.cache/readnet/`, outside the project; the licence allows non-commercial use only. Pratham has also given GuruAI permission to train on ReadNet.

## Fine-tuning on ReadNet

`finetune_indicconformer.py` adapts the IndicConformer CTC path (the torch rebuild in `providers/indicconformer.py`, imported, not copied) from adult speech to children's, on ReadNet's Marathi letters and words. The result is a file in the same format as `mr_ctc.pt`, read by `indicconformer_closed_ft`; `mr_ctc.pt` itself is never written.

```sh
curl -L -o ~/.cache/readnet/MR_Words.csv https://huggingface.co/datasets/PrathamOrgAI/ReadNet/resolve/main/MR_Words.csv
pip install soundfile                                 # FLAC read/write
python -I tools/stt_bench/readnet_trainset.py        # -> ~/.cache/readnet/train/{train,val}.jsonl, audio/*.flac (resumable)
python tools/stt_bench/finetune_indicconformer.py --smoke   # times 200 clips, writes nothing
python tools/stt_bench/finetune_indicconformer.py           # -> ~/.cache/indicconformer/finetuned/mr_ctc_readnet.pt
python tools/stt_bench/bench.py ~/.cache/readnet/fixture-mr-letters --providers indicconformer_closed,indicconformer_closed_ft
python tools/stt_bench/indicconformer_onnx.py tools/stt_bench/fixtures/guruai-clips-20261115-000000.zip \
  --weights ~/.cache/indicconformer/finetuned/mr_ctc_readnet.pt
```

**Held out.** Every child in the ReadNet fixture (above) is left out of training in both CSVs, so the fixture stays an unseen-speaker test. The fixture manifest keeps only the first 8 hex digits of the child's uuid, so any child with that prefix is dropped. Of the rest, about 5% of children (by a hash of the uuid) form the validation set, which picks the checkpoint and stops training. Splits are by child, never by clip, because a model that has heard a child's voice scores that child's other clips too well. The son's clips and the synthetic fixture are never used in training.

**Transcripts** are what the annotator heard, not the sheet's letter, so a child who read ड for ट trains as ड. Cleaning (`clean()` in `readnet_trainset.py`): NFC; quotes, parentheses and a trailing `,` or `.` removed; `-` (no valid answer), rows with `_` (annotator notes such as `फणस_फ`), digits, Latin or other symbols dropped. A pure repeat (`र-र`, `विमान-विमान`) becomes the word repeated with a space (`र र`), which is what the clip holds; the evaluator's N9 rule folds such repeats for verdicts. Hyphenated rows whose parts differ (self-corrections `कोस-कोळसा`, sounding out `प-पतंग`, alternatives `ध -ड`) are dropped, since which part the child meant is unclear. Rows from Hindi sheets (`_HI_`) are dropped. A kept text must round-trip the Marathi tokenizer without `<unk>`. The audio (16 kHz stereo WAV on the server) is downmixed to mono as `ffmpeg -ac 1` does, the same conversion the bench applies, and stored as 16 kHz FLAC (`soundfile`).

**Recipe.** The rebuild has no padding masks, so each clip is one forward pass and gradients are summed over 16 clips per optimiser step. The subsampling and the lowest 6 of 17 Conformer layers stay frozen, and BatchNorm keeps the adult checkpoint's running statistics: the low layers hold acoustic features that transfer, and keeping them fixed limits forgetting of the adult-trained behaviour (vowels are rare in ReadNet's letter sheets). AdamW, peak learning rate 5e-5 with 150 warm-up steps and cosine decay to 5%, gradient-norm clip 1.0. SpecAugment on the log-mel features (2 frequency masks up to 15 mels, one time mask up to 5% of frames per 2 s). CTC loss on the Marathi token ids, computed on CPU because MPS has no CTC kernel; the encoder runs on MPS. Validation loss and greedy character error rate (spaces ignored) are computed before training, every 300 steps and at each epoch end; the best CER is saved and training stops after 3 validations without improvement or after `--max-hours`. All of these are flags.
