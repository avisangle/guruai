// Android 15 (targetSdk 35+) breaks TextView lines by glyph ink bounds, while
// React Native measures by glyph advances. Setting the attribute false on the
// app theme makes every TextView break by advances again.
// See docs/decisions/D-GURU-53-text-advance-width.md.
const { AndroidConfig, withAndroidStyles } = require('expo/config-plugins');

const setUseBoundsForWidthFalse = (xml) =>
  AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    parent: AndroidConfig.Styles.getAppThemeGroup(),
    name: 'android:useBoundsForWidth',
    value: 'false',
    targetApi: '35',
  });

const withTextAdvanceWidth = (config) =>
  withAndroidStyles(config, (c) => {
    c.modResults = setUseBoundsForWidthFalse(c.modResults);
    return c;
  });

module.exports = withTextAdvanceWidth;
module.exports.setUseBoundsForWidthFalse = setUseBoundsForWidthFalse;
