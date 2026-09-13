/* ==========================================================================
   Pico — the island

   The notch as its own window: a black rounded rectangle hanging from the
   top edge of the screen, the way the MacBook notch and the iPhone's Dynamic
   Island work. It has three sizes and moves between them on its own:

     compact  the pet on the left, a status glyph on the right, nothing else
     live     wider — what Pico is doing right now, or the reply it just wrote
     open     tall — the conversation, any decision, and a box to type in

   HOW THE SIZE CHANGES
   The window is the island, so growing means resizing the window. This page
   lays its content out at the size it is about to be and reports that size;
   the bridge springs the window open around it. Content is already in place
   while the frame catches up, which reads as a reveal rather than a reflow.

   WHY THE DOM IS NEVER REBUILT
   A streamed reply updates this page dozens of times a second. Rebuilding the
   markup on each one restarts every entrance animation and the whole island
   flickers. Nodes are built once and their text and attributes are updated;
   the thread only appends when a new message arrives.
   ========================================================================== */

import { store, PHASE_COPY, isActive } from './store.js';
import { bridge } from './bridge.js';
import { Mascot } from './mascot.js';
import { permissions, LEVELS } from './permissions.js';

const NAME_KEY = 'pico.pet.name.v1';

/**
 * Content width for each size. Height is whatever the content needs.
 *
 * peek is what hovering gets you: clearly bigger than resting, so the island
 * visibly reacts to the pointer before you have committed to anything.
 */
export const WIDTHS = { compact: 232, peek: 392, live: 440, open: 600 };

const SHORT = {
  Idle: 'Ready',
  Starting: 'Starting',
  Observing: 'Looking',
  Thinking: 'Thinking',
  Acting: 'Working',
  Paused: 'Paused',
  AwaitingApproval: 'Needs you',
  AwaitingTakeover: 'Your turn',
  Completed: 'Done',
  Stopped: 'Stopped',
  Failed: 'Could not finish',
};

const MODE_ORDER = ['auto', 'chat', 'agent'];
const MODE_LABEL = { auto: 'Auto', chat: 'Chat', agent: 'Do it' };
const MODE_HINT = {
  auto: 'Pico decides whether to talk or to work',
  chat: 'Talk only — nothing on your computer is touched',
  agent: 'Always act on the desktop',
};

const SUGGESTIONS = ['What can you do?', 'Open Notepad', 'Search the web for today\'s news'];

/* Lucide-style paths, 24 unit grid, drawn with a 2px round stroke. */
const ICON = {
  send: 'M12 19V5 M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18 M6 6l12 12',
  chevron: 'm18 15-6-6-6 6',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4',
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01',
  ask: 'M12 17h.01 M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
  hand: 'M18 11V6a2 2 0 0 0-4 0 M14 10V4a2 2 0 0 0-4 0v2 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function icon(name, { fill = false } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICON[name]);
  p.setAttribute('fill', fill ? 'currentColor' : 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}

function iconButton(name, label, cls = 'island__btn') {
  const b = el('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name, { fill: name === 'stop' }));
  return b;
}

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {(size:{width:number,height:number,view:string})=>void} opts.onMeasure
 */
export function mountIsland(host = document.body, { onMeasure } = {}) {
  let petName = (() => { try { return localStorage.getItem(NAME_KEY) || 'Pico'; } catch { return 'Pico'; } })();

  let pinned = false;        // opened by the user, stays open until dismissed
  let hover = false;
  let hoverTimer = null;
  let flash = null;          // { kind, text, until } — a transient live notice
  let flashTimer = null;
  let view = 'compact';
  let renderedCount = 0;     // messages already in the thread DOM
  const autoApproved = new Set();

  // --- skeleton ------------------------------------------------------------
  const root = el('div', 'island');
  root.dataset.view = view;
  root.dataset.phase = 'Idle';

  const bar = el('div', 'island__bar');

  const lead = el('div', 'island__lead');
  const mascot = new Mascot({ size: 26 });
  lead.append(mascot.el);

  const text = el('div', 'island__text');
  const title = el('div', 'island__title');
  const sub = el('div', 'island__sub');
  text.append(title, sub);

  const trail = el('div', 'island__trail');

  const glyph = el('div', 'island__glyph');
  const dot = el('span', 'island__dot');
  const bars = el('span', 'island__bars');
  for (let i = 0; i < 4; i++) bars.append(el('i'));
  const tick = el('span', 'island__tick');
  tick.append(icon('check'));
  const cross = el('span', 'island__cross');
  cross.append(icon('x'));
  glyph.append(dot, bars, tick, cross);

  const stopBtn = iconButton('stop', 'Stop — Esc', 'island__btn island__btn--stop');
  const permBtn = el('button', 'island__perm');
  permBtn.type = 'button';
  permBtn.append(icon('shield'), el('span', 'island__perm-label'));
  const collapseBtn = iconButton('chevron', 'Collapse');

  trail.append(glyph, stopBtn, permBtn, collapseBtn);
  bar.append(lead, text, trail);

  // --- panel ---------------------------------------------------------------
  const panel = el('div', 'island__panel');

  const thread = el('div', 'island__thread');
  const empty = el('div', 'island__empty');
  const emptyLine = el('div', 'island__empty-line');
  const chips = el('div', 'island__chips');
  for (const s of SUGGESTIONS) {
    const c = el('button', 'island__chip', s);
    c.type = 'button';
    c.addEventListener('click', () => submit(s));
    chips.append(c);
  }
  empty.append(emptyLine, chips);

  const decision = el('div', 'island__decision');
  decision.hidden = true;      // nothing to decide until one arrives

  const composer = el('div', 'island__composer');
  const modeBtn = el('button', 'island__mode');
  modeBtn.type = 'button';
  const input = el('input', 'island__input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Message or task');
  const sendBtn = iconButton('send', 'Send', 'island__send');
  composer.append(modeBtn, input, sendBtn);

  panel.append(empty, thread, decision, composer);
  root.append(bar, panel);
  host.append(root);

  // --- behaviour -----------------------------------------------------------
  function showFlash(kind, value, ms = 3800) {
    flash = { kind, text: value };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; update(); }, ms);
  }

  function decide(s) {
    if (s.question) return 'open';
    if (s.approval && !autoApproved.has(s.approval.id)) return 'open';
    if (s.takeover) return 'open';
    if (pinned) return 'open';
    if (isActive(s.phase) || flash) return 'live';
    const last = s.messages[s.messages.length - 1];
    if (last && last.from === 'pico' && !last.done) return 'live';   // reply still streaming
    if (hover) return 'peek';
    return 'compact';
  }

  function open() {
    pinned = true;
    update();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function collapse() {
    pinned = false;
    input.blur();
    update();
  }

  function submit(value) {
    const t = String(value ?? input.value).trim();
    if (!t) return;
    const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    if (!store.canSubmit) return;
    store.addMessage({ id, from: 'you', text: t, done: true });
    store.addRecent(t);
    bridge.send('submitTask', { text: t, mode: store.state.mode, id });
    input.value = '';
    syncSend();
  }

  const canSend = () => store.canSubmit;

  function syncSend() {
    sendBtn.disabled = !input.value.trim() || !canSend();
  }

  bar.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (view === 'open') collapse(); else open();
  });

  collapseBtn.addEventListener('click', collapse);
  stopBtn.addEventListener('click', () => bridge.send('stop'));

  permBtn.addEventListener('click', () => {
    const order = ['ask', 'smart', 'all'];
    permissions.set(order[(order.indexOf(permissions.level) + 1) % order.length]);
    update();
  });

  modeBtn.addEventListener('click', () => {
    store.setMode(MODE_ORDER[(MODE_ORDER.indexOf(store.state.mode) + 1) % MODE_ORDER.length]);
    input.focus();
  });

  input.addEventListener('input', syncSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  sendBtn.addEventListener('click', () => submit());

  // Esc keeps its meaning everywhere in Pico: during a run it is the stop
  // button, otherwise it puts the island away.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isActive(store.state.phase)) bridge.send('stop');
    else collapse();
  });

  /* --- hovering ------------------------------------------------------------
     Reacting to the pointer is the island's one unprompted gesture, so it has
     to happen every single time the pointer arrives — and stop the moment it
     leaves.

     The page is a poor judge of this, which took a while to accept. A browser
     announces a pointer leaving whenever the window resizes under it, and the
     island resizes precisely because it was hovered: expand, leave, collapse,
     enter, expand — the island flickering between two sizes under a pointer
     that had not moved. Its own hit-testing is no better. Put the pointer
     somewhere rather than moving it there and :hover can still say the island
     is not underneath it, so the safety net had a hole in the same place.

     None of that is in doubt outside the browser. There is a window, at a
     rectangle the bridge chose, and a pointer, at a position Windows will
     state plainly. So the bridge watches both and says which it is, and from
     its first word the page stops guessing entirely — `told` is that switch.

     What follows is only for when there is no bridge to ask: the island open
     in an ordinary tab, or the mock. Then the page falls back on its own
     events, with :hover to check the ones it does not believe. */
  const page = document.documentElement;

  let told = false;          // the bridge has spoken; the page defers to it
  let hoverPoll = null;

  const under = () => {
    try { return page.matches(':hover'); } catch { return hover; }
  };

  function setHover(on) {
    if (on === hover) return;
    hover = on;
    update();
  }

  function enter() {
    if (told) return;
    clearTimeout(hoverTimer);
    setHover(true);
    // While it believes it is hovered, keep asking. This is the safety net
    // for the opposite mistake: a leave that is never announced at all, which
    // would leave the island expanded over an empty desk.
    if (!hoverPoll) hoverPoll = setInterval(verify, 200);
  }

  function verify() {
    if (told || under()) return;
    clearInterval(hoverPoll);
    hoverPoll = null;
    setHover(false);
  }

  function leave(e) {
    if (told) return;
    clearTimeout(hoverTimer);
    // A leave whose coordinates are outside the window is not in doubt: the
    // pointer really has gone, and waiting to confirm it only makes the
    // island slow to tuck away.
    const gone = e && (e.clientX < 0 || e.clientY < 0
      || e.clientX > window.innerWidth || e.clientY > window.innerHeight);
    hoverTimer = setTimeout(verify, gone ? 0 : 140);
  }

  page.addEventListener('pointerenter', enter);
  page.addEventListener('pointerover', enter);
  page.addEventListener('pointermove', enter);
  page.addEventListener('pointerleave', leave);
  // relatedTarget is null only when the pointer has moved somewhere this page
  // cannot see — which is to say, off the island altogether.
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) leave(e); });

  // Clicking anywhere else on the desktop tucks it away, as the real one does
  // — unless it is holding a decision that still needs an answer.
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.hasFocus()) return;
      const s = store.state;
      if (s.approval || s.takeover) return;
      if (pinned) { pinned = false; update(); }
    }, 180);
  });

  // --- thread --------------------------------------------------------------
  function messageNode(m) {
    const n = el('div', `island__msg island__msg--${m.from}`);
    n.dataset.id = m.id;
    paintMessage(n, m);
    return n;
  }

  function paintMessage(n, m) {
    if (!m.text && !m.done) {
      if (!n.querySelector('.island__typing')) {
        const t = el('span', 'island__typing');
        t.append(el('i'), el('i'), el('i'));
        n.replaceChildren(t);
      }
      return;
    }
    if (n.textContent !== m.text) n.textContent = m.text;
  }

  function syncThread(s) {
    const list = s.messages;
    if (list.length < renderedCount) {        // cleared
      thread.replaceChildren();
      renderedCount = 0;
    }
    for (let i = renderedCount; i < list.length; i++) thread.append(messageNode(list[i]));
    renderedCount = list.length;

    // Streaming updates change the text of messages already on screen.
    const tail = list.slice(-3);
    for (const m of tail) {
      const n = thread.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      if (n) paintMessage(n, m);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  // --- decisions -----------------------------------------------------------
  /* Anything Pico cannot get on with until the person says something.
     A question before it starts, an approval mid-run, a handover.

     A question used to be answered in the same box a task is typed into,
     which meant the one moment Pico is actually waiting on you looked exactly
     like the moment it is waiting for you to think of something to do. Now it
     has a card of its own, with its own field, under a dot that will not stop
     blinking until it is dealt with. */
  let decisionKey = null;

  const ATTENTION = {
    question: 'Needs your answer',
    approval: 'Needs your approval',
    takeover: 'Needs you to take over',
  };

  function syncDecision(s) {
    const q = s.question;
    const a = s.approval && !autoApproved.has(s.approval.id) ? s.approval : null;
    const t = s.takeover;
    const key = q ? `q:${q.id}` : a ? `a:${a.id}` : t ? `t:${t.id}` : null;
    if (key === decisionKey) return;
    decisionKey = key;
    decision.replaceChildren();
    decision.hidden = !key;
    if (!key) return;

    const kind = q ? 'question' : a ? 'approval' : 'takeover';
    decision.dataset.kind = kind;

    const flag = el('div', 'island__attention');
    flag.append(el('i', 'island__attention-dot'), el('span', null, ATTENTION[kind]));

    const badge = el('div', 'island__decision-icon');
    badge.append(icon(q ? 'ask' : a ? 'alert' : 'hand'));

    const body = el('div', 'island__decision-body');
    body.append(el('div', 'island__decision-title',
      q ? q.text : a ? a.summary : 'Your turn'));
    if (!q) {
      body.append(el('div', 'island__decision-reason',
        a ? (a.risk?.reason || 'This step needs your approval.') : t.reason));
    }

    const actions = el('div', 'island__decision-actions');

    if (q) {
      // Its own field. Answering is not the same act as starting a job, and
      // giving them the same box made a waiting Pico invisible.
      const row = el('div', 'island__answer');
      const field = el('input', 'island__answer-input');
      field.type = 'text';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.placeholder = 'Type your answer…';
      field.setAttribute('aria-label', q.text);
      const go = iconButton('send', 'Answer', 'island__send');
      go.disabled = true;

      const answer = () => {
        const value = field.value.trim();
        if (!value) return;
        // The bridge writes both halves into the thread once it has the
        // answer; adding one here as well would show it twice.
        bridge.send('answerQuestion', { id: q.id, text: value });
        store.setQuestion(null);
      };

      field.addEventListener('input', () => { go.disabled = !field.value.trim(); });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answer(); }
      });
      go.addEventListener('click', answer);

      row.append(field, go);
      actions.append(row);
      requestAnimationFrame(() => field.focus({ preventScroll: true }));
    } else if (a) {
      const deny = el('button', 'island__pill', 'Stop');
      const allow = el('button', 'island__pill island__pill--primary', 'Allow once');
      deny.type = allow.type = 'button';
      deny.addEventListener('click', () => bridge.send('deny', { id: a.id }));
      allow.addEventListener('click', () => bridge.send('approve', { id: a.id }));
      actions.append(deny, allow);
    } else {
      const done = el('button', 'island__pill island__pill--primary', 'Done — carry on');
      done.type = 'button';
      done.addEventListener('click', () => bridge.send('takeoverDone', { id: t.id }));
      actions.append(done);
    }

    decision.append(flag, badge, body, actions);
  }

  // --- the bar -------------------------------------------------------------
  function syncBar(s) {
    const copy = PHASE_COPY[s.phase] || PHASE_COPY.Idle;
    const running = isActive(s.phase);
    const last = s.messages[s.messages.length - 1];
    const streaming = last && last.from === 'pico' && !last.done;

    let head = petName;
    let line = SHORT[s.phase] || 'Ready';
    let mark = running ? 'bars' : 'dot';

    /* What Pico is doing, said while it is doing it.
       The bar used to show the last action it finished, which is the one
       thing that is definitely no longer happening: it sat on "clicked the
       address bar" through the three seconds of working out what to do next,
       so the island was always one beat behind and often plain wrong. The
       plan step is what it is on now; the action is what it is doing within
       that step, and only while it is actually doing it. */
    const step = s.step;
    const doing = s.phase === 'Acting' && s.action?.detail ? s.action.detail : null;
    const busy = doing || step?.text || copy.title;
    const progress = step && step.total > 1 ? `Step ${step.index + 1} of ${step.total}` : null;

    if (view === 'peek') {
      head = petName;
      line = s.guardian.canAct === false ? 'Chat only' : 'Click to type · Esc to hide';
    } else if (view === 'live') {
      if (running) {
        head = busy;
        line = progress ? `${progress} · ${SHORT[s.phase]}` : SHORT[s.phase];
      } else if (streaming) {
        head = last.text || 'Writing…';
        line = petName;
        mark = 'bars';
      } else if (flash) {
        head = flash.text;
        line = flash.kind === 'done' ? 'Done' : flash.kind === 'fail' ? SHORT.Failed : petName;
        mark = flash.kind === 'done' ? 'tick' : flash.kind === 'fail' ? 'cross' : 'dot';
      } else {
        head = petName;
        line = 'Click to type';
      }
    } else if (view === 'open') {
      line = running
        ? (progress ? `${progress} · ${busy}` : busy)
        : s.guardian.canAct === false ? 'Chat only' : 'Ready';
    }

    if (title.textContent !== head) title.textContent = head;
    if (sub.textContent !== line) sub.textContent = line;
    glyph.dataset.mark = mark;

    stopBtn.hidden = !(running && view !== 'compact');
    permBtn.hidden = view !== 'open';
    collapseBtn.hidden = view !== 'open';

    const lvl = LEVELS[permissions.level];
    permBtn.dataset.level = permissions.level;
    permBtn.title = `Permissions: ${lvl.label} — ${lvl.hint}`;
    permBtn.querySelector('.island__perm-label').textContent = lvl.label;
  }

  function syncComposer(s) {
    modeBtn.textContent = MODE_LABEL[s.mode];
    modeBtn.dataset.mode = s.mode;
    modeBtn.title = MODE_HINT[s.mode];
    input.placeholder = s.mode === 'chat' ? `Talk to ${petName}…`
      : s.mode === 'agent' ? `Tell ${petName} what to do…`
      : `Ask ${petName} anything, or give it a job…`;
    input.disabled = !s.guardian.ready;
    // While Pico is waiting on an answer there is exactly one box to type in,
    // and it is the one on the card. Two would be a puzzle.
    composer.hidden = Boolean(s.question);
    syncSend();

    empty.hidden = s.messages.length > 0 || Boolean(s.approval || s.takeover || s.question);
    emptyLine.textContent = s.guardian.canAct === false && s.guardian.reason
      ? s.guardian.reason
      : `Say hi, or tell ${petName} what to do on your computer.`;
  }

  // --- measuring -----------------------------------------------------------
  /* The window is only as big as the page last said it wanted to be, so a
     measurement that misses means text sits behind the frame with nothing to
     show it is there — the page cannot scroll, it is the island. Hence three
     belts: measure after every update, measure again whenever the natural
     height changes for any reason, and check afterwards that the window
     actually got as big as was asked. */
  let lastMeasured = '';
  let healTimer = null;
  let healAttempts = 0;
  let want = { width: WIDTHS.compact, height: 36 };

  const MAX_HEALS = 3;

  /* --- and if the window will not come ------------------------------------
     Everything above assumes the frame eventually arrives at the size the
     page asked for. When it does not — no window helper on this machine, a
     bridge that has been restarted, a resize refused for any reason at all —
     the island lays itself out at a width the window does not have, and the
     content is simply cut off against the frame. There is no scrollbar to
     hint at it and no way for the user to drag it bigger: the window is the
     island. What they get is half a sentence with its first word sliced off.

     So the page ends up responsible for its own legibility. If the frame has
     not caught up after a moment, the island folds into the room it actually
     has — text at full size, ellipsised where it must be, the conversation
     scrolling — and unfolds again the instant the frame arrives.

     What it must never do is scale itself down. A miniature island floating
     in the middle of a black rectangle is not a smaller island, it is a small
     window, and a window is the one thing this is not. */
  let capped = false;
  let fitTimer = null;

  function fits() {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (!(iw > 0 && ih > 0)) return true;      // nothing to measure against
    return iw >= want.width - 2 && ih >= want.height - 2;
  }

  function setCapped(on) {
    if (on === capped) return;
    capped = on;
    root.classList.toggle('is-capped', on);
  }

  function checkFit() {
    if (fits()) {
      clearTimeout(fitTimer);
      fitTimer = null;
      setCapped(false);
      return;
    }
    // Folded already: stay folded until there is room again.
    if (capped) return;
    // Otherwise give the frame time to arrive. A morph takes about a third of
    // a second, and during it being briefly larger than the window is the
    // reveal, not a fault.
    if (!fitTimer) fitTimer = setTimeout(() => { fitTimer = null; if (!fits()) setCapped(true); }, 500);
  }

  window.addEventListener('resize', checkFit);

  /* How tall the island wants to be, which is not the same as how tall it
     currently is: folded, it is exactly as tall as the window, and asking for
     that would be asking to stay folded forever. Unfold, measure, fold back —
     all inside one frame, so nothing is painted in between. */
  function naturalHeight() {
    if (!capped) return Math.ceil(root.offsetHeight);
    root.classList.remove('is-capped');
    const h = Math.ceil(root.offsetHeight);
    root.classList.add('is-capped');
    return h;
  }

  function postMeasure(force = false) {
    const size = {
      view,
      width: WIDTHS[view],
      height: naturalHeight(),
    };
    want = { width: size.width, height: size.height };
    checkFit();
    const key = `${size.width}x${size.height}`;
    if (!force && key === lastMeasured) return;
    if (!force) healAttempts = 0;      // a genuinely new size starts fresh
    lastMeasured = key;
    onMeasure?.(size);

    // Did the frame actually get there? A morph cancelled by a newer one, or
    // a font that swapped in late, can leave it short — so check, and ask
    // again if so.
    //
    // Strictly bounded, because this is a page asking to be resized and then
    // measuring the result: somewhere that cannot report its own geometry
    // (innerWidth reads 0 in an embedded view) every check looks "too small"
    // and it would retry forever. Only trust real numbers, and only retry a
    // few times.
    clearTimeout(healTimer);
    if (healAttempts >= MAX_HEALS) return;
    healTimer = setTimeout(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (!(w > 0 && h > 0)) return;
      if (h < size.height - 2 || w < size.width - 2) {
        healAttempts += 1;
        postMeasure(true);
      }
    }, 560);
  }

  // A streamed reply rewraps as it arrives, a decision appears, the web font
  // replaces the fallback — all of them change the height without any state
  // change to notice, so watch the box itself.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => postMeasure()).observe(root);
  }
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => postMeasure(true)).catch(() => {});
  }

  // --- the one update ------------------------------------------------------
  function update() {
    const s = store.state;
    const next = decide(s);
    if (next !== view) {
      view = next;
      root.dataset.view = view;
      // Replay the content entrance only on an actual change of size.
      root.classList.remove('is-morphing');
      void root.offsetWidth;
      root.classList.add('is-morphing');
    }
    root.dataset.phase = s.phase;
    mascot.setPhase(s.phase);

    syncBar(s);
    if (view === 'open') {
      syncThread(s);
      syncDecision(s);
      syncComposer(s);
    }

    requestAnimationFrame(() => postMeasure());
  }

  // --- the store -----------------------------------------------------------
  function maybeAutoApprove(s) {
    const a = s.approval;
    if (!a || autoApproved.has(a.id)) return;
    const { auto, why } = permissions.decide(a);
    if (!auto) return;
    autoApproved.add(a.id);
    store.addMessage({ from: 'event', text: `Allowed automatically: ${a.summary} — ${why}` });
    bridge.send('approve', { id: a.id });
  }

  store.subscribe((s, meta) => {
    if (meta.type === 'cursor') return;               // thirty a second, nothing to redraw

    // The bridge, watching the real pointer against the real window. It
    // speaks only when the answer changes, so this is a few messages per
    // visit to the island — and it is right every time, which is more than
    // the page's own enter and leave events manage.
    if (meta.type === 'notchHover') {
      told = true;
      clearTimeout(hoverTimer);
      if (hoverPoll) { clearInterval(hoverPoll); hoverPoll = null; }
      setHover(s.notchHover);
      return;
    }

    if (meta.type === 'approval') maybeAutoApprove(s);
    if (meta.type === 'question' && s.question) pinned = true;
    if (meta.type === 'action') mascot.pulse();

    // Sent as a job: get out of the way of the screen Pico is about to use.
    if (meta.type === 'routed' && s.routed?.mode === 'agent') pinned = false;

    if (meta.type === 'summary' && s.summary) showFlash('done', s.summary, 4200);
    if (meta.type === 'error' && s.error) showFlash('fail', s.error.message, 5200);
    if (meta.type === 'message' && meta.message?.from === 'pico' && meta.message.done && !pinned) {
      showFlash('reply', meta.message.text, 5200);
    }

    update();
  });

  return {
    root,
    open,
    collapse,
    setName(name) { petName = name || 'Pico'; update(); },
    get view() { return view; },
  };
}
