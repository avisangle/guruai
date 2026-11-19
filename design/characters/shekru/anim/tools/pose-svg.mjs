// Puts the effect shapes (shekru-fx.svg) above the character in one SVG text.
// Lines are de-indented so poseSvg's draw-order pass leaves them alone.
export function withFx(svgText, fxText) {
  const inner = fxText.split('\n').map((l) => l.trim()).filter((l) => l && !/^<\/?svg/.test(l)).join('\n');
  return svgText.replace(/<\/svg>\s*$/, inner + '\n</svg>\n');
}
// Bakes a frame from rig.update() into SVG text (for offline rendering).
export function poseSvg(svgText, frame) {
  let out = svgText;
  for (const id in frame.parts) {
    const p = frame.parts[id];
    const re = new RegExp(`<g id="${id}"( display="none")?>`);
    const attrs = [`id="${id}"`];
    if (p.transform) attrs.push(`transform="${p.transform}"`);
    if (!p.visible) attrs.push('display="none"');
    if (p.opacity < 1) attrs.push(`opacity="${p.opacity.toFixed(3)}"`);
    out = out.replace(re, `<g ${attrs.join(' ')}>`);
  }
  // reorder the direct children of #shekru (4-space indented blocks)
  const lines = out.split('\n');
  const blocks = {}; let curId = null; const head = [], tail = [];
  for (const line of lines) {
    const m = /^ {4}<g id="([^"]+)"/.exec(line);
    if (m) { curId = m[1]; blocks[curId] = []; }
    if (curId) { blocks[curId].push(line); if (line === '    </g>') curId = null; }
    else (Object.keys(blocks).length ? tail : head).push(line);
  }
  const body = frame.order.flatMap((id) => blocks[id]);
  return [...head, ...body, ...tail].join('\n');
}
