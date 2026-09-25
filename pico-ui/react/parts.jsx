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
import { createPortal } from 'react-dom';
import { store, isActive } from '../src/store.js';
import { bridge } from '../src/bridge.js';
import { Mascot } from '../src/mascot.js';
import { Beam, MetalButton, Orb, orbStateFor } from './fx.jsx';
import { useStore, useStoreEvent, sel } from './hooks.js';
import { speak, stopVoice, setVoiceEnabled } from '../src/voice.js';
import { createMicrophone } from '../src/microphone.js';
import { claimVoice, updateVoice, endVoice, releaseVoice, stopEverything, onVoiceSession, isSpokenStop, voiceOwner } from '../src/voice-session.js';
import { byId as keybind } from '../src/keybinds.js';
import {
  MAX_ATTACHMENTS, MAX_PAYLOAD_BYTES, attachmentFromFile, buildPastedTextAttachment,
  estimateAttachmentBytes, formatBytes, shouldAttachPaste, toBridgeAttachment, toDisplayAttachment,
} from '../src/attachments.js';

/* --------------------------------------------------------------------------
   Icons — Lucide-style paths on a 24 unit grid, 2px round stroke.
   -------------------------------------------------------------------------- */
const PATHS = {
  send: 'M12 19V5 M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3 M8 21h8',
  volume: 'M11 5 6 9H3v6h3l5 4z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13',
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
  power: 'M12 3v8 M6.3 6.7a8 8 0 1 0 11.4 0',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4',
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01',
  ask: 'M12 17h.01 M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
  hand: 'M18 11V6a2 2 0 0 0-4 0 M14 10V4a2 2 0 0 0-4 0v2 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  expand: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  paperclip: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  file: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z M14 2v6h6',
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
   A tiny, safe markdown subset for Halo's replies.

   Paragraphs, **bold**, *italic*, `code`, fenced code blocks, bullet and
   numbered lists, and simple pipe tables — built as React elements, never
   as HTML, so there is no dangerouslySetInnerHTML anywhere near a message
   that came from a model. The user's own messages never go through this:
   they stay plain text, pre-wrap, exactly what was typed.
   -------------------------------------------------------------------------- */
const MD_INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/;

/** Bold, italic and inline code within one line of already-block-split text. */
function mdInline(text, keyBase) {
  const nodes = [];
  let rest = text;
  let i = 0;
  while (rest) {
    const m = MD_INLINE.exec(rest);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const token = m[0];
    if (token[0] === '`') nodes.push(<code key={`${keyBase}i${i++}`} className="h-md-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={`${keyBase}i${i++}`}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={`${keyBase}i${i++}`}>{token.slice(1, -1)}</em>);
    rest = rest.slice(m.index + token.length);
  }
  return nodes;
}

const mdSplitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const mdIsTableRule = (line) => {
  const cells = mdSplitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
};

function MdTable({ lines, mkey }) {
  const header = mdSplitRow(lines[0]);
  const rows = lines.slice(2).map(mdSplitRow);
  return (
    <div className="h-md-tablewrap" key={mkey}>
      <table className="h-md-table">
        <thead><tr>{header.map((c, i) => <th key={i}>{mdInline(c, `${mkey}h${i}`)}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{mdInline(c, `${mkey}r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const isFence = (l) => /^\s*```/.test(l);
const isBullet = (l) => /^\s*[-*+]\s+/.test(l);
const isNumbered = (l) => /^\s*\d+[.)]\s+/.test(l);

/** Text -> an array of block-level React nodes. */
function renderMarkdownLite(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // the closing fence, if the stream ever finishes it
      blocks.push(<pre className="h-md-pre" key={`b${key++}`}><code>{body.join('\n')}</code></pre>);
      continue;
    }

    if (line.includes('|') && lines[i + 1] !== undefined && mdIsTableRule(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { tableLines.push(lines[i]); i += 1; }
      blocks.push(<MdTable lines={tableLines} mkey={`b${key++}`} />);
      continue;
    }

    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i += 1; }
      blocks.push(<ul className="h-md-list" key={`b${key++}`}>{items.map((it, idx) => <li key={idx}>{mdInline(it, `b${key}i${idx}`)}</li>)}</ul>);
      continue;
    }

    if (isNumbered(line)) {
      const items = [];
      while (i < lines.length && isNumbered(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i += 1; }
      blocks.push(<ol className="h-md-list" key={`b${key++}`}>{items.map((it, idx) => <li key={idx}>{mdInline(it, `b${key}o${idx}`)}</li>)}</ol>);
      continue;
    }

    if (!line.trim()) { i += 1; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isBullet(lines[i]) && !isNumbered(lines[i])
      && !(lines[i].includes('|') && lines[i + 1] !== undefined && mdIsTableRule(lines[i + 1]))) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p className="h-md-p" key={`b${key++}`}>
        {para.map((l, idx) => <span key={idx}>{idx > 0 && <br />}{mdInline(l, `b${key}p${idx}`)}</span>)}
      </p>,
    );
  }
  return blocks;
}

/* --------------------------------------------------------------------------
   Attachments — chips inside the composer, and read-only in the thread.

   The same two small components draw both: with `onRemove` they are the
   composer's own queue, with `onOpenImage` they are what a sent message
   shows. Never both at once — a message already sent cannot be edited.
   -------------------------------------------------------------------------- */
function AttachmentImage({ att, onRemove, onOpenImage }) {
  const openable = Boolean(onOpenImage);
  return (
    <span className="h-att h-att--image">
      <img
        className="h-att__thumb"
        src={att.thumb}
        alt={att.name}
        title={att.name}
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        onClick={openable ? () => onOpenImage(att) : undefined}
        onKeyDown={openable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenImage(att); } } : undefined}
      />
      {onRemove && (
        <button type="button" className="h-att__x" aria-label={`Remove ${att.name}`} onClick={() => onRemove(att.id)}>
          <Icon name="x" size={9} />
        </button>
      )}
    </span>
  );
}

function AttachmentText({ att, onRemove }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const chip = useRef(null);
  const popover = useRef(null);
  // The composer's own copy counts lines; the thread's (toDisplayAttachment) does not.
  const lines = att.lines ?? null;
  const sub = lines != null ? `${lines} line${lines === 1 ? '' : 's'}` : formatBytes(att.size) || 'text';

  // The chip can sit inside the composer's beam, which clips anything that
  // pokes out of its own rounded box — a popover positioned the ordinary
  // way (absolute, inside the chip) would be sliced off at that edge. So
  // this one is measured against the chip and portalled to the document
  // body instead, the same reasoning as the picture's Lightbox above.
  useLayoutEffect(() => {
    if (!open) return;
    const r = chip.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 258)), bottom: window.innerHeight - r.top + 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrap.current?.contains(e.target) || popover.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <span className={`h-att h-att--text${open ? ' is-open' : ''}`} ref={wrap}>
      <button type="button" className="h-att__chip" ref={chip} onClick={() => setOpen((v) => !v)} title={att.name}>
        <Icon name="file" size={13} />
        <span className="h-att__name">{att.name}</span>
        <span className="h-att__sub">{sub}</span>
      </button>
      {onRemove && (
        <button type="button" className="h-att__x" aria-label={`Remove ${att.name}`} onClick={() => onRemove(att.id)}>
          <Icon name="x" size={9} />
        </button>
      )}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          className="h-att__preview"
          style={{ position: 'fixed', left: pos.left, bottom: pos.bottom }}
          ref={popover}
          role="dialog"
          aria-label={`Preview of ${att.name}`}
        >
          <pre>{att.preview || att.text || ''}</pre>
        </div>,
        document.body,
      )}
    </span>
  );
}

function AttachmentRow({ items, onRemove, onOpenImage, className = '' }) {
  if (!items?.length) return null;
  return (
    <div className={`h-atts ${className}`}>
      {items.map((att) => (att.kind === 'image'
        ? <AttachmentImage key={att.id} att={att} onRemove={onRemove} onOpenImage={onOpenImage} />
        : <AttachmentText key={att.id} att={att} onRemove={onRemove} />))}
    </div>
  );
}

/** The one place a picture gets shown at size. Portalled to the document
    body so it sits above everything regardless of which effect wrapper
    (Beam, MetalFx) the thread happens to be nested inside. */
function Lightbox({ att, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!att || typeof document === 'undefined') return null;
  return createPortal(
    <div className="h-lightbox" role="dialog" aria-modal="true" aria-label={att.name} onClick={onClose}>
      <img className="h-lightbox__img" src={att.thumb} alt={att.name} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="h-lightbox__x" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------------------
   The thread
   -------------------------------------------------------------------------- */
const CLAMP_LINES = 12;
const CLAMP_CHARS = 900;

/** A long typed message, cut to a readable first screenful. Cut by lines
    first and then by characters, so one 900-character line does not slip
    through just because it never breaks. */
function clampUserText(text) {
  if (!text) return { clamped: false, shown: text };
  const lines = text.split('\n');
  const byLines = lines.length > CLAMP_LINES ? lines.slice(0, CLAMP_LINES).join('\n') : text;
  const shown = byLines.length > CLAMP_CHARS ? byLines.slice(0, CLAMP_CHARS) : byLines;
  return { clamped: shown.length < text.length, shown };
}

const Message = memo(function Message({ id, from, text, done, memoryId, remembered, attachments, onOpenImage }) {
  const [expanded, setExpanded] = useState(false);
  const { clamped, shown } = useMemo(() => clampUserText(text), [text]);
  const md = useMemo(() => (from === 'pico' ? renderMarkdownLite(text) : null), [from, text]);

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
  if (from === 'pico' && !text && !done && !attachments?.length) {
    return (
      <div className="h-msg h-msg--pico h-msg--waiting" data-id={id}>
        <Orb state="breathing" px={20} />
        <span className="h-shimmer">Thinking</span>
      </div>
    );
  }
  if (from === 'you') {
    return (
      <div className="h-msg h-msg--you" data-id={id}>
        {text && (
          <div className={`h-msg__text${clamped && !expanded ? ' is-clamped' : ''}`}>
            {expanded || !clamped ? text : shown}
          </div>
        )}
        {clamped && (
          <button type="button" className="h-msg__more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <AttachmentRow items={attachments} onOpenImage={onOpenImage} className="h-msg__atts" />
      </div>
    );
  }
  return (
    <div className={`h-msg h-msg--${from}${done ? '' : ' is-streaming'}`} data-id={id}>
      {text && <div className="h-msg__md">{md}</div>}
      <AttachmentRow items={attachments} onOpenImage={onOpenImage} className="h-msg__atts" />
      {from === 'pico' && done && text && <button type="button" className="h-link" onClick={() => speak(text)} aria-label="Listen to this reply"> Listen</button>}
    </div>
  );
});

export function Thread({ className = '', stickToBottom = true }) {
  const messages = useStore(sel.messages);
  const memory = useStore(sel.memory);
  const kept = useMemo(() => new Set(memory.map((f) => f.id)), [memory]);
  const ref = useRef(null);
  const pinned = useRef(true);
  const lastId = useRef(null);
  const prevMessages = useRef(messages);
  const [showJump, setShowJump] = useState(false);
  const [lightboxAtt, setLightboxAtt] = useState(null);

  // Follow the conversation down, unless the person has scrolled up to read.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (pinned.current) setShowJump(false);
  };

  const jump = () => {
    pinned.current = true;
    setShowJump(false);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    const changed = prevMessages.current !== messages;
    const last = messages[messages.length - 1];
    // Sending is never a moment to leave someone scrolled up looking at an
    // old part of the conversation — the thing they just did belongs on
    // screen, whatever they were reading before.
    if (changed && last && last.id !== lastId.current && last.from === 'you') pinned.current = true;
    lastId.current = last ? last.id : null;
    prevMessages.current = messages;
    if (!el || !messages.length) return;
    if (stickToBottom && pinned.current) {
      el.scrollTop = el.scrollHeight;
      if (changed) setShowJump(false);
    } else if (changed) {
      setShowJump(true);
    }
  });

  if (!messages.length) return null;
  return (
    <div className={`h-thread ${className}`} ref={ref} onScroll={onScroll}>
      {messages.map((m) => (
        <Message key={m.id} id={m.id} from={m.from} text={m.text} done={m.done}
          memoryId={m.memoryId} remembered={m.memoryId ? kept.has(m.memoryId) : false}
          attachments={m.attachments} onOpenImage={setLightboxAtt} />
      ))}
      {showJump && (
        <button type="button" className="h-thread__jump" onClick={jump}>
          Jump to latest <Icon name="chevron" size={12} className="h-thread__jump-icon" />
        </button>
      )}
      <Lightbox att={lightboxAtt} onClose={() => setLightboxAtt(null)} />
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
    <Beam size="pulse-inner" color={look.color} className="h-decision-beam">
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
  if (!plan?.steps?.length) return null;
  const running = !plan.finished && isActive(phase);
  const steps = plan.steps.map((s, i) => ({ ...s, i }));
  // Long plans show the neighbourhood of the current step, not the whole list.
  const from = Math.max(0, Math.min(plan.index - 2, steps.length - limit));
  const visible = steps.slice(from, from + limit);

  return (
    <ol className={`h-steps${dense ? ' is-dense' : ''}${plan.revision !== undefined && steps.length > 1 ? ' is-timeline' : ''}`} aria-label="Plan">
      {from > 0 && <li className="h-steps__more">{from} earlier step{from === 1 ? '' : 's'}</li>}
      {visible.map((s) => {
        const current = running && s.i === plan.index;
        const status = current ? 'current' : s.status;
        return (
          <li key={s.id ?? `${s.i}:${s.do}`} className="h-step" data-status={status}>
            <span className="h-step__mark">
              {current ? <Orb state={orbStateFor({ phase }) ?? 'working'} px={20} paused={phase === 'Paused'} />
                : status === 'done' ? <Icon name="check" size={12} />
                : status === 'skipped' ? <Icon name="skip" size={11} />
                : status === 'failed' || status === 'changed' ? <Icon name="x" size={11} />
                : <i />}
            </span>
            <span className="h-step__text">
              <span className="h-step__do">{s.do}</span>
              {/* The current milestone says what Halo is doing right now; the
                  others stay one line each, so the timeline reads at a glance. */}
              {current && plan.live && <span className="h-step__why h-step__live">{plan.live}</span>}
              {current && !plan.live && s.doneWhen && <span className="h-step__why">Done when: {s.doneWhen}</span>}
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

export function ActivityLog() {
  const plan = useStore(sel.plan);
  if (!plan?.activity?.length) return null;
  return <details className="h-activity"><summary>Activity · {plan.activity.length} recent actions</summary>
    <ol>{plan.activity.map((item, index) => <li key={`${item.id}:${index}`}>{item.text}</li>)}</ol>
  </details>;
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
      <button type="button" className="h-stop-button" title="Stop task and voice · Esc" onClick={stopEverything}>
        <Icon name="stop" size={size - 3} /> Stop
      </button>
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

/* --------------------------------------------------------------------------
   The voice bar's parts, after HeyClicky: a glowing round mic, a waveform,
   a line of hint, and the chord drawn as keycaps.
   -------------------------------------------------------------------------- */

/** The bars at rest: a still voice, loud on the left and fading out. */
const WAVE_AT_REST = [0.3, 0.55, 0.8, 0.45, 1, 0.6, 0.85, 0.4, 0.7, 0.3, 0.2, 0.28, 0.16, 0.22, 0.12, 0.18];

/** Recent microphone levels as bars, newest on the right. */
export function Waveform({ level = 0, phase = 'idle' }) {
  const live = phase === 'recording';
  const [history, setHistory] = useState(() => WAVE_AT_REST.map(() => 0));
  useEffect(() => {
    if (live) setHistory((h) => [...h.slice(1), Math.max(0, Math.min(1, level))]);
  }, [level, live]);
  const values = live ? history : WAVE_AT_REST;
  return (
    <span className="h-wave" data-phase={phase} aria-hidden="true">
      {values.map((v, i) => (
        <i key={i}
          data-on={live ? (v > 0.06 ? 'true' : 'false') : (i < 10 ? 'true' : 'false')}
          style={{ height: `${Math.round(5 + (v * 21))}px`, animationDelay: `${(i * 83) % 600}ms` }} />
      ))}
    </span>
  );
}

/** The mic: starts voice, shows what voice is doing, and ends it again. */
export function VoiceOrb({ phase = 'idle', level = 0, active = false, onClick }) {
  const label = active ? 'End voice' : 'Talk to Halo';
  return (
    <button type="button" className="h-orb" data-phase={active ? phase : 'idle'} aria-label={label} title={label}
      style={{ '--level': active && phase === 'recording' ? Math.max(0, Math.min(1, level)) : 0 }}
      onClick={onClick}>
      <Icon name="mic" size={20} />
    </button>
  );
}

export function Keycaps({ keys = [] }) {
  return (
    <span className="h-keycaps" aria-hidden="true">
      {keys.map((k) => <kbd key={k}>{k.length > 1 ? k.toLowerCase() : k}</kbd>)}
    </span>
  );
}

/* `taskStopShown`: the run's own controls, with their Stop, are on screen
   beside this box, so its Stop is only for voice — two Stop buttons one
   above the other was what the open island showed while a task ran. */
export function Composer({ petName = 'Halo', autoFocus = false, inputRef = null, big = false, acceptShortcut = false, taskStopShown = false }) {
  const [micState, setMicState] = useState({ phase: 'idle', message: '' });
  const voice = useStore(sel.voice);
  const conversationOn = voice.active;
  const conversation = useRef(false);
  const voiceBusy = useRef(false);
  const resumeTimer = useRef(null);
  const oneShot = useRef(false);           // push-to-talk: one utterance, then done
  const spokeOnce = useRef(null);          // the reply preference to restore after it
  const repliesBefore = useRef(false);
  const [focused, setFocused] = useState(false);
  const transcriptHandler = useRef(null);
  const microphone = useMemo(() => createMicrophone({
    onState: state => {
      setMicState(state);
      if (conversation.current) updateVoice({ phase: state.phase, message: state.message });
    },
    onLevel: level => { if (conversation.current) updateVoice({ level }); },
    onTranscript: value => transcriptHandler.current?.(value),
    stopPlayback: stopVoice,
  }), []);
  const resumeListening = () => {
    clearTimeout(resumeTimer.current);
    if (!conversation.current || voiceBusy.current) return;
    resumeTimer.current = setTimeout(() => {
      if (conversation.current && !voiceBusy.current) microphone.start();
    }, 450);
  };
  useEffect(() => {
    const off = bridge.onSend(command => {
      if (['newChat', 'openChat', 'stop'].includes(command)) {
        conversation.current = false;
        clearTimeout(resumeTimer.current);
        microphone.cancel();
        if (store.state.voice.active) endVoice();
      } else if (['submitTask', 'steer'].includes(command)) {
        microphone.cancel();
        resumeListening();
      }
    });
    const unload = () => {
      conversation.current = false;
      clearTimeout(resumeTimer.current);
      microphone.cancel();
      if (store.state.voice.owner === voiceOwner) endVoice();
    };
    window.addEventListener('pagehide', unload);
    return () => { off(); window.removeEventListener('pagehide', unload); unload(); };
  }, [microphone]);
  useEffect(() => onVoiceSession(event => {
    if (event.type !== 'claim' && event.type !== 'stop') return;
    conversation.current = false;
    clearTimeout(resumeTimer.current);
    microphone.cancel();
    voiceBusy.current = false;
    setVoiceEnabled(false);
    setVoiceOn(false);
  }), [microphone]);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('');
  useEffect(() => {
    const update = (event) => {
      const value = event.detail;
      setVoiceStatus(value);
      const busy = value === 'Preparing voice…' || value === 'Speaking';
      if (busy) {
        voiceBusy.current = true; microphone.cancel();
        if (conversation.current) updateVoice({ phase: 'speaking', message: value, level: 0 });
      }
      else if (voiceBusy.current) {
        voiceBusy.current = false;
        if (spokeOnce.current !== null) {
          const before = spokeOnce.current;
          spokeOnce.current = null;
          setVoiceEnabled(before);
          setVoiceOn(before);
        } else resumeListening();
      }
    };
    window.addEventListener('halo:voice-status', update);
    return () => window.removeEventListener('halo:voice-status', update);
  }, [microphone]);
  const phase = useStore(sel.phase);
  const plan = useStore(sel.plan);
  const mode = useStore(sel.mode);
  const guardian = useStore(sel.guardian);
  const [text, setText] = useState('');
  const own = useRef(null);
  const ref = inputRef ?? own;
  const composing = useRef(false);   // an IME candidate is open — Enter confirms it, never sends

  const steering = isActive(phase) && Boolean(plan && !plan.finished);
  const blocked = isActive(phase) && !steering;

  /* --------------------------------------------------------------------
     Attachments — files queued in the browser, waiting to go up with the
     next message. Never touched while steering: a correction mid-run is
     text only, so the paperclip and the chip row both disappear then.
     -------------------------------------------------------------------- */
  const [attachments, setAttachments] = useState([]);
  const [attachNote, setAttachNote] = useState('');
  const attachNoteTimer = useRef(null);
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const showAttachNote = (message) => {
    setAttachNote(message);
    clearTimeout(attachNoteTimer.current);
    attachNoteTimer.current = setTimeout(() => setAttachNote(''), 5000);
  };
  useEffect(() => () => clearTimeout(attachNoteTimer.current), []);

  // A ref, not the function itself, because the window listener below is
  // registered once — the same pattern transcriptHandler uses above — so it
  // always calls whatever this render's version closes over.
  const handleFilesRef = useRef(null);
  handleFilesRef.current = async (fileList) => {
    if (steering) return;
    const incoming = Array.from(fileList || []).filter(Boolean);
    if (!incoming.length) return;
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const take = incoming.slice(0, room);
    const notes = [];
    if (incoming.length > take.length) {
      notes.push(`Halo carries up to ${MAX_ATTACHMENTS} attachments at a time — the rest were left out.`);
    }
    let budget = attachments.reduce((sum, a) => sum + estimateAttachmentBytes(a), 0);
    const added = [];
    for (const file of take) {
      let result;
      try { result = await attachmentFromFile(file); } catch { result = { ok: false, note: `Halo couldn't read ${file.name}.` }; }
      if (!result.ok) { notes.push(result.note); continue; }
      const size = estimateAttachmentBytes(result.attachment);
      if (budget + size > MAX_PAYLOAD_BYTES) { notes.push('That would make the message too large to send.'); continue; }
      budget += size;
      added.push(result.attachment);
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
    if (notes.length) showAttachNote(notes.join(' '));
  };
  // The app window also accepts a drop anywhere on the chat view, not just
  // on the pill — see the ChatView drop target in app.jsx, which only ever
  // dispatches this one event rather than reaching into composer state.
  useEffect(() => {
    const onExternalFiles = (e) => { handleFilesRef.current?.(e.detail); };
    window.addEventListener('halo:attach-files', onExternalFiles);
    return () => window.removeEventListener('halo:attach-files', onExternalFiles);
  }, []);

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const onPaste = (e) => {
    if (steering) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []);
    if (files.length) {
      e.preventDefault();
      handleFilesRef.current?.(files);
      return;
    }
    const pasted = cd.getData('text/plain');
    if (!pasted || !shouldAttachPaste(pasted)) return; // a normal-sized paste: let the textarea take it, newlines and all
    e.preventDefault();
    if (attachments.length >= MAX_ATTACHMENTS) {
      showAttachNote(`Halo carries up to ${MAX_ATTACHMENTS} attachments at a time.`);
      return;
    }
    setAttachments((prev) => [...prev, buildPastedTextAttachment(pasted)]);
  };

  const onComposerDragOver = (e) => {
    if (steering || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onComposerDragLeave = () => setDragOver(false);
  const onComposerDrop = (e) => {
    if (steering || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragOver(false);
    handleFilesRef.current?.(e.dataTransfer.files);
  };

  const hasText = Boolean(text.trim());
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;
  const canSend = guardian.ready && !blocked && (steering ? hasText : hasContent);

  useEffect(() => {
    if (['Stopped', 'Failed'].includes(phase) && conversation.current) {
      conversation.current = false;
      clearTimeout(resumeTimer.current);
      microphone.cancel();
      endVoice();
    }
  }, [phase, microphone]);

  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus, ref]);

  // One line at rest, growing with what is typed, scrolling past the cap
  // rather than pushing the rest of the window around.
  const maxTextareaHeight = big ? 220 : 150;
  /* Measured again whenever its width changes, not only when the text does:
     the island hides the composer while it is small, a hidden box measures
     0px tall, and that 0 stayed put when it was shown again — or a box laid
     out at one width kept a height worked out at another. A hidden box is
     left alone rather than measured as nothing. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      if (!el.clientWidth) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxTextareaHeight)}px`;
    };
    fit();
    if (typeof ResizeObserver !== 'function') return undefined;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, maxTextareaHeight, ref]);

  const submit = (value) => {
    const t = (typeof value === 'string' ? value : text).trim();
    const queued = attachments;
    if ((!t && !queued.length) || !guardian.ready || blocked) return;
    if (steering) {
      if (!t) return; // attachments do not steer a run — see the brief
      bridge.send('steer', { text: t });
    } else {
      const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // A finished plan belongs to the task before; the conversation has moved on.
      if (store.state.plan?.finished) store.setPlan(null);
      store.addMessage({ id, from: 'you', text: t, done: true, attachments: queued.map(toDisplayAttachment) });
      if (t) store.addRecent(t);
      bridge.send('submitTask', { text: t, mode, id, ...(queued.length ? { attachments: queued.map(toBridgeAttachment) } : {}) });
    }
    setText('');
    setAttachments([]);
    setAttachNote('');
  };
  transcriptHandler.current = (value) => {
    if (isSpokenStop(value)) { stopEverything(); return; }
    setText(value);
    if (guardian.ready && !blocked) submit(value);
    else if (guardian.ready && isActive(phase)) bridge.send('steer', { text: value });
    else setMicState({ phase: 'idle', message: 'Recorded. You can send this when Halo is ready.' });
    if (oneShot.current) {
      /* Push-to-talk is one thing said. The bar goes back to rest now; the
         reply is still spoken, and afterwards replies go back to how they
         were. */
      oneShot.current = false;
      spokeOnce.current = repliesBefore.current;
      conversation.current = false;
      clearTimeout(resumeTimer.current);
      microphone.cancel();
      releaseVoice();
      return;
    }
    if (conversation.current) updateVoice({ phase: 'thinking', transcript: value, message: `Heard: ${value}` });
    resumeListening();
  };

  const placeholder = steering
    ? `Tell ${petName} something — "no, the other one"…`
    : blocked ? `${petName} is working…`
    : mode === 'chat' ? `Talk to ${petName}…`
    : mode === 'agent' ? `Tell ${petName} what to do…`
    : `Ask ${petName} anything, or give it a job…`;

  const startConversation = () => {
    repliesBefore.current = voiceOn;
    conversation.current = true;
    claimVoice();
    setVoiceEnabled(true);
    setVoiceOn(true);
    microphone.start();
  };
  const endConversation = () => {
    spokeOnce.current = null;
    oneShot.current = false;
    conversation.current = false;
    clearTimeout(resumeTimer.current);
    microphone.cancel();
    voiceBusy.current = false;
    setVoiceEnabled(false);
    setVoiceOn(false);
    endVoice();
  };
  useStoreEvent(['voiceToggle'], () => {
    if (!acceptShortcut) return;
    if (store.state.voice.active) {
      if (store.state.voice.owner === voiceOwner) endConversation();
      else endVoice();
    } else startConversation();
  });
  /* Hold to talk. The chord starts voice on the way down either way; how
     long it was held decides the rest. A tap leaves hands-free voice on,
     sending whenever you stop talking. A hold of a third of a second or more
     is push-to-talk: letting go sends what was said, and the microphone is
     put down again once Halo has answered. */
  useStoreEvent(['voiceRelease'], (s) => {
    if (!acceptShortcut || !conversation.current) return;
    if ((s.voiceHeldMs ?? 0) < 350) return;
    oneShot.current = true;
    microphone.finish();
  });
  const voiceMessage = voice.transcript && voice.phase === 'thinking'
    ? `Heard: ${voice.transcript}`
    : voice.phase === 'recording' ? 'Listening… stop talking to send'
    : voice.message || (voice.phase === 'speaking' ? `${petName} is speaking` : 'Listening…');
  const shortcutOk = useStore((s) => s.voiceShortcut) !== false;
  const talkKeys = keybind('toggleVoice')?.keys ?? [];
  const working = isActive(phase);
  const hint = shortcutOk && talkKeys.length
    ? `${talkKeys.map((k) => (k.length > 1 ? k.toLowerCase() : k)).join(' + ')} or click the mic :)`
    : 'type here, or click the mic :)';

  return (
    <Beam active={steering} size="line" color="ocean" className="h-composer-beam">
      <div
        className={`h-composer h-clicky${big ? ' is-big' : ''}${conversationOn ? ' is-voice' : ''}${dragOver ? ' is-dragover' : ''}`}
        data-steering={steering ? 'true' : 'false'}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {!conversationOn && !steering && attachments.length > 0 && (
          <AttachmentRow items={attachments} onRemove={removeAttachment} className="h-composer__chips" />
        )}
        {!conversationOn && attachNote && <div className="h-composer__note" role="status">{attachNote}</div>}

        <div className="h-composer__row">
          <VoiceOrb phase={voice.phase} level={voice.level} active={conversationOn}
            onClick={() => { if (!conversationOn) startConversation(); else if (voice.owner === voiceOwner) endConversation(); else endVoice(); }} />
          {conversationOn ? <>
            <Waveform level={voice.level} phase={voice.phase} />
            <span className="h-voice__status" role="status">{voiceMessage}</span>
            {voice.phase === 'error' && voice.owner === voiceOwner && <button type="button" className="h-voice__end" onClick={() => microphone.start()}>Retry</button>}
          </> : <>
            {!focused && !text && !hasAttachments && <Waveform phase="idle" />}
            {steering && <span className="h-composer__tag">Steer</span>}
            {!steering && (
              <IconButton icon="paperclip" label="Attach a file" size={16} className="h-composer__attach"
                onMouseDown={(e) => e.preventDefault()} onClick={() => fileInputRef.current?.click()} />
            )}
            {!steering && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.tsv,.json,.log,.xml,.html,.yaml,.yml,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rs,.sql,text/*"
                onChange={(e) => { handleFilesRef.current?.(e.target.files); e.target.value = ''; }}
              />
            )}
            <textarea
              ref={ref}
              className="h-composer__input"
              rows={1}
              value={text}
              disabled={!guardian.ready}
              placeholder={focused || steering || blocked ? placeholder : hint}
              aria-label={steering ? 'Steer the task in hand' : 'Message or task'}
              autoComplete="off"
              spellCheck={false}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => setText(e.target.value)}
              onPaste={onPaste}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent?.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {!steering && (focused || hasContent) && (
              <button type="button" className="h-composer__mode" data-mode={mode} title={MODE_HINT[mode]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { store.setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]); ref.current?.focus(); }}>
                {MODE_LABEL[mode]}
              </button>
            )}
            {(focused || hasContent) && (
              <button type="button" className="h-clicky__speak" aria-pressed={voiceOn} title={voiceOn ? 'Replies are read aloud' : 'Read replies aloud'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setVoiceEnabled(!voiceOn); setVoiceOn(!voiceOn); }}>
                <Icon name="volume" size={15} />
              </button>
            )}
            {hasContent
              ? (
                <MetalButton circle aria-label={steering ? 'Send to the task' : 'Send'} disabled={!canSend} onClick={submit} className="h-send">
                  <Icon name="send" size={big ? 17 : 15} />
                </MetalButton>
              )
              : !working && shortcutOk && talkKeys.length > 0 && <Keycaps keys={talkKeys} />}
          </>}
          {(conversationOn || voiceStatus || (working && !taskStopShown)) && (
            <button type="button" className="h-stop-button h-clicky__stop" title="Stop everything · Esc" onClick={stopEverything}>
              <Icon name="stop" size={11} /> Stop
            </button>
          )}
        </div>
      </div>
      {!conversationOn && micState.phase === 'error' && micState.message && <small className="h-clicky__note" role="status">{micState.message}</small>}
    </Beam>
  );
}
