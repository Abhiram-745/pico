/* ==========================================================================
   Halo — the floating companion

   In production this is the small always-on-top overlay. It stays visually
   simple on purpose: the character, a halo, and one line of status. Anything
   that needs typing lives in the palette, because the overlay window is
   WS_EX_NOACTIVATE and therefore cannot take keyboard focus.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from './store.js';
import { bridge } from './bridge.js';
import { Mascot } from './mascot.js';

const MODIFIER_LABELS = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };

export function mountCompanion(host, { size = 190 } = {}) {
  const root = document.createElement('div');
  root.className = 'companion';
  root.dataset.phase = 'Idle';

  const mascot = new Mascot({ size });

  const bubble = document.createElement('div');
  bubble.className = 'companion__bubble glass glass-accent-edge';
  bubble.innerHTML = `
    <div class="companion__status">
      <span class="dot"></span>
      <span class="companion__title"></span>
    </div>
    <div class="companion__detail"></div>
    <div class="worm companion__worm" hidden></div>
    <div class="companion__hold" hidden>
      <div class="companion__hold-text">Still holding the chord — release to resume</div>
      <div class="companion__hold-keys"></div>
    </div>
    <div class="companion__actions">
      <button class="btn btn--ghost companion__pause" type="button"></button>
      <button class="btn btn--ghost companion__stop" type="button">Stop</button>
    </div>
  `;

  const els = {
    title:  bubble.querySelector('.companion__title'),
    detail: bubble.querySelector('.companion__detail'),
    worm:   bubble.querySelector('.companion__worm'),
    hold:   bubble.querySelector('.companion__hold'),
    keys:   bubble.querySelector('.companion__hold-keys'),
    pause:  bubble.querySelector('.companion__pause'),
    stop:   bubble.querySelector('.companion__stop'),
  };

  root.append(mascot.el, bubble);
  host.append(root);

  els.pause.addEventListener('click', () => {
    const { pause, phase } = store.state;
    bridge.send(pause.paused || phase === 'Paused' ? 'resume' : 'pause');
  });
  els.stop.addEventListener('click', () => bridge.send('stop'));

  // Clicking the character opens the palette — the one affordance the pet has.
  mascot.el.addEventListener('click', () => bridge.send('openPalette'));

  store.subscribe((state, meta) => {
    const { phase, action, pause } = state;

    root.dataset.phase = phase;
    mascot.setPhase(phase);

    const copy = PHASE_COPY[phase] || PHASE_COPY.Idle;
    els.title.textContent = copy.title;

    // While acting, the action's own line is more informative than the phase's.
    // Once complete, the model's closing sentence beats a generic phase string.
    const detail = (phase === 'Acting' && action?.detail) ? action.detail
      : (phase === 'Completed' && state.summary) ? state.summary
      : copy.detail;
    els.detail.textContent = detail;
    els.detail.hidden = !detail;

    els.worm.hidden = !['Starting', 'Observing', 'Thinking', 'Acting'].includes(phase);

    els.pause.textContent = phase === 'Paused' ? 'Resume' : 'Pause';
    els.pause.disabled = !isActive(phase);
    els.stop.disabled = !isActive(phase);

    // --- the fix -----------------------------------------------------------
    // The real audit log shows three resume attempts re-paused within the same
    // second because the modifiers were still physically down, with no UI
    // signal at all. Now the blocked state is explicit and each key goes dark
    // as it is released.
    const blocked = pause.blockedReason === 'modifier-held';
    els.hold.hidden = !blocked;
    if (blocked) {
      const held = new Set(pause.heldModifiers || []);
      els.keys.replaceChildren(
        ...['ctrl', 'shift'].map((mod) => {
          const k = document.createElement('span');
          k.className = 'kbd';
          k.dataset.held = String(held.has(mod));
          k.textContent = MODIFIER_LABELS[mod];
          return k;
        }),
      );
    }

    if (meta.type === 'action') mascot.pulse();
    if (meta.type === 'pause' && blocked) {
      bubble.classList.remove('nudge');
      void bubble.getBoundingClientRect();
      bubble.classList.add('nudge');
    }
  });

  return { root, mascot };
}
