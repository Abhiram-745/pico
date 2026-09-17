/* ==========================================================================
   Halo — the three effects, and when each is used.

   ORB (thinking-orbs)
   Whenever Halo is thinking, in place of a spinner. Each phase has its own
   motion, so the orb says what kind of thinking it is: looking at the
   screen is "searching", working out a plan is "solving", changing course
   after something went wrong is "shaping", writing a reply is "composing".
   The mascot is still who Halo is at rest; the orb is Halo busy.

   METAL (metal-fx)
   The buttons that do something — send, allow, run, save — and nothing
   else. A liquid-metal ring on every button would make none of them stand
   out, which is the one job it has.

   BEAM (border-beam)
   Light travelling round an edge, for "something is happening here": the
   island while a task runs, the box you type into while a run can be
   steered, and — as a steady pulse — a question or an approval that is
   waiting on you.

   All three fall back to the plain element when WebGL or the canvas is not
   there, and all three hold still under prefers-reduced-motion.
   ========================================================================== */

import { forwardRef, useEffect, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { MetalFx } from 'metal-fx';
import { BorderBeam } from 'border-beam';

const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function useReducedMotion() {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    let mq;
    try { mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; }
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Which orb a moment calls for, or null when Halo is not thinking at all.
 *
 * @param {object} s
 *   phase      the run's phase
 *   streaming  a reply is being written
 *   waiting    a reply has been asked for and not one word has come back
 *   replanning the plan's previous step just failed or was corrected
 */
export function orbStateFor({ phase, streaming = false, waiting = false, replanning = false }) {
  if (waiting) return 'breathing';
  if (streaming) return 'composing';
  switch (phase) {
    case 'Starting': return 'connecting';
    case 'Observing': return 'searching';
    case 'Thinking': return replanning ? 'shaping' : 'solving';
    case 'Acting': return 'working';
    case 'Paused': return 'breathing';
    case 'AwaitingApproval':
    case 'AwaitingTakeover': return 'listening';
    default: return null;
  }
}

/** A word for each orb, for people who cannot see it move. */
export const ORB_WORD = {
  connecting: 'Getting ready',
  searching: 'Looking',
  solving: 'Planning',
  shaping: 'Changing course',
  working: 'Working',
  breathing: 'Thinking',
  composing: 'Writing',
  listening: 'Waiting for you',
  weaving: 'Connecting',
};

/**
 * The orb, at any display size.
 *
 * It ships tuned for exactly two sizes, 64 and 20. Anything in between is
 * drawn at the nearest tuned size above it and scaled down, which keeps the
 * tuning rather than inventing a third.
 */
export function Orb({ state, px = 20, paused = false, speed = 1, className = '' }) {
  const reduced = useReducedMotion();
  const tuned = px <= 20 ? 20 : 64;
  const scale = px / tuned;
  return (
    <span
      className={`h-orb ${className}`}
      style={{ width: px, height: px }}
      role="img"
      aria-label={ORB_WORD[state] ?? 'Thinking'}
    >
      <span className="h-orb__inner" style={{ transform: scale === 1 ? undefined : `scale(${scale})`, width: tuned, height: tuned }}>
        <ThinkingOrb state={state} size={tuned} theme="dark" speed={speed} paused={paused || reduced} aria-hidden="true" />
      </span>
    </span>
  );
}

/**
 * A button with a liquid-metal ring. `circle` for icon buttons.
 * Everything else a button takes passes straight through to the button.
 */
export const MetalButton = forwardRef(function MetalButton(
  { circle = false, preset = 'chromatic', strength = 1, quiet = false, className = '', children, disabled, ...rest },
  ref,
) {
  const reduced = useReducedMotion();
  return (
    <MetalFx
      preset={preset}
      variant={circle ? 'circle' : 'button'}
      theme="dark"
      strength={disabled ? 0.35 * strength : strength}
      innerShadow={circle}
      disableGlow={quiet || disabled}
      paused={reduced || disabled}
      className={`h-metal ${circle ? 'h-metal--circle' : ''}`}
    >
      <button ref={ref} type="button" className={`h-mbtn ${circle ? 'h-mbtn--circle' : ''} ${className}`} disabled={disabled} {...rest}>
        {children}
      </button>
    </MetalFx>
  );
});

/**
 * Light round an edge. `active` false leaves the child exactly as it was —
 * the beam is a state, not a decoration.
 */
export function Beam({ active = true, size = 'md', color = 'colorful', strength = 0.7, radius, className = '', children, duration }) {
  const reduced = useReducedMotion();
  return (
    <BorderBeam
      size={size}
      colorVariant={color}
      strength={strength}
      theme="dark"
      active={active && !reduced}
      borderRadius={radius}
      duration={duration}
      className={`h-beam ${className}`}
    >
      {children}
    </BorderBeam>
  );
}
