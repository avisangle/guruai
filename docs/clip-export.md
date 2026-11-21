# Answer clip export format

Recording mode in the app saves one audio clip per listening turn, labelled with the answer the lesson acted on: the on-device judge's verdict (clips from before 2026-11-17: the adult tester's tap). The export is what the speech-to-text benchmark (`tools/stt_bench/`) reads.

## File

`guruai-clips-<YYYYMMDD-HHMMSS>.zip`, shared from the app through the Android share sheet:

```
manifest.json
clips/<clip id>.<ext>      audio as recorded: 16 kHz mono 16-bit WAV (exports made before 2026-11-16: m4a/AAC)
```

## manifest.json

```json
{
  "format": 1,
  "exported_at": "2026-11-15T10:42:00Z",
  "app_version": "1.0.0",
  "clips": [
    {
      "id": "c-20261115-104201-001",
      "file": "clips/c-20261115-104201-001.wav",
      "child": "C1",
      "age": 5,
      "template_id": "tpl_kg_mr_swar_1",
      "item_id": "a",
      "item_key": "mr:letter:अ",
      "display": "अ",
      "expected": ["अ"],
      "accepted_variants": ["अ अननसाचा", "अननस"],
      "kind": "teach",
      "label": "correct",
      "label_by": "judge",
      "matched_text": "अ",
      "matched_lang": "mr",
      "recorded_at": "2026-11-15T10:42:01Z",
      "duration_ms": 2380,
      "judge": { "choice": "अ", "verdict": "correct", "heard": { "kind": "correct", "by": "shekru", "text": "अ", "lang": "mr" }, "free": "अ", "note": "free=\"अ\" ...", "ms": 310 }
    }
  ]
}
```

- `child`: a short code the tester types (C1, C2, ...). Never a name.
- `age`: years, typed by the tester; optional (`null`).
- `kind`: `teach` (repeat after Shekru) or `quiz` (name the letter).
- `label`: the answer the lesson acted on: `correct`, `wrong` or `silent`. For `wrong`, what the child actually said is unknown.
- `label_by` (optional): `judge` when `label` is the judge's own verdict (`unclear` becomes `silent`), so it is not a check of the judge (D-GURU-34-parent-helps). Absent: the tester's tap.
- `matched_text` (optional): the answer text the judge matched, absent when it heard `other` or `nothing`. On a quiz turn the words of the line that opened the mic are never candidates, so a child echoing the hint word is not matched.
- `matched_lang` (optional): `mr`, `en` or `hi`, the language of `matched_text` when it is an answer of the clip's own item (absent when it is another item's answer).
- `expected`, `accepted_variants`: copied from the lesson item at recording time.
- `judge` (optional): the on-device judge's view of the clip, present when the model was on the phone. `choice` is a lesson letter, `other` or `nothing`; `verdict` is `correct`, `wrong` or `unclear` (compare with `label`, where `silent` matches `unclear`); `heard` is what the lesson got from the judge: `correct`, `meaning` (the item's answer in another language; its `verdict` is `correct`), `wrong` or `silent`, with `text` and `lang` as in `matched_*`; `free` is the model's own decode; `ms` the time to judge; `error` when judging failed. Logic: `app/src/asr/lessonJudge.ts`.

## Privacy

Clips are children's voices. They stay in the app's private storage until the tester exports them. Record only children whose parent has agreed. Do not send real clips to any external service until the parent has agreed to that too and the provider's data terms have been checked (`pending.md`).
