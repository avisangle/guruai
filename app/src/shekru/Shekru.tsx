// Shekru drawn with react-native-svg. The tree is rendered once; each animated
// group reads its transform, opacity and visibility from a shared value.
import { memo, type ReactNode } from 'react';
import { Platform } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Stop, Text } from 'react-native-svg';

import artJson from './generated/shekru.art.json';
import { FRONT_SUFFIX, SHADOW, SHADOW_CX, SHADOW_CY, type PartValue, type PartValues } from './useShekruRig';

type Matrix = [number, number, number, number, number, number];
type Node = { t: string; id?: string; front?: boolean; p?: Record<string, string>; c?: Node[] };

const AnimatedG = Animated.createAnimatedComponent(G);
const VIEWBOX = artJson.viewBox.join(' ');
// Native takes the 2x3 matrix as `matrix`; react-native-svg on web only reads it from `transform`.
const WEB = Platform.OS === 'web';

function Part({ value, children }: { value: SharedValue<PartValue>; children: ReactNode }) {
  const animatedProps = useAnimatedProps(() => {
    const v = value.value;
    const m = v.m as Matrix;
    const props: { opacity: number; display: 'inline' | 'none'; matrix?: Matrix; transform?: Matrix } = {
      opacity: v.o,
      display: v.d,
    };
    if (WEB) props.transform = m; else props.matrix = m;
    return props;
  });
  return <AnimatedG animatedProps={animatedProps}>{children}</AnimatedG>;
}

// Empty slot in the hint card (shekru-fx.svg); the lesson fills it with the letter.
const LETTER_SLOT = 'fx-hint-letter';

function render(nodes: Node[], values: PartValues, letter?: string): ReactNode {
  return nodes.map((n, i) => {
    if (n.id === LETTER_SLOT) {
      return letter ? (
        <Text key={i} x={362} y={264} textAnchor="middle" fontFamily="sans-serif" fontSize={48} fontWeight="800" fill="#3D1420">{letter}</Text>
      ) : null;
    }
    if (n.t === 'path') return <Path key={i} {...n.p} />;
    if (n.t === 'circle') return <Circle key={i} {...n.p} />;
    if (n.t === 'ellipse') return <Ellipse key={i} {...n.p} />;
    const children = render(n.c ?? [], values, letter);
    const value = n.id ? values[n.front ? n.id + FRONT_SUFFIX : n.id] : undefined;
    return value ? <Part key={i} value={value}>{children}</Part> : <G key={i} {...n.p}>{children}</G>;
  });
}

export const Shekru = memo(function Shekru({ values, size, hintLetter }: { values: PartValues; size: number; hintLetter?: string }) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} accessibilityLabel="शेकरू">
      <Defs>
        <RadialGradient id="shadow" cx={SHADOW_CX} cy={SHADOW_CY} rx={158.7} ry={14.3} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#5C461E" stopOpacity={0.28} />
          <Stop offset="1" stopColor="#5C461E" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Part value={values[SHADOW]}>
        <Ellipse cx={SHADOW_CX} cy={SHADOW_CY} rx={158.7} ry={14.3} fill="url(#shadow)" />
      </Part>
      {render(artJson.character as Node[], values)}
      {render(artJson.fx as Node[], values, hintLetter)}
    </Svg>
  );
});
