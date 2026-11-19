import { createEndpointer, END_SILENCE_MS, MAX_MS, NO_SPEECH_MS } from './endpoint';

const RATE = 16000;
const LOUD = 0.1; // -20 dBFS
const QUIET = 0.001; // -60 dBFS

// ms of a constant-level tone as int16
const tone = (ms: number, level: number) => {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((i % 2 ? level : -level) * 32767);
  return out;
};

const frames = (ms: number) => Math.ceil(ms / 30) * 30; // the endpointer decides per 30 ms frame

// Feeds 30 ms chunks until the endpointer stops; returns why and when.
function run(...parts: [number, number][]) {
  const ep = createEndpointer(RATE);
  let t = 0;
  for (const [ms, level] of parts) {
    for (let done = 0; done < ms; done += 30) {
      t += 30;
      const why = ep.push(tone(30, level));
      if (why) return { why, t };
    }
  }
  return { why: null, t };
}

test('stops 1.5 s after the child stops talking', () => {
  expect(run([600, QUIET], [900, LOUD], [5000, QUIET])).toEqual({ why: 'end', t: 600 + 900 + frames(END_SILENCE_MS) });
});

test('a pause shorter than 1.5 s between letter and word does not end the answer', () => {
  expect(run([420, LOUD], [1200, QUIET], [600, LOUD], [5000, QUIET]).t).toBe(420 + 1200 + 600 + frames(END_SILENCE_MS));
});

test('nothing said: stops after 4 s', () => {
  expect(run([10020, QUIET])).toEqual({ why: 'nospeech', t: frames(NO_SPEECH_MS) });
});

test('a click is not speech', () => {
  expect(run([60, LOUD], [10020, QUIET])).toEqual({ why: 'nospeech', t: frames(NO_SPEECH_MS) });
});

test('speech that never stops is cut at 10 s', () => {
  expect(run([20010, LOUD])).toEqual({ why: 'max', t: frames(MAX_MS) });
});

test('chunk size does not matter', () => {
  const ep = createEndpointer(RATE);
  const audio = [tone(500, LOUD), tone(3000, QUIET)];
  let why = null;
  for (const part of audio) for (let i = 0; i < part.length && !why; i += 1234) why = ep.push(part.subarray(i, i + 1234));
  expect(why).toBe('end');
});
