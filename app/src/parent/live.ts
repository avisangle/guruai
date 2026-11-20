// The parent gate's device dependencies: SQLite, the system unlock prompt, secure store.
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { openDb } from '../data/db';
import { migrate } from '../data/migrations';
import { createGate, type Gate } from './gate';

export function liveGate(): Gate {
  const db = openDb();
  migrate(db);
  return createGate({ db, auth: LocalAuthentication, secureStore: SecureStore, crypto: Crypto, now: Date.now });
}
