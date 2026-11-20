// GURU-15: first-use judge speed and memory check (PRD Edge Cases: phone too weak for the judge,
// over 1 s or out of memory; Technical Constraints: reaction within 1 s for 90% of answers).
//
// Real schema (app/src/data/migrations.ts, migration 1, GURU-4):
//   device(id, device_id, parent_lang, allow_mobile_data, consent_clips, consent_summaries,
//          consent_answered_at, judge_check TEXT ('ok'|'slow'|'oom'|null), judge_p90_ms INTEGER,
//          mic_last_granted_at, created_at, updated_at)   one row, created by getDevice()
//
// Contract pinned here (speedCheck.ts):
//   type JudgeReadiness = 'ready' | 'missing' | 'slow' | 'oom'
//   type SpeedCheckDeps = {
//     db: Db;
//     modelAvailable: () => boolean;
//     judge: () => Promise<{ error?: string }>;  // one judgeClip run on assets/audio/speedcheck.wav
//     now: () => number;                         // ms clock; each run is timed around judge()
//   }
//   runSpeedCheck(deps?): Promise<JudgeReadiness>    runs only when the model is there and judge_check is null
//   rerunSpeedCheck(deps?): Promise<JudgeReadiness>  clears judge_check and judge_p90_ms, then runs
//   judgeReadiness(deps?: { db; modelAvailable }): JudgeReadiness
//   Every deps argument is optional; omitted, the live ones are used (liveDb, model.ts, judgeClip).
import * as fs from 'fs';
import * as path from 'path';

import type { Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createTestDb } from '../data/testDb';
import { isSilent } from './judge';
import { judgeReadiness, rerunSpeedCheck, runSpeedCheck } from './speedCheck';
import { parseWav } from './wav';

// Native-free: device ids, the live database, the model file and the real judge are all stubbed.
jest.mock('expo-crypto', () => {
  let calls = 0;
  return { randomUUID: jest.fn(() => `uuid-${++calls}`) };
});
jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
jest.mock('expo-asset', () => ({
  Asset: { fromModule: jest.fn(() => ({ downloadAsync: jest.fn(async () => undefined), localUri: 'file:///speedcheck.wav', uri: 'file:///speedcheck.wav' })) },
}));
jest.mock('../../modules/guru-asr', () => ({ __esModule: true, default: null }));
jest.mock('./lessonJudge', () => ({ judgeClip: jest.fn() }));
jest.mock('./model', () => ({ modelAvailable: jest.fn(() => false), ensureModel: jest.fn() }));
jest.mock('../data/liveDb', () => {
  const { createTestDb: create } = jest.requireActual('../data/testDb');
  const { migrate: up } = jest.requireActual('../data/migrations');
  const db = create();
  up(db);
  return { liveDb: () => db };
});

const READINESS = ['ready', 'missing', 'slow', 'oom'];

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

type Run = { ms: number; error?: string };

/**
 * A scripted judge on a fake clock: run i advances the clock by runs[i].ms and reports runs[i].error.
 * The first entry is the warm-up run.
 */
function scripted(db: Db, runs: Run[], modelAvailable = true) {
  let t = 1_000_000;
  let i = 0;
  const judge = jest.fn(async () => {
    const run = runs[Math.min(i++, runs.length - 1)];
    t += run.ms;
    return run.error ? { error: run.error } : {};
  });
  return { db, modelAvailable: () => modelAvailable, judge, now: () => t };
}

const stored = (db: Db) => {
  const d = getDevice(db);
  return { judge_check: d.judge_check, judge_p90_ms: d.judge_p90_ms };
};

const runs = (warmup: number, timed: number[]): Run[] => [{ ms: warmup }, ...timed.map((ms) => ({ ms }))];

// Error texts as judgeClip reports them: String(e) of the rejected native call.
const LOAD_OOM =
  "Error: Call to function 'GuruAsr.load' has been rejected.\n→ Caused by: java.lang.OutOfMemoryError: Failed to allocate a 137000000 byte allocation with 25165824 free bytes";
const RUN_OOM =
  "Error: Call to function 'GuruAsr.run' has been rejected.\n→ Caused by: ai.onnxruntime.OrtException: Error code - ORT_RUNTIME_EXCEPTION - message: Failed to allocate memory for requested buffer of size 52428800";
const NOT_OOM = "Error: Call to function 'GuruAsr.run' has been rejected.\n→ Caused by: java.lang.IllegalStateException: model not loaded";

describe('GURU-15 judge speed and memory check', () => {
  test('a fast phone: one untimed warm-up then 5 timed runs; stores ok with the p90 and reads as ready', async () => {
    const db = freshDb();
    const deps = scripted(db, runs(4000, [380, 400, 390, 400, 400])); // the warm-up includes the model load

    await expect(runSpeedCheck(deps)).resolves.toBe('ready');

    expect(deps.judge).toHaveBeenCalledTimes(6);
    expect(stored(db)).toEqual({ judge_check: 'ok', judge_p90_ms: 400 });
    expect(judgeReadiness(deps)).toBe('ready');
  });

  test('p90 over 1,000 ms stores slow (one slow run in five is enough); exactly 1,000 ms is still ok', async () => {
    const slowDb = freshDb();
    const slow = scripted(slowDb, runs(300, [300, 300, 300, 300, 1500]));
    await expect(runSpeedCheck(slow)).resolves.toBe('slow');
    expect(stored(slowDb).judge_check).toBe('slow');
    expect(stored(slowDb).judge_p90_ms).toBeGreaterThan(1000);
    expect(judgeReadiness(slow)).toBe('slow');

    const edgeDb = freshDb();
    const edge = scripted(edgeDb, runs(5000, [1000, 1000, 1000, 1000, 1000]));
    await expect(runSpeedCheck(edge)).resolves.toBe('ready');
    expect(stored(edgeDb)).toEqual({ judge_check: 'ok', judge_p90_ms: 1000 });
  });

  test('an out-of-memory failure in the load (warm-up) or in a timed run stores oom; another failure does not', async () => {
    const loadDb = freshDb();
    const load = scripted(loadDb, [{ ms: 200, error: LOAD_OOM }, { ms: 300 }, { ms: 300 }, { ms: 300 }, { ms: 300 }, { ms: 300 }]);
    await expect(runSpeedCheck(load)).resolves.toBe('oom');
    expect(stored(loadDb).judge_check).toBe('oom');
    expect(judgeReadiness(load)).toBe('oom');

    const runDb = freshDb();
    const run = scripted(runDb, [{ ms: 3000 }, { ms: 300 }, { ms: 300 }, { ms: 300, error: RUN_OOM }, { ms: 300 }, { ms: 300 }]);
    await expect(runSpeedCheck(run)).resolves.toBe('oom');
    expect(stored(runDb).judge_check).toBe('oom');

    const otherDb = freshDb();
    const other = scripted(otherDb, [{ ms: 3000 }, { ms: 300 }, { ms: 300, error: NOT_OOM }, { ms: 300 }, { ms: 300 }, { ms: 300 }]);
    await runSpeedCheck(other);
    expect(stored(otherDb).judge_check).not.toBe('oom');
  });

  test('runs only once: no model means missing and no run; a stored result is never re-measured', async () => {
    const db = freshDb();
    const noModel = scripted(db, runs(300, [300, 300, 300, 300, 300]), false);
    await expect(runSpeedCheck(noModel)).resolves.toBe('missing');
    expect(noModel.judge).not.toHaveBeenCalled();
    expect(stored(db).judge_check).toBeNull();
    expect(judgeReadiness(noModel)).toBe('missing');

    // The model arrives but the check has not run yet: nothing known against the phone.
    expect(judgeReadiness({ db, modelAvailable: () => true })).toBe('ready');

    const first = scripted(db, runs(300, [300, 300, 300, 300, 1500]));
    await expect(runSpeedCheck(first)).resolves.toBe('slow');

    const again = scripted(db, runs(300, [300, 300, 300, 300, 300]));
    await expect(runSpeedCheck(again)).resolves.toBe('slow');
    expect(again.judge).not.toHaveBeenCalled();
    expect(stored(db).judge_check).toBe('slow');

    // A stored result still reads as missing once the model file is gone.
    expect(judgeReadiness({ db, modelAvailable: () => false })).toBe('missing');
  });

  test('rerunSpeedCheck (Settings) clears the stored result and measures again', async () => {
    const db = freshDb();
    await runSpeedCheck(scripted(db, runs(300, [1200, 1200, 1200, 1200, 1200])));
    expect(stored(db).judge_check).toBe('slow');

    const fast = scripted(db, runs(300, [200, 200, 200, 200, 200]));
    await expect(rerunSpeedCheck(fast)).resolves.toBe('ready');
    expect(fast.judge).toHaveBeenCalledTimes(6);
    expect(stored(db)).toEqual({ judge_check: 'ok', judge_p90_ms: 200 });

    // Without the model the rerun clears the old result and cannot measure a new one.
    const gone = scripted(db, runs(300, [200, 200, 200, 200, 200]), false);
    await expect(rerunSpeedCheck(gone)).resolves.toBe('missing');
    expect(gone.judge).not.toHaveBeenCalled();
    expect(stored(db)).toEqual({ judge_check: null, judge_p90_ms: null });
  });

  test('the speed-check clip ships as a 16 kHz mono 16-bit WAV with speech in it, answer-length', () => {
    const file = path.join(__dirname, '../../assets/audio/speedcheck.wav');
    expect(fs.existsSync(file)).toBe(true);
    const { samples } = parseWav(new Uint8Array(fs.readFileSync(file)));
    const seconds = samples.length / 16000;
    expect(seconds).toBeGreaterThanOrEqual(0.5);
    expect(seconds).toBeLessThanOrEqual(4);
    expect(isSilent(samples)).toBe(false); // a silent clip would skip the model and time nothing
  });
});

describe('GURU-15 contract for GURU-29 (readiness screens) and GURU-30 (parent home)', () => {
  test('exports runSpeedCheck, rerunSpeedCheck and judgeReadiness returning ready | missing | slow | oom', async () => {
    expect(typeof runSpeedCheck).toBe('function');
    expect(typeof rerunSpeedCheck).toBe('function');
    expect(typeof judgeReadiness).toBe('function');

    const deps = scripted(freshDb(), runs(300, [300, 300, 300, 300, 300]));
    expect(READINESS).toContain(judgeReadiness(deps));
    const run = runSpeedCheck(deps);
    expect(run).toBeInstanceOf(Promise);
    expect(READINESS).toContain(await run);
    expect(READINESS).toContain(await rerunSpeedCheck(deps));

    // Screens call them with no arguments: the live database and model (mocked here: no model file).
    expect(judgeReadiness()).toBe('missing');
    await expect(runSpeedCheck()).resolves.toBe('missing');
  });
});
