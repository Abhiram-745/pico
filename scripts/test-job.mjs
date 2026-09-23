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

console.log('job: all passed');
process.exit(0);
