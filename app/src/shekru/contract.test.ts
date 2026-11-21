/// <reference types="node" />
// GURU-7: four surprise states (sneeze, dropnut, dance, celebrate) and the 14-state tutor contract.
//
// Real data shapes this file relies on (read, not assumed):
// - shekru.anim.json: { initial, groups: { upper }, fx: { asset, parts }, states: { <name>: { duration, loop,
//   next?, tracks, mouth?, mix?, fx?: { tracks } } } }. One-shots today: hello, correct, bye (loop false, next 'idle').
// - Track part ids are shekru.rig.json `parts` keys or anim `groups` keys; state `fx.tracks` ids are anim `fx.parts` keys.
// - app/src/shekru/generated/shekru.anim.json is JSON.stringify of design/characters/shekru/anim/shekru.anim.json.
// - app/src/shekru/generated/visemes.json maps voice line -> { text, duration, events }; a state speaks only
//   through a line (demo.tsx LINE_OF), so a silent state has no clip and its demo button plays no audio.
// - build-anim.mjs runs validate() (exit 1 on error), then writes ../shekru.anim.json and copies ../../svg files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import generatedAnim from './generated/shekru.anim.json';
import generatedVisemes from './generated/visemes.json';
import Demo from '../app/demo';
import { TUTOR_STATES, type TutorState } from './contract';

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const DESIGN = path.join(ROOT, 'design/characters/shekru');

const SURPRISES = ['sneeze', 'dropnut', 'dance', 'celebrate'] as const;
const EXISTING = ['idle', 'hello', 'talking', 'listening', 'thinking', 'correct', 'tryagain', 'hint', 'nohear', 'bye'];

type StateDef = {
  duration: number;
  loop?: boolean;
  next?: string;
  tracks: Record<string, unknown>;
  fx?: { tracks: Record<string, unknown> };
};
type Anim = { groups: Record<string, unknown>; fx: { parts: Record<string, unknown> }; states: Record<string, StateDef> };

const ANIM = generatedAnim as unknown as Anim;
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

function surprise(name: string): StateDef {
  const s = ANIM.states[name];
  expect(s).toBeDefined();
  return s;
}

// Demo route: the rig, the SVG and audio are native, so they are replaced; the
// route's own button list and its show() logic run for real.
const mockRig = { values: {}, setState: jest.fn(), setSpeech: jest.fn(), syncSpeech: jest.fn() };
const mockPlayer = { addListener: jest.fn(() => ({ remove: jest.fn() })), pause: jest.fn(), replace: jest.fn(), play: jest.fn() };
jest.mock('./useShekruRig', () => ({ useShekruRig: () => mockRig }));
jest.mock('./Shekru', () => ({ Shekru: () => null }));
jest.mock('expo-audio', () => ({ useAudioPlayer: () => mockPlayer }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The demo route exists only in test builds (GURU-9); it redirects otherwise.
jest.mock('../config/build', () => ({ IS_TEST_BUILD: true }));

describe('GURU-7 tutor state contract', () => {
  test('the generated animation defines every TUTOR_STATES name', () => {
    const missing = TUTOR_STATES.filter((s) => !(s in ANIM.states));
    expect(missing).toEqual([]);
  });

  test('sneeze, dropnut, dance and celebrate are one-shots of 2 to 4 s that return to idle', () => {
    for (const name of SURPRISES) {
      const s = surprise(name);
      expect({ name, loop: s.loop, next: s.next }).toEqual({ name, loop: false, next: 'idle' });
      expect(s.duration).toBeGreaterThanOrEqual(2);
      expect(s.duration).toBeLessThanOrEqual(4);
    }
  });

  test('the surprise states animate only existing rig parts, rig groups and fx shapes', () => {
    const rig = readJson(path.join(APP, 'src/shekru/generated/shekru.rig.json'));
    const body = new Set([...Object.keys(rig.parts), ...Object.keys(ANIM.groups)]);
    for (const name of SURPRISES) {
      const s = surprise(name);
      expect({ name, unknown: Object.keys(s.tracks).filter((p) => !body.has(p)) }).toEqual({ name, unknown: [] });
      const fxIds = Object.keys(s.fx?.tracks ?? {});
      expect({ name, unknownFx: fxIds.filter((p) => !(p in ANIM.fx.parts)) }).toEqual({ name, unknownFx: [] });
    }
  });

  test('the surprise states are silent: no voice line drives the mouth', () => {
    const clips = generatedVisemes as Record<string, unknown>;
    for (const name of SURPRISES) {
      surprise(name);
      expect({ name, hasLine: name in clips }).toEqual({ name, hasLine: false });
    }
  });

  test('build-anim.mjs passes validate() and reproduces the committed animation the app ships', () => {
    // Run in a copy so the test never rewrites the design files.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guru7-anim-'));
    try {
      for (const dir of ['anim', 'svg']) {
        fs.cpSync(path.join(DESIGN, dir), path.join(tmp, dir), {
          recursive: true,
          filter: (src) => !src.includes(`${path.sep}audio`) && !src.endsWith('.png'),
        });
      }
      const run = spawnSync(process.execPath, [path.join(tmp, 'anim/tools/build-anim.mjs')], { encoding: 'utf8' });
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });

      const rebuilt = fs.readFileSync(path.join(tmp, 'anim/shekru.anim.json'), 'utf8');
      const committed = fs.readFileSync(path.join(DESIGN, 'anim/shekru.anim.json'), 'utf8');
      expect(rebuilt).toBe(committed);
      expect(Object.keys(JSON.parse(rebuilt).states)).toEqual(expect.arrayContaining([...TUTOR_STATES]));
      // npm run build:shekru was re-run after the motion change
      expect(generatedAnim).toEqual(JSON.parse(committed));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the demo route has a button per surprise state that plays it without speech', () => {
    render(createElement(Demo));
    for (const name of SURPRISES) {
      mockRig.setState.mockClear();
      mockRig.setSpeech.mockClear();
      mockPlayer.play.mockClear();
      fireEvent.press(screen.getByTestId(`state-${name}`));
      expect(mockRig.setState).toHaveBeenCalledWith(name);
      expect(mockPlayer.play).not.toHaveBeenCalled();
      expect(mockRig.setSpeech.mock.calls.filter(([events]) => events != null)).toEqual([]);
    }
  });
});

// Contract for GURU-19 (tutor variety: surprises) and GURU-28 (lesson player v2: surprise states in the rig).
// Shape only: the export names, the 14 state names, and the TutorState type.
describe('GURU-7 contract for dependents (GURU-19, GURU-28)', () => {
  test('contract.ts exports TUTOR_STATES (all 14 names) and type TutorState', () => {
    expect(Array.isArray(TUTOR_STATES)).toBe(true);
    expect(TUTOR_STATES).toHaveLength(14);
    expect([...TUTOR_STATES].sort()).toEqual([...EXISTING, ...SURPRISES].sort());
    expect(new Set(TUTOR_STATES).size).toBe(14);

    // Type-level half, checked by `npm run typecheck`: every listed name is a TutorState
    // and TutorState is a union of names, not plain string.
    const all: readonly TutorState[] = TUTOR_STATES;
    const pick: TutorState = 'dropnut';
    // @ts-expect-error not a tutor state
    const bad: TutorState = 'jump';
    expect([all.length, pick, bad]).toHaveLength(3);
  });
});
