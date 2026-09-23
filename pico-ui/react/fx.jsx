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
   out, which is the one job it has. And even on those it was too much: a
   dozen rings all moving and glowing at once is a light show, not a hint.
   So there are two tones now. Most metal buttons are calm — a thin, still
   ring at half strength with no halo, that only starts to move while the
   pointer or the keyboard is on it. `hero` is for the one button a screen
   is really about (New chat, the update): the metal moves on its own, and
   the halo still only comes up when you reach for it.

   BEAM (border-beam)
   Light travelling round an edge, for "something is happening here": the
   island while a task runs, the box you type into while a run can be
   steered, and — as a steady pulse — a question or an approval that is
   waiting on you. Slow and faint by default (see CALM_BEAM): it is there
   to be noticed out of the corner of an eye, not to be watched.

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
    // Halo has let go of the mouse and is only polling a chat app for its
    // answer — nothing to point at, so the same idle-but-alive orb as a
    // pause, not "working".
    case 'Waiting': return 'breathing';
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
      <span className="h-orb__inner" style={{ transform: `translate(-50%, -50%) scale(${scale})`, width: tuned, height: tuned }}>
        <ThinkingOrb state={state} size={tuned} theme="dark" speed={speed} paused={paused || reduced} aria-hidden="true" />
      </span>
    </span>
  );
}

/**
 * A button with a liquid-metal ring. `circle` for icon buttons.
 *
 *   calm (default)  still ring, strength 0.5, no halo; moves while hovered
 *                   or focused, so it answers the hand without shouting
 *   hero            moving ring, strength 0.8; the halo comes up, softly,
 *                   only while hovered or focused. One per screen at most.
 *
 * `strength` overrides either; `quiet` keeps the halo off even on a hero.
 * Everything else a button takes passes straight through to the button.
 */
export const MetalButton = forwardRef(function MetalButton(
  { circle = false, hero = false, preset = 'chromatic', strength, quiet = false, className = '', children, disabled, ...rest },
  ref,
) {
  const reduced = useReducedMotion();
  // Whether a hand is on it — pointer over it, or keyboard focus inside it.
  const [near, setNear] = useState(false);
  const base = strength ?? (hero ? 0.8 : 0.5);
  const moving = !reduced && !disabled && (hero || near);
  return (
    <MetalFx
      preset={preset}
      variant={circle ? 'circle' : 'button'}
      theme="dark"
      strength={disabled ? 0.35 * base : base}
      glowGain={0.55}
      innerShadow={circle}
      disableGlow={quiet || disabled || !hero || !near}
      paused={!moving}
      onPointerEnter={() => setNear(true)}
      onPointerLeave={() => setNear(false)}
      onFocus={() => setNear(true)}
      onBlur={() => setNear(false)}
      className={`h-metal ${circle ? 'h-metal--circle' : ''}${hero ? ' h-metal--hero' : ''}`}
    >
      <button ref={ref} type="button" className={`h-mbtn ${circle ? 'h-mbtn--circle' : ''} ${className}`} disabled={disabled} {...rest}>
        {children}
      </button>
    </MetalFx>
  );
});

/**
 * How loud each kind of beam is when the call site does not say. Half or
 * less of the library's own defaults, and a good deal slower: at full
 * strength a rotating beam round the island read as a warning light, and
 * the approval pulse at 1.8s was closer to a strobe than to breathing.
 * The library's own defaults, for comparison: strength 1, and a cycle of
 * 1.96s (md/sm), 3.1s (line), 2.3s (pulses).
 */
const CALM_BEAM = {
  sm: { strength: 0.45, duration: 3.2 },
  md: { strength: 0.45, duration: 3.6 },
  line: { strength: 0.4, duration: 4.4 },
  'pulse-inner': { strength: 0.55, duration: 2.9 },
  'pulse-outside': { strength: 0.45, duration: 2.9 },
};

/**
 * Light round an edge. `active` false leaves the child exactly as it was —
 * the beam is a state, not a decoration.
 */
export function Beam({ active = true, size = 'md', color = 'colorful', strength, radius, className = '', children, duration }) {
  const reduced = useReducedMotion();
  const calm = CALM_BEAM[size] ?? CALM_BEAM.md;
  return (
    <BorderBeam
      size={size}
      colorVariant={color}
      strength={strength ?? calm.strength}
      theme="dark"
      active={active && !reduced}
      borderRadius={radius}
      duration={duration ?? calm.duration}
      className={`h-beam ${className}`}
    >
      {children}
    </BorderBeam>
  );
}
