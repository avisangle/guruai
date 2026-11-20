// The parent gate's device dependencies: SQLite, the system unlock prompt, secure store.
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { liveDb } from '../data/liveDb';
import { createGate, type Gate } from './gate';

let gate: Gate | undefined;

/** Created on first use, so app start opens no database for the gate. */
export function liveGate(): Gate {
  gate ??= createGate({ db: liveDb(), auth: LocalAuthentication, secureStore: SecureStore, crypto: Crypto, now: Date.now });
  return gate;
}
