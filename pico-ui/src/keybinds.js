/* ==========================================================================
   Halo — the keybinds, in one place.

   One list, used by four things that must never disagree about it:

     - the native host, which registers them with Windows so they work while
       Halo is not the focused window (bridge/native/island-host.cs)
     - the island and the app, which act on them
     - onboarding, which teaches them and waits for the real keys
     - settings, which shows them

   WHY CTRL+ALT AND NOT CTRL+SHIFT
   Ctrl+Shift+<letter> is taken all over Windows and the browser, and the
   three chords Halo already had (pause, stop, palette) live there. Ctrl+Alt
   is nearly empty on Windows, is not a Windows-reserved prefix the way Win+
   is, and every chord below is three keys — which is what makes them hard to
   hit by accident, and what onboarding asks you to press.

   The id is what crosses the wire, so it is never renamed lightly; the
   `keys` are what a keyboard is asked to light up.
   ========================================================================== */

/**
 * @typedef {object} Keybind
 * @property {string} id       stable name, sent to and from the bridge
 * @property {string} label    what it does, in the fewest words that are true
 * @property {string} hint     one sentence, for settings and onboarding
 * @property {string[]} keys   key names as the keyboard draws them
 * @property {string} code     KeyboardEvent.code of the non-modifier key
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {boolean} taught  part of onboarding
 */

/** @type {Keybind[]} */
export const KEYBINDS = [
  {
    id: 'toggleHidden',
    label: 'Hide and show Halo',
    hint: 'Puts Halo away without stopping it, and brings it back.',
    keys: ['Ctrl', 'Alt', 'H'],
    code: 'KeyH',
    ctrl: true,
    alt: true,
    shift: false,
    taught: true,
    demo: 'hide',
  },
  {
    id: 'openChat',
    label: 'Talk to Halo',
    hint: 'Opens the island with the cursor already in the box, from anywhere.',
    /* A for ask. It was Ctrl+Alt+Space, which Windows refused to hand over on
       the machine this was built on — that chord belongs to the input-method
       switcher in several layouts, and a chord Windows will not register is
       a chord that silently does nothing. */
    keys: ['Ctrl', 'Alt', 'A'],
    code: 'KeyA',
    ctrl: true,
    alt: true,
    shift: false,
    taught: true,
    demo: 'chat',
  },
  {
    id: 'toggleCard',
    label: 'Island or floating card',
    hint: 'Switches between the strip at the top of the screen and a card you can move anywhere.',
    keys: ['Ctrl', 'Alt', 'F'],
    code: 'KeyF',
    ctrl: true,
    alt: true,
    shift: false,
    taught: true,
    demo: 'card',
  },
  {
    id: 'toggleGuide',
    label: 'Guide me instead',
    hint: 'Halo shows you where to click and what to type, and you do it yourself.',
    keys: ['Ctrl', 'Alt', 'G'],
    code: 'KeyG',
    ctrl: true,
    alt: true,
    shift: false,
    taught: true,
    demo: 'guide',
  },

  /* Already registered by the guardian, listed here so settings and
     onboarding show the whole picture rather than half of it. */
  {
    id: 'pause',
    label: 'Pause or carry on',
    hint: 'Stops Halo mid-task without losing where it was.',
    keys: ['Ctrl', 'Shift', 'Space'],
    code: 'Space',
    ctrl: true,
    alt: false,
    shift: true,
    taught: false,
  },
  {
    id: 'stop',
    label: 'Stop now',
    hint: 'Ends the task at once. Escape does the same while Halo is working.',
    keys: ['Ctrl', 'Shift', 'Backspace'],
    code: 'Backspace',
    ctrl: true,
    alt: false,
    shift: true,
    taught: false,
  },
  {
    id: 'palette',
    label: 'Command palette',
    hint: 'Everything Halo can do, by name.',
    keys: ['Ctrl', 'Shift', 'P'],
    code: 'KeyP',
    ctrl: true,
    alt: false,
    shift: true,
    taught: false,
  },
];

export const byId = (id) => KEYBINDS.find((k) => k.id === id) ?? null;

/** The ones onboarding teaches, in the order it teaches them. */
export const TAUGHT = KEYBINDS.filter((k) => k.taught);

/**
 * The key this event is about, by physical position.
 *
 * `code` is the right question — it is the same place on the board whatever
 * the layout — but it is not always answered: synthetic events, some remote
 * desktops and a few input methods send an empty one. Rather than ignore
 * those presses, fall back to the character.
 */
function codeOf(e) {
  if (e.code) return e.code;
  const k = String(e.key ?? '');
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  return k;
}

/** Does this keydown event match this keybind exactly? */
export function matches(e, bind) {
  if (!bind) return false;
  return codeOf(e) === bind.code
    && e.ctrlKey === bind.ctrl
    && e.altKey === bind.alt
    && e.shiftKey === bind.shift
    && !e.metaKey;
}

/** The keybind this event is, if it is one of ours. */
export function match(e, list = KEYBINDS) {
  return list.find((b) => matches(e, b)) ?? null;
}

/** "Ctrl + Alt + H" — for anywhere a chord is written out in a sentence. */
export const written = (bind) => (bind ? bind.keys.join(' + ') : '');
