# PRD: GuruAI V1

Supersedes `GuruAI - Product Blueprint v3.docx` (2026-11-14) where they differ. Written 2026-11-19.

## Summary

GuruAI is an Android app in which a Marathi-speaking cartoon tutor, Shekru, teaches children aged 4 to 8 the school syllabus, Marathi literacy and topics their parents choose. Shekru explains in Marathi and uses English where the child needs the English word, never Hindi. The child answers aloud, and a speech model on the phone checks the answer offline. Parents set goals and limits behind a parent lock and see progress. V1 is built in three milestones: M1 is a pilot with 10 to 20 families, M2 adds accounts and is the public launch, M3 adds parent-made content.

## Problem Statement

Marathi-speaking families send their children to English-medium schools, where teachers often explain in Hinglish. At home the child hears Marathi; at school, English explained through Hindi. Many children aged 4 to 8 mix up the three languages and struggle to understand English letters, words and their meanings.

Parents fill the gap themselves. They re-teach the school syllabus in Marathi, explain English words in Marathi, teach Marathi literacy (वर्णमाला, बाराखडी) that the school does not cover, and teach whatever else they think matters, in or out of the syllabus. Many do not have the time every day, and tuition classes usually teach in Hinglish too. Most learning apps only take taps, are built around English, and cannot hear a Marathi answer.

GuruAI takes the place of that parent. Marathi-medium families have the mirror need (Marathi school content, English as a subject, explained in Marathi) and are served by the same app.

## Goals

Pilot gate (end of M1; 10 to 20 families, 4 weeks):
- At least 70% of started lessons finish with every item resolved, without a parent stepping in (a session with the "parent helps" switch on counts as stepping in).
- False praise (a wrong answer judged correct) at most 5% of answers, measured on consented, hand-labelled clips.
- At least half of families active in week 4, at 3 or more sessions a week.
- At least 80% of mastered items still correct at the next-day revision.

Also measured in the pilot, not a gate: parents are asked whether their child can predict what Shekru will say.

Launch (end of M2): public Play Store release with the 55 to 65 lesson launch catalogue for Maharashtra State Board and CBSE, Nursery to Class 2.

Cost: no per-session server cost for speech; the only running costs are downloads (Cloudflare R2, free egress) and, from M2, the Supabase backend.

## Non-Goals

- iOS.
- More tutor characters at launch (the app stays ready for them).
- A cloud speech judge, or any third-party speech API, for the child's answers.
- Changing the teaching style within a lesson.
- Homework from a photo or PDF, sharing lessons between families, free-talk mode with the tutor.
- Adult-voice detection.
- Paid plans.
- Boards other than Maharashtra State Board and CBSE.
- Ads, and analytics that profile the child.

## Current State

As of 2026-11-19 the project is a working prototype on the owner's phone (Galaxy S25+), not a product:

| Area | What exists |
|---|---|
| App | Expo SDK 58, Expo Router, React Native 0.88 (`app/`). One home screen with a lesson menu and a tester recording panel. |
| Lesson player | Flow defined by each lesson file: teach all items, quiz, retry missed items (`app/src/lesson/engine.ts`, 8 lessons in `content/lessons/`: Marathi स्वर 1 and 2, व्यंजन 1, English letters A to Z in 5 lessons). Position saved after every answer in SQLite (`app/src/progress/storage.ts`), with a per-item `mastered` flag. |
| Tutor | Shekru: rigged SVG, 10 animated states, lip sync (`app/src/shekru/`). Lines voiced with Gemini TTS ([D-CHAR-gemini-tts-voice](../decisions/D-CHAR-gemini-tts-voice.md)); line ids are character-neutral ([D-CHAR-swap-ready-tutor](../decisions/D-CHAR-swap-ready-tutor.md)). |
| Speech judge | IndicConformer Marathi, int8 ONNX (137 MB), in an own Expo module with onnxruntime-android ([D-STT-on-device-runtime](../decisions/D-STT-on-device-runtime.md)). Closed set: scores only the lesson's listed answers. Auto-stop, judge drives the lesson, "unsure" asks again (D-STT-* records). Tested on one child over 6 sessions: on the latest tap-labelled session it agreed with the tester on 18 of 22 answers (Mac) and 17 of 22 (phone). Only letters and letter + word answers have been tested. The model is pushed to the phone over USB. |
| Recording | Tester mode saves labelled clips and exports a zip (`docs/clip-export.md`). |
| Content pipeline | `tools/gen_voice.py` (Gemini TTS, batch, Scribe word check), `app/scripts/build-content.mjs`, `tools/stt_bench/asr_tokens.py`. |
| Not built | Child profiles, onboarding, parent PIN and parent mode, today's queue, learning paths, spaced revision, downloads, consent, uploads, any backend. |

## User Personas

| Persona | Description | Primary action |
|---|---|---|
| Child | 4 to 8, Nursery to Class 2, often cannot read yet; uses a parent's phone | Picks their face, presses one big button, learns with Shekru |
| Parent | Marathi-speaking, child in an English-medium or Marathi-medium school; sets the app up on their own phone | Onboarding, goals and limits, assigns lessons, reads progress; from M3 creates own lessons |
| Pilot admin | The owner | Builds, consent records, reviews consented clips and session summaries |

## Proposed Solution

### Architecture

- **Speech is judged on the phone only.** The existing closed-set judge, extended with the child sound swaps (word-final चा to सा, र to ल), which on the bench raised correct accepts on the son's tap-labelled sessions from 56 to 62 of 79 with no change in false accepts. A cloud judge was considered and rejected: its free usage would run out as users grow, and it would send every answer's audio off the phone.
- **Local-first data.** The phone's SQLite database is the source of truth. Every answer is stored as an append-only event; mastery, revision and reports are derived from events. M2 adds sync on top: upload new events, download parent changes. Rejected: backend-first with Supabase from M1 (delays the pilot behind login, sync and SMS OTP work) and Firebase (document store against a relational model, vendor lock-in).
- **Downloads from Cloudflare R2** behind an owned domain: the model and audio packs. Free egress; 10 million reads a month on the free tier. A cache rule on the download paths and versioned file names.
- **A thin backend grows per milestone.** M1: one small upload function (Cloudflare Worker) that returns short-lived upload links for consented clips and session summaries into R2. M2: Supabase (Mumbai) for login, database and sync. M3: server functions for voicing and drafting parent content.
- **Tutor as a profile setting.** Each child profile has a tutor field; Shekru is the only option at launch. Every tutor follows the same state and viseme contract and has its own audio pack per line id (D-CHAR-swap-ready-tutor).

### Language design

The tutor uses Marathi as the bridge into English, consistently, rather than switching on every line. An independent review of the first design (per-item level switching) found it would follow the judge's errors more than the child, needed language tags the judge cannot reliably produce, and roughly tripled audio. This design replaces it:

1. **Every word item has a target language and a question direction.** "हे काय आहे? इंग्लिशमध्ये?" has target English; "Apple म्हणजे काय?" has target Marathi. A word the tutor said in the question does not count as the child's answer in that turn.
2. **Within an item: ask, Marathi bridge, reveal.** The question is in the target language. On a miss, the hint is the Marathi bridge ("सफरचंद... इंग्लिशमध्ये?"). On a second miss, the tutor says the answer and the child repeats it.
3. **Two teaching styles per word item:** Marathi-led and English-led. The child's level picks the style. The level changes only between sessions, from the child's first-try rate on the target word; unclear and unsure answers do not count.
4. **The parent picks goals** (English words, Marathi letters, numbers, ...), a starting style and an optional limit, and can hear a short sample of each style. From M2 a placement check sets the starting level.
5. **Styles apply to word and meaning items only**, not to वर्णमाला or बाराखडी items.
6. **Answers carry a language tag** (mr, en, hi). A build-time check flags items whose answers in different languages cannot be told apart (identical text, or a token or two apart, such as पाणी/पानी, हात/हाथ, आठ); flagged items never trigger a language-based reaction.
7. **Hindi answers on Marathi-target items.** A Hindi word with the right meaning counts as correct and is praised. On items the check can tell apart, the tutor then asks for the Marathi word ("मराठीत काय म्हणतात?"; wireframe decision 24); if the child does not know it, the tutor says it and the child repeats. This turn never affects mastery. On flagged items, the tutor only models the word. On English-target items a Hindi answer follows rule 8 (owner decision, 2026-11-20).
8. **Right meaning in Marathi or Hindi when the target is English** ("सफरचंद" or "सेब" to "हे काय आहे? इंग्लिशमध्ये?"): the tutor acknowledges the meaning ("हो, सफरचंद!"; for a Hindi answer "हो, अर्थ बरोबर!", without repeating the Hindi word) and asks for the English word, as the bridge step. It is not a wrong attempt and is not counted as correct.
9. **Word items are practice only until they pass a judge test.** Until a tap-mode test on whole-word and meaning answers shows at least 80% of correct answers accepted and at most 5% false praise, a "wrong" verdict on a word item never holds the child back or marks the item as not learned. Letter items count as today.

Tutor lines use only Marathi and English, never Hindi.

**Captions show English in English letters.** Each tutor line has two texts: the voice script, with English words in Devanagari as spoken ("धिस इज ॲन ॲपल"), which the voice generator needs; and the on-screen caption, with English words in Latin letters ("This is an apple. Apple म्हणजे सफरचंद"), which the adult reading along sees.

### Learning model

- **Session and lesson:** a session is one sitting, from the child tapping their face to goodbye, Stop, or the app being closed; a pause or a phone call does not end it. A lesson is one item list inside a session. Reports list lessons.
- **Mastery per child, per item, per language**, keyed by `item_key`, so it carries across lessons, paths and class changes.
- **Revision:** a mastered item is checked again after 1, 3, 7, 14 and 30 days (initial values, tuned on pilot data); a miss resets it to 1 day.
- **Learning paths:** GuruAI class paths (auto-enrolled from class and board) and skill paths (parent turns on). Parent playlists arrive in M3.
- **Today's queue** for the child: revision due is always included and never counts toward the goal; then lessons fill in this order until the daily lesson goal is met: lessons the parent assigned for today, the next lesson in each active path. Revision items due today are mixed into today's lessons first; any left over form a short revision stop (2 to 3 minutes) on the trail, after the first lesson. Lessons whose audio pack is not on the phone stay out of the queue.
- **What counts toward the goal:** a lesson counts when it reaches its end, including a repeat of a finished lesson. A lesson left early counts once it is resumed and finished.
- **Daily goal in lessons, not minutes:** the parent picks 1 to 5 lessons a day (default 3). A safety cap on active time (default 30 minutes; the parent can change it or turn it off) guards screen time; time while paused, or after about 20 s of silence, does not count. Children answer at very different speeds and pause mid-lesson, so a fixed number of minutes would cut some off just before the end of a lesson.

### Tutor variety

The prototype has 3 praise lines, 2 "wrong" lines, 1 "didn't hear" line, one intro and outro per lesson, one teach, hint and praise line per item, and a fixed quiz order, so a repeated lesson is word-for-word the same and children learn to predict Shekru. In M1 the tutor must not feel scripted:

1. **Larger line pools** for shared lines: about 15 to 20 praise lines; 8 to 10 each for try again, didn't hear and the quiz question; several lesson intros and goodbyes. A line is not reused within the last few turns (not only "not the last one").
2. **Praise that fits the moment**, from separate pools: correct first try, correct after a hint, three in a row (at 3, 6, 9 ... correct answers in a row), a comeback after a miss, finishing a lesson (two pools: all correct, and with misses, so Shekru never says "all of them went well" after misses). When two moments apply: comeback, then after a hint, then three in a row, then first try.
3. **Picture reactions**: one or two fun lines per item tied to its picture ("चू चू! आगगाडी आली!", "ऊस किती गोड लागतो!"). M1 covers the pilot lessons; later lessons add them as they are written.
4. **Occasional surprises**: at random, at most one per lesson and not in every lesson, Shekru does something unexpected between items: a silly animation (sneezes, drops his nut, a little dance), a one-line joke or fun fact, or a celebration without speech.
5. **A different lesson each time**: the quiz order is shuffled every run, still keeping confusable letters apart (content/README rules), and revision items are mixed in between new ones.

All of it stays pre-recorded audio and pre-built animation; nothing is generated on the phone.

### Behavioral Flows

First run:

```mermaid
sequenceDiagram
    actor Parent
    participant App
    participant R2 as Download server (R2)
    Parent->>App: Install and open
    App->>R2: On first open: download the model in the background (Wi-Fi, resumable); starter pack and shared lines are inside the app
    App-->>Parent: Welcome (Marathi, language switch)
    Parent->>App: Parent lock (phone's screen lock, or a separate app PIN); who is learning (nickname, picture, class, school medium)
    Parent->>App: Hand the phone to the child; mic permission dialog
    R2-->>App: Files
    App->>App: Verify checksums, check the phone runs the judge fast enough
    App-->>Parent: On the first goodbye: "For parents: help improve Shekru?" strip (consents, default off)
```

One answer in a lesson:

```mermaid
sequenceDiagram
    actor Child
    participant App
    participant Judge as On-device judge
    App-->>Child: Shekru asks in the target language, chime
    Child->>App: Spoken answer (auto-stop)
    App->>Judge: Clip and the lesson's answers
    Judge-->>App: Matched answer (item, language) or other / nothing, unsure flag
    alt Correct in the target language
        App-->>Child: Praise, next item
    else Right meaning in Hindi, target Marathi
        App-->>Child: Praise, then ask for the Marathi word
    else Right meaning in Marathi or Hindi, target English
        App-->>Child: Acknowledge, ask for the English word
    else Wrong or other
        App-->>Child: Hint (letters: the picture word; words: Marathi bridge), ask again, then reveal and repeat
    else Nothing heard or unsure
        App-->>Child: "मला ऐकू आलं नाही, पुन्हा सांग" once; a second in a row: teaching moves on, quiz counts it as a missed try (hint, no "wrong" line)
    end
    App->>App: Save event, update position and mastery
```

Consented upload (M1):

```mermaid
sequenceDiagram
    participant App
    participant Fn as Upload function
    participant R2 as Storage (R2)
    App->>App: Session ends; consent on; Wi-Fi available
    App->>Fn: Request upload links (device id, child code)
    Fn-->>App: Short-lived links
    App->>R2: Upload clips and the session summary
    R2-->>App: Stored
    App->>App: Mark uploaded; delete local copies past retention
```

## Happy Path

First run (parent, about 1 minute, 3 screens):
1. Welcome in Marathi, with the language switch.
2. Parent lock: by default the phone's own screen lock (fingerprint, face, or the phone's PIN or pattern) opens parent mode, so there is nothing new to remember. One line offers "Use a separate GuruAI PIN" ("choose this if your child knows your phone's lock"), entered and confirmed on the same screen. If the phone has no screen lock, the app PIN is required.
3. Who is learning: nickname, picture, class, school medium. Then the phone goes to the child.

Everything else has a default and is changed in Settings: board (Maharashtra State Board), goals (from class), language style (from school medium), lessons per day (3), tutor (Shekru, hidden while it is the only one). Shared tutor lines and a starter lesson pack ship inside the app, so a first lesson never waits for a pack. The model starts downloading in the background when the app first opens, so it is usually done or close by the hand-over; the child's other packs follow once the class is known. Until the model is ready the child sees "Shekru is getting ready", which turns into the normal queue by itself when the download finishes. Mic permission is asked when the parent taps "hand the phone to your child", so the adult answers the Android dialog; if it was refused or skipped, the child sees "ask a grown-up" and parent mode offers the way back to the prompt (owner decision, 2026-11-20). Consents are off until the parent opts in: the goodbye screen after the first lesson carries a small "For parents: help improve Shekru?" strip that opens the consent screen through the parent gate; the same question shows on the next parent-mode open and as a row on the setup card until answered. A "Finish setting up" card on parent home lists the skipped steps.

Daily session (child):
1. The app opens in child mode with the child picker (faces and nicknames).
2. The child taps their face; today's queue shows one big start button, stars and a trail of what is left.
3. Shekru teaches; each answer is judged on the phone; progress is saved after every answer.
4. When the daily lesson goal is met (or the active-time cap is reached, in which case the current lesson finishes first), Shekru says goodbye.

Parent mode:
1. Long-press the lock icon for 2 s, then unlock with the phone's screen lock or the app PIN (whichever the parent chose).
2. Per child: Up next, Pending, Revision due, Completed (collapsed); assign a lesson (grouped list with a search box in M1); change goals, style, lessons per day (child profile, in Settings); a simple report showing lessons done against the daily goal.
3. "Parent helps" switch, per child: "मी उत्तरं तपासेन" (I'll check the answers). When on, the child's lessons show बरोबर / चूक / शांत (correct / wrong / silent) buttons during the answer turn only (after the chime, hidden while the tutor speaks), and the tapped button decides the answer; the mic and judge are off meanwhile. It stays on for the rest of that session and turns itself off at its end (goodbye, Stop, or the app being closed). Tapped answers update mastery and revision like Shekru's verdicts; the word-item practice-only rule (Language design 9) applies either way. Only a parent can turn it on (it sits behind the parent lock), because children press "correct" whatever they said.
4. The app returns to child mode after 2 minutes of inactivity or when it goes to the background.

## Edge Cases and Failure Modes

| Scenario | Expected behaviour |
|---|---|
| Model not downloaded yet, or the download fails | The child sees "Shekru is getting ready, ask a grown-up"; the lesson waits until a parent turns on the "parent helps" switch. The buttons never appear by themselves. The download resumes later. |
| Not enough storage | Before downloading, show the space needed next to the free space and offer fewer packs. When space is enough, the download starts without asking. |
| An assigned or next lesson's audio pack is not on the phone | The lesson can still be assigned; assigning starts its pack download. It stays out of today's queue until the pack is on the phone; parent home shows it as waiting for download. |
| Mic permission denied | Same "ask a grown-up" screen; parent mode offers a one-tap way back to the permission prompt, or the "parent helps" switch. |
| Phone too weak for the judge (over 1 s, or out of memory) | Detected at first use and shown on parent home; lessons need the "parent helps" switch on this phone; recorded in the session summary. |
| Child presses Home mid-lesson, or a call comes in | Pause; resume at the same answer. The report shows "left early, 6 of 10", not a failure. |
| Judge unsure, or a noisy room | "Didn't hear, say it again", never "wrong" (D-STT-unsure-not-wrong). Asked once; a second in a row moves on in teaching and counts as a missed try in the quiz, so a lesson always ends. |
| Child repeats the word the tutor just said | Not counted as an answer in that turn (the prompt word is excluded). |
| Item answers in two languages cannot be told apart | The build check flags it; no language-based reaction on that item. |
| An adult says the answer | Not detected in V1; a known limit noted in the pilot. |
| App PIN forgotten (M1) | If the phone has fingerprint or face unlock, it opens parent mode and the parent sets a new PIN. Otherwise reinstall, and mastery is lost; the PIN screen says so when the PIN is set. From M2, reset through the account. With the phone's screen lock as the gate, there is no app PIN to forget. |
| Phone's screen lock removed after setup | The system unlock prompt cannot run, so the next long-press asks the parent to set a GuruAI PIN. |
| Parent picks "Only this time" on the mic dialog | The grant ends when the app closes, so the next day the child sees "ask a grown-up"; the parent-home banner says to choose "While using the app". |
| Child keeps entering wrong app PINs | Waits of 30 s, then 5 min, then 15 min for each further 3 wrong; never a 24-hour lock, so lessons that need the "parent helps" switch are never blocked for a day. Fingerprint or face (not the phone's pattern, which the child may know) opens it at any time. |
| Two children on one phone | Separate profiles and mastery; no switching to a sibling's profile from child mode. |
| Consent withdrawn | Uploads stop immediately; uploaded clips are deleted on request. |
| Active-time cap reached mid-lesson | The current lesson finishes, then goodbye. |
| Child pauses for a long time mid-lesson | Pause time and long silences do not count toward the active-time cap. |

## Technical Constraints

- Minimum phone: Android 10, 3 GB RAM (to be confirmed by the cheap-phone test; 2 GB phones untested). The judge adds about 200 MB of memory.
- Answer to tutor reaction at most 1 s for 90% of answers on the minimum phone (0.2 s on the S25+).
- Play Store download under 100 MB including the first audio pack; the model and other packs download after install.
- Fully offline once downloads finish.
- Daily goal 3 lessons per child by default (1 to 5); active-time safety cap 30 minutes by default.
- Audio size: about 500 items × about 5 lines × 2 styles is roughly 100 to 150 MB per tutor; packs are split by learning path.
- Login: none in M1. Parent gate: Android's system unlock prompt (BiometricPrompt with device credential) by default; optional app PIN stored as a salted hash in Android encrypted storage, with lockout counters on the device and strong biometrics as the recovery route. M2: Google sign-in with email fallback; no SMS OTP (avoids India's DLT registration and SMS cost).
- Parent mode text in Marathi and English, switchable, Marathi by default.
- Privacy: Play Families policy; India's DPDP Act (parental consent for children's data). Uploads carry no names, only a random device id and the child's code. Tester recording and zip export exist only in test builds.
- Services: Cloudflare R2 and one Worker (M1); Supabase, Mumbai region (M2); Gemini TTS and an LLM, server side only, parent text only (M3). Catalogue audio is produced offline on the Mac.
- Gemini TTS's under-18 terms are a recorded, accepted risk (D-CHAR-gemini-tts-voice).

## Scope

### Phase 1 (Current Work): M1, pilot

- **Parent:** 3-screen onboarding (welcome, parent lock: phone's screen lock or a separate app PIN, who is learning; mic permission at the hand-over), background downloads, consent prompt after the first lesson, "Finish setting up" card; settings for everything defaulted (board, goals, style with sample, lessons per day, consents, more children); parent mode (long-press + phone lock or app PIN, lockout, auto-return; Up next, Pending, Revision due, Completed; assign from a grouped list with search; settings; simple report; Marathi/English switch).
- **Child:** child picker; today's queue with one start button, stars and a trail; lesson player with the language design, tutor variety (points 1 to 5) and captions with English in English letters; daily lesson goal with active-time cap; resume.
- **Learning:** mastery per item and language; spaced revision; class and skill paths with auto-enrolment.
- **Speech:** on-device judge with the child sound swaps; parent-only "parent helps" switch; first-use speed check.
- **Downloads and data:** model and packs from R2 (resume, checksum, Wi-Fi unless the parent allows mobile data); consented clip and session summary uploads through the upload function.
- **Content (parallel track):** pilot catalogue of about 15 to 20 lessons: the 8 existing lessons (reworked for 2 styles where they have words), the remaining व्यंजन, about 4 English word-and-meaning lessons, numbers 1 to 20 in Marathi and English; teacher review and listen-through for each.
- **Release:** the cheap-phone test; Play Store internal testing track for the pilot families.

### Phase 2 (Future): M2, accounts and public launch; M3, parent content

M2:
- Google sign-in (email fallback), Supabase (Mumbai), "claim this device" for pilot data, sync, PIN reset through the account.
- Child-only devices paired by QR code; reports on the parent's own phone.
- Placement check; school-year change prompt in June.
- Lesson library for the launch catalogue: search (also English words typed in Latin letters), filters by subject, class and status, "what school is teaching now" by textbook chapter (board mapping), and the child's progress on every lesson.
- Full launch catalogue (55 to 65 lessons); Play Families compliance; **public Play Store release**.

M3 (an update after launch):
- Customise catalogue lessons, word lists, mix from library, parent playlists.
- AI-assisted topics with parent approval and daily limits (at most 5 AI-drafted lessons a day, at most 15 items each).
- Server-side voicing in one style; the parent listens to and approves the lines; the server writes English words in Devanagari and tokenises answers for the judge.

### Out of Scope

As in Non-Goals.

### Future Possibilities

- Callbacks to earlier days: Shekru refers to what the child learned before ("काल आपण ए शिकलो, आठवतंय?"). Needs progress-dependent lines per item; considered for M1 and deferred to after the pilot (2026-11-19).
- Tai, Pati and Dino as selectable tutors. Tai and Pati have concept art and demo voice lines; Dino (owner request, 2026-11-19) has no design yet.
- The child's own photo as their picture (owner request, 2026-11-19): parent takes one with the camera or picks one from the gallery, then crops it to the round icon. The photo stays on the phone, is never uploaded and is left out of M2 sync. The gallery route uses the Android photo picker (no permission); the camera route adds a camera permission prompt. The fixed animal set stays as the default.
- After the pilot, if the data shows children tapping "correct" themselves: flag a likely child tap when "correct" is tapped while the mic heard no voice, and make letters mastered only by taps need one Shekru-judged correct answer at revision (2026-11-19, deferred from M1).
- A judge fine-tuned on consented pilot clips.
- Adult-voice detection.
- Paid plans.
- iOS.
- Families speaking other home languages, using the same bridge approach.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Judge evidence comes from one child | Accuracy across children unknown; false praise could exceed 5% | Pilot clips with consent, hand-labelled sample of about 20% of sessions; letter items count, word items practice only until their test |
| Whole English words and meaning answers never tested | Word lessons might not be checkable | Tap-mode test before word items count; practice-only until then |
| 2 to 3 GB phones untested | Judge too slow or app killed for memory | Cheap-phone test before M1 ships; "parent helps" fallback; speed check at first use |
| Language tags unreliable for Hindi/Marathi near-pairs | Wrong "say it in Marathi" prompts | Build-time ambiguity check; no language reaction on flagged items |
| Style level thresholds unknown | Children stuck at one style or moved too early | Change only between sessions; log every turn; tune offline on pilot logs |
| Tutor variety adds about 80 shared lines per tutor plus picture reactions, and new surprise animations | More voicing, listen-through and animation work; every future tutor (Tai, Pati, Dino) must match | Batch voicing; picture reactions only for pilot lessons in M1; surprise animations added to the shared tutor state contract once, so later tutors know what to provide |
| Audio volume and listen-through effort | Content becomes the bottleneck | Two styles, not three; shared short lines; batch voicing (D-CHAR-tts-batch-api) |
| Gemini TTS terms for under-18 use | Voice may need replacing | Recorded risk; line ids are tutor-neutral, so a new voice is a new pack |
| An adult answers for the child | Inflated results | Known limit; noted in pilot analysis |
| Forgotten app PIN in M1 | Pilot family loses progress | Phone's screen lock is the default gate; fingerprint or face recovers an app PIN; warning at PIN setup; M2 account reset |
| Children's data | Legal exposure under DPDP | Separate consents, no names in uploads, deletion on request, test-only recording features |

## Acceptance Criteria

M1, on the minimum phone (Android 10, 3 GB RAM):
- [ ] App icon to child picker in at most 3 s.
- [ ] End of the child's answer to Shekru's reaction in at most 1 s for 90% of answers.
- [ ] A tutor line starts within 300 ms of the previous step.
- [ ] Shekru animates at 30 frames a second or more; a 15-minute session ends without the app being killed for memory.
- [ ] Onboarding is 3 screens; a parent reaches the hand-over in about 1 minute. Every skipped setting has a default and appears on the "Finish setting up" card.
- [ ] Downloads resume after the network drops; a corrupted file fails its checksum and downloads again; the space needed is shown before downloading when free space is short; downloads wait for Wi-Fi unless the parent allows mobile data; the model download starts on first open.
- [ ] With airplane mode on after downloads, a full lesson runs with the judge.
- [ ] Killing the app mid-lesson and reopening resumes at the same answer.
- [ ] The बरोबर / चूक / शांत buttons appear only when a parent has turned on the "parent helps" switch, only during the answer turn, and the switch is off again after that session (goodbye, Stop or app closed) and survives a pause or call within it.
- [ ] With the model missing, the mic denied or a phone too weak and the switch off, the child sees "ask a grown-up" and no buttons.
- [ ] Every answer event records who decided it (`shekru` or `tap`); all pilot figures (accuracy, false praise, next-day revision) use only `shekru` answers.
- [ ] Revision due is always in today's queue and does not count toward the goal; a lesson counts toward the goal when it reaches its end.
- [ ] The day ends after the parent's lesson goal; the active-time cap ignores paused time and long silences and lets the current lesson finish.
- [ ] Every word item has a target language; the prompt word does not count as the answer; a miss goes ask, hint (Marathi bridge for words, picture word for letters), reveal; a right meaning in Marathi or Hindi on an English-target item gets the bridge step, not a wrong attempt; the style level changes only between sessions.
- [ ] The content build fails if an item's answers in different languages cannot be told apart and the item is not flagged.
- [ ] On a Marathi-target item a Hindi answer with the right meaning counts as correct, then on unflagged items the child is asked for the Marathi word, modelled if they do not know it. On an English-target item a Hindi or Marathi answer with the right meaning gets the bridge step and is not counted as correct.
- [ ] Word items never hold a child back until their judge test shows at least 80% of correct answers accepted and at most 5% false praise.
- [ ] Shared line pools hold at least 15 praise lines and 8 each of try again, didn't hear and quiz question; no shared line repeats within the last 5 turns of its pool.
- [ ] Praise comes from the pool that matches the moment (first try, after a hint, three in a row at 3, 6, 9, comeback, lesson finished all correct or with misses), with the stated precedence when two apply.
- [ ] "Didn't hear" is asked at most twice in a row per turn; every lesson can reach its end.
- [ ] Every pilot lesson item has at least one picture reaction line.
- [ ] Surprises appear at random, at most once per lesson, not in every lesson, never during a listening turn.
- [ ] The quiz order differs between two runs of the same lesson and never puts confusable letters back to back.
- [ ] The parent gate uses the phone's screen lock by default and the app PIN when chosen or when the phone has no screen lock; the app PIN is stored only as a salted hash; lockout (3 wrong: 30 s, then 5 min, then 15 min per further 3 wrong, never longer) and fingerprint or face recovery work; auto-return (2 min or background) works.
- [ ] Mic permission is requested on the parent's hand-over tap; a refusal leads to "ask a grown-up" on the child side and a way back to the prompt in parent mode.
- [ ] All parent-mode text switches between Marathi and English; Marathi is the default.
- [ ] Consents are off by default and first offered on the goodbye after the first lesson ("For parents" strip through the parent gate); nothing uploads without the matching consent; withdrawing consent stops uploads immediately; uploads carry only a random device id and the child's code.
- [ ] Tester recording and zip export are absent from release builds.

Pilot gate: the four targets under Goals.

M2: parent signs in with Google; pilot data is claimed into the account; a change made on the parent's phone reaches a paired child-only device; PIN reset works through the account; the app passes Play Families review and is published.

M3: a parent creates a word-list lesson, hears and approves every line, and assigns it; an AI-drafted topic cannot be assigned before approval; daily limits hold.

## Technical Implementation Strategy

Input for `/breakdown`. Bound by the decision records in `docs/decisions/`.

**Content schema** (`content/lessons/*.json`, `app/src/lesson/types.ts`):
- Item: add `target_lang`, `ask_direction`, per-answer language tags in `assessment` (each accepted answer becomes `{text, lang}` or a parallel tag list), an `ambiguous_lang` flag, and teach lines per style (`teach.mr_led`, `teach.en_led`) for word items.
- `app/scripts/build-content.mjs`: the ambiguity check (normalised text equality, or token edit distance of 2 or less, between answers of different languages in one item) and failing the build on unflagged collisions.
- Lessons gain an item type (letter or word) so styles apply only to word items.
- Every line gets a `caption` next to its voice script: English words in Latin letters for display, Devanagari spelling kept for voicing.

**Judge** (`app/src/asr/`):
- Return the matched answer's text and language, not only the item's card letter; keep duplicate texts with all their tags instead of keeping the first.
- Port the child sound swaps from `tools/stt_bench/providers/indicconformer.py` (`child_swaps`) to `judge.ts`, with Python goldens.
- Exclude the turn's prompt word from the candidates.
- First-use speed and memory check.

**Lesson engine** (`app/src/lesson/engine.ts`):
- Ask in the target language, Marathi bridge as the hint, reveal and repeat.
- Hindi follow-up turn (not scored).
- Practice-only verdict handling for word items until their gate passes (a content or config flag per item type).
- Pick the teach line by the child's style level.
- Tutor variety: line families with context tags (first try, after hint, streak, comeback, lesson end, picture reaction), selection that avoids the last 5 lines of a family, random surprise slots between items, quiz order shuffled per run with a confusable-pair rule, revision items interleaved.

**Tutor animation:** surprise moments need new animated states (for example sneeze, drop the nut, dance). They extend the shared tutor state contract in D-CHAR-swap-ready-tutor, so the change needs its own decision record.

**Local data** (SQLite, replacing `app/src/progress/storage.ts`'s position-only store), mirroring the blueprint entities so M2 can sync them:
- `child_profile` (nickname, picture, class, board, medium, goals, style level and limit, lessons per day, active-time cap, tutor), `parent_gate` (mode: device lock or app PIN, hash, salt, failed attempts, lockout until), `device` (random id, consents).
- `learning_path`, `path_unit`, `path_enrollment`, `assignment`, `lesson_position`.
- `event` (append-only: session start/end, answer with verdict, decided by (`shekru` or `tap`), matched text, language, scores summary, unsure flag, attempt number, style level), `item_mastery` (per child, item_key, language: state, streak, next revision date), derived from events.

**Screens** (Expo Router, `app/src/app/`): parent welcome and language switch, parent lock (choice, app PIN set, unlock), who is learning, "Finish setting up" card, child profile form (in Settings), consent prompt after the first lesson, downloads (in Settings, and a storage prompt), child picker, today's queue, "Shekru is getting ready" and "ask a grown-up" (model missing, mic denied, phone too weak), lesson (existing) with three in a row, surprise and lesson finished moments, goodbye with the "For parents" strip, parent home per child, settings, report, "parent helps" switch (parent home) and answer buttons (lesson). Wireframes come before the breakdown.

**Downloads:** a download manager (resumable, checksum, Wi-Fi rule, storage check) for the model and per-path audio packs; pack manifest with versions and checksums on R2.

**Upload function:** a Cloudflare Worker issuing short-lived R2 upload links per device; app-side queue that uploads after sessions, on Wi-Fi, only with consent.

**Pipeline:** `tools/gen_voice.py` to voice two styles per word item and the tutor variety lines (shared pools, praise by moment, picture reactions for pilot lessons); `tools/stt_bench` to run the word-item judge test.

**Decision records to write** in the issues that implement them: on-device judge only (cloud judge rejected); local-first with append-only events; language design (target language, bridge ladder, between-session style levels, ambiguity check, Hindi rule); word items practice-only until gated; tutor variety and the extended tutor state contract; "parent helps" buttons only behind a parent switch (rejected: buttons shown automatically when the judge cannot run, because children tap "correct"); parent gate: phone's screen lock by default with optional app PIN (rejected: app PIN only, one more PIN to remember; phone lock only, children often know the pattern), app PIN recovery by strong biometrics only, no 24-hour lock; Google sign-in for M2 instead of SMS OTP.

## Open Questions

- Does a 3 GB phone run the judge within 1 s, and does a 2 GB phone work at all?
- Exact numbers for the style level rule (first-try rate and number of sessions before moving up or down).
- Which English words and meanings go into the 4 pilot word lessons, and the number lessons' wording.
- Teacher reviewer: one freelance primary teacher, or a partner school or tuition centre.
- CBSE Marathi mapping: which books and chapters CBSE schools in Maharashtra use for Classes 1 and 2.
- Consent form wording for the pilot, and legal advice on DPDP and the Gemini TTS terms.
- Recruiting the 10 to 20 pilot families, including some with 3 GB phones.
- Paid plans: what triggers them and which features become paid (the catalogue stays free).
