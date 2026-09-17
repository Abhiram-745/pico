/* ==========================================================================
   Halo — onboarding

   Four chords, one at a time, and you cannot get past one without pressing
   it. That is the whole design, and it is deliberate: Halo is a thing you
   reach for with the keyboard from inside whatever you are working in, so
   the keyboard is the first thing it teaches, and reading about a chord is
   not the same as having pressed it once.

   THE TWO LAYERS
   Behind: a drawing of the desktop, filling the right of the sheet, with
   Halo on it — built from the island's own markup and its own stylesheet, so
   what is demonstrated here is the island, not an artist's impression of it.
   In front: the keyboard, over the whole window, with the chord lit. The
   moment a key goes down the keyboard clears away and the desktop behind it
   is doing the thing you just asked for. Press, and you see the result; stop
   pressing, and you get the keys back.

   WHAT COUNTS AS PRESSING IT
   The bridge, not this page: Windows hands the chord to the island host
   (bridge/native/island-host.cs), which is the same path that carries it
   when Halo is not the window in front — so what onboarding accepts is
   exactly what works afterwards. A keydown in this window counts too, for
   the preview, where there is no bridge to ask.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { bridge } from '../src/bridge.js';
import { TAUGHT, matches } from '../src/keybinds.js';
import { useStoreEvent } from './hooks.js';
import { Keyboard, useKeysDown } from './keyboard.jsx';
import { MetalButton, Orb } from './fx.jsx';
import { Icon, MascotView } from './parts.jsx';

/* How long the words get before the keyboard arrives over them. */
const READ_MS = 1600;

/* --------------------------------------------------------------------------
   Halo, as it really is

   The island's own class names and its own stylesheet (island.css is loaded
   by app.html for exactly this), scaled down to sit on a drawing of a
   screen. Anything that changes about the island changes here too, which is
   the only way a demonstration stays honest.
   -------------------------------------------------------------------------- */
function MiniHalo({ shape, talking }) {
  const view = shape === 'card' ? 'card' : shape === 'open' ? 'open' : 'compact';
  return (
    <div className="h-island" data-view={view} data-phase="Idle">
      <div className="h-island__bar">
        <span className="h-island__lead">
          <span className="h-presence" style={{ width: view === 'compact' ? 22 : 30, height: view === 'compact' ? 22 : 30 }}>
            <span className="h-presence__rest"><MascotView phase="Idle" size={view === 'compact' ? 22 : 30} /></span>
          </span>
        </span>
        <div className="h-island__text">
          <div className="h-island__title">
            {view === 'compact' ? 'Halo · Ready' : 'Halo'}
            {talking && <i className="h-mini__caret" />}
          </div>
          {view !== 'compact' && <div className="h-island__sub">Ready</div>}
        </div>
        <div className="h-island__trail"><span className="h-glyph" data-mark="dot" /></div>
      </div>

      {view !== 'compact' && (
        <div className="h-island__panel h-mini__panel">
          <div className="h-mini__thread">
            <span className="h-mini__bubble" style={{ width: '58%' }} />
            <span className="h-mini__bubble h-mini__bubble--you" style={{ width: '42%' }} />
          </div>
          <div className="h-mini__composer">{talking ? 'Ask Halo anything…' : 'Ask Halo anything, or give it a job…'}</div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   The desktop it lives on

   `demo` decides what Halo is doing on it. The card is not animated at all:
   it is put in your hands, because the thing worth knowing about a card is
   that you can move it, and being told that is not the same as dragging one.
   -------------------------------------------------------------------------- */
function Stage({ demo, live }) {
  const screen = useRef(null);
  const [at, setAt] = useState({ x: 62, y: 46 });      // per-cent, card only
  const grab = useRef(null);

  // A new step starts the card back where a card starts.
  useEffect(() => { setAt({ x: 62, y: 46 }); }, [demo]);

  const onDown = (e) => {
    if (demo !== 'card' || !live) return;
    const box = screen.current.getBoundingClientRect();
    grab.current = {
      box,
      dx: e.clientX - (box.left + (at.x / 100) * box.width),
      dy: e.clientY - (box.top + (at.y / 100) * box.height),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    const g = grab.current;
    if (!g) return;
    setAt({
      x: Math.max(4, Math.min(92, ((e.clientX - g.dx - g.box.left) / g.box.width) * 100)),
      y: Math.max(2, Math.min(86, ((e.clientY - g.dy - g.box.top) / g.box.height) * 100)),
    });
  };
  const onUp = (e) => {
    if (!grab.current) return;
    grab.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const isCard = demo === 'card' && live;
  const shape = isCard ? 'card' : demo === 'chat' && live ? 'open' : 'compact';

  const place = isCard
    ? { left: `${at.x}%`, top: `${at.y}%`, translate: '-50% 0' }
    : undefined;

  return (
    <div className={`h-stage${live ? ' is-live' : ''}`} data-demo={demo}>
      <div className="h-stage__screen" ref={screen}>
        <div className="h-stage__wall" />

        <div className="h-stage__win" aria-hidden="true">
          <div className="h-stage__winbar"><i /><i /><i /></div>
          <div className="h-stage__lines">
            <span style={{ width: '72%' }} /><span style={{ width: '54%' }} />
            <span style={{ width: '63%' }} /><span style={{ width: '38%' }} />
          </div>
        </div>

        <div
          className={`h-stage__halo${isCard ? ' is-card' : ''}`}
          style={place}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <MiniHalo shape={shape} talking={demo === 'chat' && live} />
        </div>

        {isCard && <div className="h-stage__grabhint">Drag it anywhere</div>}

        {demo === 'guide' && live && (
          <div className="h-stage__guide" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-stage__cursor"><path d="M5 3l14 8.5-6.2 1.2L9.8 19z" /></svg>
            <span className="h-stage__bubble">Type “hello” here</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* One key of the chord, as a metal button. */
function KeyChip({ label, done, i }) {
  return (
    <span className="h-chipwrap" style={{ '--i': i }}>
      <MetalButton className={`h-chip${done ? ' is-done' : ''}`} preset="chromatic" strength={done ? 1.15 : 0.85} tabIndex={-1}>
        {label}
      </MetalButton>
    </span>
  );
}

/* --------------------------------------------------------------------------
   Onboarding
   -------------------------------------------------------------------------- */
export function Onboard({ onDone }) {
  const [index, setIndex] = useState(0);
  const [beat, setBeat] = useState('read');     // read -> press -> done
  const down = useKeysDown();
  const timer = useRef(null);

  const steps = TAUGHT;
  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    setBeat('read');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBeat('press'), READ_MS);
    return () => clearTimeout(timer.current);
  }, [index]);

  const land = useCallback(() => setBeat('done'), []);

  /* The real chord, as Windows reported it to the bridge. */
  useStoreEvent(['chord'], (s) => {
    if (s.chord?.id === step?.id) land();
  });

  /* The same chord in this window — the preview has no bridge behind it. */
  useEffect(() => {
    const on = (e) => {
      if (!step || !matches(e, step)) return;
      e.preventDefault();
      land();
    };
    addEventListener('keydown', on, true);
    return () => removeEventListener('keydown', on, true);
  }, [step, land]);

  const next = () => {
    if (last) {
      bridge.send('onboarded', {});
      onDone?.();
      return;
    }
    setIndex((i) => i + 1);
  };

  const held = down.length > 0;
  const need = useMemo(() => step?.keys ?? [], [step]);
  // The board is in front until a key is held or the chord has landed; after
  // that the desktop behind it is the thing to look at.
  const boardUp = beat === 'press' && !held;

  if (!step) return null;

  return (
    <div className="h-onboard" role="dialog" aria-modal="true" aria-label="Getting started with Halo">
      <div className="h-onboard__sheet">
        <div className="h-onboard__say">
          <div className="h-onboard__count">
            {steps.map((s, i) => (
              <i key={s.id} data-state={i < index ? 'done' : i === index ? 'now' : 'todo'} />
            ))}
            <span>{index + 1} of {steps.length}</span>
          </div>

          <h1 className="h-onboard__title">{step.label}</h1>
          <p className="h-onboard__hint">{step.hint}</p>

          <div className="h-onboard__visual">
            <span className="h-onboard__vlabel">Press</span>
            <div className="h-onboard__chips">
              {step.keys.map((k, i) => <KeyChip key={k} label={k} i={i} done={beat === 'done'} />)}
            </div>
          </div>

          <div className="h-onboard__state" data-beat={beat}>
            {beat === 'done' ? (
              <>
                <span className="h-onboard__tick"><Icon name="check" size={12} /></span>
                <span>{step.demo === 'card' ? 'That is it — now drag it somewhere.' : 'That is it.'}</span>
              </>
            ) : (
              <>
                <Orb state={beat === 'press' ? 'listening' : 'breathing'} px={18} />
                <span>{beat === 'press' ? 'Go ahead, press it.' : 'One moment…'}</span>
              </>
            )}
          </div>

          <div className="h-onboard__go">
            <MetalButton className="h-onboard__next" disabled={beat !== 'done'} onClick={next} strength={1.1}>
              {last ? 'Start using Halo' : 'Next'}
            </MetalButton>
            <span className="h-onboard__nudge">
              {beat === 'done' ? '' : 'Every one of these works from anywhere on your desktop.'}
            </span>
          </div>
        </div>

        <div className="h-onboard__show">
          <Stage demo={step.demo} live={beat === 'done'} />
        </div>
      </div>

      {/* The board, over everything, until a key is actually held down. */}
      <div className={`h-onboard__kb${boardUp ? '' : ' is-away'}`} aria-hidden={!boardUp}>
        <Keyboard need={need} down={down} />
      </div>
    </div>
  );
}
