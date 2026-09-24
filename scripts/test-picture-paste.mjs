#!/usr/bin/env node
/* ==========================================================================
   A picture the person attached, pasted by the task loop (driver.mjs) — by
   its number, like a text, against a pretend desktop and a scripted model.

   The pretend desktop keeps two clipboards' worth of state, the way the
   real one does: text, or a picture that replaced it. ctrl+v pastes
   whichever is there. Nothing here touches the real clipboard, mouse or
   keyboard, and no model is called.

     - one numbering for text and pictures, shown to the model as
       `[2] picture "fox.png" (image/png)`
     - paste_attachment on a picture puts that picture on the clipboard as a
       picture and presses ctrl+v, and says so
     - a picture that cannot be put on the clipboard pastes nothing at all:
       not the person's own clipboard in its place
     - a plain paste while a picture is attached, with nothing Halo knows
       on the clipboard, is refused and pointed at the picture's number
     - a picture pasted from a planned batch ("then") the same way
     - after a picture, the text Halo copied earlier is not pasted again as
       if it were still there

   Run with: node scripts/test-picture-paste.mjs
   ========================================================================== */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HALO_HOME = mkdtempSync(join(tmpdir(), 'halo-test-'));
const { runTask } = await import('../bridge/driver.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

/* --- a pretend desktop (the pattern of scripts/test-driver.mjs) ------------ */
function desktop({ windows, front }) {
  const state = {
    windows: new Map(windows.map((w) => [w.hwnd, { ...w }])),
    front,
    value: '',
    clipboard: '',          // text on the clipboard…
    image: null,            // …or the picture that took its place
    selection: '',          // what ctrl+c would pick up right now
    screen: 1,
    typed: [],              // text pasted or typed: [{ text, into }]
    pictures: [],           // pictures pasted: [{ dataUrl, into }]
    imageWrites: [],        // every picture Halo asked to put on the clipboard
    imageFails: false,      // the helper cannot put it there
    keys: [],
  };
  const grey = () => new Uint8Array(64).fill((state.screen * 37) % 256);
  const RW = 800, RH = 600;
  const rawFrame = () => {
    const data = new Uint8Array(RW * RH * 4);
    const v = 10 + ((state.screen * 53) % 200);
    for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255; }
    return { data, width: RW, height: RH };
  };
  const shot = () => ({
    b64: '', mime: 'image/jpeg', width: 100, height: 60,
    physical: { width: 1000, height: 600 }, scale: 1, raw: rawFrame(), grey: grey(),
    toPhysical: (x, y) => ({ x, y }), physToScreen: (x, y) => ({ x, y }), toScreen: (x, y) => ({ x, y }),
  });
  const win = (h) => (h ? { ...state.windows.get(h), hwnd: h } : null);
  return {
    state,
    capture: async () => shot(),
    frame: async () => rawFrame(),
    focusedWindow: () => win(state.front)?.title ?? '',
    available: async () => ({ ok: true }),
    foreground: async () => win(state.front),
    focus: async (h) => { if (state.windows.has(h)) state.front = h; return true; },
    move: async () => {},
    click: async () => { state.screen += 1; },
    doubleClick: async () => { state.screen += 1; },
    drag: async () => {},
    wheel: async () => {},
    type: async (t) => { state.typed.push({ text: t, into: state.front }); state.value += t; state.screen += 1; },
    keypress: async (keys = []) => {
      const chord = keys.map((k) => String(k).toLowerCase()).join('+');
      state.keys.push(chord);
      if (chord === 'ctrl+c') { state.clipboard = state.selection; state.image = null; return; }
      if (chord === 'ctrl+v') {
        if (state.image) state.pictures.push({ dataUrl: state.image, into: state.front });
        else { state.typed.push({ text: state.clipboard, into: state.front }); state.value += state.clipboard; }
      }
      state.screen += 1;
    },
    holdAndPress: async () => { state.screen += 1; },
    // A picture on the clipboard reads as no text at all, as it does for real.
    readClipboard: async () => (state.image ? '' : state.clipboard),
    writeClipboard: async (t) => { state.clipboard = String(t ?? ''); state.image = null; return true; },
    writeClipboardImage: async (dataUrl) => {
      state.imageWrites.push(dataUrl);
      if (state.imageFails) return false;
      state.image = dataUrl;
      return true;
    },
    wait: (ms = 0) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    sense: {
      hit: async () => null,
      near: async () => null,
      wake: async () => null,
      windows: async () => [...state.windows.entries()].map(([hwnd, w]) => ({ hwnd, minimized: false, tool: false, rect: [0, 0, 500, 400], ...w })),
      focused: async () => ({ found: true, title: win(state.front)?.title, at: { type: 'Edit', name: 'Message' }, value: state.value }),
    },
  };
}

/** A model that answers from a script: each entry is a function of the call. */
function scripted(script) {
  const calls = [];
  const llm = {
    tiers: { plan: 'plan-model', see: 'see-model', fast: 'fast-model' },
    calls,
    chat: async () => 'GOING WRONG - it keeps pressing the same thing and the screen never changes.',
    respond: async (req) => {
      const tool = req.tools?.[0]?.function?.name;
      if (tool === 'point') return { call: null, text: '' };
      calls.push({ tool, text: req.content?.find((c) => c.type === 'text')?.text ?? '' });
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
      }
      return { ...out, exhausted: true };
    },
  };
  return llm;
}

const act = (args) => ({ name: 'act', args: { why: 'doing the step', ...args } });
const finish = { name: 'step_done' };
const report = (succeeded, summary) => ({ name: 'report', args: { succeeded, summary } });

function run({ computer, llm, task, context = {} }) {
  const events = { phases: [], summaries: [], audits: [] };
  const done = runTask({
    task, computer, llm, maxTurns: 30, context,
    hooks: {
      onPhase: (p) => events.phases.push(p),
      onSummary: (t) => events.summaries.push(t),
      onAudit: (e, extra) => events.audits.push({ e, ...extra }),
    },
  });
  return { done, events };
}

const CHAT = { hwnd: '300', title: 'Assistant - Google Chrome', process: 'chrome' };
const FOX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARgAGAQJ/3ZBTTwAAAABJRU5ErkJggg==';
const NOTES = { id: 't1', name: 'notes.txt', kind: 'text', mime: 'text/plain', size: 11, text: 'hello there' };
const PICTURE = { id: 'p1', name: 'fox.png', kind: 'image', mime: 'image/png', size: 70, dataUrl: FOX, thumb: FOX };

/* --- by its number, in one numbering with the text -------------------------- */
console.log('a picture pasted by its number');
{
  const computer = desktop({ windows: [CHAT], front: '300' });
  computer.state.clipboard = 'the person\'s own notes';
  let after = '';
  const llm = scripted([
    act({ action: 'paste', paste_attachment: 2 }),
    ({ calls }) => { after = calls.at(-1).text; return finish; },
    report(true, 'Pasted the picture.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'paste the attached picture into the chat', context: { attachments: [NOTES, PICTURE] } });
  await done;
  const first = llm.calls[0]?.text ?? '';
  check('text and picture share one numbering: the text is [1]', /\[1\] "notes\.txt" — 1 line/.test(first), first.slice(0, 400));
  check('and the picture [2], by name and type', /\[2\] picture "fox\.png" \(image\/png\)/.test(first), first.slice(0, 400));
  check('the old "cannot paste pictures" is gone', !/cannot paste pictures|cannot be done yet/i.test(first), first.slice(0, 400));
  check('the picture was put on the clipboard as a picture, once',
    computer.state.imageWrites.length === 1 && computer.state.imageWrites[0] === FOX, JSON.stringify(computer.state.imageWrites.map((u) => u.slice(0, 30))));
  check('and pasted with ctrl+v into the window being worked in',
    computer.state.pictures.length === 1 && computer.state.pictures[0].dataUrl === FOX && computer.state.pictures[0].into === '300',
    JSON.stringify(computer.state.pictures.map((p) => ({ ...p, dataUrl: p.dataUrl.slice(0, 30) }))));
  check('the person\'s own clipboard was never pasted', !computer.state.typed.some((t) => /own notes/.test(t.text)), JSON.stringify(computer.state.typed));
  check('the model was told what went in', /pasted the picture fox\.png/.test(after), after.slice(-600));
}

/* --- a picture that cannot be put on the clipboard -------------------------- */
console.log('a picture that cannot be put on the clipboard');
{
  const computer = desktop({ windows: [CHAT], front: '300' });
  computer.state.clipboard = 'the person\'s bank details';
  computer.state.imageFails = true;
  let after = '';
  const llm = scripted([
    act({ action: 'paste', paste_attachment: 1 }),
    ({ calls }) => { after = calls.at(-1).text; return finish; },
    report(false, 'The picture could not be pasted.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'paste this picture into the chat', context: { attachments: [PICTURE] } });
  await done;
  check('it was tried', computer.state.imageWrites.length === 1, String(computer.state.imageWrites.length));
  check('and nothing at all was pasted — no ctrl+v', !computer.state.keys.includes('ctrl+v'), computer.state.keys.join(' '));
  check('least of all the person\'s own clipboard', !computer.state.typed.some((t) => /bank/.test(t.text)), JSON.stringify(computer.state.typed));
  check('the model was told why', /could not be put on the clipboard/.test(after), after.slice(-600));
}

/* --- another window takes the screen while the picture is readied ----------
   Putting a picture on the clipboard takes a helper process and most of a
   second — long enough for a notification or another app to take focus.
   ctrl+v would go into whatever that is, so it is not pressed. */
console.log('another window comes to the front while the picture is readied');
{
  const NOTEPAD = { hwnd: '400', title: 'Untitled - Notepad', process: 'Notepad' };
  const computer = desktop({ windows: [CHAT, NOTEPAD], front: '300' });
  const write = computer.writeClipboardImage;
  computer.writeClipboardImage = async (url) => { computer.state.front = '400'; return write(url); };
  let after = '';
  const llm = scripted([
    act({ action: 'paste', paste_attachment: 1 }),
    ({ calls }) => { after = calls.at(-1).text; return finish; },
    report(false, 'Another window took the screen.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'paste this picture into the chat', context: { attachments: [PICTURE] } });
  await done;
  check('nothing was pasted into the window that took the screen',
    computer.state.pictures.length === 0 && !computer.state.keys.includes('ctrl+v'), computer.state.keys.join(' '));
  check('and the model was told what happened', /came to the front while the picture was being readied/.test(after), after.slice(-600));
}

/* --- a plain paste in its place --------------------------------------------- */
console.log('a plain paste while a picture is attached');
{
  const computer = desktop({ windows: [CHAT], front: '300' });
  computer.state.clipboard = 'the person\'s own notes';
  let after = '';
  const llm = scripted([
    act({ action: 'paste' }),
    ({ calls }) => { after = calls.at(-1).text; return act({ action: 'paste', paste_attachment: 2 }); },
    finish,
    report(true, 'Pasted the picture.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'paste this picture into the chat', context: { attachments: [NOTES, PICTURE] } });
  await done;
  check('the plain paste pasted nothing', !computer.state.typed.some((t) => /own notes/.test(t.text)), JSON.stringify(computer.state.typed));
  check('and the model was pointed at the picture\'s number', /paste_attachment: 2\b/.test(after), after.slice(-600));
  check('then the picture itself went in', computer.state.pictures.length === 1, String(computer.state.pictures.length));
}

/* --- from a planned batch --------------------------------------------------- */
console.log('a picture pasted from a planned batch');
{
  const computer = desktop({ windows: [CHAT], front: '300' });
  const llm = scripted([
    act({ action: 'click', x: 40, y: 50, target: 'the message box', then: [{ action: 'paste', paste_attachment: 1 }] }),
    finish,
    report(true, 'Pasted the picture.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'click the message box and paste the picture', context: { attachments: [PICTURE] } });
  await done;
  check('the queued paste put the picture in, without asking the model again',
    computer.state.pictures.length === 1 && computer.state.imageWrites.length === 1,
    JSON.stringify({ pictures: computer.state.pictures.length, writes: computer.state.imageWrites.length, acts: llm.calls.filter((c) => c.tool === 'act').length }));
}

/* --- what Halo copied earlier, after a picture ------------------------------ */
console.log('text copied earlier is not pasted again after a picture');
{
  const computer = desktop({ windows: [CHAT], front: '300' });
  computer.state.selection = 'ORDER-99312';
  let after = '';
  const llm = scripted([
    act({ action: 'copy', remember_as: 'order number' }),
    act({ action: 'paste', paste_attachment: 1 }),
    act({ action: 'paste' }),
    ({ calls }) => { after = calls.at(-1).text; return act({ action: 'paste', paste_text: 'ORDER-99312' }); },
    finish,
    report(true, 'Pasted the picture and the order number.'),
    finish,
  ]);
  const { done } = run({ computer, llm, task: 'copy the order number, then paste the picture and the order number', context: { attachments: [PICTURE] } });
  await done;
  check('the picture went in once', computer.state.pictures.length === 1, String(computer.state.pictures.length));
  check('the plain paste after it was refused — it would have pasted the picture again',
    /Halo does not know what is on the clipboard now/.test(after), after.slice(-600));
  check('and the order number went in exactly once, as text, when asked for exactly',
    computer.state.typed.filter((t) => t.text === 'ORDER-99312').length === 1, JSON.stringify(computer.state.typed));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
