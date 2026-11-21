// Listening turns from the microphone. After the chime the mic records until the
// endpointer says the answer is over (or nothing was said), the on-device judge scores
// the take, and its Heard is the child's answer. In recording mode the take is kept as
// a clip labelled by the judge; otherwise keep() may take it for upload (GURU-38), else it is deleted.
// Tap mode (tester switch): the tester's button ends the take and is the answer; the judge
// still scores the clip, for comparison. Mic, storage and judge are injected for tests.
import { createEndpointer, MAX_MS, type EndReason, type Endpointer } from '../asr/endpoint';
import type { ClipJudge } from '../asr/lessonJudge';
import type { AnswerSource } from '../lesson/answerSource';
import type { Answer, Heard, Listen } from '../lesson/types';
import { clipMeta, clipNamer, type ClipMeta } from './clips';

export type Mic = {
  prepare(): Promise<void>; // opens the microphone; nothing is captured yet
  // Starts capturing to a file (after the chime); onPcm gets the live int16 samples.
  record(onPcm: (pcm: Int16Array, sampleRate: number) => void): Promise<void>;
  // Ends the take. uri is where the audio landed (also after a failed take).
  stop(): Promise<{ uri: string | null; durationMs: number }>;
};

export type ClipSink = {
  save(audioUri: string, meta: ClipMeta): Promise<void> | void;
  discard(audioUri: string): void;
};

// Who is being recorded; null when recording mode is off.
export type CaptureContext = { child: string; age: number | null; templateId: string };

const SILENT: Heard = { kind: 'silent', by: 'shekru' };
// Clip label: a right meaning is one of the item's accepted answers, so the bench scores it correct.
const label = (heard: Heard): Answer => (heard.kind === 'meaning' ? 'correct' : heard.kind);

export function createMicSource(mic: Mic, sink: ClipSink, opts: {
  startDelayMs: number; // let the chime finish before the mic opens
  judge(uri: string, listen: Listen): Promise<ClipJudge>; // the prompt's words are not candidates
  context(): CaptureContext | null;
  // Outside recording and tap mode: takes the take for upload and returns its name, or null to discard it.
  keep?: (audioUri: string, recordedAt: Date) => string | null;
  tapped?: () => AnswerSource | null; // the tester's buttons, in tap mode
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
  onJudged?: (judge: ClipJudge, answer: Answer, saved: ClipMeta | null, tapped: boolean) => void;
  onError?: (error: unknown) => void;
}): AnswerSource {
  const now = opts.now ?? (() => new Date());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let turn = 0; // bumping it cancels the running turn
  let endNow: (() => void) | null = null;
  // One recorder: turns run strictly one after another.
  let chain: Promise<void> = Promise.resolve();
  const nextClipId = clipNamer();

  const discard = (uri: string | null) => {
    if (uri) sink.discard(uri);
  };
  // A storage failure must not cost the child's answer.
  const kept = (uri: string, recordedAt: Date) => {
    try {
      return opts.keep?.(uri, recordedAt) ?? null;
    } catch (e) {
      opts.onError?.(e);
      return null;
    }
  };

  return {
    listen(step) {
      const { item, kind } = step;
      const mine = ++turn;
      const live = () => mine === turn;
      const asked = Date.now();
      return new Promise<Heard>((resolve) => {
        chain = chain.then(async () => {
          if (!live()) return;
          let open = false;
          try {
            await mic.prepare();
            open = true;
            await wait(Math.max(0, opts.startDelayMs - (Date.now() - asked)));
            if (!live()) return;
            let ep: Endpointer | null = null;
            const tester = opts.tapped?.() ?? null;
            let tapped: Heard | null = null;
            const ended = new Promise<EndReason | 'cancel'>((r) => {
              endNow = () => r('cancel');
              void mic.record((pcm, rate) => {
                if (tester) return;
                ep ??= createEndpointer(rate);
                const why = ep.push(pcm);
                if (why) r(why);
              }).catch((e) => {
                opts.onError?.(e);
                r('end');
              });
              if (tester) {
                void tester.listen(step).then((a) => {
                  tapped = a;
                  r('end');
                });
              } else {
                void wait(MAX_MS + 2000).then(() => r('max')); // no samples arriving: stop anyway
              }
            });
            const started = now();
            await ended;
            endNow = null;
            const take = await mic.stop();
            open = false;
            if (!live()) return discard(take.uri);
            if (!take.uri) return resolve(tapped ?? SILENT); // nothing captured
            if (tapped) resolve(tapped); // the lesson goes on while the judge scores the clip

            const judge = await opts.judge(take.uri, step);
            if (!tapped && !live()) return discard(take.uri);
            if (judge.error) opts.onError?.(judge.error);
            const answer = tapped ?? (judge.error ? SILENT : judge.heard);
            const clipLabel = label(answer);
            const ctx = opts.context();
            let meta: ClipMeta | null = null;
            if (ctx) {
              meta = {
                ...clipMeta({
                  id: nextClipId(started),
                  ext: take.uri.split('.').pop() || 'wav',
                  child: ctx.child,
                  age: ctx.age,
                  templateId: ctx.templateId,
                  item,
                  kind,
                  label: clipLabel,
                  labelBy: tapped ? undefined : 'judge',
                  matched: judge.heard,
                  recordedAt: started,
                  durationMs: take.durationMs || now().getTime() - started.getTime(),
                }),
                judge,
              };
              await sink.save(take.uri, meta);
            } else if (tapped || !kept(take.uri, started)) {
              // A tapped answer has already gone on, so its take could not be named in it.
              discard(take.uri);
            }
            opts.onJudged?.(judge, clipLabel, meta, tapped != null);
            resolve(answer);
          } catch (e) {
            opts.onError?.(e);
            if (open) {
              open = false;
              discard((await mic.stop().catch(() => ({ uri: null }))).uri);
            }
            if (live()) resolve(SILENT); // the lesson goes on: a broken mic counts as no answer
          } finally {
            if (open && !live()) discard((await mic.stop().catch(() => ({ uri: null }))).uri);
          }
        });
      });
    },
    cancel() {
      turn++;
      endNow?.();
      endNow = null;
    },
  };
}
