#!/usr/bin/env node
/* ==========================================================================
   A message with something attached, from Enter to the desktop: routed with
   what came with it (agent.mjs), a list sent item by item in code (job.mjs,
   chatbox.mjs) — against a pretend desktop that records what was sent.

   Run with: node scripts/test-job.mjs
   ========================================================================== */
import assert from 'node:assert/strict';
import { HostAgent } from '../bridge/agent.mjs';

const events = [];
const transport = { emit: (type, payload) => events.push({ type, payload }), onCommand() {} };
const memory = { forPrompt: () => '', add: () => null, list: () => [], value: () => null, forget: () => [] };
const routines = { match: () => null, touch() {}, save() {}, get() {}, list: () => [] };
const agent = new HostAgent(transport, { memory, routines });

const conversed = [];
agent.attachLLM({
  tiers: { fast: 'test', text: 'test' },
  async converse(turns, { onDelta }) { conversed.push(turns.map((t) => ({ ...t }))); onDelta?.('ok'); return 'ok'; },
  async chat() { return 'AGENT'; },          // the router's tiebreak, when the rules are unsure
  async evaluate() { return null; },
});

/* --- talking about what was attached ------------------------------------ */
const png = 'data:image/png;base64,iVBORw0KGgo=';
await agent.run('', { attachments: [{ id: 'i1', name: 'fox.png', kind: 'image', mime: 'image/png', size: 8, dataUrl: png }] });
const asked = conversed.at(-1).at(-1);
assert.ok(Array.isArray(asked.content), 'a picture goes to the model as a picture');
assert.equal(asked.content.find((p) => p.type === 'image_url')?.image_url.url, png);
assert.ok(!JSON.stringify(agent.history).includes('base64'), 'and is not kept in the conversation');

await agent.run('summarise this', { attachments: [{ id: 't1', name: 'notes.txt', kind: 'text', mime: 'text/plain', size: 10, text: 'ALPHA BETA' }] });
assert.match(conversed.at(-1).at(-1).content, /ALPHA BETA/, 'a pasted text is read whole');
assert.ok(agent.history.some((h) => /\[Attached: notes\.txt\]/.test(h.content)));

await agent.run('hello there', {});
assert.equal(conversed.at(-1).at(-1).content, 'hello there', 'a plain message is sent as it always was');

/* --- a list, sent in a chat app ----------------------------------------- */
const box = { value: '', clip: 'the person\'s own clipboard', sent: [] };
const FIELD = [300, 800, 600, 40];
const sense = {
  async windows() {
    return [
      // Says the name, is not the app: never the place to press Enter.
      { hwnd: '7', title: 'whatsapp notes.txt - Notepad', process: 'Notepad', rect: [0, 0, 800, 600] },
      { hwnd: '9', title: 'WhatsApp', process: 'WhatsApp', rect: [0, 0, 1200, 900] },
    ];
  },
  async foreground() { return { hwnd: '9' }; },
  async composer(hwnd) {
    assert.equal(String(hwnd), '9', 'the app itself, not a window that mentions it');
    return { found: true, field: { type: 'Edit', name: 'Type a message', rect: FIELD, value: box.value }, buttons: [] };
  },
  async focused() { return { at: { type: 'Edit', rect: FIELD, value: box.value } }; },
};
agent.attachComputer({
  sense,
  async available() { return { ok: true }; },
  async foreground() { return null; },
  async focus() { return true; },
  async click() {},
  async keypress(keys) {
    const k = keys.join('+');
    if (k === 'ctrl+v') box.value += box.clip;
    else if (k === 'ctrl+a' || k === 'backspace') box.value = '';
    else if (k === 'enter') { box.sent.push(box.value); box.value = ''; }
  },
  async writeClipboard(t) { box.clip = t; return true; },
  async readClipboard() { return box.clip; },
  async capture() { return { scale: 1, grey: null }; },
});
events.length = 0;
await agent.run('send each of these to whatsapp, from the second one', {
  attachments: [{ id: 't2', name: 'list.txt', kind: 'text', mime: 'text/plain', size: 60, text: '1. first, not sent\n2. second message\n3. third message' }],
});
assert.deepEqual(box.sent, ['second message', 'third message'], 'from 2 onwards, exactly as written, in order');
assert.equal(box.clip, 'the person\'s own clipboard', 'the clipboard is given back');
const phases = events.filter((e) => e.type === 'phase').map((e) => e.payload.phase);
assert.equal(phases.at(-1), 'Completed');
const plan = events.filter((e) => e.type === 'plan' && e.payload).at(-1).payload;
assert.ok(plan.list && plan.finished, 'the island is shown a finished list');

// Saved as a shortcut, it would replay with nothing attached: not saved, and said why.
let shortcutsSaved = 0;
routines.save = () => { shortcutsSaved += 1; return { name: 'Send the list' }; };
events.length = 0;
agent.handle({ command: 'routineSave', payload: { name: 'Send the list' } });
assert.equal(shortcutsSaved, 0, 'a job that used an attachment is not kept as words alone');
assert.match(events.find((e) => e.type === 'message')?.payload.text ?? '', /Not saved as a shortcut/);

/* --- Skip, and what is said, while a list runs ---------------------------
   A pretend ChatGPT: a stop button shows for a few reads after each send,
   the way the real one shows "Stop streaming" while it writes. Skip and
   corrections arrive the way the interface sends them (agent.handle). */
function chatgpt({ title = 'ChatGPT - Google Chrome', process: proc = 'chrome', busyAfterSend = 2 } = {}) {
  const app = { value: '', clip: 'the person\'s own clipboard', sent: [], busy: 0, pastedWhileBusy: false, afterSend: () => {} };
  const FIELD2 = [300, 800, 600, 40];
  const sense2 = {
    async windows() { return [{ hwnd: '11', title, process: proc, rect: [0, 0, 1200, 900] }]; },
    async foreground() { return { hwnd: '11' }; },
    async composer() {
      const busy = app.busy > 0;
      if (busy) app.busy -= 1;
      return { found: true, field: { type: 'Edit', name: 'Message ChatGPT', rect: FIELD2, value: app.value }, buttons: busy ? [{ name: 'Stop streaming', rect: [910, 805, 30, 30] }] : [] };
    },
    async focused() { return { at: { type: 'Edit', rect: FIELD2, value: app.value } }; },
  };
  const computer = {
    sense: sense2,
    async available() { return { ok: true }; },
    async foreground() { return null; },
    async focus() { return true; },
    async click() {},
    async keypress(keys) {
      const k = keys.join('+');
      if (k === 'ctrl+v') { if (app.busy > 0) app.pastedWhileBusy = true; app.value += app.clip; } else if (k === 'ctrl+a' || k === 'backspace') app.value = '';
      else if (k === 'enter') { app.sent.push(app.value); app.value = ''; app.busy = busyAfterSend; app.afterSend(app.sent.length); }
    },
    async writeClipboard(t) { app.clip = t; return true; },
    async readClipboard() { return app.clip; },
    async capture() { return { scale: 1, grey: null }; },
  };
  const seen = [];
  const a = new HostAgent({ emit: (type, payload) => seen.push({ type, payload }), onCommand() {} }, { memory, routines });
  a.attachLLM({ tiers: { fast: 'test', text: 'test' }, async chat() { return 'AGENT'; }, async evaluate() { return null; } });
  a.attachComputer(computer);
  const last = (type) => seen.filter((e) => e.type === type && e.payload).at(-1)?.payload;
  return { app, agent: a, seen, last };
}
const three = [{ id: 't3', name: 'prompts.md', kind: 'text', mime: 'text/markdown', size: 40, text: '1. one\n2. two\n3. three' }];
// A messaging app: sent without waiting for anything back, so nothing here waits.
const messenger = { title: 'WhatsApp', process: 'WhatsApp', busyAfterSend: 0 };

{
  // Skip on the row in hand before it goes: that one is left out, the rest go.
  const { app, agent: a, last } = chatgpt(messenger);
  app.afterSend = (n) => { if (n === 1) a.handle({ command: 'skipStep', payload: { index: 1 } }); };
  await a.run('send each of these to whatsapp', { attachments: three });
  assert.deepEqual(app.sent, ['one', 'three'], 'a skipped row is not sent');
  assert.deepEqual(last('plan').steps.map((s) => s.status), ['done', 'skipped', 'done']);
  assert.equal(last('phase').phase, 'Completed', 'a list with a row taken out by the person still finished');
  assert.match(last('summary').text, /skipped 2, as you asked/);
}
{
  // "Stop after this one": the one in hand finishes, nothing after it goes.
  const { app, agent: a, last } = chatgpt(messenger);
  app.afterSend = (n) => { if (n === 1) a.handle({ command: 'steer', payload: { text: 'stop after this one' } }); };
  await a.run('send each of these to whatsapp', { attachments: three });
  assert.deepEqual(app.sent, ['one']);
  assert.deepEqual(last('plan').steps.map((s) => s.status), ['done', 'skipped', 'skipped']);
  assert.match(last('summary').text, /stopped before 2–3, as you asked/);
}
{
  // "Skip 3" by its number; and something a list under way cannot do is answered, not dropped.
  const { app, agent: a, seen } = chatgpt(messenger);
  app.afterSend = (n) => {
    if (n === 1) { a.handle({ command: 'steer', payload: { text: 'skip 3' } }); a.handle({ command: 'steer', payload: { text: 'make them all shorter' } }); }
  };
  await a.run('send each of these to whatsapp', { attachments: three });
  assert.deepEqual(app.sent, ['one', 'two']);
  const activity = seen.filter((e) => e.type === 'plan' && e.payload?.activity).flatMap((e) => e.payload.activity.map((x) => x.text));
  assert.ok(activity.some((t) => /Not changed: "make them all shorter"/.test(t)), JSON.stringify(activity));
}
{
  /* Skip while an answer is being written: not waited for — and the next
     one waits for the app to be free before it is pasted, or ChatGPT would
     keep it in the box and send nothing. */
  const { app, agent: a, last } = chatgpt();
  // Still writing for a few reads after the first; the second is answered quickly.
  app.afterSend = (n) => { if (n === 1) { app.busy = 4; a.handle({ command: 'skipStep', payload: { index: 0 } }); } };
  await a.run('paste each of these into chatgpt and wait for each answer', { attachments: [{ ...three[0], text: '1. one\n2. two' }] });
  assert.deepEqual(app.sent, ['one', 'two']);
  assert.equal(app.pastedWhileBusy, false, 'nothing was pasted while the app was still writing');
  assert.equal(last('phase').phase, 'Completed');
}

console.log('job: all passed');
process.exit(0);
