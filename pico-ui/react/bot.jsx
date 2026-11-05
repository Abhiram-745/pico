/* ==========================================================================
   Halo's face — the one mascot hook.

   The living bot faces from `bot-avatars` (the same package and shapes the
   Pythe app draws its team with; see pythe-v2 AgentBotAvatar.tsx / mascots.ts),
   replacing the flat painted-screen rig in src/mascot.js. Everything that
   shows Halo's face goes through here:

     <Bot state="idle|working|thinking|success" size={n} />   a face
     useMascotState({ phase, streaming, flash })               phase -> state
     mountBot(el, opts)                                         for plain modules

   The library knows three bodies of motion (default / working / sleeping);
   Halo's four states are built from them:
     idle      default, a calm glance now and then
     thinking  default, head turned further and a touch faster — looking about
     working   the library's working hop
     success   one short hop, then back to idle
   Paused is the library's sleeping. Reduced motion draws one still frame.
   ========================================================================== */

import { useEffect, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BotAvatar } from 'bot-avatars';
import { useReducedMotion } from './fx.jsx';

/** Halo's own body: the droid, in the island's blue. */
export const HALO_BOT = Object.freeze({ shape: 'droid', color: '#8FB4FF', ink: '#14203a' });

export const MASCOT_STATES = Object.freeze(['idle', 'watching', 'working', 'thinking', 'success']);

/** The bridge's phases (store.js) -> the four states. */
export function mascotStateFor({ phase = 'Idle', streaming = false, flash = null, watching = false } = {}) {
  if (flash?.kind === 'done') return 'success';
  if (streaming) return 'thinking';
  switch (phase) {
    case 'Acting': return 'working';
    case 'Starting':
    case 'Observing':
    case 'Thinking':
    case 'Waiting':
    case 'AwaitingApproval':
    case 'AwaitingTakeover': return 'thinking';
    case 'Completed': return 'success';
    default: return watching ? 'watching' : 'idle';
  }
}

/** The state to draw: `success` is a one-off hop that settles back to idle. */
export function useMascotState(input) {
  const wanted = typeof input === 'string' ? input : mascotStateFor(input);
  const [hop, setHop] = useState(false);
  useEffect(() => {
    if (wanted !== 'success') { setHop(false); return undefined; }
    setHop(true);
    const t = setTimeout(() => setHop(false), 1700);
    return () => clearTimeout(t);
  }, [wanted]);
  if (wanted === 'success') return hop ? 'success' : 'idle';
  return wanted;
}

/* A small, simple 3D-looking bot for the island's top bar: a soft gradient
   head, a dark glass face with glossy eyes that blink, and an antenna that
   glows. Pure SVG + CSS (react/bot.css), so it costs nothing and holds
   still under prefers-reduced-motion. */
export function BotFace({ state = 'idle', size = 26, paused = false, label }) {
  const uid = useId().replace(/:/g, '');
  const s = paused ? 'paused' : state;
  return (
    <span className="h-face" data-state={s} style={{ width: size, height: size }}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <defs>
          <radialGradient id={`${uid}h`} cx="32%" cy="22%" r="95%"><stop offset="0" stopColor="#e6eeff" /><stop offset=".45" stopColor="#9db8f2" /><stop offset="1" stopColor="#4a63b8" /></radialGradient>
          <linearGradient id={`${uid}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b2750" /><stop offset="1" stopColor="#090e22" /></linearGradient>
          <radialGradient id={`${uid}e`} cx="40%" cy="30%" r="80%"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#b8f0ff" /><stop offset="1" stopColor="#4bbcff" /></radialGradient>
          <radialGradient id={`${uid}a`} cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#bff7e4" /><stop offset="1" stopColor="#3fd7a4" /></radialGradient>
        </defs>
        <ellipse className="h-face__shadow" cx="20" cy="37.4" rx="10" ry="1.7" />
        <g className="h-face__body">
          <line x1="20" y1="9.6" x2="20" y2="5.8" stroke="#8ea6e0" strokeWidth="1.4" strokeLinecap="round" />
          <circle className="h-face__glow" cx="20" cy="4.6" r="4.2" fill="#3fd7a4" />
          <circle className="h-face__bulb" cx="20" cy="4.6" r="2.3" fill={`url(#${uid}a)`} />
          <rect x="4.5" y="9.5" width="31" height="25" rx="11.5" fill={`url(#${uid}h)`} />
          <path d="M9 13.2c3-2.2 8-2.9 12-2.4" stroke="#ffffff" strokeOpacity=".7" strokeWidth="1.3" strokeLinecap="round" fill="none" />
          <rect x="8.5" y="14.5" width="23" height="15.5" rx="7.5" fill={`url(#${uid}s)`} />
          <g className="h-face__eyes">
            <g className="h-face__eye h-face__eye--l"><ellipse cx="15" cy="22.2" rx="2.7" ry="3.5" fill={`url(#${uid}e)`} /><circle cx="14.1" cy="20.7" r="1" fill="#fff" /></g>
            <g className="h-face__eye h-face__eye--r"><ellipse cx="25" cy="22.2" rx="2.7" ry="3.5" fill={`url(#${uid}e)`} /><circle cx="24.1" cy="20.7" r="1" fill="#fff" /></g>
          </g>
          <g className="h-face__happy" fill="none" stroke="#b8f0ff" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12.4 23.4q2.6-4 5.2 0" /><path d="M22.4 23.4q2.6-4 5.2 0" />
          </g>
        </g>
      </svg>
    </span>
  );
}

export function Bot({ state = 'idle', size = 40, paused = false, shape = HALO_BOT.shape, color = HALO_BOT.color, label, variant }) {
  const quiet = useReducedMotion();
  const s = MASCOT_STATES.includes(state) ? state : 'idle';
  if ((variant ?? (size <= 48 ? 'face' : 'plush')) === 'face') return <BotFace state={s} size={size} paused={paused} label={label} />;
  const lib = paused ? 'sleeping' : (s === 'working' || s === 'success') ? 'working' : 'default';
  // plush variant has no `watching`; it looks about a little more.
  return (
    <span className="h-bot" data-state={paused ? 'paused' : s} style={{ width: size, height: size }}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <BotAvatar
        type={shape}
        state={lib}
        size={size}
        color={color}
        ink={HALO_BOT.ink}
        face="eyes"
        shading="flat"
        turn={s === 'thinking' ? 0.9 : s === 'watching' ? 0.7 : 0.45}
        speed={s === 'thinking' ? 1.4 : 1}
        jumpEvery={0}
        paused={quiet}
        aria-hidden
      />
    </span>
  );
}

/** For modules that are not React (the first-run gate). Returns { set, destroy }. */
export function mountBot(el, { size = 108, state = 'idle', ...rest } = {}) {
  const root = createRoot(el);
  const draw = (next) => root.render(<BotHost state={next} size={size} {...rest} />);
  draw(state);
  return { set: draw, destroy: () => root.unmount() };
}

function BotHost({ state, ...rest }) {
  return <Bot state={useMascotState(state)} {...rest} />;
}
