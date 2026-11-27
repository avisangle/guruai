// GURU-49: Android builds compile only arm64-v8a and armeabi-v7a.
// Plain JSON reads; no Expo CLI or native call. See D-GURU-49-android-arm-only.
import * as fs from 'fs';
import * as path from 'path';

const appJson = require('../../app.json');
const easJson = require('../../eas.json');
const pkg = require('../../package.json');

const PLUGIN = 'expo-build-properties';
const ARM_ABIS = ['arm64-v8a', 'armeabi-v7a'];
const ENV_KEY = 'ORG_GRADLE_PROJECT_reactNativeArchitectures';

type PluginEntry = string | [string, Record<string, any>?];

function buildPropsEntry(): [string, Record<string, any>] | undefined {
  const plugins: PluginEntry[] = appJson.expo?.plugins ?? [];
  const hit = plugins.find((p) => (Array.isArray(p) ? p[0] : p) === PLUGIN);
  return Array.isArray(hit) ? (hit as [string, Record<string, any>]) : undefined;
}

describe('GURU-49 android build ABIs', () => {
  it('app.json registers expo-build-properties with an android config', () => {
    const entry = buildPropsEntry();
    expect(entry).toBeDefined();
    expect(Array.isArray(entry![1]?.android?.buildArchs)).toBe(true);
  });

  it('buildArchs is exactly arm64-v8a and armeabi-v7a', () => {
    const archs: string[] = buildPropsEntry()?.[1]?.android?.buildArchs ?? [];
    expect([...archs].sort()).toEqual([...ARM_ABIS].sort());
  });

  it('buildArchs never lists an emulator ABI (x86, x86_64)', () => {
    const archs: string[] = buildPropsEntry()?.[1]?.android?.buildArchs ?? [];
    expect(archs.length).toBeGreaterThan(0);
    expect(archs.filter((a) => a.startsWith('x86'))).toEqual([]);
  });

  it('no eas.json profile overrides reactNativeArchitectures via env', () => {
    const profiles = Object.keys(easJson.build);
    expect(profiles).toEqual(expect.arrayContaining(['development', 'preview', 'production']));
    for (const p of profiles) {
      expect(easJson.build[p].env?.[ENV_KEY]).toBeUndefined();
    }
  });

  it('decision record D-GURU-49-android-arm-only exists and is Accepted', () => {
    const file = path.join(__dirname, '../../../docs/decisions/D-GURU-49-android-arm-only.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/\*\*Status:\*\*\s*Accepted/);
  });

  it('contract (shape only, for dependents): plugin entry, env absence, SDK 58 dependency', () => {
    const entry = buildPropsEntry();
    expect(entry?.[0]).toBe(PLUGIN);
    expect(typeof entry?.[1]?.android).toBe('object');
    expect(Array.isArray(entry?.[1]?.android?.buildArchs)).toBe(true);
    for (const p of Object.keys(easJson.build)) {
      expect(easJson.build[p].env?.[ENV_KEY]).toBeUndefined();
    }
    expect(pkg.dependencies[PLUGIN]).toMatch(/^~58\.0\.\d+$/);
  });
});
