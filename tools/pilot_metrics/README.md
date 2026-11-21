# Pilot gate metrics

Computes the four pilot gate targets (PRD Goals, end of M1) per pilot week from the session summaries the app uploads (TDD 2.9 in the GURU-1 epic, built by `app/src/upload/summary.ts`), and writes the sheet for hand-labelling consented clips.

## Run

From the project root:

```sh
source venv/bin/activate
python tools/pilot_metrics/report.py --start 2026-12-01 --r2 \
    --sheet-out tools/pilot_metrics/data/sheet.csv --out tools/pilot_metrics/data/report.md
python tools/pilot_metrics/report.py --source DIR --start 2026-12-01 --labels tools/pilot_metrics/data/sheet.csv \
    --sheet-out tools/pilot_metrics/data/sheet.csv --out tools/pilot_metrics/data/report.md
```

| Option | Meaning |
|---|---|
| `--source DIR` | local copy of the bucket's `uploads/` prefix, laid out `<device_id>/<child_code>/<session_id>/summary.json` plus that session's `.wav` clips (default `tools/pilot_metrics/data/uploads/`) |
| `--start YYYY-MM-DD` | pilot start date. A session's pilot week is `floor((session date - start) / 7) + 1`; sessions before the start are ignored |
| `--labels FILE` | a labelling sheet with `human_label` filled in; feeds false praise |
| `--sheet-out FILE` | write the labelling sheet (CSV) |
| `--out FILE` | write the Markdown report (default: stdout) |
| `--r2` | first copy files not yet in `--source` from the bucket's `uploads/` prefix: every `summary.json`, and clips only for sessions in the labelling sample. Keys outside the upload layout are skipped. Needs `boto3` in the venv (`pip install boto3`) and `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in the environment, from an R2 API token with read access to the bucket; `R2_BUCKET` defaults to `guru-uploads` |

Everything under `tools/pilot_metrics/data/` is children's data and is ignored by git. Keep downloads, sheets and reports there.

## Targets

A session's date is its calendar date in IST ([D-GURU-39-pilot-day-ist](../../docs/decisions/D-GURU-39-pilot-day-ist.md)). Each target is reported per week with its value, goal, pass or fail and sample size; a target with no sample in a week shows `n/a`.

| Target | Counted | Goal |
|---|---|---|
| Lessons finished | Of the week's started lessons (`lessons[]`), those `finished` with `items_resolved == items_total` in a session with `parent_helps` false | at least 70% |
| False praise | Of labelled answers decided by `shekru`, those the judge heard as `correct` that the label says are `wrong` or `silent` | at most 5% |
| Active families | Of all families (device ids) seen in the pilot, those with 3 or more sessions in the week | at least 50% |
| Next-day revision | Of `shekru` answers with `phase: revision` and `revision_interval_days: 1`, those heard as `correct` | at least 80% |

Answers decided by `tap` (the parent's answer buttons) are left out of false praise and next-day revision and shown as a separate count.

## Labelling sheet

About 20% of sessions that have clips are sampled. Whether a session is in the sample depends only on a fixed seed and its session id, so the same uploads give the same sheet, and sessions that arrive later never push earlier ones out. The sheet has one row per clip answer of a sampled session:

`clip_path, session_id, child_code, template_id, item_key, expected, judge_verdict, matched_text, decided_by, human_label`

`clip_path` is relative to `--source`. `expected` joins the item's answers with ` | `; `judge_verdict` is the answer's `heard_kind`. Listen to each clip and fill `human_label` with `correct`, `wrong` or `silent`. Pass the filled sheet back with `--labels`; labels already filled are carried into the new `--sheet-out`, so the same file can be used for both.
