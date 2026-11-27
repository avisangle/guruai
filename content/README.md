# Lesson content

- `prompts/<lang>.json`: shared tutor lines (prompt library), used by every lesson.
- `lessons/<template>.json`: one lesson template: items (blueprint item schema), the lines tied to each item, and the lesson flow.
- `paths/`: learning paths, default goals and audio packs (below). Only lessons reachable from a path are built into the app.

Item `assessment`: `expected` (the answer), `accepted_variants` (other ways to say it, e.g. letter + picture word; also the closed-set candidates for speech scoring), optional `also_correct` (answers that count as right though they belong to another item: the vowel-length partner, `docs/decisions/D-STT-lenient-vowel-length.md`).

`accepted_variants` also lists the everyday words children use for the picture, with and without the letter in front, when they start with the item's letter: "खारुताई" for खार, the Hindi "चम्मच" for चमचा. The judge only knows the listed answers, so a missing everyday word is rejected even when said clearly. Add one when a tester session shows children using it. After editing, run `tools/stt_bench/asr_tokens.py` and `app/scripts/build-content.mjs`.

The judge reports the matched answer as its item's card letter (`display`), and an item's own card letter counts as correct (`verdictFor`, `evaluate_choice`). So `display` need not be an answer: English shows "B" while every answer is Devanagari ("बी", "बी फॉर बॉल"). Never compare a card letter with answer text directly.

Line ids are character-neutral. Each tutor gets its own audio pack for the same ids (`docs/decisions/D-CHAR-swap-ready-tutor.md`).

## Item kind, language and captions

Types: `app/src/lesson/types.ts`. Answer-language design: `docs/decisions/D-GURU-2-answer-language-tags.md`.

- `kind`: `"letter"` or `"word"`. Styles (Marathi-led and English-led teaching) apply to word items only.
- `target_lang`: `"mr"` or `"en"`, the language the child should answer in. Letter items take the lesson's `learning_language` (`mr-IN` gives `mr`, `en-IN` gives `en`).
- `ask_direction` (word items): `"picture_to_target"` ("हे काय आहे? इंग्लिशमध्ये?") or `"word_to_meaning"` ("Apple म्हणजे काय?").
- `assessment.langs` (optional): answer text to its languages, from `"mr"`, `"en"`, `"hi"`, e.g. `{ "पानी": ["hi"] }`. An answer not listed is `[target_lang]`; a text may carry several. Every key must be one of the item's `expected` or `accepted_variants` texts.
- `ambiguous_lang` (optional): `true` when answers in different languages cannot be told apart (see the build check below).
- Lines. Letter items: `teach`, `hint`, `correct`. Word items: `teach_mr_led`, `teach_en_led` (in place of `teach`), `ask` (the question in the target language, per `ask_direction`), `hint` (the Marathi bridge), `correct`, `ack_meaning` ("हो, सफरचंद! इंग्लिशमध्ये?"), `model_mr` (the Marathi word for the Hindi follow-up). Both kinds may add `react_1` and `react_2` (picture reactions). A `correct` line names the answer and never praises ("ए फॉर ॲपल!"): the engine plays a praise line for the moment first (D-GURU-19-tutor-variety).
- `captions` (optional, on lessons, on items, and on `prompts/<lang>.json`): line name to the on-screen text, with English letters and words in Latin letters ("हे बघ, A. A for Apple! आता तू म्हण!" for the voice line "हे बघ, ए. ए फॉर ॲपल! आता तू म्हण!"). A line without a caption shows its voice text. Captions are never voiced. Every line that speaks an English letter name or word gets one.

## Learning paths and packs

- `paths/<path_id>.json`: `{path_id, kind, title: {mr, en}, board?, class?, skill?, pack, units: [{unit_id, title, lessons}]}`, file name = `path_id`; `lessons` are `template_id`s. Class paths (`kind: "class"`, `class_<board>_<class>`) exist for every board (`msb`, `cbse`) and class (`Nursery`, `LKG`, `UKG`, `Class1`, `Class2`); skill paths (`kind: "skill"`, `skill_<skill>`) for `mr_letters`, `en_letters`, `en_words`, `numbers`. A unit may list no lessons yet.
- `paths/goals.json`: class to its default skill goals (skill ids).
- `paths/packs.json`: pack id to `{title, lessons}`. Every lesson reachable from a path is in exactly one pack; `starter` ships inside the app. Why packs follow class bands: `docs/decisions/D-GURU-16-packs-by-class-band.md`.

The build writes `app/src/content/generated/paths.json` (`{paths, goals, packs, lessonPack}`) and `lessons.json` (the reachable lessons, ordered by path file name, then unit).

## Audio packs

`build:content` bundles the audio of the shared lines and the `starter` pack's lessons into the app and prints its size. Every other pack is downloaded (`docs/decisions/D-GURU-14-downloads-starter-pack.md`). `npm run build:packs` (from `app/`, after `build:content`) zips each non-empty pack other than `starter` into `app/dist/packs/shekru/<pack>.v<n>.zip` (`<line id>.mp3` and `clips.json`), writes `app/dist/manifest.json` and updates `content/packs.lock.json`. A pack's version goes up only when its zip changes (`docs/decisions/D-GURU-23-pack-version-by-zip-hash.md`).

To publish, add the model and the bucket. This puts every file not yet in R2 under `guru/v1/`, then the manifest:

```sh
R2_BUCKET=<bucket> npm run build:packs -- --model <path>/mr_ctc_wav.int8.onnx --model-version <n> --publish
```

Commit `content/packs.lock.json` after a publish.

## Build check

`npm run build:content` (from `app/`) runs `validatePaths` and `validateContent` (`app/src/content/validate.ts`) first, prints every error and exits non-zero without writing anything when there are any. It reports:

- a path naming an unknown lesson or a pack not in `packs.json`; a reachable lesson in no pack; a lesson in two packs; a board and class with no class path;
- a flow `order` entry that names no item `display`;
- an item without a valid `kind` or `target_lang`, or missing a line its kind requires;
- an `assessment.langs` key that is not one of the item's answers;
- an answer with no entry in `app/src/asr/generated/mr-tokens.json` (run `tools/stt_bench/asr_tokens.py`);
- **language ambiguity:** two answers of one item whose language sets share no language, and whose normalised text (`app/src/asr/normalise.ts`) is equal or whose token id sequences are within edit distance 2. The judge could not tell which language the child used, so the build fails unless the item sets `ambiguous_lang: true`. Example: "पाणी" (mr) and "पानी" (hi), or "हात" (mr) and "हाथ" (hi).

## Authoring

How to add a catalogue entry (lesson, item, tutor line, pack) so it matches what ships. Where this section says "open point", the existing files give no rule; it describes what the existing lines do, and the owner decides whether to make it a rule. Product rules: `docs/prd/guruai-v1.md` (tutor lines use only Marathi and English, never Hindi).

### (a) Wording rules for lessons and tutor lines

Sources of tone: the style text in `VOICES` ("talking to a 5-year-old", `tools/gen_voice.py`), the Product Blueprint v3 quality checklist ("Marathi lines sound like natural spoken Marathi, not translations"; the `.docx` sits at the repo root and is gitignored), and the rules below.

- **Marathi and English only, never Hindi** in tutor lines (`docs/prd/guruai-v1.md`). Hindi appears only as an accepted answer, tagged in `assessment.langs`.
- **No gendered verb forms** for the child or the tutor. Marathi marks gender on intransitive past tense ("तू आलास / आलीस") and on first-person verbs ("देतो / देते"). Use imperatives ("सांग", "म्हण", "बघ"), transitive past, "आपण" forms, or set phrases ("ही घे एक मदत").
- Every line that opens the mic ends with "आता तू सांग!" (asking) or "आता तू म्हण!" (repeat after me). The chime follows the line.
- Write letter names as the Devanagari letter itself. English words are written in Devanagari as spoken ("कॅट").
- English letters (`kg-en-letters-*`): the card shows the capital letter; lines and answers use its spoken name in Devanagari as Indian children say it ("बी", "डबल्यू", "झेड"), with "<name> फॉर <word>" as the anchor. Answers also list "<name> फोर <word>": the speech model writes "for" either way. Answers must tokenize without `<unk>`: no hyphens ("एक्स रे"), and ॲ as one character, not अ + ZWJ + ॅ.
- Spoken, everyday Marathi, not translated English.
- Early lessons never put easily confused letters back to back (इ/ई, उ/ऊ; B/D, M/N, P/T). In quizzes this also covers ए/ऐ, ओ/औ, क/ख, ग/घ.
- Gemini TTS swaps a rarer anchor word for the usual primer word ("ऐ ऐन्याचा" came out "ऐ ऐरणीचा" in 5 takes). Check each take, and if it keeps swapping, add context to the line ("ऐना म्हणजे आरसा").
- A key in `tools/voice_latin.json` (English word to its Devanagari spelling for the voice script) must never equal a letter name (`docs/decisions/D-GURU-17-voice-latin-overrides.md`). The voice script writes English words in Devanagari; the caption writes them in Latin letters (see Item kind, language and captions).

Line grammar the existing lessons use (describe, do not extend; copy the closest existing item):

- Marathi letter item. `teach`: "हे बघ, <letter>. <letter> <anchor, genitive>! आता तू म्हण!" ("हे बघ, ख. ख खारीचा! आता तू म्हण!"). `hint`: "हे अक्षर <anchor genitive>ं आहे. <anchor>! आता तू सांग!". `correct`: "<letter>, <anchor genitive>!", which names the answer and never praises (`docs/decisions/D-GURU-19-tutor-variety.md`). `react_1`: one short playful line about the picture ("खारुताई झाडावर सरसर चढली!").
- English letter item. The spoken name in Devanagari with a "<name> फॉर <word>" anchor ("हे बघ, बी. बी फॉर बॉल! आता तू म्हण!"); the caption is in Latin ("हे बघ, B. B for Ball! आता तू म्हण!"); answers also list "<name> फोर <word>".
- Lesson lines. `intro`: "नमस्कार! आज आपण ... शिकूया. चल, सुरू करूया!". `quiz_intro`. `outro`: "आजचा अभ्यास संपला! आज आपण <letters> शिकलो. उद्या भेटूया!".
- Anchor items carry `anchor.word`, `anchor.picture`, and `accepted_variants` with "<letter> <anchor genitive>" and the bare anchor word (the `accepted_variants` paragraph above).

Open point, child-level vocabulary for ages 4 to 8: no file gives a word list or a level rule. The existing anchors are everyday picture words (खार, चमचा, ॲपल, बॉल) and the lines use short imperatives and one idea per sentence. A new anchor word is judged by the owner and the teacher reviewer in step (g).

### (b) Fixed voice settings

Shekru's voice is `Puck` with the style text below, quoted from `VOICES["shekru"]` in `tools/gen_voice.py`:

> a playful, bouncy young cartoon squirrel talking to a 5-year-old, warm and cheeky

These never change once lines ship, or new takes will not match old ones (`docs/decisions/D-CHAR-gemini-tts-voice.md`). `tools/tests/test_gen_voice.py` pins `VOICES` for all three characters and fails when any voice name or style text is edited.

### (c) Line ids

Ids are what `tools/gen_voice.py::lesson_lines` produces, and are character-neutral (each tutor gets its own audio for the same ids):

- Shared lines keep their prompt-library id in `prompts/<lang>.json`: `<family>_<n>`, or the bare family id. Families and their minimum sizes are `FAMILIES` in `app/src/lesson/lines.ts`.
- Lesson lines: `<template_id>.<line>` (`tpl_kg_en_letters_1.intro`).
- Item lines: `<template_id>.<item id>.<line>` (`tpl_kg_en_letters_1.a.teach`).

Never edit an existing id's text in place to mean something else: the take no longer matches, `build:content` reports it stale, and it must be re-voiced with `--redo` (see (d)). Add a new id instead.

### (d) Voicing new lines

From the project root, inside the venv, pass every lesson with `--lesson`:

```sh
source venv/bin/activate && python tools/gen_voice.py shekru --new --batch $(for f in content/lessons/*.json; do printf -- '--lesson %s ' "$f"; done)
```

- Without `--lesson`, `gen_voice.py` voices its demo lines into `design/voice/` instead.
- `--new` voices only lines with no take. Existing takes are never replaced except with `--redo=<id>,...`, which keeps the old take as `<id>.prev.wav`.
- `--batch` uses the Gemini Batch API (own limits, half price, up to 3 rounds). The sync and batch paths send the same `VOICES` voice and style.
- `--el-env <.env>` adds the ElevenLabs transcript check, which re-takes a clip when a script word is dropped. The key in use belongs to another project (`pending.md`).
- After voicing, run `npm run build:content` from `app/` (reports stale takes, bundles shared and starter lines). For a new answer, run `tools/stt_bench/asr_tokens.py` first.

### (e) Pitch check

Gemini sometimes voices a take like an adult (GURU-40: 7 of 114 new takes). Check new takes against the existing ones (`docs/decisions/D-GURU-55-take-pitch-check.md`). List the new takes, one path or id per line, then:

```sh
source venv/bin/activate && python tools/pitch_check.py content/audio/shekru new-takes.txt
```

For example `find content/audio/shekru -name '*.mp3' -newer <file> > new-takes.txt`. The takes are the `.wav` files next to the `.mp3`s; `.prev.` and `.rejectN.` takes are ignored.

The cut is the 5th percentile of the existing takes' median pitch. Only takes below it are flagged (low side only). The command prints the old and new summaries and a `LOW <hz> Hz  <id>` line per flagged take, lowest first, and exits 1 when any is flagged. For each flagged take: re-voice with `--redo=<id>,...`, run the check again, then listen. A flag is a prompt to listen, never a verdict, and an unflagged take still goes through the listen-through in (g). The takes are local only (`content/audio/` is gitignored), so the check is not wired into CI.

### (f) Versions

- A pack's version is never hand-edited. `npm run build:packs` bumps it only when the pack zip's SHA-256 changes, and `content/packs.lock.json` is committed after a publish (`docs/decisions/D-GURU-23-pack-version-by-zip-hash.md`; see Audio packs).
- A lesson's `version` must go up when its items or flow change after it shipped, because a saved position resumes only for the same version (`app/src/lesson/engine.ts`, `docs/decisions/D-GURU-20-in-progress-is-resumable.md`).

### (g) Review steps, in order

Source: Product Blueprint v3, "How a lesson gets made" (steps: syllabus scan, author, teacher review, prompt lines, audio, listen-through, child test, publish; "Steps 3, 6 and 7 stay human").

1. Author: an LLM drafts, the owner edits, following (a) to (c).
2. Owner check of anchor words and line grammar, then the primary teacher reviewer (blueprint step 3: accuracy and age fit). Both before voicing.
3. Voice (d).
4. Pitch check (e).
5. Listen-through (blueprint step 6).
6. Child test (blueprint step 7).
7. Publish (Audio packs, and (f)).

The lesson `status` field ("draft") is not read by any code today; it gates nothing.
