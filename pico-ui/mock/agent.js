/* ==========================================================================
   Pico — mock host

   Stands in for the C# side so the UI is fully exercisable in a browser.
   It speaks exactly the contract in src/bridge.js and nothing more, which is
   what keeps the UI honest: if it works here, it works against WebView2.

   Scenario timings and event shapes are taken from the real
   AppData\Local\Pico\audit.jsonl (106 events across 9 sessions).
   ========================================================================== */

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
    this.settings = {
      model: 'gpt-5.4-mini',
      pauseOnPhysicalInput: true,
      maximumComputerTurns: 100,
      hasApiKey: true,
    };
    transport.onCommand((msg) => this.handle(msg));

    /* Optional. When the bridge has an LLM configured, this turns a task into
       real steps instead of the scripted ones. Left null in the browser, where
       there is no key and must never be one. */
    this.planner = null;
    this.summariser = null;
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
    this.setPhase('Idle');
  }

  // --- commands from the UI ------------------------------------------------
  handle({ command, payload = {} }) {
    switch (command) {
      case 'submitTask':
        this.run(payload.text);
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
  async run(text = '') {
    // Cancel anything still in flight first. Without this, submitting a second
    // task leaves the previous scenario's loop running and the two interleave
    // phase changes — which is exactly what a real host must never do either.
    this.cancelled = true;
    this.paused = false;
    await sleep(150);            // longer than the gate() poll interval

    this.cancelled = false;
    this.sessionId = newSessionId();

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
      reason: 'A password field is focused. Pico never types credentials.',
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

  async scenarioFailure() {
    if (!(await this._begin())) return;
    if (!(await this.step(700))) return;

    this.setPhase('Thinking');
    if (!(await this.step(900))) return;

    this.audit('run_failed', { phase: 'Failed', metadata: { failure_class: 'local_validation' } });
    this.emit('error', {
      title: 'Local error',
      message: 'The desktop call was not complete. Pico stopped without running its actions.',
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
