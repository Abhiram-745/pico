/* ==========================================================================
   Halo — onboarding

   Four chords, one at a time, and you cannot get past one without pressing
   it. That is the whole design, and it is deliberate: Halo is a thing you
   reach for with the keyboard from inside whatever you are working in, so
   the keyboard is the first thing it teaches, and reading about a chord is
   not the same as having pressed it once.

   Each step runs the same three beats:

     read    the words, on their own, for a couple of seconds
     press   the keyboard appears with those keys lit; press them
     done    the desktop beside it does the thing you just asked for, then
             the next step is offered

   TWO THINGS WORTH KNOWING

   The press is counted by the bridge, not by this page: Windows tells the
   island host the chord fired (bridge/native/island-host.cs), which is the
   same path that will carry it when Halo is not the window in front. So
   what onboarding accepts is exactly what works afterwards. A local
   keydown is accepted too, for the preview, where there is no bridge.

   The keyboard fades out while any key is held. Somebody pressing the chord
   is not reading a picture of a keyboard at that moment, and the demo beside
   it is the thing they should see.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { bridge } from '../src/bridge.js';
import { TAUGHT, matches } from '../src/keybinds.js';
import { useStoreEvent } from './hooks.js';
import { Keyboard, useKeysDown } from './keyboard.jsx';
import { MetalButton, Orb } from './fx.jsx';
import { Icon } from './parts.jsx';

/* How long the words get on their own before the keyboard slides in. Long
   enough to read one sentence, short enough that nobody is waiting. */
const READ_MS = 2300;

/* --------------------------------------------------------------------------
   The stage

   A small drawing of this desktop, with Halo where Halo really is: a strip
   at the top middle of the screen. When a chord lands, the thing it does
   happens here — the island leaves and comes back, opens with a caret in it,
   becomes a card and drifts off to the corner, or grows a second cursor that
   points at things and tells you what to type.

   It is a drawing and not a video because it has to be true after a change
   to the island, and a video would be true only on the day it was recorded.
   -------------------------------------------------------------------------- */
function Stage({ demo, run, live }) {
  return (
    <div className={`h-stage${live ? ' is-live' : ''}`} data-demo={demo} data-run={run % 2} aria-hidden="true">
      <div className="h-stage__screen">
        <div className="h-stage__wall" />

        {/* what you were doing when you reached for Halo */}
        <div className="h-stage__win">
          <div className="h-stage__winbar"><i /><i /><i /></div>
          <div className="h-stage__lines">
            <span style={{ width: '72%' }} /><span style={{ width: '54%' }} />
            <span style={{ width: '63%' }} /><span style={{ width: '38%' }} />
          </div>
        </div>

        {/* Halo itself: the island at the top, or the card once it has moved */}
        <div className="h-stage__halo">
          <div className="h-stage__pill">
            <span className="h-stage__face" />
            <span className="h-stage__text">
              <b>Halo</b>
              <i className="h-stage__caret" />
            </span>
            <span className="h-stage__dot" />
          </div>
        </div>

        {/* guide mode: a second cursor that only ever points */}
        <div className="h-stage__guide">
          <svg viewBox="0 0 24 24" className="h-stage__cursor"><path d="M5 3l14 8.5-6.2 1.2L9.8 19z" /></svg>
          <span className="h-stage__bubble">Type “hello” here</span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   One key, as a button

   The same metal as the buttons that do things elsewhere in Halo, because
   these are the buttons that do things: hovering one says it is a key and
   not a picture of a key, and the metal runs across it while you are there.
   -------------------------------------------------------------------------- */
function KeyChip({ label, done, i }) {
  return (
    <span className="h-chipwrap" style={{ '--i': i }}>
      <MetalButton
        className={`h-chip${done ? ' is-done' : ''}`}
        preset="chromatic"
        strength={done ? 1.15 : 0.85}
        tabIndex={-1}
      >
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
  const [run, setRun] = useState(0);            // bumped to replay the demo
  const down = useKeysDown();
  const timer = useRef(null);

  const steps = TAUGHT;
  const step = steps[index];
  const last = index === steps.length - 1;

  /* The words, then the keyboard. */
  useEffect(() => {
    setBeat('read');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBeat('press'), READ_MS);
    return () => clearTimeout(timer.current);
  }, [index]);

  const land = useCallback(() => {
    setBeat((b) => (b === 'done' ? b : 'done'));
    setRun((r) => r + 1);
  }, []);

  /* The real chord, as Windows reported it to the bridge. */
  useStoreEvent(['chord'], (s) => {
    if (!s.chord || s.chord.id !== step?.id) return;
    if (beat === 'done') { setRun((r) => r + 1); return; }   // pressing it again replays
    land();
  });

  /* The same chord typed into this window, for when there is no bridge
     behind the page — and because the app window is often the focused one,
     in which case Windows hands the chord here first. */
  useEffect(() => {
    const on = (e) => {
      if (!step || !matches(e, step)) return;
      e.preventDefault();
      if (beat === 'done') setRun((r) => r + 1); else land();
    };
    addEventListener('keydown', on, true);
    return () => removeEventListener('keydown', on, true);
  }, [step, beat, land]);

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

  if (!step) return null;

  return (
    <div className="h-onboard" role="dialog" aria-modal="true" aria-label="Getting started with Halo">
      <div className="h-onboard__sheet">

        {/* --- left: what this one is ------------------------------------- */}
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
              {step.keys.map((k, i) => (
                <KeyChip key={k} label={k} i={i} done={beat === 'done'} />
              ))}
            </div>
          </div>

          <div className="h-onboard__state" data-beat={beat}>
            {beat === 'done' ? (
              <>
                <span className="h-onboard__tick"><Icon name="check" size={12} /></span>
                <span>That is it — press it again to watch it once more.</span>
              </>
            ) : (
              <>
                <Orb state={beat === 'press' ? 'listening' : 'breathing'} px={18} />
                <span>{beat === 'press' ? 'Go ahead, press it.' : 'One moment…'}</span>
              </>
            )}
          </div>

          <div className="h-onboard__go">
            <MetalButton
              className="h-onboard__next"
              disabled={beat !== 'done'}
              onClick={next}
              strength={1.1}
            >
              {last ? 'Start using Halo' : 'Next'}
            </MetalButton>
            <span className="h-onboard__nudge">
              {beat === 'done' ? '' : 'Every one of these works from anywhere on your desktop.'}
            </span>
          </div>
        </div>

        {/* --- right: the desktop, and the keyboard over it ---------------- */}
        <div className="h-onboard__show">
          <Stage demo={step.demo} run={run} live={beat === 'done'} />
          <div className={`h-onboard__kb${beat === 'read' ? ' is-away' : ''}`}>
            <Keyboard need={need} down={down} dim={held || beat === 'done'} />
          </div>
        </div>
      </div>
    </div>
  );
}
