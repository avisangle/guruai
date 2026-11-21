// On app start, a sitting the previous run left open is closed and its summary queued, and the
// upload queue runs without waiting for a new session end (D-GURU-38-queue-at-app-start).
import { render } from '@testing-library/react-native';
import { createElement } from 'react';

import { migrate } from '../data/migrations';
import { createChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import { startSession } from '../learning/session';
import { runUploads, sessionEnded } from '../upload/uploadQueue';

jest.mock('expo-crypto', () => {
  let calls = 0;
  return { randomUUID: jest.fn(() => `uuid-${++calls}`), getRandomBytes: (n: number) => new Uint8Array(n) };
});

const mockDb = createTestDb();
jest.mock('../data/liveDb', () => ({ liveDb: () => mockDb }));
jest.mock('../upload/uploadQueue', () => ({
  sessionEnded: jest.fn(async () => undefined),
  runUploads: jest.fn(async () => undefined),
}));
jest.mock('../asr/speedCheck', () => ({ runSpeedCheck: jest.fn(async () => 'ready') }));
jest.mock('../downloads/downloader', () => ({ startInitialDownloads: jest.fn(async () => undefined) }));
jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true, loadAsync: async () => undefined }));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(async () => true), hideAsync: jest.fn(async () => true) }));
jest.mock('expo-router', () => {
  const Stack = function Stack() {
    return null;
  };
  Stack.Screen = function StackScreen() {
    return null;
  };
  Stack.Protected = function StackProtected() {
    return null;
  };
  return { Stack };
});
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

it('queues the summary of a sitting the last run left open, then runs the upload queue', () => {
  migrate(mockDb);
  const kid = createChild(mockDb, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium: 'en' }).id;
  const left = startSession(mockDb, kid, new Date(2026, 10, 20, 9).toISOString());

  const RootLayout = require('../app/_layout').default;
  render(createElement(RootLayout));

  expect(mockDb.get('SELECT end_reason FROM session WHERE id = ?', [left])).toEqual({ end_reason: 'closed' });
  expect(jest.mocked(sessionEnded).mock.calls).toEqual([[left]]);
  expect(runUploads).toHaveBeenCalledTimes(1);
});
