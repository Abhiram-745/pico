#!/usr/bin/env node
/* ==========================================================================
   Measuring how far a scroll went, on made-up frames where the answer is
   known: a varied page, a sticky header that does not move, and a list of
   identical rows where only the expected distance can pick the right one.

   Run with: node scripts/test-scroll.mjs
   ========================================================================== */

import { measureShift, scrollBy } from '../bridge/scroll.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

const W = 900;
const H = 1000;

/** A tall "document" of rows, each a function of its own index. */
function page(total, rowAt) {
  const data = Buffer.alloc(W * total * 4);
  for (let y = 0; y < total; y++) {
    for (let x = 0; x < W; x++) {
      const v = rowAt(x, y);
      const i = ((y * W) + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return data;
}

/** The view of that document scrolled to `top`, with an optional fixed header. */
function view(doc, top, header = 0) {
  const data = Buffer.alloc(W * H * 4);
  doc.copy(data, 0, top * W * 4, (top + H) * W * 4);
  for (let y = 0; y < header; y++) {
    for (let x = 0; x < W; x += 1) {
      const i = ((y * W) + x) * 4;
      const v = (x >> 3) % 2 ? 40 : 200;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  return { data, width: W, height: H };
}

// Varied content: blocks of "text" of different lengths, headings, gaps.
const hash = (n) => { let t = (n + 0x6D2B79F5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const varied = page(6000, (x, y) => {
  const line = Math.floor(y / 22);
  const inGlyph = (y % 22) > 5 && (y % 22) < 17;
  const len = 200 + (hash(line) * 650);
  if (line % 13 === 0) return (y % 22) > 3 && x < 500 ? 30 : 255;       // a heading
  if (hash(line * 7) < 0.12) return 255;                                  // a gap
  if (!inGlyph || x > len) return 255;
  return hash((line * 1000) + Math.floor(x / 9)) < 0.55 ? 60 : 245;       // words
});

const region = { x: 0, y: 0, width: W, height: H };
for (const [from, shift] of [[0, 125], [500, 250], [1000, 377], [2000, 440], [3000, -300], [3100, 1]]) {
  const m = measureShift(view(varied, from), view(varied, from + shift), region, {});
  check(`varied page, moved ${shift}px: measured ${m?.shift}`, m && Math.abs(m.shift - shift) <= 1, JSON.stringify(m));
}
{
  const m = measureShift(view(varied, 800), view(varied, 800), region, {});
  check(`nothing moved: measured ${m?.shift} with confidence ${m?.confidence?.toFixed(2)}`, m && m.shift === 0 && m.confidence < 0.05, JSON.stringify(m));
}
{
  const m = measureShift(view(varied, 1200, 90), view(varied, 1200 + 260, 90), region, {});
  check(`sticky header does not hold it at zero: measured ${m?.shift}`, m && Math.abs(m.shift - 260) <= 1, JSON.stringify(m));
}

// Identical rows 45px apart, differing only in a tiny "digit".
const rows = page(6000, (x, y) => {
  const row = Math.floor(y / 45);
  const inRow = y % 45;
  if (inRow === 44) return 210;                                           // divider
  if (inRow > 14 && inRow < 30 && x > 40 && x < 200) return 70;           // "Customer"
  if (inRow > 14 && inRow < 30 && x > 210 && x < 230) return ((row % 10) * 20) + 20;  // the digit
  return 250;
});
for (const shift of [125, 250, 375]) {
  const m = measureShift(view(rows, 900), view(rows, 900 + shift), region, { expected: shift + 3 });
  check(`identical rows, moved ${shift}px, expected ~${shift + 3}: measured ${m?.shift}`, m && Math.abs(m.shift - shift) <= 1, JSON.stringify(m));
}

// The loop itself, against a fake window: a notch is 100px here.
{
  let top = 1000;
  let turns = 0;
  let reversals = 0;
  let lastSign = 0;
  const io = {
    sense: null,
    frame: async () => view(varied, top),
    wheel: async (x, y, units) => {
      turns += 1;
      if (lastSign && Math.sign(units) !== lastSign) reversals += 1;
      lastSign = Math.sign(units);
      top = Math.max(0, Math.min(6000 - H, top + Math.round((units / 120) * 100)));
    },
  };
  const r = await scrollBy(io, { point: { x: 450, y: 500 }, axis: 'y', distance: 0.8, screens: true, scale: 1 });
  // Whole 100px notches cannot land nearer than 50px to what was asked.
  check(`scroll 0.8 of the view with 100px notches: asked ${r.requested}, moved ${r.moved} in ${turns} turns`,
    Math.abs(r.moved - r.requested) <= 50 && Math.abs((top - 1000) - r.moved) <= 2, JSON.stringify({ ...r, frame: undefined, top }));
  check(`and without twitching back and forth (${reversals} reversals)`, reversals === 0 && turns <= 4);

  top = 6000 - H - 150;
  const end = await scrollBy(io, { point: { x: 450, y: 500 }, axis: 'y', distance: 1, screens: true, scale: 1 });
  check(`near the bottom: moved ${end.moved}, reports the end`, end.atEnd && Math.abs(end.moved - 150) <= 2, JSON.stringify({ ...end, frame: undefined }));
}

// A panel inside the window — a chat list, an inbox — is what scrolls, and
// "a screen" of it is its own height, not the window's.
{
  let top = 800;
  const PANEL = { y: 260, h: 500 };
  const io = {
    sense: null,
    frame: async () => {
      const outer = view(varied, 3000);                  // the static rest of the window
      const inner = view(varied, top);
      for (let y = 0; y < PANEL.h; y++) {
        inner.data.copy(outer.data, (PANEL.y + y) * W * 4, y * W * 4, (y + 1) * W * 4);
      }
      return outer;
    },
    wheel: async (x, y, units) => { top = Math.max(0, top + Math.round((units / 120) * 100)); },
  };
  const r = await scrollBy(io, { point: { x: 450, y: 480 }, axis: 'y', distance: 0.8, screens: true, scale: 1 });
  check(`0.8 of a 500px panel in a 1000px window: moved ${r.moved} (panel measured ${r.view}px)`,
    Math.abs(r.moved - 400) <= 60 && Math.abs(r.view - PANEL.h) <= 60, JSON.stringify({ ...r, frame: undefined, top }));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
