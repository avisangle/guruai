// Parent gate (D-GURU-13-parent-gate): the phone's screen lock by default, or a GuruAI PIN.
// SQLite holds only the mode and wrong-PIN counters; the PIN record is in secure store.
import { randomUUID } from 'expo-crypto';
import { SecurityLevel } from 'expo-local-authentication';
import type * as LocalAuthentication from 'expo-local-authentication';
import type * as SecureStore from 'expo-secure-store';

import type { Db } from '../data/db';
import { lockoutFor } from './lockout';
import { createPinRecord, isValidPin, pinMatches, type PinCrypto } from './pin';

export type GateMode = 'device' | 'pin';
export type GateState = GateMode | 'needs_pin_setup';
export type PinResult = { ok: boolean; waitUntil?: number };

export type GateDeps = {
  db: Db;
  auth: Pick<typeof LocalAuthentication, 'getEnrolledLevelAsync' | 'authenticateAsync'>;
  secureStore: Pick<typeof SecureStore, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'>;
  crypto: PinCrypto;
  /** Epoch ms. */
  now: () => number;
};

const PIN_KEY = 'guru.parent_pin';

type GateRow = { mode: GateMode; failed: number; lockout_until: string | null };

// One PIN check at a time per database, across gate instances (switchToDeviceLock builds its own):
// overlapping checks would read the same `failed` and lose a count.
const pinQueues = new WeakMap<Db, Promise<unknown>>();

/** Whether recoverWithBiometrics can work on this phone. */
export async function strongBiometricsAvailable(auth: Pick<GateDeps['auth'], 'getEnrolledLevelAsync'>) {
  return (await auth.getEnrolledLevelAsync()) >= SecurityLevel.BIOMETRIC_STRONG;
}

const screenLockSet = async (auth: Pick<GateDeps['auth'], 'getEnrolledLevelAsync'>) =>
  (await auth.getEnrolledLevelAsync()) >= SecurityLevel.SECRET;

/** Proof for switchToDeviceLock: the GuruAI PIN, or strong biometrics with this prompt message. */
export type SwitchProof = { pin: string } | { biometrics: string };

/**
 * Back to the phone's screen lock: removes the PIN record once the proof passes the gate's own checks
 * (D-GURU-51-switch-back-asks-pin). Refuses, changing nothing, when the phone has no screen lock (checked
 * first, no prompt) or the gate is not in pin mode. The mode changes first, so a failed delete never leaves
 * pin mode without a PIN. Kept off the gate object (D-GURU-36-switch-back-outside-gate).
 */
export async function switchToDeviceLock(deps: GateDeps, proof: SwitchProof): Promise<PinResult> {
  const { db, auth, secureStore, now } = deps;
  if (!(await screenLockSet(auth))) return { ok: false };
  const gate = createGate(deps);
  if ((await gate.mode()) !== 'pin') return { ok: false };
  const result = 'pin' in proof ? await gate.verifyPin(proof.pin) : { ok: await gate.recoverWithBiometrics(proof.biometrics) };
  if (!result.ok) return result;
  db.run("UPDATE parent_gate SET mode = 'device', failed = 0, lockout_until = NULL, updated_at = ?", [
    new Date(now()).toISOString(),
  ]);
  await secureStore.deleteItemAsync(PIN_KEY);
  return { ok: true };
}

export function createGate({ db, auth, secureStore, crypto, now }: GateDeps) {
  const stamp = () => new Date(now()).toISOString();

  // The single parent_gate row, created with the gate.
  if (!db.get('SELECT 1 FROM parent_gate')) {
    const at = stamp();
    db.run('INSERT INTO parent_gate (id, created_at, updated_at) VALUES (?, ?, ?)', [
      randomUUID(),
      at,
      at,
    ]);
  }

  const row = () => db.get<GateRow>('SELECT mode, failed, lockout_until FROM parent_gate LIMIT 1')!;

  function resetCounters() {
    db.run('UPDATE parent_gate SET failed = 0, lockout_until = NULL, updated_at = ?', [stamp()]);
  }

  const deviceLockAvailable = () => screenLockSet(auth);

  async function checkPin(pin: string, at: number): Promise<PinResult> {
    const current = row();
    const until = current.lockout_until ? Date.parse(current.lockout_until) : 0;
    if (at < until) return { ok: false, waitUntil: until };

    const stored = await secureStore.getItemAsync(PIN_KEY);
    if (stored && (await pinMatches(crypto, pin, stored))) {
      resetCounters();
      return { ok: true };
    }

    const failed = current.failed + 1;
    const wait = lockoutFor(failed);
    const waitUntil = at + wait;
    db.run('UPDATE parent_gate SET failed = ?, lockout_until = ?, updated_at = ?', [
      failed,
      wait ? new Date(waitUntil).toISOString() : current.lockout_until,
      stamp(),
    ]);
    return wait ? { ok: false, waitUntil } : { ok: false };
  }

  return {
    async mode(): Promise<GateMode> {
      return row().mode;
    },

    deviceLockAvailable,

    /** Decision 25: device mode with no screen lock on the phone must set up a PIN. */
    async state(): Promise<GateState> {
      if (row().mode === 'pin') return 'pin';
      return (await deviceLockAvailable()) ? 'device' : 'needs_pin_setup';
    },

    /** System unlock prompt; the phone's PIN or pattern is accepted as well as biometrics. */
    async unlockWithDevice(promptMessage?: string): Promise<boolean> {
      const result = await auth.authenticateAsync({ promptMessage, disableDeviceFallback: false });
      return result.success;
    },

    /** Stores a new 4-digit PIN and switches the gate to pin mode. */
    async setPin(pin: string): Promise<void> {
      if (!isValidPin(pin)) throw new Error('PIN must be 4 digits');
      await secureStore.setItemAsync(PIN_KEY, await createPinRecord(crypto, pin));
      db.run("UPDATE parent_gate SET mode = 'pin', updated_at = ?", [stamp()]);
    },

    /** During a wait, refuses without checking. Every 3rd wrong PIN starts a wait. */
    verifyPin(pin: string, at: number = now()): Promise<PinResult> {
      const result = (pinQueues.get(db) ?? Promise.resolve()).then(() => checkPin(pin, at));
      pinQueues.set(db, result.catch(() => undefined));
      return result;
    },

    /**
     * Forgotten PIN: strong biometrics only, never the phone's PIN or pattern (a child
     * may know it). Works during a wait; on success clears the counters so the caller
     * can set a new PIN. False with no prompt when the phone has no strong biometrics.
     */
    async recoverWithBiometrics(promptMessage?: string): Promise<boolean> {
      if (!(await strongBiometricsAvailable(auth))) return false;
      const result = await auth.authenticateAsync({
        promptMessage,
        disableDeviceFallback: true,
        biometricsSecurityLevel: 'strong',
      });
      if (result.success) resetCounters();
      return result.success;
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
