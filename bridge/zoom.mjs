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
export function cropBox(point, physical, size = CROP) {
  const w = Math.min(size, physical.width);
  const h = Math.min(size, physical.height);
  const x = Math.round(Math.max(0, Math.min(physical.width - w, point.x - (w / 2))));
  const y = Math.round(Math.max(0, Math.min(physical.height - h, point.y - (h / 2))));
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
  for (let row = 0; row < box.height; row++) {
    const from = (((box.y + row) * raw.width) + box.x) * 4;
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
      const x = Math.max(0, Math.round(within[0]));
      const y = Math.max(0, Math.round(within[1]));
      return { x, y, width: Math.min(shot.physical.width - x, Math.round(within[2])), height: Math.min(shot.physical.height - y, Math.round(within[3])) };
    })()
    : cropBox(physical, shot.physical, crop);
  const picture = zoomImage(shot.raw, box, within ? Math.min(SHOWN, box.width) : shown);
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
