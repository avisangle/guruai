// GURU-10: the mic source resolves to Heard (TDD 2.2): the judge verdict maps to {kind, by: 'shekru'}; a tap passes through.
import type { ClipJudge, Verdict } from '../asr/lessonJudge';
import lessonsJson from '../content/generated/lessons.json';
import type { AnswerSource } from '../lesson/answerSource';
import type { Heard, Lesson } from '../lesson/types';
import { createMicSource, type CaptureContext, type ClipSink, type Mic } from './capture';
import type { ClipMeta } from './clips';

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the cases below are written against it

const lesson = lessonJson as unknown as Lesson;
const [itemA, itemAa] = lesson.items;
const CTX: CaptureContext = { child: 'C1', age: 5, templateId: lesson.template_id };

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const speech = new Int16Array(16000 * 0.5).map((_, i) => (i % 2 ? 3000 : -3000)); // 0.5 s at -21 dBFS
const quiet = new Int16Array(16000 * 2); // 2 s of silence

// Fake microphone that logs calls; each take lands in a new file. talk() feeds it audio.
function fakeMic() {
  const log: string[] = [];
  let take = 0;
  let onPcm: ((pcm: Int16Array, rate: number) => void) | null = null;
  const mic: Mic = {
    prepare: async () => {
      take++;
      log.push('prepare');
    },
    record: async (cb) => {
      onPcm = cb;
      log.push('record');
    },
    stop: async () => {
      log.push('stop');
      onPcm = null;
      return { uri: `file:///cache/rec-${take}.wav`, durationMs: 2500 };
    },
  };
  const feed = (pcm: Int16Array) => onPcm?.(pcm, 16000);
  const talk = () => {
    feed(speech);
    feed(quiet); // 1.5 s quiet after speech ends the take
  };
  return { mic, log, talk, feed };
}

function fakeSink() {
  const saved: { uri: string; meta: ClipMeta }[] = [];
  const discarded: string[] = [];
  const sink: ClipSink = {
    save: (uri, meta) => {
      saved.push({ uri, meta });
    },
    discard: (uri) => {
      discarded.push(uri);
    },
  };
  return { sink, saved, discarded };
}

const judgement = (verdict: Verdict, extra: Partial<ClipJudge> = {}): ClipJudge =>
  ({ choice: 'अ', verdict, free: 'अ', note: '', ms: 120, ...extra });

function setup(opts: { context?: CaptureContext | null; verdict?: Verdict; judge?: () => Promise<ClipJudge>; tapped?: AnswerSource } = {}) {
  const { mic, log, talk, feed } = fakeMic();
  const { sink, saved, discarded } = fakeSink();
  const errors: unknown[] = [];
  const judged: string[] = [];
  const times = [new Date('2026-11-15T10:42:01.200Z'), new Date('2026-11-15T10:42:01.900Z'), new Date('2026-11-15T10:42:05Z')];
  let t = 0;
  const source = createMicSource(mic, sink, {
    startDelayMs: 750,
    judge: opts.judge ?? (async (uri) => {
      judged.push(uri);
      return judgement(opts.verdict ?? 'correct');
    }),
    context: () => (opts.context === undefined ? CTX : opts.context),
    tapped: () => opts.tapped ?? null,
    now: () => times[Math.min(t++, times.length - 1)],
    // the chime delay passes at once; the no-audio fallback (12 s) never fires
    wait: (ms) => (ms > 5000 ? new Promise<void>(() => {}) : Promise.resolve()),
    onError: (e) => errors.push(e),
  });
  return { source, log, talk, feed, saved, discarded, errors, judged };
}

// Resolves to the answer, or 'pending' if the promise has not settled.
const settle = async (p: Promise<Heard>) => {
  let out: Heard | 'pending' = 'pending';
  void p.then((a) => (out = a));
  await flush();
  return out;
};

test('records after the chime, stops when the child goes quiet, and the judge decides', async () => {
  const { source, log, talk, saved, discarded, judged } = setup({ verdict: 'wrong' });
  const answer = source.listen(itemA, 'teach');
  await flush();
  expect(log).toEqual(['prepare', 'record']);
  talk();
  expect(await answer).toMatchObject({ kind: 'wrong', by: 'shekru' });
  expect(log).toEqual(['prepare', 'record', 'stop']);
  expect(judged).toEqual(['file:///cache/rec-1.wav']);
  expect(discarded).toEqual([]);
  expect(saved).toHaveLength(1);
  expect(saved[0].meta).toMatchObject({
    id: 'c-20261115-104201-001',
    file: 'clips/c-20261115-104201-001.wav',
    child: 'C1',
    age: 5,
    item_id: 'a',
    kind: 'teach',
    label: 'wrong',
    label_by: 'judge',
    duration_ms: 2500,
    judge: { verdict: 'wrong' },
  });
});

test('recording mode off: the take is judged, then deleted', async () => {
  const { source, talk, saved, discarded } = setup({ context: null });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  talk();
  expect(await answer).toMatchObject({ kind: 'correct', by: 'shekru' });
  expect(saved).toEqual([]);
  expect(discarded).toEqual(['file:///cache/rec-1.wav']);
});

test('an unclear verdict is a silent answer', async () => {
  const { source, talk } = setup({ verdict: 'unclear' });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  talk();
  expect(await answer).toMatchObject({ kind: 'silent', by: 'shekru' });
});

test('a judge error counts as silent and is reported', async () => {
  const { source, talk, errors } = setup({ judge: async () => judgement('unclear', { error: 'model missing' }) });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  talk();
  expect(await answer).toMatchObject({ kind: 'silent', by: 'shekru' });
  expect(errors).toEqual(['model missing']);
});

test('nothing said: the mic stops after 4 s of quiet', async () => {
  const { source, log, feed, judged } = setup({ verdict: 'unclear' });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  feed(quiet);
  expect(await settle(answer)).toBe('pending'); // 2 s: still waiting for speech
  feed(quiet);
  feed(quiet);
  expect(await answer).toMatchObject({ kind: 'silent', by: 'shekru' });
  expect(log).toEqual(['prepare', 'record', 'stop']);
  expect(judged).toHaveLength(1);
});

test('a cancelled turn (pause, background) stops, discards, and never answers', async () => {
  const { source, log, saved, discarded, judged } = setup();
  const answer = source.listen(itemA, 'teach');
  await flush();
  source.cancel();
  expect(await settle(answer)).toBe('pending');
  expect(log).toEqual(['prepare', 'record', 'stop']);
  expect(judged).toEqual([]);
  expect(saved).toEqual([]);
  expect(discarded).toEqual(['file:///cache/rec-1.wav']);
});

test('cancel before the mic has started touches nothing', async () => {
  const { source, log, discarded } = setup();
  const answer = source.listen(itemA, 'quiz');
  source.cancel(); // same tick: prepare has not run yet
  expect(await settle(answer)).toBe('pending');
  expect(log).toEqual([]);
  expect(discarded).toEqual([]);
});

test('cancel while the judge is thinking discards the take', async () => {
  let release = (_j: ClipJudge) => {};
  const { source, talk, saved, discarded } = setup({ judge: () => new Promise((r) => (release = r)) });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  talk();
  await flush();
  source.cancel();
  release(judgement('correct'));
  expect(await settle(answer)).toBe('pending');
  expect(saved).toEqual([]);
  expect(discarded).toEqual(['file:///cache/rec-1.wav']);
});

test('turns run one after another and ids count up within the same second', async () => {
  const { source, talk, saved } = setup();
  const first = source.listen(itemA, 'teach');
  await flush();
  talk();
  await first;
  const second = source.listen(itemAa, 'quiz');
  await flush();
  talk();
  await second;
  expect(saved.map((s) => [s.meta.id, s.meta.item_id, s.meta.kind])).toEqual([
    ['c-20261115-104201-001', 'a', 'teach'],
    ['c-20261115-104201-002', 'aa', 'quiz'],
  ]);
});

test('a mic failure is reported and the lesson gets a silent answer', async () => {
  const errors: unknown[] = [];
  const saved: unknown[] = [];
  const source = createMicSource(
    { prepare: () => Promise.reject(new Error('no permission')), record: async () => {}, stop: async () => ({ uri: null, durationMs: 0 }) },
    { save: (_uri, meta) => { saved.push(meta); }, discard: () => {} },
    { startDelayMs: 0, judge: async () => judgement('correct'), context: () => CTX, onError: (e) => errors.push(e) },
  );
  expect(await source.listen(itemA, 'teach')).toMatchObject({ kind: 'silent', by: 'shekru' });
  expect(String(errors[0])).toContain('no permission');
  expect(saved).toEqual([]);
});

// Tester buttons without React.
function fakeTester() {
  let pending: ((a: Heard) => void) | null = null;
  const source: AnswerSource = {
    listen: () => new Promise((r) => (pending = r)),
    cancel: () => (pending = null),
  };
  return { source, give: (a: Heard) => pending?.(a) };
}

test('tap mode: the tester button ends the take and is the answer; the judge scores alongside', async () => {
  const tester = fakeTester();
  const { source, log, feed, saved, judged } = setup({ tapped: tester.source, verdict: 'wrong' });
  const answer = source.listen(itemA, 'quiz');
  await flush();
  feed(quiet);
  feed(quiet);
  feed(quiet); // silence does not end a tap-mode take
  expect(await settle(answer)).toBe('pending');
  tester.give({ kind: 'correct', by: 'tap' });
  expect(await answer).toEqual({ kind: 'correct', by: 'tap' });
  await flush();
  expect(log).toEqual(['prepare', 'record', 'stop']);
  expect(judged).toHaveLength(1);
  expect(saved[0].meta).toMatchObject({ label: 'correct', judge: { verdict: 'wrong' } });
  expect(saved[0].meta.label_by).toBeUndefined();
});
