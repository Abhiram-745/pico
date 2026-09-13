/* ==========================================================================
   HostAgent — what happens when you press Enter.

   Everything you type arrives here, and the first decision is the one the
   app was missing: is this a message, or a job?

     "hello"          -> a reply, streamed back. Nothing is touched.
     "open chrome"    -> the desktop loop in driver.mjs.

   Before this, every line was a job. Saying hello opened whatever was
   focused and typed "hello" into it, which is a fair description of an app
   that does not work.

   It extends MockAgent rather than replacing it, so the pause/resume/stop
   plumbing, the audit log and the approval dance stay exactly as built and
   already trusted by the interface — and so the hosted preview, which has no
   desktop and no key, still demonstrates the same UI against scripted runs.
   ========================================================================== */

import { MockAgent } from '../pico-ui/mock/agent.js';
import { route } from './intent.mjs';
import { runTask } from './driver.mjs';
import { matchShortcut, runShortcut } from './shortcuts.mjs';
import { ALLOW } from './policy.mjs';

let sessionCounter = 0;
const newSessionId = () =>
  `host${(++sessionCounter).toString().padStart(4, '0')}${Math.random().toString(16).slice(2, 10)}`;

/** How much conversation the chat side remembers. */
const CHAT_MEMORY = 12;

export class HostAgent extends MockAgent {
  constructor(transport) {
    super(transport);
    // Off by default. On, every approval card is skipped — only for a
    // machine and an account the user fully trusts. See settings.js.
    this.settings.autoApproveAll = false;
    this.computer = null;
    this.llm = null;
    this.history = [];      // chat turns, oldest first
    this.petName = 'Pico';
  }

  attachComputer(computer) { this.computer = computer; }
  attachLLM(llm) { this.llm = llm; }

  /** Can a task actually be carried out on this machine, right now? */
  canAct() { return Boolean(this.computer && this.llm); }

  /** Why not, in words the interface can show without inventing any. */
  blockedReason() {
    if (!this.llm) return 'No model is configured, so Pico cannot plan anything yet.';
    if (!this.computer) {
      return 'Pico cannot reach the screen or the mouse on this machine, so it '
        + 'can talk but not work.';
    }
    return null;
  }

  handle(msg) {
    if (msg?.command === 'setName') {
      this.petName = String(msg.payload?.name || 'Pico').slice(0, 24);
      return;
    }
    return super.handle(msg);
  }

  /* ------------------------------------------------------------------------
     The fork
     ---------------------------------------------------------------------- */
  async run(text = '', opts = {}) {
    const task = String(text || '').trim();
    if (!task) return;

    // Cancel anything still in flight. Without this a second message leaves
    // the first run's loop going and the two interleave phase changes.
    this.cancelled = true;
    this.paused = false;
    await new Promise((r) => setTimeout(r, 160));
    this.cancelled = false;
    this.sessionId = newSessionId();

    const decision = await route(task, { hint: opts.mode || 'auto', llm: this.llm });
    this.emit('routed', { mode: decision.mode, why: decision.why, source: decision.source });

    if (decision.mode === 'chat') return this.converse(task);
    return this.work(task);
  }

  /* ------------------------------------------------------------------------
     Talking
     ---------------------------------------------------------------------- */
  async converse(text) {
    const id = `msg_${Date.now()}`;
    this.history.push({ role: 'user', content: text });
    this.history = this.history.slice(-CHAT_MEMORY);

    if (!this.llm) {
      this.emit('message', {
        id,
        text: 'No model is configured yet, so I can\'t reply properly. '
          + 'Add your OpenAI key and I\'ll be able to talk.',
        done: true,
      });
      return;
    }

    // Chat has no phases — it must not drive the mascot through Observing and
    // Acting for a run that never touches the desktop.
    this.emit('message', { id, text: '', done: false });

    let full = '';
    try {
      full = await this.llm.converse(this.history, {
        name: this.petName,
        onDelta: (piece) => {
          if (this.cancelled) return;
          full += piece;
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

    this.history.push({ role: 'assistant', content: full });
    this.emit('message', { id, text: full, done: true });
  }

  /* ------------------------------------------------------------------------
     Working
     ---------------------------------------------------------------------- */
  async work(task) {
    if (!this.canAct()) {
      // Say what is actually wrong instead of running a scripted stand-in
      // that looks like success. Pretending was the whole problem.
      const why = this.blockedReason();
      this.emit('message', { id: `msg_${Date.now()}`, text: why, done: true });
      this.emit('error', { title: 'Pico cannot work yet', message: why, recoverable: true });
      this.setPhase('Failed');
      return;
    }

    this.history.push({ role: 'user', content: task });
    this.history = this.history.slice(-CHAT_MEMORY);

    // A bug in the loop must surface as a failed run, not as a dead bridge.
    // It took down the whole server once, which also killed the phone's
    // connection and the interface along with it.
    try {
      if (await this.tryShortcut(task)) return;
      await this.drive(task);
    } catch (err) {
      console.error('[bridge] run crashed:', err);
      this.setPhase('Failed');
      this.audit('run_failed', { metadata: { failure_class: 'internal' } });
      this.emit('error', {
        title: 'Pico hit an internal error',
        message: String(err?.message || err),
        recoverable: true,
      });
    }
  }

  /**
   * Simple, unambiguous jobs done directly — no screenshot, no model call.
   * "Open Notepad" took several seconds through the full loop; this is about
   * one. Returns false when there is no fast path or it could not confirm
   * success, so the full loop picks it up from wherever the screen now is.
   */
  async tryShortcut(task) {
    const sc = matchShortcut(task);
    if (!sc) return false;

    this.setPhase('Starting');
    this.audit('run_started', { metadata: { model: 'shortcut', kind: sc.kind } });
    this.setPhase('Acting');

    const ok = await runShortcut(sc, this.computer, {
      onAction: (a) => {
        this.audit('action_executed', { action_type: a.type, risk: ALLOW });
        this.emit('action', a);
      },
      gate: () => this.gate(),
    });
    if (this.cancelled) return true;

    if (!ok) {
      this.audit('shortcut_unconfirmed', { metadata: { kind: sc.kind } });
      return false;
    }

    const summary = sc.kind === 'app' ? `Opened ${sc.name}.` : sc.label;
    this.setPhase('Completed');
    this.audit('run_completed', { metadata: { completed_actions: sc.kind === 'app' ? 3 : 1 } });
    this.history.push({ role: 'assistant', content: summary });
    this.emit('summary', { text: summary });
    return true;
  }

  drive(task) {
    return runTask({
      task,
      computer: this.computer,
      llm: this.llm,
      model: this.settings.model,
      maxTurns: Math.max(1, Number(this.settings.maximumComputerTurns) || 40),
      hooks: {
        gate: () => this.gate(),
        onPhase: (phase) => this.setPhase(phase),
        onAction: (a) => this.emit('action', a),
        onAudit: (event, extra) => this.audit(event, extra),
        onSummary: (text) => {
          this.history.push({ role: 'assistant', content: text });
          this.emit('summary', { text });
        },
        onError: (e) => this.emit('error', e),

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
          return approved && !this.cancelled;
        },

        onHandover: async (card) => {
          const done = new Promise((res) => { this._takeoverResolve = res; });
          this.emit('takeover', card);
          await done;
          this._takeoverResolve = null;
        },
      },
    });
  }
}
