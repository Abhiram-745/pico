/* ==========================================================================
   Pico — the notch

   Replaces the floating companion. Sits at the top of the screen, always
   there, and is the control surface: tasks, approvals, takeovers, agents and
   chat all happen here rather than in a separate window.

   Modes, smallest to largest:
     rest    a slim pill — the pet and a status dot
     glance  widens on its own when something changes, then settles back
     panel   task entry, decisions, the agent list
     chat    conversation view

   In the Windows host this is one always-on-top, click-through-except-here
   window docked to the top centre of the primary display. It replaces
   OverlayWindow; the palette window stays for keyboard-first use.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from './store.js';
import { bridge } from './bridge.js';
import { Mascot } from './mascot.js';
import { renderApproval, renderTakeover, renderError } from './cards.js';
import { CursorLayer, AGENT_COLORS, AGENT_NAMES } from './cursors.js';
import { permissions, LEVELS } from './permissions.js';

const NAME_KEY = 'pico.pet.name.v1';
const AGENTS_KEY = 'pico.agents.v1';
const BG_KEY = 'pico.background.v1';

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v === null ? fallback : v; }
  catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const ICONS = {
  send: 'M5 12h13M12 5l7 7-7 7',
  chat: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z',
  agents: 'M4 4l7.5 4.7-3.3.8-1.7 3z M13 10l7.5 4.7-3.3.8-1.7 3z',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  shield: 'M12 3l7.5 3v5.4c0 4.3-3.1 7.9-7.5 9.1-4.4-1.2-7.5-4.8-7.5-9.1V6z M9 12l2.2 2.2L15.2 10',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z',
};

const icon = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
};

/**
 * @param {HTMLElement} host
 * @param {object}  opts
 * @param {boolean} opts.windowed   the notch is its own OS window, so it
 *                                  fills the frame and reports its own size
 * @param {(size:{height:number})=>void} opts.onMeasure
 */
export function mountNotch(host = document.body, { windowed = false, onMeasure } = {}) {
  const root = el('div', 'notch-layer');
  root.dataset.mode = 'rest';
  root.dataset.phase = 'Idle';
  if (windowed) root.dataset.host = 'window';

  const scrim = el('div', 'notch-layer__scrim');

  const notch = el('div', 'notch');
  notch.setAttribute('role', 'region');
  notch.setAttribute('aria-label', 'Pico');

  // --- bar -----------------------------------------------------------------
  const bar = el('div', 'notch__bar');
  const petMount = el('div', 'notch__pet');
  const mascot = new Mascot({ size: 40 });
  petMount.append(mascot.el);

  const textWrap = el('div', 'notch__text');
  const nameEl = el('div', 'notch__name');
  const statusEl = el('div', 'notch__status');
  textWrap.append(nameEl, statusEl);

  const chips = el('div', 'notch__cursors');
  const pulse = el('div', 'notch__pulse');
  bar.append(petMount, textWrap, chips, pulse);

  // --- body ----------------------------------------------------------------
  const body = el('div', 'notch__body');

  const field = el('div', 'notch__field');

  /* Auto decides between talking and working; the other two settle it by
     hand. It has to be visible, not buried in settings, because the whole
     point is that you can see and change what Pico is about to do with
     what you typed. */
  const modeBtn = el('button', 'notch__mode');
  modeBtn.type = 'button';
  const MODE_ORDER = ['auto', 'chat', 'agent'];
  const MODE_LABEL = { auto: 'Auto', chat: 'Chat', agent: 'Do it' };
  const MODE_HINT = {
    auto: 'Pico decides: talk, or work',
    chat: 'Talk only — nothing is touched',
    agent: 'Always act on the desktop',
  };
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = MODE_ORDER[(MODE_ORDER.indexOf(store.state.mode) + 1) % MODE_ORDER.length];
    store.setMode(next);
    input.focus();
  });

  const input = el('input', 'notch__input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Message or task');
  const send = el('button', 'notch__send');
  send.type = 'button';
  send.setAttribute('aria-label', 'Send');
  send.append(icon(ICONS.send));
  field.append(modeBtn, input, send);

  const scroll = el('div', 'notch__scroll');

  const foot = el('div', 'notch__foot');
  const chatBtn = el('button', 'notch__iconbtn');
  chatBtn.type = 'button';
  chatBtn.title = 'Chat';
  chatBtn.append(icon(ICONS.chat));

  const agentsBtn = el('button', 'notch__iconbtn');
  agentsBtn.type = 'button';
  agentsBtn.title = 'Cursors';
  agentsBtn.append(icon(ICONS.agents));

  const bgBtn = el('button', 'notch__iconbtn');
  bgBtn.type = 'button';
  bgBtn.title = 'Work in the background';
  bgBtn.append(icon(ICONS.eye));

  const permBtn = el('button', 'notch__iconbtn');
  permBtn.type = 'button';
  permBtn.title = 'Permissions';
  permBtn.append(icon(ICONS.shield));

  const gearBtn = el('button', 'notch__iconbtn');
  gearBtn.type = 'button';
  gearBtn.title = 'Rename';
  gearBtn.append(icon(ICONS.gear));

  const footSpacer = el('div', 'notch__foot-spacer');
  foot.append(
    el('span', 'kbd', 'Ctrl'), el('span', 'kbd', 'Shift'), el('span', 'kbd', 'P'),
    el('span', 'notch__foot-label', 'palette'),
    footSpacer, chatBtn, agentsBtn, bgBtn, permBtn, gearBtn,
  );

  body.append(field, scroll, foot);
  notch.append(bar, body);
  // Siblings, not nested: the scrim fades to opacity 0 in rest mode, and a
  // nested notch would fade out with it.
  root.append(scrim, notch);
  host.append(root);

  // --- cursors -------------------------------------------------------------
  const cursorLayer = new CursorLayer(host);

  let petName = read(NAME_KEY, 'Pico');
  let agentCount = Math.max(1, Math.min(6, Number(read(AGENTS_KEY, '1')) || 1));
  let background = read(BG_KEY, 'true') === 'true';
  let view = 'tasks';        // tasks | agents | chat | rename
  let mode = 'rest';         // rest | glance | panel | chat
  let glanceTimer = null;
  const agentState = new Map();   // id -> { task, state }
  const autoApproved = new Set(); // approval ids answered without asking

  cursorLayer.ensure(agentCount);
  cursorLayer.showAll(background);

  // --- mode ----------------------------------------------------------------
  function setMode(next) {
    mode = next;
    root.dataset.mode = next;
    if (next === 'panel' || next === 'chat') {
      queueMicrotask(() => input.focus({ preventScroll: true }));
    }
  }

  /** Widen briefly to show a change, then settle back. */
  function glance(ms = 2600) {
    if (mode === 'panel' || mode === 'chat') return;
    setMode('glance');
    clearTimeout(glanceTimer);
    glanceTimer = setTimeout(() => { if (mode === 'glance') setMode('rest'); }, ms);
  }

  function open(which = 'tasks') {
    view = which;
    setMode(which === 'chat' ? 'chat' : 'panel');
    render(store.state);
  }

  function close() {
    clearTimeout(glanceTimer);
    setMode('rest');
    input.blur();
  }

  const toggle = () => (mode === 'rest' || mode === 'glance' ? open('tasks') : close());

  // --- rendering -----------------------------------------------------------
  function renderChips() {
    const busy = [...agentState.entries()].filter(([, a]) => a.state && a.state !== 'idle');
    chips.replaceChildren(...busy.slice(0, 4).map(([id]) => {
      const c = cursorLayer.get(id);
      const chip = el('span', 'notch__cursor-chip', c?.label ?? '');
      chip.style.background = c?.color ?? 'var(--accent)';
      return chip;
    }));
  }

  function renderTasks(state) {
    const frag = document.createDocumentFragment();

    if (state.approval && !autoApproved.has(state.approval.id)) {
      frag.append(renderApproval(state.approval));
    }
    else if (state.takeover) frag.append(renderTakeover(state.takeover));
    else if (state.error) frag.append(renderError(state.error));

    if (!state.approval && !state.takeover && state.recents.length) {
      const wrap = el('div', 'agents');
      wrap.append(el('div', 'agents__title', 'Recent'));
      const list = el('div', 'agents__list');
      for (const t of state.recents.slice(0, 4)) {
        const row = el('button', 'agent');
        row.type = 'button';
        row.style.setProperty('--agent-color', 'var(--text-lo)');
        const main = el('div', 'agent__main');
        main.append(el('div', 'agent__name', t));
        row.append(main);
        row.addEventListener('click', () => { input.value = t; input.focus(); updateSend(); });
        list.append(row);
      }
      wrap.append(list);
      frag.append(wrap);
    }
    return frag;
  }

  function renderAgents() {
    const wrap = el('div', 'agents');

    const head = el('div', 'agents__head');
    head.append(el('span', 'agents__title', 'Cursors'));
    const count = el('div', 'agents__count');
    const minus = el('button', 'agents__step', '−');
    const n = el('span', 'agents__n', String(agentCount));
    const plus = el('button', 'agents__step', '+');
    minus.type = plus.type = 'button';
    minus.disabled = agentCount <= 1;
    plus.disabled = agentCount >= 6;
    minus.addEventListener('click', () => setAgentCount(agentCount - 1));
    plus.addEventListener('click', () => setAgentCount(agentCount + 1));
    count.append(minus, n, plus);
    head.append(count);
    wrap.append(head);

    const list = el('div', 'agents__list');
    for (const c of cursorLayer.all()) {
      const st = agentState.get(c.id) || { state: 'idle', task: '' };
      const row = el('div', 'agent');
      row.style.setProperty('--agent-color', c.color);
      row.dataset.busy = String(st.state !== 'idle');

      const dot = el('div', 'agent__dot', c.label);
      const main = el('div', 'agent__main');
      main.append(el('div', 'agent__name', `Cursor ${c.label}`));
      main.append(el('div', 'agent__task', st.task || 'Waiting for a task'));
      row.append(dot, main, el('div', 'agent__state', st.state));
      list.append(row);
    }
    wrap.append(list);

    const note = el('p', 'notch__note',
      'Each cursor runs its own task and makes its own model request, ' +
      'concurrently. They are drawn, not the system pointer — so your real ' +
      'mouse stays yours while they work.');
    note.style.marginTop = '10px';
    wrap.append(note);
    return wrap;
  }

  function renderPermissions() {
    const wrap = el('div', 'agents');
    wrap.append(el('div', 'agents__title', 'Permissions'));

    const list = el('div', 'agents__list');
    for (const lv of Object.values(LEVELS)) {
      const row = el('button', 'agent perm');
      row.type = 'button';
      row.dataset.selected = String(permissions.level === lv.id);
      row.style.setProperty('--agent-color', lv.id === 'all' ? '#fb923c' : 'var(--accent)');

      const tick = el('div', 'perm__tick');
      tick.textContent = permissions.level === lv.id ? '✓' : '';

      const main = el('div', 'agent__main');
      main.append(el('div', 'agent__name', lv.label));
      main.append(el('div', 'agent__task', lv.hint));
      row.append(tick, main);
      row.addEventListener('click', () => { permissions.set(lv.id); render(store.state); });
      list.append(row);
    }
    wrap.append(list);

    const note = el('p', 'notch__note',
      'Credentials, CAPTCHAs and Windows security prompts always come to you — ' +
      'Pico cannot type a credential, so there is nothing to auto-approve. ' +
      '"Accept all" lasts for this session only and is never remembered.');
    note.style.marginTop = '10px';
    wrap.append(note);
    return wrap;
  }

  function renderChat(state) {
    const wrap = el('div', 'notch__msgs');
    // One thread, shared with the app window through the store — so what you
    // type up here is the same conversation you see down there.
    for (const m of state.messages) {
      const node = el('div', `msg msg--${m.from}`);
      if (!m.text && !m.done) {
        const t = el('span', 'msg__typing');
        t.append(el('i'), el('i'), el('i'));
        node.append(t);
      } else {
        node.textContent = m.text;
      }
      wrap.append(node);
    }
    return wrap;
  }

  function renderRename() {
    const wrap = el('div');
    const row = el('div', 'rename');
    const field2 = el('input', 'rename__input');
    field2.type = 'text';
    field2.value = petName;
    field2.maxLength = 24;
    field2.setAttribute('aria-label', 'Name');
    const save = el('button', 'btn btn--primary', 'Save');
    save.type = 'button';

    const commit = () => {
      const v = field2.value.trim().slice(0, 24);
      if (v) { petName = v; write(NAME_KEY, v); }
      view = 'tasks';
      render(store.state);
    };
    save.addEventListener('click', commit);
    field2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });

    row.append(field2, save);
    wrap.append(el('div', 'agents__title', 'What should I call it?'), row);
    queueMicrotask(() => field2.select());
    return wrap;
  }

  function updateSend() {
    send.disabled = !input.value.trim() || !store.canSubmit;
  }

  function render(state) {
    root.dataset.phase = state.phase;
    mascot.setPhase(state.phase);

    const copy = PHASE_COPY[state.phase] || PHASE_COPY.Idle;
    nameEl.textContent = state.phase === 'Idle' ? petName : copy.title;

    const detail = state.phase === 'Acting' && state.action?.detail ? state.action.detail
      : state.phase === 'Completed' && state.summary ? state.summary
      : copy.detail;
    statusEl.textContent = detail || (state.phase === 'Idle' ? 'Ready' : '');

    input.placeholder = state.mode === 'chat'
      ? `Talk to ${petName}…`
      : state.mode === 'agent'
        ? `Tell ${petName} what to do…`
        : `Message or task…`;
    input.disabled = !state.guardian.ready;
    modeBtn.textContent = MODE_LABEL[state.mode];
    modeBtn.dataset.mode = state.mode;
    modeBtn.title = MODE_HINT[state.mode];
    updateSend();

    chatBtn.setAttribute('aria-pressed', String(view === 'chat'));
    agentsBtn.setAttribute('aria-pressed', String(view === 'agents'));
    permBtn.setAttribute('aria-pressed', String(permissions.level !== 'ask'));
    permBtn.title = `Permissions — ${LEVELS[permissions.level].label}`;
    bgBtn.setAttribute('aria-pressed', String(background));
    bgBtn.title = background ? 'Working in the background' : 'Bring work to the front';

    renderChips();

    if (mode === 'panel' || mode === 'chat') {
      scroll.replaceChildren(
        view === 'agents' ? renderAgents()
          : view === 'chat' ? renderChat(state)
          : view === 'rename' ? renderRename()
          : view === 'perms' ? renderPermissions()
          : renderTasks(state),
      );
      // Keep the task box available everywhere except while renaming,
      // where it would compete with the name field for Enter.
      field.hidden = view === 'rename' || view === 'perms';
    }

    // Size to content rather than to a fixed height — in a page that means
    // the element's own height, in a window it means the window's.
    requestAnimationFrame(() => measure());
  }

  /** What this notch wants to be, given what it is currently showing. */
  function measure() {
    if (mode === 'rest' || mode === 'glance') {
      const h = bar.offsetHeight + (windowed ? 8 : 0);
      if (windowed) onMeasure?.({ height: Math.max(52, h) });
      return;
    }

    const content = bar.offsetHeight
      + (field.hidden ? 0 : field.offsetHeight + 12)
      + scroll.scrollHeight
      + foot.offsetHeight
      + 18;

    if (windowed) {
      onMeasure?.({ height: Math.max(180, Math.min(720, content)) });
    } else {
      notch.style.setProperty(
        '--panel-h',
        `${Math.max(180, Math.min(window.innerHeight * 0.7, content))}px`,
      );
    }
    if (view === 'chat') scroll.scrollTop = scroll.scrollHeight;
  }

  // --- agents --------------------------------------------------------------
  function setAgentCount(n) {
    agentCount = Math.max(1, Math.min(6, n));
    write(AGENTS_KEY, agentCount);
    cursorLayer.ensure(agentCount);
    cursorLayer.showAll(background);
    for (const id of [...agentState.keys()]) {
      if (!cursorLayer.get(id)) agentState.delete(id);
    }
    render(store.state);
  }

  /**
   * Drive a cursor through a step. Exposed so the host (or the demo) can move
   * agents around; each call animates at display rate rather than jumping.
   */
  async function driveCursor(id, { x, y, state, task, click = false }) {
    const c = cursorLayer.get(id);
    if (!c) return;
    const prev = agentState.get(id) || {};
    agentState.set(id, { task: task ?? prev.task ?? '', state: state ?? prev.state ?? 'idle' });
    if (state) c.setState(state === 'idle' ? 'idle' : 'working');
    renderChips();
    if (typeof x === 'number' && typeof y === 'number') await c.moveTo(x, y);
    if (click) c.click();
    if (mode === 'panel' && view === 'agents') render(store.state);
  }

  // --- events --------------------------------------------------------------
  bar.addEventListener('click', (e) => {
    if (e.target.closest('.notch__iconbtn')) return;
    toggle();
  });

  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });

  input.addEventListener('input', updateSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && !isActive(store.state.phase)) { e.preventDefault(); close(); }
  });
  send.addEventListener('click', submit);

  chatBtn.addEventListener('click', () => open(view === 'chat' ? 'tasks' : 'chat'));
  agentsBtn.addEventListener('click', () => { view = view === 'agents' ? 'tasks' : 'agents'; open(view); });
  permBtn.addEventListener('click', () => { view = view === 'perms' ? 'tasks' : 'perms'; open(view); });
  gearBtn.addEventListener('click', () => { view = view === 'rename' ? 'tasks' : 'rename'; open(view); });
  bgBtn.addEventListener('click', () => {
    background = !background;
    write(BG_KEY, background);
    cursorLayer.showAll(background);
    render(store.state);
  });

  function submit() {
    const text = input.value.trim();
    if (!text || send.disabled) return;

    // Added locally under an id the host echoes back, so it appears the
    // instant you press Enter rather than after a network round trip.
    const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    store.addMessage({ id, from: 'you', text, done: true });
    store.addRecent(text);
    bridge.send('submitTask', { text, mode: store.state.mode, id });

    input.value = '';
    updateSend();
    // Stay open on the conversation. Closing the moment you said something
    // meant a reply arrived to a notch that was no longer showing it.
    open('chat');
  }

  // --- store ---------------------------------------------------------------
  /* Auto-approval. The decision is taken here rather than in the host so the
     user can see what was allowed and why — a silent auto-yes would be worse
     than the prompt it replaces. Takeover is never auto-answered. */
  function maybeAutoApprove(state) {
    const a = state.approval;
    if (!a || autoApproved.has(a.id)) return false;

    const { auto, why } = permissions.decide(a);
    if (!auto) return false;

    autoApproved.add(a.id);
    store.addMessage({ from: 'event', text: `Auto-approved: ${a.summary} — ${why}` });
    bridge.send('approve', { id: a.id });
    glance(2200);
    return true;
  }

  store.subscribe((state, meta) => {
    if (meta.type === 'approval' && state.approval && maybeAutoApprove(state)) {
      render(state);
      return;   // never surface a card we just answered
    }

    if (meta.type === 'phase') {
      // Anything that needs a human opens the notch properly; ordinary
      // progress only earns a glance.
      if (state.phase === 'AwaitingApproval') {
        if (maybeAutoApprove(state)) { render(state); return; }
        // The host sends `approval` then `phase`. If the first one was already
        // auto-approved, this second event must not re-open the card we just
        // answered — otherwise it flashes on screen for a frame.
        if (state.approval && autoApproved.has(state.approval.id)) { render(state); return; }
        open('tasks');
      } else if (state.phase === 'AwaitingTakeover') {
        open('tasks');   // always a human; permissions never bypass this
      } else if (state.phase !== 'Idle') glance();
    }
    if (meta.type === 'action') { mascot.pulse(); glance(1800); }
    if (meta.type === 'summary' && state.summary) glance(3200);

    // A reply is a conversation, not a run: show it where it can be read
    // rather than flashing a status line that vanishes.
    if (meta.type === 'routed' && state.routed?.mode === 'chat') open('chat');
    if (meta.type === 'message' && mode === 'rest') glance(2600);

    render(state);
  });

  render(store.state);

  return {
    root, notch, mascot, cursorLayer,
    open, close, toggle, glance, driveCursor, setAgentCount,
    get name() { return petName; },
    get agentCount() { return agentCount; },
    get background() { return background; },
  };
}
