/* ==========================================================================
   HostAgent — drives the real desktop when it can, falls back to the
   scripted demo agent when it can't.

   Extends MockAgent rather than duplicating it: pause/resume/stop/settings
   plumbing, the approval and takeover promise dance, and the audit log all
   stay exactly as already built and already trusted by pico-ui. This class
   only adds a second path for run(): when a computer-control backend
   (computer.mjs) and an OpenAI key are both available and the selected
   model is a computer-use model, it drives OpenAI's Responses API
   "computer_use_preview" tool loop instead of a scripted scenario —
   screenshot in, action out, repeat.

   OpenAI's own safety-check mechanism (pending_safety_checks on a
   computer_call) is what feeds the existing approval-card UI here: nothing
   new was invented for that, it is wired straight into the mechanism the
   approval cards were already built for.
   ========================================================================== */

import { MockAgent } from '../pico-ui/mock/agent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionCounter = 0;
const newSessionId = () =>
  `host${(++sessionCounter).toString().padStart(4, '0')}${Math.random().toString(16).slice(2, 10)}`;

const ALLOW_RISK = {
  level: 'None',
  decision: 'Allow',
  categories: 'None',
  reason: 'No protected or high-impact operation was detected.',
};

const ACTION_TYPE_MAP = {
  click: 'Click', double_click: 'Click', drag: 'Drag', keypress: 'Keypress',
  move: 'Move', screenshot: 'Screenshot', scroll: 'Scroll', type: 'Type', wait: 'Wait',
};

/* OpenAI's computer-use safety-check codes, mapped onto the risk shape the
   approval card already knows how to render. */
const SAFETY_CATEGORY = {
  malicious_instructions: { level: 'High', categories: 'PromptInjection' },
  irrelevant_domain: { level: 'Medium', categories: 'UnexpectedSite' },
  sensitive_domain: { level: 'Medium', categories: 'SensitiveSite' },
};

function describeAction(action = {}) {
  switch (action.type) {
    case 'click': return `Click at (${action.x}, ${action.y})`;
    case 'double_click': return `Double-click at (${action.x}, ${action.y})`;
    case 'move': return `Move the pointer to (${action.x}, ${action.y})`;
    case 'drag': return 'Drag across the screen';
    case 'scroll': return 'Scroll the current view';
    case 'type': return 'Type text';   // never the text itself — see store.js
    case 'keypress': return `Press ${(action.keys || []).join('+')}`;
    case 'wait': return 'Wait for the app to respond';
    case 'screenshot': return 'Take a fresh screenshot';
    default: return action.type || 'Unknown action';
  }
}

function extractText(message) {
  if (!message?.content) return '';
  return message.content
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join(' ')
    .trim();
}

export class HostAgent extends MockAgent {
  constructor(transport) {
    super(transport);
    // Off by default. Turning it on means every approval card is skipped —
    // only for a machine and account the user fully trusts. See settings.js.
    this.settings.autoApproveAll = false;
    this.computer = null;
    this.responses = null;
  }

  attachComputer(computer) { this.computer = computer; }
  attachResponses(llm) { this.responses = llm; }

  canDriveDesktop() {
    return Boolean(this.computer)
      && Boolean(this.responses)
      && this.responses.provider === 'openai'
      && /computer-use/i.test(this.settings.model || '');
  }

  async run(text = '') {
    if (this.canDriveDesktop()) return this.runComputerUse(text);
    return super.run(text);   // no real backend yet — same scripted demo as before
  }

  /* ------------------------------------------------------------------------
     The real loop
     ---------------------------------------------------------------------- */
  async runComputerUse(task) {
    this.cancelled = true;
    this.paused = false;
    await sleep(150);
    this.cancelled = false;
    this.sessionId = newSessionId();

    this.setPhase('Starting');
    this.audit('run_started', { metadata: { model: this.settings.model } });

    let size;
    try {
      size = await this.computer.size();
    } catch (err) {
      return this.fail('desktop_unavailable', `Could not read the screen: ${err.message}`);
    }

    if (!(await this.gate())) return;
    this.setPhase('Observing');
    if (!(await this.performAction('Screenshot', 'Take a fresh screenshot', { type: 'screenshot' }))) return;

    let shot;
    try {
      shot = await this.computer.screenshotBase64();
    } catch (err) {
      return this.fail('desktop_unavailable', `Could not capture the screen: ${err.message}`);
    }

    this.setPhase('Thinking');

    const tool = { type: 'computer_use_preview', display_width: size.width, display_height: size.height, environment: 'windows' };
    let response;
    try {
      response = await this.callResponses({
        model: this.settings.model,
        tools: [tool],
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: String(task) },
            { type: 'input_image', image_url: `data:image/png;base64,${shot}` },
          ],
        }],
        truncation: 'auto',
      });
    } catch (err) {
      return this.fail('model_error', err.message);
    }

    const executed = [];
    const maxTurns = Math.max(1, Number(this.settings.maximumComputerTurns) || 100);

    for (let turns = 0; ; turns++) {
      if (!(await this.gate())) return;

      const calls = (response.output || []).filter((o) => o.type === 'computer_call');
      if (!calls.length) {
        this.setPhase('Completed');
        this.audit('run_completed', { metadata: { completed_actions: executed.length } });
        const text = extractText((response.output || []).find((o) => o.type === 'message'));
        if (text) this.emit('summary', { text });
        return;
      }

      if (turns >= maxTurns) {
        return this.fail('turn_limit', `Stopped after ${maxTurns} actions, the configured limit.`);
      }

      const call = calls[0];
      let acknowledged = [];

      if (call.pending_safety_checks?.length) {
        const ok = this.settings.autoApproveAll
          ? await this.autoApprove(call.pending_safety_checks)
          : await this.requestApproval(call);
        if (!ok) {
          this.audit('stop_requested', { metadata: { source: 'approval-denied' } });
          this.setPhase('Stopped');
          this.audit('run_stopped');
          return;
        }
        acknowledged = call.pending_safety_checks.map((c) => ({ id: c.id }));
      }

      if (!(await this.gate())) return;
      this.setPhase('Acting');

      try {
        if (!(await this.performAction(
          ACTION_TYPE_MAP[call.action?.type] || 'Move',
          describeAction(call.action),
          call.action,
        ))) return;
      } catch (err) {
        return this.fail('action_failed', `Could not perform that action: ${err.message}`);
      }
      executed.push(call.action?.type);

      if (!(await this.gate())) return;
      this.setPhase('Observing');
      try {
        shot = await this.computer.screenshotBase64();
      } catch (err) {
        return this.fail('desktop_unavailable', `Could not capture the screen: ${err.message}`);
      }

      this.setPhase('Thinking');
      try {
        response = await this.callResponses({
          model: this.settings.model,
          tools: [tool],
          previous_response_id: response.id,
          input: [{
            type: 'computer_call_output',
            call_id: call.call_id,
            ...(acknowledged.length ? { acknowledged_safety_checks: acknowledged } : {}),
            output: { type: 'computer_screenshot', image_url: `data:image/png;base64,${shot}` },
          }],
          truncation: 'auto',
        });
      } catch (err) {
        return this.fail('model_error', err.message);
      }
    }
  }

  /** Assess -> execute for real -> log, in that order (unlike the mock's timed stand-in). */
  async performAction(type, detail, action) {
    if (!(await this.gate())) return false;
    this.audit('action_assessed', { action_type: type, risk: ALLOW_RISK });
    this.emit('action', { type, detail });
    await this.execute(action);
    if (!(await this.gate())) return false;
    this.audit('action_executed', { action_type: type, risk: ALLOW_RISK });
    return true;
  }

  async execute(action) {
    const c = this.computer;
    switch (action?.type) {
      case 'click': return c.click(action.x, action.y, action.button);
      case 'double_click': return c.doubleClick(action.x, action.y);
      case 'move': return c.move(action.x, action.y);
      case 'drag': return c.drag(action.path || []);
      case 'scroll': return c.scroll(action.x, action.y, action.scroll_x, action.scroll_y);
      case 'type': return c.type(action.text);
      case 'keypress': return c.keypress(action.keys || []);
      case 'wait': return c.wait(1000);
      case 'screenshot': return;   // the observation step already takes one
      default: return;
    }
  }

  async requestApproval(call) {
    const checks = call.pending_safety_checks;
    const infos = checks.map((c) => SAFETY_CATEGORY[c.code] || { level: 'Medium', categories: 'Unknown' });
    const level = infos.some((i) => i.level === 'High') ? 'High' : 'Medium';
    const categories = [...new Set(infos.map((i) => i.categories))].join(', ');
    const reason = checks.map((c) => c.message).join(' ');
    const risk = { level, decision: 'RequireConfirmation', categories, reason };

    const id = `apr_${Date.now()}`;
    this.audit('action_assessed', { action_type: ACTION_TYPE_MAP[call.action?.type] || 'Move', risk });

    // Arm before emitting — an auto-approval could come back on the same tick.
    const decision = new Promise((res) => { this._approveResolve = res; });
    this.emit('approval', { id, summary: describeAction(call.action), target: reason, risk });

    const approved = await decision;
    this._approveResolve = null;
    return approved && !this.cancelled;
  }

  /** Explicit user opt-in (settings.autoApproveAll): skip the card, log it anyway. */
  async autoApprove(checks) {
    this.audit('action_assessed', {
      action_type: 'Approval',
      risk: {
        level: 'High',
        decision: 'AutoApproved',
        categories: 'UserOverride',
        reason: checks.map((c) => c.message).join(' '),
      },
      metadata: { source: 'autoApproveAll setting' },
    });
    return true;
  }

  fail(failureClass, message) {
    this.setPhase('Failed');
    this.audit('run_failed', { metadata: { failure_class: failureClass } });
    this.emit('error', { title: 'Pico stopped', message, recoverable: true });
  }

  /* ------------------------------------------------------------------------
     OpenAI Responses API — the computer_use_preview tool loop
     ---------------------------------------------------------------------- */
  async callResponses(body) {
    const llm = this.responses;
    const res = await fetch(`${llm.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (!res.ok) throw new Error(llm.redact(parsed?.error?.message || `HTTP ${res.status}`));
    return parsed;
  }
}
