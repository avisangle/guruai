// Shekru drawn on one Skia canvas. The tree renders once; each animated group reads its matrix and
// opacity from the rig's shared value on the UI thread, so a rig step redraws the canvas without a
// React render (docs/decisions/D-GURU-48-shekru-on-skia.md).
import {
  Canvas, Circle, Group, Oval, Paint, Paragraph, Path, RadialGradient, Skia, Text, TextAlign, matchFont, rect, vec,
  type SkFont, type SkPath,
} from '@shopify/react-native-skia';
import { memo, useMemo, type ReactNode } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import artJson from './generated/shekru.art.json';
import { DRAW_TREE, partMatrix, partOpacity, type DrawNode, type Paint as ArtPaint } from './skiaArt';
import { SHADOW_CX, SHADOW_CY, type PartValue, type PartValues } from './useShekruRig';

type Parts = SharedValue<PartValue>[];

// The viewBox is square: the canvas shows VIEW_SIZE art units from (VIEW_X, VIEW_Y).
const [VIEW_X, VIEW_Y, VIEW_SIZE] = artJson.viewBox;

// Parsed once per module load, never per render or per rig step.
const PATHS = new Map<string, SkPath>();
(function parse(nodes: DrawNode[]) {
  for (const n of nodes) {
    if (n.kind === 'group') parse(n.children);
    else if (n.kind === 'path' && !PATHS.has(n.d)) PATHS.set(n.d, Skia.Path.MakeFromSVGString(n.d)!);
  }
})(DRAW_TREE);

// Ground shadow: an elliptical gradient in the art. Skia's radial gradient is circular, so a circle
// of radius rx is squashed to ry about its centre.
const SHADOW_RX = 158.7;
const SHADOW_RY = 14.3;
const SHADOW_COLOR = '#5C461E';
const SHADOW_OPACITY = 0.28;
const SHADOW_CENTRE = vec(SHADOW_CX, SHADOW_CY);

// Hint letter: centred on LETTER_X with its baseline on LETTER_Y, as in shekru-fx.svg.
const LETTER_X = 362;
const LETTER_Y = 264;
const LETTER_SIZE = 48;
const LETTER_WEIGHT = 800;
const LETTER_COLOR = '#3D1420';
// Layout width for the paragraph; wider than any one letter or picture.
const LETTER_BOX = 240;
// Built on first use: screens that never show a hint do not load the system font manager.
let letterFont: SkFont | undefined;
const getLetterFont = () => (letterFont ??= matchFont({ fontFamily: 'sans-serif', fontSize: LETTER_SIZE, fontWeight: LETTER_WEIGHT }));

function Part({ value, children }: { value: SharedValue<PartValue>; children: ReactNode }) {
  const matrix = useDerivedValue(() => partMatrix(value.value));
  const opacity = useDerivedValue(() => partOpacity(value.value));
  return <Group matrix={matrix} opacity={opacity}>{children}</Group>;
}

// Skia's Text draws with one typeface, unshaped. Text the font has no glyph for goes through
// Paragraph, which shapes and falls back to the system fonts. That is every lesson today: lessons
// pass a picture emoji (content/pictures.ts). Paragraph ignores the opacity of the groups above it,
// so it fades through a layer of its own, clipped to the text box to keep the layer small.
function FallbackLetter({ letter, above }: { letter: string; above: Parts }) {
  const { paragraph, box } = useMemo(() => {
    const p = Skia.ParagraphBuilder.Make({ textAlign: TextAlign.Center })
      .pushStyle({
        color: Skia.Color(LETTER_COLOR),
        fontFamilies: ['sans-serif'],
        fontSize: LETTER_SIZE,
        fontStyle: { weight: LETTER_WEIGHT },
      })
      .addText(letter)
      .build();
    p.layout(LETTER_BOX);
    const top = LETTER_Y - p.getLineMetrics()[0].baseline;
    return { paragraph: p, box: rect(LETTER_X - LETTER_BOX / 2, top, LETTER_BOX, p.getHeight()) };
  }, [letter]);
  const opacity = useDerivedValue(() => above.reduce((o, part) => o * partOpacity(part.value), 1));
  return (
    <Group clip={box}>
      <Group layer={<Paint opacity={opacity} />}>
        <Paragraph paragraph={paragraph} x={box.x} y={box.y} width={box.width} />
      </Group>
    </Group>
  );
}

function HintLetter({ letter, above }: { letter: string; above: Parts }) {
  const font = getLetterFont();
  const glyphs = font.getGlyphIDs(letter);
  if (glyphs.includes(0)) return <FallbackLetter letter={letter} above={above} />;
  // SVG textAnchor="middle": start half the advance width left of the centre.
  const width = font.getGlyphWidths(glyphs).reduce((sum, w) => sum + w, 0);
  return <Text text={letter} x={LETTER_X - width / 2} y={LETTER_Y} font={font} color={LETTER_COLOR} />;
}

const paintProps = (p: ArtPaint) =>
  p.style === 'fill'
    ? { color: p.color }
    : { color: p.color, style: 'stroke' as const, strokeWidth: p.width, strokeCap: p.cap, strokeJoin: p.join };

// `above` is the bound parts enclosing `nodes`, outermost first.
function draw(nodes: DrawNode[], values: PartValues, letter: string | undefined, above: Parts = []): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'group': {
        const value = values[n.part];
        return <Part key={i} value={value}>{draw(n.children, values, letter, [...above, value])}</Part>;
      }
      case 'shadow':
        return (
          <Group key={i} origin={SHADOW_CENTRE} transform={[{ scaleY: SHADOW_RY / SHADOW_RX }]}>
            <Circle c={SHADOW_CENTRE} r={SHADOW_RX} opacity={SHADOW_OPACITY}>
              <RadialGradient c={SHADOW_CENTRE} r={SHADOW_RX} colors={[SHADOW_COLOR, SHADOW_COLOR + '00']} />
            </Circle>
          </Group>
        );
      case 'hintLetter':
        return letter ? <HintLetter key={i} letter={letter} above={above} /> : null;
      // One element per paint, in paint order: a leaf with both draws its fill, then its stroke.
      case 'path':
        return n.paints.map((p, j) => <Path key={j} path={PATHS.get(n.d)!} {...paintProps(p)} />);
      case 'circle':
        return n.paints.map((p, j) => <Circle key={j} cx={n.cx} cy={n.cy} r={n.r} {...paintProps(p)} />);
      case 'ellipse':
        return n.paints.map((p, j) => (
          <Oval key={j} x={n.cx - n.rx} y={n.cy - n.ry} width={2 * n.rx} height={2 * n.ry} {...paintProps(p)} />
        ));
    }
  });
}

export const Shekru = memo(function Shekru({ values, size, hintLetter }: { values: PartValues; size: number; hintLetter?: string }) {
  return (
    <Canvas style={{ width: size, height: size }} accessibilityLabel="शेकरू">
      <Group transform={[{ scale: size / VIEW_SIZE }, { translateX: -VIEW_X }, { translateY: -VIEW_Y }]}>
        {draw(DRAW_TREE, values, hintLetter)}
      </Group>
    </Canvas>
  );
});
