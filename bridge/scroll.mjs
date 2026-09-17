/* ==========================================================================
   Halo — scrolling a measured distance.

   A mouse wheel does not scroll a distance. It scrolls a number of notches,
   and what a notch is worth is up to the application: 125 pixels in Chrome on
   this display, three lines in Word, three rows in Explorer, something else
   in every list anybody ever wrote. So "scroll down a screen" cannot be
   turned into a number of notches in advance, by anybody.

   It can be measured. Scroll a first estimate, compare the screen before and
   after to see how far the content really moved, learn what a notch is worth
   here, and make up the difference. The model is then told what happened in
   the terms it asked in — "moved 1,020px, about 0.8 of the view" or "that is
   the bottom" — rather than being left to guess from a picture whether the
   scroll did anything.

   WHAT WAS WRONG BEFORE
   nut-js's scrollDown(n) sends a wheel delta of n, and one notch is a delta
   of 120. Halo sent between 1 and 12. Its largest possible scroll moved a
   page about thirteen pixels, and its smallest moved nothing at all.
   ========================================================================== */

/** One notch of a wheel, in the units Windows uses. */
export const WHEEL_DELTA = 120;

/**
 * How far did the content move between two frames?
 *
 * Both frames are raw RGBA at physical resolution. Only `region` is compared
 * — the scrolling area, or failing that the window under the pointer — and
 * the answer is the vertical (or horizontal) offset that best lines the
 * second frame up with the first. Positive means the content moved up (or
 * left): the view scrolled down (or right).
 *
 * Row signatures rather than pixels: each row is reduced to a strip of
 * column-bin brightnesses, so the search compares a few dozen numbers per row
 * instead of a thousand pixels. The mean over rows is trimmed, so a sticky
 * header or a blinking caret — the parts that do not move with the content —
 * cannot outvote the parts that do.
 *
 * Lists repeat themselves: a column of identical rows lines up just as well
 * one row further on. `expected`, when given, breaks those ties towards the
 * distance that was actually asked for.
 *
 * @returns {{shift:number, confidence:number}|null}
 */
export function measureShift(before, after, region, { axis = 'y', expected = null, maxShift = null } = {}) {
  if (!before || !after || before.width !== after.width || before.height !== after.height) return null;

  const W = before.width;
  const H = before.height;
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(W, Math.round(region.x + region.width));
  const y1 = Math.min(H, Math.round(region.y + region.height));
  if (x1 - x0 < 40 || y1 - y0 < 40) return null;

  // Work along the scrolling axis; the other axis is summarised into bins.
  const vertical = axis === 'y';
  const len = vertical ? (y1 - y0) : (x1 - x0);         // pixels along the axis
  const span = vertical ? (x1 - x0) : (y1 - y0);        // extent across it

  /* Two levels of the same picture.
     Fine: a line every pixel, a bin every ~6px — sharp enough to place an
     offset to the pixel, and sharp enough to be fooled by a list whose rows
     differ only by a digit.
     Coarse: 8px lines, 3x wider bins — the text blurs into grey bands and
     what is left is the larger shape of the page: a heading, a striped row,
     a picture, a gap. That shape repeats far less often than rows do, so it
     settles which of the look-alike offsets is the real one. */
  const STEP = 1;
  const lines = Math.floor(len / STEP);
  const bins = Math.max(32, Math.min(160, Math.floor(span / 6)));
  const binOf = new Uint16Array(span);
  for (let a = 0; a < span; a++) binOf[a] = Math.min(bins - 1, Math.floor((a * bins) / span));

  const signature = (frame) => {
    const out = new Float32Array(lines * bins);
    const counts = new Float32Array(bins);
    const d = frame.data;
    for (let li = 0; li < lines; li++) {
      const along = li * STEP;
      counts.fill(0);
      const base = li * bins;
      for (let a = 0; a < span; a += 2) {
        const i = vertical ? (((y0 + along) * W) + x0 + a) * 4 : (((y0 + a) * W) + x0 + along) * 4;
        const b = binOf[a];
        out[base + b] += (d[i] * 0.3) + (d[i + 1] * 0.59) + (d[i + 2] * 0.11);
        counts[b] += 1;
      }
      for (let b = 0; b < bins; b++) if (counts[b]) out[base + b] /= counts[b];
    }
    return out;
  };

  const shrink = (fine, factorL, factorB) => {
    const L = Math.floor(lines / factorL);
    const Bn = Math.floor(bins / factorB);
    const out = new Float32Array(L * Bn);
    for (let l = 0; l < L; l++) {
      for (let b = 0; b < Bn; b++) {
        let sum = 0;
        for (let dl = 0; dl < factorL; dl++) {
          const row = (l * factorL + dl) * bins;
          for (let db = 0; db < factorB; db++) sum += fine[row + (b * factorB) + db];
        }
        out[(l * Bn) + b] = sum / (factorL * factorB);
      }
    }
    return { data: out, lines: L, bins: Bn };
  };

  const fineA = { data: signature(before), lines, bins };
  const fineB = { data: signature(after), lines, bins };
  const coarseA = shrink(fineA.data, 8, 3);
  const coarseB = shrink(fineB.data, 8, 3);

  /* A line that is flat — blank space — says nothing about where anything
     went and matches every offset equally well, so it does not vote. */
  const texturedLines = (sig, min) => {
    const out = [];
    for (let li = 0; li < sig.lines; li++) {
      let lo = 255; let hi = 0;
      for (let b = 0; b < sig.bins; b++) {
        const v = sig.data[(li * sig.bins) + b];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo >= min) out.push(li);
    }
    return out;
  };

  /* Mean line difference at offset s (in lines of that level), trimmed so
     the worst fifth — a sticky header, a caret, an animation — do not get a
     say. after[li] is compared with before[li + s]. */
  const makeCost = (a, b, textured, share = 0.9) => {
    const scratch = new Float32Array(a.lines);
    return (s) => {
      let n = 0;
      for (const li of textured) {
        const src = li + s;
        if (src < 0 || src >= a.lines) continue;
        let diff = 0;
        const ai = src * a.bins;
        const bi = li * a.bins;
        for (let k = 0; k < a.bins; k++) diff += Math.abs(a.data[ai + k] - b.data[bi + k]);
        scratch[n++] = diff / a.bins;
      }
      if (n < Math.max(4, textured.length * 0.12)) return Infinity;
      const used = scratch.subarray(0, n).sort();
      const keep = Math.max(3, Math.floor(n * share));
      let sum = 0;
      for (let k = 0; k < keep; k++) sum += used[k];
      return sum / keep;
    };
  };

  /* A gentle pull towards the distance that was asked for: enough to choose
     between look-alike offsets, never enough to override a clear answer. */
  const pull = (px, c) => {
    if (expected == null || !Number.isFinite(c)) return c;
    const off = Math.abs(px - expected) / Math.max(80, Math.abs(expected));
    return c * (1 + (0.25 * Math.min(1, off)));
  };

  /* Only lines that changed get a say in how far things moved. A header, a
     sidebar, the rest of a window around a scrolling panel: all of it lines
     up perfectly at "nothing moved", and where it is most of the picture it
     outvotes the panel that did move. Unchanged lines prove only that they
     did not scroll, which is already known once anything else has. */
  const changedOnly = (sig, list, min) => {
    const out = list.filter((li) => {
      let d = 0;
      const base = li * sig.b.bins;
      for (let k = 0; k < sig.b.bins; k++) d += Math.abs(sig.a.data[base + k] - sig.b.data[base + k]);
      return d / sig.b.bins > min;
    });
    return out;
  };
  const allCoarse = texturedLines(coarseB, 3);
  const allFine = texturedLines(fineB, 6);
  if (allFine.length < 10) return null;
  const movedFine = changedOnly({ a: fineA, b: fineB }, allFine, 3);
  if (movedFine.length === 0) {
    return { shift: 0, confidence: 0, distinct: 1, ambiguous: false, still: 0, cost: 0, extent: null };
  }
  const movedCoarse = changedOnly({ a: coarseA, b: coarseB }, allCoarse, 2);
  const fineTex = movedFine.length >= 10 ? movedFine : allFine;
  const coarseTex = movedCoarse.length >= 6 ? movedCoarse : allCoarse;
  const coarseCost = makeCost(coarseA, coarseB,
    coarseTex.length >= 6 ? coarseTex : Array.from({ length: coarseB.lines }, (_, i) => i));
  const fineCost = makeCost(fineA, fineB, fineTex);

  const CL = 8 * STEP;                                   // pixels per coarse line
  const limitPx = Math.min(len * 0.85, maxShift ?? len);
  const limitC = Math.floor(limitPx / CL);

  const ranked = [];
  for (let s = -limitC; s <= limitC; s++) {
    const c = pull(s * CL, coarseCost(s));
    if (Number.isFinite(c)) ranked.push([s * CL, c]);
  }
  ranked.sort((p, q) => p[1] - q[1]);

  // The best few coarse answers, kept apart so they are real alternatives.
  const seeds = [];
  for (const [px] of ranked) {
    if (seeds.every((q) => Math.abs(q - px) > CL * 2)) seeds.push(px);
    if (seeds.length >= 4) break;
  }
  seeds.push(0);
  if (expected != null) seeds.push(Math.round(expected / STEP) * STEP);

  let best = 0;
  let bestCost = Infinity;
  const tried = new Map();        // offset -> cost with the pull applied
  const plain = new Map();        // offset -> cost without it
  for (const seed of seeds) {
    for (let px = seed - (CL + 3); px <= seed + CL + 3; px += STEP) {
      if (Math.abs(px) > limitPx || tried.has(px)) continue;
      const raw = fineCost(px / STEP);
      const c = pull(px, raw);
      plain.set(px, raw);
      tried.set(px, c);
      if (c < bestCost) { bestCost = c; best = px; }
    }
  }
  if (!Number.isFinite(bestCost)) return null;

  /* Dead heats. Trimming drops the worst lines, and at an offset one pixel
     from the truth the worst lines are exactly the ones that differ — so on
     very even content two neighbouring offsets can both score perfectly.
     Every line gets a vote to settle it, and "nothing moved" wins a tie. */
  const fineFull = makeCost(fineA, fineB, fineTex, 1);
  const heat = [...tried].filter(([, c]) => c <= (bestCost * 1.02) + 0.02).map(([px]) => px);
  if (heat.length > 1) {
    let top = Infinity;
    for (const px of heat) {
      const c = fineFull(px / STEP) + (px === 0 ? -1e-6 : 0);
      if (c < top) { top = c; best = px; }
    }
    bestCost = tried.get(best);
  }

  /* Look-alikes. Where the content repeats exactly — a column of rows the
     same height, differing only by a digit — several offsets fit almost as
     well as the true one, and which of them scores best is noise. When that
     is so, and there is a distance that was asked for, the look-alike
     nearest to it is the answer: a notch estimate is wrong by a few pixels,
     never by a whole row. */
  let ambiguous = false;
  if (expected != null) {
    const minima = [];
    for (const [px, c] of plain) {
      if (!Number.isFinite(c)) continue;
      const left = plain.get(px - STEP);
      const right = plain.get(px + STEP);
      if ((left === undefined || c <= left) && (right === undefined || c <= right)) minima.push([px, c]);
    }
    minima.sort((p, q) => p[1] - q[1]);
    const floor = minima[0]?.[1] ?? Infinity;
    const peers = minima.filter(([, c]) => c <= (floor * 1.4) + 0.4);
    if (peers.length > 1) {
      ambiguous = true;
      peers.sort((p, q) => Math.abs(p[0] - expected) - Math.abs(q[0] - expected));
      [best] = peers[0];
      bestCost = tried.get(best);
    }
  }

  // Runner-up that is genuinely somewhere else: a close second means the
  // answer was a coin toss between look-alikes.
  let second = Infinity;
  for (const [px, c] of tried) if (Math.abs(px - best) > 12 && c < second) second = c;

  // How much better the chosen offset explains the second frame than
  // "nothing moved" does. A screen that did not move scores about zero.
  const still = fineCost(0);
  const confidence = Number.isFinite(still) && still > 0
    ? Math.max(0, Math.min(1, (still - bestCost) / still))
    : 0;

  /* Which part moved. A chat list, a message pane, the inbox beside a
     reading pane: in most apps it is a panel that scrolls, not the window,
     and "a screen" of that panel is its height, not the window's. Lines the
     offset explains better than "nothing moved" belong to it; the span from
     the first to the last of them is the panel, give or take its padding. */
  let extent = null;
  if (best !== 0 && confidence >= 0.3) {
    let first = -1;
    let last = -1;
    for (const li of fineTex) {
      const src = li + (best / STEP);
      if (src < 0 || src >= lines) continue;
      let moving = 0;
      let staying = 0;
      const bi = li * bins;
      for (let k = 0; k < bins; k++) {
        const b = fineB.data[bi + k];
        moving += Math.abs(fineA.data[(src * bins) + k] - b);
        staying += Math.abs(fineA.data[bi + k] - b);
      }
      // A real match, not merely a less bad one: content that scrolled in
      // matches nothing, and against nothing either comparison can win.
      if (moving / bins < 5 && moving + (bins * 2) < staying) {
        if (first < 0) first = li;
        last = li;
      }
    }
    // Line numbers in the second frame. The stretch that scrolled into view
    // is new — it matches nothing in the first frame — and belongs to the
    // panel too: below the moved lines when scrolling down, above them up.
    if (first >= 0 && last > first) {
      extent = best > 0
        ? { start: first * STEP, end: (last * STEP) + best }
        : { start: Math.max(0, (first * STEP) + best), end: last * STEP };
    }
  }

  return {
    shift: best,
    confidence,
    distinct: Number.isFinite(second) && second > 0 ? Math.max(0, Math.min(1, (second - bestCost) / second)) : 1,
    ambiguous,
    still,
    cost: bestCost,
    extent,
  };
}

/* --------------------------------------------------------------------------
   Scrolling a distance
   -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a notch has turned out to be worth, per application. Physical px. */
const learned = new Map();

/** Browsers and Electron apps take a fraction of a notch and scroll a fraction
    of the distance. Most other things wait for a whole notch. */
const takesFractions = (win) => /^Chrome_WidgetWin_/.test(win?.cls ?? '')
  || /^(?:chrome|msedge|brave|opera|vivaldi|firefox|code|slack|discord|claude|spotify|whatsapp|teams|ms-teams|notion|figma|obsidian)$/i.test(win?.process ?? '');

/**
 * Wait for a scroll to stop moving. Browsers animate a wheel notch over a
 * couple of hundred milliseconds, and measuring halfway through the glide
 * reports half the distance.
 */
async function stillFrame(frame, region, first = 170) {
  await sleep(first);
  let last = await frame();
  for (let i = 0; i < 6; i++) {
    await sleep(70);
    const next = await frame();
    if (!regionChanged(last, next, region, 1.2)) return next;
    last = next;
  }
  return last;
}

/**
 * Scroll by a distance, measured.
 *
 * @param {object} io
 * @param {(x:number,y:number,delta:number,axis:string)=>Promise} io.wheel  physical point, wheel units
 * @param {()=>Promise<object>} io.frame   a raw physical frame
 * @param {object|null} io.sense
 * @param {object} req
 * @param {{x:number,y:number}} req.point  physical pixels, over what should scroll
 * @param {'x'|'y'} req.axis
 * @param {number} req.distance   physical pixels; positive is down (or right)
 * @param {boolean} [req.screens] distance is in screens of the scrolling area instead
 * @param {boolean} [req.toEnd]   keep going until nothing moves
 * @returns {Promise<{moved:number, requested:number, atEnd:boolean, view:number, percent:number|null, how:string, frame:object}>}
 */
export async function scrollBy({ wheel, frame, sense = null }, { point, axis = 'y', distance: asked, screens = false, toEnd = false, scale = 1 }) {
  const vertical = axis !== 'x';
  const sign = Math.sign(asked) || 1;

  const [win, uia] = await Promise.all([
    sense?.windowAt(point.x, point.y) ?? null,
    sense?.scrollable(point.x, point.y) ?? null,
  ]);
  const winRect = Array.isArray(win?.rect) ? win.rect : null;

  /* What to compare. The accessibility layer's scrolling container if it
     has one here; the window under the pointer if not; and within that, a
     band around the pointer — the part most likely to be the thing that
     moves, and least likely to include a sidebar that does not. */
  const box = (uia?.found && Array.isArray(uia.rect) && uia.rect[2] > 60 && uia.rect[3] > 60)
    ? uia.rect
    : (winRect ?? [0, 0, 4000, 4000]);
  const frame0 = await frame();
  const screenW = frame0.width;
  const screenH = frame0.height;
  const bx0 = Math.max(0, box[0]);
  const by0 = Math.max(0, box[1]);
  const bx1 = Math.min(screenW, box[0] + box[2]);
  const by1 = Math.min(screenH, box[1] + box[3]);
  const HALF = 360;
  const region = vertical
    ? {
      x: Math.max(bx0, point.x - HALF),
      y: by0 + (uia?.found ? 0 : Math.min(90, (by1 - by0) * 0.07)),
      width: Math.min(bx1, point.x + HALF) - Math.max(bx0, point.x - HALF),
      height: (by1 - by0) - (uia?.found ? 0 : Math.min(90, (by1 - by0) * 0.07)),
    }
    : {
      x: bx0,
      y: Math.max(by0, point.y - HALF),
      width: bx1 - bx0,
      height: Math.min(by1, point.y + HALF) - Math.max(by0, point.y - HALF),
    };
  let view = vertical ? region.height : region.width;
  let distance = screens ? asked * view : asked;
  let resized = false;

  const key = `${win?.process || 'unknown'}|${axis}`;
  let perNotch = learned.get(key) ?? (100 * scale);
  const fractions = takesFractions(win);

  const uiaOk = Boolean(uia?.found && (vertical ? uia.vertical : uia.horizontal));
  const percentOf = (u) => (vertical ? u?.v : u?.h);
  const sizeOf = (u) => (vertical ? u?.vsize : u?.hsize);
  let percent = uiaOk ? percentOf(uia) : null;

  let before = frame0;
  let moved = 0;
  let atEnd = false;
  let how = 'image';
  let uiaMoved = false;

  /* All the way to one end: the distance does not matter, only whether it
     is still moving. Big strides, and stop when a stride changes nothing. */
  if (toEnd) {
    // Bounded: a video or an animation under the pointer never stops
    // "changing", and must not keep this turning the wheel for ever.
    for (let round = 0; round < 30; round++) {
      let units = Math.sign(sign) * ((view * 0.9) / perNotch) * 120;
      if (!fractions) units = Math.sign(units) * Math.max(120, Math.round(Math.abs(units) / 120) * 120);
      await wheel(point.x, point.y, units, axis);
      const after = await stillFrame(frame, region, 140);
      let still = !regionChanged(before, after, region, 1.2);
      if (uiaOk) {
        const now = await sense.scrollable(point.x, point.y);
        const p1 = percentOf(now);
        if (Number.isFinite(p1)) {
          still = still || p1 === percent;
          percent = p1;
          if ((sign > 0 && p1 >= 99.5) || (sign < 0 && p1 <= 0.5)) { before = after; atEnd = true; break; }
        }
      }
      before = after;
      if (still) { atEnd = true; break; }
      moved += (units / 120) * perNotch;
    }
    return { moved: Math.round(moved), requested: Math.round(distance), atEnd, view: Math.round(view), percent, how: 'to-end', frame: before };
  }

  for (let round = 0; round < 8; round++) {
    const remaining = distance - moved;
    if (Math.abs(remaining) <= Math.max(12, Math.abs(distance) * 0.05)) break;
    // An application that only moves in whole notches cannot get closer than
    // half of one. Trying anyway overshoots, corrects, and overshoots again —
    // a page visibly twitching up and down until the rounds run out.
    if (!fractions && Math.abs(remaining) < perNotch * 0.5) break;
    // Gone past it. Coming back is a visible lurch in the other direction, so
    // only when the overshoot is large enough to matter.
    if (Math.sign(remaining) !== Math.sign(distance)
      && Math.abs(remaining) < Math.max(60, Math.abs(distance) * 0.2, fractions ? 0 : perNotch)) break;

    // Small enough to measure: the frames must still overlap afterwards. How
    // much they must overlap depends on how it will be measured — not at all
    // when Windows reports the scroll position itself, less once a notch
    // here has already been measured and there is a good guess to check.
    // (Windows' own number only counts once it has been seen to move: over a
    // panel inside a page it reports the page, which is not what scrolls.)
    const stride = uiaMoved ? 0.95 : learned.has(key) ? 0.7 : 0.45;
    const chunk = Math.sign(remaining) * Math.min(Math.abs(remaining), view * stride);
    let units = (chunk / perNotch) * 120;
    if (!fractions) units = Math.sign(units) * Math.max(120, Math.round(Math.abs(units) / 120) * 120);
    else if (Math.abs(units) < 12) units = Math.sign(units) * 12;
    const expected = (units / 120) * perNotch;

    await wheel(point.x, point.y, units, axis);
    const after = await stillFrame(frame, region);

    let got = null;
    let trusted = false;
    if (uiaOk) {
      const now = await sense.scrollable(point.x, point.y);
      const p0 = percent;
      const p1 = percentOf(now);
      const size = sizeOf(now);
      if (Number.isFinite(p0) && Number.isFinite(p1) && Number.isFinite(size) && size > 0 && size < 100 && p1 !== p0) {
        const content = view / (size / 100);
        got = ((p1 - p0) / 100) * (content - view);
        trusted = true;
        uiaMoved = true;
        how = 'uia';
      }
      if (Number.isFinite(p1)) percent = p1;
    }
    if (got === null) {
      const m = measureShift(before, after, region, { axis, expected });
      if (m && (m.confidence >= 0.2 || Math.abs(m.shift) < 3)) {
        got = m.shift;
        trusted = m.confidence >= 0.45 && !m.ambiguous;
        // A panel smaller than the window scrolled: from here on, "a screen"
        // means a screen of that panel. Once, from the first good reading.
        const span = m.extent ? m.extent.end - m.extent.start : 0;
        if (screens && !resized && trusted && span > 60 && span < view * 0.85) {
          resized = true;
          view = span;
          distance = asked * view;
        }
      } else if (regionChanged(before, after, region)) {
        // It moved, but the picture will not say how far. Believe the
        // estimate rather than claiming a distance nothing measured.
        got = expected;
        how = 'estimate';
      } else {
        got = 0;
      }
    }

    before = after;
    if (Math.abs(got) < 3) { atEnd = true; break; }      // nothing moved: an end, or nothing to scroll
    if (Math.sign(got) !== Math.sign(units)) { break; }    // moved the wrong way: something else happened

    if (trusted) {
      perNotch = Math.max(8, Math.abs(got) / (Math.abs(units) / 120));
      learned.set(key, perNotch);
    }
    moved += got;
    // Much less than a notch's worth where the rest scrolled fully: the end.
    if (Math.abs(got) < Math.abs(expected) * 0.55 && Math.abs(expected) > 30) { atEnd = true; break; }
  }

  if (uiaOk && Number.isFinite(percent)) {
    if (sign > 0 && percent >= 99.5) atEnd = true;
    if (sign < 0 && percent <= 0.5) atEnd = true;
  }

  return { moved: Math.round(moved), requested: Math.round(distance), atEnd, view: Math.round(view), percent, how, frame: before };
}

/** Did two frames differ at all inside a region? Cheap: sparse samples. */
export function regionChanged(before, after, region, threshold = 3) {
  if (!before || !after) return true;
  const W = before.width;
  let diff = 0;
  let n = 0;
  for (let y = Math.round(region.y); y < region.y + region.height; y += 7) {
    for (let x = Math.round(region.x); x < region.x + region.width; x += 7) {
      const i = ((y * W) + x) * 4;
      diff += Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]);
      n += 1;
    }
  }
  return n > 0 && diff / (n * 2) > threshold;
}
