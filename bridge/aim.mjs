/* ==========================================================================
   Halo — landing on the thing, not beside it.

   The model says where to click from a picture of the screen. Measured, a
   good model puts that point about two physical pixels from the middle of
   what it meant — and a checkbox is seventeen pixels across, so "about two"
   now and then means the label beside it, or the gap between two icons.

   Windows already knows exactly where every button is: the accessibility
   layer screen readers use reports each control's rectangle and name. So the
   model's point is taken as "this is the thing I mean", the control under it
   is looked up, and the click goes to that control's middle.

     - On a control: click its centre. A wide row keeps the model's x, a tall
       panel keeps its y, and anything where the exact spot matters — a text
       field, a slider, a document — keeps the point it was given.
     - Just beside one (within a few pixels): the nearest control whose name
       fits what the model said it was clicking.
     - Nowhere near one, or no accessibility information at all (games,
       custom-drawn apps): the model's point, untouched.

   It never presses anything. The user's own pointer still makes the click.
   ========================================================================== */

/** Controls where the exact spot matters more than the middle. A link can
    wrap onto a second line, and the middle of its box is then the gap
    between the two — so a link keeps the point that was on its text. */
const POSITIONAL = new Set(['Edit', 'Document', 'Slider', 'ScrollBar', 'Text', 'Hyperlink', 'Custom', 'Pane', 'Group', 'Table', 'List', 'Tree', 'DataGrid']);

/** How far beside a control a click can land and still be taken to mean it. */
const NEAR_ENOUGH = 16;

const STOP = new Set(['the', 'a', 'an', 'button', 'icon', 'link', 'tab', 'in', 'on', 'of', 'for', 'to', 'at',
  'and', 'with', 'next', 'row', 'menu', 'item', 'field', 'box', 'checkbox', 'panel', 'toolbar', 'top', 'bottom',
  'left', 'right', 'side', 'bar', 'labelled', 'labeled', 'called', 'named', 'that', 'this', 'which', 'is', 'says']);

const tokens = (s) => String(s ?? '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length > 1 && !STOP.has(w));

/**
 * How well a control's name fits the model's description of its target,
 * from 0 (nothing in common) to 1 (the name is in the description).
 */
export function fit(description, name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 0;
  const d = String(description ?? '').toLowerCase();
  // A quoted label in the description is the strongest evidence there is.
  const quoted = [...d.matchAll(/["“”'‘’]([^"“”'‘’]{1,60})["“”'‘’]/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.some((q) => n === q || n.includes(q) || (q.length > 3 && q.includes(n)))) return 1;
  const nt = tokens(n);
  if (!nt.length) return 0;
  const dt = new Set(tokens(d));
  const shared = nt.filter((w) => dt.has(w)).length;
  return shared / nt.length;
}

const inside = (r, p) => r && p.x >= r[0] && p.x <= r[0] + r[2] && p.y >= r[1] && p.y <= r[1] + r[3];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Where in a control to click, given where the model pointed. */
export function placeIn(el, p) {
  const [rx, ry, rw, rh] = el.rect;
  const margin = Math.max(1, Math.min(4, rw / 4, rh / 4));
  const kept = {
    x: clamp(p.x, rx + margin, rx + rw - margin),
    y: clamp(p.y, ry + margin, ry + rh - margin),
  };
  if (el.positional || POSITIONAL.has(el.type)) return { ...kept, how: 'kept' };
  return {
    x: rw <= 480 ? rx + (rw / 2) : kept.x,
    y: rh <= 160 ? ry + (rh / 2) : kept.y,
    how: 'centred',
  };
}

/**
 * Settle where a click should land.
 *
 * @param {object|null} sense   from sense.mjs, or null
 * @param {{x:number,y:number}} point  physical pixels, from the model
 * @param {object} opts
 * @param {string} opts.target  the model's own description of what it is clicking
 * @returns {Promise<{x:number, y:number, how:string, landed:object|null, window:object|null, moved:number}>}
 */
export async function settle(sense, point, { target = '' } = {}) {
  const plain = { x: point.x, y: point.y, how: 'model', landed: null, window: null, moved: 0 };
  if (!sense) return plain;

  const hit = await sense.hit(point.x, point.y);
  if (!hit) return plain;
  const window = hit.window && typeof hit.window === 'object' ? hit.window : null;
  const landedAt = hit.at ? { type: hit.at.type, name: hit.at.name } : null;
  if (!hit.found) return { ...plain, window };

  const result = (el, where) => ({
    x: where.x,
    y: where.y,
    how: where.how,
    landed: { type: el.type, name: el.name, rect: el.rect },
    window,
    moved: Math.hypot(where.x - point.x, where.y - point.y),
  });

  // On a control. If the smallest one under the point is not what was
  // described and a larger one around it is — the close button inside the
  // tab that was meant — the larger one is the target.
  const layers = (Array.isArray(hit.layers) ? hit.layers : [])
    .filter((l) => l && Array.isArray(l.rect) && l.enabled !== false && inside(l.rect, point));
  if (layers.length) {
    let chosen = layers[0];
    if (target && fit(target, chosen.name) < 0.5) {
      const better = layers.find((l) => fit(target, l.name) >= 0.5);
      if (better) chosen = better;
    }
    // A control the size of a window is not a control anybody aims at.
    if (chosen.rect[2] * chosen.rect[3] < 900 * 700) return result(chosen, placeIn(chosen, point));
  }

  /* Just beside one.
     Not from inside something that is itself a place to click: a document,
     a text field, a canvas. A click into the blank part of a page or an
     empty line of a document means exactly there, and pulling it onto the
     nearest button would be the worst possible correction. From a plain
     label or an unnamed gap, a neighbour counts — but one that does not
     share the name the model gave only if it is right next to the point. */
  const surface = new Set(['Edit', 'Document', 'Custom', 'Window', 'Table', 'DataGrid', 'Tree', 'List', 'Slider', 'ScrollBar']);
  if (surface.has(hit.at?.type)) return { ...plain, landed: landedAt, window };

  const near = await sense.near(point.x, point.y, NEAR_ENOUGH + 8);
  const controls = (near?.controls ?? []).filter((c) => c && Array.isArray(c.rect)
    && c.enabled !== false && !c.offscreen && c.distance <= NEAR_ENOUGH
    && c.rect[2] * c.rect[3] < 600 * 300
    && (fit(target, c.name) >= 0.5 || c.distance <= 8));
  if (controls.length) {
    const scored = controls
      .map((c) => ({ c, score: fit(target, c.name) - (c.distance / NEAR_ENOUGH) * 0.6 }))
      .sort((a, b) => b.score - a.score);
    // With nothing to go on but distance, only an unambiguous neighbour.
    const top = scored[0];
    const second = scored[1];
    const decisive = fit(target, top.c.name) >= 0.5 || !second || top.score - second.score > 0.25;
    if (decisive) {
      const edge = {
        x: clamp(point.x, top.c.rect[0], top.c.rect[0] + top.c.rect[2]),
        y: clamp(point.y, top.c.rect[1], top.c.rect[1] + top.c.rect[3]),
      };
      return result(top.c, placeIn(top.c, edge));
    }
  }

  return { ...plain, landed: landedAt, window };
}
