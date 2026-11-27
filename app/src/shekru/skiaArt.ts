// Shekru's art as a draw list for the Skia renderer, and the conversions from a rig value to Skia
// props. No React and no Skia here, so jest checks order, binding, paints and maths as plain JS.
import artJson from './generated/shekru.art.json';
import { FRONT_SUFFIX, SHADOW, type PartValue } from './useShekruRig';

export type Paint =
  | { style: 'fill'; color: string }
  | { style: 'stroke'; color: string; width: number; cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel' };

export type DrawNode =
  // `part` is the key into PartValues that drives the group.
  | { kind: 'group'; part: string; children: DrawNode[] }
  | { kind: 'path'; d: string; paints: Paint[] }
  | { kind: 'circle'; cx: number; cy: number; r: number; paints: Paint[] }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; paints: Paint[] }
  | { kind: 'shadow' }
  | { kind: 'hintLetter' };

type Stroke = Extract<Paint, { style: 'stroke' }>;
type ArtNode = { t: string; id?: string; front?: boolean; p?: Record<string, string>; c?: ArtNode[] };

// Empty slot in the hint card (shekru-fx.svg); the lesson fills it with the letter.
const LETTER_SLOT = 'fx-hint-letter';
const KEYS = new Set([...Object.keys(artJson.parts), ...artJson.front.map((id) => id + FRONT_SUFFIX)]);

// SVG paint order: fill, then stroke. Cap and join default to butt and miter, as in SVG.
function paints(p: Record<string, string>): Paint[] {
  const out: Paint[] = [];
  if (p.fill !== 'none') out.push({ style: 'fill', color: p.fill });
  if (p.stroke !== undefined && p.stroke !== 'none') {
    out.push({
      style: 'stroke',
      color: p.stroke,
      width: Number(p.strokeWidth),
      cap: (p.strokeLinecap ?? 'butt') as Stroke['cap'],
      join: (p.strokeLinejoin ?? 'miter') as Stroke['join'],
    });
  }
  return out;
}

// Document order. A group no rig value drives carries no attributes in this art, so it is
// flattened into its parent.
function walk(nodes: ArtNode[]): DrawNode[] {
  return nodes.flatMap((n): DrawNode[] => {
    if (n.id === LETTER_SLOT) return [{ kind: 'hintLetter' }];
    const p = n.p ?? {};
    if (n.t === 'path') return [{ kind: 'path', d: p.d, paints: paints(p) }];
    if (n.t === 'circle') return [{ kind: 'circle', cx: Number(p.cx), cy: Number(p.cy), r: Number(p.r), paints: paints(p) }];
    if (n.t === 'ellipse') {
      return [{ kind: 'ellipse', cx: Number(p.cx), cy: Number(p.cy), rx: Number(p.rx), ry: Number(p.ry), paints: paints(p) }];
    }
    const children = walk(n.c ?? []);
    // A lifted part is drawn twice; the rig shows one copy and hides the other.
    const part = n.front ? n.id + FRONT_SUFFIX : n.id;
    return part !== undefined && KEYS.has(part) ? [{ kind: 'group', part, children }] : children;
  });
}

export const DRAW_TREE: DrawNode[] = [
  { kind: 'group', part: SHADOW, children: [{ kind: 'shadow' }] },
  ...walk(artJson.character as ArtNode[]),
  ...walk(artJson.fx as ArtNode[]),
];

// SVG matrix(a, b, c, d, e, f) as a row-major 3x3: x' = a·x + c·y + e, y' = b·x + d·y + f.
export function partMatrix(v: PartValue): number[] {
  'worklet';
  const m = v.m;
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

// A hidden part draws at opacity 0. Skia multiplies group opacities, so it hides its children too.
export function partOpacity(v: PartValue): number {
  'worklet';
  return v.d === 'none' ? 0 : v.o;
}
