// The app's parent gate over the app database and the real native modules.
import * as ExpoCrypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { appDb } from '../data/appDb';
import { createGate, type Gate } from './gate';

let gate: Gate | null = null;

export function appGate(): Gate {
  gate ??= createGate({
    db: appDb(),
    auth: LocalAuthentication,
    secureStore: SecureStore,
    crypto: ExpoCrypto,
    now: () => Date.now(),
  });
  return gate;
}
