/* ==========================================================================
   Halo — command palette  (Ctrl+Shift+P)

   The keyboard-first surface. This is a separate, activatable window in the
   host: the companion overlay is WS_EX_NOACTIVATE and can never take focus,
   so anything involving typing has to live here.

   Esc handling is deliberately not the usual "close on Escape". Esc is the
   Guardian's emergency stop. Swallowing it while a run is live would take
   away the fastest way to halt the agent, so during a run Esc is left alone
   and the palette says so.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from './store.js';
import { bridge } from './bridge.js';
import { renderApproval, renderTakeover, renderError } from './cards.js';
import { renderSettings } from './settings.js';
import { renderTimeline } from './timeline.js';

const MODIFIER_LABELS = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };

/** Static commands. `when` gates visibility against current state. */
const COMMANDS = [
  {
    id: 'pause',
    title: 'Pause',
    hint: 'Stop before the next action',
    keys: ['Ctrl', 'Shift', 'Space'],
    when: (s) => isActive(s.phase) && s.phase !== 'Paused',
    run: () => bridge.send('pause'),
  },
  {
    id: 'resume',
    title: 'Resume',
    hint: 'Continue the current task',
    keys: ['Ctrl', 'Shift', 'Space'],
    when: (s) => s.phase === 'Paused',
    run: () => bridge.send('resume'),
  },
  {
    id: 'stop',
    title: 'Stop task',
    hint: 'End the run immediately',
    keys: ['Esc'],
    when: (s) => isActive(s.phase),
    run: () => bridge.send('stop'),
  },
  {
    id: 'settings',
    title: 'Settings',
    hint: 'Model, safety, API key',
    when: () => true,
    run: () => store.setSettingsOpen(true),
  },
  {
    id: 'tuck',
    title: 'Tuck Halo away',
    hint: 'Hide the companion; restore from the tray',
    when: () => true,
    run: () => bridge.send('tuckAway'),
  },
  {
    id: 'clear-recents',
    title: 'Clear recent tasks',
    hint: 'Forget locally stored task history',
    when: (s) => s.recents.length > 0,
    run: () => store.clearRecents(),
  },
];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const matches = (q, ...fields) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => String(f || '').toLowerCase().includes(needle));
};

export function mountPalette(host) {
  const root = el('div', 'palette-layer');
  root.hidden = true;

  const scrim = el('div', 'palette__scrim');

  const panel = el('div', 'palette glass glass-accent-edge');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Halo command palette');

  panel.innerHTML = `
    <div class="palette__run" hidden>
      <div class="palette__run-top">
        <span class="dot"></span>
        <span class="palette__run-title"></span>
        <span class="palette__run-turn"></span>
      </div>
      <div class="palette__run-detail"></div>
      <div class="worm"></div>
      <div class="palette__hold" hidden>
        <span class="palette__hold-text">Chord still held — release to resume</span>
        <span class="palette__hold-keys"></span>
      </div>
    </div>

    <div class="palette__field">
      <svg class="palette__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 12h4l2.5-6 3 12L16 12h4" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <input class="palette__input" type="text" autocomplete="off" spellcheck="false"
             placeholder="What should I do?" aria-label="Task or command">
      <span class="palette__badge" hidden></span>
    </div>

    <div class="palette__blocked" hidden></div>
    <div class="palette__body"></div>

    <div class="palette__footer">
      <div class="palette__hints"></div>
      <button class="palette__timeline-toggle btn btn--ghost" type="button">Activity</button>
    </div>
  `;

  const els = {
    run:       panel.querySelector('.palette__run'),
    runTitle:  panel.querySelector('.palette__run-title'),
    runTurn:   panel.querySelector('.palette__run-turn'),
    runDetail: panel.querySelector('.palette__run-detail'),
    hold:      panel.querySelector('.palette__hold'),
    holdKeys:  panel.querySelector('.palette__hold-keys'),
    input:     panel.querySelector('.palette__input'),
    badge:     panel.querySelector('.palette__badge'),
    blocked:   panel.querySelector('.palette__blocked'),
    body:      panel.querySelector('.palette__body'),
    hints:     panel.querySelector('.palette__hints'),
    timeline:  panel.querySelector('.palette__timeline-toggle'),
  };

  scrim.append(panel);
  root.append(scrim);
  host.append(root);

  let selection = 0;
  let rows = [];
  let showTimeline = false;

  // --- rendering -----------------------------------------------------------
  function buildRows(state) {
    const q = els.input.value.trim();
    const out = [];

    if (q) {
      out.push({
        kind: 'run-task',
        title: q,
        hint: 'Run this task',
        run: () => submit(q),
      });
    }

    for (const r of state.recents) {
      if (q && !matches(q, r)) continue;
      if (q && r.toLowerCase() === q.toLowerCase()) continue;
      out.push({ kind: 'recent', title: r, hint: 'Recent', run: () => submit(r) });
    }

    for (const c of COMMANDS) {
      if (!c.when(state)) continue;
      if (!matches(q, c.title, c.hint)) continue;
      out.push({ kind: 'command', ...c });
    }
    return out;
  }

  function renderList(state) {
    rows = buildRows(state);
    if (selection >= rows.length) selection = Math.max(0, rows.length - 1);

    const list = el('div', 'palette__list');
    let lastKind = null;

    rows.forEach((row, i) => {
      const kindLabel = row.kind === 'run-task' ? null
        : row.kind === 'recent' ? 'Recent tasks' : 'Commands';
      if (kindLabel && kindLabel !== lastKind) {
        list.append(el('div', 'section-label', kindLabel));
        lastKind = kindLabel;
      }

      const item = el('button', 'palette__row row-in');
      item.type = 'button';
      item.dataset.index = String(i);
      if (i === selection) item.classList.add('is-selected');

      const icon = el('span', `palette__row-icon palette__row-icon--${row.kind}`);
      icon.textContent = row.kind === 'run-task' ? '▶' : row.kind === 'recent' ? '↺' : '⌘';

      const main = el('span', 'palette__row-main');
      main.append(el('span', 'palette__row-title', row.title));
      if (row.hint) main.append(el('span', 'palette__row-hint', row.hint));

      item.append(icon, main);

      if (row.keys) {
        const keys = el('span', 'palette__row-keys');
        for (const k of row.keys) {
          const kb = el('span', 'kbd', k);
          kb.dataset.held = '';
          keys.append(kb);
        }
        item.append(keys);
      }

      item.addEventListener('click', () => { selection = i; activate(); });
      item.addEventListener('mousemove', () => {
        if (selection === i) return;
        selection = i;
        syncSelection();
      });
      list.append(item);
    });

    if (!rows.length) {
      list.append(el('div', 'palette__empty', 'Nothing matches. Type a task and press Enter to run it.'));
    }
    return list;
  }

  function syncSelection() {
    for (const node of els.body.querySelectorAll('.palette__row')) {
      node.classList.toggle('is-selected', Number(node.dataset.index) === selection);
    }
    els.body.querySelector('.palette__row.is-selected')
      ?.scrollIntoView({ block: 'nearest' });
  }

  function render(state) {
    root.dataset.phase = state.phase;

    // --- running strip ---
    const active = isActive(state.phase);
    els.run.hidden = !active;
    if (active) {
      const copy = PHASE_COPY[state.phase] || PHASE_COPY.Idle;
      els.runTitle.textContent = copy.title;
      const detail = state.phase === 'Acting' && state.action?.detail
        ? state.action.detail
        : state.phase === 'Completed' && state.summary
          ? state.summary
          : copy.detail;
      els.runDetail.textContent = detail;
      els.runDetail.hidden = !detail;
      els.runTurn.textContent = state.turn
        ? `${state.turn} / ${state.settings.maximumComputerTurns}`
        : '';

      const blocked = state.pause.blockedReason === 'modifier-held';
      els.hold.hidden = !blocked;
      if (blocked) {
        const held = new Set(state.pause.heldModifiers || []);
        els.holdKeys.replaceChildren(...['ctrl', 'shift'].map((m) => {
          const k = el('span', 'kbd', MODIFIER_LABELS[m]);
          k.dataset.held = String(held.has(m));
          return k;
        }));
      }
    }

    // --- guardian badge / submit gating ---
    const reason = store.submitBlockedReason;
    const guardianDown = !state.guardian.ready;
    els.badge.hidden = !guardianDown;
    if (guardianDown) els.badge.textContent = 'Guardian offline';

    els.blocked.hidden = !(guardianDown && !active);
    if (!els.blocked.hidden) els.blocked.textContent = reason || '';

    els.input.disabled = guardianDown;

    // --- body ---
    if (state.settingsOpen) {
      els.body.replaceChildren(renderSettings(state));
    } else if (showTimeline) {
      els.body.replaceChildren(renderTimeline(state));
    } else {
      const frag = document.createDocumentFragment();
      if (state.approval) frag.append(renderApproval(state.approval));
      else if (state.takeover) frag.append(renderTakeover(state.takeover));
      else if (state.error) frag.append(renderError(state.error));

      // A pending decision owns the palette; the list would only distract.
      if (!state.approval && !state.takeover) frag.append(renderList(state));
      els.body.replaceChildren(frag);
    }

    els.timeline.textContent = showTimeline ? 'Back' : 'Activity';
    els.timeline.hidden = state.settingsOpen;

    renderHints(state);
  }

  function renderHints(state) {
    const active = isActive(state.phase);
    const hints = state.settingsOpen
      ? [['Esc', 'Back']]
      : active
        ? [['↑↓', 'Navigate'], ['↵', 'Run'], ['Esc', 'Emergency stop'], ['Ctrl Shift P', 'Close']]
        : [['↑↓', 'Navigate'], ['↵', 'Run'], ['Esc', 'Close']];

    els.hints.replaceChildren(...hints.map(([k, label]) => {
      const g = el('span', 'palette__hint');
      for (const part of k.split(' ')) g.append(el('span', 'kbd', part));
      g.append(el('span', 'palette__hint-label', label));
      return g;
    }));
  }

  // --- actions -------------------------------------------------------------
  function submit(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (!store.canSubmit) { nudge(); return; }
    store.addRecent(clean);
    store.set({ task: clean });
    bridge.send('submitTask', { text: clean });
    els.input.value = '';
    close();
  }

  function activate() {
    const row = rows[selection];
    if (!row) {
      const typed = els.input.value.trim();
      if (typed) submit(typed);
      return;
    }
    row.run();
    if (row.kind === 'command' && !['settings'].includes(row.id)) close();
  }

  function nudge() {
    panel.classList.remove('nudge');
    void panel.getBoundingClientRect();
    panel.classList.add('nudge');
  }

  // Closing is timed rather than driven by `animationend`: child animations
  // (rows, the progress worm) bubble their own animationend to the panel, and
  // under prefers-reduced-motion the exit animation is ~0ms. Both make the
  // event unreliable, which previously left the palette wedged open.
  let closeTimer = null;
  const CLOSE_MS = 180;

  function open() {
    clearTimeout(closeTimer);
    if (!root.hidden) { els.input.focus(); return; }
    root.hidden = false;
    panel.classList.remove('panel-out');
    panel.classList.add('panel-in');
    selection = 0;
    showTimeline = false;
    render(store.state);
    queueMicrotask(() => els.input.focus());
    store.setPaletteOpen(true);
  }

  function close() {
    if (root.hidden) return;
    panel.classList.remove('panel-in');
    panel.classList.add('panel-out');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      root.hidden = true;
      panel.classList.remove('panel-out');
    }, CLOSE_MS);
    store.setPaletteOpen(false);
    store.setSettingsOpen(false);
  }

  const toggle = () => (root.hidden ? open() : close());

  // --- events --------------------------------------------------------------
  els.input.addEventListener('input', () => { selection = 0; render(store.state); });

  els.timeline.addEventListener('click', () => {
    showTimeline = !showTimeline;
    render(store.state);
  });

  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });

  panel.addEventListener('keydown', (e) => {
    const state = store.state;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selection = Math.min(selection + 1, rows.length - 1);
      syncSelection();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selection = Math.max(selection - 1, 0);
      syncSelection();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      activate();
      return;
    }
    if (e.key === 'Escape') {
      if (state.settingsOpen) { e.preventDefault(); store.setSettingsOpen(false); return; }
      // Never swallow Esc during a run: it is the emergency stop.
      if (isActive(state.phase)) {
        flashEscHint();
        return;
      }
      e.preventDefault();
      close();
    }
  });

  function flashEscHint() {
    const hint = els.hints.querySelector('.palette__hint:nth-child(3)');
    if (!hint) return;
    hint.classList.remove('is-flashing');
    void hint.getBoundingClientRect();
    hint.classList.add('is-flashing');
  }

  store.subscribe((state, meta) => {
    if (!root.hidden) render(state);

    // A decision that needs a human should surface the palette itself.
    if (meta.type === 'approval' && state.approval) open();
    if (meta.type === 'takeover' && state.takeover) open();
  });

  return { open, close, toggle, root, panel, input: els.input };
}
