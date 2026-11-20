// GURU-11: the engine (GURU-19) run on the shipped lessons and pools never speaks a line
// with no text. A missing id gives `undefined` text, which useLinePlayer cannot play.
import lessonsJson from '../content/generated/lessons.json';
import promptsJson from '../content/generated/prompts.json';
import { createLesson } from './engine';
import type { Heard, Lesson, Prompts, Step } from './types';

const prompts = promptsJson as Prompts;
const lessons = lessonsJson as unknown as Lesson[];
const KINDS = ['correct', 'wrong', 'silent'] as const;

// Deterministic rng in [0, 1).
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plays a lesson to the end with random answers; returns every step it produced.
function run(lesson: Lesson, seed: number): Step[] {
  const pick = seeded(seed * 7919);
  const engine = createLesson(lesson, prompts, { rng: seeded(seed) });
  const steps: Step[] = [];
  for (let n = 0; n < 2000; n++) {
    const step = engine.next();
    steps.push(step);
    if (step.type === 'done') return steps;
    if (step.type === 'listen') engine.answer({ kind: KINDS[Math.floor(pick() * KINDS.length)], by: 'shekru' } as Heard);
  }
  throw new Error(`${lesson.template_id} did not finish`);
}

describe('shipped lessons and pools', () => {
  it.each(lessons.map((l) => [l.template_id, l] as const))('%s: every spoken line has text', (_, lesson) => {
    const missing = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      for (const step of run(lesson, seed)) {
        // a missing id leaves `line` undefined too, so label by state
        if ((step.type === 'say' || (step.type === 'surprise' && step.state !== 'celebrate')) && !step.text) {
          missing.add(`${step.type} ${step.state}: ${step.line ?? 'no line id'}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
