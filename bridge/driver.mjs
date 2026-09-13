/* ==========================================================================
   Pico — the loop that does the work.

   Decide once, then carry it out. That is the whole shape of it.

   WHY IT IS SHAPED THIS WAY
   The first version asked one model, every single turn, "what next?" with the
   whole task in front of it. That answers a question nobody asked: given a
   task and a screen, there is always something else that could plausibly be
   done next. So "click the play button" became click play, then the next
   thing, then the next — accurate each time, and far past what was wanted.

   Now the task is planned once, into the fewest steps that complete it and a
   plain statement of what "done" looks like. After that the loop only ever
   carries out the current step. When the steps run out, the run is over.
   Overrunning is not discouraged by the prompt; it is structurally impossible.

   WHICH MODEL DOES WHAT
   Planning is the part that needs judgement, so it gets the strongest model,
   once. Execution is narrow — "do this one step" — so it gets the cheapest
   model that can actually do it, and that split is measured rather than
   assumed:

     keyboard steps   nano. Typing and key chords need no aim, and it is the
                      fastest and cheapest thing available.
     pointer steps    mini. Nano was measured putting the Start button 300px
                      from where it is, which misses every time; mini lands
                      on it. Aiming needs a little reasoning budget, so
                      pointer steps get one and keyboard steps do not.

   Each execution turn is built fresh from the plan and the current screen
   rather than accumulating a conversation. A short prompt cannot drift, and
   it keeps one image per call instead of a growing pile of them.

   WHAT IT SENDS
   A downscaled JPEG of the desktop, each turn, to the model provider. The
   settings panel says so in as many words; it is not buried here.
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

/** Turns allowed per planned step before the run is abandoned. */
const TURNS_PER_STEP = 4;

/* --------------------------------------------------------------------------
   Planning
   -------------------------------------------------------------------------- */
const PLAN_TOOL = [{
  type: 'function',
  function: {
    name: 'plan',
    description: 'State the smallest complete plan for the task.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The fewest steps that complete exactly what was asked. '
            + 'Usually one. Never add steps that were not asked for.',
          items: {
            type: 'object',
            properties: {
              do: {
                type: 'string',
                description: 'Exactly ONE action, six words or fewer: a single '
                  + 'click, a single key combination, or a single piece of text '
                  + 'typed. Never combine two — "press Win, type Notepad, Enter" '
                  + 'is three steps, not one.',
              },
              kind: {
                type: 'string',
                enum: ['pointer', 'keyboard'],
                description: 'pointer = has to aim at something on screen. '
                  + 'keyboard = typing or a key combination, no aiming.',
              },
            },
            required: ['do', 'kind'],
          },
        },
        done_when: {
          type: 'string',
          description: 'What will be visible on screen once the task is complete.',
        },
        already_done: {
          type: 'boolean',
          description: 'True if the screen already shows the task as complete.',
        },
      },
      required: ['steps', 'done_when', 'already_done'],
    },
  },
}];

const PLAN_SYSTEM = (shot, windowTitle) => [
  'You plan work for someone operating a Windows 11 desktop.',
  `The screenshot is ${shot.width} by ${shot.height} pixels.`,
  windowTitle ? `In front right now: ${windowTitle}.` : '',
  '',
  'Plan the smallest set of steps that does exactly what was asked, and',
  'nothing beyond it. If one click does it, the plan is one step.',
  '',
  'Each step is one single action. Opening an app from the Start menu is',
  'three steps: press Win, then type its name, then press Enter.',
  '',
  'Do not add steps that were not asked for. Do not tidy up, continue a',
  'sequence, verify by opening something else, or do the obvious next thing.',
  'Finishing early is correct; doing more than was asked is not.',
  '',
  'If the screen already shows what was asked, say so with already_done.',
].filter(Boolean).join('\n');

/* --------------------------------------------------------------------------
   Executing
   -------------------------------------------------------------------------- */
const ACT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Perform one action towards the current step.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'right_click', 'type', 'key',
                   'scroll', 'move', 'wait'],
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
          why: { type: 'string', description: 'Six words or fewer, for the person watching.' },
        },
        required: ['action', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'step_done',
      description: 'The current step is already complete on screen. Move to the next one.',
      parameters: { type: 'object', properties: {}, required: [] },
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
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
  },
];

const ACT_SYSTEM = (shot, windowTitle) => [
  'You operate a Windows 11 desktop, one action at a time.',
  '',
  `The screenshot is ${shot.width} by ${shot.height} pixels. Give every`,
  'coordinate in that space, measured from the top-left corner. Look at where',
  'the control actually is in the image rather than guessing from memory.',
  windowTitle ? `In front right now: ${windowTitle}.` : '',
  '',
  'Carry out THE CURRENT STEP and nothing else. The rest of the plan is not',
  'yours to do and later steps are not yours to start. If the current step is',
  'already done on screen, call step_done.',
  '',
  'Prefer the keyboard where it is more reliable than aiming: the Windows key',
  'opens Start, ctrl+l focuses a browser address bar, ctrl+t opens a tab.',
  '',
  'The black bar at the top centre of the screen is Pico itself. It is not',
  'part of any task — never click or type into it.',
  '',
  'Never type a password, PIN, card number, one-time code, or answer a',
  'CAPTCHA. Call handover instead.',
].filter(Boolean).join('\n');

const imagePart = (shot) => ({
  type: 'image_url',
  image_url: { url: `data:${shot.mime};base64,${shot.b64}`, detail: 'high' },
});

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
export async function runTask({ task, computer, llm, maxTurns = 24, hooks = {} }) {
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

  const look = async () => computer.capture();

  onPhase('Starting');
  onAudit('run_started', { metadata: { model: llm.tiers.plan } });

  let shot;
  try {
    onPhase('Observing');
    shot = await look();
  } catch (err) {
    return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
  }
  if (!(await gate())) return;

  /* --- decide, once ------------------------------------------------------ */
  onPhase('Thinking');
  let plan;
  try {
    const choice = await llm.toolCall(
      [
        { role: 'system', content: PLAN_SYSTEM(shot, computer.focusedWindow()) },
        { role: 'user', content: [{ type: 'text', text: `Task: ${task}` }, imagePart(shot)] },
      ],
      { model: llm.tiers.plan, tools: PLAN_TOOL, effort: 'low', maxTokens: 1200 },
    );
    plan = choice.call?.args;
  } catch (err) {
    return fail('model_error', err.message);
  }
  if (!(await gate())) return;

  const steps = Array.isArray(plan?.steps) ? plan.steps.filter((s) => s?.do).slice(0, 6) : [];
  if (!steps.length || plan.already_done) {
    onPhase('Completed');
    onAudit('run_completed', { metadata: { completed_actions: 0, already_done: true } });
    onSummary(plan?.already_done
      ? 'That was already the case, so I left it alone.'
      : 'There was nothing to do for that.');
    return;
  }

  onAudit('plan_made', {
    metadata: { steps: steps.length, done_when: plan.done_when },
  });
  if (process.env.PICO_DEBUG) {
    console.log(`[plan] ${steps.map((s, i) => `${i + 1}.${s.kind}:${s.do}`).join(' | ')}`);
  }

  /* --- carry it out ------------------------------------------------------ */
  const budget = Math.min(maxTurns, (steps.length * TURNS_PER_STEP) + 2);
  const done = [];
  let stepIndex = 0;
  let lastSignature = null;
  let lastAction = null;
  let repeats = 0;
  let lastGrey = shot.grey;

  for (let turn = 0; turn < budget && stepIndex < steps.length; turn++) {
    if (!(await gate())) return;

    const step = steps[stepIndex];
    const windowTitle = computer.focusedWindow();

    // Keyboard steps need no aim, so they go to the cheapest model. Pointer
    // steps have to find something in the image, which nano cannot do — and
    // aiming needs a little reasoning budget to be reliable. Anything that
    // has already stalled is escalated regardless.
    const stuck = repeats >= 2;
    const pointer = step.kind === 'pointer';
    const model = stuck ? llm.tiers.plan : (pointer ? llm.tiers.see : llm.tiers.fast);
    const effort = (stuck || pointer) ? 'low' : 'none';

    onPhase('Thinking');
    let choice;
    try {
      choice = await llm.toolCall(
        [
          { role: 'system', content: ACT_SYSTEM(shot, windowTitle) },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `Task: ${task}`,
                  `Plan: ${steps.map((s, i) => `${i + 1}. ${s.do}`).join(' ')}`,
                  done.length ? `Already done: ${done.join('; ')}` : null,
                  `CURRENT STEP (${stepIndex + 1} of ${steps.length}): ${step.do}`,
                  'Do only that step.',
                  // Without this it re-sends the identical action and the run
                  // dies on the stuck check having learned nothing.
                  repeats > 0
                    ? `Your last attempt (${describe(lastAction)}) changed nothing on `
                      + 'screen. Do it a different way, or call step_done if it is '
                      + 'already the case.'
                    : null,
                ].filter(Boolean).join('\n'),
              },
              imagePart(shot),
            ],
          },
        ],
        { model, tools: ACT_TOOLS, effort, maxTokens: pointer || stuck ? 1200 : 700 },
      );
    } catch (err) {
      return fail('model_error', err.message);
    }
    if (!(await gate())) return;

    const name = choice.call?.name;
    const args = choice.call?.args ?? {};

    if (!choice.call || name === 'step_done') {
      stepIndex += 1;
      repeats = 0;
      lastSignature = null;
      continue;
    }

    if (name === 'handover') {
      onPhase('AwaitingTakeover');
      onAudit('takeover_requested', { metadata: { reason: args.reason } });
      await onHandover({
        id: `tko_${Date.now()}`,
        reason: args.reason || 'This step needs you.',
        appName: windowTitle,
      });
      if (!(await gate())) return;
      onPhase('Observing');
      try { shot = await look(); } catch (err) {
        return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
      }
      done.push(`you did it yourself: ${step.do}`);
      stepIndex += 1;
      continue;
    }

    // --- an action ---------------------------------------------------------
    const action = { ...args, type: args.action };

    // A model with nothing to push back on it will happily press Escape
    // thirty times in a row. It did exactly that the first time this ran.
    const sig = signature(action);
    repeats = sig === lastSignature ? repeats + 1 : 0;
    lastSignature = sig;
    lastAction = action;
    if (repeats >= STUCK_AFTER) {
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'stuck' } });
      onSummary(
        `I stopped: the same step — ${describe(action).toLowerCase()} — kept `
        + 'having no effect, so repeating it was not going to get anywhere.',
      );
      return;
    }

    const risk = assess(action, windowTitle);
    const detail = describe(action);
    const phaseType = ACTION_PHASE[action.type] || 'Move';
    onAudit('action_assessed', { action_type: phaseType, risk });

    if (risk.decision === 'Handover') {
      onPhase('AwaitingTakeover');
      await onHandover({ id: `tko_${Date.now()}`, reason: risk.reason, appName: windowTitle });
      if (!(await gate())) return;
      done.push(`you did it yourself: ${step.do}`);
      stepIndex += 1;
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
    // first keystrokes of the run would be typed into Pico itself. Skip and
    // let the next turn click into the right window first. The Windows key is
    // exempt: it opens Start wherever focus is.
    const keyboardAction = action.type === 'type'
      || (action.type === 'key' && !(action.keys || []).some((k) => /^(?:win|meta|super|cmd)$/i.test(k)));
    if (keyboardAction && isPicoWindow(windowTitle)) {
      onAudit('action_skipped', { metadata: { reason: 'focus is on Pico itself' } });
      continue;
    }

    onPhase('Acting');
    onAction({ type: phaseType, detail });
    try {
      await execute(computer, action, shot);
    } catch (err) {
      return fail('action_failed', `That action did not go through: ${err.message}`);
    }
    onAudit('action_executed', { action_type: phaseType, risk });
    if (!(await gate())) return;

    // Let the screen settle before looking. Clicking and photographing in the
    // same instant catches the previous frame and the model then repeats
    // itself, which is most of what "inconsistent" looked like.
    await computer.wait(action.type === 'key' || action.type === 'type' ? 240 : 150);

    onPhase('Observing');
    try { shot = await look(); } catch (err) {
      return fail('screen_unavailable', `Pico could not see the screen: ${err.message}`);
    }

    // Something happened, so treat the step as carried out and move on. A
    // step that genuinely needs a second action gets it: the next turn sees
    // the next step, and if that is already satisfied it says so.
    const moved = !sameScreen(lastGrey, shot.grey);
    if (process.env.PICO_DEBUG) {
      console.log(`[turn ${turn}] step ${stepIndex + 1}/${steps.length} "${step.do}" `
        + `via ${model} -> ${sig} | screen ${moved ? 'changed' : 'UNCHANGED'} | repeats=${repeats}`);
    }
    if (moved) {
      done.push(detail);
      stepIndex += 1;
      repeats = 0;
      lastSignature = null;
    }
    lastGrey = shot.grey;
  }

  /* --- and stop ---------------------------------------------------------- */
  const verdict = await verify(llm, { task, doneWhen: plan.done_when, shot, done });
  onPhase(verdict.succeeded ? 'Completed' : 'Stopped');
  onAudit(verdict.succeeded ? 'run_completed' : 'run_stopped', {
    metadata: { completed_actions: done.length, planned: steps.length },
  });
  onSummary(verdict.summary);
}

const REPORT_TOOL = [{
  type: 'function',
  function: {
    name: 'report',
    description: 'Say whether the task actually got done, judging by the screen.',
    parameters: {
      type: 'object',
      properties: {
        succeeded: { type: 'boolean', description: 'Is what was asked for actually true on screen now?' },
        summary: {
          type: 'string',
          description: 'One short past-tense sentence for the person. If it did '
            + 'not work, say plainly what happened instead.',
        },
      },
      required: ['succeeded', 'summary'],
    },
  },
}];

/**
 * Look at the final screen and say honestly whether it worked.
 *
 * Worth a whole extra call because the alternative was reciting the plan back
 * as though it had happened: a run that opened nothing still reported
 * "Notepad was opened and hello there was typed", which is the one kind of
 * wrong an agent must never be.
 */
async function verify(llm, { task, doneWhen, shot, done }) {
  const plain = done.length
    ? `Done: ${done.join('; ')}.`
    : 'Nothing was carried out.';
  try {
    const choice = await llm.toolCall(
      [
        {
          role: 'system',
          content: 'You check whether a desktop task actually got done. Judge only '
            + 'by the screenshot. Do not be generous: if what was asked for is not '
            + 'visibly true, it did not work.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Task: ${task}`,
                doneWhen ? `Complete when: ${doneWhen}` : null,
                `Actions carried out: ${done.length ? done.join('; ') : 'none'}`,
                'Here is the screen now.',
              ].filter(Boolean).join('\n'),
            },
            imagePart(shot),
          ],
        },
      ],
      { model: llm.tiers.see, tools: REPORT_TOOL, effort: 'low', maxTokens: 900 },
    );
    const r = choice.call?.args;
    if (r && typeof r.summary === 'string' && r.summary.trim()) {
      return { succeeded: Boolean(r.succeeded), summary: r.summary.trim() };
    }
  } catch {
    /* fall through to the plain account below */
  }
  return { succeeded: done.length > 0, summary: plain };
}

/**
 * One plain past-tense sentence. The plan's steps are imperatives ("click the
 * Start button"), and stitching those together reads like an instruction
 * rather than a report — so the cheapest model turns them into a sentence.
 * If it is slow or unavailable the plain list still says what happened.
 */
async function summarise(llm, task, done) {
  if (!done.length) return 'Nothing needed doing.';
  const plain = done.join(', then ');
  try {
    const line = await llm.summarise(task, done);
    if (line) return line;
  } catch {
    /* a missing sentence must not fail a run that succeeded */
  }
  return `Done: ${plain}.`;
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
    default: return undefined;
  }
}

export { ALLOW };
