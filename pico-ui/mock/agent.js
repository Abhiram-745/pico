/* ==========================================================================
   Halo — mock host

   Stands in for the C# side so the UI is fully exercisable in a browser.
   It speaks exactly the contract in src/bridge.js and nothing more, which is
   what keeps the UI honest: if it works here, it works against WebView2.

   Scenario timings and event shapes are taken from the real
   AppData\Local\Halo\audit.jsonl (106 events across 9 sessions).
   ========================================================================== */

import { localRoute } from '../../bridge/intent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionCounter = 0;
const newSessionId = () => `mock${(++sessionCounter).toString().padStart(4, '0')}` +
  Math.random().toString(16).slice(2, 10);

const ALLOW_RISK = {
  level: 'None',
  decision: 'Allow',
  categories: 'None',
  reason: 'No protected or high-impact operation was detected.',
};

/** Map a planned step onto the action type whose motion best matches it. */
function inferActionType(step) {
  const t = String(step).toLowerCase();
  // Word boundaries matter: without them "enter" matches "center" and
  // "alt" matches "salt", which mislabels the step.
  if (/\btyp(?:e|ing)\b|\bwrite\b|\binput\b/.test(t)) return 'Type';
  if (/\bpress\b|\bkeys?\b|\bshortcut\b|\bctrl\b|\benter\b/.test(t)) return 'Keypress';
  if (/\bscroll\b/.test(t)) return 'Scroll';
  if (/\bclicks?\b|\bselect\b|\bchoose\b|\bopens?\b|\blaunch\b/.test(t)) return 'Click';
  if (/\bwait\b|\buntil\b/.test(t)) return 'Wait';
  if (/\blook\b|\bcheck\b|\bfind\b|\bverify\b/.test(t)) return 'Screenshot';
  return 'Move';
}

export class MockAgent {
  constructor(transport) {
    this.t = transport;
    this.sessionId = newSessionId();
    this.cancelled = false;
    this.paused = false;
    this.heldModifiers = [];
    this.phase = 'Idle';
    this.petName = 'Halo';
    this.settings = {
      model: 'gpt-4.1-mini',
      pauseOnPhysicalInput: true,
      maximumComputerTurns: 100,
      // Set true only once a provider is actually attached.
      hasApiKey: false,
    };
    transport.onCommand((msg) => this.handle(msg));

    /* Optional. When the bridge has an LLM configured, this turns a task into
       real steps instead of the scripted ones. Left null in the browser, where
       there is no key and must never be one. */
    this.planner = null;
    this.summariser = null;

    // The preview's stand-ins for what the bridge keeps on disk.
    this.previewMemory = [];
    this.previewRoutines = [];
    this.previewSteering = [];
    this.previewLastRun = null;
  }

  // --- plumbing ------------------------------------------------------------
  emit(type, payload) { this.t.emit(type, payload); }

  setPhase(phase) {
    this.phase = phase;
    this.emit('phase', { phase });
  }

  audit(event_type, extra = {}) {
    this.emit('auditEvent', {
      timestamp: new Date().toISOString(),
      event_type,
      phase: this.phase,
      session_id: this.sessionId,
      ...extra,
    });
  }

  /** Resolve once unpaused, so scenarios stall exactly like the real loop. */
  async gate() {
    while (this.paused && !this.cancelled) await sleep(120);
    return !this.cancelled;
  }

  async step(ms) {
    await sleep(ms);
    return this.gate();
  }

  async action(type, { detail, ...extra } = {}) {
    if (!(await this.gate())) return false;
    this.audit('action_assessed', { action_type: type, risk: ALLOW_RISK, ...extra });
    this.emit('action', detail ? { type, detail } : { type });
    await sleep(420);
    if (!(await this.gate())) return false;
    this.audit('action_executed', { action_type: type, risk: ALLOW_RISK, ...extra });
    return true;
  }

  start() {
    this.emit('guardian', { ready: true });
    this.emit('settings', this.settings);
    this.emit('memory', { facts: this.previewMemory });
    this.emit('routines', { items: this.previewRoutines });
    // As the real bridge does once Windows accepts Ctrl+Alt+V.
    this.emit('voiceShortcut', { available: true });
    this.setPhase('Idle');
  }

  // --- commands from the UI ------------------------------------------------
  handle({ command, payload = {} }) {
    switch (command) {
      case 'submitTask':
        this.run(payload.text, { mode: payload.mode, attachments: payload.attachments });
        break;

      case 'setName':
        this.petName = String(payload.name || 'Halo').slice(0, 24);
        break;

      case 'pause':
        this.paused = true;
        this.emit('pauseState', { paused: true, source: 'overlay' });
        this.audit('paused', { metadata: { source: 'overlay' } });
        break;

      case 'resume':
        this.tryResume('overlay');
        break;

      case 'stop':
        this.cancelled = true;
        this.paused = false;
        this.audit('stop_requested', { metadata: { source: 'overlay' } });
        this.setPhase('Stopped');
        this.audit('run_stopped');
        break;

      case 'approve':
        this._approveResolve?.(true);
        break;

      case 'deny':
        this._approveResolve?.(false);
        break;

      case 'takeoverDone':
        this._takeoverResolve?.();
        break;

      // --- while a run is going (the real ones are in bridge/agent.mjs) ----
      case 'skipStep':
        this.previewSteering.push({ type: 'skip' });
        break;

      case 'steer':
        if (String(payload.text ?? '').trim()) {
          this.emit('message', { id: `steer_${Date.now()}`, from: 'you', text: String(payload.text).trim(), done: true });
          this.previewSteering.push({ type: 'correct', text: String(payload.text).trim() });
        }
        break;

      case 'memoryAdd': {
        const text = String(payload.text ?? '').trim();
        if (text) this.previewMemory = [{ id: `mem_${Date.now()}`, text, source: 'added', created: Date.now() }, ...this.previewMemory];
        this.emit('memory', { facts: this.previewMemory });
        break;
      }
      case 'memoryRemove':
        this.previewMemory = this.previewMemory.filter((f) => f.id !== payload.id);
        this.emit('memory', { facts: this.previewMemory });
        break;
      case 'memoryClear':
        this.previewMemory = [];
        this.emit('memory', { facts: this.previewMemory });
        break;

      case 'routineSave': {
        const run = this.previewLastRun;
        const name = String(payload.name ?? '').trim();
        if (!name || !(payload.task || run)) break;
        this.previewRoutines = [
          { id: `sc_${Date.now()}`, name, task: payload.task || run.task, steps: run?.steps ?? [], runs: 0, created: Date.now() },
          ...this.previewRoutines.filter((r) => r.name.toLowerCase() !== name.toLowerCase()),
        ];
        this.emit('routines', { items: this.previewRoutines });
        this.emit('message', { id: `sc_${Date.now()}`, from: 'event', text: `Saved as a shortcut: "${name}". Say its name to run it again.`, done: true });
        break;
      }
      case 'routineRun': {
        const item = this.previewRoutines.find((r) => r.id === payload.id);
        if (item) {
          this.emit('message', { id: `you_${Date.now()}`, from: 'you', text: item.name, done: true });
          this.run(item.task, { mode: 'agent' });
        }
        break;
      }
      case 'routineRename':
        this.previewRoutines = this.previewRoutines.map((r) => (r.id === payload.id ? { ...r, name: String(payload.name ?? r.name) } : r));
        this.emit('routines', { items: this.previewRoutines });
        break;
      case 'routineRemove':
        this.previewRoutines = this.previewRoutines.filter((r) => r.id !== payload.id);
        this.emit('routines', { items: this.previewRoutines });
        break;

      case 'newChat':
        this.cancelled = true;
        this.emit('plan', null);
        break;

      case 'saveSettings':
        // An API key is write-only: the host stores it in Windows Credential
        // Manager and only ever reports whether one exists.
        const { apiKey, ...rest } = payload;
        this.settings = { ...this.settings, ...rest };
        if (apiKey) this.settings.hasApiKey = true;
        this.emit('settings', this.settings);
        break;

      default:
        break;
    }
  }

  /**
   * The behaviour the redesign exists to explain. In the real app, resuming
   * while the chord is still physically held immediately re-paused the run,
   * silently. Here we report *why*.
   */
  tryResume(source) {
    if (this.heldModifiers.length) {
      this.emit('pauseState', {
        paused: true,
        source: 'held-modifier',
        blockedReason: 'modifier-held',
        heldModifiers: [...this.heldModifiers],
      });
      this.audit('paused', { metadata: { source: 'held-modifier' } });
      return;
    }
    this.paused = false;
    this.emit('pauseState', { paused: false, source, blockedReason: null, heldModifiers: [] });
    this.audit('resumed', { metadata: { source } });
    this.setPhase('Acting');
  }

  /** Used by the harness to simulate physical keys going down / coming up. */
  setHeldModifiers(mods) {
    this.heldModifiers = mods;
    if (this.paused && this.heldModifiers.length === 0) {
      this.emit('pauseState', {
        paused: true, source: 'held-modifier', blockedReason: null, heldModifiers: [],
      });
    } else if (this.paused) {
      this.emit('pauseState', {
        paused: true,
        source: 'held-modifier',
        blockedReason: 'modifier-held',
        heldModifiers: [...mods],
      });
    }
  }

  // --- scenarios -----------------------------------------------------------
  async run(text = '', opts = {}) {
    // Cancel anything still in flight first. Without this, submitting a second
    // task leaves the previous scenario's loop running and the two interleave
    // phase changes — which is exactly what a real host must never do either.
    this.cancelled = true;
    this.paused = false;
    await sleep(150);            // longer than the gate() poll interval

    this.cancelled = false;
    this.sessionId = newSessionId();

    // A message with attachments is its own small scenario — see
    // scenarioAttachments — so the preview can show the round trip (thumbs
    // in the thread, a reply that knows they arrived) without pretending an
    // unwired preview can actually look inside a picture or a file.
    const attachments = Array.isArray(opts.attachments) ? opts.attachments.filter(Boolean) : [];
    if (attachments.length) return this.scenarioAttachments(text, attachments);

    // The same fork the real host makes, so the preview demonstrates the
    // behaviour rather than describing it. The rules are shared code; only
    // the model tiebreak is missing here, and it has no key to call it with.
    const decision = localRoute(text) ?? { mode: 'chat', why: 'not clearly an instruction' };
    const mode = opts.mode === 'chat' || opts.mode === 'agent' ? opts.mode : decision.mode;
    this.emit('routed', {
      mode,
      why: opts.mode && opts.mode !== 'auto' ? 'you chose it' : decision.why,
      source: opts.mode && opts.mode !== 'auto' ? 'user' : 'rules',
    });
    const told = String(text).match(/^(?:please\s+)?remember(?:\s+that)?\s+(.{3,})$/i);
    if (told) {
      const fact = { id: `mem_${Date.now()}`, text: told[1].replace(/\bmy\b/gi, 'your'), source: 'told', created: Date.now() };
      this.previewMemory = [fact, ...this.previewMemory];
      this.emit('memory', { facts: this.previewMemory });
      this.emit('message', { id: `mem_note_${fact.id}`, from: 'event', text: `Remembered: ${fact.text}`, memoryId: fact.id, done: true });
      this.emit('message', { id: `msg_${Date.now()}`, from: 'pico', text: 'Got it — I\'ll remember that.', done: true });
      return;
    }
    const saved = this.previewRoutines.find((r) => r.name.toLowerCase() === String(text).trim().toLowerCase());
    if (saved) return this.scenarioPlanned(saved.task);
    if (mode === 'chat') return this.scenarioChat(text);

    const t = text.toLowerCase();
    if (t.includes('email') || t.includes('send') || t.includes('post')) return this.scenarioApproval(text);
    if (t.includes('log in') || t.includes('login') || t.includes('password') || t.includes('sign in')) return this.scenarioTakeover(text);
    if (t.includes('fail') || t.includes('break')) return this.scenarioFailure(text);
    return this.scenarioHappy(text);
  }

  async _begin() {
    this.setPhase('Starting');
    this.audit('run_started', { phase: 'Starting', metadata: { model: this.settings.model } });
    if (!(await this.step(700))) return false;
    this.setPhase('Observing');
    return this.action('Screenshot');
  }

  async scenarioHappy(task = '') {
    if (!this.planner) return this.scenarioPlanned(task);
    if (!(await this._begin())) return;
    if (!(await this.step(600))) return;

    this.setPhase('Thinking');

    // With a planner attached the steps come from the model, so the run shows
    // what it actually intends to do rather than a fixed sequence.
    let steps = null;
    if (this.planner) {
      try {
        steps = await this.planner(task);
      } catch (err) {
        this.setPhase('Failed');
        this.audit('run_failed', { metadata: { failure_class: 'model_error' } });
        this.emit('error', { title: 'Model error', message: err.message, recoverable: true });
        return;
      }
      if (this.cancelled) return;
    }
    if (!(await this.step(steps ? 250 : 1100))) return;

    this.setPhase('Acting');

    if (steps) {
      for (const step of steps) {
        if (!(await this.action(inferActionType(step), { detail: step }))) return;
        if (!(await this.step(700))) return;
      }
    } else {
      for (const a of ['Move', 'Click', 'Type', 'Keypress', 'Screenshot', 'Move', 'Click']) {
        if (!(await this.action(a))) return;
        if (!(await this.step(520))) return;
      }
    }

    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: steps ? steps.length : 7 } });

    // The summary is written after the run is already marked complete. On a
    // free reasoning model it takes ~30s, and blocking Completed on it makes a
    // finished task look stuck.
    if (this.summariser && steps) {
      this.summariser(task, steps)
        .then((text) => { if (!this.cancelled) this.emit('summary', { text }); })
        .catch(() => { /* a missing summary must not fail a completed run */ });
    }
  }

  /**
   * A run with a visible plan, as the real loop publishes one: each step
   * marked as it goes, a skip or a correction honoured part way, and a
   * finished task that can be kept as a shortcut.
   */
  async scenarioPlanned(task = '') {
    this.previewSteering = [];
    this.emit('plan', null);
    if (!(await this._begin())) return;
    if (!(await this.step(500))) return;
    this.setPhase('Thinking');
    if (!(await this.step(900))) return;

    const t = String(task).toLowerCase();
    const app = (t.match(/open\s+([a-z]+)/)?.[1] ?? 'notepad');
    const name = app.charAt(0).toUpperCase() + app.slice(1);
    const typed = String(task).match(/type\s+(.+)$/i)?.[1];
    let steps = [
      { id: 'm0_1', do: `Open ${name}`, doneWhen: `${name} is in front`, kind: 'milestone', status: 'pending', why: `Opening ${name}` },
      { id: 'm0_2', do: 'Find the place to write', doneWhen: 'A blank page has the cursor', kind: 'milestone', status: 'pending', why: 'Putting the cursor where the text should go' },
      { id: 'm0_3', do: typed ? `Write ${typed}` : 'Write a short note', doneWhen: 'The text is on the page', kind: 'milestone', status: 'pending', why: 'Typing it in' },
    ];
    let index = 0;
    // The shape the real driver sends in milestone mode: ids, a done-when each, and the live line.
    const publish = (extra = {}) => this.emit('plan', { steps: steps.map(({ why, ...st }) => st), index, doneWhen: 'the text is on screen', revision: 0, live: steps[index]?.why, ...extra });
    publish();

    while (index < steps.length) {
      this.emit('step', { index, total: steps.length, text: steps[index].do });
      this.setPhase('Thinking');
      if (!(await this.step(900))) return;

      const note = this.previewSteering.shift();
      if (note?.type === 'skip') {
        steps[index].status = 'skipped';
        index += 1;
        publish();
        continue;
      }
      if (note?.type === 'correct') {
        this.setPhase('Thinking');
        steps[index].status = 'changed';
        steps = [...steps.slice(0, index + 1), { do: `Do it the other way: ${note.text}`, kind: 'pointer', status: 'pending', why: 'Following your correction' }, ...steps.slice(index + 1)];
        index += 1;
        publish();
        if (!(await this.step(700))) return;
        continue;
      }

      this.setPhase('Acting');
      if (!(await this.action(inferActionType(steps[index].do), { detail: steps[index].why }))) return;
      if (!(await this.step(650))) return;
      steps[index].status = 'done';
      index += 1;
      publish();
    }

    publish({ finished: true, succeeded: true });
    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: steps.length } });
    this.previewLastRun = { task, steps: steps.filter((st) => st.status === 'done').map((st) => st.do), succeeded: true };
    this.emit('runFinished', this.previewLastRun);
    this.emit('summary', { id: `sum_${Date.now()}`, text: `Opened ${name}${typed ? ` and typed "${typed}"` : ''}.` });
  }

  async scenarioApproval() {
    if (!(await this._begin())) return;
    if (!(await this.step(600))) return;

    this.setPhase('Thinking');
    if (!(await this.step(1000))) return;

    this.setPhase('Acting');
    for (const a of ['Move', 'Click', 'Type']) {
      if (!(await this.action(a))) return;
      if (!(await this.step(460))) return;
    }

    // Matches the real audit entries: High / RequireConfirmation / ExternalCommunication
    const risk = {
      level: 'High',
      decision: 'RequireConfirmation',
      categories: 'ExternalCommunication',
      reason: 'Sending a message is externally visible and cannot be undone.',
    };
    const id = `apr_${Date.now()}`;
    this.audit('action_assessed', { action_type: 'Click', risk });

    // Arm the resolver BEFORE emitting. The emit is synchronous all the way
    // to the UI, so an auto-approval can come straight back on the same tick
    // — and would be dropped if nothing were listening yet.
    const decision = new Promise((res) => { this._approveResolve = res; });

    this.emit('approval', {
      id,
      summary: 'Click “Send” to deliver the drafted email',
      target: 'Send button — Mail, Compose window',
      risk,
    });

    const approved = await decision;
    this._approveResolve = null;
    if (this.cancelled) return;

    if (!approved) {
      this.audit('stop_requested', { metadata: { source: 'overlay' } });
      this.setPhase('Stopped');
      this.audit('run_stopped');
      return;
    }

    this.setPhase('Acting');
    this.audit('action_executed', { action_type: 'Click', risk });
    this.emit('action', { type: 'Click' });
    if (!(await this.step(900))) return;

    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: 4 } });
  }

  async scenarioTakeover() {
    if (!(await this._begin())) return;
    if (!(await this.step(600))) return;

    this.setPhase('Thinking');
    if (!(await this.step(900))) return;

    this.setPhase('Acting');
    for (const a of ['Move', 'Click']) {
      if (!(await this.action(a))) return;
      if (!(await this.step(460))) return;
    }

    const id = `tko_${Date.now()}`;

    // Same ordering rule as approval: arm before emitting.
    const done = new Promise((res) => { this._takeoverResolve = res; });

    this.emit('takeover', {
      id,
      reason: 'A password field is focused. Halo never types credentials.',
      appName: 'Microsoft Edge — account sign-in',
    });

    await done;
    this._takeoverResolve = null;
    if (this.cancelled) return;

    // The real loop takes a fresh observation after every human takeover.
    this.setPhase('Observing');
    if (!(await this.action('Screenshot'))) return;
    if (!(await this.step(700))) return;

    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: 3 } });
  }

  /**
   * Talking, not working. No phases, no desktop — which is the whole point
   * of the distinction: saying hello must leave the machine alone.
   */
  async scenarioChat(text) {
    const id = `msg_${Date.now()}`;
    const t = String(text).toLowerCase();

    const reply =
      /^(?:hi|hey|hello|yo|sup|howdy)/.test(t)
        ? `Hello. I'm ${this.petName}. Tell me something to do on your desktop `
          + 'and I\'ll go and do it — or just keep talking, this is a preview.'
      : /who|what are you|what can you do/.test(t)
        ? 'I read your screen and work it for you — clicking, typing, '
          + 'scrolling — and I stop to ask before anything I can\'t undo. '
          + 'This is the hosted preview, so nothing here touches your computer.'
      : /thank/.test(t)
        ? 'Any time.'
        : 'This is the preview, so I can show you the interface but I\'m not '
          + 'wired to a model here. Installed, this is where the reply would '
          + 'stream in.';

    // Typed out rather than dropped in whole, because that is what the real
    // one does and the difference is the thing worth showing.
    this.emit('message', { id, text: '', done: false });
    const words = reply.split(' ');
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      if (this.cancelled) return;
      acc += (i ? ' ' : '') + words[i];
      this.emit('message', { id, text: acc, done: false });
      await sleep(26);
    }
    this.emit('message', { id, text: reply, done: true });
  }

  /**
   * A message that carried attachments. This exists so the preview can show
   * the whole round trip — the composer's own thumbnails, sent up, echoed
   * straight back under the same id, and a reply that noticed them —
   * without claiming a browser preview with no model wired up can actually
   * read a picture or a file.
   */
  async scenarioAttachments(text, attachments) {
    this.emit('routed', { mode: 'chat', why: 'a message with attachments talks, rather than acting', source: 'rules' });
    const names = attachments.map((a) => a.name).filter(Boolean);
    const list = names.length <= 1 ? names.join('')
      : names.length === 2 ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const reply = `Got your ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`
      + `${list ? ` — ${list}` : ''}. `
      + 'This is the preview, so I can show them in the thread but nothing here actually reads them.';

    const id = `msg_${Date.now()}`;
    this.emit('message', { id, text: '', done: false });
    const words = reply.split(' ');
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      if (this.cancelled) return;
      acc += (i ? ' ' : '') + words[i];
      this.emit('message', { id, text: acc, done: false });
      await sleep(26);
    }
    this.emit('message', { id, text: reply, done: true });
  }

  async scenarioFailure() {
    if (!(await this._begin())) return;
    if (!(await this.step(700))) return;

    this.setPhase('Thinking');
    if (!(await this.step(900))) return;

    this.audit('run_failed', { phase: 'Failed', metadata: { failure_class: 'local_validation' } });
    this.emit('error', {
      title: 'Local error',
      message: 'The desktop call was not complete. Halo stopped without running its actions.',
      recoverable: true,
    });
  }

  /**
   * Replay of the real 2026-08-16T11:24 session, which is the reason the
   * held-modifier state now has a UI at all.
   */
  async scenarioThrash() {
    this.cancelled = false;
    this.paused = false;
    this.sessionId = newSessionId();

    this.setPhase('Starting');
    this.audit('run_started', { metadata: { model: this.settings.model } });
    await sleep(600);

    this.setPhase('Acting');
    this.emit('action', { type: 'Screenshot' });
    await sleep(700);

    // 11:24:33 — physical input pauses the run
    this.paused = true;
    this.emit('pauseState', { paused: true, source: 'physical-input' });
    this.audit('paused', { metadata: { source: 'physical-input' } });
    await sleep(900);

    // The user grabs Ctrl+Shift+Space and holds it
    this.setHeldModifiers(['ctrl', 'shift']);

    // Three resume attempts, each blocked — exactly as logged
    for (let i = 0; i < 3; i++) {
      await sleep(1000);
      this.tryResume('guardian-hotkey');
    }

    // They finally let go
    await sleep(1400);
    this.setHeldModifiers(['shift']);
    await sleep(700);
    this.setHeldModifiers([]);
    await sleep(500);
    this.tryResume('guardian-hotkey');
  }
}
