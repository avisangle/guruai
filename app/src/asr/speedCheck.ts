// First-use judge speed and memory check (PRD Edge Cases: a phone too weak for the judge; Technical
// Constraints: reaction within 1 s for 90% of answers). Measured once per phone, stored on the device row.
import { Asset } from 'expo-asset';

import lessonsJson from '../content/generated/lessons.json';
import type { Db } from '../data/db';
import { getDevice, setJudgeCheck } from '../data/device';
import { liveDb } from '../data/liveDb';
import type { JudgeCheck } from '../data/types';
import type { Lesson } from '../lesson/types';
import { judgeClip } from './lessonJudge';
import { modelAvailable } from './model';

export type JudgeReadiness = 'ready' | 'missing' | 'slow' | 'oom';

export type SpeedCheckDeps = {
  db: Db;
  modelAvailable: () => boolean;
  judge: () => Promise<{ error?: string }>; // one judge run on the speed-check clip
  now: () => number; // ms clock
};

const RUNS = 5;
export const SLOW_P90_MS = 1000;
// What the native load/run rejections carry on out-of-memory: Java's OutOfMemoryError, ONNX Runtime's allocator.
const OOM = /OutOfMemory|Failed to allocate|bad_alloc|out of memory/i;

/** The clip is Shekru saying "बी फॉर बॉल", judged as a teach listen against that lesson's answers. */
async function liveJudge() {
  const asset = Asset.fromModule(require('../../assets/audio/speedcheck.wav'));
  await asset.downloadAsync(); // expo-asset caches: a no-op after the first run
  const lesson = (lessonsJson as unknown as Lesson[]).find((l) => l.template_id === 'tpl_kg_en_letters_1')!;
  const item = lesson.items.find((i) => i.id === 'b')!;
  const listen = { type: 'listen', item, kind: 'teach', showAnchor: false, prompt: '' } as const;
  return judgeClip(asset.localUri ?? asset.uri, listen, lesson.items);
}

const live = (): SpeedCheckDeps => ({ db: liveDb(), modelAvailable, judge: liveJudge, now: Date.now });

const READINESS: Record<JudgeCheck, JudgeReadiness> = { ok: 'ready', slow: 'slow', oom: 'oom' };

/** missing without the model; else the stored check, and ready while unchecked. */
export function judgeReadiness(deps: Pick<SpeedCheckDeps, 'db' | 'modelAvailable'> = live()): JudgeReadiness {
  if (!deps.modelAvailable()) return 'missing';
  const check = getDevice(deps.db).judge_check;
  return check ? READINESS[check] : 'ready';
}

/**
 * One untimed warm-up (it includes the model load), then RUNS timed runs. Out of memory stores oom; any
 * other failure stores nothing, so the next start measures again (D-GURU-15-speed-check-failures).
 */
async function measure(deps: SpeedCheckDeps): Promise<JudgeReadiness> {
  if (!deps.modelAvailable() || getDevice(deps.db).judge_check) return judgeReadiness(deps);
  const times: number[] = [];
  for (let i = 0; i < 1 + RUNS; i++) {
    const t0 = deps.now();
    const { error } = await deps.judge();
    if (error) {
      if (!OOM.test(error)) return 'ready'; // unchecked
      setJudgeCheck(deps.db, 'oom', null);
      return 'oom';
    }
    times.push(deps.now() - t0);
  }
  const p90 = Math.max(...times.slice(1)); // nearest-rank p90 of 5 runs is the slowest; run 0 is the warm-up
  const check = p90 > SLOW_P90_MS ? 'slow' : 'ok';
  setJudgeCheck(deps.db, check, p90);
  return READINESS[check];
}

// Screens may ask at the same time; one measurement at a time, or the runs would time each other.
let running: Promise<JudgeReadiness> | null = null;

/** Measures the judge once per phone: when the model is there and no result is stored. */
export function runSpeedCheck(deps: SpeedCheckDeps = live()): Promise<JudgeReadiness> {
  running ??= measure(deps).finally(() => {
    running = null;
  });
  return running;
}

/** Settings: forgets the stored result and measures again. */
export async function rerunSpeedCheck(deps: SpeedCheckDeps = live()): Promise<JudgeReadiness> {
  await running;
  setJudgeCheck(deps.db, null, null);
  return runSpeedCheck(deps);
}
