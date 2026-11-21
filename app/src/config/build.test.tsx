// GURU-9: test vs release builds. Spec: issue GURU-9, PRD Technical Constraints and Privacy.
// Lives outside src/app/: Expo Router turns every .tsx file there into a route.
//
// Contract pinned for /implement:
//   app/src/config/build.ts      named export IS_TEST_BUILD = process.env.EXPO_PUBLIC_TEST_BUILD === '1'
//   app/src/config/TestOnly.tsx  named export TestOnly({ children }): children only when IS_TEST_BUILD
//   gated when false             RecordingPanel (testID recording-panel, holding record-toggle and
//                                tap-toggle) and the demo link (testID demo-link) in LessonScreen;
//                                /probe, /demo and /tester redirect to /; the child picker's link to
//                                /tester (testID tester-link)
//   eas.json                     development, preview: env.EXPO_PUBLIC_TEST_BUILD "1"; production:
//                                android.buildType "app-bundle", no EXPO_PUBLIC_TEST_BUILD
//   app.json                     mic permission text speaks of listening to the child's answers
// Not covered: the "tester: reset progress" button. No such button exists in the code today, so
// there is nothing to render or hide; add it to the gate and this file when it appears.
//
// Real schema: none (no database access in this issue).
// Faked: ./build (IS_TEST_BUILD switched per test), expo-audio, expo-keep-awake, the speech and
// file modules, the Shekru rig, reanimated, safe-area, liveDb/profiles/useRecording.
/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'fs';
import * as path from 'path';
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

let mockTestBuild = false;
jest.mock('./build', () => ({
  get IS_TEST_BUILD() {
    return mockTestBuild;
  },
}), { virtual: true }); // virtual: the module does not exist until /implement

jest.mock('expo-audio', () => {
  const thing = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : key === 'remove' ? () => undefined : thing()),
      apply: () => thing(),
    });
  return new Proxy({ __esModule: true }, {
    get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : thing()),
  });
});
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => undefined }));
jest.mock('../screens/ProbeScreen', () => ({ ProbeScreen: () => null }));
jest.mock('../shekru/Shekru', () => ({ Shekru: () => null }));
jest.mock('../shekru/useShekruRig', () => ({
  useShekruRig: () => ({ values: {}, setState: () => undefined, setSpeech: () => undefined, syncSpeech: () => undefined }),
}));
jest.mock('../data/liveDb', () => ({ liveDb: () => ({}) }));
jest.mock('../data/profiles', () => ({ listChildren: () => [] }));
jest.mock('../screens/useRecording', () => ({
  useRecording: () => ({
    on: false, settings: { child: '', age: undefined }, update: () => undefined, setOn: () => undefined,
    tap: false, setTap: () => undefined, mic: 'granted', active: false, count: 0, error: null,
    source: undefined, prepare: async () => undefined, exportAll: async () => undefined,
    deleteAll: () => undefined, judged: undefined,
  }),
}));
jest.mock('react-native-reanimated/mock', () => {
  const chain = (): unknown =>
    new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
  const rn = (name: string) => require('react-native')[name];
  const views = ['View', 'Text', 'Image', 'ScrollView', 'FlatList'];
  const Animated: Record<string, unknown> = new Proxy(
    { createAnimatedComponent: (c: unknown) => c },
    { get: (t, k) => (views.includes(k as string) ? rn(k as string) : (t as Record<string | symbol, unknown>)[k]) },
  );
  const known: Record<string, unknown> = {
    __esModule: true,
    default: Animated,
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => undefined,
    FadeIn: { duration: () => ({}) },
  };
  return new Proxy(known, {
    get: (t, k) => (views.includes(k as string) ? rn(k as string) : k in t ? t[k as string] : chain()),
  });
});
jest.mock('react-native-reanimated', () => jest.requireMock('react-native-reanimated/mock'));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const APP = path.resolve(__dirname, '../..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(APP, file), 'utf8'));

function renderHome() {
  const { LessonScreen } = require('../screens/LessonScreen');
  return render(h(LessonScreen));
}

async function visit(url: string) {
  return renderRouter(
    {
      index: () => h(Text, { testID: 'home' }, 'home'),
      demo: require('../app/demo').default,
      probe: require('../app/probe').default,
      tester: require('../app/tester').default,
    },
    { initialUrl: url },
  );
}

beforeEach(() => {
  mockTestBuild = false;
});

describe('GURU-9: test vs release builds', () => {
  it('contract (consumers of GURU-9): IS_TEST_BUILD is a boolean from EXPO_PUBLIC_TEST_BUILD and TestOnly is a component', () => {
    const real = (v: string | undefined) => {
      const old = process.env.EXPO_PUBLIC_TEST_BUILD;
      if (v === undefined) delete process.env.EXPO_PUBLIC_TEST_BUILD;
      else process.env.EXPO_PUBLIC_TEST_BUILD = v;
      try {
        let value: unknown;
        jest.isolateModules(() => {
          value = jest.requireActual('./build').IS_TEST_BUILD;
        });
        return value;
      } finally {
        if (old === undefined) delete process.env.EXPO_PUBLIC_TEST_BUILD;
        else process.env.EXPO_PUBLIC_TEST_BUILD = old;
      }
    };
    expect(real('1')).toBe(true);
    expect(real('0')).toBe(false);
    expect(real(undefined)).toBe(false);
    expect(typeof jest.requireActual('./TestOnly').TestOnly).toBe('function');
  });

  it('TestOnly renders its children only when IS_TEST_BUILD is true', () => {
    const { TestOnly } = require('./TestOnly');
    mockTestBuild = false;
    const off = render(h(TestOnly, null, h(Text, { testID: 'secret' }, 'x')));
    expect(screen.queryByTestId('secret')).toBeNull();
    off.unmount();
    mockTestBuild = true;
    render(h(TestOnly, null, h(Text, { testID: 'secret' }, 'x')));
    expect(screen.getByTestId('secret')).toBeTruthy();
  });

  it('release build: the home screen has no recording panel, tap mode or demo link', () => {
    mockTestBuild = false;
    renderHome();
    expect(screen.getByTestId('lesson-menu')).toBeTruthy(); // the screen itself still renders
    expect(screen.queryByTestId('recording-panel')).toBeNull();
    expect(screen.queryByTestId('record-toggle')).toBeNull();
    expect(screen.queryByTestId('tap-toggle')).toBeNull();
    expect(screen.queryByTestId('export-clips')).toBeNull();
    expect(screen.queryByTestId('demo-link')).toBeNull();
  });

  it('test build: the home screen shows the recording panel, tap mode and demo link as today', () => {
    expect(typeof jest.requireActual('./build')).toBe('object'); // the flag module exists (else this passes ungated)
    mockTestBuild = true;
    renderHome();
    expect(screen.getByTestId('recording-panel')).toBeTruthy();
    expect(screen.getByTestId('record-toggle')).toBeTruthy();
    expect(screen.getByTestId('tap-toggle')).toBeTruthy();
    expect(screen.getByTestId('export-clips')).toBeTruthy();
    expect(screen.getByTestId('demo-link')).toBeTruthy();
  });

  it('release build: /demo, /probe and /tester redirect to /; test build: they open', async () => {
    mockTestBuild = false;
    for (const url of ['/demo', '/probe', '/tester']) {
      const r = await visit(url);
      expect(await screen.findByTestId('home')).toBeTruthy();
      expect(r).toHavePathname('/');
      r.unmount();
    }
    mockTestBuild = true;
    for (const url of ['/demo', '/probe', '/tester']) {
      const r = await visit(url);
      expect(r).toHavePathname(url);
      expect(screen.queryByTestId('home')).toBeNull();
      r.unmount();
    }
  });

  it('the child picker links to the tester tools in test builds only', async () => {
    for (const on of [false, true]) {
      mockTestBuild = on;
      const r = await renderRouter({ index: require('../app/index').default }, { initialUrl: '/' });
      expect(screen.queryByTestId('tester-link') !== null).toBe(on);
      r.unmount();
    }
  });

  it('eas.json: development and preview set EXPO_PUBLIC_TEST_BUILD=1; production builds an app bundle without it', () => {
    const { build } = readJson('eas.json');
    expect(build.development.env?.EXPO_PUBLIC_TEST_BUILD).toBe('1');
    expect(build.preview.env?.EXPO_PUBLIC_TEST_BUILD).toBe('1');
    expect(build.production?.android?.buildType).toBe('app-bundle');
    expect(build.production?.env?.EXPO_PUBLIC_TEST_BUILD).toBeUndefined();
    expect(build.production?.extends).toBeUndefined(); // would inherit a test profile's env
  });

  it("app.json: the mic permission text describes listening to the child's answers, not only tester recording", () => {
    const { expo } = readJson('app.json');
    const texts: string[] = [expo.ios.infoPlist.NSMicrophoneUsageDescription];
    for (const p of expo.plugins) {
      if (Array.isArray(p) && p[1]?.microphonePermission) texts.push(p[1].microphonePermission);
    }
    expect(texts.length).toBe(3);
    for (const t of texts) {
      expect(t).toMatch(/listen/i);
      expect(t).toMatch(/child/i);
      expect(t).not.toMatch(/only when a tester/i);
    }
  });
});
