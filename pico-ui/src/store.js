/* ==========================================================================
   Pico — UI state store
   Mirrors the C# AgentPhase / OverlayPhase state machine. All user-facing
   copy below is the app's own wording, recovered from Pico.exe, so the
   redesign does not silently change any safety-critical language.
   ========================================================================== */

export const PHASES = [
  'Idle', 'Starting', 'Observing', 'Thinking', 'Acting', 'Paused',
  'AwaitingApproval', 'AwaitingTakeover', 'Completed', 'Stopped', 'Failed',
];

/** Phase -> the strings the real app shows. */
export const PHASE_COPY = {
  Idle:             { title: 'Tell me what to do',            detail: '' },
  Starting:         { title: 'Getting ready',                 detail: 'Checking the desktop before the next action' },
  Observing:        { title: 'Reading the active desktop',    detail: '' },
  Thinking:         { title: 'Planning the next safe step',   detail: '' },
  Acting:           { title: 'Working on your desktop',       detail: '' },
  Paused:           { title: 'Paused',                        detail: 'No actions will run until you resume.' },
  AwaitingApproval: { title: 'Needs your approval',           detail: 'A consequential action needs approval.' },
  AwaitingTakeover: { title: 'Your turn',                     detail: 'Please complete this step manually.' },
  Completed:        { title: 'Task complete.',                detail: '' },
  Stopped:          { title: 'Task stopped.',                 detail: 'Task stopped. Your desktop is yours.' },
  Failed:           { title: 'Something went wrong.',          detail: '' },
};

/** Action type -> the app's own human-readable detail line. */
export const ACTION_COPY = {
  Screenshot: 'Taking a fresh look',
  Click:      'Selecting an on-screen control',
  Drag:       'Moving an on-screen item',
  Move:       'Positioning the pointer',
  Scroll:     'Moving through the current view',
  Keypress:   'Using a keyboard shortcut',
  Type:       'Entering text (content hidden)',
  Wait:       'Waiting for the app to respond',
  Validate:   'Validating the next action',
};

/** Phases in which a run is live, so Esc must stay the emergency stop. */
export const ACTIVE_PHASES = new Set([
  'Starting', 'Observing', 'Thinking', 'Acting', 'Paused',
  'AwaitingApproval', 'AwaitingTakeover',
]);

export const isActive = (phase) => ACTIVE_PHASES.has(phase);

const RECENTS_KEY = 'pico.recents.v1';
const MAX_RECENTS = 8;

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return []; // private window, blocked storage, corrupt value — all non-fatal
  }
}

function saveRecents(list) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* per-viewer convenience only; never required for correctness */
  }
}

const initial = () => ({
  phase: 'Idle',
  task: '',
  action: null,            // { type, detail }
  approval: null,          // { id, summary, target, risk }
  takeover: null,          // { id, reason, appName }
  error: null,             // { title, message, recoverable }

  // The bug this redesign exists to fix: `blockedReason` is what the old UI
  // never surfaced, leaving the user pressing the resume chord in a loop.
  pause: { paused: false, source: null, blockedReason: null, heldModifiers: [] },

  guardian: { ready: false },
  settings: {
    model: 'gpt-5.4-mini',
    pauseOnPhysicalInput: true,
    maximumComputerTurns: 100,
    hasApiKey: false,
  },

  turn: 0,
  timeline: [],
  recents: loadRecents(),
  paletteOpen: false,
  settingsOpen: false,
});

class Store {
  constructor() {
    this.state = initial();
    this._subs = new Set();
  }

  subscribe(fn) {
    this._subs.add(fn);
    fn(this.state, { type: 'init' });
    return () => this._subs.delete(fn);
  }

  emit(meta = {}) {
    for (const fn of this._subs) fn(this.state, meta);
  }

  /** Shallow-merge a patch and notify. `meta.type` lets views react to events. */
  set(patch, meta = {}) {
    Object.assign(this.state, patch);
    this.emit(meta);
  }

  // --- phase ---------------------------------------------------------------
  setPhase(phase, meta = {}) {
    if (!PHASES.includes(phase)) throw new Error(`Unknown phase: ${phase}`);
    const previous = this.state.phase;
    this.state.phase = phase;

    // Leaving a decision state clears its card.
    if (phase !== 'AwaitingApproval') this.state.approval = null;
    if (phase !== 'AwaitingTakeover') this.state.takeover = null;
    if (phase !== 'Paused') {
      this.state.pause = { ...this.state.pause, paused: false, blockedReason: null };
    }
    if (phase === 'Idle') {
      this.state.action = null;
      this.state.turn = 0;
      this.state.error = null;
    }
    this.emit({ type: 'phase', phase, previous, ...meta });
  }

  setAction(action) {
    const detail = action?.detail || ACTION_COPY[action?.type] || '';
    this.state.action = action ? { ...action, detail } : null;
    if (action) this.state.turn += 1;
    this.emit({ type: 'action', action: this.state.action });
  }

  setApproval(approval) {
    this.state.approval = approval;
    this.emit({ type: 'approval', approval });
  }

  setTakeover(takeover) {
    this.state.takeover = takeover;
    this.emit({ type: 'takeover', takeover });
  }

  setError(error) {
    this.state.error = error;
    this.emit({ type: 'error', error });
  }

  setPause(pause) {
    this.state.pause = { ...this.state.pause, ...pause };
    this.emit({ type: 'pause', pause: this.state.pause });
  }

  setGuardian(guardian) {
    this.state.guardian = { ...this.state.guardian, ...guardian };
    this.emit({ type: 'guardian', guardian: this.state.guardian });
  }

  setSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.emit({ type: 'settings', settings: this.state.settings });
  }

  // --- timeline ------------------------------------------------------------
  /**
   * Append an audit event. Mirrors the real audit.jsonl schema:
   *   { timestamp, event_type, phase, action_type?, risk?, metadata? }
   * Screenshots, coordinates and typed text are never carried here — the
   * host redacts them and the UI must never reintroduce them.
   */
  pushEvent(event) {
    const entry = { timestamp: new Date().toISOString(), ...event };
    this.state.timeline = [...this.state.timeline, entry].slice(-200);
    this.emit({ type: 'timeline', entry });
  }

  clearTimeline() {
    this.state.timeline = [];
    this.emit({ type: 'timeline', cleared: true });
  }

  // --- recents (UI-owned: the audit log deliberately redacts task text) ----
  addRecent(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const next = [clean, ...this.state.recents.filter((r) => r !== clean)].slice(0, MAX_RECENTS);
    this.state.recents = next;
    saveRecents(next);
    this.emit({ type: 'recents', recents: next });
  }

  clearRecents() {
    this.state.recents = [];
    saveRecents([]);
    this.emit({ type: 'recents', recents: [] });
  }

  // --- palette -------------------------------------------------------------
  setPaletteOpen(open) {
    if (this.state.paletteOpen === open) return;
    this.state.paletteOpen = open;
    if (!open) this.state.settingsOpen = false;
    this.emit({ type: 'palette', open });
  }

  setSettingsOpen(open) {
    this.state.settingsOpen = open;
    this.emit({ type: 'settingsView', open });
  }

  reset() {
    const recents = this.state.recents;
    this.state = { ...initial(), recents };
    this.emit({ type: 'reset' });
  }

  // --- derived -------------------------------------------------------------
  get canSubmit() {
    return this.state.guardian.ready && !isActive(this.state.phase);
  }

  /** Why submission is blocked, in the app's own words. */
  get submitBlockedReason() {
    if (!this.state.guardian.ready) return 'Safety guardian offline — restart Pico before running a task.';
    if (isActive(this.state.phase)) return 'Pico is already working on a task.';
    return null;
  }
}

export const store = new Store();
