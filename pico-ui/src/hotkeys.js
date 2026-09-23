/* ==========================================================================
   Halo — hotkeys

   In production these chords are registered by the *host*, not the page:
     Ctrl+Shift+Space   pause / resume        (Halo.Guardian.exe)
     Esc                emergency stop        (Halo.Guardian.exe)
     Ctrl+Shift+Bksp    emergency stop        (Halo.Guardian.exe)
     Ctrl+Shift+P       toggle palette        (Halo.Desktop, new)

   The three Guardian chords must keep working when Halo is unfocused, which
   is only possible from a process that owns a global RegisterHotKey. This
   module reproduces them in-page so the whole interaction is testable in a
   browser, and so the harness can demonstrate the held-modifier state.

   Ctrl+Shift+P must also be added to the injector's protected-chord list, so
   the model cannot synthesize it and summon Halo's own UI. See INTEGRATION.md.
   ========================================================================== */

import { store, isActive } from './store.js';
import { bridge } from './bridge.js';
import { stopEverything } from './voice-session.js';

const MOD_KEYS = { Control: 'ctrl', Shift: 'shift', Alt: 'alt' };

export function installHotkeys({ palette, onModifiers } = {}) {
  const held = new Set();

  const report = () => onModifiers?.([...held]);

  window.addEventListener('keydown', (e) => {
    const mod = MOD_KEYS[e.key];
    if (mod && !held.has(mod)) { held.add(mod); report(); }

    // --- Ctrl+Shift+P : toggle the palette --------------------------------
    // e.code so it survives keyboard layouts where P is elsewhere.
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      palette?.toggle();
      return;
    }

    // --- Ctrl+Shift+Space : pause / resume --------------------------------
    if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
      e.preventDefault();
      const { phase, pause } = store.state;
      if (!isActive(phase)) return;
      bridge.send(pause.paused || phase === 'Paused' ? 'resume' : 'pause');
      return;
    }

    // --- Ctrl+Shift+Backspace : emergency stop ----------------------------
    if (e.ctrlKey && e.shiftKey && e.code === 'Backspace') {
      e.preventDefault();
      if (isActive(store.state.phase)) bridge.send('stop');
      return;
    }

    // --- Esc : the Stop button, from the keyboard -------------------------
    // Ends a live run and any voice at once, the way the Stop button does.
    // When the palette is open and handling its own Escape, it stops
    // propagation itself; this is the unfocused/global path.
    if (e.key === 'Escape' && (isActive(store.state.phase) || store.state.voice?.active) && !store.state.paletteOpen) {
      stopEverything();
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    const mod = MOD_KEYS[e.key];
    if (mod && held.has(mod)) { held.delete(mod); report(); }
  }, true);

  // Losing focus loses keyup events, so assume everything came up.
  window.addEventListener('blur', () => {
    if (held.size) { held.clear(); report(); }
  });

  return { held };
}
