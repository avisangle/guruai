// The root layout renders one dark status bar so every route inherits it (GURU-45). All screen
// backgrounds are light, so dark clock and icons are the default. Schema: no tables touched.
import { render } from '@testing-library/react-native';
import { createElement } from 'react';

import { createTestDb } from '../data/testDb';

const mockStatusBarProps: Record<string, unknown>[] = [];
jest.mock('expo-status-bar', () => ({
  StatusBar: (props: Record<string, unknown>) => {
    mockStatusBarProps.push(props);
    return null;
  },
}));

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

let mockFontsLoaded = true;
jest.mock('expo-font', () => ({
  useFonts: () => [mockFontsLoaded, null],
  isLoaded: () => true,
  loadAsync: async () => undefined,
}));

beforeEach(() => {
  mockStatusBarProps.length = 0;
  mockFontsLoaded = true;
});

const renderRoot = () => {
  const RootLayout = require('../app/_layout').default;
  return render(createElement(RootLayout));
};

// A failing test here means GURU-45's acceptance criterion "RootLayout renders a dark StatusBar" is unmet.
it('renders an expo-status-bar StatusBar with style "dark" once fonts are ready', () => {
  renderRoot();
  expect(mockStatusBarProps.length).toBeGreaterThan(0);
  expect(mockStatusBarProps[mockStatusBarProps.length - 1]).toMatchObject({ style: 'dark' });
});

it('never asks for a light status bar', () => {
  renderRoot();
  expect(mockStatusBarProps.every((p) => p.style === 'dark')).toBe(true);
  expect(mockStatusBarProps.length).toBeGreaterThan(0);
});

it('renders nothing, status bar included, while fonts load, then the dark bar once they are ready', () => {
  mockFontsLoaded = false;
  const view = renderRoot();
  expect(view.toJSON()).toBeNull();
  expect(mockStatusBarProps).toEqual([]);
  mockFontsLoaded = true;
  view.rerender(createElement(require('../app/_layout').default));
  expect(mockStatusBarProps.some((p) => p.style === 'dark')).toBe(true);
});

// Contract for dependents: output_for_dependents promises a default export RootLayout that renders
// <StatusBar style="dark" /> on every route; no new exports.
it('contract: RootLayout is the default export function and the dark bar sits in its tree', () => {
  const mod = require('../app/_layout');
  expect(typeof mod.default).toBe('function');
  expect(Object.keys(mod).filter((k) => k !== 'default' && k !== '__esModule')).toEqual([]);
  renderRoot();
  expect(mockStatusBarProps.some((p) => p.style === 'dark')).toBe(true);
});
