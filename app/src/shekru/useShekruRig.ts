// Runs the Shekru engine on the UI thread and exposes one shared value per
// animated part. React never re-renders for a frame; JS-thread stalls (lesson
// logic, speech recognition callbacks) cannot make the character stutter.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { makeMutable, useFrameCallback, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { frameGate } from './frameGate';
import { makeEngine } from './generated/engine';
import animJson from './generated/shekru.anim.json';
import artJson from './generated/shekru.art.json';
import rigJson from './generated/shekru.rig.json';

export type PartValue = { m: number[]; o: number; d: 'inline' | 'none' };
export type PartValues = Record<string, SharedValue<PartValue>>;
export type VisemeEvent = [number, string];
// Audio position sampled on the JS thread; the UI thread extrapolates from it.
export type SpeechClock = { on: boolean; t: number; wall: number };

export const FRONT_SUFFIX = '@front';
export const SHADOW = '@shadow';

const INITIAL = artJson.parts as Record<string, PartValue>;
const FRONT: string[] = artJson.front;
const FRONT_AFTER: string = artJson.frontAfter;
const GROUND: number = artJson.ground;
const IDENTITY = [1, 0, 0, 1, 0, 0];
// Shadow centre in viewBox units, see Shekru.tsx.
export const SHADOW_CX = 202.4;
export const SHADOW_CY = 442.6;

type UiState = { rig: any; clock: number; sinceStep: number; state: string | null };
// One slot per hook instance: a screen under the lesson keeps its own rig.
const ui = (key: number) => {
  'worklet';
  return (globalThis as any).__shekru?.[key] as UiState | undefined;
};
let lastKey = 0;

function setPart(sv: SharedValue<PartValue>, m: number[], o: number, d: 'inline' | 'none') {
  'worklet';
  const c = sv.value;
  if (c.d === d) {
    if (d === 'none') return; // hidden parts need no transform updates
    const n = c.m;
    if (
      c.o === o &&
      Math.abs(n[0] - m[0]) < 1e-4 && Math.abs(n[1] - m[1]) < 1e-4 && Math.abs(n[2] - m[2]) < 1e-4 &&
      Math.abs(n[3] - m[3]) < 1e-4 && Math.abs(n[4] - m[4]) < 1e-3 && Math.abs(n[5] - m[5]) < 1e-3
    ) return;
  }
  sv.value = { m, o, d };
}

export function useShekruRig(onState?: (state: string) => void) {
  const values = useMemo(() => {
    const v: PartValues = {};
    for (const id in INITIAL) v[id] = makeMutable(INITIAL[id]);
    for (const id of FRONT) v[id + FRONT_SUFFIX] = makeMutable<PartValue>({ ...INITIAL[id], d: 'none' });
    v[SHADOW] = makeMutable<PartValue>({ m: IDENTITY, o: 1, d: 'inline' });
    return v;
  }, []);
  const speechClock = useMemo(() => makeMutable<SpeechClock>({ on: false, t: 0, wall: 0 }), []);
  const key = useMemo(() => ++lastKey, []);

  useEffect(() => {
    const seed = (Math.random() * 1e9) | 0;
    scheduleOnUI(() => {
      const rig = makeEngine().createRig(rigJson, animJson, { seed });
      const g = globalThis as any;
      g.__shekru = { ...g.__shekru, [key]: { rig, clock: 0, sinceStep: 0, state: null } };
    });
    const setReduced = (on: boolean) => scheduleOnUI(() => ui(key)?.rig.setReducedMotion(on));
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      sub.remove();
      scheduleOnUI(() => {
        const g = globalThis as any;
        if (g.__shekru) delete g.__shekru[key];
      });
    };
  }, [key]);

  const loop = useFrameCallback((info) => {
    const g = ui(key);
    if (!g) return;
    const step = frameGate(g, (info.timeSincePreviousFrame ?? 0) / 1000);
    if (step === null) return;
    g.clock += step;
    const s = speechClock.value;
    const speechTime = s.on ? s.t + Math.min(0.3, (Date.now() - s.wall) / 1000) : undefined;
    const frame = g.rig.update(g.clock, { speechTime });

    const headAt = frame.order.indexOf(FRONT_AFTER);
    for (const id in frame.parts) {
      const p = frame.parts[id];
      const d = p.visible ? 'inline' : 'none';
      const lifted = FRONT.indexOf(id) >= 0 && frame.order.indexOf(id) > headAt;
      setPart(values[id], p.matrix, p.opacity, lifted ? 'none' : d);
      const front = values[id + FRONT_SUFFIX];
      if (front) setPart(front, p.matrix, p.opacity, lifted ? d : 'none');
    }

    // ground shadow shrinks while he is in the air (same maths as the web preview)
    const root = frame.parts.shekru;
    const lift = root ? -(root.matrix[5] - (1 - root.matrix[3]) * GROUND) : 0;
    const k = Math.max(0, Math.min(1, lift / 60));
    const sc = 1 - 0.3 * k;
    setPart(values[SHADOW], [sc, 0, 0, sc, SHADOW_CX * (1 - sc), SHADOW_CY * (1 - sc)], 1 - 0.45 * k, 'inline');

    if (frame.state !== g.state) {
      g.state = frame.state;
      if (onState) scheduleOnRN(onState, frame.state);
    }
  }, false);

  // The frame callback runs only while the screen is focused and the app is in the foreground.
  useFocusEffect(useCallback(() => {
    loop.setActive(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (state) => loop.setActive(state === 'active'));
    return () => {
      sub.remove();
      loop.setActive(false);
    };
  }, [loop]));

  return useMemo(() => ({
    values,
    // Takes effect on the next frame and blends from the pose on screen.
    setState: (name: string) => scheduleOnUI(() => ui(key)?.rig.setState(name)),
    // events of the clip about to play, or null to clear
    setSpeech: (events: VisemeEvent[] | null) => {
      if (!events) speechClock.value = { on: false, t: 0, wall: 0 };
      scheduleOnUI(() => ui(key)?.rig.setSpeech(events));
    },
    // Call with the audio position whenever the player reports it.
    syncSpeech: (playing: boolean, seconds: number) => {
      speechClock.value = { on: playing, t: seconds, wall: Date.now() };
    },
  }), [values, speechClock, key]);
}

export type ShekruRig = ReturnType<typeof useShekruRig>;
