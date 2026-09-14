#!/usr/bin/env node
/* ==========================================================================
   The planner, and the two ways it used to let a person down.

   1. IT ASKED, WAS ANSWERED, AND THREW THE ANSWER AWAY.
      It asked what to type into Google, was told "lovable.dev and then open a
      project and see it", and replied "There was nothing to do for that."
      What happened: the second planning pass could still ask a question, so
      it asked another one; only one is allowed, so the loop broke out holding
      an empty plan, and an empty plan printed that line. Fixed by taking the
      question field off the tool for the second pass — see PLAN_TOOL_SETTLED.

   2. IT CLICKED THE WRONG ROW AND NEVER KNEW.
      Told to open Locked chats it pressed Archived. The accessibility layer
      knew the name of what was under the pointer the whole time; now the
      driver reads it before committing. contradicts() decides, and it has to
      be reluctant — too eager and Pico stops clicking things at all.

   Run with: node scripts/test-driver.mjs
   ========================================================================== */

import { runTask, contradicts, PLAN_TOOL, PLAN_TOOL_SETTLED } from '../bridge/driver.mjs';

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) return;
  failures += 1;
  console.error(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
};

/* --------------------------------------------------------------------------
   Stubs. Just enough of a screen and a model to drive the loop.
   -------------------------------------------------------------------------- */
const frame = () => ({
  width: 1920,
  height: 1080,
  mime: 'image/png',
  b64: '',
  grey: new Uint8Array(64),
  scale: 1,
  toScreen: (x, y) => ({ x, y }),
});

function stubComputer(overrides = {}) {
  return {
    capture: async () => frame(),
    park: () => {},
    focusedWindow: () => 'Google Chrome',
    wait: async () => {},
    click: async () => {},
    move: async () => {},
    type: async () => {},
    keypress: async () => {},
    scroll: async () => {},
    drag: async () => {},
    doubleClick: async () => {},
    pointer: { x: 0, y: 0 },
    ...overrides,
  };
}

/** A model that returns the given tool calls in order, recording what it saw. */
function stubLLM(calls) {
  const seen = [];
  return {
    tiers: { plan: 'plan', see: 'see', fast: 'fast' },
    seen,
    async toolCall(messages, opts) {
      seen.push({ messages, opts });
      const next = calls.shift();
      if (!next) return { call: null };
      return { call: next };
    },
  };
}

const collect = () => {
  const out = { summary: null, phases: [], error: null, questions: [] };
  return {
    out,
    hooks: {
      gate: async () => true,
      onPhase: (p) => out.phases.push(p),
      onSummary: (t) => { out.summary = t; },
      onError: (e) => { out.error = e; },
      onQuestion: async (q) => { out.questions.push(q.text); return 'lovable.dev and then open a project'; },
    },
  };
};

/* --------------------------------------------------------------------------
   1. The tool for the second pass cannot ask
   -------------------------------------------------------------------------- */
{
  const first = PLAN_TOOL[0].function.parameters.properties;
  const second = PLAN_TOOL_SETTLED[0].function.parameters.properties;
  ok('the first plan pass may ask a question', 'question' in first);
  ok('the second plan pass may not', !('question' in second));
  ok('the second pass still plans', 'steps' in second && 'done_when' in second);
}

/* --------------------------------------------------------------------------
   2. An answered question produces a plan, not "nothing to do"
   -------------------------------------------------------------------------- */
{
  const llm = stubLLM([
    // pass 1: asks
    { name: 'plan', args: { steps: [], done_when: '', already_done: false, question: 'What would you like me to type into Google?' } },
    // pass 2: plans
    { name: 'plan', args: { steps: [{ do: 'Click the address bar', kind: 'pointer' }], done_when: 'lovable.dev is open', already_done: false } },
    // the act turn, then the run ends when the model stops calling anything
    { name: 'step_done', args: {} },
    { name: 'report', args: { succeeded: true, summary: 'Opened lovable.dev.' } },
  ]);
  const { out, hooks } = collect();
  await runTask({ task: 'go to google and type something nice', computer: stubComputer(), llm, maxTurns: 4, hooks });

  ok('it asked once', out.questions.length === 1, `asked: ${JSON.stringify(out.questions)}`);
  ok('it did not say there was nothing to do',
    out.summary !== 'There was nothing to do for that.', `summary: ${out.summary}`);
  ok('it got as far as acting', out.phases.includes('Acting') || out.phases.includes('Thinking'));

  // The second pass must have been handed the exchange, not just a re-ask.
  const secondPass = llm.seen[1];
  const text = JSON.stringify(secondPass.messages);
  ok('the second pass sees the question it asked', text.includes('What would you like me to type'));
  ok('the second pass sees the answer', text.includes('lovable.dev'));
  ok('the second pass is given the tool that cannot ask',
    !('question' in secondPass.opts.tools[0].function.parameters.properties));
}

/* --------------------------------------------------------------------------
   3. A plan that still comes back empty says so honestly
   -------------------------------------------------------------------------- */
{
  const llm = stubLLM([
    { name: 'plan', args: { steps: [], done_when: '', already_done: false, question: 'Which one?' } },
    { name: 'plan', args: { steps: [], done_when: '', already_done: false } },
  ]);
  const { out, hooks } = collect();
  await runTask({ task: 'do the thing', computer: stubComputer(), llm, maxTurns: 4, hooks });

  ok('an answered question never ends in "nothing to do"',
    out.summary !== 'There was nothing to do for that.', `summary: ${out.summary}`);
  ok('the answer is quoted back so it is plainly not lost',
    String(out.summary).includes('lovable.dev'), `summary: ${out.summary}`);
}

/* --------------------------------------------------------------------------
   4. already_done still reports as done, not as a failure
   -------------------------------------------------------------------------- */
{
  const llm = stubLLM([
    { name: 'plan', args: { steps: [], done_when: 'it is open', already_done: true } },
  ]);
  const { out, hooks } = collect();
  await runTask({ task: 'open notepad', computer: stubComputer(), llm, maxTurns: 4, hooks });
  ok('already_done completes', out.phases.includes('Completed'), `phases: ${out.phases}`);
  ok('already_done says so', /already/i.test(String(out.summary)), `summary: ${out.summary}`);
}

/* --------------------------------------------------------------------------
   5. contradicts(): reluctant, and right about the case that caused it
   -------------------------------------------------------------------------- */
{
  const agrees = [
    ['Locked chats', 'Locked chats'],
    ['Send button', 'Send'],
    ['Send', 'Send message'],
    ['the address bar', 'Address and search bar'],
    ['Compose', 'Compose '],
    // no words worth comparing on one side is never a contradiction
    ['Locked chats', ''],
    ['', 'Archived'],
    ['it', 'Archived'],
    ['the button', 'Archived'],
    ['Locked chats', 'chat'],
  ];
  for (const [want, found] of agrees) {
    ok(`"${want}" vs "${found}" is not a contradiction`, !contradicts(want, found));
  }

  const contradict = [
    ['Locked chats', 'Archived'],
    ['Locked chats', 'Starred messages'],
    ['Drafts', 'Sent'],
    ['Reply', 'Forward'],
    ['Mum', 'Football Lads 2024'],
  ];
  for (const [want, found] of contradict) {
    ok(`"${want}" vs "${found}" is a contradiction`, contradicts(want, found));
  }
}

/* --------------------------------------------------------------------------
   6. A wrong target is refused once, and the model is told what was there
   -------------------------------------------------------------------------- */
{
  const llm = stubLLM([
    { name: 'plan', args: { steps: [{ do: 'Open Locked chats', kind: 'pointer' }], done_when: 'locked chats open', already_done: false } },
    { name: 'act', args: { action: 'click', x: 100, y: 200, why: 'Click Locked chats' } },
    { name: 'act', args: { action: 'click', x: 100, y: 260, why: 'Click Locked chats' } },
    { name: 'report', args: { succeeded: true, summary: 'Opened Locked chats.' } },
  ]);
  const clicks = [];
  const computer = stubComputer({
    probe: async () => 'Archived',
    click: async (x, y) => clicks.push([x, y]),
  });
  const { hooks } = collect();
  await runTask({ task: 'open locked chats', computer, llm, maxTurns: 3, hooks });

  // Turn one is refused before any click; turn two goes through even though
  // the probe still disagrees, because one refusal per step is the limit.
  ok('the first click is refused', clicks.length <= 1, `clicks: ${JSON.stringify(clicks)}`);
  const secondAct = llm.seen[2];
  const text = JSON.stringify(secondAct?.messages ?? '');
  ok('the model is told what was actually under the pointer', text.includes('Archived'), text.slice(0, 200));
  ok('and what it was supposed to be', text.includes('Locked chats'));
}

/* -------------------------------------------------------------------------- */
if (failures) {
  console.error(`\n  ${failures} driver check${failures > 1 ? 's' : ''} failed\n`);
  process.exit(1);
}
console.log('  driver checks passed');
