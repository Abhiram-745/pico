/* ==========================================================================
   Real desktop control.

   Thin wrapper around @nut-tree-fork/nut-js, which is the thing that
   actually moves the mouse, types, and grabs the screen. Kept behind
   loadComputer() so a machine where the native module fails to load (wrong
   platform, missing build, running inside the Vercel/browser preview) just
   gets null back — the caller falls back to the scripted demo agent instead
   of crashing the bridge.

   Coordinates in and out of this module are real screen pixels. The caller
   (agent.mjs) is responsible for whatever coordinate space the model uses.
   ========================================================================== */

import { tmpdir } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const F_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);

export async function loadComputer() {
  let nut;
  try {
    nut = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.warn(`[bridge] desktop control unavailable (${err.message}) — using scripted scenarios`);
    return null;
  }

  const { mouse, keyboard, screen, Point, Button, Key, FileType } = nut;
  mouse.config.autoDelayMs = 2;
  keyboard.config.autoDelayMs = 2;

  const KEY_MAP = {
    ENTER: Key.Enter, RETURN: Key.Return, TAB: Key.Tab,
    ESC: Key.Escape, ESCAPE: Key.Escape,
    BACKSPACE: Key.Backspace, DELETE: Key.Delete, DEL: Key.Delete,
    SPACE: Key.Space, INSERT: Key.Insert, CAPSLOCK: Key.CapsLock,
    UP: Key.Up, DOWN: Key.Down, LEFT: Key.Left, RIGHT: Key.Right,
    HOME: Key.Home, END: Key.End, PAGEUP: Key.PageUp, PAGEDOWN: Key.PageDown,
    CTRL: Key.LeftControl, CONTROL: Key.LeftControl, LCTRL: Key.LeftControl, RCTRL: Key.RightControl,
    ALT: Key.LeftAlt, LALT: Key.LeftAlt, RALT: Key.RightAlt,
    SHIFT: Key.LeftShift, LSHIFT: Key.LeftShift, RSHIFT: Key.RightShift,
    CMD: Key.LeftSuper, WIN: Key.LeftWin, SUPER: Key.LeftSuper, META: Key.LeftMeta,
  };
  for (const f of F_KEYS) if (f in Key) KEY_MAP[f] = Key[f];
  for (let c = 65; c <= 90; c++) {
    const ch = String.fromCharCode(c);
    KEY_MAP[ch] = Key[ch];
  }
  for (let d = 0; d <= 9; d++) KEY_MAP[String(d)] = Key[`Num${d}`];

  const mapKey = (name) => KEY_MAP[String(name).toUpperCase()] ?? null;

  const BUTTON_MAP = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE, wheel: Button.MIDDLE };

  return {
    async size() {
      return { width: await screen.width(), height: await screen.height() };
    },

    /** PNG screenshot of the whole screen, base64-encoded. */
    async screenshotBase64() {
      const name = `pico-${randomBytes(6).toString('hex')}`;
      const path = await screen.capture(name, FileType.PNG, tmpdir());
      try {
        return (await readFile(path)).toString('base64');
      } finally {
        unlink(path).catch(() => {});
      }
    },

    async move(x, y) {
      await mouse.setPosition(new Point(x, y));
    },

    async click(x, y, button = 'left') {
      await mouse.setPosition(new Point(x, y));
      await mouse.click(BUTTON_MAP[button] ?? Button.LEFT);
    },

    async doubleClick(x, y) {
      await mouse.setPosition(new Point(x, y));
      await mouse.doubleClick(Button.LEFT);
    },

    async drag(path) {
      if (!path?.length) return;
      await mouse.setPosition(new Point(path[0].x, path[0].y));
      await mouse.drag(path.map((p) => new Point(p.x, p.y)));
    },

    async scroll(x, y, dx = 0, dy = 0) {
      await mouse.setPosition(new Point(x, y));
      if (dy < 0) await mouse.scrollUp(Math.round(Math.abs(dy)) || 1);
      if (dy > 0) await mouse.scrollDown(Math.round(dy) || 1);
      if (dx < 0) await mouse.scrollLeft(Math.round(Math.abs(dx)) || 1);
      if (dx > 0) await mouse.scrollRight(Math.round(dx) || 1);
    },

    async type(text) {
      if (text) await keyboard.type(text);
    },

    /** A chord: every key pressed together, then released in reverse. */
    async keypress(keys = []) {
      const mapped = keys.map(mapKey).filter((k) => k !== null);
      if (!mapped.length) return;
      await keyboard.pressKey(...mapped);
      await keyboard.releaseKey(...mapped);
    },

    async wait(ms = 500) {
      await new Promise((r) => setTimeout(r, Math.min(ms, 3000)));
    },
  };
}
