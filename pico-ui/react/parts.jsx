/* ==========================================================================
   Halo — the pieces the island and the app window share.

   The same conversation, the same decision card, the same plan and the same
   box to type into, in both places. They differ in how much room they get,
   not in how they behave: a question answered in the island has been
   answered in the app window, because it is the same card reading the same
   store.

   IN PLACE, NOT REBUILT
   A reply streams in a few words at a time. Each message is its own
   component, memoised on what it shows, so a new word re-renders that one
   message and nothing else — no thread rebuilt, no entrance animation
   replayed, no flicker.
   ========================================================================== */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { store, isActive } from '../src/store.js';
import { bridge } from '../src/bridge.js';
import { Mascot } from '../src/mascot.js';
import { Beam, MetalButton, Orb, orbStateFor } from './fx.jsx';
import { useStore, sel } from './hooks.js';

/* --------------------------------------------------------------------------
   Icons — Lucide-style paths on a 24 unit grid, 2px round stroke.
   -------------------------------------------------------------------------- */
const PATHS = {
  send: 'M12 19V5 M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  pause: 'M9 5v14 M15 5v14',
  play: 'M8 5.5v13l10.5-6.5z',
  skip: 'M5 5.5v13l9-6.5z M18 5v14',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18 M6 6l12 12',
  chevron: 'm18 15-6-6-6 6',
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-3.5-3.5',
  pencil: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z M13.5 6.5l4 4',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12 M9 7V4h6v3',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  brain: 'M12 5a3 3 0 0 0-5.8-1A3 3 0 0 0 3 8a3 3 0 0 0 .6 5.4A3.5 3.5 0 0 0 8 19a3 3 0 0 0 4 1 M12 5a3 3 0 0 1 5.8-1A3 3 0 0 1 21 8a3 3 0 0 1-.6 5.4A3.5 3.5 0 0 1 16 19a3 3 0 0 1-4 1 M12 5v15',
  chat: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z',
  activity: 'M3 12h4l2.5-7 4 14 2.5-7h5',
  monitor: 'M3 5h18v12H3z M8 21h8 M12 17v4',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z',
  update: 'M20 11a8 8 0 1 0-.6 3M20 5v6h-6',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4',
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01',
  ask: 'M12 17h.01 M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
  hand: 'M18 11V6a2 2 0 0 0-4 0 M14 10V4a2 2 0 0 0-4 0v2 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  expand: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg className={`h-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={name === 'stop' || name === 'play' ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function IconButton({ icon, label, onClick, className = '', size = 15, ...rest }) {
  return (
    <button type="button" className={`h-ibtn ${className}`} title={label} aria-label={label} onClick={onClick} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/* --------------------------------------------------------------------------
   The mascot — the existing rig, hosted in a React node.
   -------------------------------------------------------------------------- */
export function MascotView({ phase = 'Idle', size = 26 }) {
  const host = useRef(null);
  const rig = useRef(null);
  useLayoutEffect(() => {
    rig.current = new Mascot({ size });
    host.current.replaceChildren(rig.current.el);
    return () => host.current?.replaceChildren();
  }, [size]);
  useEffect(() => { rig.current?.setPhase(phase); }, [phase]);
  return <span className="h-mascot" ref={host} style={{ width: size, height: size }} />;
}

/**
 * Halo's face for this moment: the orb while it thinks, the mascot at rest.
 * Crossfaded rather than swapped, so a phase change reads as one character
 * changing expression rather than two things taking turns.
 */
export function Presence({ px = 26 }) {
  const phase = useStore(sel.phase);
  const plan = useStore(sel.plan);
  const messages = useStore(sel.messages);
  const last = messages[messages.length - 1];
  const streaming = Boolean(last && last.from === 'pico' && !last.done);
  const waiting = streaming && !last.text;
  const prev = plan && plan.index > 0 ? plan.steps[plan.index - 1] : null;
  const replanning = Boolean(prev && (prev.status === 'failed' || prev.status === 'changed'));
  const orb = orbStateFor({ phase, streaming, waiting, replanning });
  return (
    <span className="h-presence" data-busy={orb ? 'true' : 'false'} style={{ width: px, height: px }}>
      <span className="h-presence__rest"><MascotView phase={phase} size={px} /></span>
      <span className="h-presence__busy">
        {orb && <Orb state={orb} px={px} paused={phase === 'Paused'} />}
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------------
   The thread
   -------------------------------------------------------------------------- */
const Message = memo(function Message({ id, from, text, done, memoryId, remembered }) {
  if (from === 'event') {
    return (
      <div className="h-msg h-msg--event" data-id={id}>
        <span>{text}</span>
        {memoryId && remembered && (
          <button type="button" className="h-link" onClick={() => bridge.send('memoryRemove', { id: memoryId })}>Forget</button>
        )}
        {memoryId && !remembered && <span className="h-msg__gone">forgotten</span>}
      </div>
    );
  }
  if (from === 'pico' && !text && !done) {
    return (
      <div className="h-msg h-msg--pico h-msg--waiting" data-id={id}>
        <Orb state="breathing" px={20} />
        <span className="h-shimmer">Thinking</span>
      </div>
    );
  }
  return (
    <div className={`h-msg h-msg--${from}${done ? '' : ' is-streaming'}`} data-id={id}>
      {text}
    </div>
  );
});

export function Thread({ className = '', stickToBottom = true }) {
  const messages = useStore(sel.messages);
  const memory = useStore(sel.memory);
  const kept = useMemo(() => new Set(memory.map((f) => f.id)), [memory]);
  const ref = useRef(null);
  const pinned = useRef(true);

  // Follow the conversation down, unless the person has scrolled up to read.
  const onScroll = () => {
    const el = ref.current;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    if (stickToBottom && pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  if (!messages.length) return null;
  return (
    <div className={`h-thread ${className}`} ref={ref} onScroll={onScroll}>
      {messages.map((m) => (
        <Message key={m.id} id={m.id} from={m.from} text={m.text} done={m.done}
          memoryId={m.memoryId} remembered={m.memoryId ? kept.has(m.memoryId) : false} />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   A decision: a question, an approval, or a handover.

   The one moment Halo is stopped and waiting on the person, so it must be
   impossible to miss: its own colour, a pulse of light round its edge that
   does not stop until it is dealt with, the island held open around it, and
   the primary answer in metal.
   -------------------------------------------------------------------------- */
const ATTENTION = {
  question: { label: 'Needs your answer', icon: 'ask', color: 'ocean' },
  approval: { label: 'Needs your approval', icon: 'alert', color: 'sunset' },
  takeover: { label: 'Your turn', icon: 'hand', color: 'ocean' },
};

export function useDecision(autoApproved) {
  const question = useStore(sel.question);
  const approvalRaw = useStore(sel.approval);
  const takeover = useStore(sel.takeover);
  const approval = approvalRaw && !autoApproved?.has(approvalRaw.id) ? approvalRaw : null;
  if (question) return { kind: 'question', item: question, key: `q:${question.id}` };
  if (approval) return { kind: 'approval', item: approval, key: `a:${approval.id}` };
  if (takeover) return { kind: 'takeover', item: takeover, key: `t:${takeover.id}` };
  return null;
}

export function Decision({ decision, compact = false }) {
  const [answer, setAnswer] = useState('');
  const field = useRef(null);
  const primary = useRef(null);
  const { kind, item } = decision;
  const look = ATTENTION[kind];
  const options = kind === 'question' && Array.isArray(item.options) ? item.options.filter((o) => o && o.id && o.label) : [];

  useEffect(() => {
    setAnswer('');
    // The consequential button is never the one you hit by reflex; a question
    // with no set answers wants typing, so the field is ready for it.
    requestAnimationFrame(() => {
      if (kind === 'question' && !options.length) field.current?.focus({ preventScroll: true });
    });
  }, [decision.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (text, choice = null) => {
    const value = String(text ?? '').trim();
    if (!value) return;
    // The bridge writes both halves into the thread once it has the answer.
    bridge.send('answerQuestion', { id: item.id, text: value, ...(choice ? { choice } : {}) });
    store.setQuestion(null);
  };

  return (
    <Beam size="pulse-inner" color={look.color} strength={0.9} duration={1.8} className="h-decision-beam">
      <section className={`h-decision h-decision--${kind}${compact ? ' is-compact' : ''}`} role="alertdialog" aria-label={look.label}>
        <header className="h-decision__flag">
          <i className="h-decision__dot" />
          <span>{look.label}</span>
        </header>
        <div className="h-decision__main">
          <span className="h-decision__icon"><Icon name={look.icon} size={17} /></span>
          <div className="h-decision__body">
            <div className="h-decision__title">
              {kind === 'question' ? item.text : kind === 'approval' ? item.summary : 'Please complete this step yourself'}
            </div>
            {kind === 'approval' && (
              <>
                {item.risk?.reason && <div className="h-decision__reason">{item.risk.reason}</div>}
                {item.target && <div className="h-decision__target"><span>Where</span>{item.target}</div>}
              </>
            )}
            {kind === 'takeover' && (
              <>
                <div className="h-decision__reason">{item.reason}</div>
                {item.appName && <div className="h-decision__target"><span>Where</span>{item.appName}</div>}
              </>
            )}
          </div>
        </div>

        {kind === 'question' && (
          <div className="h-decision__answer">
            {options.length > 0 && (
              <div className="h-decision__choices">
                {options.map((o, i) => (i === 0
                  ? <MetalButton key={o.id} className="h-pill h-pill--primary" onClick={() => send(o.label, o.id)} title={o.label}>{o.label}</MetalButton>
                  : <button key={o.id} type="button" className="h-pill" onClick={() => send(o.label, o.id)} title={o.label}>{o.label}</button>))}
              </div>
            )}
            <div className="h-field">
              <input
                ref={field}
                className="h-field__input"
                value={answer}
                placeholder={options.length ? 'Or type something else…' : 'Type your answer…'}
                aria-label={item.text}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(answer); } }}
              />
              <MetalButton circle aria-label="Answer" disabled={!answer.trim()} onClick={() => send(answer)} className="h-send">
                <Icon name="send" size={15} />
              </MetalButton>
            </div>
          </div>
        )}

        {kind === 'approval' && (
          <div className="h-decision__actions">
            <span className="h-decision__note">Applies once. Later steps still ask.</span>
            <button type="button" className="h-pill h-pill--danger" onClick={() => bridge.send('deny', { id: item.id })}>Stop</button>
            <MetalButton ref={primary} className="h-pill h-pill--primary" onClick={() => bridge.send('approve', { id: item.id })}>Allow once</MetalButton>
          </div>
        )}

        {kind === 'takeover' && (
          <div className="h-decision__actions">
            <span className="h-decision__note">Halo never types passwords or codes. It looks again when you continue.</span>
            <MetalButton className="h-pill h-pill--primary" onClick={() => bridge.send('takeoverDone', { id: item.id })}>Done — carry on</MetalButton>
          </div>
        )}
      </section>
    </Beam>
  );
}

/* --------------------------------------------------------------------------
   The plan, as Halo works through it.
   -------------------------------------------------------------------------- */
const STATUS_WORD = { done: 'Done', skipped: 'Skipped', failed: 'Did not work', changed: 'Changed', pending: 'Next' };

export function PlanSteps({ limit = 12, dense = false }) {
  const plan = useStore(sel.plan);
  const phase = useStore(sel.phase);
  const action = useStore(sel.action);
  if (!plan?.steps?.length) return null;
  const running = !plan.finished && isActive(phase);
  const steps = plan.steps.map((s, i) => ({ ...s, i }));
  // Long plans show the neighbourhood of the current step, not the whole list.
  const from = Math.max(0, Math.min(plan.index - 2, steps.length - limit));
  const visible = steps.slice(from, from + limit);

  return (
    <ol className={`h-steps${dense ? ' is-dense' : ''}`} aria-label="Plan">
      {from > 0 && <li className="h-steps__more">{from} earlier step{from === 1 ? '' : 's'}</li>}
      {visible.map((s) => {
        const current = running && s.i === plan.index;
        const status = current ? 'current' : s.status;
        return (
          <li key={`${s.i}:${s.do}`} className="h-step" data-status={status}>
            <span className="h-step__mark">
              {current ? <Orb state={orbStateFor({ phase }) ?? 'working'} px={20} paused={phase === 'Paused'} />
                : status === 'done' ? <Icon name="check" size={12} />
                : status === 'skipped' ? <Icon name="skip" size={11} />
                : status === 'failed' || status === 'changed' ? <Icon name="x" size={11} />
                : <i />}
            </span>
            <span className="h-step__text">
              <span className="h-step__do">{s.do}</span>
              {current && action?.detail && phase === 'Acting' && <span className="h-step__why">{action.detail}</span>}
              {!current && status !== 'pending' && status !== 'done' && <span className="h-step__why">{STATUS_WORD[status]}</span>}
            </span>
            {current && (
              <button type="button" className="h-step__skip" onClick={() => bridge.send('skipStep', { index: s.i })} title="Skip this step">
                Skip
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Pause or resume, skip, stop — the controls for a run in hand. */
export function RunControls({ size = 15 }) {
  const phase = useStore(sel.phase);
  const plan = useStore(sel.plan);
  if (!isActive(phase)) return null;
  const paused = phase === 'Paused';
  const canSkip = Boolean(plan && !plan.finished && plan.index < plan.steps.length);
  return (
    <div className="h-controls">
      <IconButton icon={paused ? 'play' : 'pause'} label={paused ? 'Resume' : 'Pause'} size={size}
        onClick={() => bridge.send(paused ? 'resume' : 'pause')} />
      {canSkip && <IconButton icon="skip" label="Skip this step" size={size} onClick={() => bridge.send('skipStep', { index: plan.index })} />}
      <IconButton icon="stop" label="Stop — Esc" size={size - 3} className="h-ibtn--stop" onClick={() => bridge.send('stop')} />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Keep a finished task as a shortcut.
   -------------------------------------------------------------------------- */
export function SaveShortcut({ onDone }) {
  const lastRun = useStore(sel.lastRun);
  const routines = useStore(sel.routines);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const input = useRef(null);
  useEffect(() => { if (naming) input.current?.focus({ preventScroll: true }); }, [naming]);
  useEffect(() => { setNaming(false); setName(''); }, [lastRun?.task]);
  if (!lastRun?.succeeded || routines.some((r) => r.task === lastRun.task)) return null;

  const save = () => {
    const value = name.trim();
    if (!value) return;
    bridge.send('routineSave', { name: value });
    setNaming(false);
    setName('');
    onDone?.();
  };

  if (!naming) {
    return (
      <button type="button" className="h-chip h-chip--save" onClick={() => setNaming(true)}>
        <Icon name="bookmark" size={13} /> Save as shortcut
      </button>
    );
  }
  return (
    <div className="h-field h-field--inline">
      <input ref={input} className="h-field__input" value={name} maxLength={48} placeholder="Name it, e.g. morning setup"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
      <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={!name.trim()} onClick={save}>Save</MetalButton>
    </div>
  );
}

/* --------------------------------------------------------------------------
   The box you type into.

   Three jobs, one box. Idle, it starts something. While a run can be
   steered, it steers it — "no, the other one" goes to the run in hand, not
   into a queue behind it — and light travels along its edge to say so.
   -------------------------------------------------------------------------- */
const MODE_ORDER = ['auto', 'chat', 'agent'];
const MODE_LABEL = { auto: 'Auto', chat: 'Chat', agent: 'Do it' };
const MODE_HINT = {
  auto: 'Halo decides whether to talk or to work',
  chat: 'Talk only — nothing on your computer is touched',
  agent: 'Always act on the desktop',
};

export function Composer({ petName = 'Halo', autoFocus = false, inputRef = null, big = false }) {
  const phase = useStore(sel.phase);
  const plan = useStore(sel.plan);
  const mode = useStore(sel.mode);
  const guardian = useStore(sel.guardian);
  const [text, setText] = useState('');
  const own = useRef(null);
  const ref = inputRef ?? own;

  const steering = isActive(phase) && Boolean(plan && !plan.finished);
  const blocked = isActive(phase) && !steering;
  const canSend = Boolean(text.trim()) && guardian.ready && !blocked;

  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus, ref]);

  const submit = () => {
    const t = text.trim();
    if (!t || !canSend) return;
    if (steering) {
      bridge.send('steer', { text: t });
    } else {
      const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // A finished plan belongs to the task before; the conversation has moved on.
      if (store.state.plan?.finished) store.setPlan(null);
      store.addMessage({ id, from: 'you', text: t, done: true });
      store.addRecent(t);
      bridge.send('submitTask', { text: t, mode, id });
    }
    setText('');
  };

  const placeholder = steering
    ? `Tell ${petName} something — "no, the other one"…`
    : blocked ? `${petName} is working…`
    : mode === 'chat' ? `Talk to ${petName}…`
    : mode === 'agent' ? `Tell ${petName} what to do…`
    : `Ask ${petName} anything, or give it a job…`;

  return (
    <Beam active={steering} size="line" color="ocean" strength={0.85} className="h-composer-beam">
      <div className={`h-composer${big ? ' is-big' : ''}`} data-steering={steering ? 'true' : 'false'}>
        {steering
          ? <span className="h-composer__tag">Steer</span>
          : (
            <button type="button" className="h-composer__mode" data-mode={mode} title={MODE_HINT[mode]}
              onClick={() => { store.setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]); ref.current?.focus(); }}>
              {MODE_LABEL[mode]}
            </button>
          )}
        <input
          ref={ref}
          className="h-composer__input"
          value={text}
          disabled={!guardian.ready}
          placeholder={placeholder}
          aria-label={steering ? 'Steer the task in hand' : 'Message or task'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <MetalButton circle aria-label={steering ? 'Send to the task' : 'Send'} disabled={!canSend} onClick={submit} className="h-send">
          <Icon name="send" size={big ? 17 : 15} />
        </MetalButton>
      </div>
    </Beam>
  );
}
