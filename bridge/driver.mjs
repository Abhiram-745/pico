/* ==========================================================================
   Pico — the loop that actually does the work.

   Look, decide, act, look again. That is the whole shape of it.

   WHY THIS EXISTS
   The previous loop was written against OpenAI's `computer_use_preview`
   tool, and could never run: it was gated on the model name containing
   "computer-use", while the model was always the fast text tier — and the
   account has no computer-use model at all. Every task silently fell through
   to a scripted demo that pretended to work.

   This runs on an ordinary vision model with ordinary function calling,
   which every current key can reach. The screenshot goes in, one tool call
   comes back, it is judged, executed, and the next screenshot goes in. The
   model never sees coordinates it did not ask for and never gets to run two
   actions unexamined.

   WHAT IT SENDS
   A downscaled JPEG of the desktop, each turn. That is a full-screen image
   of whatever you have open, and it goes to the model provider. The settings
   panel says so in as many words; it is not buried here.
   ========================================================================== */

import { assess, describe, ACTION_PHASE, ALLOW } from './policy.mjs';

/** Identity of an action, for spotting a loop. */
const signature = (a) =>
  // Keys are normalised so "escape", "Esc" and "ESC" count as the same press —
  // the model varies the spelling while repeating itself.
  [a.type, a.x, a.y, a.text,
    (a.keys || []).map((k) => String(k).toUpperCase().replace(/^ESCAPE$/, 'ESC')).join('+'),
    a.dy].join('|');

/**
 * Did the screen meaningfully change? Compares the coarse grey thumbnails
 * from screen.mjs by mean absolute difference. An exact hash was tried first
 * and never matched — the clock alone changes every frame — so the model was
 * always told "something moved" and kept pressing Escape.
 */
const UNCHANGED_BELOW = 1.5;   // mean grey-level difference, 0–255
function sameScreen(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length < UNCHANGED_BELOW;
}

/** Pico's own windows: the app ("Pico") and the island ("Pico Notch"). */
const isPicoWindow = (title = '') => /(?:^|— )Pico(?: Notch)?$/.test(String(title).trim());

/** How many identical actions in a row before the run is called stuck. */
const STUCK_AFTER = 4;

/* One tool, not nine. A single call with an action field keeps the schema
   small enough to resend every turn without it dominating the prompt, and
   the model picks the action far more reliably than it picks between nine
   near-identical function names. */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Perform exactly one action on the Windows desktop.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'right_click', 'type', 'key',
                   'scroll', 'move', 'wait', 'screenshot'],
          },
          x: { type: 'integer', description: 'Horizontal position in the screenshot.' },
          y: { type: 'integer', description: 'Vertical position in the screenshot.' },
          text: { type: 'string', description: 'Text to type, for action "type".' },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Chord to press together, e.g. ["ctrl","t"] or ["enter"].',
          },
          dy: { type: 'integer', description: 'Scroll amount; negative is up.' },
          why: {
            type: 'string',
            description: 'Six words or fewer, for the person watching. '
              + 'Name the control, e.g. "click the Send button".',
          },
        },
        required: ['action', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'The task is done, or cannot be taken further.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One short past-tense sentence.' },
          succeeded: { type: 'boolean' },
        },
        required: ['summary', 'succeeded'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handover',
      description:
        'Hand control back to the person. Use for passwords, PINs, two-factor '
        + 'codes, CAPTCHAs and Windows security prompts — never attempt these.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'What they need to do, in one sentence.' },
        },
        required: ['reason'],
      },
    },
  },
];

const systemPrompt = (shot, windowTitle) => [
  'You operate a Windows 11 desktop for someone watching you work.',
  '',
  `The screenshot is ${shot.width} by ${shot.height} pixels. Give every`,
  'coordinate in that space, measured from the top-left corner. Look at where',
  'the control actually is in the image rather than guessing from memory.',
  windowTitle ? `In front right now: ${windowTitle}.` : '',
  '',
  'Call exactly one tool per turn. After each action you get a fresh',
  'screenshot, so take one step and look again rather than planning ahead.',
  '',
  'Prefer the keyboard where it is more reliable than aiming: the Windows key',
  'opens Start, ctrl+l focuses a browser address bar, ctrl+t opens a tab.',
  'Wait when something is still loading.',
  '',
  'The black bar at the top centre of the screen is Pico itself. It is not',
  'part of any task — never click or type into it.',
  '',
  'Never type a password, PIN, card number, one-time code, or answer a',
  'CAPTCHA. Call handover instead.',
  '',
  'Call finish as soon as the task is done — including when it turned out to',
  'be already done. Repeating an action that changed nothing is never the',
  'right next step: if the screen did not move, either try a different',
  'approach or finish.',
].filter(Boolean).join('\n');

/** Keep the conversation from growing without bound over a long run. */
const MAX_IMAGES = 3;

function trimHistory(messages) {
  // Old screenshots are the expensive part and the least useful: only the
  // most recent few say anything about the screen as it is now.
  let images = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const hasImage = m.content.some((c) => c.type === 'image_url');
    if (!hasImage) continue;
    images += 1;
    if (images > MAX_IMAGES) {
      m.content = m.content
        .filter((c) => c.type !== 'image_url')
        .concat([{ type: 'text', text: '[earlier screenshot omitted]' }]);
    }
  }
  return messages;
}

/**
 * Run one task against the real desktop.
 *
 * Every hook is optional except `gate`, which is how pause and stop reach
 * this loop: it resolves false when the run should end.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {object} opts.computer   from computer.mjs
 * @param {object} opts.llm        from llm.mjs
 * @param {string} opts.model
 * @param {number} opts.maxTurns
 * @param {object} opts.hooks
 *   gate()            -> Promise<boolean>
 *   onPhase(phase)
 *   onAction({ type, detail })
 *   onAudit(event, extra)
 *   onApproval({ id, summary, target, risk }) -> Promise<boolean>
 *   onHandover({ id, reason, appName })       -> Promise<void>
 *   onSummary(text)
 *   onError({ title, message })
 */
export async function runTask({ task, computer, llm, model, maxTurns = 40, hooks = {} }) {
  const {
    gate = async () => true,
    onPhase = () => {},
    onAction = () => {},
    onAudit = () => {},
    onApproval = async () => false,
    onHandover = async () => {},
    onSummary = () => {},
    onError = () => {},
  } = hooks;

  const fail = (failureClass, message) => {
    onPhase('Failed');
    onAudit('run_failed', { metadata: { failure_class: failureClass } });
    onError({ title: 'Pico stopped', message, recoverable: true });
  };

  onPhase('Starting');
  onAudit('run_started', { metadata: { model } });

  let shot;
  try {
    onPhase('Observing');
    shot = await computer.capture();
  } catch (err) {
    return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
  }
  if (!(await gate())) return;

  const messages = [
    { role: 'system', content: systemPrompt(shot, computer.focusedWindow()) },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Task: ${task}` },
        { type: 'image_url', image_url: { url: `data:${shot.mime};base64,${shot.b64}`, detail: 'high' } },
      ],
    },
  ];

  let executed = 0;
  const done = [];                 // what has actually been carried out
  let lastSignature = null;
  let repeats = 0;
  let lastGrey = shot.grey;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (!(await gate())) return;

    onPhase('Thinking');
    let choice;
    try {
      choice = await llm.toolCall(trimHistory(messages), { model, tools: TOOLS });
    } catch (err) {
      return fail('model_error', err.message);
    }
    if (!(await gate())) return;

    // No tool call means the model answered in prose. Treat whatever it said
    // as the closing summary rather than looping on an empty turn.
    if (!choice.call) {
      onPhase('Completed');
      onAudit('run_completed', { metadata: { completed_actions: executed } });
      if (choice.text) onSummary(choice.text);
      return;
    }

    const { name, args } = choice.call;

    if (name === 'finish') {
      onPhase(args.succeeded === false ? 'Stopped' : 'Completed');
      onAudit(args.succeeded === false ? 'run_stopped' : 'run_completed', {
        metadata: { completed_actions: executed },
      });
      if (args.summary) onSummary(args.summary);
      return;
    }

    if (name === 'handover') {
      onPhase('AwaitingTakeover');
      onAudit('takeover_requested', { metadata: { reason: args.reason } });
      await onHandover({
        id: `tko_${Date.now()}`,
        reason: args.reason || 'This step needs you.',
        appName: computer.focusedWindow(),
      });
      if (!(await gate())) return;

      onPhase('Observing');
      try {
        shot = await computer.capture();
      } catch (err) {
        return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
      }
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'The person has finished that step. Here is the screen now.' },
          { type: 'image_url', image_url: { url: `data:${shot.mime};base64,${shot.b64}`, detail: 'high' } },
        ],
      });
      continue;
    }

    // --- an action ---------------------------------------------------------
    const action = { ...args, type: args.action };

    // A model with nothing to push back on it will happily press Escape
    // thirty times in a row. It did exactly that the first time this ran.
    const sig = signature(action);
    repeats = sig === lastSignature ? repeats + 1 : 0;
    lastSignature = sig;
    if (repeats >= STUCK_AFTER) {
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'stuck' } });
      onSummary(
        `I stopped: the same step — ${describe(action).toLowerCase()} — kept `
        + 'having no effect, so repeating it was not going to get anywhere.',
      );
      return;
    }

    const windowTitle = computer.focusedWindow();
    const risk = assess(action, windowTitle);
    const detail = describe(action);
    const phaseType = ACTION_PHASE[action.type] || 'Move';

    onAudit('action_assessed', { action_type: phaseType, risk });

    if (risk.decision === 'Handover') {
      onPhase('AwaitingTakeover');
      await onHandover({ id: `tko_${Date.now()}`, reason: risk.reason, appName: windowTitle });
      if (!(await gate())) return;
      messages.push({
        role: 'assistant',
        content: `I handed that step to the person: ${risk.reason}`,
      });
      continue;
    }

    if (risk.decision === 'RequireConfirmation') {
      onPhase('AwaitingApproval');
      const approved = await onApproval({
        id: `apr_${Date.now()}`,
        summary: detail,
        target: windowTitle || 'the active window',
        risk,
      });
      if (!approved) {
        onAudit('stop_requested', { metadata: { source: 'approval-denied' } });
        onPhase('Stopped');
        onAudit('run_stopped');
        return;
      }
      if (!(await gate())) return;
    }

    // A job typed into the island leaves keyboard focus in the island, so the
    // first keystrokes of the run would be typed into Pico itself. Refuse
    // and say why; the model then clicks the window it meant. The Windows key
    // is exempt: it opens Start wherever focus is.
    const keyboardAction = action.type === 'type'
      || (action.type === 'key' && !(action.keys || []).some((k) => /^(?:win|meta|super|cmd)$/i.test(k)));
    if (keyboardAction && isPicoWindow(windowTitle)) {
      const rawCall = choice.call.raw;
      messages.push(
        { role: 'assistant', content: null, tool_calls: [rawCall] },
        {
          role: 'tool',
          tool_call_id: rawCall.id,
          content: 'Not done: keyboard focus is on Pico\'s own window. Click the '
            + 'window or field the text should go into first, then type.',
        },
      );
      continue;
    }

    onPhase('Acting');
    onAction({ type: phaseType, detail });

    try {
      await execute(computer, action, shot);
    } catch (err) {
      return fail('action_failed', `That action did not go through: ${err.message}`);
    }
    executed += 1;
    done.push(detail);
    onAudit('action_executed', { action_type: phaseType, risk });
    if (!(await gate())) return;

    // Let the screen settle before looking. Clicking and photographing in the
    // same instant catches the previous frame and the model then repeats
    // itself, which is most of what "inconsistent" looked like.
    await computer.wait(action.type === 'key' || action.type === 'type' ? 240 : 150);

    onPhase('Observing');
    try {
      shot = await computer.capture();
    } catch (err) {
      return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
    }

    // Whether anything actually happened. Comparing the two screenshots is
    // the only honest answer, and it is the single most useful thing to tell
    // a model that is about to repeat itself.
    const unchanged = sameScreen(lastGrey, shot.grey);
    lastGrey = shot.grey;

    // The provider requires the assistant turn that made the call and a tool
    // result answering it, in that order, before the next user turn.
    const rawCall = choice.call.raw;
    messages.push(
      { role: 'assistant', content: null, tool_calls: [rawCall] },
      { role: 'tool', tool_call_id: rawCall.id, content: unchanged ? 'done (screen unchanged)' : 'done' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Task: ${task}`,
              `Done so far: ${done.map((d, i) => `${i + 1}. ${d}`).join('; ')}`,
              unchanged
                ? 'The screen is pixel-for-pixel identical to before that action, '
                  + 'so it had no effect. Do something different, or finish.'
                : 'Here is the screen now.',
            ].join('\n'),
          },
          { type: 'image_url', image_url: { url: `data:${shot.mime};base64,${shot.b64}`, detail: 'high' } },
        ],
      },
    );
  }

  fail('turn_limit', `Pico stopped after ${maxTurns} actions, the configured limit.`);
}

/** Coordinates arrive in the screenshot's space; the mouse works in another. */
async function execute(computer, action, shot) {
  const at = () => shot.toScreen(action.x ?? 0, action.y ?? 0);

  switch (action.type) {
    case 'click': { const p = at(); return computer.click(p.x, p.y, 'left'); }
    case 'double_click': { const p = at(); return computer.doubleClick(p.x, p.y); }
    case 'right_click': { const p = at(); return computer.click(p.x, p.y, 'right'); }
    case 'move': { const p = at(); return computer.move(p.x, p.y); }
    case 'scroll': {
      const p = Number.isFinite(action.x) ? at() : computer.pointer;
      return computer.scroll(p.x, p.y, 0, action.dy ?? 3);
    }
    case 'type': return computer.type(action.text ?? '');
    case 'key': return computer.keypress(action.keys ?? []);
    case 'wait': return computer.wait(900);
    case 'screenshot': return undefined;   // the observation step takes one
    default: return undefined;
  }
}

export { ALLOW };
