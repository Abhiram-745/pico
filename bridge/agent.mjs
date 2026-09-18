/* ==========================================================================
   HostAgent — what happens when you press Enter.

   Everything you type arrives here, and the first decision is the one the
   app was missing: is this a message, or a job?

     "hello"          -> a reply, streamed back. Nothing is touched.
     "open chrome"    -> the desktop loop in driver.mjs.

   Before this, every line was a job. Saying hello opened whatever was
   focused and typed "hello" into it, which is a fair description of an app
   that does not work.

   Two things are settled before that fork, because neither is a message or
   a job in the usual sense:

     "remember my brother is Ravi"  -> kept, said so, and taken back on request
     "morning setup"                -> a saved shortcut, run again

   It extends MockAgent rather than replacing it, so the pause/resume/stop
   plumbing, the audit log and the approval dance stay exactly as built and
   already trusted by the interface — and so the hosted preview, which has no
   desktop and no key, still demonstrates the same UI against scripted runs.
   ========================================================================== */

import { MockAgent } from '../pico-ui/mock/agent.js';
import { route } from './intent.mjs';
import { runTask } from './driver.mjs';
import { matchShortcut, runShortcut } from './shortcuts.mjs';
import * as apps from './apps.mjs';
import { ALLOW } from './policy.mjs';
import { memory as defaultMemory, detect as detectMemory } from './memory.mjs';
import { routines as defaultRoutines, Routines } from './routines.mjs';

/* Verbs people mistype when they are in a hurry. Only the first word of the
   request, and only to a verb, so nothing anyone meant is rewritten. */
const TYPOS = new Map([
  ['opne', 'open'], ['oepn', 'open'], ['opn', 'open'], ['opem', 'open'], ['oen', 'open'],
  ['lauch', 'launch'], ['lanuch', 'launch'], ['luanch', 'launch'],
  ['serach', 'search'], ['seach', 'search'], ['saerch', 'search'], ['searh', 'search'],
  ['sned', 'send'], ['snd', 'send'], ['mesage', 'message'], ['messgae', 'message'], ['msg', 'message'],
  ['clsoe', 'close'], ['cloes', 'close'], ['clikc', 'click'], ['cilck', 'click'], ['tpye', 'type'],
  ['goto', 'go to'], ['plya', 'play'], ['pley', 'play'],
]);
export function fixTypos(text) {
  return String(text).replace(/^((?:(?:please|pls|can you|could you|hey|ok|okay|now|just)[,\s]+)*)([a-z]+)\b/i, (all, lead, word) => {
    const fixed = TYPOS.get(word.toLowerCase());
    return fixed ? `${lead}${fixed}` : all;
  });
}

let sessionCounter = 0;
const newSessionId = () =>
  `host${(++sessionCounter).toString().padStart(4, '0')}${Math.random().toString(16).slice(2, 10)}`;

/** How much conversation the chat side remembers. */
const CHAT_MEMORY = 12;

/** Phases a paused run must not be shown leaving on its own. */
const SETTLED = new Set(['Paused', 'Completed', 'Stopped', 'Failed', 'Idle', 'AwaitingApproval', 'AwaitingTakeover']);

export class HostAgent extends MockAgent {
  constructor(transport, { memory = defaultMemory, routines = defaultRoutines } = {}) {
    super(transport);
    // Off by default. On, every approval card is skipped — only for a
    // machine and an account the user fully trusts. See settings.js.
    this.settings.autoApproveAll = false;
    this.computer = null;
    this.llm = null;
    this.history = [];      // chat turns, oldest first
    this.petName = 'Halo';
    this.memory = memory;
    this.routines = routines;
    this.steering = [];     // skips and corrections, waiting for the loop to read them
    this.lastRun = null;    // { task, steps, succeeded } — what "save as shortcut" saves
    this.plan = null;       // the plan as it stands, for replaying to a new window
    this._heldPhase = null;
    this.runToken = 0;      // which run is the current one — see superseded()
  }

  /* One run at a time, for real.

     Starting a new message used to set `cancelled`, wait a moment, and clear
     it again. A run halfway through a model call — several seconds — slept
     straight through that moment, woke to find `cancelled` false, and
     carried on alongside the new one: a task from the last chat finishing
     inside the next. Every run now holds the token it started with, and a
     run whose token is no longer the current one is over, whenever it wakes. */
  superseded(token) { return token !== this.runToken || this.cancelled; }

  async gateFor(token) {
    const open = await this.gate();
    return open && token === this.runToken;
  }

  attachComputer(computer) { this.computer = computer; }

  /* Guide mode's cursor, when the bridge has one. A function rather than the
     thing itself: it is built the first time guide mode is switched on, and
     a run that starts a second later should get it. */
  attachGuide(get) { this.getGuide = get; }

  /** The guide to run with, or null when Halo is doing the work itself. */
  async guideFor() {
    if (!this.shell?.guide || !this.getGuide) return null;
    try { return await this.getGuide(); } catch { return null; }
  }

  /** The shape Halo is in, told by the bridge whenever it changes. */
  setShell(shell) { this.shell = shell; }
  attachLLM(llm) { this.llm = llm; }

  /** Can a task actually be carried out on this machine, right now? */
  canAct() { return Boolean(this.computer && this.llm); }

  /** Why not, in words the interface can show without inventing any. */
  blockedReason() {
    if (!this.llm) return 'No model is configured, so Halo cannot plan anything yet.';
    if (!this.computer) {
      return 'Halo cannot reach the screen or the mouse on this machine, so it '
        + 'can talk but not work.';
    }
    return null;
  }

  /* A run keeps announcing phases while it winds its way to the next gate —
     "Thinking", "Acting" — and each of those arriving after Pause would show
     a paused run as busy. Held back while paused, and the latest restored on
     resume, so the island always says what is really true. */
  setPhase(phase) {
    if (this.paused && !SETTLED.has(phase)) { this._heldPhase = phase; return; }
    super.setPhase(phase);
  }

  tryResume(source) {
    super.tryResume(source);
    if (!this.paused && this._heldPhase) {
      const held = this._heldPhase;
      this._heldPhase = null;
      super.setPhase(held);
    }
  }

  handle(msg) {
    const payload = msg?.payload ?? {};
    switch (msg?.command) {
      case 'setName':
        this.petName = String(payload.name || 'Halo').slice(0, 24);
        return;

      case 'answerQuestion':
        this._answerResolve?.({ text: payload.text ?? '', choice: payload.choice ?? null });
        return;

      /* A new chat is a new chat for the model too.

         The thread clearing while `history` kept its twelve turns would be the
         worst of both: the conversation gone from the screen and still being
         quietly quoted back into every reply. */
      case 'newChat': {
        this.cancelled = true;              // nothing from the old chat finishes
        this.runToken += 1;
        this._answerResolve?.({ text: '', choice: null });
        this._answerResolve = null;

        // Empty for a genuinely new chat; the thread so far when an older one
        // has been reopened. Only the two roles a conversation has — an
        // 'event' line is the interface narrating itself, not something anyone
        // said, and feeding it back would have Halo answering its own notices.
        const resume = Array.isArray(payload.resume) ? payload.resume : [];
        this.history = resume
          .filter((m) => (m?.from === 'you' || m?.from === 'pico') && String(m.text || '').trim())
          .map((m) => ({
            role: m.from === 'you' ? 'user' : 'assistant',
            content: String(m.text).slice(0, 2000),
          }))
          .slice(-CHAT_MEMORY);
        this.plan = null;
        this.emit('plan', null);
        return;
      }

      // --- while a task runs ---------------------------------------------
      case 'skipStep':
        this.steering.push({ type: 'skip', index: Number.isInteger(payload.index) ? payload.index : undefined });
        this.audit('skip_requested', { metadata: { index: payload.index } });
        return;

      case 'steer': {
        const text = String(payload.text ?? '').trim().slice(0, 500);
        if (!text) return;
        this.steering.push({ type: 'correct', text });
        this.emit('message', { id: `steer_${Date.now()}`, from: 'you', text, done: true });
        this.audit('correction_given');
        return;
      }

      // --- memory --------------------------------------------------------
      case 'memoryAdd': {
        const fact = this.memory.add(String(payload.text ?? ''), { source: 'added' });
        // Said in the thread, not as an error: nothing failed, and an error
        // would mark the run in hand as failed with it.
        if (!fact) this.emit('message', { id: `mem_refused_${Date.now()}`, from: 'event', done: true, text: 'Not kept: that looks like it could be a secret, and Halo never stores those.' });
        return;
      }
      case 'memoryRemove':
        this.memory.remove(String(payload.id ?? ''));
        return;
      case 'memoryClear':
        this.memory.clear();
        return;

      // --- saved shortcuts -------------------------------------------------
      case 'routineSave': {
        const run = this.lastRun;
        const task = String(payload.task ?? '').trim() || run?.task;
        const saved = this.routines.save({ name: payload.name, task, steps: payload.task ? [] : run?.steps ?? [] });
        if (saved) {
          this.emit('message', {
            id: `sc_${Date.now()}`, from: 'event', done: true,
            text: `Saved as a shortcut: "${saved.name}". Say its name to run it again.`,
          });
        }
        return;
      }
      case 'routineRun': {
        const item = this.routines.get(String(payload.id ?? ''));
        if (item) this.runRoutine(item);
        return;
      }
      case 'routineRename':
        this.routines.rename(String(payload.id ?? ''), String(payload.name ?? ''));
        return;
      case 'routineRemove':
        this.routines.remove(String(payload.id ?? ''));
        return;

      default:
        return super.handle(msg);
    }
  }

  /**
   * Ask the person one thing and wait for the answer: `{ text, choice }`.
   *
   * `options`, when given, are shown as buttons — `choice` is the id of the
   * one tapped, and a typed answer comes back as `text` with no choice.
   * Armed before emitting, like approvals, so an answer on the same tick
   * is not lost.
   */
  async ask({ id = `q_${Date.now()}`, text, options = null }) {
    const answered = new Promise((res) => { this._answerResolve = res; });
    this.emit('question', { id, text, options: Array.isArray(options) && options.length ? options : undefined });
    const answer = await answered;
    this._answerResolve = null;
    this.emit('question', null);

    // The exchange goes into the thread once it is an exchange. While the
    // question is still open it lives on its own card, and putting it in the
    // thread as well showed it twice, one above the other.
    const said = this.cancelled ? '' : String(answer?.text || '').trim();
    this.emit('message', { id, from: 'pico', text, done: true });
    if (said) this.emit('message', { id: `${id}_a`, from: 'you', text: said, done: true });
    return { text: said, choice: this.cancelled ? null : (answer?.choice ?? null) };
  }

  /** A line in the thread saying what was kept, with the id to take it back. */
  noteRemembered(fact) {
    if (!fact) return;
    this.emit('message', {
      id: `mem_note_${fact.id}_${Date.now()}`, from: 'event', done: true,
      text: `Remembered: ${fact.text}`, memoryId: fact.id,
    });
  }

  /* ------------------------------------------------------------------------
     The fork
     ---------------------------------------------------------------------- */
  async run(text = '', opts = {}) {
    const task = fixTypos(String(text || '').trim());
    if (!task) return;

    // Cancel anything still in flight. Without this a second message leaves
    // the first run's loop going and the two interleave phase changes.
    this.cancelled = true;
    this.paused = false;
    this._heldPhase = null;
    const token = ++this.runToken;
    await new Promise((r) => setTimeout(r, 160));
    if (token !== this.runToken) return;          // a newer message arrived meanwhile
    this.cancelled = false;
    this.steering = [];
    this.sessionId = newSessionId();

    /* Something to keep, or to forget. Said outright ("remember …",
       "forget …"), that is the whole message and it is answered here. Said
       in passing ("my brother is Ravi"), it is kept and the conversation
       carries on as normal — so the reply can use it. */
    const told = detectMemory(task);
    if (told?.kind === 'forget') {
      const gone = this.memory.forget(told.about);
      const reply = gone.length
        ? `Forgotten: ${gone.map((f) => f.text).join('; ')}.`
        : `I wasn't keeping anything about "${told.about}".`;
      this.emit('routed', { mode: 'chat', why: 'asked to forget something', source: 'rules' });
      this.emit('message', { id: `msg_${Date.now()}`, from: 'pico', text: reply, done: true });
      return;
    }
    if (told?.kind === 'remember') {
      const fact = this.memory.add(told.text, { source: told.explicit ? 'told' : 'noticed' });
      this.noteRemembered(fact);
      if (told.explicit) {
        this.emit('routed', { mode: 'chat', why: 'asked to remember something', source: 'rules' });
        this.history.push({ role: 'user', content: task }, { role: 'assistant', content: `Got it — I'll remember that ${fact?.text ?? told.text}.` });
        this.emit('message', { id: `msg_${Date.now()}`, from: 'pico', text: fact ? 'Got it — I\'ll remember that.' : 'That looks like it could be a secret, so I won\'t keep it.', done: true });
        return;
      }
    }

    // A saved shortcut, by name.
    const saved = opts.mode !== 'chat' ? this.routines.match(task) : null;
    if (saved) {
      this.emit('routed', { mode: 'agent', why: `your shortcut "${saved.name}"`, source: 'shortcut' });
      return this.runRoutine(saved, { alreadyAnnounced: true, token });
    }

    // "Open Claude" is a job whatever the name is. The router only knows a
    // fixed list of app names, and anything off it went to a model to be
    // classified — which could, and did, call it conversation.
    const hint = opts.mode || 'auto';
    const decision = hint === 'auto' && apps.parseOpen(task)
      ? { mode: 'agent', why: 'asks to open something', source: 'rules' }
      : await route(task, { hint, llm: this.llm });
    this.emit('routed', { mode: decision.mode, why: decision.why, source: decision.source });

    if (token !== this.runToken) return;
    if (decision.mode === 'chat') return this.converse(task, token);
    return this.work(task, { token });
  }

  /* The chat model worked out that this is a job — "yes", "do it", "opne a
     chat on discord" after it offered. It used to answer "switching to task
     mode" and then do nothing, because chat cannot touch the desktop and
     nothing ever switched. Now it names the job, and the job is started. */
  async handOff(job, token) {
    if (token !== this.runToken) return;
    this.emit('routed', { mode: 'agent', why: 'the conversation asked for it', source: 'model' });
    this.history.pop();                      // the user turn; work() adds it again
    return this.work(job, { token });
  }

  /** Run a saved shortcut: planned fresh, with the last run as a hint. */
  async runRoutine(item, { alreadyAnnounced = false, token = null } = {}) {
    if (!alreadyAnnounced) {
      this.cancelled = true;
      this.paused = false;
      token = ++this.runToken;
      await new Promise((r) => setTimeout(r, 160));
      if (token !== this.runToken) return;
      this.cancelled = false;
      this.steering = [];
      this.sessionId = newSessionId();
      this.emit('message', { id: `you_sc_${Date.now()}`, from: 'you', text: item.name, done: true });
      this.emit('routed', { mode: 'agent', why: `your shortcut "${item.name}"`, source: 'shortcut' });
    }
    this.routines.touch(item.id);
    return this.work(item.task, { note: Routines.note(item), routine: item, token });
  }

  /* ------------------------------------------------------------------------
     Talking
     ---------------------------------------------------------------------- */
  async converse(text, token = this.runToken) {
    const id = `msg_${Date.now()}`;
    this.history.push({ role: 'user', content: text });
    this.history = this.history.slice(-CHAT_MEMORY);

    if (!this.llm) {
      this.emit('message', {
        id,
        text: 'I\'m still connecting to the model. Give me a few seconds and try again.',
        done: true,
      });
      return;
    }

    // Chat has no phases — it must not drive the mascot through Observing and
    // Acting for a run that never touches the desktop.
    this.emit('message', { id, text: '', done: false });

    let full = '';
    // A reply that starts "TASK:" is a hand-off, not something to show.
    const maybeTask = () => /^\s*T(?:A(?:S(?:K(?::.*)?)?)?)?$/is.test(full) || /^\s*TASK:/i.test(full);
    try {
      full = await this.llm.converse(this.history, {
        name: this.petName,
        facts: this.memory.forPrompt(),
        onDelta: (piece) => {
          if (this.superseded(token)) return;
          full += piece;
          if (maybeTask()) return;
          this.emit('message', { id, text: full, done: false });
        },
      });
    } catch (err) {
      this.emit('message', {
        id,
        text: `I couldn't reach the model just then — ${err.message}`,
        done: true,
      });
      return;
    }

    if (this.superseded(token)) return;
    const job = String(full).match(/^\s*TASK:\s*(.+)/is)?.[1]?.split('\n')[0].trim();
    if (job) {
      this.emit('message', { id, text: '', done: true, remove: true });
      return this.handOff(job, token);
    }
    this.history.push({ role: 'assistant', content: full });
    this.emit('message', { id, text: full, done: true });
  }

  /* ------------------------------------------------------------------------
     Working
     ---------------------------------------------------------------------- */
  async work(task, context = {}) {
    if (context.token == null) context = { ...context, token: this.runToken };
    if (!this.canAct()) {
      // Say what is actually wrong instead of running a scripted stand-in
      // that looks like success. Pretending was the whole problem.
      const why = this.blockedReason();
      this.emit('message', { id: `msg_${Date.now()}`, text: why, done: true });
      this.emit('error', { title: 'Halo cannot work yet', message: why, recoverable: true });
      this.setPhase('Failed');
      return;
    }

    this.history.push({ role: 'user', content: task });
    this.history = this.history.slice(-CHAT_MEMORY);
    this.lastRun = null;
    this.plan = null;
    this.emit('plan', null);

    // Locked, behind a screen saver, or at a UAC prompt: nothing Halo sends
    // can reach the desktop, so say so instead of starting anything.
    const reachable = await this.computer.available?.().catch(() => null) ?? { ok: true };
    if (!reachable.ok) {
      const why = `Halo can't use the mouse or keyboard right now — ${reachable.why}. Unlock the screen and try again.`;
      this.emit('message', { id: `msg_${Date.now()}`, text: why, done: true });
      this.emit('error', { title: 'Halo cannot reach the desktop', message: why, recoverable: true });
      this.setPhase('Failed');
      return;
    }

    // A bug in the loop must surface as a failed run, not as a dead bridge.
    // It took down the whole server once, which also killed the phone's
    // connection and the interface along with it.
    try {
      if (await this.tryOpen(task, context)) return;
      if (!context.routine && await this.tryShortcut(task, context.token)) return;
      await this.drive(task, context);
    } catch (err) {
      console.error('[bridge] run crashed:', err);
      this.setPhase('Failed');
      this.audit('run_failed', { metadata: { failure_class: 'internal' } });
      this.emit('error', {
        title: 'Halo hit an internal error',
        message: String(err?.message || err),
        recoverable: true,
      });
    }
  }

  /** What memory offers the opener: kept app-or-website answers, and a browser. */
  openHelpers() {
    return {
      remembered: (key) => this.memory.value(key),
      remember: (key, pick, { app, site } = {}) => {
        const name = app?.name ?? key.replace(/^open:/, '');
        const text = pick === 'app'
          ? `Open ${name} as the app, not the website`
          : `Open ${name} as the website (${site?.label ?? 'in the browser'}), not the app`;
        this.noteRemembered(this.memory.add(text, { key, value: pick, source: 'answered' }));
      },
      browser: apps.preferredBrowser(this.memory.list()),
    };
  }

  /**
   * "Open X" — and "open X and then do Y" — settled before anything looks
   * at the screen, by the same opener a plan step uses (apps.open).
   *
   * Something that is neither an installed app nor a known website is not
   * this function's business: the planner gets it, and can tell a folder or
   * a settings page from an app. Anything after "and then" is handed to the
   * planner once the thing is open, with the choice already made so nothing
   * is asked twice, and with a truthful account of what came to the front.
   */
  async tryOpen(task, context = {}) {
    const parsed = apps.parseOpen(task);
    if (!parsed) return false;

    // Only what is certainly an app or a site is opened here.
    if (!parsed.url) {
      const decision = await apps.resolve(parsed.name, task).catch(() => null);
      if (!decision || decision.kind === 'unknown') return false;
    }

    this.setPhase('Starting');
    this.audit('run_started', { metadata: { model: 'open' } });
    this.setPhase('Acting');

    const choices = new Map();
    let result;
    try {
      result = await apps.open(parsed.url ? { url: parsed.url } : { name: parsed.name }, {
        computer: this.computer,
        task,
        choices,
        ask: async (question, options) => {
          this.setPhase('AwaitingApproval');
          const answer = await this.ask({ text: question, options });
          this.setPhase('Acting');
          return answer;
        },
        gate: () => this.gateFor(context.token),
        onAction: (a) => this.emit('action', a),
        before: await this.computer.foreground().catch(() => null),
        ...this.openHelpers(),
      });
    } catch (err) {
      this.audit('open_failed', { metadata: { reason: String(err.message) } });
      return false;     // the planner gets a go instead
    }
    if (this.superseded(context.token)) return true;

    const finish = (phase, summary, failureClass = null) => {
      this.setPhase(phase);
      this.audit(phase === 'Completed' ? 'run_completed' : 'run_stopped', failureClass ? { metadata: { failure_class: failureClass } } : { metadata: { completed_actions: 1 } });
      this.history.push({ role: 'assistant', content: summary });
      this.emit('summary', { text: summary });
    };

    if (result.outcome === 'stopped') return true;
    // "Open the Claude app or claude.ai?" — "no, the claude gc on discord".
    // Not a refusal: the question was the wrong one. Do the job they meant.
    if (result.outcome === 'corrected') {
      await this.drive(`${task}\n(asked whether to open ${result.label}, they said: ${result.correction})`, {
        ...context,
        choices: [...choices.entries()],
        whole: task,
      }, task);
      return true;
    }
    if (result.outcome === 'declined' || result.outcome === 'unclear') {
      finish('Stopped', result.summary, result.outcome);
      return true;
    }
    if (result.outcome === 'unknown') return false;
    this.audit('action_executed', { action_type: 'Keypress', risk: ALLOW });
    if (result.outcome === 'not-opened') {
      finish('Stopped', result.summary, 'not_opened');
      return true;
    }

    if (parsed.rest) {
      const opened = result;
      await this.drive(parsed.rest, {
        ...context,
        whole: task,
        note: [context.note, opened.note].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        choices: [...choices.entries()],
        // Said first, so the person hears what came to the front before what
        // was done in it: "Notepad was already open, showing Pico.sln. …"
        prefix: opened.outcome === 'already-open' ? opened.summary : '',
      }, task);
      return true;
    }

    this.lastRun = { task, steps: [`Open ${result.label}`], succeeded: true };
    this.emit('runFinished', { task, steps: this.lastRun.steps, succeeded: true, routine: context.routine?.id ?? null });
    finish('Completed', result.summary);
    return true;
  }

  /**
   * Simple, unambiguous jobs done directly — no screenshot, no model call:
   * going to a site by address, and searching. Returns false when there is
   * no fast path, so the full loop picks it up.
   *
   * Opening apps is no longer one of them. It typed the name into Start
   * search and pressed Enter, which launches whatever the top result is —
   * and when the app is not installed, the top result is a web search.
   * tryOpen opens apps by their Start-menu ID instead.
   */
  async tryShortcut(task, token = this.runToken) {
    const sc = matchShortcut(task);
    if (!sc || sc.kind !== 'url') return false;

    this.setPhase('Starting');
    this.audit('run_started', { metadata: { model: 'shortcut', kind: sc.kind } });
    this.setPhase('Acting');

    const ok = await runShortcut(sc, this.computer, {
      onAction: (a) => {
        this.audit('action_executed', { action_type: a.type, risk: ALLOW });
        this.emit('action', a);
      },
      gate: () => this.gateFor(token),
    });
    if (this.superseded(token)) return true;

    if (!ok) {
      this.audit('shortcut_unconfirmed', { metadata: { kind: sc.kind } });
      return false;
    }

    const summary = sc.label;
    this.lastRun = { task, steps: [sc.label.replace(/\.$/, '')], succeeded: true };
    this.emit('runFinished', { task, steps: this.lastRun.steps, succeeded: true });
    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: 1 } });
    this.history.push({ role: 'assistant', content: summary });
    this.emit('summary', { text: summary });
    return true;
  }

  /**
   * Hand a task to the loop. `whole` is the request as the person said it,
   * which is what a shortcut saved from this run should keep — not only the
   * part after "open X and".
   */
  async drive(task, context = {}, whole = task) {
    const helpers = this.openHelpers();
    const result = await runTask({
      task,
      computer: this.computer,
      llm: this.llm,
      context: {
        ...context,
        memory: this.memory.forPrompt(),
        guide: await this.guideFor(),
        browser: helpers.browser,
      },
      maxTurns: Math.max(1, Number(this.settings.maximumComputerTurns) || 24),
      hooks: {
        gate: () => this.gateFor(context.token),
        onPhase: (phase) => { if (!this.superseded(context.token)) this.setPhase(phase); },
        onStep: (step) => this.emit('step', step),
        onPlan: (plan) => {
          if (this.superseded(context.token)) return;
          this.plan = plan;
          this.emit('plan', plan);
        },
        onAction: (a) => this.emit('action', a),
        onAudit: (event, extra) => this.audit(event, extra),
        onSummary: (text) => {
          if (this.superseded(context.token)) return;
          const said = context.prefix ? `${context.prefix} ${text}` : text;
          this.history.push({ role: 'assistant', content: said });
          this.emit('summary', { text: said });
        },
        onError: (e) => this.emit('error', e),
        steer: () => this.steering.splice(0),
        remembered: helpers.remembered,
        remember: helpers.remember,

        onApproval: async (card) => {
          if (this.settings.autoApproveAll) {
            this.audit('action_assessed', {
              action_type: 'Approval',
              risk: { ...card.risk, decision: 'AutoApproved', categories: 'UserOverride' },
              metadata: { source: 'autoApproveAll setting' },
            });
            return true;
          }
          // Arm before emitting: the interface can answer on the same tick
          // when the user has auto-approval on, and the answer would be lost.
          const decision = new Promise((res) => { this._approveResolve = res; });
          this.emit('approval', card);
          const approved = await decision;
          this._approveResolve = null;
          return approved && !this.superseded(context.token);
        },

        onQuestion: (q) => this.ask(q),

        onHandover: async (card) => {
          const done = new Promise((res) => { this._takeoverResolve = res; });
          this.emit('takeover', card);
          await done;
          this._takeoverResolve = null;
        },
      },
    });

    // However the loop ended — finished, stopped, failed, replaced — the
    // guide arrow does not belong on screen afterwards.
    (await this.guideFor())?.hide();

    if (result && !this.superseded(context.token)) {
      const steps = [
        ...(whole !== task ? [whole.slice(0, whole.length - task.length).replace(/\s*(?:,|and then|then|and)\s*$/i, '').trim()] : []),
        ...result.steps,
      ].filter(Boolean);
      this.lastRun = { task: whole, steps, succeeded: result.succeeded };
      this.emit('runFinished', { task: whole, steps, succeeded: result.succeeded, routine: context.routine?.id ?? null });
    }
    return result;
  }
}
