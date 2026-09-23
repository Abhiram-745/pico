/* ==========================================================================
   Halo — a second, closer look, for targets nothing is marked on.

   Numbered marks (marks.mjs) cover everything Windows can describe. What is
   left is what it cannot: a canvas, a game, a map, a chart, an app that draws
   its own controls. There the model has to give a point, and a small model's
   point on a whole-screen picture is only roughly right — near the thing, not
   on it.

   Roughly right is enough to start from. The area around that point is cut
   out, enlarged, gridded with pixel rulers, and shown again with one
   question: where exactly, in this picture, is the thing? At that size the
   thing is large, the rulers are close, and the answer only has to be good to
   within the enlarged picture — a far smaller error in real pixels.

   One extra call, and only for a click that had no mark to land on.
   ========================================================================== */

import { createRequire } from 'node:module';
import { downscale } from './screen.mjs';
import { fillRect, drawNumber } from './marks.mjs';

const require = createRequire(import.meta.url);
let jpeg = null;
try { jpeg = require('jpeg-js'); } catch { /* no zoom without an encoder */ }

/** Physical pixels cut out around the first guess, and how large it is shown. */
export const CROP = 420;
export const SHOWN = 840;
const RULE = 70;   // grid spacing in the enlarged picture

/** The crop's placement on the screen: centred on the guess, kept on screen. */
export function cropBox(point, physical, size = CROP, origin = { x: 0, y: 0 }) {
  const w = Math.min(size, physical.width);
  const h = Math.min(size, physical.height);
  const x = Math.round(Math.max(origin.x, Math.min(origin.x + physical.width - w, point.x - (w / 2))));
  const y = Math.round(Math.max(origin.y, Math.min(origin.y + physical.height - h, point.y - (h / 2))));
  return { x, y, width: w, height: h };
}

/** A point in the enlarged picture, back in physical screen pixels. */
export function fromZoom(p, box, shown = SHOWN) {
  return {
    x: box.x + ((Number(p.x) + 0.5) * (box.width / shown)) - 0.5,
    y: box.y + ((Number(p.y) + 0.5) * (box.height / Math.round((box.height * shown) / box.width))) - 0.5,
  };
}

function crop(raw, box) {
  const src = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const out = Buffer.allocUnsafe(box.width * box.height * 4);
  // The box is in desktop pixels; the frame is of one display.
  const bx = box.x - (raw.originX ?? 0);
  const by = box.y - (raw.originY ?? 0);
  for (let row = 0; row < box.height; row++) {
    const from = (((by + row) * raw.width) + bx) * 4;
    src.copy(out, row * box.width * 4, from, from + (box.width * 4));
  }
  return out;
}

/** The enlarged, ruled picture, as a JPEG. */
export function zoomImage(raw, box, shown = SHOWN) {
  if (!jpeg) return null;
  const img = downscale(crop(raw, box), box.width, box.height, shown);
  // Rulers: faint lines every RULE pixels, numbered along the top and left.
  for (let v = RULE; v < img.width; v += RULE) fillRect(img, v, 0, 1, img.height, [255, 0, 160]);
  for (let v = RULE; v < img.height; v += RULE) fillRect(img, 0, v, img.width, 1, [255, 0, 160]);
  for (let v = RULE; v < img.width - 20; v += RULE) {
    fillRect(img, v + 2, 1, (String(v).length * 12) + 3, 18, [30, 30, 30]);
    drawNumber(img, v, v + 4, 3, 2, [255, 255, 255]);
  }
  for (let v = RULE; v < img.height - 20; v += RULE) {
    fillRect(img, 1, v + 2, (String(v).length * 12) + 3, 18, [30, 30, 30]);
    drawNumber(img, v, 3, v + 4, 2, [255, 255, 255]);
  }
  const data = jpeg.encode(img, 85).data;
  return { b64: Buffer.from(data).toString('base64'), mime: 'image/jpeg', width: img.width, height: img.height };
}

/* --------------------------------------------------------------------------
   Numbered shapes inside a picture.

   A drawing has no accessibility tree, but it does have shapes: runs of
   pixels that differ from what is behind them. Found by colour against the
   picture's own background, boxed and numbered, they can be chosen the way
   controls are — by number — and the click goes to the middle of the shape
   instead of wherever a model's sense of pixels puts it.
   -------------------------------------------------------------------------- */

/**
 * The distinct things drawn in a region, as desktop-pixel rectangles.
 * @returns {Array<{rect:number[], area:number}>}
 */
export function shapesIn(raw, box, { step = 3, maxShapes = 60 } = {}) {
  const src = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const ox = (raw.originX ?? 0);
  const oy = (raw.originY ?? 0);
  const gw = Math.max(1, Math.floor(box.width / step));
  const gh = Math.max(1, Math.floor(box.height / step));
  const at = (gx, gy) => {
    const x = Math.min(raw.width - 1, Math.max(0, box.x - ox + (gx * step)));
    const y = Math.min(raw.height - 1, Math.max(0, box.y - oy + (gy * step)));
    const i = ((y * raw.width) + x) * 4;
    return [src[i], src[i + 1], src[i + 2]];
  };
  // The background is the commonest colour round the edge.
  const counts = new Map();
  const edge = [];
  for (let gx = 0; gx < gw; gx++) edge.push(at(gx, 0), at(gx, gh - 1));
  for (let gy = 0; gy < gh; gy++) edge.push(at(0, gy), at(gw - 1, gy));
  for (const [r, g, b] of edge) {
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bgKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];

  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const [r, g, b] = at(gx, gy);
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 70) mask[(gy * gw) + gx] = 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const shapes = [];
  const queue = new Int32Array(gw * gh);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0; let tail = 0;
    queue[tail++] = start; seen[start] = 1;
    let x0 = gw; let y0 = gh; let x1 = 0; let y1 = 0; let area = 0;
    let sr = 0; let sg = 0; let sb = 0;
    while (head < tail) {
      const c = queue[head++];
      const cx = c % gw; const cy = (c - cx) / gw;
      area += 1;
      const [pr, pg, pb] = at(cx, cy);
      sr += pr; sg += pg; sb += pb;
      if (cx < x0) x0 = cx; if (cy < y0) y0 = cy; if (cx > x1) x1 = cx; if (cy > y1) y1 = cy;
      for (const n of [c - 1, c + 1, c - gw, c + gw]) {
        if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
        if ((n === c - 1 && cx === 0) || (n === c + 1 && cx === gw - 1)) continue;
        seen[n] = 1; queue[tail++] = n;
      }
    }
    const w = (x1 - x0 + 1) * step;
    const h = (y1 - y0 + 1) * step;
    // Specks and anything nearly the size of the whole picture are not things to click.
    if (area < 6 || w > box.width * 0.8 || h > box.height * 0.8) continue;
    /* Its colour, and how much of its own box it fills — a square all of
       it, a circle about three quarters, a triangle half — which is enough
       to name "the green circle" without showing anyone the picture. */
    shapes.push({ rect: [box.x + (x0 * step), box.y + (y0 * step), w, h], area,
      colour: [Math.round(sr / area), Math.round(sg / area), Math.round(sb / area)],
      fill: area / ((x1 - x0 + 1) * (y1 - y0 + 1)) });
  }
  return shapes.sort((a, b) => b.area - a.area).slice(0, maxShapes);
}

const PICK_TOOL = [{
  type: 'function',
  function: {
    name: 'pick',
    description: 'Say which numbered box holds the target.',
    parameters: {
      type: 'object',
      properties: { number: { type: 'integer', description: 'The number on the box around the target, or 0 if no box holds it.' } },
      required: ['number'],
    },
  },
}];

/**
 * Pick a shape by number inside a picture.
 * @returns {Promise<{x:number,y:number,moved:number}|null>} desktop pixels, or null to fall back to pointing
 */
export async function pickShape(llm, { shot, box, target, physical, signal } = {}) {
  if (!llm?.respond || !jpeg || !shot?.raw?.data || !target) return null;
  const shapes = shapesIn(shot.raw, box);
  if (shapes.length < 1 || shapes.length > 60) return null;
  const shown = Math.min(1600, box.width);
  const img = downscale(crop(shot.raw, box), box.width, box.height, shown);
  const s = img.width / box.width;
  shapes.forEach((sh, i) => {
    const x = (sh.rect[0] - box.x) * s; const y = (sh.rect[1] - box.y) * s;
    const w = sh.rect[2] * s; const h = sh.rect[3] * s;
    const c = [255, 0, 160];
    fillRect(img, x - 2, y - 2, w + 4, 2, c); fillRect(img, x - 2, y + h, w + 4, 2, c);
    fillRect(img, x - 2, y - 2, 2, h + 4, c); fillRect(img, x + w, y - 2, 2, h + 4, c);
    const n = i + 1;
    const lw = (String(n).length * 12) + 4;
    const lx = Math.max(0, Math.min(img.width - lw, x - 2));
    const ly = Math.max(0, y - 20);
    fillRect(img, lx, ly, lw, 18, [20, 20, 20]);
    drawNumber(img, n, lx + 3, ly + 2, 2, [255, 255, 255]);
  });
  const data = jpeg.encode(img, 85).data;
  try {
    const out = await llm.respond({
      model: llm.tiers.see,
      system: 'You are shown part of a Windows screen. The separate things in it have magenta boxes with numbers. '
        + 'Say which number is on the box around the target. Read the thing inside each box, not only the number. 0 if none holds it.',
      content: [
        { type: 'text', text: `Target: ${target}` },
        { type: 'image', b64: Buffer.from(data).toString('base64'), mime: 'image/jpeg', detail: 'high' },
      ],
      tools: PICK_TOOL,
      maxTokens: 60,
      signal,
    });
    const n = Number(out?.call?.args?.number);
    const sh = Number.isInteger(n) && n >= 1 ? shapes[n - 1] : null;
    if (!sh) return null;
    const p = { x: sh.rect[0] + (sh.rect[2] / 2), y: sh.rect[1] + (sh.rect[3] / 2) };
    return { ...p, moved: physical ? Math.hypot(p.x - physical.x, p.y - physical.y) : 0, shapes: shapes.length };
  } catch { return null; }
}

const POINT_TOOL = [{
  type: 'function',
  function: {
    name: 'point',
    description: 'Say exactly where the target is in this enlarged picture.',
    parameters: {
      type: 'object',
      properties: {
        found: { type: 'boolean', description: 'False if the target is not in this picture at all.' },
        x: { type: 'integer', description: 'Horizontal centre of the target, in this picture\'s pixels. Use the rulers.' },
        y: { type: 'integer', description: 'Vertical centre of the target, in this picture\'s pixels. Use the rulers.' },
      },
      required: ['found'],
    },
  },
}];

/**
 * Refine a rough point.
 *
 * @param {object} llm
 * @param {object} opts
 * @param {object} opts.shot     the shot the rough point was given on
 * @param {{x:number,y:number}} opts.physical  the rough point, physical pixels
 * @param {string} opts.target   what the model said it was aiming at
 * @returns {Promise<{x:number,y:number,moved:number}|null>} physical pixels, or null to keep the rough point
 */
export async function refine(llm, { shot, physical, target, signal, box: within = null, crop = CROP, shown = SHOWN } = {}) {
  if (!llm?.respond || !shot?.raw?.data || !target) return null;
  /* Either around a rough point, or — when the model pointed at a whole
     picture by its mark — the picture itself, kept on screen. */
  const box = within
    ? (() => {
      const o = shot.origin ?? { x: 0, y: 0 };
      const x = Math.max(o.x, Math.round(within[0]));
      const y = Math.max(o.y, Math.round(within[1]));
      return { x, y, width: Math.min(o.x + shot.physical.width - x, Math.round(within[2])), height: Math.min(o.y + shot.physical.height - y, Math.round(within[3])) };
    })()
    : cropBox(physical, shot.physical, crop, shot.origin ?? { x: 0, y: 0 });
  const picture = zoomImage(shot.raw, box, within ? Math.min(1600, box.width) : shown);
  if (!picture) return null;
  try {
    const out = await llm.respond({
      model: llm.tiers.see,
      system: [
        'You are shown an enlarged part of a Windows screen, with numbered pixel rulers along the top and left.',
        `The picture is ${picture.width} by ${picture.height} pixels.`,
        'Find the target and give the pixel at its centre, reading the rulers. If it is not in the picture, say found false.',
      ].join('\n'),
      content: [
        { type: 'text', text: `Target: ${target}` },
        { type: 'image', b64: picture.b64, mime: picture.mime, detail: 'high' },
      ],
      tools: POINT_TOOL,
      maxTokens: 200,
      signal,
    });
    const a = out?.call?.args;
    if (!a?.found || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
    if (a.x < 0 || a.y < 0 || a.x >= picture.width || a.y >= picture.height) return null;
    const p = fromZoom(a, box, picture.width);
    return { ...p, moved: Math.hypot(p.x - physical.x, p.y - physical.y) };
  } catch { return null; }
}
