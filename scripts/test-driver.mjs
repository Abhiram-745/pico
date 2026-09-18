#!/usr/bin/env node
/* ==========================================================================
   The task loop, against a pretend desktop and a scripted model.

   Nothing here touches the real mouse, keyboard or screen, and no model is
   called: a fake computer keeps a list of windows and a text field, and the
   "model" answers each call from a script. That is enough to check the
   parts of the loop that are about decisions rather than pixels:

     - another window taking the screen is put back once, and named the
       second time
     - a step that keeps getting nowhere re-plans the rest instead of ending
     - "done" is settled by what Windows says when it can be
     - skipping a step and correcting Halo while it runs

   Run with: node scripts/test-driver.mjs
   ========================================================================== */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HALO_HOME = mkdtempSync(join(tmpdir(), 'halo-test-'));
const { runTask, readFacts, contradicts } = await import('../bridge/driver.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

/* --- a pretend desktop ---------------------------------------------------- */
function desktop({ windows, front }) {
  const state = {
    windows: new Map(windows.map((w) => [w.hwnd, { ...w }])),
    front,
    value: '',
    screen: 1,           // bumped whenever something visibly changes
    typed: [],           // [{ text, into }]
    focusCalls: [],
    onForeground: null,  // (callNumber) => void, to take the screen mid-run
    fgCalls: 0,
    clicksChange: true,
  };
  const grey = () => new Uint8Array(64).fill((state.screen * 37) % 256);
  const shot = () => ({
    b64: '', mime: 'image/jpeg', width: 100, height: 60,
    physical: { width: 1000, height: 600 }, scale: 1, raw: null, grey: grey(),
    toPhysical: (x, y) => ({ x, y }), physToScreen: (x, y) => ({ x, y }), toScreen: (x, y) => ({ x, y }),
  });
  const win = (h) => (h ? { ...state.windows.get(h), hwnd: h } : null);
  const computer = {
    state,
    capture: async () => shot(),
    frame: async () => null,
    focusedWindow: () => win(state.front)?.title ?? '',
    available: async () => ({ ok: true }),
    foreground: async () => {
      state.fgCalls += 1;
      state.onForeground?.(state.fgCalls);
      return win(state.front);
    },
    focus: async (h) => { state.focusCalls.push(h); if (state.windows.has(h)) state.front = h; return true; },
    move: async () => {},
    click: async () => { if (state.clicksChange) state.screen += 1; },
    doubleClick: async () => { state.screen += 1; },
    drag: async () => {},
    wheel: async () => {},
    type: async (t) => { state.typed.push({ text: t, into: state.front }); state.value += t; state.screen += 1; },
    keypress: async () => { state.screen += 1; },
    // A real timer, briefly: a wait that resolves as a microtask never lets
    // anything else run, and the loop that waits for a person would spin.
    wait: (ms = 0) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    sense: {
      hit: async () => null,
      near: async () => null,
      wake: async () => null,
      windows: async () => [...state.windows.entries()].map(([hwnd, w]) => ({ hwnd, minimized: false, tool: false, rect: [0, 0, 500, 400], ...w })),
      focused: async () => ({ found: true, title: win(state.front)?.title, at: { type: 'Document', name: 'Text editor' }, value: state.value }),
    },
  };
  return computer;
}

/** A model that answers from a script: each entry is a function of the call. */
function scripted(script) {
  const calls = [];
  const llm = {
    tiers: { plan: 'plan-model', see: 'see-model', fast: 'fast-model' },
    calls,
    respond: async (req) => {
      const tool = req.tools?.[0]?.function?.name;
      calls.push({ tool, model: req.model, text: req.content?.find((c) => c.type === 'text')?.text ?? '' });
      const next = script.shift();
      if (!next) throw new Error(`the script ran out at a "${tool}" call`);
      const answer = typeof next === 'function' ? next({ tool, req, calls }) : next;
      return { call: answer, text: '' };
    },
  };
  return llm;
}

const plan = (steps, extra = {}) => ({ name: 'plan', args: { steps, done_when: 'it is done', already_done: false, ...extra } });
const act = (args) => ({ name: 'act', args: { why: 'doing the step', ...args } });

function run({ computer, llm, task = 'type hello there', hooks = {}, context = {} }) {
  const events = { phases: [], summaries: [], plans: [], errors: [], audits: [] };
  const done = runTask({
    task,
    computer,
    llm,
    maxTurns: 30,
    context,
    hooks: {
      onPhase: (p) => events.phases.push(p),
      onSummary: (t) => events.summaries.push(t),
      onPlan: (p) => events.plans.push(JSON.parse(JSON.stringify(p))),
      onError: (e) => events.errors.push(e),
      onAudit: (e, extra) => events.audits.push({ e, ...extra }),
      ...hooks,
    },
  });
  return { done, events };
}

const NOTEPAD = { hwnd: '100', title: 'Untitled - Notepad', process: 'Notepad' };
const VIDEO = { hwnd: '200', title: 'Big Buck Bunny - YouTube - Google Chrome', process: 'chrome' };


/* --- 1. focus taken once: brought back, and the text still goes in --------- */
console.log('focus taken once');
{
  const computer = desktop({ windows: [NOTEPAD, VIDEO], front: '100' });
  const llm = scripted([
    plan([{ do: 'Type hello there', kind: 'keyboard' }]),
    // While this decision is being made, the video takes the screen.
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
    act({ action: 'type', text: 'hello there' }),
  ]);
  const { done, events } = run({ computer, llm });
  const result = await done;
  check('nothing was typed into the video', computer.state.typed.every((t) => t.into === '100'), JSON.stringify(computer.state.typed));
  check('Notepad was brought back', computer.state.focusCalls.includes('100'));
  check('the text went into Notepad', computer.state.typed.some((t) => t.into === '100' && t.text === 'hello there'));
  check('the run finished', events.phases.at(-1) === 'Completed', `${events.phases.join(' > ')} ${JSON.stringify(events.errors)}`);
  check('judged by the facts, without a verifier call', !llm.calls.some((c) => c.tool === 'report'), llm.calls.map((c) => c.tool).join(','));
  check('it says what it did', /typed "hello there"/i.test(events.summaries.at(-1) ?? ''), events.summaries.at(-1));
  check('it reports success', result?.succeeded === true);
}

/* --- 2. focus taken twice: stops, and names what took it ------------------- */
console.log('focus taken twice');
{
  const computer = desktop({ windows: [NOTEPAD, VIDEO], front: '100' });
  const llm = scripted([
    plan([{ do: 'Type hello there', kind: 'keyboard' }]),
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
  ]);
  const { done, events } = run({ computer, llm });
  await done;
  check('nothing was typed at all', computer.state.typed.length === 0, JSON.stringify(computer.state.typed));
  check('the run stopped', events.phases.at(-1) === 'Stopped', events.phases.join(' > '));
  check('the summary names the window that took the screen', (events.summaries.at(-1) ?? '').includes('Big Buck Bunny'), events.summaries.at(-1));
  check('it did not loop until the turns ran out', llm.calls.length === 3, `${llm.calls.length} model calls`);
}

/* --- 3. taken between steps, while Halo was only typing --------------------- */
console.log('focus taken between steps');
{
  const computer = desktop({ windows: [NOTEPAD, VIDEO], front: '100' });
  const llm = scripted([
    plan([{ do: 'Type hello', kind: 'keyboard' }, { do: 'Type there', kind: 'keyboard' }]),
    () => act({ action: 'type', text: 'hello ' }),
    // Taken while typing, so the step is looked at again rather than assumed.
    ({ req }) => {
      check('it is told the keys may have gone astray', /came to the front on its own/.test(req.content[0].text), req.content[0].text);
      return { name: 'step_done', args: {} };
    },
    () => act({ action: 'type', text: 'there' }),
  ]);
  // Right after the first text goes in and Halo has looked, the video jumps up.
  let armed = true;
  computer.state.onForeground = () => {
    if (armed && computer.state.typed.length === 1) { armed = false; computer.state.front = '200'; }
  };
  const { done, events } = run({ computer, llm, task: 'type hello there' });
  await done;
  check('put Notepad back without being asked', computer.state.focusCalls.includes('100'));
  check('both pieces of text went into Notepad', computer.state.typed.length === 2 && computer.state.typed.every((t) => t.into === '100'), JSON.stringify(computer.state.typed));
  check('finished', events.phases.at(-1) === 'Completed', `${events.phases.join(' > ')} | ${events.summaries.at(-1)}`);
}

/* --- 4. a click that changes nothing: re-planned, not abandoned ------------- */
console.log('re-plan after a miss');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  computer.state.clicksChange = false;
  const llm = scripted([
    plan([{ do: 'Click the View menu', kind: 'pointer' }, { do: 'Click Status bar', kind: 'pointer' }]),
    act({ action: 'click', x: 10, y: 5, target: 'the View menu' }),
    act({ action: 'click', x: 12, y: 5, target: 'the View menu' }),
    ({ tool, req }) => {
      check('the re-plan is told what went wrong', /changed nothing/i.test(req.content[0].text), req.content[0].text);
      computer.state.clicksChange = true;
      return { name: 'replan', args: { steps: [{ do: 'Press alt+v to open View', kind: 'keyboard' }, { do: 'Click Status bar', kind: 'pointer' }], already_done: false } };
    },
    act({ action: 'key', keys: ['alt', 'v'] }),
    act({ action: 'click', x: 20, y: 20, target: 'Status bar' }),
    { name: 'report', args: { succeeded: true, summary: 'Turned on the status bar.' } },
  ]);
  const { done, events } = run({ computer, llm, task: 'show the status bar in notepad' });
  await done;
  const last = events.plans.at(-1);
  check('the run finished instead of stopping at the miss', events.phases.at(-1) === 'Completed', `${events.phases.join(' > ')} | ${events.summaries.at(-1)}`);
  check('the failed step is still shown, marked', last?.steps?.[0]?.status === 'failed', JSON.stringify(last));
  check('the new steps follow it', last?.steps?.[1]?.do === 'Press alt+v to open View' && last.steps.length === 3, JSON.stringify(last?.steps));
  check('a click leaves nothing to check, so the verifier was asked', llm.calls.at(-1).tool === 'report');
}

/* --- 5. skipping a step while it runs --------------------------------------- */
console.log('skip');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const pending = [];
  const llm = scripted([
    plan([{ do: 'Type hello', kind: 'keyboard' }, { do: 'Type goodbye', kind: 'keyboard' }]),
    () => { pending.push({ type: 'skip', index: 0 }); return act({ action: 'type', text: 'hello' }); },
    act({ action: 'type', text: 'goodbye' }),
    { name: 'report', args: { succeeded: true, summary: 'Typed goodbye.' } },
  ]);
  const { done, events } = run({ computer, llm, hooks: { steer: () => pending.splice(0) } });
  await done;
  check('the skipped step\'s action was not carried out', !computer.state.typed.some((t) => t.text === 'hello'), JSON.stringify(computer.state.typed));
  check('the next step was', computer.state.typed.some((t) => t.text === 'goodbye'));
  check('it is marked skipped', events.plans.at(-1)?.steps?.[0]?.status === 'skipped', JSON.stringify(events.plans.at(-1)));
}

/* --- 6. "no, the other one" ------------------------------------------------ */
console.log('correction');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const pending = [];
  const llm = scripted([
    plan([{ do: 'Click the first result', kind: 'pointer' }]),
    () => { pending.push({ type: 'correct', text: 'no, the other one' }); return act({ action: 'click', x: 10, y: 10, target: 'the first result' }); },
    ({ req }) => {
      check('the correction reaches the planner, word for word', req.content[0].text.includes('no, the other one'), req.content[0].text);
      return { name: 'replan', args: { steps: [{ do: 'Click the second result', kind: 'pointer' }], already_done: false } };
    },
    act({ action: 'click', x: 10, y: 30, target: 'the second result' }),
    { name: 'report', args: { succeeded: true, summary: 'Opened the second result.' } },
  ]);
  const { done, events } = run({ computer, llm, task: 'click the search result', hooks: { steer: () => pending.splice(0) } });
  await done;
  const steps = events.plans.at(-1)?.steps ?? [];
  check('the corrected step is marked changed', steps[0]?.status === 'changed', JSON.stringify(steps));
  check('and replaced by what they meant', steps[1]?.do === 'Click the second result' && steps[1]?.status === 'done', JSON.stringify(steps));
  check('the first click never happened', computer.state.screen === 2, `screen=${computer.state.screen}`);
}

/* --- 7. facts, on their own ------------------------------------------------ */
console.log('facts');
{
  const facts = {
    front: NOTEPAD,
    focused: { found: true, title: 'Untitled - Notepad', at: { type: 'Document', name: 'Text editor' }, value: 'hello  there' },
    windows: [NOTEPAD],
  };
  const typedOk = readFacts(facts, {
    steps: [{ do: 'Open Notepad', kind: 'open', status: 'done' }, { do: 'Type hello there', kind: 'keyboard', status: 'done' }],
    typed: [{ text: 'hello there' }],
    opened: [{ kind: 'app', label: 'Notepad', outcome: 'opened' }],
  });
  check('open + type, both confirmed: settled as success', typedOk.settled?.succeeded === true, JSON.stringify(typedOk));
  check('the summary says both', /opened Notepad and typed "hello there"/i.test(typedOk.settled?.summary ?? ''), typedOk.settled?.summary);

  const sent = readFacts({ ...facts, focused: { ...facts.focused, value: '' } }, {
    steps: [{ do: 'Type hello there', kind: 'keyboard', status: 'done' }, { do: 'Press Enter', kind: 'keyboard', status: 'done' }],
    typed: [{ text: 'hello there' }],
    pressed: ['enter'],
  });
  check('a field emptied by Enter is not called a failure by facts alone', sent.settled === null, JSON.stringify(sent));
  check('but the verifier is told the field is empty', sent.lines.some((l) => /not in the focused field/.test(l)), sent.lines.join(' | '));

  const clicked = readFacts(facts, {
    steps: [{ do: 'Click Save', kind: 'pointer', status: 'done' }],
  });
  check('a click cannot be settled by facts', clicked.settled === null);
}

/* --- 8. open, through the one opener ---------------------------------------- */
console.log('what an open window is showing');
{
  // apps.open itself launches real programs, so it is not run from here; the
  // part of it that decides what to say about an already-open app is.
  const apps = await import('../bridge/apps.mjs');
  check('a file named in the title', apps.showing('Pico.sln - Notepad', 'Notepad') === 'Pico.sln');
  check('a blank one is showing nothing worth saying', apps.showing('Untitled - Notepad', 'Notepad') === null);
  check('an unsaved file, without its asterisk', apps.showing('*notes.txt - Notepad', 'Notepad') === 'notes.txt');
  check('a title that is only the app', apps.showing('Spotify Premium', 'Spotify') === null);
}

/* --- 9. the wrong row, refused by name ------------------------------------
   Told to open Locked chats, Halo once pressed Archived: the row above it,
   same shape, and nothing noticed. The accessibility layer knew the name the
   whole time. contradicts() decides, and must be reluctant — too eager and
   Halo stops clicking things at all. */
console.log('the wrong row');
{
  const agrees = [
    ['Locked chats', 'Locked chats'],
    ['Send button', 'Send'],
    ['Send', 'Send message'],
    ['the address bar', 'Address and search bar'],
    ['Compose', 'Compose '],
    ['Locked chats', ''],
    ['', 'Archived'],
    ['it', 'Archived'],
    ['the button', 'Archived'],
    ['Locked chats', 'chat'],
    ['the blue Send button at the bottom right of the chat', 'Send'],
  ];
  for (const [want, found] of agrees) check(`"${want}" vs "${found}" agrees`, !contradicts(want, found));
  const contradict = [
    ['Locked chats', 'Archived'],
    ['Locked chats', 'Starred messages'],
    ['Drafts', 'Sent'],
    ['Reply', 'Forward'],
    ['Mum', 'Football Lads 2024'],
  ];
  for (const [want, found] of contradict) check(`"${want}" vs "${found}" contradicts`, contradicts(want, found));

  // In the loop: refused once with the real name said back, then allowed.
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  let clicks = 0;
  computer.click = async () => { clicks += 1; computer.state.screen += 1; };
  computer.sense.hit = async () => ({ found: true, at: { type: 'ListItem', name: 'Archived' }, layers: [], window: { title: 'WhatsApp' } });
  const llm = scripted([
    plan([{ do: 'Open Locked chats', kind: 'pointer' }]),
    act({ action: 'click', x: 10, y: 40, target: 'Locked chats' }),
    ({ req }) => {
      check('the model is told what was really there', /called "Archived", which is not "Locked chats"/.test(req.content[0].text), req.content[0].text);
      return act({ action: 'click', x: 10, y: 60, target: 'Locked chats' });
    },
    { name: 'report', args: { succeeded: true, summary: 'Opened Locked chats.' } },
  ]);
  const { done, events } = run({ computer, llm, task: 'show my locked chats in whatsapp' });
  await done;
  check('refused once, then the second click went through', clicks === 1, `clicks=${clicks}`);
  check('and the run finished', events.phases.at(-1) === 'Completed', events.phases.join(' > '));
}

/* --- 10. guide mode: points, waits, and touches nothing --------------------
   The one mode where Halo does not use the mouse or the keyboard at all. It
   has to stay that way: a guide that clicks for you is not a guide. */
console.log('guide mode');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const touched = [];
  for (const m of ['click', 'doubleClick', 'type', 'keypress', 'drag', 'wheel']) {
    computer[m] = async () => { touched.push(m); };
  }
  // Only `move` is allowed to be called — and only because parking is off.
  computer.move = async () => { touched.push('move'); };

  const pointed = [];
  const guide = {
    point: (x, y, words) => { pointed.push({ x, y, words }); return true; },
    say: (words) => { pointed.push({ words }); return true; },
    hide: () => { pointed.push({ hidden: true }); return true; },
  };

  // The person does each step a moment after being shown it.
  const doesIt = () => setTimeout(() => { computer.state.screen += 5; }, 600);
  const origPoint = guide.point;
  const origSay = guide.say;
  guide.point = (x, y, words) => { doesIt(); return origPoint(x, y, words); };
  guide.say = (words) => { doesIt(); return origSay(words); };

  const llm = scripted([
    plan([{ do: 'Click the address bar', kind: 'pointer' }, { do: 'Type halo.dev', kind: 'keyboard' }]),
    act({ action: 'click', x: 40, y: 10, target: 'the address bar' }),
    act({ action: 'type', text: 'halo.dev' }),
    { name: 'report', args: { succeeded: true, summary: 'You opened halo.dev.' } },
  ]);
  const { done, events } = run({ computer, llm, task: 'put halo.dev in the address bar', context: { guide } });
  await done;

  check('nothing was clicked, typed or pressed', touched.length === 0, touched.join(','));
  check('it pointed at the control it found', pointed.some((p) => p.words === 'Click address bar' && Number.isFinite(p.x)), JSON.stringify(pointed.slice(0, 3)));
  check('and said what to type', pointed.some((p) => String(p.words).startsWith('Type: halo.dev')), JSON.stringify(pointed));
  check('it put the arrow away at the end', pointed.at(-1)?.hidden === true, JSON.stringify(pointed.at(-1)));
  check('the steps were marked done as the person did them', events.plans.at(-1)?.steps?.every((s) => s.status === 'done'), JSON.stringify(events.plans.at(-1)?.steps));
  check('and it finished', events.phases.at(-1) === 'Completed', events.phases.join(' > '));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
