/* ==========================================================================
   Pico phone companion

   Pairs with the laptop over the LAN and drives the same agent the desktop
   UI does, through the identical bridge contract.

   The phone is the user, so it may approve actions — but it can never skip
   one. Every approval and takeover still has to be answered.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from '../pico-ui/src/store.js';
import { bridge, WebSocketTransport } from '../pico-ui/src/bridge.js';
import { Mascot } from '../pico-ui/src/mascot.js';
import { renderApproval, renderTakeover, renderError } from '../pico-ui/src/cards.js';

const TOKEN_KEY = 'pico.pair.token.v1';
const HOST_KEY = 'pico.pair.host.v1';

const $ = (sel) => document.querySelector(sel);

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const drop = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

/* --------------------------------------------------------------------------
   Pairing code can arrive three ways: the QR's #p= hash, a saved token, or
   the user typing it.
   -------------------------------------------------------------------------- */
function codeFromHash() {
  const m = /[#&]p=([A-Z0-9]+)/i.exec(location.hash);
  if (!m) return null;
  // Don't leave the code sitting in the URL bar / history.
  history.replaceState(null, '', location.pathname + location.search);
  return m[1].toUpperCase();
}

const wsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
};

let pendingCode = codeFromHash();
let transport = null;

/* --------------------------------------------------------------------------
   Views
   -------------------------------------------------------------------------- */
const app = $('#app');
const pairView = $('#pair');
const mainView = $('#main');

const els = {
  led: $('.bar__led'),
  connText: $('#conn-text'),
  name: $('#host-name'),
  unpair: $('#unpair'),

  title: $('#stage-title'),
  detail: $('#stage-detail'),
  turn: $('#stage-turn'),
  stageMount: $('#stage-pet'),

  input: $('#task-input'),
  send: $('#task-send'),
  note: $('#composer-note'),
  recents: $('#recents'),

  controls: $('#controls'),
  pause: $('#btn-pause'),
  stop: $('#btn-stop'),

  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),

  pairMount: $('#pair-pet'),
  pairInput: $('#pair-input'),
  pairBtn: $('#pair-btn'),
  pairError: $('#pair-error'),

  install: $('#install'),
  installBtn: $('#install-btn'),
};

/* Pico is drawn, not loaded: the rig builds the character from geometry, so
   there is no artwork to fetch and it stays crisp on a phone screen at any
   density. It was a PNG here until the rig replaced it. */
const stagePet = new Mascot({ size: 178 });
els.stageMount.append(stagePet.el);

const pairPet = new Mascot({ size: 132 });
els.pairMount.append(pairPet.el);

// A tap is a hover on a touchscreen, and a hop is a fine thing to get for one.
for (const pet of [stagePet, pairPet]) {
  pet.el.addEventListener('pointerdown', () => pet.jump());
}

function showPairing(show) {
  pairView.hidden = !show;
  mainView.hidden = show;
  if (show) setTimeout(() => els.pairInput.focus({ preventScroll: true }), 350);
}

/* --------------------------------------------------------------------------
   Connection
   -------------------------------------------------------------------------- */
const CONN_TEXT = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  unpaired: 'Not paired',
};

function setConn(status) {
  app.dataset.conn = status;
  els.connText.textContent = CONN_TEXT[status] || status;
  updateComposer();
}

function connect() {
  transport = new WebSocketTransport(wsUrl(), {
    token: () => read(TOKEN_KEY),
    code: () => pendingCode,
    onStatus: setConn,
    onPaired: (token, name) => {
      write(TOKEN_KEY, token);
      write(HOST_KEY, name || 'this laptop');
      pendingCode = null;
      els.name.textContent = read(HOST_KEY);
      els.pairError.textContent = '';
      showPairing(false);
    },
    onPairError: (reason) => {
      // A saved token that the laptop no longer recognises: forget it and
      // fall back to asking for the code.
      drop(TOKEN_KEY);
      els.pairError.textContent = reason;
      els.pairInput.value = '';
      showPairing(true);
    },
  });

  bridge.attach(transport);
  transport.connect();
}

function unpair() {
  drop(TOKEN_KEY);
  drop(HOST_KEY);
  pendingCode = null;
  transport?.disconnect();
  store.reset();
  showPairing(true);
  setConn('unpaired');
  connect();
}

/* --------------------------------------------------------------------------
   Composer
   -------------------------------------------------------------------------- */
function updateComposer() {
  const s = store.state;
  const connected = app.dataset.conn === 'connected';
  const busy = isActive(s.phase);
  const hasText = els.input.value.trim().length > 0;

  els.send.disabled = !connected || busy || !hasText || !s.guardian.ready;

  let note = '';
  if (!connected) note = 'Waiting for your laptop…';
  else if (!s.guardian.ready) note = 'Safety guardian offline on the laptop.';
  else if (busy) note = 'Pico is already working on a task.';
  els.note.textContent = note;
  els.note.hidden = !note;
}

function submit() {
  const text = els.input.value.trim();
  if (!text || els.send.disabled) return;
  store.addRecent(text);
  bridge.send('submitTask', { text });
  els.input.value = '';
  els.input.style.height = 'auto';
  els.input.blur();
  updateComposer();
  if (navigator.vibrate) navigator.vibrate(8);
}

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`;
  updateComposer();
});

els.input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter (and the on-screen return key) makes a newline
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});

els.send.addEventListener('click', submit);
els.pause.addEventListener('click', () => {
  bridge.send(store.state.phase === 'Paused' ? 'resume' : 'pause');
});
els.stop.addEventListener('click', () => bridge.send('stop'));
els.unpair.addEventListener('click', unpair);

els.pairInput.addEventListener('input', () => {
  els.pairInput.value = els.pairInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  els.pairBtn.disabled = els.pairInput.value.length < 4;
});

els.pairInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.pairBtn.click(); }
});

els.pairBtn.addEventListener('click', () => {
  pendingCode = els.pairInput.value.trim();
  if (!pendingCode) return;
  els.pairError.textContent = '';
  els.pairBtn.disabled = true;
  drop(TOKEN_KEY);
  transport?.disconnect();
  connect();
  setTimeout(() => { els.pairBtn.disabled = false; }, 1200);
});

function renderRecents() {
  const list = store.state.recents.slice(0, 6);
  els.recents.hidden = list.length === 0 || isActive(store.state.phase);
  els.recents.replaceChildren(...list.map((text) => {
    const b = document.createElement('button');
    b.className = 'recents__chip';
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => {
      els.input.value = text;
      els.input.dispatchEvent(new Event('input'));
      els.input.focus();
    });
    return b;
  }));
}

/* --------------------------------------------------------------------------
   Render
   -------------------------------------------------------------------------- */
store.subscribe((state, meta) => {
  const { phase, action } = state;

  app.dataset.phase = phase;
  stagePet.setPhase(phase);
  pairPet.setPhase(phase === 'Idle' ? 'Idle' : phase);

  const copy = PHASE_COPY[phase] || PHASE_COPY.Idle;
  els.title.textContent = copy.title;
  els.detail.textContent = (phase === 'Acting' && action?.detail) ? action.detail
    : (phase === 'Completed' && state.summary) ? state.summary
    : copy.detail;

  els.turn.textContent = state.turn ? `${state.turn} of ${state.settings.maximumComputerTurns} turns` : '';
  els.turn.hidden = !state.turn;

  const busy = isActive(phase);
  els.controls.hidden = !busy;
  els.pause.textContent = phase === 'Paused' ? 'Resume' : 'Pause';

  // --- decision sheet ---
  let card = null;
  if (state.approval) card = renderApproval(state.approval);
  else if (state.takeover) card = renderTakeover(state.takeover);
  else if (state.error) card = renderError(state.error);

  if (card) {
    if (els.sheet.hidden) {
      els.sheetBody.replaceChildren(card);
      els.sheet.hidden = false;
      // A decision needs attention even if the phone is in a pocket.
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    }
  } else {
    els.sheet.hidden = true;
    els.sheetBody.replaceChildren();
  }

  if (meta.type === 'action') stagePet.pulse();
  renderRecents();
  updateComposer();
});

/* --------------------------------------------------------------------------
   Install prompt (Android/Chrome). iOS uses Share > Add to Home Screen.
   -------------------------------------------------------------------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.install.hidden = false;
});

els.installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.install.hidden = true;
});

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
els.name.textContent = read(HOST_KEY) || 'Pico';
showPairing(!(read(TOKEN_KEY) || pendingCode));
setConn('connecting');
connect();

/* Service workers require a secure context. Over the LAN this page is served
   from http://<private-ip>:4177, which is *not* one — so registration is
   skipped rather than failing noisily in the console.

   Consequences, which the phone page documents honestly:
     iPhone  — Add to Home Screen works anyway; iOS does not require a service
               worker, so you get a real standalone app.
     Android — you get a home-screen shortcut, but Chrome only offers a true
               install over trusted HTTPS. Serving the bridge through something
               like Tailscale (which issues a real certificate) enables it.
   Everything else works identically either way; only offline caching is lost,
   and the app is useless without the laptop anyway. */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
}
