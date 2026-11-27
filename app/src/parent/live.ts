// The parent gate's device dependencies: SQLite, the system unlock prompt, secure store.
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { liveDb } from '../data/liveDb';
import { createGate, switchToDeviceLock, type Gate, type GateDeps, type SwitchProof } from './gate';

let gate: Gate | undefined;

const deps = (): GateDeps => ({ db: liveDb(), auth: LocalAuthentication, secureStore: SecureStore, crypto: Crypto, now: Date.now });

/** Created on first use, so app start opens no database for the gate. */
export function liveGate(): Gate {
  gate ??= createGate(deps());
  return gate;
}

export const liveSwitchToDeviceLock = (proof: SwitchProof) => switchToDeviceLock(deps(), proof);
