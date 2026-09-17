/* ==========================================================================
   Halo — the keyboard

   A drawn Windows keyboard, laid out like the one on this desk: the same
   rows, the same double-legend keycaps, the same function row with its
   icons. It has two jobs and they pull in opposite directions, so both are
   spelled out here.

   1. SAY WHICH KEYS. The chord being taught is lit blue and named on the
      cap, so there is nothing to work out: the keys you have to press are
      the ones glowing.
   2. GET OUT OF THE WAY. The moment a key actually goes down, the keyboard
      fades back — you are looking at your hands or at what Halo just did,
      not at a picture of a keyboard. It comes back when the keys come up.

   Every cap is a real key with its real legends (Shift's arrow, Enter's
   return, the F-row icons), because a keyboard with placeholder caps is
   something you have to translate, and this is meant to be something you
   recognise.
   ========================================================================== */

import { memo, useEffect, useState } from 'react';

/* --------------------------------------------------------------------------
   The layout

   [name, { w, sub, glyph, wide }] — `name` is what a keybind calls the key
   (see keybinds.js), `w` is width in units where a letter key is 1.
   -------------------------------------------------------------------------- */
const K = (name, opts = {}) => ({ name, ...opts });

export const ROWS = [
  [
    K('Esc', { w: 1.3 }),
    K('F1', { sub: 'F1', glyph: 'bluetooth' }),
    K('F2', { sub: 'F2', glyph: 'mute' }),
    K('F3', { sub: 'F3', glyph: 'voldown' }),
    K('F4', { sub: 'F4', glyph: 'volup' }),
    K('F5', { sub: 'F5', glyph: 'play' }),
    K('F6', { sub: 'F6', glyph: 'screen' }),
    K('F7', { sub: 'F7', glyph: 'search' }),
    K('F8', { sub: 'F8', glyph: 'task' }),
    K('F9', { top: 'Home', sub: 'F9' }),
    K('F10', { top: 'End', sub: 'F10' }),
    K('F11', { top: 'PgUp', sub: 'F11' }),
    K('F12', { top: 'PgDn', sub: 'F12' }),
    K('Lock', { glyph: 'lock' }),
    K('Del', { top: 'Del', sub: 'Ins', flip: true, w: 1.3 }),
  ],
  [
    K('`', { top: '~', sub: '`' }),
    K('1', { top: '!', sub: '1' }),
    K('2', { top: '@', sub: '2' }),
    K('3', { top: '#', sub: '3' }),
    K('4', { top: '$', sub: '4' }),
    K('5', { top: '%', sub: '5' }),
    K('6', { top: '^', sub: '6' }),
    K('7', { top: '&', sub: '7' }),
    K('8', { top: '*', sub: '8' }),
    K('9', { top: '(', sub: '9' }),
    K('0', { top: ')', sub: '0' }),
    K('-', { top: '—', sub: '–' }),
    K('=', { top: '+', sub: '=' }),
    K('Backspace', { w: 2, label: 'Backspace' }),
  ],
  [
    K('Tab', { w: 1.55, label: 'Tab', align: 'left' }),
    K('Q'), K('W'), K('E'), K('R'), K('T'), K('Y'), K('U'), K('I'), K('O'), K('P'),
    K('[', { top: '{', sub: '[' }),
    K(']', { top: '}', sub: ']' }),
    K('\\', { top: '|', sub: '\\', w: 1.45 }),
  ],
  [
    K('CapsLock', { w: 1.8, label: 'Caps', align: 'left', dotted: true }),
    K('A'), K('S'), K('D'), K('F'), K('G'), K('H'), K('J'), K('K'), K('L'),
    K(';', { top: ':', sub: ';' }),
    K("'", { top: '"', sub: "'" }),
    K('Enter', { w: 2.2, label: 'Enter', align: 'right' }),
  ],
  [
    K('Shift', { w: 2.35, label: 'Shift', align: 'left' }),
    K('Z'), K('X'), K('C'), K('V'), K('B'), K('N'), K('M'),
    K(',', { top: '<', sub: ',' }),
    K('.', { top: '>', sub: '.' }),
    K('/', { top: '?', sub: '/' }),
    K('ShiftRight', { w: 2.65, label: 'Shift', align: 'right' }),
  ],
  [
    K('Ctrl', { w: 1.5, label: 'Ctrl' }),
    K('Fn', { w: 1.2, label: 'Fn' }),
    K('Win', { w: 1.2, glyph: 'win' }),
    K('Alt', { w: 1.35, label: 'Alt' }),
    K('Space', { w: 6.2, label: '' }),
    K('AltRight', { w: 1.35, label: 'Alt' }),
    K('Emoji', { w: 1.2, glyph: 'emoji' }),
    K('ArrowLeft', { w: 1.1, glyph: 'left' }),
    K('ArrowUpDown', { w: 1.1, glyph: 'updown', stack: true }),
    K('ArrowRight', { w: 1.1, glyph: 'right' }),
  ],
];

/* Which drawn key a real keypress is. Codes, not key values, so a chord is
   the same physical place on every layout. Both Shifts, Alts and Ctrls count
   as the one named in a chord — nobody means the left Alt specifically. */
const CODE_TO_KEY = {
  Escape: 'Esc',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Backspace: 'Backspace',
  Tab: 'Tab',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  CapsLock: 'CapsLock',
  Semicolon: ';',
  Quote: "'",
  Enter: 'Enter',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Win',
  MetaRight: 'Win',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUpDown',
  ArrowDown: 'ArrowUpDown',
  Delete: 'Del',
  Insert: 'Del',
  Home: 'F9',
  End: 'F10',
  PageUp: 'F11',
  PageDown: 'F12',
};

export function keyNameFor(code = '') {
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  return code;
}

/**
 * Does this drawn key answer to one of `wanted`?
 *
 * Pressing either Shift is pressing Shift, so both caps answer when a key
 * is *held*; but only one of them is lit when a chord is being taught —
 * two glowing Alts read as "press both", which is not a thing.
 */
const answersTo = (keyName, wanted, { bothSides = true } = {}) => {
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!bothSides && /Right$/.test(keyName)) return false;
  const base = keyName.replace(/Right$/, '');
  return wanted.some((w) => same(base, w) || same(keyName, w));
};

/* --------------------------------------------------------------------------
   Legends that are drawings, not letters
   -------------------------------------------------------------------------- */
const Glyph = memo(function Glyph({ name }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'bluetooth':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path {...p} d="M5 4.2 11 11.8 8 14V2l3 2.2L5 11.8" /></svg>;
    case 'mute':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><path {...p} d="M2 6h2.5L8 3v10L4.5 10H2z" /><path {...p} d="m11.5 6 3.5 4m0-4-3.5 4" /></svg>;
    case 'voldown':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><path {...p} d="M2 6h2.5L8 3v10L4.5 10H2z" /><path {...p} d="M11 6.6a3 3 0 0 1 0 2.8" /></svg>;
    case 'volup':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><path {...p} d="M2 6h2.5L8 3v10L4.5 10H2z" /><path {...p} d="M11 6.6a3 3 0 0 1 0 2.8M13.4 4.8a6 6 0 0 1 0 6.4" /></svg>;
    case 'play':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><path {...p} d="M3 3.5 9 8l-6 4.5z" /><path {...p} d="M12 3.5v9M15 3.5v9" /></svg>;
    case 'screen':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><rect {...p} x="2" y="3.5" width="14" height="9" rx="1.4" /><path {...p} d="M6 8h4l-1.4-1.4M10 8 8.6 9.4" /></svg>;
    case 'search':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><circle {...p} cx="7" cy="7" r="4" /><path {...p} d="m10.2 10.2 3 3" /></svg>;
    case 'task':
      return <svg viewBox="0 0 18 16" className="h-kb__svg"><rect {...p} x="2" y="3.5" width="10" height="7" rx="1.2" /><path {...p} d="M14.5 6v6.5H6" /></svg>;
    case 'lock':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><rect {...p} x="3.5" y="7" width="9" height="6" rx="1.4" /><path {...p} d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7" /></svg>;
    case 'win':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path fill="currentColor" d="M2.5 3.6 7.3 3v4.6H2.5zm0 8.8 4.8.6V8.4H2.5zM8.2 2.9 13.5 2v5.6H8.2zm0 5.5h5.3V14l-5.3-.9z" /></svg>;
    case 'emoji':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><rect {...p} x="3" y="3" width="10" height="10" rx="1.6" /><path fill="currentColor" d="M8 6.2c-1.5-1.3-3.2.4-1.8 1.9L8 10l1.8-1.9c1.4-1.5-.3-3.2-1.8-1.9z" /></svg>;
    case 'left':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path {...p} d="M9.6 4.6 6 8l3.6 3.4" /></svg>;
    case 'right':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path {...p} d="M6.4 4.6 10 8l-3.6 3.4" /></svg>;
    case 'up':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path {...p} d="M4.6 9.6 8 6l3.4 3.6" /></svg>;
    case 'down':
      return <svg viewBox="0 0 16 16" className="h-kb__svg"><path {...p} d="M4.6 6.4 8 10l3.4-3.6" /></svg>;
    default:
      return null;
  }
});

/* --------------------------------------------------------------------------
   One key
   -------------------------------------------------------------------------- */
const Cap = memo(function Cap({ k, wanted, down, order }) {
  const cls = ['h-key'];
  if (wanted) cls.push('is-wanted');
  if (down) cls.push('is-down');
  if (k.align) cls.push(`is-${k.align}`);
  // A cap either carries a word or a drawing, never its own variable name:
  // "ArrowLeft" is not printed on any keyboard.
  const label = k.label ?? (k.top || k.glyph ? null : k.name);

  return (
    <div
      className={cls.join(' ')}
      style={{ '--kw': k.w ?? 1 }}
      data-key={k.name}
      data-order={order ?? undefined}
      aria-hidden="true"
    >
      <span className="h-key__face">
        {k.dotted && <i className="h-key__pip" />}
        {k.glyph && k.name === 'ArrowUpDown' ? (
          <span className="h-key__stack"><Glyph name="up" /><Glyph name="down" /></span>
        ) : k.glyph ? (
          <span className="h-key__glyph"><Glyph name={k.glyph} /></span>
        ) : null}
        {k.top && <span className="h-key__top">{k.top}</span>}
        {label != null && label !== '' && <span className="h-key__main">{label}</span>}
        {k.sub && <span className={`h-key__sub${k.flip ? ' is-flip' : ''}`}>{k.sub}</span>}
      </span>
    </div>
  );
});

/* --------------------------------------------------------------------------
   The board

   `need` is the chord to light up, in the order it should be read. `dim`
   fades the whole thing back — onboarding sets it while a key is actually
   held down, which is the one moment a picture of a keyboard is no help.
   -------------------------------------------------------------------------- */
export function Keyboard({ need = [], down = [], dim = false, className = '' }) {
  const heldNames = new Set(down);
  return (
    <div className={`h-kb${dim ? ' is-dim' : ''} ${className}`} role="img"
      aria-label={need.length ? `Keyboard, with ${need.join(' plus ')} highlighted` : 'Keyboard'}>
      <div className="h-kb__board">
        {ROWS.map((row, i) => (
          <div className="h-kb__row" key={i}>
            {row.map((k) => (
              <Cap
                key={k.name}
                k={k}
                wanted={answersTo(k.name, need, { bothSides: false })}
                down={[...heldNames].some((n) => answersTo(k.name, [n]))}
                order={need.findIndex((w) => answersTo(k.name, [w], { bothSides: false })) + 1 || undefined}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   What is held down, right now

   Physical keys, from this window. A chord is only ever counted as pressed
   by the bridge (Windows told it), never by this — but which keys are down
   is exactly what a keyboard on screen should show.
   -------------------------------------------------------------------------- */
export function useKeysDown() {
  const [down, setDown] = useState([]);

  useEffect(() => {
    const held = new Set();
    const sync = () => setDown([...held]);
    const on = (e) => {
      const name = keyNameFor(e.code);
      if (!held.has(name)) { held.add(name); sync(); }
    };
    const off = (e) => {
      const name = keyNameFor(e.code);
      if (held.delete(name)) sync();
    };
    // Losing the window loses the keyups with it, so assume everything is up.
    const clear = () => { if (held.size) { held.clear(); sync(); } };
    addEventListener('keydown', on, true);
    addEventListener('keyup', off, true);
    addEventListener('blur', clear);
    return () => {
      removeEventListener('keydown', on, true);
      removeEventListener('keyup', off, true);
      removeEventListener('blur', clear);
    };
  }, []);

  return down;
}
