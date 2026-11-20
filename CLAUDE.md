# GuruAI

Android app (Expo, React Native) in which Shekru, a squirrel tutor, teaches children aged 4 to 8 Marathi and English, judged by an on-device speech model. Product source of truth: [docs/prd/guruai-v1.md](docs/prd/guruai-v1.md). UI source of truth: [design/wireframes/guruai-v1-wireframes.html](design/wireframes/guruai-v1-wireframes.html) and [design/foundations/tokens.json](design/foundations/tokens.json). Where they disagree, the PRD wins.

## Tracker and workflow

- Jira project **GURU**. Branches are the bare issue key (`GURU-12`). Dev cycle: `/breakdown`, then `/tdd-prep`, `/implement`, `/review` per story, or `/develop-epic`.
- Decision records: one file per decision in `docs/decisions/`, named `D-GURU-<n>-<slug>.md` for new ones (older records use `D-STT-*` and `D-CHAR-*`).
- Bugs go to `bug.md`, deferrals to `pending.md`, one line per run to `progress.md`.

## Layout

| Path | What |
|---|---|
| `app/` | Expo app. Routes in `app/src/app/`; lesson engine `app/src/lesson/`; speech judge `app/src/asr/`; native judge module `app/modules/guru-asr/`. Read `app/AGENTS.md` before touching Expo APIs. |
| `content/` | Lesson templates, shared tutor lines, learning paths and packs; rules in `content/README.md`. Voiced audio (`content/audio/`) is built, not committed. |
| `tools/` | `gen_voice.py` (voicing), `stt_bench/` (judge benchmark, see its README). |
| `design/` | Wireframes, tokens, character art and rigs. |
| `docs/` | PRD, decision records, clip export format, provider notes. |

## Commands

App (from `app/`):

```sh
npm test               # jest
npm run typecheck      # tsc --noEmit
npm run lint           # expo lint
npm run build:content  # rebuild app/src/content/generated from content/
npx expo install <pkg> # never npm install for Expo packages
```

Python tools (from the project root, always inside the venv):

```sh
source venv/bin/activate && python tools/stt_bench/bench.py <export.zip>
```

## Rules

- **Children's data never enters git:** voice clips, clip exports, bench results derived from them, and the speech model are in `.gitignore`. The bench fixture zip is synthetic and is the only clip zip tracked. This repo is public.
- Tester recording and zip export exist only in test builds.
- Tutor lines are Marathi and English only, never Hindi. The voice script writes English words in Devanagari; the on-screen caption writes them in Latin letters.
- Every user-facing parent-mode string has Marathi and English; Marathi is the default.
- Colours, type, spacing and touch targets come from `design/foundations/tokens.json`; no literal colours in components.
