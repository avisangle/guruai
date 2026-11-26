// GURU-47: frameGate must work when the UI runtime evaluates its worklet code string.
//
// Pinned here (output_for_dependents: none, so no separate contract test):
// - frameGate(state, dt[, fps]) keeps both call forms; the default rate (SHEKRU_FPS = 20) is
//   resolved inside the body, never in the parameter list.
//
// Why this exists: the worklets plugin unpacks the closure inside the function body, so a
// module-scope name in a default parameter is a global lookup on the UI runtime and throws
// ReferenceError. Jest runs the JS-side function (where the name is a factory parameter), so
// frameGate.test.ts cannot see it. This test runs __initData.code with only its closure.
//
// Real transform: babel-preset-expo (applies react-native-worklets/plugin), as Metro and
// jest-expo do; the app has no babel.config.js. No schema or endpoint is involved.
import { transformSync } from '@babel/core';
import * as path from 'path';

type Gate = (this: { __closure: unknown[] }, state: { sinceStep: number }, dt: number, fps?: number) => number | null;

const FILE = path.join(__dirname, 'frameGate.ts');

function loadWorklet() {
  const preset = require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] });
  const out = transformSync(require('fs').readFileSync(FILE, 'utf8'), {
    filename: FILE,
    presets: [preset],
    babelrc: false,
    configFile: false,
  });
  const mod = { exports: {} as Record<string, unknown> };
  new Function('exports', 'require', 'module', out!.code!)(mod.exports, require, mod);
  const frameGate = mod.exports.frameGate as { __initData?: { code: string }; __closure: unknown[] };
  return frameGate;
}

describe('frameGate as the UI runtime runs it (GURU-47)', () => {
  const frameGate = loadWorklet();

  // Indirect eval runs in global scope, where SHEKRU_FPS is undefined, like the UI runtime.
  const run = (state: { sinceStep: number }, dt: number, fps?: number) => {
    const fn = (0, eval)((frameGate.__initData as { code: string }).code) as Gate;
    return fn.call({ __closure: frameGate.__closure }, state, dt, ...(fps === undefined ? [] : [fps]));
  };

  it('is a worklet: the transform attached __initData (guards against a vacuous pass)', () => {
    expect(frameGate.__initData).toBeDefined();
    expect(typeof frameGate.__initData!.code).toBe('string');
    expect(Array.isArray(frameGate.__closure)).toBe(true);
  });

  it('runs without a ReferenceError when fps is omitted', () => {
    expect(() => run({ sinceStep: 0 }, 0.06)).not.toThrow();
  });

  it('with no fps, steps at the default 20 Hz: 0.06 s steps, 0.01 s waits, 5 s is clamped to 0.1', () => {
    const a = { sinceStep: 0 };
    expect(run(a, 0.06)).toBe(0.06);
    expect(a.sinceStep).toBe(0);
    const b = { sinceStep: 0 };
    expect(run(b, 0.01)).toBeNull();
    expect(b.sinceStep).toBe(0.01);
    expect(run({ sinceStep: 0 }, 5)).toBe(0.1);
  });

  it('an explicit fps still wins: fps = 60 steps at 0.02 s', () => {
    expect(run({ sinceStep: 0 }, 0.02, 60)).toBe(0.02);
  });
});
