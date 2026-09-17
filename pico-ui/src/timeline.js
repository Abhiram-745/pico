/* ==========================================================================
   Halo — activity timeline

   Renders live audit events using the real audit.jsonl schema:
     { timestamp, event_type, phase, action_type?, risk?, session_id?,
       response_id?, call_id?, metadata? }

   SAFETY: the audit log deliberately excludes screenshots, coordinates,
   typed text, clipboard data and UI text. This view must never reintroduce
   any of them — it renders only the known-safe fields enumerated below.
   ========================================================================== */

const SAFE_METADATA_KEYS = new Set([
  'source', 'model', 'failure_class', 'completed_actions',
]);

const EVENT_COPY = {
  run_started:   { label: 'Run started',    tone: 'info' },
  run_completed: { label: 'Run completed',  tone: 'good' },
  run_stopped:   { label: 'Run stopped',    tone: 'warn' },
  run_failed:    { label: 'Run failed',     tone: 'bad'  },
  stop_requested:{ label: 'Stop requested', tone: 'warn' },
  paused:        { label: 'Paused',         tone: 'warn' },
  resumed:       { label: 'Resumed',        tone: 'info' },
  action_assessed: { label: 'Assessed',     tone: 'muted' },
  action_executed: { label: 'Executed',     tone: 'info' },
  action_deferred_stale_target: { label: 'Deferred — target moved', tone: 'warn' },
};

const SOURCE_COPY = {
  'physical-input': 'you touched the mouse or keyboard',
  'guardian-hotkey': 'guardian hotkey',
  'held-modifier': 'chord still held',
  'overlay': 'the companion',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const time = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '';
  }
};

export function renderTimeline(state) {
  const root = el('div', 'timeline panel-in');

  if (!state.timeline.length) {
    root.append(el('div', 'palette__empty', 'No activity yet. Run a task to see what Halo does, step by step.'));
    return root;
  }

  const list = el('div', 'timeline__list');

  // newest first reads better in a short panel
  for (const ev of [...state.timeline].reverse()) {
    const copy = EVENT_COPY[ev.event_type] || { label: ev.event_type, tone: 'muted' };
    const row = el('div', 'timeline__row');
    row.dataset.tone = copy.tone;

    row.append(el('span', 'timeline__time', time(ev.timestamp)));

    const rail = el('span', 'timeline__rail');
    rail.append(el('span', 'timeline__node'));
    row.append(rail);

    const main = el('span', 'timeline__main');

    const head = el('span', 'timeline__head');
    head.append(el('span', 'timeline__label', copy.label));
    if (ev.action_type) head.append(el('span', 'timeline__action', ev.action_type));
    main.append(head);

    const bits = [];

    const source = ev.metadata?.source;
    if (source) bits.push(SOURCE_COPY[source] || source);

    if (ev.metadata?.failure_class) bits.push(ev.metadata.failure_class.replace(/_/g, ' '));
    if (ev.metadata?.completed_actions != null) bits.push(`${ev.metadata.completed_actions} actions`);
    if (ev.metadata?.model) bits.push(ev.metadata.model);

    if (ev.risk && ev.risk.decision && ev.risk.decision !== 'Allow') {
      bits.push(`${ev.risk.decision} · ${ev.risk.level}`);
    }

    if (bits.length) main.append(el('span', 'timeline__meta', bits.join(' · ')));

    // Only surface the policy reason when it actually stopped something —
    // the "Allow" reason is identical on every event and is pure noise.
    if (ev.risk?.reason && ev.risk.decision !== 'Allow') {
      main.append(el('span', 'timeline__reason', ev.risk.reason));
    }

    row.append(main);
    list.append(row);
  }

  root.append(list);

  const note = el('div', 'timeline__note',
    'Screenshots, coordinates and typed text are never recorded.');
  root.append(note);

  return root;
}

/** Guard used by tests: no unexpected metadata key ever reaches the DOM. */
export function assertSafeEvent(ev) {
  for (const k of Object.keys(ev.metadata || {})) {
    if (!SAFE_METADATA_KEYS.has(k)) {
      throw new Error(`Unsafe metadata key in timeline: ${k}`);
    }
  }
  return true;
}
