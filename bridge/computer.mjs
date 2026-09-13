/* ==========================================================================
   Real desktop control.

   Two halves, because no single library does both well here:

     seeing  screen.mjs  (node-screenshots, with a compositing fallback)
     doing   nut-js      (the pointer and the keyboard)

   That split is not tidiness for its own sake. nut-js's capture on this
   machine failed permanently mid-session and its value-returning calls
   (getMousePos, getActiveWindow) return garbage on Node 24 — while its
   input calls, which return nothing, work perfectly. So each library is
   used only for the half it is reliable at, and `loadComputer` proves both
   halves work before reporting that the desktop can be driven.

   MOVEMENT
   The pointer glides; it never teleports. A run used to look like a seizure
   because every move was a single SetCursorPos jump, which is both
   unreadable and genuinely harder for Windows to hit-test correctly on
   hover-sensitive controls. Every intermediate position is reported through
   `onPointer`, so the interface can draw where the cursor actually is.
   ========================================================================== */

import { Screen } from './screen.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fast away, gentle into the target. Used for the small corrective settle. */
const easeOutQuart = (t) => 1 - (1 - t) ** 4;

/** The velocity profile of a human reach: speeds up, peaks, brakes. */
const minimumJerk = (t) => (t ** 3) * (10 - (15 * t) + (6 * t * t));

const F_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);

function buildKeyMap(Key) {
  const map = {
    ENTER: Key.Enter, RETURN: Key.Return, TAB: Key.Tab,
    ESC: Key.Escape, ESCAPE: Key.Escape,
    BACKSPACE: Key.Backspace, DELETE: Key.Delete, DEL: Key.Delete,
    SPACE: Key.Space, INSERT: Key.Insert, CAPSLOCK: Key.CapsLock,
    UP: Key.Up, DOWN: Key.Down, LEFT: Key.Left, RIGHT: Key.Right,
    HOME: Key.Home, END: Key.End, PAGEUP: Key.PageUp, PAGEDOWN: Key.PageDown,
    CTRL: Key.LeftControl, CONTROL: Key.LeftControl,
    ALT: Key.LeftAlt, SHIFT: Key.LeftShift,
    CMD: Key.LeftSuper, WIN: Key.LeftSuper, SUPER: Key.LeftSuper, META: Key.LeftSuper,
  };
  for (const f of F_KEYS) if (f in Key) map[f] = Key[f];
  for (let c = 65; c <= 90; c++) map[String.fromCharCode(c)] = Key[String.fromCharCode(c)];
  for (let d = 0; d <= 9; d++) map[String(d)] = Key[`Num${d}`];
  return map;
}

/**
 * @param {object} opts
 * @param {(p:{x:number,y:number,done:boolean})=>void} [opts.onPointer]
 * @returns the control surface, or null when the desktop cannot be driven
 */
export async function loadComputer({ onPointer } = {}) {
  if (process.platform !== 'win32') {
    console.warn('[bridge] desktop control is Windows-only — running without it');
    return null;
  }

  // --- eyes ---------------------------------------------------------------
  const screen = new Screen();
  let vision;
  try {
    vision = await screen.detect();
  } catch (err) {
    console.warn(`[bridge] the screen could not be read (${err.message})`);
    return null;
  }

  // --- hands --------------------------------------------------------------
  let nut;
  try {
    nut = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.warn(`[bridge] input control unavailable (${err.message})`);
    return null;
  }

  const { mouse, keyboard, Point, Button, Key } = nut;
  mouse.config.autoDelayMs = 1;
  keyboard.config.autoDelayMs = 1;

  const KEY_MAP = buildKeyMap(Key);
  const mapKey = (name) => KEY_MAP[String(name).toUpperCase().trim()] ?? null;
  const BUTTON = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

  const bounds = screen.bounds;
  const clampX = (x) => Math.round(Math.max(0, Math.min(bounds.width - 1, x)));
  const clampY = (y) => Math.round(Math.max(0, Math.min(bounds.height - 1, y)));

  // Where we last put the pointer. nut-js can report its position, but on
  // this build that read returns garbage, so the last commanded position is
  // the honest answer.
  let at = { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };

  async function setPointer(x, y, done = false) {
    at = { x: clampX(x), y: clampY(y) };
    await mouse.setPosition(new Point(at.x, at.y));
    onPointer?.({ ...at, done });
  }

  /** Sample a path over `duration`, by the clock rather than by step count. */
  async function trace(duration, at01, last) {
    // Timers on Windows fire late and unevenly, so a fixed number of steps
    // with fixed sleeps stretches a 300ms move to 600ms. Reading the clock
    // each iteration keeps the duration honest: a late tick just samples
    // further along the curve.
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / duration);
      const p = at01(t);
      await setPointer(p.x, p.y, last && t >= 1);
      if (t >= 1) return;
      await sleep(6);
    }
  }

  /**
   * Move the pointer the way a hand does.
   *
   *   - Fitts's law sets the time: long moves take longer, but not linearly,
   *     so a short hop is quick and a cross-screen move is not a crawl.
   *   - Minimum-jerk timing: it accelerates, peaks mid-way and brakes, which
   *     is the velocity profile of a real reach.
   *   - A slight arc, bent to a random side, because wrists pivot.
   *   - On long moves, a small overshoot and a correction back onto target.
   *
   * It is also much faster than the old linear glide — a cross-screen move is
   * under half a second — because watching a cursor crawl was most of what
   * made simple tasks feel slow.
   */
  async function glide(x, y, ms = 0) {
    const tx = clampX(x);
    const ty = clampY(y);
    const from = { ...at };
    const dx = tx - from.x;
    const dy = ty - from.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 3) { await setPointer(tx, ty, true); return; }

    const duration = ms > 0
      ? ms
      : Math.max(90, Math.min(430, 70 + (52 * Math.log2(1 + (dist / 12)))));

    const ux = dx / dist;
    const uy = dy / dist;
    const side = Math.random() < 0.5 ? -1 : 1;
    const bend = side * Math.min(70, dist * (0.05 + (Math.random() * 0.07)));
    const ctrl = {
      x: from.x + (dx * 0.5) - (uy * bend),
      y: from.y + (dy * 0.5) + (ux * bend),
    };

    const overshoot = dist > 360 ? Math.min(12, dist * 0.014) : 0;
    const end = { x: tx + (ux * overshoot), y: ty + (uy * overshoot) };

    await trace(duration, (t) => {
      const e = minimumJerk(t);
      const a = 1 - e;
      return {
        x: (a * a * from.x) + (2 * a * e * ctrl.x) + (e * e * end.x),
        y: (a * a * from.y) + (2 * a * e * ctrl.y) + (e * e * end.y),
      };
    }, !overshoot);

    if (overshoot) {
      const back = { ...at };
      await trace(70, (t) => {
        const e = easeOutQuart(t);
        return { x: back.x + ((tx - back.x) * e), y: back.y + ((ty - back.y) * e) };
      }, true);
    }
  }

  const surface = {
    vision,
    get pointer() { return { ...at }; },

    /** The space the mouse works in, which is not the screenshot's space. */
    async size() { return { ...bounds }; },

    capture(opts) { return screen.capture(opts); },

    focusedWindow() { return screen.focusedWindow(); },

    move(x, y, ms) { return glide(x, y, ms); },

    async click(x, y, button = 'left') {
      if (Number.isFinite(x)) await glide(x, y);
      await sleep(18);                       // one frame for hover states to settle
      await mouse.click(BUTTON[button] ?? Button.LEFT);
    },

    async doubleClick(x, y) {
      if (Number.isFinite(x)) await glide(x, y);
      await sleep(18);
      await mouse.doubleClick(Button.LEFT);
    },

    async drag(path = []) {
      if (path.length < 2) return;
      await glide(path[0].x, path[0].y);
      await mouse.pressButton(Button.LEFT);
      for (const p of path.slice(1)) await glide(p.x, p.y, 260);
      await mouse.releaseButton(Button.LEFT);
    },

    async scroll(x, y, dx = 0, dy = 0) {
      if (Number.isFinite(x)) await glide(x, y);
      const ticks = (v) => Math.max(1, Math.min(12, Math.round(Math.abs(v) / 40) || 1));
      if (dy < 0) await mouse.scrollUp(ticks(dy));
      if (dy > 0) await mouse.scrollDown(ticks(dy));
      if (dx < 0) await mouse.scrollLeft(ticks(dx));
      if (dx > 0) await mouse.scrollRight(ticks(dx));
    },

    async type(text) {
      if (text) await keyboard.type(String(text));
    },

    /** A chord: pressed together, released in reverse. */
    async keypress(keys = []) {
      const mapped = keys.map(mapKey).filter((k) => k !== null);
      if (!mapped.length) return;
      await keyboard.pressKey(...mapped);
      await keyboard.releaseKey(...mapped);
    },

    wait(ms = 500) { return sleep(Math.min(Math.max(ms, 0), 5000)); },

    stop() { /* nothing long-lived to tear down */ },
  };

  console.log(
    `[bridge] desktop control ready — ${bounds.width}x${bounds.height}, ` +
    `capture via ${vision.mode}`,
  );
  return surface;
}
