/* ==========================================================================
   Halo — UI state store
   Mirrors the C# AgentPhase / OverlayPhase state machine. All user-facing
   copy below is the app's own wording, recovered from Halo.exe, so the
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

const RECENTS_KEY = 'halo.recents.v1';
const MAX_RECENTS = 8;

/**
 * Move a value stored under Pico's name to Halo's, once. Kept here because
 * every page loads the store, so the first page to open after the rename
 * does it for all of them.
 */
export function migrateKey(from, to) {
  try {
    if (localStorage.getItem(to) === null && localStorage.getItem(from) !== null) {
      localStorage.setItem(to, localStorage.getItem(from));
    }
    localStorage.removeItem(from);
  } catch { /* storage blocked: nothing to carry, nothing lost */ }
}
migrateKey('pico.recents.v1', RECENTS_KEY);

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
  step: null,              // { index, total, text } — the plan step being worked on
  approval: null,          // { id, summary, target, risk }
  takeover: null,          // { id, reason, appName }
  error: null,             // { title, message, recoverable }
  summary: null,           // closing sentence, written after a run completes

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

  // The conversation lives here rather than inside a view, so what you type
  // in the notch is the same thread you see in the app window.
  messages: [],            // { id, from: 'you'|'pico'|'event', text, done }
  routed: null,            // { mode, why, source } — which fork the last message took
  question: null,          // { id, text } — asked before starting, answered in the composer
  mode: 'auto',            // what the composer is set to: auto | chat | agent

  // The plan of the run in hand, as it changes: { steps: [{ do, kind, status }],
  // index, doneWhen, finished?, succeeded? }. Kept after the run so the last
  // one can still be read, and cleared when the next begins.
  plan: null,
  // The last finished task, for "save as shortcut": { task, steps, succeeded }.
  lastRun: null,

  memory: [],              // [{ id, text, source, created }] — what Halo keeps
  routines: [],            // [{ id, name, task, steps, runs, lastRun }] — saved shortcuts
  chats: { list: [], current: null, loaded: false },   // every conversation, newest first
  chatSearch: null,        // { q, results } — the last search this window asked for

  // Where the real pointer is while Halo drives it. Drawn rather than
  // guessed: Windows has one system cursor and this is its live position.
  cursor: { x: 0, y: 0, visible: false },
  notchOpen: false,
  notchHover: false,

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
    if (phase === 'Starting') { this.state.summary = null; this.state.lastRun = null; }
    this.emit({ type: 'phase', phase, previous, ...meta });
  }

  /** Which step of the plan Halo is on, so the island can say so. */
  setStep(step) {
    this.state.step = step && step.text ? step : null;
    this.emit({ type: 'step', step: this.state.step });
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

  /** The closing line of a run. Filed under the bridge's id, so a window
      that reconnects does not show it twice. */
  setSummary(text, id) {
    this.state.summary = text || null;
    if (text) {
      if (id && this.state.messages.some((m) => m.id === id)) this.setMessage({ id, from: 'pico', text, done: true });
      else this.addMessage({ id, from: 'pico', text, done: true });
    }
    this.emit({ type: 'summary', summary: this.state.summary });
  }

  // --- the run in hand -----------------------------------------------------
  setPlan(plan) {
    this.state.plan = plan && Array.isArray(plan.steps) ? plan : null;
    this.emit({ type: 'plan', plan: this.state.plan });
  }

  setLastRun(run) {
    this.state.lastRun = run && run.task ? run : null;
    this.emit({ type: 'lastRun', lastRun: this.state.lastRun });
  }

  // --- what Halo keeps -----------------------------------------------------
  setMemory(facts) {
    this.state.memory = Array.isArray(facts) ? facts : [];
    this.emit({ type: 'memory', memory: this.state.memory });
  }

  setRoutines(items) {
    this.state.routines = Array.isArray(items) ? items : [];
    this.emit({ type: 'routines', routines: this.state.routines });
  }

  setChats({ list, current }) {
    this.state.chats = { list: Array.isArray(list) ? list : [], current: current ?? null, loaded: true };
    this.emit({ type: 'chats', chats: this.state.chats });
  }

  setChatSearch(result) {
    this.state.chatSearch = result;
    this.emit({ type: 'chatSearch', chatSearch: result });
  }

  // --- conversation --------------------------------------------------------
  /** Append a finished message. Returns it, so the caller can keep the id. */
  addMessage({ id, from, text, done = true, memoryId }) {
    const entry = { id: id ?? `m_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, from, text, done };
    if (memoryId) entry.memoryId = memoryId;
    this.state.messages = [...this.state.messages, entry].slice(-120);
    this.emit({ type: 'message', message: entry });
    return entry;
  }

  /**
   * A streaming reply from the host. The same id arrives many times with a
   * longer `text` each time, so this replaces in place rather than appending
   * — otherwise one sentence becomes forty bubbles.
   */
  setMessage({ id, from = 'pico', text, done, memoryId, remove }) {
    const list = this.state.messages;
    const i = list.findIndex((m) => m.id === id);
    // A reply that turned out to be a job handed to the desktop loop: the
    // placeholder it streamed into goes, rather than staying as an empty bubble.
    if (remove) {
      if (i === -1) return;
      this.state.messages = list.filter((m) => m.id !== id);
      this.emit({ type: 'message', restored: true });
      return;
    }
    if (i === -1) {
      this.addMessage({ id, from, text, done: Boolean(done), memoryId });
      return;
    }
    const next = [...list];
    next[i] = { ...next[i], text, done: Boolean(done) };
    this.state.messages = next;
    this.emit({ type: 'message', message: next[i], streaming: !done });
  }

  clearMessages() {
    this.state.messages = [];
    this.emit({ type: 'message', cleared: true });
  }

  /**
   * Adopt a whole thread at once — a chat reopened from this machine's own
   * history, replacing whatever was on screen.
   *
   * Marked `restored` so the thing that saves chats can tell this apart from
   * a message arriving. Without that, loading a chat immediately saves it
   * back over itself, which is harmless right up until you load an old chat
   * and it takes the current one's place in the list.
   */
  loadMessages(list) {
    this.state.messages = (Array.isArray(list) ? list : []).slice(-120);
    this.emit({ type: 'message', restored: true });
  }

  /** Halo needs one detail before it starts. The next thing you type answers it. */
  setQuestion(question) {
    this.state.question = question && question.text ? question : null;
    this.emit({ type: 'question', question: this.state.question });
  }

  setRouted(routed) {
    this.state.routed = routed;
    this.emit({ type: 'routed', routed });
  }

  /** What the composer is set to. Not sent anywhere until you submit. */
  setMode(mode) {
    if (!['auto', 'chat', 'agent'].includes(mode)) return;
    this.state.mode = mode;
    this.emit({ type: 'mode', mode });
  }

  setCursor({ x, y, done }) {
    this.state.cursor = { x, y, visible: true };
    this.emit({ type: 'cursor', cursor: this.state.cursor, done: Boolean(done) });
  }

  hideCursor() {
    this.state.cursor = { ...this.state.cursor, visible: false };
    this.emit({ type: 'cursor', cursor: this.state.cursor });
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

  /** A run is going, so what is typed steers it rather than starting another. */
  get canSteer() {
    const plan = this.state.plan;
    return isActive(this.state.phase) && Boolean(plan && !plan.finished);
  }

  /** Why submission is blocked, in the app's own words. */
  get submitBlockedReason() {
    if (!this.state.guardian.ready) return 'Safety guardian offline — restart Halo before running a task.';
    if (isActive(this.state.phase)) return 'Halo is already working on a task.';
    return null;
  }
}

export const store = new Store();
