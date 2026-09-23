/* ==========================================================================
   Halo — numbered marks: the model says which, Windows says where.

   Measured in this repository (llm.mjs): asked for the pixel coordinates of a
   control, gpt-4o and gpt-4.1-mini put 0 of 8 clicks inside the target, the
   mini a median 962 pixels away. They are not bad at seeing: they are bad at
   turning what they see into a number of pixels. Asked instead "which of
   these numbered boxes is the Save button", the same models read the label
   off the picture — reading a number is something they do well.

   So every control UI Automation reports is drawn onto the screenshot as a
   box with a number, the same numbers are listed in words beside it, and the
   model answers with a number. The click goes to the middle of the rectangle
   Windows gave for that number: exact, whatever the model's sense of
   geometry. Raw coordinates stay as a fallback for things nothing is marked
   on (canvases, games), and those go through zoom.mjs.

   The technique is Set-of-Mark prompting (Yang et al., 2023), used by most
   of the desktop agents that work with small models.
   ========================================================================== */

import { createRequire } from 'node:module';
import { downscale } from './screen.mjs';

const require = createRequire(import.meta.url);
let jpeg = null;
try { jpeg = require('jpeg-js'); } catch { /* marks fall back to the plain picture */ }

/** Most marks one picture carries. Beyond this the labels start covering what
    they label, and the list stops being read. */
export const MAX_MARKS = 90;

/* Controls first, then the words and places a job may need to point at: a
   card on a board is text, not a button, and a board's column is a group. */
const PLACE_TYPES = new Set(['Group', 'List', 'Pane', 'Custom', 'Table', 'DataGrid', 'Tree', 'Document']);

const inside = (outer, r) => r[0] >= outer[0] - 2 && r[1] >= outer[1] - 2
  && r[0] + r[2] <= outer[0] + outer[2] + 2 && r[1] + r[3] <= outer[1] + outer[3] + 2;

/**
 * One numbered list from what the window reports.
 *
 * @param {object} seen      sense.look() output: { elements, texts?, places? }
 * @param {object} opts
 * @param {number[]} [opts.within]  the work window's rect; marks outside it are dropped
 * @returns {Array<{n:number, kind:'control'|'text'|'place', role:string, name:string, rect:number[], value?:string, checked?:boolean}>}
 */
export function buildMarks(seen, { within = null, max = MAX_MARKS } = {}) {
  const marks = [];
  const taken = [];
  const add = (kind, el) => {
    if (marks.length >= max) return;
    const r = el?.rect;
    if (!Array.isArray(r) || r.length !== 4 || r[2] < 4 || r[3] < 4) return;
    if (el.offscreen || el.enabled === false) return;
    if (within && !inside(within, r)) return;
    const name = String(el.name ?? el.text ?? '').replace(/\s+/g, ' ').trim();
    if (!name && kind !== 'control') return;
    // The same box reported twice (a tree lists a control under each parent
    // that claims it) is one mark, not two numbers for one thing.
    if (taken.some((t) => t.every((v, i) => Math.abs(v - r[i]) <= 4))) return;
    taken.push(r);
    const m = { n: marks.length + 1, kind, role: el.type || kind, name: name.slice(0, 80), rect: r.map(Math.round) };
    if (typeof el.value === 'string' && el.value) m.value = el.value.slice(0, 80);
    if (typeof el.checked === 'boolean') m.checked = el.checked;
    if (Array.isArray(el.range) && el.range.length === 3 && el.range.every(Number.isFinite)) m.range = el.range;
    marks.push(m);
  };

  const elements = Array.isArray(seen?.elements) ? seen.elements : [];
  /* The window's own frame buttons are never what a job means — by id where
     the app gives one, and by name and place (the top-right corner) where it
     does not, as Chrome does not. Nor is a pane the size of the whole window. */
  const frame = (el) => ['Close', 'Minimize', 'Maximize', 'Restore'].includes(String(el.id || ''))
    || (within && el.type === 'Button' && /^(?:minimi[sz]e|maximi[sz]e|restore|close)$/i.test(String(el.name || '').trim())
      && el.rect?.[1] < within[1] + 50 && el.rect?.[0] > within[0] + within[2] - 260);
  const wholeWindow = (el) => within && Array.isArray(el.rect)
    && el.rect[2] * el.rect[3] >= 0.85 * within[2] * within[3];
  const usable = elements.filter((el) => !frame(el) && !wholeWindow(el));
  /* The page first. In a browser the numbered list used to open with
     fourteen of Chrome's own buttons, and a small model reading "the first
     few are what matters" dragged Chrome's tab strip instead of a card. What
     is inside the document gets the low numbers; the browser around it
     follows. */
  // The page itself is usually most of the window, so it is looked for among
  // everything, not only what survived the whole-window filter.
  const doc = elements.filter((el) => el.type === 'Document' && Array.isArray(el.rect) && !el.offscreen)
    .sort((a, b) => (b.rect[2] * b.rect[3]) - (a.rect[2] * a.rect[3]))[0];
  const inDoc = (el) => Boolean(doc && Array.isArray(el.rect) && inside(doc.rect, el.rect));
  const pageFirst = (list) => (doc ? [...list.filter(inDoc), ...list.filter((el) => !inDoc(el))] : list);
  const texts = (seen?.texts ?? []).map((el) => ({ ...el, type: 'Text' }));
  const places = [...usable.filter((el) => PLACE_TYPES.has(el.type) && el !== doc), ...(seen?.places ?? []).filter((el) => !wholeWindow(el))];

  for (const el of pageFirst(usable.filter((e) => !PLACE_TYPES.has(e.type)))) if (inDoc(el) || !doc) add('control', el);
  for (const el of pageFirst(texts)) if (inDoc(el) || !doc) add('text', el);
  for (const el of pageFirst(places)) if (inDoc(el) || !doc) add('place', el);
  // Then everything around the page: the browser's own address bar, tabs, back.
  if (doc) {
    for (const el of usable.filter((e) => !PLACE_TYPES.has(e.type) && !inDoc(e))) add('control', el);
    for (const el of texts.filter((e) => !inDoc(e))) add('text', el);
  }
  return marks;
}

/** The list the model reads beside the picture, one mark per line. */
export function describeMarks(marks) {
  return marks.map((m) => {
    const bits = [`[${m.n}] ${m.role}`, m.name ? JSON.stringify(m.name) : '(no name)'];
    if (m.value !== undefined) bits.push(`value ${JSON.stringify(m.value)}`);
    if (m.checked !== undefined) bits.push(m.checked ? 'checked' : 'not checked');
    if (m.range) bits.push(`at ${m.range[2]} (from ${m.range[0]} to ${m.range[1]}) — use set_value`);
    return bits.join(' ');
  }).join('\n');
}

/** The mark's rectangle as a point in screenshot space: its middle, or for
    text an edge, when a selection has to start or end on it. */
export function markPoint(mark, shot, where = 'centre') {
  const [x, y, w, h] = mark.rect;
  const px = where === 'start' ? x + Math.min(3, w / 4) : where === 'end' ? x + w - Math.min(3, w / 4) : x + (w / 2);
  const py = y + (h / 2);
  if (shot.fromPhysical) return shot.fromPhysical(px, py);
  return {
    x: Math.round((px * shot.width) / shot.physical.width),
    y: Math.round((py * shot.height) / shot.physical.height),
  };
}

/* --- drawing --------------------------------------------------------------- */

/* 5x7 digits. A font file and a text renderer would be a dependency for ten
   glyphs; these are the ten glyphs. */
const DIGITS = [
  '01110100011001110101110011000101110', '00100011000010000100001000010001110',
  '01110100010000100010001000100011111', '11110000010000101110000010000111110',
  '00010001100101010010111110001000010', '11111100001111000001000011000101110',
  '00110010001000011110100011000101110', '11111000010001000100010000100001000',
  '01110100011000101110100011000101110', '01110100011000101111000010001001100',
];

/* Strong, distinct, and each dark enough for white numbers on it. Controls
   cycle through them so neighbours differ; text and places have their own so
   the model can tell a button from a label at a glance. */
const CONTROL_COLOURS = [[220, 38, 38], [37, 99, 235], [22, 163, 74], [217, 119, 6], [147, 51, 234], [8, 145, 178], [190, 24, 93], [77, 124, 15]];
const TEXT_COLOUR = [71, 85, 105];
const PLACE_COLOUR = [15, 118, 110];

export function fillRect(img, x, y, w, h, [r, g, b]) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    let i = ((yy * img.width) + x0) * 4;
    for (let xx = x0; xx < x1; xx++, i += 4) { img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; }
  }
}

function outline(img, x, y, w, h, colour, t = 2, dashed = false) {
  const segs = (len, fn) => {
    if (!dashed) { fn(0, len); return; }
    for (let s = 0; s < len; s += 8) fn(s, Math.min(4, len - s));
  };
  segs(w, (s, l) => { fillRect(img, x + s, y, l, t, colour); fillRect(img, x + s, y + h - t, l, t, colour); });
  segs(h, (s, l) => { fillRect(img, x, y + s, t, l, colour); fillRect(img, x + w - t, y + s, t, l, colour); });
}

export function drawNumber(img, n, x, y, scale, colour) {
  const text = String(n);
  for (let c = 0; c < text.length; c++) {
    const glyph = DIGITS[text.charCodeAt(c) - 48];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[(gy * 5) + gx] === '1') fillRect(img, x + (c * 6 * scale) + (gx * scale), y + (gy * scale), scale, scale, colour);
      }
    }
  }
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Draw the marks onto a copy of the shot's picture.
 *
 * Works from the full-resolution frame the shot kept, scaled the same way the
 * plain picture was, so a mark sits on exactly the pixels the model sees.
 *
 * @returns {{b64:string, mime:string}|null}  null when it cannot draw
 */
export function drawMarks(shot, marks, { quality = 80, width = null } = {}) {
  if (!jpeg || !shot?.raw?.data || !marks.length) return null;
  const raw = shot.raw;
  const w = Math.min(raw.width, width ?? shot.width);
  const img = w === raw.width
    ? { data: Buffer.from(raw.data), width: raw.width, height: raw.height }
    : downscale(raw.data, raw.width, raw.height, w);
  const sx = img.width / raw.width;
  const sy = img.height / raw.height;
  const scale = img.width >= 1200 ? 2 : 1;
  const labelH = (7 * scale) + 4;
  const placed = [];

  /* Places first and underneath: a column's outline behind the cards in it,
     never on top of their numbers. */
  const order = [...marks].sort((a, b) => (a.kind === 'place' ? 0 : 1) - (b.kind === 'place' ? 0 : 1));
  for (const m of order) {
    const colour = m.kind === 'text' ? TEXT_COLOUR : m.kind === 'place' ? PLACE_COLOUR : CONTROL_COLOURS[m.n % CONTROL_COLOURS.length];
    // Rectangles are in desktop pixels; the picture is of one display.
    const x = (m.rect[0] - (shot.origin?.x ?? 0)) * sx;
    const y = (m.rect[1] - (shot.origin?.y ?? 0)) * sy;
    const w = Math.max(3, m.rect[2] * sx);
    const h = Math.max(3, m.rect[3] * sy);
    outline(img, x, y, w, h, colour, m.kind === 'control' ? 2 : 1, m.kind !== 'control');

    const labelW = (String(m.n).length * 6 * scale) + 3;
    /* Where the number goes: on the box's top-left corner, or just outside
       it, whichever does not sit on another number. A label on top of a
       label is a number nobody can read. */
    const spots = [
      { x: x - 1, y: y - labelH + 1 },
      { x: x - labelW, y },
      { x: x + 1, y: y + 1 },
      { x: x + w - labelW, y: y - labelH + 1 },
      { x: x - 1, y: y + h - 1 },
    ].map((p) => ({ x: Math.max(0, Math.min(img.width - labelW, p.x)), y: Math.max(0, Math.min(img.height - labelH, p.y)), w: labelW, h: labelH }));
    const spot = spots.find((s) => !placed.some((p) => overlaps(s, p))) ?? spots[0];
    placed.push(spot);
    fillRect(img, spot.x, spot.y, spot.w, spot.h, colour);
    drawNumber(img, m.n, spot.x + 2, spot.y + 2, scale, [255, 255, 255]);
  }

  const encoded = jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data;
  return { b64: Buffer.from(encoded).toString('base64'), mime: 'image/jpeg', width: img.width, height: img.height };
}

/**
 * Turn a mark chosen by the model into the action's coordinates.
 * Mutates and returns `action`; anything it cannot resolve is left alone for
 * the ordinary checks to complain about.
 */
export function resolveMarks(action, marks, shot) {
  if (!action || !Array.isArray(marks) || !marks.length) return action;
  const byN = (n) => marks.find((m) => m.n === Number(n)) ?? null;
  const from = Number.isFinite(Number(action.mark)) ? byN(action.mark) : null;
  const to = Number.isFinite(Number(action.to_mark)) ? byN(action.to_mark) : null;

  if (from) {
    const selecting = action.type === 'select_text' || action.action === 'select_text';
    const p = markPoint(from, shot, selecting ? 'start' : 'centre');
    action.x = p.x;
    action.y = p.y;
    action.markedAs = from;
    /* A control's middle is exact — there is nothing for the aim layer to
       improve. Text and places keep aiming: a click into a text run or a
       drop onto a column wants the point, not the middle of a big box. */
    if (from.kind === 'control' && !selecting) action.exact = true;
    if (!action.target) action.target = `${from.role} "${from.name}"`;
    /* Selecting a single run of text: from its first character to its last. */
    if (selecting && !to && !Number.isFinite(action.to_x)) {
      const e = markPoint(from, shot, 'end');
      action.to_x = e.x;
      action.to_y = e.y;
    }
  }
  if (to) {
    const selecting = action.type === 'select_text' || action.action === 'select_text';
    const p = markPoint(to, shot, selecting ? 'end' : 'centre');
    action.to_x = p.x;
    action.to_y = p.y;
    action.toMarkedAs = to;
  }
  return action;
}
