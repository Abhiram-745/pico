/* ==========================================================================
   Real desktop control.

   Three parts, because no single library does all of it well here:

     seeing    screen.mjs   (node-screenshots, with a compositing fallback)
     doing     nut-js       (the pointer and the keyboard)
     knowing   sense.mjs    (the accessibility layer: what is under a point)

   nut-js's capture on this machine failed permanently mid-session, so it is
   used only for input, which it does reliably. `loadComputer` proves seeing
   and doing both work before reporting that the desktop can be driven;
   knowing is optional and everything works, less precisely, without it.

   ONE CURSOR
   Halo moves the pointer the user already has, where they can see it. There
   is no second, drawn cursor and nothing is pressed behind their back.

   MOVEMENT
   The pointer glides from wherever it actually is — read from Windows at
   the start of every move, not remembered from Halo's last one, so a mouse
   the user has moved in the meantime does not jump back to where Halo left
   it before setting off. Every intermediate position is reported through
   `onPointer`, so the interface can show where the cursor is.

   It has to be watched rather than timed. Windows wakes a sleeping process
   on a 15.6ms tick, and libnut sleeps after every mouse call it makes, so
   the obvious way to write this — a position, a short sleep, a position —
   can only put the pointer in about sixty-four places a second. That is
   slower than the screen redraws, which is what a staircase of a cursor
   actually is. Both delays are turned off below and the loop reads the
   clock instead, which puts it in roughly five hundred, one every couple
   of pixels. See loadComputer and trace().
   ========================================================================== */

import { createRequire } from 'node:module';
import { Screen } from './screen.mjs';
import { WHEEL_DELTA } from './scroll.mjs';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Back in about a tenth of a millisecond, where setTimeout's floor on
    Windows is a whole 15.6ms timer tick — see trace(). */
const tick = () => new Promise((r) => setImmediate(r));

/** The closest two pointer positions are ever sent: five hundred a second,
    which is a high-end mouse's reporting rate and well past what a display
    can show. Finer than this only spends the glide's own time moving. */
const STEP_MS = 2;

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
    ARROWUP: Key.Up, ARROWDOWN: Key.Down, ARROWLEFT: Key.Left, ARROWRIGHT: Key.Right,
    HOME: Key.Home, END: Key.End, PAGEUP: Key.PageUp, PAGEDOWN: Key.PageDown,
    PGUP: Key.PageUp, PGDN: Key.PageDown,
    CTRL: Key.LeftControl, CONTROL: Key.LeftControl,
    ALT: Key.LeftAlt, SHIFT: Key.LeftShift,
    CMD: Key.LeftSuper, WIN: Key.LeftSuper, WINDOWS: Key.LeftSuper, SUPER: Key.LeftSuper, META: Key.LeftSuper,
    MINUS: Key.Minus, EQUAL: Key.Equal, PLUS: Key.Equal, COMMA: Key.Comma, PERIOD: Key.Period,
    SLASH: Key.Slash, BACKSLASH: Key.Backslash, SEMICOLON: Key.Semicolon, QUOTE: Key.Quote,
    '-': Key.Minus, '=': Key.Equal, '+': Key.Equal, ',': Key.Comma, '.': Key.Period, '/': Key.Slash,
  };
  for (const f of F_KEYS) if (f in Key) map[f] = Key[f];
  for (let c = 65; c <= 90; c++) map[String.fromCharCode(c)] = Key[String.fromCharCode(c)];
  for (let d = 0; d <= 9; d++) map[String(d)] = Key[`Num${d}`];
  return map;
}

/**
 * @param {object} opts
 * @param {(p:{x:number,y:number,done:boolean})=>void} [opts.onPointer]
 * @param {object} [opts.sense]   from sense.mjs, optional
 * @returns the control surface, or null when the desktop cannot be driven
 */
export async function loadComputer({ onPointer, sense = null } = {}) {
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
  let libnut = null;
  try {
    nut = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.warn(`[bridge] input control unavailable (${err.message})`);
    return null;
  }
  try {
    // The native module directly: its position read and its wheel both
    // behave, where nut-js's wrappers around them do not (see scroll()).
    libnut = require('@nut-tree-fork/libnut-win32');
  } catch { /* positions fall back to the last commanded one */ }

  /* libnut sleeps after every mouse call it makes — ten milliseconds by
     default — and Windows rounds that up to a whole 15.6ms timer tick. That
     one setting, left alone, is what made the pointer look wrong: however
     finely the loop below asked for positions, only about sixty-four a
     second could get out, so a cross-screen glide arrived as twenty-odd
     jumps of up to 127 pixels rather than a movement. Measured on this
     machine at 15.3ms a call before this line and 0.23ms after it.
     It has to be exactly zero — even setMouseDelay(1) costs the full tick.
     The pauses that matter, around a click and through a drag, are asked
     for deliberately further down. */
  try { libnut?.setMouseDelay(0); } catch { /* an older build: moves stay coarse */ }

  const { mouse, keyboard, Point, Button, Key } = nut;
  mouse.config.autoDelayMs = 1;
  keyboard.config.autoDelayMs = 1;

  const KEY_MAP = buildKeyMap(Key);
  const mapKey = (name) => KEY_MAP[String(name).toUpperCase().trim()] ?? null;
  const BUTTON = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

  const bounds = screen.bounds;
  const clampX = (x) => Math.round(Math.max(0, Math.min(bounds.width - 1, x)));
  const clampY = (y) => Math.round(Math.max(0, Math.min(bounds.height - 1, y)));

  // Where Halo last put the pointer, for when Windows cannot be asked.
  let at = { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };

  /** Where the pointer really is now, in mouse units. */
  function whereIsPointer() {
    try {
      const p = libnut?.getMousePos();
      // While the desktop is locked or behind a screen saver, Windows refuses
      // the read and the native call hands back whatever was in memory —
      // x = -1065361536 was seen. Anything off every plausible monitor is
      // that, not a position.
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)
        && Math.abs(p.x) < 50_000 && Math.abs(p.y) < 50_000) return { x: p.x, y: p.y };
    } catch { /* fall through */ }
    return { ...at };
  }

  async function setPointer(x, y, done = false) {
    at = { x: clampX(x), y: clampY(y) };
    await mouse.setPosition(new Point(at.x, at.y));
    onPointer?.({ ...at, done });
  }

  /** Sample a path over `duration`, by the clock rather than by step count. */
  async function trace(duration, at01) {
    // Timers on Windows fire late and unevenly, so a fixed number of steps
    // with fixed sleeps stretches a 300ms move to 600ms. Reading the clock
    // each iteration keeps the duration honest: a late tick just samples
    // further along the curve.
    //
    // The wait between samples is not a timer either. setTimeout's floor
    // here is that same 15.6ms tick — ask for 6 and get 15.6 — and a third
    // of a second paced in 15.6ms steps is a slideshow, not a movement.
    // setImmediate comes back in about a tenth of a millisecond, so the
    // curve decides where the pointer is and the loop simply keeps up.
    // Nothing here sleeps, so the gaps are spent going round this loop,
    // which costs a core for as long as the move lasts — a tenth of a
    // second or two, and only while Halo is actually moving. That is the
    // whole price of the fix and it is worth paying: Windows will not wake
    // a process on anything finer than its 15.6ms tick, so pacing that is
    // smoother than the tick has to be watched for rather than waited for.
    // The watching goes through setImmediate rather than a blocking spin
    // so the poll phase still runs between turns and the bridge keeps
    // answering its sockets while the pointer is on its way.
    const t0 = performance.now();
    let last = null;
    let sent = -Infinity;
    for (;;) {
      const now = performance.now();
      const elapsed = now - t0;
      // Not due yet: come straight back round rather than working out a
      // position that is not going to be used.
      if (elapsed < duration && now - sent < STEP_MS) { await tick(); continue; }
      const t = Math.min(1, elapsed / duration);
      const p = at01(t);
      const x = clampX(p.x);
      const y = clampY(p.y);
      // Only where it has actually reached a new pixel: through the slow
      // ends of the curve the same position comes up many times over, and
      // sending it again is a move the pointer does not make.
      if (t >= 1 || last === null || x !== last.x || y !== last.y) {
        await setPointer(x, y, t >= 1);
        last = { x, y };
        sent = now;
      }
      if (t >= 1) return;
      await tick();
    }
  }

  /**
   * Move the pointer.
   *
   * Straight there, with minimum-jerk timing — it accelerates, peaks mid-way
   * and brakes, the velocity profile of a real reach — over a time that
   * grows with the logarithm of the distance, so a short hop is immediate
   * and a cross-screen move is still under a third of a second. It lands on
   * the exact point it was given.
   *
   * No arc, no overshoot. Both were once here to look human, and both made
   * the pointer pass over things on the way that lit up, opened, or took the
   * click — an overshoot past a target is a hover on whatever is beyond it.
   */
  async function glide(x, y, ms = 0) {
    const tx = clampX(x);
    const ty = clampY(y);
    const from = whereIsPointer();
    at = from;
    const dx = tx - from.x;
    const dy = ty - from.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 2) { await setPointer(tx, ty, true); return; }

    const duration = ms > 0
      ? ms
      : Math.max(70, Math.min(360, 55 + (46 * Math.log2(1 + (dist / 14)))));

    await trace(duration, (t) => {
      const e = minimumJerk(t);
      return { x: from.x + (dx * e), y: from.y + (dy * e) };
    });

    // Land exactly. Every step above is a rounded integer, and the last one
    // is only as close as the curve happened to get.
    if (at.x !== tx || at.y !== ty) await setPointer(tx, ty, true);
  }

  const surface = {
    vision,
    sense,
    get pointer() { return whereIsPointer(); },

    /** The space the mouse works in, which is not the screenshot's space. */
    async size() { return { ...bounds }; },

    capture(opts) { return screen.capture(opts); },

    /** A raw physical frame, for measuring rather than for a model. */
    frame() { return screen.rawDesktop(); },

    /** Title of what is in front. Synchronous, for the activity log. */
    focusedWindow() { return screen.focusedWindow(); },

    /**
     * Can input reach the desktop at all right now?
     *
     * Not while the computer is locked, a screen saver is running, or a UAC
     * prompt is up: Windows sends mouse and keyboard input from ordinary
     * programs nowhere then, and a run would carry on clicking into
     * nothing and report whatever the screenshot happened to show.
     */
    async available() {
      const d = await sense?.desktop();
      if (!d || d.usable !== false) return { ok: true };
      const why = /screen-?saver/i.test(d.name)
        ? 'the screen saver is on'
        : 'the computer is locked or a Windows security prompt is showing';
      return { ok: false, why };
    },

    /** What is in front, properly: `{ hwnd, title, process }` or null. */
    async foreground() {
      const fg = await sense?.foreground();
      if (fg?.hwnd) return fg;
      const title = screen.focusedWindow();
      return title ? { hwnd: null, title, process: '' } : null;
    },

    move(x, y, ms) { return glide(x, y, ms); },

    /* The pause before a click is not politeness. An application decides
       what is under the pointer when the button goes down, and a menu, a
       hover-highlight or a tooltip needs a few frames to have happened —
       click in the same instant the pointer lands and it often goes to what
       was there before. */
    async click(x, y, button = 'left') {
      if (Number.isFinite(x)) await glide(x, y);
      await sleep(70);
      await mouse.click(BUTTON[button] ?? Button.LEFT);
      await sleep(40);                       // and let it register before moving on
    },

    async doubleClick(x, y) {
      if (Number.isFinite(x)) await glide(x, y);
      await sleep(70);
      await mouse.doubleClick(Button.LEFT);
      await sleep(40);
    },

    /**
     * Press, travel, release — the way a hand does it.
     *
     * Windows does not treat a button-down followed by a jump as a drag: the
     * pointer has to cross a few pixels while the button is held before the
     * application starts one, the application needs a frame to notice the
     * button went down, and letting go in the same instant the pointer
     * arrives drops whatever was being dragged at the position before last.
     */
    async drag(path = []) {
      if (path.length < 2) return;
      await glide(path[0].x, path[0].y);
      await sleep(60);                       // let the target see the pointer arrive

      await mouse.pressButton(Button.LEFT);
      await sleep(90);                       // and see the button go down

      // Past the system drag threshold before doing anything else, or the
      // application treats the whole gesture as a click.
      const next = path[1];
      const dx = Math.sign(next.x - at.x) || 1;
      const dy = Math.sign(next.y - at.y) || 1;
      await setPointer(at.x + (dx * 8), at.y + (dy * 8));
      await sleep(40);

      try {
        for (const p of path.slice(1)) await glide(p.x, p.y, 320);
        await sleep(110);                    // arrive, then let go — not both at once
      } finally {
        // Never leave the button down. A run that failed mid-drag would
        // otherwise hand the desk back with the mouse held, and every
        // subsequent click would be a selection.
        await mouse.releaseButton(Button.LEFT);
      }
      await sleep(60);
    },

    /**
     * Turn the wheel, over a point given in mouse units.
     *
     * `amount` is in Windows wheel units — 120 is one notch — and positive
     * scrolls down (or right). Delivered a notch at a time, a frame apart,
     * the way a wheel turns: an application handed one enormous delta
     * either clamps it or jumps without animating. A remainder smaller than
     * a notch is sent as it is; applications that cannot use it ignore it.
     *
     * nut-js's scrollDown(n) was the old route, and it passes n straight
     * through as the delta: scrollDown(3) is three hundred-and-twentieths of
     * one notch. That is why Halo's scrolling barely moved anything.
     */
    async wheel(x, y, amount, axis = 'y') {
      if (Number.isFinite(x)) {
        const here = whereIsPointer();
        if (Math.hypot(here.x - x, here.y - y) > 2) await glide(x, y);
      }
      // Windows: a positive vertical delta is the wheel turned away from you,
      // which scrolls up; a positive horizontal one scrolls right.
      const send = (units) => {
        if (axis === 'x') libnut.scrollMouse(units, 0);
        else libnut.scrollMouse(0, -units);
      };
      if (!libnut) {
        const n = Math.max(1, Math.round(Math.abs(amount) / WHEEL_DELTA)) * WHEEL_DELTA;
        if (axis === 'x') await (amount < 0 ? mouse.scrollLeft(n) : mouse.scrollRight(n));
        else await (amount < 0 ? mouse.scrollUp(n) : mouse.scrollDown(n));
        return;
      }
      let left = Math.round(amount);
      while (Math.abs(left) >= WHEEL_DELTA) {
        const step = Math.sign(left) * WHEEL_DELTA;
        send(step);
        left -= step;
        if (left !== 0) await sleep(18);
      }
      if (left !== 0) send(left);
    },

    /** Whole notches, for anything that just wants the view to move.
        Positive dy scrolls down, positive dx scrolls right. */
    async scroll(x, y, dx = 0, dy = 0) {
      if (dy) await surface.wheel(x, y, dy * WHEEL_DELTA, 'y');
      if (dx) await surface.wheel(x, y, dx * WHEEL_DELTA, 'x');
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

    /** Bring a window to the front, by handle. */
    async focus(hwnd) {
      const r = await sense?.focus(hwnd);
      if (r) return Boolean(r.ok);
      try { libnut?.focusWindow(Number(hwnd)); return true; } catch { return false; }
    },

    wait(ms = 500) { return sleep(Math.min(Math.max(ms, 0), 5000)); },

    stop() { sense?.stop(); },
  };

  console.log(
    `[bridge] desktop control ready — ${bounds.width}x${bounds.height}, `
    + `capture via ${vision.mode}${sense ? ', accessibility on' : ''}`,
  );
  return surface;
}
