# Lesson content

- `prompts/<lang>.json`: shared tutor lines (prompt library), used by every lesson.
- `lessons/<template>.json`: one lesson template: items (blueprint item schema), the lines tied to each item, and the lesson flow.

Item `assessment`: `expected` (the answer), `accepted_variants` (other ways to say it, e.g. letter + picture word; also the closed-set candidates for speech scoring), optional `also_correct` (answers that count as right though they belong to another item: the vowel-length partner, `docs/decisions/D-STT-lenient-vowel-length.md`).

`accepted_variants` also lists the everyday words children use for the picture, with and without the letter in front, when they start with the item's letter: "खारुताई" for खार, the Hindi "चम्मच" for चमचा. The judge only knows the listed answers, so a missing everyday word is rejected even when said clearly. Add one when a tester session shows children using it. After editing, run `tools/stt_bench/asr_tokens.py` and `app/scripts/build-content.mjs`.

The judge reports the matched answer as its item's card letter (`display`), and an item's own card letter counts as correct (`verdictFor`, `evaluate_choice`). So `display` need not be an answer: English shows "B" while every answer is Devanagari ("बी", "बी फॉर बॉल"). Never compare a card letter with answer text directly.

Line ids are character-neutral. Each tutor gets its own audio pack for the same ids (`docs/decisions/D-CHAR-swap-ready-tutor.md`).

## Writing rules for tutor lines

- **No gendered verb forms** for the child or the tutor. Marathi marks gender on intransitive past tense ("तू आलास / आलीस") and on first-person verbs ("देतो / देते"). Use imperatives ("सांग", "म्हण", "बघ"), transitive past, "आपण" forms, or set phrases ("ही घे एक मदत").
- Every line that opens the mic ends with "आता तू सांग!" (asking) or "आता तू म्हण!" (repeat after me). The chime follows the line.
- Write letter names as the Devanagari letter itself. English words are written in Devanagari as spoken ("कॅट").
- English letters (`kg-en-letters-*`): the card shows the capital letter; lines and answers use its spoken name in Devanagari as Indian children say it ("बी", "डबल्यू", "झेड"), with "<name> फॉर <word>" as the anchor. Answers also list "<name> फोर <word>": the speech model writes "for" either way. Answers must tokenize without `<unk>`: no hyphens ("एक्स रे"), and ॲ as one character, not अ + ZWJ + ॅ.
- Spoken, everyday Marathi, not translated English.
- Early lessons never put easily confused letters back to back (इ/ई, उ/ऊ; B/D, M/N, P/T). In quizzes this also covers ए/ऐ, ओ/औ, क/ख, ग/घ.
- Gemini TTS swaps a rarer anchor word for the usual primer word ("ऐ ऐन्याचा" came out "ऐ ऐरणीचा" in 5 takes). Check each take, and if it keeps swapping, add context to the line ("ऐना म्हणजे आरसा").
