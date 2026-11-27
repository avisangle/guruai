// GURU-13: parent gate logic. Spec: issue GURU-13, PRD Edge Cases (PIN forgotten,
// screen lock removed, wrong PINs), TDD 2.6 and section 3 in Epic GURU-1.
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   parent_gate(id, mode TEXT NOT NULL DEFAULT 'device', failed INTEGER NOT NULL DEFAULT 0,
//               lockout_until TEXT, lockout_stage INTEGER NOT NULL DEFAULT 0, created_at, updated_at)
// The PIN record lives in expo-secure-store only.
//
// createGate(deps) gets every native call injected:
//   db           the Db interface (better-sqlite3 here)
//   auth         expo-local-authentication's shape: getEnrolledLevelAsync(), authenticateAsync(options)
//                (SDK 58 SecurityLevel: NONE 0, SECRET 1, BIOMETRIC_WEAK 2, BIOMETRIC_STRONG 3)
//   secureStore  expo-secure-store's shape: getItemAsync, setItemAsync, deleteItemAsync
//   crypto       expo-crypto's shape: getRandomBytes(Async), digest, digestStringAsync (SHA-256 only)
//   now          () => epoch ms
// Times (now, waitUntil) are epoch milliseconds.
import * as nodeCrypto from "crypto";

import type { Db } from "../data/db";
import { migrate } from "../data/migrations";
import { createTestDb } from "../data/testDb";

import {
  createGate,
  switchToDeviceLock,
  type GateDeps,
  type PinResult,
  type SwitchProof,
} from "./gate";
import { lockoutFor } from "./lockout";

// gate.ts may import these for its live defaults; tests must never reach native code.
jest.mock("expo-sqlite", () => ({ openDatabaseSync: jest.fn() }));
jest.mock(
  "expo-local-authentication",
  () => ({
    SecurityLevel: {
      NONE: 0,
      SECRET: 1,
      BIOMETRIC_WEAK: 2,
      BIOMETRIC_STRONG: 3,
    },
    getEnrolledLevelAsync: jest.fn(async () => 0),
    authenticateAsync: jest.fn(async () => ({
      success: false,
      error: "not_available",
    })),
  }),
  { virtual: true },
);
jest.mock(
  "expo-secure-store",
  () => ({
    getItemAsync: jest.fn(),
    setItemAsync: jest.fn(),
    deleteItemAsync: jest.fn(),
  }),
  { virtual: true },
);

const NONE = 0;
const SECRET = 1;
const BIOMETRIC_WEAK = 2;
const BIOMETRIC_STRONG = 3;

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.parse("2026-12-01T10:00:00Z");

function fakeAuth(level: number, success = true) {
  return {
    hasHardwareAsync: jest.fn(async () => true),
    isEnrolledAsync: jest.fn(async () => level >= 2),
    getEnrolledLevelAsync: jest.fn(async () => level),
    authenticateAsync: jest.fn(async (_options?: Record<string, unknown>) =>
      success
        ? { success: true as const }
        : { success: false as const, error: "user_cancel" as const },
    ),
  };
}

function fakeSecureStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: jest.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      items.delete(key);
    }),
  };
}

// Real SHA-256 behind expo-crypto's function names; random bytes are distinct per call.
function fakeCrypto() {
  let seed = 0;
  const randomBytes = (n: number) => {
    seed++;
    return Uint8Array.from(
      { length: n },
      (_, i) => (seed * 37 + i * 11) & 0xff,
    );
  };
  const sha256 = (algorithm: string, data: Uint8Array | string) => {
    if (algorithm !== "SHA-256")
      throw new Error(`unexpected digest algorithm ${algorithm}`);
    return nodeCrypto.createHash("sha256").update(data);
  };
  return {
    getRandomBytes: jest.fn(randomBytes),
    getRandomBytesAsync: jest.fn(async (n: number) => randomBytes(n)),
    getRandomValues: <T extends Uint8Array>(a: T) => {
      a.set(randomBytes(a.length));
      return a;
    },
    digest: jest.fn(async (algorithm: string, data: BufferSource) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const out = sha256(algorithm, bytes).digest();
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
    digestStringAsync: jest.fn(
      async (
        algorithm: string,
        data: string,
        options?: { encoding?: "hex" | "base64" },
      ) =>
        sha256(algorithm, data).digest(
          options?.encoding === "base64" ? "base64" : "hex",
        ),
    ),
  };
}

function setup(level = SECRET, authSuccess = true) {
  const database = createTestDb();
  migrate(database);
  let clock = T0;
  const deps = {
    db: database,
    auth: fakeAuth(level, authSuccess),
    secureStore: fakeSecureStore(),
    crypto: fakeCrypto(),
    now: () => clock,
  };
  return {
    ...deps,
    gate: createGate(deps),
    setClock: (t: number) => {
      clock = t;
    },
  };
}

/** Every value in every SQLite table, as one string. */
function dumpDb(db: Db): string {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return JSON.stringify(tables.map((t) => db.all(`SELECT * FROM "${t.name}"`)));
}

/** The one PIN record written to secure store, parsed. */
function pinRecord(store: ReturnType<typeof fakeSecureStore>) {
  const values = [...store.items.values()];
  expect(values).toHaveLength(1);
  return JSON.parse(values[0]) as {
    salt: string;
    rounds: number;
    hash: string;
  };
}

/** Byte length of a hex or base64 string. */
function byteLength(s: string): number {
  return /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0
    ? s.length / 2
    : Buffer.from(s, "base64").length;
}

const failedCount = (db: Db) =>
  db.get<{ failed: number }>("SELECT failed FROM parent_gate")?.failed;

describe("GURU-13 parent gate", () => {
  it("device lock: available only with a screen lock, else needs_pin_setup (decision 25); unlockWithDevice allows device-credential fallback", async () => {
    for (const [level, available] of [
      [NONE, false],
      [SECRET, true],
      [BIOMETRIC_STRONG, true],
    ] as const) {
      const { gate } = setup(level);
      expect(await gate.deviceLockAvailable()).toBe(available);
      expect(await gate.mode()).toBe("device");
      expect(await gate.state()).toBe(available ? "device" : "needs_pin_setup");
    }

    // Choosing a PIN switches to pin mode, which needs no screen lock.
    const { gate } = setup(NONE);
    await gate.setPin("4821");
    expect(await gate.mode()).toBe("pin");
    expect(await gate.state()).toBe("pin");

    // unlockWithDevice opens the system prompt with device-credential fallback and resolves its result.
    const ok = setup(SECRET, true);
    expect(await ok.gate.unlockWithDevice()).toBe(true);
    expect(ok.auth.authenticateAsync).toHaveBeenCalledTimes(1);
    const options = ok.auth.authenticateAsync.mock.calls[0][0] ?? {};
    expect(options.disableDeviceFallback).not.toBe(true);

    const cancelled = setup(SECRET, false);
    expect(await cancelled.gate.unlockWithDevice()).toBe(false);
  });

  it("setPin stores only a salted, iterated SHA-256 record in secure store, never in SQLite", async () => {
    const { gate, db, secureStore, auth, crypto } = setup(SECRET);

    for (const bad of ["123", "12345", "abcd", "12a4", ""]) {
      await expect(gate.setPin(bad)).rejects.toThrow();
    }
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();

    await gate.setPin("4821");
    const [key] = [...secureStore.items.keys()];
    expect(key).toMatch(/^[\w.-]+$/); // secure-store key rule
    const record = pinRecord(secureStore);
    expect(Object.keys(record).sort()).toEqual(["hash", "rounds", "salt"]);
    expect(record.rounds).toBe(1000);
    expect(byteLength(record.salt)).toBe(16);
    expect(record.hash).not.toContain("4821");

    // Nothing PIN-related in SQLite: no PIN, hash or salt anywhere.
    const dump = dumpDb(db);
    for (const secret of ["4821", record.hash, record.salt])
      expect(dump).not.toContain(secret);

    // Salt and rounds are really used: tampering with either breaks a correct PIN.
    const original = secureStore.items.get(key)!;
    const verifyWith = async (patch: Partial<typeof record>) => {
      secureStore.items.set(key, JSON.stringify({ ...record, ...patch }));
      const fresh = createGate({
        db,
        auth,
        secureStore,
        crypto,
        now: () => T0,
      });
      return (await fresh.verifyPin("4821", T0)).ok;
    };
    expect(await verifyWith({ rounds: 999 })).toBe(false);
    const otherSalt = Buffer.alloc(16, 7);
    expect(
      await verifyWith({
        salt: /^[0-9a-f]+$/i.test(record.salt)
          ? otherSalt.toString("hex")
          : otherSalt.toString("base64"),
      }),
    ).toBe(false);
    secureStore.items.set(key, original);
    expect((await gate.verifyPin("4821", T0)).ok).toBe(true);

    // A new PIN gets a new salt.
    await gate.setPin("4821");
    expect(pinRecord(secureStore).salt).not.toBe(record.salt);
  });

  it("lockoutFor: 30 s at 3, 5 min at 6, 15 min at every further 3, never more, nothing in between", () => {
    expect(lockoutFor(3)).toBe(30 * SEC);
    expect(lockoutFor(6)).toBe(5 * MIN);
    for (const n of [9, 12, 15, 30, 300]) expect(lockoutFor(n)).toBe(15 * MIN);
    for (const n of [0, 1, 2, 4, 5, 7, 8, 10, 11, 13])
      expect(lockoutFor(n)).toBe(0);
  });

  it("verifyPin counts wrong PINs, locks out without checking, and the counters survive a restart", async () => {
    const { gate, db, crypto, auth, secureStore } = setup(SECRET);
    await gate.setPin("4821");

    let t = T0;
    // 1st and 2nd wrong: no wait yet.
    expect(await gate.verifyPin("0000", t)).toEqual({ ok: false });
    expect(await gate.verifyPin("1111", t)).toEqual({ ok: false });
    expect(failedCount(db)).toBe(2);

    // 3rd wrong: 30 s wait.
    expect(await gate.verifyPin("2222", t)).toEqual({
      ok: false,
      waitUntil: t + 30 * SEC,
    });

    // During the wait even the right PIN is refused unchecked, and nothing is counted.
    crypto.digest.mockClear();
    crypto.digestStringAsync.mockClear();
    expect(await gate.verifyPin("4821", t + 10 * SEC)).toEqual({
      ok: false,
      waitUntil: t + 30 * SEC,
    });
    expect(
      crypto.digest.mock.calls.length +
        crypto.digestStringAsync.mock.calls.length,
    ).toBe(0);
    expect(failedCount(db)).toBe(3);

    // Closing the app does not reset the wait: a new gate over the same db still refuses.
    const reopened = createGate({
      db,
      auth,
      secureStore,
      crypto: fakeCrypto(),
      now: () => t + 20 * SEC,
    });
    expect(await reopened.verifyPin("4821", t + 20 * SEC)).toEqual({
      ok: false,
      waitUntil: t + 30 * SEC,
    });

    const threeWrong = async (at: number) => {
      await gate.verifyPin("0000", at);
      await gate.verifyPin("0000", at);
      return gate.verifyPin("0000", at);
    };
    // 3 more wrong after the wait: 5 min.
    t += 30 * SEC;
    expect(await threeWrong(t)).toEqual({ ok: false, waitUntil: t + 5 * MIN });
    // 3 more: 15 min.
    t += 5 * MIN;
    expect(await threeWrong(t)).toEqual({ ok: false, waitUntil: t + 15 * MIN });
    // 3 more: 15 min again, never longer.
    t += 15 * MIN;
    expect(await threeWrong(t)).toEqual({ ok: false, waitUntil: t + 15 * MIN });
    expect(failedCount(db)).toBe(12);
  });

  it("a correct PIN resets the count and the wait", async () => {
    const { gate, db } = setup(SECRET);
    await gate.setPin("4821");

    await gate.verifyPin("0000", T0);
    await gate.verifyPin("0000", T0);
    expect(await gate.verifyPin("4821", T0)).toEqual({ ok: true });
    expect(failedCount(db)).toBe(0);

    // Two more wrong after the reset do not trigger the 30 s wait.
    await gate.verifyPin("0000", T0);
    await gate.verifyPin("0000", T0);
    expect(await gate.verifyPin("4821", T0)).toEqual({ ok: true });

    // After a wait ends, the right PIN opens and clears it.
    for (let i = 0; i < 3; i++) await gate.verifyPin("0000", T0);
    expect(await gate.verifyPin("4821", T0 + 30 * SEC)).toEqual({ ok: true });
    expect(failedCount(db)).toBe(0);
    expect(await gate.verifyPin("0000", T0 + 30 * SEC)).toEqual({ ok: false });
  });

  it("recoverWithBiometrics needs strong biometrics, works during a wait, resets counters and allows a new PIN", async () => {
    const { gate, db, auth } = setup(BIOMETRIC_STRONG);
    await gate.setPin("4821");
    for (let i = 0; i < 3; i++) await gate.verifyPin("0000", T0);
    expect((await gate.verifyPin("4821", T0 + SEC)).ok).toBe(false);

    auth.authenticateAsync.mockClear();
    expect(await gate.recoverWithBiometrics()).toBe(true);
    expect(auth.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceFallback: true,
        biometricsSecurityLevel: "strong",
      }),
    );
    expect(failedCount(db)).toBe(0);

    await gate.setPin("5739");
    expect(await gate.verifyPin("5739", T0 + 2 * SEC)).toEqual({ ok: true });
    expect((await gate.verifyPin("4821", T0 + 2 * SEC)).ok).toBe(false);

    // A failed or cancelled biometric prompt changes nothing.
    const failing = setup(BIOMETRIC_STRONG, false);
    await failing.gate.setPin("4821");
    for (let i = 0; i < 3; i++) await failing.gate.verifyPin("0000", T0);
    expect(await failing.gate.recoverWithBiometrics()).toBe(false);
    expect(failedCount(failing.db)).toBe(3);

    // Phone PIN or pattern only: recovery is not offered, so no prompt at all.
    const patternOnly = setup(SECRET);
    await patternOnly.gate.setPin("4821");
    expect(await patternOnly.gate.recoverWithBiometrics()).toBe(false);
    expect(patternOnly.auth.authenticateAsync).not.toHaveBeenCalled();
  });

  // Contract for GURU-24 (onboarding parent lock), GURU-25 (gate screens, PIN waits)
  // and GURU-36 (settings: lock mode and PIN). Shape only.
  it("contract: createGate(deps) and pure lockoutFor(failed) as promised to GURU-24, GURU-25, GURU-36", async () => {
    expect(typeof createGate).toBe("function");
    expect(typeof lockoutFor).toBe("function");
    expect(typeof lockoutFor(3)).toBe("number");

    const { gate } = setup(SECRET);
    for (const fn of [
      "mode",
      "unlockWithDevice",
      "setPin",
      "verifyPin",
      "recoverWithBiometrics",
      "deviceLockAvailable",
      "state",
    ] as const) {
      expect(typeof gate[fn]).toBe("function");
    }

    expect(["device", "pin"]).toContain(await gate.mode());
    expect(["device", "pin", "needs_pin_setup"]).toContain(await gate.state());
    expect(typeof (await gate.deviceLockAvailable())).toBe("boolean");
    expect(typeof (await gate.unlockWithDevice())).toBe("boolean");
    await gate.setPin("4821");
    const wrong = await gate.verifyPin("0000", T0);
    expect(typeof wrong.ok).toBe("boolean");
    for (let i = 0; i < 2; i++) await gate.verifyPin("0000", T0);
    expect(typeof (await gate.verifyPin("4821", T0)).waitUntil).toBe("number");
    expect(typeof (await gate.recoverWithBiometrics())).toBe("boolean");
  });
});

// GURU-51: switching back to the phone's lock needs the old GuruAI PIN or strong biometrics, checked
// inside switchToDeviceLock (D-GURU-51-switch-back-asks-pin, amending D-GURU-36). Order kept:
// screen-lock check, pin-mode check, proof, mode write, record delete.
describe("GURU-51 switchToDeviceLock asks for a proof", () => {
  const PIN = "4821";

  const depsOf = (s: ReturnType<typeof setup>): GateDeps => ({
    db: s.db,
    auth: s.auth,
    secureStore: s.secureStore,
    crypto: s.crypto,
    now: s.now,
  });

  const modeOf = (db: Db) =>
    db.get<{ mode: string }>("SELECT mode FROM parent_gate")?.mode;
  const lockoutOf = (db: Db) =>
    db.get<{ lockout_until: string | null }>(
      "SELECT lockout_until FROM parent_gate",
    )?.lockout_until;

  /** A gate in pin mode with PIN 4821 stored. */
  async function inPinMode(level: number, authSuccess = true) {
    const s = setup(level, authSuccess);
    await s.gate.setPin(PIN);
    s.auth.authenticateAsync.mockClear();
    return s;
  }

  /** Mode pin, the PIN record still stored, nothing deleted. */
  function expectUnchanged(s: ReturnType<typeof setup>) {
    expect(modeOf(s.db)).toBe("pin");
    expect(s.secureStore.items.size).toBe(1);
    expect(s.secureStore.deleteItemAsync).not.toHaveBeenCalled();
  }

  it("no screen lock: refuses before any proof, with no prompt and no counting, even with the right PIN", async () => {
    const s = await inPinMode(NONE);

    expect(await switchToDeviceLock(depsOf(s), { pin: PIN })).toEqual({
      ok: false,
    });
    expect(await switchToDeviceLock(depsOf(s), { pin: "0000" })).toEqual({
      ok: false,
    });
    expect(
      await switchToDeviceLock(depsOf(s), { biometrics: "Open" }),
    ).toEqual({ ok: false });

    expect(s.auth.authenticateAsync).not.toHaveBeenCalled();
    expect(failedCount(s.db)).toBe(0);
    expectUnchanged(s);
  });

  it("device mode: refuses, changing nothing, with no PIN check and no prompt", async () => {
    const s = setup(BIOMETRIC_STRONG);
    expect(modeOf(s.db)).toBe("device");

    expect(await switchToDeviceLock(depsOf(s), { pin: PIN })).toEqual({
      ok: false,
    });
    expect(
      await switchToDeviceLock(depsOf(s), { biometrics: "Open" }),
    ).toEqual({ ok: false });

    expect(s.auth.authenticateAsync).not.toHaveBeenCalled();
    expect(failedCount(s.db)).toBe(0); // the PIN was never checked, so never counted
    expect(modeOf(s.db)).toBe("device");
    expect(s.secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("wrong PIN changes nothing and counts; the 3rd starts the 30 s wait; during it the right PIN is refused unchecked; after it the right PIN switches", async () => {
    const s = await inPinMode(SECRET);
    const deps = depsOf(s);

    expect(await switchToDeviceLock(deps, { pin: "0000" })).toEqual({
      ok: false,
    });
    expectUnchanged(s);
    expect(failedCount(s.db)).toBe(1);
    expect(await switchToDeviceLock(deps, { pin: "1111" })).toEqual({
      ok: false,
    });
    expect(await switchToDeviceLock(deps, { pin: "2222" })).toEqual({
      ok: false,
      waitUntil: T0 + 30 * SEC,
    });
    expectUnchanged(s);
    expect(failedCount(s.db)).toBe(3);

    // During the wait: refused without hashing or counting.
    s.setClock(T0 + 10 * SEC);
    s.crypto.digest.mockClear();
    s.crypto.digestStringAsync.mockClear();
    expect(await switchToDeviceLock(deps, { pin: PIN })).toEqual({
      ok: false,
      waitUntil: T0 + 30 * SEC,
    });
    expect(
      s.crypto.digest.mock.calls.length +
        s.crypto.digestStringAsync.mock.calls.length,
    ).toBe(0);
    expect(failedCount(s.db)).toBe(3);
    expectUnchanged(s);

    // The phone's own credential never stands in for the PIN.
    expect(s.auth.authenticateAsync).not.toHaveBeenCalled();

    s.setClock(T0 + 30 * SEC);
    expect(await switchToDeviceLock(deps, { pin: PIN })).toEqual({ ok: true });
    expect(modeOf(s.db)).toBe("device");
    expect(s.secureStore.items.size).toBe(0);
    expect(failedCount(s.db)).toBe(0);
    expect(lockoutOf(s.db)).toBeNull();
  });

  it("correct PIN: writes mode device and clears the counters before deleting the PIN record", async () => {
    const s = await inPinMode(SECRET);
    await s.gate.verifyPin("0000", T0);
    await s.gate.verifyPin("0000", T0);
    expect(failedCount(s.db)).toBe(2);

    const atDelete: [string | undefined, number | undefined][] = [];
    s.secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      atDelete.push([modeOf(s.db), failedCount(s.db)]);
      s.secureStore.items.delete(key);
    });

    expect(await switchToDeviceLock(depsOf(s), { pin: PIN })).toEqual({
      ok: true,
    });
    expect(atDelete).toEqual([["device", 0]]);
    expect(s.secureStore.items.size).toBe(0);
    expect(modeOf(s.db)).toBe("device");
    expect(s.auth.authenticateAsync).not.toHaveBeenCalled();
  });

  it("biometrics: strong only, with recoverWithBiometrics' options; no strong biometrics, a failed prompt or the phone's PIN or pattern change nothing", async () => {
    // Pattern only, or weak biometrics: refused with no prompt.
    for (const level of [SECRET, BIOMETRIC_WEAK]) {
      const s = await inPinMode(level);
      expect(
        await switchToDeviceLock(depsOf(s), { biometrics: "Open" }),
      ).toEqual({ ok: false });
      expect(s.auth.authenticateAsync).not.toHaveBeenCalled();
      expectUnchanged(s);
    }

    // A failed or cancelled prompt.
    const cancelled = await inPinMode(BIOMETRIC_STRONG, false);
    expect(
      await switchToDeviceLock(depsOf(cancelled), { biometrics: "Open" }),
    ).toEqual({ ok: false });
    expect(cancelled.auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expectUnchanged(cancelled);

    // A prompt that succeeds only through the phone's PIN or pattern (device fallback) is no proof.
    const fallback = await inPinMode(BIOMETRIC_STRONG);
    fallback.auth.authenticateAsync.mockImplementation(
      async (options?: Record<string, unknown>) =>
        options?.disableDeviceFallback === true
          ? { success: false as const, error: "user_cancel" as const }
          : { success: true as const },
    );
    expect(
      await switchToDeviceLock(depsOf(fallback), { biometrics: "Open" }),
    ).toEqual({ ok: false });
    expectUnchanged(fallback);
  });

  it("biometrics success switches, during a wait too, with strong-only options and the given prompt", async () => {
    const s = await inPinMode(BIOMETRIC_STRONG);
    for (let i = 0; i < 3; i++) await s.gate.verifyPin("0000", T0);
    s.setClock(T0 + SEC); // inside the 30 s wait

    expect(
      await switchToDeviceLock(depsOf(s), { biometrics: "Open the parent area" }),
    ).toEqual({ ok: true });
    expect(s.auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(s.auth.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMessage: "Open the parent area",
        disableDeviceFallback: true,
        biometricsSecurityLevel: "strong",
      }),
    );
    expect(modeOf(s.db)).toBe("device");
    expect(s.secureStore.items.size).toBe(0);
    expect(failedCount(s.db)).toBe(0);
    expect(lockoutOf(s.db)).toBeNull();
  });

  // Contract from GURU-51's output_for_dependents (Needed by: none; Settings is the consumer). Shape only.
  it("contract: switchToDeviceLock(deps, proof): Promise<PinResult>, SwitchProof, liveSwitchToDeviceLock(proof)", async () => {
    expect(typeof switchToDeviceLock).toBe("function");
    expect(switchToDeviceLock.length).toBe(2);

    const proofs: SwitchProof[] = [{ pin: "0000" }, { biometrics: "Open" }];
    for (const proof of proofs) {
      const s = await inPinMode(BIOMETRIC_STRONG, false);
      const result: PinResult = await switchToDeviceLock(depsOf(s), proof);
      expect(typeof result.ok).toBe("boolean");
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const live = require("./live") as typeof import("./live");
    const liveSwitch: (proof: SwitchProof) => Promise<PinResult> =
      live.liveSwitchToDeviceLock;
    expect(typeof liveSwitch).toBe("function");
    expect(liveSwitch.length).toBe(1);

    // The gate object gains no method (D-GURU-25, D-GURU-36).
    expect(Object.keys(setup(SECRET).gate).sort()).toEqual(
      [
        "deviceLockAvailable",
        "mode",
        "recoverWithBiometrics",
        "setPin",
        "state",
        "unlockWithDevice",
        "verifyPin",
      ].sort(),
    );
  });
});
