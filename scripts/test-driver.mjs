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
    clipboard: '',
    selection: '',       // what ctrl+c would pick up right now
    drift: 0,            // ambient change: a video, a clock, a notification
    shiftClicks: [],
    chords: [],          // [{ hold, press, times }]
    screen: 1,           // bumped whenever something visibly changes
    typed: [],           // [{ text, into }]
    focusCalls: [],
    onForeground: null,  // (callNumber) => void, to take the screen mid-run
    fgCalls: 0,
    clicksChange: true,
  };
  // `drift` is ambient movement nobody asked for — a video frame, a clock
  // minute, a notification — as distinct from `screen`, which is something
  // actually happening.
  const grey = () => new Uint8Array(64).fill(((state.screen * 37) + state.drift) % 256);
  /* Real RGBA frames, so the region check guide mode now relies on can be
     exercised: the left band is where the things being pointed at live and
     only moves when somebody actually does something; the right band is
     ambient — a video, a clock, a notification. */
  const RW = 800, RH = 600;
  const rawFrame = () => {
    const data = new Uint8Array(RW * RH * 4);
    for (let y = 0; y < RH; y++) {
      for (let x = 0; x < RW; x++) {
        const v = x < 200 ? (10 + ((state.screen * 53) % 200))
          : x > 400 ? (10 + ((state.drift * 27) % 200)) : 10;
        const i = ((y * RW) + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    return { data, width: RW, height: RH };
  };
  const shot = () => ({
    b64: '', mime: 'image/jpeg', width: 100, height: 60,
    physical: { width: 1000, height: 600 }, scale: 1, raw: rawFrame(), grey: grey(),
    toPhysical: (x, y) => ({ x, y }), physToScreen: (x, y) => ({ x, y }), toScreen: (x, y) => ({ x, y }),
  });
  const win = (h) => (h ? { ...state.windows.get(h), hwnd: h } : null);
  const computer = {
    state,
    capture: async () => shot(),
    frame: async () => rawFrame(),
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
    keypress: async (keys = []) => {
      const chord = keys.map((k) => String(k).toLowerCase()).join('+');
      // ctrl+c picks up whatever is "selected"; ctrl+v puts the clipboard
      // into the text field, the way the real ones do.
      if (chord === 'ctrl+c') { state.clipboard = state.selection; return; }
      if (chord === 'ctrl+v') { state.typed.push({ text: state.clipboard, into: state.front }); state.value += state.clipboard; }
      state.screen += 1;
    },
    shiftClick: async (x, y) => { state.shiftClicks.push({ x, y }); state.screen += 1; },
    holdAndPress: async (hold, press, times = 1) => {
      state.chords.push({ hold: [...hold], press: [...press], times });
      state.screen += 1;
    },
    readClipboard: async () => state.clipboard,
    writeClipboard: async (t) => { state.clipboard = String(t ?? ''); return true; },
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
  const retries = [];      // what the model was told off for, per re-ask
  const chats = [];        // plain chat calls, which is how reflection asks
  const llm = {
    tiers: { plan: 'plan-model', see: 'see-model', fast: 'fast-model' },
    calls,
    retries,
    chats,
    chat: async (messages) => {
      chats.push(messages);
      return 'GOING WRONG - it keeps pressing the same thing and the screen never changes.';
    },
    respond: async (req) => {
      const tool = req.tools?.[0]?.function?.name;
      // The zoomed second look (zoom.mjs) is not part of any script: it
      // finds nothing, and the click goes where the script said.
      if (tool === 'point') return { call: null, text: '' };
      calls.push({
        tool,
        model: req.model,
        text: req.content?.find((c) => c.type === 'text')?.text ?? '',
        history: (req.history ?? []).map((m) => ({
          role: m.role,
          text: m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' '),
          images: m.content.filter((c) => c.type === 'image').length,
        })),
      });
      // Mirrors LLM.respond: a scripted answer that fails the caller's
      // checks is re-asked, up to three times, inside this one call.
      let out = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = script.shift();
        if (!next) throw new Error(`the script ran out at a "${tool}" call`);
        const answer = typeof next === 'function' ? next({ tool, req, calls }) : next;
        out = { call: answer, text: '' };
        const problems = (req.checks ?? [])
          .map((c) => { try { return c(out); } catch { return [true, '']; } })
          .filter(([ok, why]) => !ok && why);
        if (!problems.length) return out;
        retries.push(problems.map(([, why]) => why));
      }
      return { ...out, exhausted: true };
    },
  };
  return llm;
}

const plan = (steps, extra = {}) => ({ name: 'plan', args: { steps, done_when: 'it is done', already_done: false, ...extra } });
const act = (args) => ({ name: 'act', args: { why: 'doing the step', ...args } });
/* The live loop ends when the model says the job is done, so every script
   carries one. Scripts whose run stops for another reason never reach it. */
const finish = { name: 'step_done' };

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
      onError: (e) => { events.errors.push(e); if (process.env.PICO_DEBUG) console.log('[error]', e?.message); },
      onAudit: (e, extra) => events.audits.push({ e, ...extra }),
      ...hooks,
    },
  });
  return { done, events };
}

const NOTEPAD = { hwnd: '100', title: 'Untitled - Notepad', process: 'Notepad' };
const SHEET = { hwnd: '200', title: 'Q3 figures.xlsx - Excel', process: 'excel' };


/* --- 1. focus taken once: brought back, and the text still goes in --------- */
console.log('focus taken once');
{
  const computer = desktop({ windows: [NOTEPAD, SHEET], front: '100' });
  const llm = scripted([
    // While this decision is being made, the video takes the screen.
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
    act({ action: 'type', text: 'hello there' }),
      finish,
  ]);
  const { done, events } = run({ computer, llm });
  const result = await done;
  check('nothing was typed into the video', computer.state.typed.every((t) => t.into === '100'), JSON.stringify(computer.state.typed));
  check('Notepad was brought back', computer.state.focusCalls.includes('100'));
  check('the text went into Notepad', computer.state.typed.some((t) => t.into === '100' && t.text === 'hello there'));
  check('the run finished', events.phases.at(-1) === 'Completed', `${events.phases.join(' > ')} ${JSON.stringify(events.errors)}`);
  // act, act, then the turn that says the job is done — and only then the verdict.
  check('judged by the facts, without a verifier call', !llm.calls.some((c) => c.tool === 'report'), llm.calls.map((c) => c.tool).join(','));
  check('it says what it did', /typed "hello there"/i.test(events.summaries.at(-1) ?? ''), events.summaries.at(-1));
  check('it reports success', result?.succeeded === true);
}

/* --- 2. focus taken twice: stops, and names what took it ------------------- */
console.log('focus taken twice');
{
  const computer = desktop({ windows: [NOTEPAD, SHEET], front: '100' });
  const llm = scripted([
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
    () => { computer.state.front = '200'; return act({ action: 'type', text: 'hello there' }); },
      finish,
  ]);
  const { done, events } = run({ computer, llm });
  await done;
  check('nothing was typed at all', computer.state.typed.length === 0, JSON.stringify(computer.state.typed));
  check('the run stopped', events.phases.at(-1) === 'Stopped', events.phases.join(' > '));
  check('the summary names the window that took the screen', (events.summaries.at(-1) ?? '').includes('Q3 figures'), events.summaries.at(-1));
  check('it did not loop until the turns ran out', llm.calls.length === 2, `${llm.calls.length} model calls`);
}

/* --- 3. taken between steps, while Halo was only typing --------------------- */
console.log('focus taken between steps');
{
  const computer = desktop({ windows: [NOTEPAD, SHEET], front: '100' });
  const llm = scripted([
    () => act({ action: 'type', text: 'hello ' }),
    // Taken while typing, so the step is looked at again rather than assumed.
    ({ req }) => {
      check('it is told the keys may have gone astray', /came to the front on its own/.test(req.content[0].text), req.content[0].text);
      return act({ action: 'type', text: 'there' });
    },
      finish,
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
    act({ action: 'click', x: 10, y: 5, target: 'the View menu' }),
    act({ action: 'click', x: 12, y: 5, target: 'the View menu' }),
    ({ req }) => {
      check('the next turn is told what went wrong', /changed nothing/i.test(req.content[0].text), req.content[0].text);
      check('and to try another way', /try a different way/i.test(req.content[0].text), req.content[0].text);
      computer.state.clicksChange = true;
      return act({ action: 'key', keys: ['alt', 'v'] });
    },
    act({ action: 'click', x: 20, y: 20, target: 'Status bar' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Turned on the status bar.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, task: 'show the status bar in notepad' });
  await done;
  const last = events.plans.at(-1);
  check('the run finished instead of stopping at the miss', events.phases.at(-1) === 'Completed', `${events.phases.join(' > ')} | ${events.summaries.at(-1)}`);
  // Nothing is marked failed, because nothing was promised: what the island
  // shows is what actually happened, in the order it happened.
  check('what it did is shown, in order', last?.steps?.map((st) => st.do).join(' | ') === 'pressed alt+v | clicked (20, 20)', JSON.stringify(last?.steps));
  check('and every line of it is something that really happened', last?.steps?.every((st) => st.status === 'done'), JSON.stringify(last?.steps));
  check('a click leaves nothing to check, so the verifier was asked', llm.calls.at(-1).tool === 'report');
}

/* --- 5. skipping a step while it runs --------------------------------------- */
console.log('skip');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const pending = [];
  const llm = scripted([
    () => { pending.push({ type: 'skip', index: 0 }); return act({ action: 'type', text: 'hello' }); },
    act({ action: 'type', text: 'goodbye' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed goodbye.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, hooks: { steer: () => pending.splice(0) } });
  await done;
  check('the skipped step\'s action was not carried out', !computer.state.typed.some((t) => t.text === 'hello'), JSON.stringify(computer.state.typed));
  check('and the run carried on', computer.state.typed.some((t) => t.text === 'goodbye'), JSON.stringify(computer.state.typed));
  check('the skip is on the record', (events.plans.at(-1)?.steps ?? []).some((st) => /you skipped/.test(st.do)), JSON.stringify(events.plans.at(-1)));
}

/* --- 6. "no, the other one" ------------------------------------------------ */
console.log('correction');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const pending = [];
  const llm = scripted([
    () => { pending.push({ type: 'correct', text: 'no, the other one' }); return act({ action: 'click', x: 10, y: 10, target: 'the first result' }); },
    ({ req }) => {
      check('the correction reaches the next turn, word for word', req.content[0].text.includes('no, the other one'), req.content[0].text);
      return act({ action: 'click', x: 10, y: 30, target: 'the second result' });
    },
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Opened the second result.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, task: 'click the search result', hooks: { steer: () => pending.splice(0) } });
  await done;
  const steps = events.plans.at(-1)?.steps ?? [];
  check('what they said is on the record', steps.some((st) => /no, the other one/.test(st.do)), JSON.stringify(steps));
  check('and the next thing done is what they meant', steps.some((st) => /clicked \(10, 30\)/.test(st.do)), JSON.stringify(steps));
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
    act({ action: 'click', x: 10, y: 40, target: 'Locked chats' }),
    ({ req }) => {
      check('the model is told what was really there', /called "Archived", which is not "Locked chats"/.test(req.content[0].text), req.content[0].text);
      return act({ action: 'click', x: 10, y: 60, target: 'Locked chats' });
    },
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Opened Locked chats.' } },
      finish,
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
    act({ action: 'click', x: 40, y: 10, target: 'the address bar' }),
    act({ action: 'type', text: 'halo.dev' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'You opened halo.dev.' } },
      finish,
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


/* --- a model that talks instead of acting --------------------------------
   The whole run used to go green without the desktop being touched: asked
   for an action, a weaker model answers with prose — "I'll click the search
   bar now" — the loop saw no tool call, marked the step done and moved on.
   Right plan, every step ticked, nothing done.
   ------------------------------------------------------------------------ */
console.log('a model that talks instead of acting');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    // Three attempts of prose in one turn: the in-turn retry cannot save
    // this, so it falls through to the loop's own handling.
    () => null, () => null, () => null,
    act({ action: 'type', text: 'hello there' }),          // the next turn, done properly
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed it.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm });
  await done;

  check('a step with no action is not marked done',
    computer.state.typed.length === 1, JSON.stringify(computer.state.typed));
  check('the model was re-asked inside the turn before giving up',
    llm.retries.length === 3, `${llm.retries.length} re-asks`);
  check('the text really went in',
    computer.state.typed[0]?.text === 'hello there', JSON.stringify(computer.state.typed));
  check('and it said why nothing happened',
    events.audits.some((a) => String(a.metadata?.reason || '').includes('described an action')),
    JSON.stringify(events.audits.map((a) => a.metadata?.reason).filter(Boolean)));
}

/* --- an opening step costs no model turn ---------------------------------- */
console.log('opening from the words of the task');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'type', text: 'ssuazo' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Searched.' } },
      finish,
  ]);
  /* The "browser" is node itself, which exits on an address it cannot run:
     the launch succeeds on any machine and no real tab opens — on CI there
     is no explorer.exe, and on a desktop a test should not open a page. */
  const { done, events } = run({ computer, llm, task: 'open reports.example.com and search ssuazo', context: { browser: { exe: process.execPath } } });
  await done;

  /* An address in the words of the task is opened before any model is asked
     anything — it is the commonest first move there is, and reading it off
     the task costs nothing. Everything after it is a decision, and decisions
     cost turns. */
  check('the address in the task opened without a turn being spent',
    /* Any timeline it showed: the planned one arrives in the background and
       can replace the list after the address has already been opened. */
    events.plans.some((p) => (p?.steps ?? []).some((st) => /reports\.example\.com/i.test(st.do))),
    JSON.stringify(events.plans.map((p) => p?.steps)));
  check('and the search happened after it',
    computer.state.typed.some((t) => t.text === 'ssuazo'), JSON.stringify(computer.state.typed));
}


/* --- carrying something between two apps ---------------------------------
   The thing the loop could not do. What is copied has to still be in front
   of the model when the app it is going into is several steps away — and
   the run's log, which was the only thing carried between turns, is trimmed.
   The scratchpad is not.
   ------------------------------------------------------------------------ */
console.log('carrying a value between apps');
{
  const computer = desktop({ windows: [NOTEPAD, SHEET], front: '100' });
  computer.state.selection = 'ORDER-99312';
  const filler = (n) => ({ do: `Type line ${n}`, kind: 'keyboard' });
  const llm = scripted([
    act({ action: 'copy', remember_as: 'order number' }),
    act({ action: 'type', text: 'one ' }),
    act({ action: 'type', text: 'two ' }),
    act({ action: 'type', text: 'three ' }),
    act({ action: 'type', text: 'four ' }),
    act({ action: 'type', text: 'five ' }),
    act({ action: 'type', text: 'six ' }),
    ({ calls }) => {
      // Six steps and seven actions after the copy, the value is still in
      // front of the model, in full, under the name it was given.
      const seen = calls.at(-1).text;
      check('the copied value is still in front of the model at the last step',
        seen.includes('ORDER-99312'), seen.slice(-500));
      check('and is filed under the name it was given',
        /order number: ORDER-99312/.test(seen), seen.slice(-500));
      return act({ action: 'paste' });
    },
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Moved it across.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'copy the order number into the other window' });
  await done;

  check('the value really was pasted',
    computer.state.typed.some((t) => t.text === 'ORDER-99312'), JSON.stringify(computer.state.typed));
}

/* --- a copy that did not take -------------------------------------------- */
console.log('a copy that picked nothing up');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  computer.state.clipboard = 'something from before';
  computer.state.selection = 'something from before';   // ctrl+c on no selection
  const llm = scripted([
    act({ action: 'copy', remember_as: 'total' }),
    ({ calls }) => {
      const seen = calls.at(-1).text;
      check('it says the copy did not take',
        /did not take|still holds/.test(seen), seen.slice(-300));
      check('and nothing wrong was filed under the name',
        !/total: something from before/.test(seen), seen.slice(-300));
      return { name: 'step_done', args: {} };
    },
    finish,

    { name: 'report', args: { succeeded: false, summary: 'Could not copy it.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'copy the total' });
  await done;
}

/* --- pasting exact text beats typing it ---------------------------------- */
console.log('pasting long exact text');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const LONG = 'https://example.com/invoices/2026/09/AC-4471-payable?ref=q3-reconciliation';
  const llm = scripted([
    act({ action: 'paste', paste_text: LONG }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Pasted the link.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'put the link in' });
  await done;

  check('the exact text arrived in one piece',
    computer.state.typed.some((t) => t.text === LONG), JSON.stringify(computer.state.typed));
  check('and the clipboard holds it', computer.state.clipboard === LONG, computer.state.clipboard);
}

/* --- a note outlives the screen it came from ------------------------------ */
console.log('notes');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'click', x: 10, y: 10, target: 'the total', note: 'the invoice total is 240.50' }),
    ({ calls }) => {
      const seen = calls.at(-1).text;
      check('the note comes back on a later turn',
        seen.includes('the invoice total is 240.50'), seen.slice(-300));
      return act({ action: 'type', text: '240.50' });
    },
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed the total.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'type the invoice total' });
  await done;
}


/* --- a job that spans two windows ----------------------------------------
   The shape of most real desktop work, and the one the loop used to treat
   as an attack: one workWindow, and anything else coming to the front was
   theft — put back once, and the second time the run stopped and named it.
   A run told to move something from Notepad into the browser had to fight
   its own destination.
   ------------------------------------------------------------------------ */
console.log('working across two windows');
{
  const computer = desktop({ windows: [NOTEPAD, SHEET], front: '100' });
  computer.state.selection = 'the quarterly figure';
  const llm = scripted([
    act({ action: 'copy', remember_as: 'figure' }),
    act({ action: 'switch_to', window: 'Excel' }),
    act({ action: 'paste' }),
    act({ action: 'switch_to', window: 'Notepad' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Moved it across and came back.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, task: 'copy the figure into the spreadsheet' });
  await done;

  check('it switched windows instead of calling it theft',
    !events.audits.some((a) => a.e === 'focus_stolen'),
    JSON.stringify(events.audits.filter((a) => a.e === 'focus_stolen')));
  check('the run was not stopped',
    events.phases.at(-1) === 'Completed', events.phases.join(' > '));
  check('it pasted into the window it switched to',
    computer.state.typed.some((t) => t.text === 'the quarterly figure' && t.into === '200'),
    JSON.stringify(computer.state.typed));
  check('and ended back in Notepad', computer.state.front === '100', computer.state.front);
}

/* --- switching to something that is not open ------------------------------ */
console.log('switching to a window that is not there');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'switch_to', window: 'Excel' }),
    ({ calls }) => {
      const seen = calls.at(-1).text;
      check('it says so, and lists what is actually open',
        /no open window matching/.test(seen) && /Notepad/.test(seen), seen.slice(-300));
      return { name: 'step_done', args: {} };
    },
    finish,

    { name: 'report', args: { succeeded: false, summary: 'Excel was not open.' } },
      finish,
  ]);
  // Not "go to excel": that phrasing is a request to OPEN something, and the
  // planner rightly adds an open step for it. This is about switching to a
  // window that is not there.
  const { done } = run({ computer, llm, task: 'put the total in the spreadsheet window' });
  await done;
}

/* --- saying what you expect, and being asked about it --------------------
   "The screen changed" is not the question. A click one row out changes it
   just as convincingly as a click on the right row.
   ------------------------------------------------------------------------ */
console.log('expectation is fed back');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'click', x: 20, y: 8, target: 'the address bar', expect: 'the address bar is focused and empty' }),
    ({ calls }) => {
      const seen = calls.at(-1).text;
      check('the next turn is shown what was expected',
        seen.includes('the address bar is focused and empty'), seen.slice(-400));
      check('and is told to check it before going on',
        /check that is what actually happened/.test(seen), seen.slice(-400));
      return act({ action: 'type', text: 'halo.dev' });
    },
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed it.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'put halo.dev in the address bar' });
  await done;
}


/* --- guide mode does not mistake a video for the person ------------------
   The step ended on "any part of the screen looks different", which on a
   real desktop is not a signal: a video playing, a clock minute rolling
   over, a notification sliding in. Guide mode would walk itself through a
   whole plan while the person was still reading the first instruction.
   ------------------------------------------------------------------------ */
console.log('guide mode and a screen that moves on its own');
{
  const touched = [];
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  for (const m of ['click', 'doubleClick', 'type', 'keypress', 'drag', 'wheel']) {
    computer[m] = async () => { touched.push(m); };
  }
  const pointed = [];
  const guide = {
    point: (x, y, words) => { pointed.push({ x, y, words }); return true; },
    say: (words) => { pointed.push({ words }); return true; },
    hide: () => { pointed.push({ hidden: true }); return true; },
  };

  // Something on screen keeps twitching, and nobody touches the machine.
  const ticking = setInterval(() => { computer.state.drift = (computer.state.drift + 1) % 7; }, 40);

  const shown = act({ action: 'click', x: 40, y: 20, target: 'the Send button' });
  const llm = scripted([
    shown, shown,
    shown, shown,
    finish,

    { name: 'report', args: { succeeded: false, summary: 'You did not do it.' } },
      finish,
  ]);
  const { done, events } = run({
    computer, llm, task: 'send it', context: { guide, patienceMs: 250 },
  });
  await done;
  clearInterval(ticking);

  check('nothing was touched', touched.length === 0, touched.join(','));
  check('the twitching never counted as the person acting',
    events.plans.every((p) => (p.steps || []).every((st) => st.status !== 'done')),
    JSON.stringify(events.plans.map((p) => (p.steps || []).map((st) => st.status))));
  check('it still pointed at the thing', pointed.some((p) => /Send/i.test(String(p.words))),
    JSON.stringify(pointed.slice(0, 3)));
}


/* --- a bad answer is corrected inside the turn ---------------------------
   Ported from Agent-S's call_llm_formatted: rather than spending a whole
   round trip discovering the answer was unusable and another correcting
   it, the answer is checked before the turn returns and the model is told
   exactly what was wrong. On a free model that is the difference between a
   step taking four seconds and twenty.
   ------------------------------------------------------------------------ */
console.log('a bad answer is put right without spending a turn');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    () => null,                                                   // prose, no tool call
    act({ action: 'click', target: 'the address bar' }),          // no coordinates
    act({ action: 'click', x: 30, y: 15, target: 'the address bar' }),   // usable
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Focused it.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, task: 'focus the address bar' });
  await done;

  check('it was told to call a tool',
    llm.retries.flat().some((w) => /call exactly one tool/i.test(w)),
    JSON.stringify(llm.retries));
  check('and then told the click needed a mark or a point',
    llm.retries.flat().some((w) => /needs "mark"/i.test(w)),
    JSON.stringify(llm.retries));
  // Two turns: the one that took three goes to answer usably, and the one
  // where the model says the job is done.
  check('all three attempts were one turn, not three',
    llm.calls.filter((c) => c.tool === 'act').length === 2,
    `${llm.calls.filter((c) => c.tool === 'act').length} act turns`);
  check('the step finished', events.phases.at(-1) === 'Completed', events.phases.join(' > '));
}


/* --- the run is one conversation, not a series of cold calls -------------
   Every turn used to restate the task, the plan and a summary of the log,
   with one screenshot, and the model never saw what it had itself said the
   turn before. It re-derived its situation from scratch each time, which is
   slow and is most of why a run could talk itself round in circles.
   ------------------------------------------------------------------------ */
console.log('the run is one conversation');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const steps = [];
  for (let i = 1; i <= 6; i++) steps.push({ do: `Type line ${i}`, kind: 'keyboard' });
  const llm = scripted([
    act({ action: 'type', text: 'one ' }),
    act({ action: 'type', text: 'two ' }),
    act({ action: 'type', text: 'three ' }),
    act({ action: 'type', text: 'four ' }),
    act({ action: 'type', text: 'five ' }),
    act({ action: 'type', text: 'six ' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed them.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'type six lines' });
  await done;

  const acts = llm.calls.filter((c) => c.tool === 'act');
  const first = acts[0];
  const last = acts.at(-1);

  check('the first turn carries no history', first.history.length === 0,
    JSON.stringify(first.history));
  check('the first turn states the task', /Task: type six lines/.test(first.text), first.text);
  check('later turns do not restate the task', !/Task: type six lines/.test(last.text), last.text);
  check('later turns are given the conversation so far', last.history.length >= 4,
    `${last.history.length} history entries`);
  check('the history includes what the model itself decided',
    last.history.some((m) => m.role === 'assistant' && m.text.length > 0),
    JSON.stringify(last.history.slice(-2)));
  check('only the newest few screenshots are kept',
    last.history.reduce((n, m) => n + m.images, 0) <= 3,
    `${last.history.reduce((n, m) => n + m.images, 0)} images carried`);
  check('but the older text is still there',
    last.history.filter((m) => m.role === 'user' && m.images === 0).length > 0,
    JSON.stringify(last.history.map((m) => `${m.role}:${m.images}`)));
}

/* --- a second opinion, but only when something is wrong ------------------ */
console.log('looking back when a run stalls');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  computer.state.clicksChange = false;            // nothing this run does works
  const stuckAct = act({ action: 'click', x: 25, y: 25, target: 'the toolbar' });
  const llm = scripted([
    stuckAct, stuckAct, stuckAct, stuckAct,
    stuckAct, stuckAct, stuckAct, stuckAct,
    finish,

    { name: 'report', args: { succeeded: false, summary: 'It would not respond.' } },
      finish,
  ]);
  const { done, events } = run({ computer, llm, task: 'click the toolbar' });
  await done;

  check('it asked for a second opinion once it was stuck', llm.chats.length > 0,
    `${llm.chats.length} reflection calls`);
  // The re-plan is what the second opinion is for: it is the decision being
  // made at the moment the run concluded something was wrong.
  // There is no re-plan to carry it: it goes to the next turn, which is the
  // decision being made at the moment the run concluded something was wrong.
  check('the next turn was told what the second opinion was',
    llm.calls.some((c) => /A look back over the run so far/.test(c.text)),
    JSON.stringify(llm.calls.map((c) => c.text.slice(-120))));
  check('the reflection was recorded', events.audits.some((a) => a.e === 'reflected'),
    JSON.stringify(events.audits.map((a) => a.e)));
}

/* --- and not when it is going fine --------------------------------------- */
console.log('no second opinion on a healthy run');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'type', text: 'hello' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Typed it.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'type hello' });
  await done;

  check('nothing was spent looking back', llm.chats.length === 0,
    `${llm.chats.length} reflection calls`);
}


/* --- selecting a span of text -------------------------------------------
   Agent-S drags between two OCR'd points. A drag across text autoscrolls
   the moment it reaches the edge of the view, turns into a drag-and-drop if
   it starts inside an existing selection, and does nothing at all in a
   control that reads a drag as a gesture. Click then shift-click costs the
   same and cannot run away.
   ------------------------------------------------------------------------ */
console.log('selecting a span of text');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  computer.state.selection = 'the second paragraph';
  const llm = scripted([
    act({ action: 'select_text', x: 12, y: 20, to_x: 70, to_y: 34, target: 'the second paragraph' }),
    act({ action: 'copy', remember_as: 'paragraph' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Selected and copied it.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'copy the second paragraph' });
  await done;

  check('it clicked where the text starts',
    computer.state.shiftClicks.length === 1, JSON.stringify(computer.state.shiftClicks));
  check('and shift-clicked where it ends, rather than dragging',
    computer.state.shiftClicks[0]?.x === 70 && computer.state.shiftClicks[0]?.y === 34,
    JSON.stringify(computer.state.shiftClicks));
  check('then the selection was copied',
    computer.state.clipboard === 'the second paragraph', computer.state.clipboard);
}

/* --- a modifier held across several taps --------------------------------- */
console.log('holding a key across several taps');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'hold_and_press', hold: ['shift'], press: ['down'], times: 4 }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Selected four lines.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'select the next four lines' });
  await done;

  check('shift was held across all four taps',
    computer.state.chords.length === 1
      && computer.state.chords[0].hold.join() === 'shift'
      && computer.state.chords[0].times === 4,
    JSON.stringify(computer.state.chords));
  check('and it was not sent as four separate chords',
    computer.state.chords.length === 1, `${computer.state.chords.length} chords`);
}

/* --- and a half-given one is put right in the turn ------------------------ */
console.log('a select_text missing its end point');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  const llm = scripted([
    act({ action: 'select_text', x: 12, y: 20, target: 'the paragraph' }),        // no end
    act({ action: 'select_text', x: 12, y: 20, to_x: 60, to_y: 30, target: 'the paragraph' }),
    finish,

    { name: 'report', args: { succeeded: true, summary: 'Selected it.' } },
      finish,
  ]);
  const { done } = run({ computer, llm, task: 'select the paragraph' });
  await done;

  check('it was told which half was missing',
    llm.retries.flat().some((w) => /needs to_x and to_y/.test(w)), JSON.stringify(llm.retries));
  check('and it still only cost one turn',
    llm.calls.filter((c) => c.tool === 'act').length === 2,
    `${llm.calls.filter((c) => c.tool === 'act').length} act turns`);
}

console.log('eight accessibility actions reuse prefetched controls without eight screenshots');
{
  const computer = desktop({ windows: [NOTEPAD], front: '100' });
  let clicks = 0, captures = 0, snapshots = 0;
  const capture = computer.capture;
  computer.capture = async () => { captures++; return capture(); };
  const elements = () => Array.from({ length: 4 }, (_, i) => ({
    type: 'Button', name: `Control ${i + 1}`, id: `control-${i}`, runtimeId: `node-${i}`,
    rect: [10 + i * 100, 30, 70, 30], operable: true, enabled: true, selected: clicks > i,
  }));
  computer.sense.look = async () => { snapshots++; return { elements: elements(), says: [`Actions completed: ${clicks}`] }; };
  computer.sense.hit = async (x) => ({ found: true, at: elements().find(el => x >= el.rect[0] && x <= el.rect[0] + el.rect[2]) });
  computer.click = async () => { clicks++; computer.state.screen++; };
  const llm = scripted([finish, { name: 'report', args: { succeeded: true, summary: 'Eight controls used.' } }, finish]);
  llm.evaluate = async (state, questions) => {
    if (!questions.operation) return null;
    const chosen = clicks < 8 ? 'CLICK' : 'DONE';
    const answer = (criteria, choice) => ({ choice, probabilities: Object.fromEntries(Object.keys(criteria).map(id => [id, id === choice ? 1 : 0])) });
    const out = { operation: answer(questions.operation.criteria, chosen) };
    for (const [key, q] of Object.entries(questions)) if (key !== 'operation') out[key] = answer(q.criteria, String((clicks % 4) + 1));
    return out;
  };
  const { done, events } = run({ computer, llm, task: 'Click Control 1, Control 2, Control 3, and Control 4 twice in order' });
  await done;
  const timings = events.audits.filter(e => e.e === 'turn_timing');
  check('all eight actions executed', clicks === 8, `${clicks} clicks`);
  check('only initial, completion and report screenshots were needed', captures === 3, `${captures} captures`);
  check('one snapshot per state, with prefetch reused', snapshots === 9, `${snapshots} reads`);
  check('all eight turns used accessibility', timings.length === 8 && timings.every(e => e.metadata.path === 'accessibility' && e.metadata.screenshot_skipped));
  check('vision checked completion and independently verified it', llm.calls.length === 2 && llm.calls[0].tool === 'act' && llm.calls[1].tool === 'report', JSON.stringify(llm.calls.map(c => c.tool)));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
