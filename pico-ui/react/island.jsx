/* ==========================================================================
   Halo — the island

   A black shape hanging from the top centre of the screen, the way the
   MacBook notch and the iPhone's Dynamic Island work. It grows out of the
   top edge and settles back into it, and it has four sizes it moves between
   on its own:

     compact  Halo at rest: its face, its name and status, a status light
     peek     the pointer is on it — a nameplate, bigger, and a hint
     live     something is happening: the step in hand and why, with the
              controls for it; or the reply Halo just wrote
     open     the conversation, the plan, any decision, and a box to type in

   HOW THE SIZE CHANGES
   The window is the island, so growing means resizing the window. This page
   lays its content out at the size it is about to be and reports that size;
   the bridge springs the window open around it. Content is already in place
   while the frame catches up, which reads as a reveal rather than a reflow.

   WHEN IT MUST STAY OPEN
   A question, an approval, a handover. Those hold the island open, pulse
   light round their own edge, and turn the compact island's status light
   into a beating one if the person puts it away without answering. Waiting
   on someone and looking idle is the failure this exists to prevent.
   ========================================================================== */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { store, isActive, PHASE_COPY } from '../src/store.js';
import { bridge, connect } from '../src/bridge.js';
import { chats } from '../src/chats.js';
import { permissions, LEVELS } from '../src/permissions.js';
import { TAUGHT, written } from '../src/keybinds.js';
import { useStore, useStoreEvent, sel, usePetName, ago } from './hooks.js';
import { Beam, MetalButton } from './fx.jsx';
import {
  Composer, Decision, Icon, IconButton, PlanSteps, Presence, RunControls, SaveShortcut, Thread, useDecision,
} from './parts.jsx';

/** Content width for each size. Height is whatever the content needs. */
export const WIDTHS = { compact: 232, peek: 380, live: 460, open: 620, card: 396 };

const SHORT = {
  Idle: 'Ready',
  Starting: 'Getting ready',
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

const SUGGESTIONS = ['What can you do?', 'Open Notepad and type hello', 'Remember I use Chrome'];

/* --------------------------------------------------------------------------
   Hovering

   Reacting to the pointer is the island's one unprompted gesture, so it has
   to happen every time the pointer arrives and stop the moment it leaves.
   The page is a poor judge of that — a browser announces a leave whenever
   the window resizes under the pointer, and the island resizes precisely
   because it was hovered. So the bridge watches the real pointer against the
   real window and says which it is (`notchHover`), and once it has spoken
   the page stops guessing. What follows is only for when there is no bridge
   to ask: an ordinary tab, or the preview.
   -------------------------------------------------------------------------- */
function useHover() {
  const [hover, setHover] = useState(false);
  const told = useRef(false);
  const told2 = useStore(sel.notchHover);

  useStoreEvent(['notchHover'], (s) => { told.current = true; setHover(Boolean(s.notchHover)); });

  /* A bridge that has gone away cannot say where the pointer is any more.
     Trusting it anyway left an island that never opened again, however long
     you hovered — so the moment the connection drops, the page goes back to
     judging hover for itself, and hands back to the bridge when it returns
     and speaks. */
  useEffect(() => {
    const onConn = () => {
      if (document.body.dataset.conn !== 'connected') { told.current = false; setHover(false); }
    };
    const watch = new MutationObserver(onConn);
    watch.observe(document.body, { attributes: true, attributeFilter: ['data-conn'] });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const page = document.documentElement;
    let timer = null;
    let poll = null;
    const under = () => { try { return page.matches(':hover'); } catch { return false; } };
    const verify = () => {
      if (told.current || under()) return;
      clearInterval(poll); poll = null;
      setHover(false);
    };
    const enter = () => {
      if (told.current) return;
      clearTimeout(timer);
      setHover(true);
      if (!poll) poll = setInterval(verify, 200);
    };
    const leave = (e) => {
      if (told.current) return;
      clearTimeout(timer);
      const gone = e && (e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight);
      timer = setTimeout(verify, gone ? 0 : 140);
    };
    const out = (e) => { if (!e.relatedTarget) leave(e); };
    page.addEventListener('pointerenter', enter);
    page.addEventListener('pointermove', enter);
    page.addEventListener('pointerleave', leave);
    document.addEventListener('mouseout', out);
    return () => {
      page.removeEventListener('pointerenter', enter);
      page.removeEventListener('pointermove', enter);
      page.removeEventListener('pointerleave', leave);
      document.removeEventListener('mouseout', out);
      clearTimeout(timer); clearInterval(poll);
    };
  }, []);
  void told2;
  return hover;
}

/* --------------------------------------------------------------------------
   Measuring

   The window is only as big as the page last said it wanted to be, so a
   measurement that misses means text sits behind the frame with nothing to
   show it is there. So: measure whenever the content's size changes for any
   reason, and check a moment later that the window really got there.

   And if the window will not come — no window helper, a restarted bridge —
   the island folds into the room it actually has rather than being sliced
   by the frame. It never scales itself down: a miniature island floating in
   a black rectangle is a small window, which is the one thing this is not.
   -------------------------------------------------------------------------- */
function useMeasure(rootRef, view, onMeasure) {
  const [capped, setCapped] = useState(false);
  const last = useRef('');
  const want = useRef({ width: WIDTHS.compact, height: 36 });
  const heal = useRef({ timer: null, tries: 0 });
  const fit = useRef(null);

  const post = useCallback((force = false) => {
    const root = rootRef.current;
    if (!root) return;
    const wasCapped = root.classList.contains('is-capped');
    if (wasCapped) root.classList.remove('is-capped');
    const height = Math.ceil(root.offsetHeight);
    if (wasCapped) root.classList.add('is-capped');
    const size = { view, width: WIDTHS[view], height };
    want.current = size;

    const fits = () => !(innerWidth > 0 && innerHeight > 0) || (innerWidth >= size.width - 2 && innerHeight >= size.height - 2);
    if (fits()) { clearTimeout(fit.current); fit.current = null; setCapped(false); } else if (!fit.current) {
      fit.current = setTimeout(() => { fit.current = null; if (!fits()) setCapped(true); }, 500);
    }

    const key = `${size.width}x${size.height}`;
    if (!force && key === last.current) return;
    if (!force) heal.current.tries = 0;
    last.current = key;
    onMeasure?.(size);

    clearTimeout(heal.current.timer);
    if (heal.current.tries >= 3) return;
    heal.current.timer = setTimeout(() => {
      if (!(innerWidth > 0 && innerHeight > 0)) return;
      if (innerHeight < size.height - 2 || innerWidth < size.width - 2) {
        heal.current.tries += 1;
        post(true);
      }
    }, 560);
  }, [rootRef, view, onMeasure]);

  useLayoutEffect(() => { post(); });
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => post());
    ro.observe(root);
    const onResize = () => post();
    addEventListener('resize', onResize);
    document.fonts?.ready?.then(() => post(true)).catch(() => {});
    return () => { ro.disconnect(); removeEventListener('resize', onResize); };
  }, [post, rootRef]);

  return capped;
}

/* --------------------------------------------------------------------------
   The island
   -------------------------------------------------------------------------- */
function Island({ onMeasure }) {
  const [petName] = usePetName();
  const phase = useStore(sel.phase);
  const plan = useStore(sel.plan);
  const action = useStore(sel.action);
  const messages = useStore(sel.messages);
  const guardian = useStore(sel.guardian);
  const lastRun = useStore(sel.lastRun);
  const routines = useStore(sel.routines);
  const chatState = useStore(sel.chats);
  const hover = useHover();

  const shell = useStore(sel.shell);
  const [pinned, setPinned] = useState(false);
  const [flash, setFlash] = useState(null);          // { kind, text } — a passing notice
  const [keys, setKeys] = useState(false);           // the chords, on arriving from the app
  const [dismissed, setDismissed] = useState(null);  // a question put away unanswered
  const [autoApproved] = useState(() => new Set());
  const [level, setLevel] = useState(permissions.level);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const flashTimer = useRef(null);
  const keysTimer = useRef(null);

  const decision = useDecision(autoApproved);
  const running = isActive(phase);
  const last = messages[messages.length - 1];
  const streaming = Boolean(last && last.from === 'pico' && !last.done);
  const waitingOnPerson = Boolean(decision);

  useEffect(() => permissions.subscribe(setLevel), []);

  const showFlash = useCallback((kind, text, ms) => {
    clearTimeout(flashTimer.current);
    setFlash({ kind, text });
    flashTimer.current = setTimeout(() => setFlash(null), ms);
  }, []);

  /* Arriving from the app window: the chords, for a few seconds, in the
     thing they operate. Opened so there is room to read them, and it puts
     itself away again — nobody asked for a panel. */
  useStoreEvent(['shell'], (s) => {
    if (!s.shell?.keysAt) return;
    setKeys(true);
    setPinned(true);
    clearTimeout(keysTimer.current);
    keysTimer.current = setTimeout(() => { setKeys(false); setPinned(false); }, 9000);
  });

  /* Ctrl+Alt+Space, from anywhere on the desktop: the box, open, focused.
     The bridge counts the presses so a second one is a second open, not a
     no-op on a flag that was already true. */
  useStoreEvent(['focusChat'], () => open());

  /* --- what size to be ----------------------------------------------------
     A card is its own shape and does not peek, grow or shrink with the
     pointer: it is a window you put somewhere, and a window that changed
     size when you moved the mouse across it would be a poltergeist. */
  const card = shell.mode === 'card';
  const view = (() => {
    if (card) return 'card';
    if (decision && !(decision.kind === 'question' && decision.item.id === dismissed)) return 'open';
    if (pinned) return 'open';
    if (running || streaming || flash) return 'live';
    if (hover) return 'peek';
    return 'compact';
  })();

  const capped = useMeasure(rootRef, view, onMeasure);

  /* --- reactions ---------------------------------------------------------- */
  useStoreEvent(['approval'], (s) => {
    const a = s.approval;
    if (!a || autoApproved.has(a.id)) return;
    const { auto, why } = permissions.decide(a);
    if (!auto) return;
    autoApproved.add(a.id);
    store.addMessage({ from: 'event', text: `Allowed automatically: ${a.summary} — ${why}` });
    bridge.send('approve', { id: a.id });
  });
  useStoreEvent(['question'], (s) => { if (s.question) { setDismissed(null); setPinned(true); } });
  // Sent as a job: get out of the way of the screen Halo is about to use.
  useStoreEvent(['routed'], (s) => { if (s.routed?.mode === 'agent') setPinned(false); });
  useStoreEvent(['summary'], (s) => { if (s.summary) showFlash('done', s.summary, 6500); });
  useStoreEvent(['error'], (s) => { if (s.error && !s.error.quiet) showFlash('fail', s.error.message, 6000); });
  useStoreEvent(['message'], (s, meta) => {
    const m = meta.message;
    if (m?.from === 'pico' && m.done && !meta.restored) showFlash('reply', m.text, 6000);
  });

  /* --- gestures ----------------------------------------------------------- */
  const open = useCallback(() => {
    setPinned(true);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, []);
  const collapse = useCallback(() => {
    setPinned(false);
    // Putting the island away is allowed to mean it, even with a question
    // still open: it stays pending, and answering it still works.
    setDismissed(store.state.question?.id ?? null);
    inputRef.current?.blur();
  }, []);

  // Esc keeps its meaning everywhere in Halo: during a run it is the stop
  // button, otherwise it puts the island away.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (isActive(store.state.phase)) bridge.send('stop'); else collapse();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [collapse]);

  // Clicking anywhere else on the desktop tucks it away — unless it is
  // holding a decision that still needs an answer.
  useEffect(() => {
    const onBlur = () => setTimeout(() => {
      if (document.hasFocus()) return;
      const s = store.state;
      if (s.approval || s.takeover) return;
      setPinned(false);
    }, 180);
    addEventListener('blur', onBlur);
    return () => removeEventListener('blur', onBlur);
  }, []);

  const onBarClick = (e) => {
    if (e.target.closest('button, input')) return;
    if (view === 'card') { inputRef.current?.focus({ preventScroll: true }); return; }
    if (view === 'open') collapse(); else open();
  };

  /* --- the words in the bar ----------------------------------------------- */
  const step = plan && !plan.finished ? plan.steps[plan.index] : null;
  const total = plan?.steps?.length ?? 0;
  const doneCount = plan ? plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length : 0;
  const doing = phase === 'Acting' && action?.detail ? action.detail : null;

  let head = petName;
  let line = SHORT[phase] || 'Ready';
  let mark = running ? 'busy' : 'dot';
  if (view === 'peek') {
    line = guardian.canAct === false ? 'Chat only' : 'Click to type · Esc to hide';
  } else if (view === 'live') {
    if (running) {
      head = step?.do || doing || PHASE_COPY[phase]?.title || SHORT[phase];
      line = [doing && doing !== head ? doing : null, total > 1 && step ? `Step ${plan.index + 1} of ${total}` : SHORT[phase]].filter(Boolean).join(' · ');
    } else if (streaming) {
      head = last.text || 'Thinking…';
      line = petName;
      mark = 'busy';
    } else if (flash) {
      head = flash.text;
      line = flash.kind === 'done' ? 'Done' : flash.kind === 'fail' ? SHORT.Failed : petName;
      mark = flash.kind === 'done' ? 'tick' : flash.kind === 'fail' ? 'cross' : 'dot';
    }
  } else if (view === 'compact') {
    // One line, because there is only room for one: "Halo · Ready".
    head = `${petName} · ${guardian.canAct === false ? 'Chat only' : line}`;
  } else if (view === 'open' || view === 'card') {
    line = running
      ? [total > 1 && step ? `Step ${plan.index + 1} of ${total}` : null, doing || SHORT[phase]].filter(Boolean).join(' · ')
      : guardian.canAct === false ? 'Chat only' : 'Ready';
  }
  if (waitingOnPerson) mark = 'attention';

  /* --- dragging the card -------------------------------------------------
     The window is moved by the bridge, not by the page: a page cannot move
     the window it is in. So the grab is measured here in screen coordinates
     and the new corner is posted; the host places it in one call, the same
     way the island is placed. */
  const drag = useRef(null);
  const onGrab = (e) => {
    if (view !== 'card' || e.button !== 0) return;
    if (e.target.closest('button, input, textarea')) return;
    drag.current = { dx: e.screenX - (window.screenX ?? 0), dy: e.screenY - (window.screenY ?? 0) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onDrag = (e) => {
    if (!drag.current) return;
    bridge.send('moveCard', { x: Math.round(e.screenX - drag.current.dx), y: Math.round(e.screenY - drag.current.dy) });
  };
  const onDrop = (e) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const recent = useMemo(() => chatState.list.filter((c) => c.id !== chatState.current).slice(0, 4), [chatState]);
  const showEmpty = !messages.length && !decision && !plan;
  const lvl = LEVELS[level];

  return (
    <Beam active={running && view !== 'compact'} size="md" color="colorful" strength={0.55} radius={view === 'compact' ? 18 : 26} className="h-island-beam">
      <div ref={rootRef} className={`h-island${capped ? ' is-capped' : ''}`} data-view={view} data-phase={phase} data-attention={waitingOnPerson ? 'true' : 'false'}>
        {/* --- the bar ---------------------------------------------------- */}
        <div className="h-island__bar" onClick={onBarClick}
          onPointerDown={onGrab} onPointerMove={onDrag} onPointerUp={onDrop} onPointerCancel={onDrop}>
          <span className="h-island__lead"><Presence px={view === 'compact' ? 22 : view === 'peek' ? 38 : 30} /></span>

          <div className="h-island__text">
            <div className="h-island__title" key={view === 'live' ? head : undefined}>{head}</div>
            <div className="h-island__sub">{line}</div>
          </div>

          <div className="h-island__trail">
            {view !== 'compact' && running && <RunControls size={14} />}
            {(view === 'compact' || !running) && (
              <span className="h-glyph" data-mark={mark}>
                {mark === 'tick' && <Icon name="check" size={11} />}
                {mark === 'cross' && <Icon name="x" size={11} />}
                {mark === 'busy' && <span className="h-glyph__bars"><i /><i /><i /><i /></span>}
              </span>
            )}
            {(view === 'open' || view === 'card') && (
              <>
                <button type="button" className="h-perm" data-level={level} title={`Permissions: ${lvl.label} — ${lvl.hint}`}
                  onClick={() => { const order = ['ask', 'smart', 'all']; permissions.set(order[(order.indexOf(level) + 1) % order.length]); }}>
                  <Icon name="shield" size={13} /><span>{lvl.label}</span>
                </button>
                {messages.length > 0 && <IconButton icon="plus" label="New chat" onClick={() => { chats.newChat(); open(); }} />}
                <IconButton icon="expand" label="Open the Halo window" onClick={() => bridge.send('openApp', {})} />
                {view === 'card'
                  ? <IconButton icon="chevron" label="Back to the island at the top"
                      onClick={() => bridge.send('setShell', { mode: 'island' })} />
                  : <IconButton icon="chevron" label="Collapse" onClick={collapse} />}
              </>
            )}
          </div>
        </div>

        {/* --- live: progress, and what just finished ---------------------- */}
        {view === 'live' && running && total > 1 && (
          <div className="h-rail" aria-hidden="true">
            {plan.steps.map((s, i) => (
              <i key={i} data-status={!plan.finished && i === plan.index ? 'current' : s.status} />
            ))}
          </div>
        )}
        {view === 'live' && !running && flash?.kind === 'done' && lastRun?.succeeded && (
          <div className="h-island__after" onClick={(e) => e.stopPropagation()}>
            <SaveShortcut onDone={() => setFlash(null)} />
          </div>
        )}

        {/* --- the chords, on arriving from the app window ----------------- */}
        {keys && (view === 'open' || view === 'card') && (
          <div className="h-keys" onClick={(e) => e.stopPropagation()}>
            <div className="h-keys__title">Reach Halo from anywhere</div>
            {TAUGHT.map((b) => (
              <div className="h-keys__row" key={b.id}>
                <span>{b.label}</span>
                <span className="h-keys__chord">{b.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
              </div>
            ))}
          </div>
        )}

        {/* --- guiding rather than working -------------------------------- */}
        {shell.guide && view !== 'compact' && (
          <div className="h-guide" onClick={(e) => e.stopPropagation()}>
            <span className="h-guide__cursor" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.2L9.8 19z" /></svg>
            </span>
            <div className="h-guide__say">
              <b>Guiding you</b>
              <span>Halo shows you where to go and what to type. It does not touch anything itself — {written(TAUGHT.find((k) => k.id === 'toggleGuide'))} to switch back.</span>
            </div>
          </div>
        )}

        {/* --- open and card: everything --------------------------------- */}
        {(view === 'open' || view === 'card') && (
          <div className="h-island__panel">
            <Thread className="h-island__thread" />

            {plan && (
              <section className="h-run" data-finished={plan.finished ? 'true' : 'false'}>
                <header className="h-run__head">
                  <span className="h-run__title">
                    {plan.finished ? (plan.succeeded ? 'Finished' : 'Stopped') : running ? `Working · ${doneCount} of ${total}` : 'Plan'}
                  </span>
                  <div className="h-run__meter"><i style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} /></div>
                </header>
                <PlanSteps limit={6} dense />
                {plan.finished && <div className="h-run__after"><SaveShortcut /></div>}
              </section>
            )}

            {decision && <Decision decision={decision} />}

            {showEmpty && (
              <div className="h-empty">
                <div className="h-empty__hello">
                  {guardian.canAct === false && guardian.reason ? guardian.reason : `What should ${petName} do?`}
                </div>
                {routines.length > 0 && (
                  <div className="h-group">
                    <div className="h-group__label">Your shortcuts</div>
                    <div className="h-chips">
                      {routines.slice(0, 6).map((r) => (
                        <MetalButton key={r.id} className="h-chip h-chip--metal" title={r.task} onClick={() => bridge.send('routineRun', { id: r.id })}>
                          <Icon name="bolt" size={12} />{r.name}
                        </MetalButton>
                      ))}
                    </div>
                  </div>
                )}
                <div className="h-chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="h-chip" onClick={() => {
                      const id = `you_${Date.now().toString(36)}`;
                      if (store.state.plan?.finished) store.setPlan(null);
                      store.addMessage({ id, from: 'you', text: s, done: true });
                      bridge.send('submitTask', { text: s, mode: store.state.mode, id });
                    }}>{s}</button>
                  ))}
                </div>
                {recent.length > 0 && (
                  <div className="h-group">
                    <div className="h-group__label">
                      Earlier
                      <button type="button" className="h-link" onClick={() => bridge.send('openApp', { section: 'chat' })}>All chats</button>
                    </div>
                    <div className="h-history">
                      {recent.map((c) => (
                        <div key={c.id} className="h-history__item" role="button" tabIndex={0}
                          onClick={() => chats.open(c.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') chats.open(c.id); }}>
                          <span className="h-history__title">{c.title}</span>
                          <span className="h-history__when">{ago(c.updated)}</span>
                          <IconButton icon="x" label="Delete this chat" size={12} className="h-history__del"
                            onClick={(e) => { e.stopPropagation(); chats.remove(c.id); }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!(decision?.kind === 'question') && <Composer petName={petName} inputRef={inputRef} />}
          </div>
        )}
      </div>
    </Beam>
  );
}

/* --------------------------------------------------------------------------
   Mounting
   -------------------------------------------------------------------------- */
const { mode, transport } = connect({ onStatus: (s) => { document.body.dataset.conn = s; } });
chats.attach({ mode });

const onMeasure = ({ width, height, view }) => {
  const q = new URLSearchParams({
    // Proves this page is the island the bridge opened, so a stray tab on
    // this URL cannot resize the real one.
    k: new URLSearchParams(location.search).get('k') ?? '',
    w: String(width),
    h: String(height),
    view,
    iw: String(innerWidth),
    ih: String(innerHeight),
    ow: String(outerWidth),
    oh: String(outerHeight),
  });
  fetch(`/notch/size?${q}`, { method: 'POST' }).catch(() => { /* no bridge behind this page */ });
};

const host = document.getElementById('island') ?? document.body.appendChild(document.createElement('div'));
createRoot(host).render(<Island onMeasure={onMeasure} />);

if (mode === 'mock') {
  const { MockAgent } = await import('../mock/agent.js');
  const agent = new MockAgent(transport);
  agent.start();
  window.halo = { store, agent };
} else {
  window.halo = { store };
}
window.pico = window.halo;
