/* ==========================================================================
   Pico — the full app window

   The notch is the always-there control. This is the room you go into: chat,
   activity, cursors, updates and settings, in one window.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from './store.js';
import { bridge } from './bridge.js';
import { Mascot } from './mascot.js';
import { renderApproval, renderTakeover, renderError } from './cards.js';
import { renderTimeline } from './timeline.js';
import { permissions, LEVELS } from './permissions.js';

const NAME_KEY = 'pico.pet.name.v1';

const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };

const el = (t, c, x) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (x != null) n.textContent = x;
  return n;
};

const ICONS = {
  chat:    'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z',
  activity:'M3 12h4l2.5-7 4 14 2.5-7h5',
  cursors: 'M4 4l7.5 4.7-3.3.8-1.7 3z M13 10l7.5 4.7-3.3.8-1.7 3z',
  update:  'M20 11a8 8 0 1 0-.6 3M20 5v6h-6',
  gear:    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z',
  send:    'M5 12h13M12 5l7 7-7 7',
  cloud:   'M7 18.5a4 4 0 0 1-.4-8A6 6 0 0 1 18 9.3a3.6 3.6 0 0 1-.6 9.2z',
  cloudDown: 'M7 17.5a4 4 0 0 1-.4-8A6 6 0 0 1 18 8.3a3.6 3.6 0 0 1 .6 7.1 M12 12v7m0 0-2.6-2.6M12 19l2.6-2.6',
  cloudCheck: 'M7 17.5a4 4 0 0 1-.4-8A6 6 0 0 1 18 8.3a3.6 3.6 0 0 1 .6 7.1 M9.4 16.6 11.6 19l4-5',
};

const icon = (d) => {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
};

/** A composed state rather than a bare line of grey text. */
function emptyState({ title, sub, action }) {
  const w = el('div', 'state');
  const pet = el('div', 'state__pet');
  pet.append(new Mascot({ size: 72 }).el);
  w.append(pet, el('div', 'state__title', title));
  if (sub) w.append(el('div', 'state__sub', sub));
  if (action) {
    const b = el('button', 'btn state__action', action.label);
    b.type = 'button';
    b.addEventListener('click', action.run);
    w.append(b);
  }
  return w;
}

function skeleton(rows = 4) {
  const w = el('div', 'panel');
  const list = el('div', 'skeleton-rows');
  for (let i = 0; i < rows; i++) {
    const r = el('div', 'skeleton');
    r.style.width = `${[92, 74, 84, 61, 79][i % 5]}%`;
    list.append(r);
  }
  w.append(list);
  return w;
}

function notice(title, body) {
  const w = el('div', 'notice');
  const m = el('div');
  m.append(el('div', 'notice__title', title));
  m.append(el('div', null, body));
  w.append(m);
  return w;
}

const SECTIONS = [
  { id: 'chat',     label: 'Chat',     icon: ICONS.chat,     title: 'Chat',     sub: 'Talk to Pico, or give it a job' },
  { id: 'activity', label: 'Activity', icon: ICONS.activity, title: 'Activity', sub: 'Every step, as it happens' },
  { id: 'desktop',  label: 'Desktop',  icon: ICONS.cursors,  title: 'Desktop',  sub: 'The notch, and where the pointer is' },
  { id: 'updates',  label: 'Updates',  icon: ICONS.update,   title: 'Updates',  sub: 'Keep Pico current' },
  { id: 'settings', label: 'Settings', icon: ICONS.gear,     title: 'Settings', sub: 'Model, permissions, name' },
];

/**
 * @param {object}  opts
 * @param {boolean} opts.demo  no bridge behind it — the hosted preview
 */
export function mountApp(host = document.body, { demo = false } = {}) {
  let section = 'chat';
  let petName = read(NAME_KEY, 'Pico');

  // --- shell ---------------------------------------------------------------
  const root = el('div', 'app');

  const side = el('aside', 'side');
  const brand = el('div', 'side__brand');
  const mascot = new Mascot({ size: 30 });
  const brandName = el('div', 'side__brand-name', petName);
  brand.append(mascot.el, brandName);

  const nav = el('nav', 'side__nav');
  const navLinks = new Map();
  for (const s of SECTIONS) {
    const b = el('button', 'navlink');
    b.type = 'button';
    b.append(icon(s.icon), el('span', null, s.label));
    b.addEventListener('click', () => go(s.id));
    navLinks.set(s.id, b);
    nav.append(b);
  }

  const sideFoot = el('div', 'side__foot');

  // The build you are running, always visible, with a live update indicator.
  // Previously you had to open Updates to learn either.
  const build = el('button', 'buildchip');
  build.type = 'button';
  build.title = 'Updates';
  const buildIcon = el('span', 'buildchip__icon');
  const buildText = el('span', 'buildchip__text');
  const buildLabel = el('span', 'buildchip__label', 'Checking…');
  const buildSha = el('span', 'buildchip__sha', '');
  buildText.append(buildLabel, buildSha);
  build.append(buildIcon, buildText);
  build.addEventListener('click', () => go('updates'));

  const status = el('div', 'side__status');
  const statusText = el('span', null, 'Connecting');
  status.append(el('i'), statusText);
  sideFoot.append(build, status);

  side.append(brand, nav, sideFoot);

  const main = el('main', 'main');
  const head = el('div', 'main__head');
  const title = el('h1', 'main__title');
  const sub = el('span', 'main__sub');
  head.append(title, sub);
  const bodyEl = el('div', 'main__body');
  main.append(head, bodyEl);

  // Say plainly that nothing here touches the visitor's machine, rather than
  // letting them wonder why a desktop agent is running in a browser tab.
  if (demo) {
    const ribbon = el('div', 'demo');
    ribbon.append(el('span', 'demo__dot'));
    ribbon.append(el('span', null,
      'Preview — the real interface, driven by a stand-in agent. Nothing on your computer is touched.'));
    const cta = el('a', 'demo__cta', 'Get Pico');
    cta.href = '/';
    ribbon.append(cta);
    main.prepend(ribbon);
  }

  root.append(side, main);
  host.append(root);

  // --- sections ------------------------------------------------------------
  const MODE_ORDER = ['auto', 'chat', 'agent'];
  const MODE_LABEL = { auto: 'Auto', chat: 'Chat', agent: 'Do it' };
  const MODE_HINT = {
    auto: 'Pico decides whether to talk or to work',
    chat: 'Talk only — nothing on your computer is touched',
    agent: 'Always act on the desktop',
  };

  function renderChat(state) {
    const wrap = el('div', 'chat');
    const scroll = el('div', 'chat__scroll');
    const list = el('div', 'chat__list');

    if (!state.messages.length && !state.approval && !state.takeover) {
      list.append(emptyState({
        title: `Talk to ${petName}, or give it a job`,
        sub: state.guardian.canAct === false && state.guardian.reason
          ? state.guardian.reason
          : 'Say hello and it answers. Tell it to open something and it goes '
            + 'and does it — reading the screen, clicking and typing, and '
            + 'stopping to ask before anything it cannot undo.',
      }));
    }

    for (const m of state.messages) {
      if (m.from === 'event') {
        list.append(el('div', 'bubble bubble--event', m.text));
        continue;
      }
      const b = el('div', `bubble bubble--${m.from}`);
      if (!m.text && !m.done) {
        // A reply that has been asked for but has not started arriving.
        const dots = el('span', 'bubble__typing');
        dots.append(el('i'), el('i'), el('i'));
        b.append(dots);
      } else {
        b.textContent = m.text;
      }
      list.append(b);
    }

    // Decisions belong at the end of the thread, where the conversation is,
    // rather than pinned above everything that has been said since.
    if (state.approval) list.append(renderApproval(state.approval));
    else if (state.takeover) list.append(renderTakeover(state.takeover));
    else if (state.error) list.append(renderError(state.error));

    scroll.append(list);

    // --- composer ---
    const composer = el('div', 'composer2');

    const modeBtn = el('button', 'composer2__mode', MODE_LABEL[state.mode]);
    modeBtn.type = 'button';
    modeBtn.dataset.mode = state.mode;
    modeBtn.title = MODE_HINT[state.mode];
    modeBtn.addEventListener('click', () => {
      store.setMode(MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length]);
    });

    const input = el('input');
    input.type = 'text';
    input.placeholder = state.mode === 'chat' ? `Talk to ${petName}…`
      : state.mode === 'agent' ? `Tell ${petName} what to do…`
      : 'Message or task…';
    input.disabled = !state.guardian.ready;

    const send = el('button', 'composer2__send');
    send.type = 'button';
    send.setAttribute('aria-label', 'Send');
    send.append(icon(ICONS.send));
    send.disabled = true;

    const sync = () => { send.disabled = !input.value.trim() || !store.canSubmit; };
    input.addEventListener('input', sync);

    const submit = () => {
      const text = input.value.trim();
      if (!text || send.disabled) return;
      const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      store.addMessage({ id, from: 'you', text, done: true });
      store.addRecent(text);
      bridge.send('submitTask', { text, mode: state.mode, id });
      input.value = '';
      render(store.state);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    send.addEventListener('click', submit);
    composer.append(modeBtn, input, send);

    wrap.append(scroll, composer);
    queueMicrotask(() => {
      scroll.scrollTop = scroll.scrollHeight;
      if (!isActive(state.phase)) input.focus();
      sync();
    });
    return wrap;
  }

  /* The pointer map is built once and updated in place. Rebuilding it per
     frame would mean re-rendering a whole section thirty times a second to
     move one dot. */
  const map = el('div', 'screenmap');
  const mapDot = el('div', 'screenmap__dot');
  const mapTrail = el('div', 'screenmap__trail');
  const mapCoords = el('div', 'screenmap__coords', '—');
  map.append(mapTrail, mapDot, mapCoords);

  function paintCursor(state) {
    const screen = state.guardian.screen;
    if (!screen) return;
    map.style.setProperty('--ratio', String(screen.height / screen.width));
    const { x, y, visible } = state.cursor;
    map.dataset.live = String(visible);
    mapDot.style.left = `${(x / screen.width) * 100}%`;
    mapDot.style.top = `${(y / screen.height) * 100}%`;
    mapTrail.style.left = mapDot.style.left;
    mapTrail.style.top = mapDot.style.top;
    mapCoords.textContent = visible ? `${Math.round(x)}, ${Math.round(y)}` : '—';
  }

  function renderDesktop(state) {
    const wrap = el('div', 'measure');

    // --- the notch ---
    const notch = el('div', 'panel');
    notch.append(el('div', 'panel__title', 'The notch'));
    notch.append(el('p', 'panel__sub',
      'A strip that sits at the top of your screen while you work. Type into '
      + 'it without coming back to this window, and it grows to show what '
      + `${petName} is doing, then settles back.`));

    const notchRow = el('div', 'row');
    const notchMain = el('div', 'row__main');
    notchMain.append(el('div', 'row__title', state.notchOpen ? 'Showing' : 'Not showing'));
    notchMain.append(el('div', 'row__sub', state.notchOpen
      ? 'Docked to the top centre of your main display.'
      : 'Opens in its own small window at the top of the screen.'));
    const notchBtn = el('button', state.notchOpen ? 'btn' : 'btn btn--primary',
      state.notchOpen ? 'Hide it' : 'Show the notch');
    notchBtn.type = 'button';
    notchBtn.disabled = demo;
    notchBtn.addEventListener('click', () => {
      bridge.send(state.notchOpen ? 'closeNotch' : 'openNotch');
    });
    notchRow.append(notchMain, notchBtn);
    notch.append(notchRow);
    if (demo) {
      notch.append(el('p', 'panel__sub',
        'The notch is a window on your own desktop, so it only exists in the '
        + 'installed app.'));
    }
    wrap.append(notch);

    // --- the pointer ---
    const ptr = el('div', 'panel');
    ptr.append(el('div', 'panel__title', 'Where the pointer is'));

    if (state.guardian.screen) {
      ptr.append(el('p', 'panel__sub',
        `Your screen, live. The dot is ${petName}'s pointer — the real one, `
        + 'drawn here as it moves so you can follow it without watching the '
        + 'whole desktop.'));
      ptr.append(map);
      paintCursor(state);
    } else {
      ptr.append(el('p', 'panel__sub', state.guardian.reason
        || 'Pico cannot reach the mouse on this machine, so there is nothing '
           + 'to show here yet.'));
    }

    ptr.append(el('p', 'panel__sub',
      'Windows has exactly one mouse pointer and this is it, which is why '
      + 'there is one dot and not several. It glides to each target rather '
      + 'than jumping, so you can see where it is going and take the mouse '
      + 'back the moment you want it.'));
    wrap.append(ptr);

    return wrap;
  }

  function renderSettings() {
    const wrap = el('div', 'measure');

    // --- permissions ---
    const perm = el('div', 'panel');
    perm.append(el('div', 'panel__title', 'Permissions'));
    perm.append(el('p', 'panel__sub', 'How much Pico may do without asking you first.'));
    for (const lv of Object.values(LEVELS)) {
      const row = el('div', 'row');
      const m = el('div', 'row__main');
      m.append(el('div', 'row__title', lv.label));
      m.append(el('div', 'row__sub', lv.hint));
      const b = el('button', permissions.level === lv.id ? 'btn btn--primary' : 'btn',
        permissions.level === lv.id ? 'On' : 'Use');
      b.type = 'button';
      b.addEventListener('click', () => { permissions.set(lv.id); render(store.state); });
      row.append(m, b);
      perm.append(row);
    }
    perm.append(el('p', 'panel__sub',
      'Credentials, CAPTCHAs and Windows security prompts always come to you. ' +
      'Accept all lasts for this session only.'));
    wrap.append(perm);

    // --- name ---
    const name = el('div', 'panel');
    name.append(el('div', 'panel__title', 'Name'));
    const nameRow = el('div', 'row');
    const nameMain = el('div', 'row__main');
    const nameInput = el('input', 'input');
    nameInput.type = 'text';
    nameInput.value = petName;
    nameInput.maxLength = 24;
    nameMain.append(nameInput);
    const saveName = el('button', 'btn', 'Save');
    saveName.type = 'button';
    saveName.addEventListener('click', () => {
      const v = nameInput.value.trim().slice(0, 24);
      if (!v) return;
      petName = v;
      write(NAME_KEY, v);
      brandName.textContent = v;
      window.dispatchEvent(new CustomEvent('pico:name', { detail: v }));
      render(store.state);
    });
    nameRow.append(nameMain, saveName);
    name.append(nameRow);
    wrap.append(name);

    // --- model ---
    const model = el('div', 'panel');
    model.append(el('div', 'panel__title', 'Model'));
    model.append(el('p', 'panel__sub',
      'Simple tasks use a fast nano model; writing and comparison use a mini one. ' +
      'Pico picks per task.'));

    const mrow = el('div', 'row');
    const mmain = el('div', 'row__main');
    mmain.append(el('div', 'row__title', store.state.settings.model || 'not configured'));
    mmain.append(el('div', 'row__sub', 'Chosen automatically'));
    mrow.append(mmain);
    model.append(mrow);

    // Deliberately read-only. Putting a key field here would mean routing a
    // secret through the browser and over the socket to reach the machine it
    // already needs to live on.
    const krow = el('div', 'row');
    const kmain = el('div', 'row__main');
    kmain.append(el('div', 'row__title', 'API key'));
    kmain.append(el('div', 'row__sub',
      store.state.settings.hasApiKey
        ? 'Configured in .env on this machine'
        : 'Set OPENAI_API_KEY in the .env file next to Start Pico.cmd'));
    krow.append(kmain);
    model.append(krow);
    wrap.append(model);

    return wrap;
  }

  // --- updates -------------------------------------------------------------
  let updateInfo = null;
  let updateBusy = false;
  let updateMsg = '';
  let updateError = null;
  let updateDone = false;
  let updatePct = 0;

  async function checkUpdates(auto = false) {
    updateBusy = true; updateError = null; updateMsg = 'Checking…'; render(store.state);
    try {
      const res = await fetch('/update/check');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      updateInfo = await res.json();
      updateMsg = updateInfo.available ? '' : 'You are on the latest build.';
    } catch (err) {
      updateInfo = null;
      // A quiet background check that fails should not shout; an explicit one
      // should say exactly what went wrong.
      updateError = auto ? null : err.message;
      updateMsg = '';
    } finally {
      updateBusy = false; render(store.state);
    }
  }

  async function installUpdate() {
    updateBusy = true; updatePct = 0; updateMsg = 'Downloading…'; render(store.state);
    try {
      const res = await fetch('/update/install', { method: 'POST' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.stage) updateMsg = { downloading: 'Downloading…', extracting: 'Unpacking…', installing: 'Installing…', done: 'Installed' }[ev.stage] || ev.stage;
          if (typeof ev.pct === 'number') updatePct = ev.pct;
          if (ev.error) throw new Error(ev.error);
          render(store.state);
        }
      }
      updateMsg = 'Installed.';
      updateDone = true;
      updateInfo = null;
    } catch (err) {
      updateError = err.message;
      updateMsg = '';
    } finally {
      updateBusy = false; render(store.state);
    }
  }

  async function restart() {
    updateMsg = 'Restarting…';
    updateBusy = true;
    render(store.state);
    try {
      await fetch('/update/restart', { method: 'POST' });
    } catch {
      /* the server goes away mid-request by design */
    }
    // The socket reconnects on its own; reload once it is back up.
    setTimeout(() => window.location.reload(), 4000);
  }

  function renderUpdates() {
    const wrap = el('div', 'measure');

    // Nothing to update in a browser tab, and no bridge to ask.
    if (demo) {
      wrap.append(emptyState({
        title: 'Updates live in the installed app',
        sub: 'Pico checks for a new build on its own and installs it in place. '
           + 'There is nothing to update in a preview running in your browser.',
        action: { label: 'Get Pico', run: () => { window.location.href = '/'; } },
      }));
      return wrap;
    }

    if (updateDone) {
      const card = el('div', 'update');
      card.dataset.state = 'available';
      const ic = el('div', 'update__icon');
      ic.append(icon(ICONS.update));
      const m = el('div', 'update__main');
      m.append(el('div', 'update__title', 'Update installed'));
      m.append(el('div', 'update__sub', 'Restart to run the new build.'));
      const act = el('div', 'row__action');
      const b = el('button', 'btn btn--primary', updateBusy ? 'Restarting…' : 'Restart now');
      b.type = 'button';
      b.disabled = updateBusy;
      b.addEventListener('click', restart);
      act.append(b);
      card.append(ic, m, act);
      wrap.append(card);
      return wrap;
    }

    // First check of the session: show the shape of the answer, not a spinner.
    if (updateBusy && !updateInfo && updatePct === 0) {
      wrap.append(skeleton(2));
      return wrap;
    }

    if (updateError) {
      wrap.append(notice('Could not check for updates', updateError));
      const retry = el('button', 'btn', 'Try again');
      retry.type = 'button';
      retry.style.marginTop = '12px';
      retry.addEventListener('click', () => checkUpdates());
      wrap.append(retry);
      return wrap;
    }

    const card = el('div', 'update');
    card.dataset.state = updateInfo?.available ? 'available' : 'current';

    const ic = el('div', 'update__icon');
    ic.append(icon(ICONS.update));

    const m = el('div', 'update__main');
    if (updateInfo?.available) {
      m.append(el('div', 'update__title', 'A new build is ready'));
      m.append(el('div', 'update__sub',
        `${updateInfo.latest.sha} · ${(updateInfo.size / 1048576).toFixed(1)} MB`));
    } else {
      m.append(el('div', 'update__title', updateBusy ? 'Working…' : 'Pico is up to date'));
      m.append(el('div', 'update__sub', updateMsg || `Build ${updateInfo?.current?.sha ?? '—'}`));
    }

    if (updateBusy && updatePct > 0) {
      const bar = el('div', 'progress');
      const fill = el('i');
      fill.style.width = `${updatePct}%`;
      bar.append(fill);
      m.append(bar);
    }

    const act = el('div', 'row__action');
    if (updateInfo?.available) {
      const b = el('button', 'btn btn--primary', updateBusy ? 'Installing…' : 'Install update');
      b.type = 'button';
      b.disabled = updateBusy;
      b.addEventListener('click', installUpdate);
      act.append(b);
    } else {
      const b = el('button', 'btn', updateBusy ? 'Checking…' : 'Check again');
      b.type = 'button';
      b.disabled = updateBusy;
      b.addEventListener('click', () => checkUpdates());
      act.append(b);
    }

    card.append(ic, m, act);
    wrap.append(card);

    if (updateMsg && updateInfo?.available) {
      wrap.append(el('p', 'panel__sub', updateMsg));
    }

    if (updateInfo?.available && updateInfo.notes) {
      const notes = el('div', 'panel');
      notes.append(el('div', 'panel__title', 'What changed'));
      // Release bodies are generated from commit subjects; show the first few
      // rather than the whole wall of text.
      const lines = String(updateInfo.notes)
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter((l) => l && !/^build\s/i.test(l) && !l.startsWith('**') && !l.startsWith('#'))
        .slice(0, 6);
      if (lines.length) {
        const ul = el('div', 'notes');
        for (const l of lines) ul.append(el('div', 'notes__line', l));
        notes.append(ul);
        wrap.append(notes);
      }
    }

    const info = el('div', 'panel');
    info.append(el('div', 'panel__title', 'How updates work'));
    info.append(el('p', 'panel__sub',
      'Every change pushed to main publishes a new build, so this always offers ' +
      'the current one. Your .env and the Windows binaries are never overwritten.'));
    const r = el('div', 'row');
    const rm = el('div', 'row__main');
    rm.append(el('div', 'row__title', 'This build'));
    rm.append(el('div', 'row__sub build', updateInfo?.current?.sha ?? 'unknown'));
    r.append(rm);
    info.append(r);
    wrap.append(info);

    return wrap;
  }

  // --- routing -------------------------------------------------------------
  function go(id) {
    section = id;
    if (!demo && id === 'updates' && !updateInfo && !updateBusy) checkUpdates(true);
    render(store.state);
  }

  function renderBuildChip() {
    const dev = updateInfo?.current?.sha === 'dev' || updateInfo?.current?.sha === 'local-dev';
    const state = demo ? 'preview'
      : updateError ? 'error'
      : updateBusy ? 'checking'
      : updateInfo?.available ? 'available'
      : updateInfo ? 'current'
      : 'unknown';

    build.dataset.state = state;
    buildIcon.replaceChildren(icon(
      state === 'available' ? ICONS.cloudDown
        : state === 'current' ? ICONS.cloudCheck
        : ICONS.cloud,
    ));
    buildLabel.textContent = {
      available: 'Update ready',
      current: dev ? 'Development build' : 'Up to date',
      checking: 'Checking…',
      error: 'Check failed',
      preview: 'Preview',
      unknown: 'Build',
    }[state];
    buildSha.textContent = updateInfo?.current?.sha ?? '';
    build.title = state === 'available'
      ? `Install ${updateInfo.latest.sha}`
      : 'Updates';
  }

  function render(state) {
    root.dataset.phase = state.phase;
    mascot.setPhase(state.phase);
    brandName.textContent = petName;

    const s = SECTIONS.find((x) => x.id === section) || SECTIONS[0];
    title.textContent = s.title;
    sub.textContent = isActive(state.phase)
      ? (PHASE_COPY[state.phase]?.title ?? s.sub)
      : s.sub;

    for (const [id, b] of navLinks) {
      if (id === section) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      const badge = b.querySelector('.navlink__badge');
      if (badge) badge.remove();
      if (id === 'updates' && updateInfo?.available) {
        b.append(el('span', 'navlink__badge', '1'));
      }
      if (id === 'chat' && (state.approval || state.takeover) && section !== 'chat') {
        b.append(el('span', 'navlink__badge', '!'));
      }
    }

    renderBuildChip();

    bodyEl.replaceChildren(
      section === 'activity' ? (state.timeline.length
        ? renderTimeline(state)
        : emptyState({
            title: 'Nothing has run yet',
            sub: 'Every step Pico takes shows up here as it happens — what it looked at, what it clicked, and what it decided to ask you about.',
            action: { label: 'Start a task', run: () => go('chat') },
          }))
        : section === 'desktop' ? renderDesktop(state)
        : section === 'updates' ? renderUpdates()
        : section === 'settings' ? renderSettings()
        : renderChat(state),
    );
  }

  store.subscribe((state, meta) => {
    // Thirty positions a second must not re-render the window. Move the dot
    // and stop — everything else about the page is unchanged.
    if (meta.type === 'cursor') {
      if (section === 'desktop') paintCursor(state);
      return;
    }
    if ((meta.type === 'approval' || meta.type === 'takeover') && section !== 'chat') section = 'chat';
    render(state);
  });

  /* Checking once at launch meant a build published while the window was open
     was never noticed. Poll on a slow interval, and again whenever the window
     regains focus — that covers the common case of pushing a change and coming
     back to it. Unauthenticated GitHub allows 60 requests an hour per address;
     this uses four. */
  const UPDATE_POLL_MS = 15 * 60 * 1000;

  // The hosted preview has no bridge, so /update/check is not there to answer.
  // Polling it would just be a 404 every fifteen minutes.
  if (!demo) {
    setTimeout(() => checkUpdates(true), 1500);
    setInterval(() => {
      if (!updateBusy) checkUpdates(true);
    }, UPDATE_POLL_MS);

    let lastFocusCheck = Date.now();
    window.addEventListener('focus', () => {
      // Don't re-check on every alt-tab; once a minute at most.
      if (updateBusy || Date.now() - lastFocusCheck < 60_000) return;
      lastFocusCheck = Date.now();
      checkUpdates(true);
    });
  }

  return {
    root, mascot, go,
    setConn(s) {
      root.dataset.conn = s;
      statusText.textContent =
        ({ connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Local only' })[s] || s;
    },
    get name() { return petName; },
  };
}
