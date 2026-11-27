// GURU-53: the app theme sets android:useBoundsForWidth false through a local
// config plugin, so Android 15 breaks lines by the width React Native measured.
// Jest does no text layout; the fence is the plugin's output.
// See D-GURU-53-text-advance-width.
import * as fs from 'fs';
import * as path from 'path';

import { AndroidConfig } from 'expo/config-plugins';

const appJson = require('../../app.json');

const APP_ROOT = path.join(__dirname, '../..');
const PLUGIN_ENTRY = './plugins/withTextAdvanceWidth';
const ITEM = 'android:useBoundsForWidth';
const EXPECTED_ITEM = { $: { name: ITEM, 'tools:targetApi': '35' }, _: 'false' };

const { getAppThemeGroup, getStylesGroupAsObject } = AndroidConfig.Styles;

// Loaded per test: the module does not exist until /implement writes it.
function loadPlugin(): any {
  return jest.requireActual('../../plugins/withTextAdvanceWidth');
}

// res/values/styles.xml of the SDK 58 prebuild template (expo/template.tgz),
// as the styles base mod hands it over (it adds xmlns:tools).
function templateStyles(): any {
  return {
    resources: {
      $: { 'xmlns:tools': 'http://schemas.android.com/tools' },
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: [{ $: { name: 'android:editTextBackground' }, _: '@drawable/rn_edit_text_material' }],
        },
        {
          $: { name: 'Theme.App.SplashScreen', parent: 'AppTheme' },
          item: [{ $: { name: 'android:windowBackground' }, _: '@drawable/splashscreen_logo' }],
        },
      ],
    },
  };
}

function boundsItems(xml: any, styleName: string): any[] {
  const style = (xml?.resources?.style ?? []).find((s: any) => s.$.name === styleName);
  return (style?.item ?? []).filter((i: any) => i.$.name === ITEM);
}

// A deep copy with every useBoundsForWidth item removed, to compare the rest.
function withoutBoundsItems(xml: any): any {
  const copy = JSON.parse(JSON.stringify(xml));
  for (const style of copy.resources.style ?? []) {
    style.item = (style.item ?? []).filter((i: any) => i.$.name !== ITEM);
  }
  return copy;
}

describe('GURU-53 android:useBoundsForWidth on the app theme', () => {
  it('setter adds android:useBoundsForWidth=false (tools:targetApi 35) to AppTheme and changes nothing else', () => {
    const out = loadPlugin().setUseBoundsForWidthFalse(templateStyles());

    expect(boundsItems(out, 'AppTheme')).toEqual([EXPECTED_ITEM]);
    expect(getStylesGroupAsObject(out, getAppThemeGroup())?.[ITEM]).toBe('false');

    // Parent, android:editTextBackground, the splash theme and <resources> attributes are as they were.
    expect(boundsItems(out, 'Theme.App.SplashScreen')).toEqual([]);
    expect(withoutBoundsItems(out)).toEqual(templateStyles());
  });

  it('running the setter twice leaves exactly one android:useBoundsForWidth item', () => {
    const { setUseBoundsForWidthFalse } = loadPlugin();
    const out = setUseBoundsForWidthFalse(setUseBoundsForWidthFalse(templateStyles()));

    expect(boundsItems(out, 'AppTheme')).toEqual([EXPECTED_ITEM]);
    expect(withoutBoundsItems(out)).toEqual(templateStyles());
  });

  it('edge: with no styles yet (introspection without an android/ directory) the item still lands on AppTheme', () => {
    const out = loadPlugin().setUseBoundsForWidthFalse({ resources: {} });

    expect(boundsItems(out, 'AppTheme')).toEqual([EXPECTED_ITEM]);
    expect(getStylesGroupAsObject(out, getAppThemeGroup())?.[ITEM]).toBe('false');
  });

  it('wrong starting state: an AppTheme that already says true ends with one item saying false', () => {
    const xml = templateStyles();
    xml.resources.style[0].item.push({ $: { name: ITEM }, _: 'true' });

    const out = loadPlugin().setUseBoundsForWidthFalse(xml);

    expect(boundsItems(out, 'AppTheme')).toEqual([EXPECTED_ITEM]);
  });

  it('plugin registers an Android styles mod whose output has the item', async () => {
    const withTextAdvanceWidth = loadPlugin();
    const config = withTextAdvanceWidth({ name: 'x', slug: 'x' });

    const stylesMod = config?.mods?.android?.styles;
    expect(typeof stylesMod).toBe('function');

    const result = await stylesMod({
      ...config,
      modResults: templateStyles(),
      modRequest: {
        platform: 'android',
        modName: 'styles',
        projectRoot: APP_ROOT,
        platformProjectRoot: path.join(APP_ROOT, 'android'),
        introspect: true,
      },
    });

    expect(boundsItems(result.modResults, 'AppTheme')).toEqual([EXPECTED_ITEM]);
    expect(withoutBoundsItems(result.modResults)).toEqual(templateStyles());
  });

  it('app.json lists the plugin and the path resolves to the module tested here', () => {
    const plugins: (string | [string, unknown?])[] = appJson.expo?.plugins ?? [];
    const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain(PLUGIN_ENTRY);

    // Prebuild resolves a relative plugin path from the project root (app/).
    const resolved = require.resolve(PLUGIN_ENTRY, { paths: [APP_ROOT] });
    expect(resolved).toBe(require.resolve('../../plugins/withTextAdvanceWidth'));
    expect(jest.requireActual(resolved)).toBe(loadPlugin());
  });

  it('contract (shape only; Needed by: none, fenced for app.json and any later theme plugin): module path, exports, item shape', () => {
    expect(fs.existsSync(path.join(APP_ROOT, 'plugins/withTextAdvanceWidth.js'))).toBe(true);

    const withTextAdvanceWidth = loadPlugin();
    expect(typeof withTextAdvanceWidth).toBe('function');
    expect(typeof withTextAdvanceWidth.setUseBoundsForWidthFalse).toBe('function');

    const config = withTextAdvanceWidth({ name: 'x', slug: 'x' });
    expect(typeof config).toBe('object');
    expect(typeof config.mods?.android?.styles).toBe('function');

    const out = withTextAdvanceWidth.setUseBoundsForWidthFalse(templateStyles());
    expect(Array.isArray(out?.resources?.style)).toBe(true);
    const [item] = boundsItems(out, 'AppTheme');
    expect(typeof item?._).toBe('string');
    expect(typeof item?.$?.['tools:targetApi']).toBe('string');

    const names = (appJson.expo?.plugins ?? []).map((p: unknown) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain(PLUGIN_ENTRY);
  });
});
