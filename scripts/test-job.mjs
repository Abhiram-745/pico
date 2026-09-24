#!/usr/bin/env node
/* ==========================================================================
   A message with something attached, from Enter to the desktop: routed with
   what came with it (agent.mjs), a list sent item by item in code (job.mjs,
   chatbox.mjs) — against a pretend desktop that records what was sent.

   Run with: node scripts/test-job.mjs
   ========================================================================== */
import assert from 'node:assert/strict';
import { HostAgent } from '../bridge/agent.mjs';
import { runJob, planJob } from '../bridge/job.mjs';
import { send } from '../bridge/chatbox.mjs';

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

/* --- a picture, sent to an assistant ----------------------------------------
   A pretend ChatGPT that takes a pasted picture the way the real one does:
   a picture on the clipboard pastes as an attachment, not as words; it
   uploads for a few reads of the box, with Send shown but disabled; Enter
   pressed in the meantime does nothing. The clipboard holds text or a
   picture, never both, and reads as no text while it holds a picture. */
const FOX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARgAGAQJ/3ZBTTwAAAABJRU5ErkJggg==';
const fox = { id: 'p1', name: 'fox.png', kind: 'image', mime: 'image/png', size: 70, dataUrl: FOX, thumb: FOX };
function picturegpt({ title = 'ChatGPT - Google Chrome', uploadReads = 2, imageFails = false, locked = false } = {}) {
  const app = {
    value: '', clip: 'the person\'s own clipboard', image: null, attached: [], uploading: 0, busy: 0,
    sent: [], enterWhileUploading: 0, pastes: 0, imageWrites: [],
  };
  const FIELD3 = [300, 800, 600, 40];
  const sense3 = {
    async windows() { return [{ hwnd: '31', title, process: 'chrome', rect: [0, 0, 1200, 900] }]; },
    async foreground() { return { hwnd: '31' }; },
    async composer() {
      if (app.uploading > 0) app.uploading -= 1;
      const busy = app.busy > 0;
      if (busy) app.busy -= 1;
      const buttons = [{ name: 'Add photos and files', rect: [305, 805, 30, 30], enabled: true }];
      if (busy) buttons.push({ name: 'Stop streaming', rect: [910, 805, 30, 30], enabled: true });
      else if (app.value || app.attached.length) buttons.push({ name: 'Send prompt', rect: [910, 805, 30, 30], enabled: app.uploading === 0 });
      else buttons.push({ name: 'Start voice mode', rect: [910, 805, 30, 30], enabled: true });
      return { found: true, field: { type: 'Edit', name: 'Message ChatGPT', rect: FIELD3, value: app.value }, buttons };
    },
    async focused() { return { at: { type: 'Edit', rect: FIELD3, value: app.value } }; },
  };
  const computer = {
    sense: sense3,
    async available() { return locked ? { ok: false, why: 'the screen is locked' } : { ok: true }; },
    async foreground() { return null; },
    async focus() { return true; },
    async click() {},
    async keypress(keys) {
      const k = keys.join('+');
      if (k === 'ctrl+v') {
        app.pastes += 1;
        if (app.image) { app.attached.push(app.image); app.uploading = uploadReads; } else app.value += app.clip;
      } else if (k === 'ctrl+a' || k === 'backspace') app.value = '';
      else if (k === 'enter') {
        if (app.uploading > 0) { app.enterWhileUploading += 1; return; }
        app.sent.push({ text: app.value, pictures: app.attached.length });
        app.value = '';
        app.attached = [];
        app.busy = 2;
      }
    },
    async writeClipboard(t) { app.clip = t; app.image = null; return true; },
    async writeClipboardImage(url) {
      app.imageWrites.push(url);
      if (imageFails) return false;
      app.image = url;
      app.clip = '';
      return true;
    },
    async readClipboard() { return app.image ? '' : app.clip; },
    async capture() { return { scale: 1, grey: null }; },
  };
  return { app, computer };
}
/** A fast model that lifts the words out; anything else it is asked, it answers as the router's tiebreak. */
function wordsModel(message, { broken = false } = {}) {
  const asked = [];
  return {
    asked,
    tiers: { fast: 'test', text: 'test', plan: 'test' },
    async chat(messages) {
      const system = String(messages?.[0]?.content ?? '');
      if (/send a message to an AI app/.test(system)) {
        asked.push({ system, user: messages[1]?.content });
        if (broken) throw new Error('the model is not answering');
        return JSON.stringify({ message });
      }
      return 'AGENT';
    },
    async evaluate() { return null; },
  };
}
const job = async (task, attachments, { computer, llm }) => {
  const seen = { summaries: [], phases: [], errors: [] };
  const result = await runJob({
    task, attachments, computer, llm,
    hooks: { onSummary: (t) => seen.summaries.push(t), onPhase: (p) => seen.phases.push(p), onError: (e) => seen.errors.push(e) },
  });
  return { result, seen };
};

{
  // Which messages are this shape at all.
  const note = { id: 't9', name: 'prompt.txt', kind: 'text', mime: 'text/plain', size: 20, text: 'Make it look like a watercolour' };
  const picture = (task, list = [fox]) => planJob(task, list);
  assert.equal(picture('send the attached image to ChatGPT')?.words, 'none', 'nothing to say: the picture goes alone');
  assert.equal(picture('Paste the attached picture into the chat')?.words, 'none');
  assert.equal(picture('paste this picture into chat gpt')?.words, 'none', 'the app\'s name, however it is spelt, is not something to say');
  assert.equal(picture('Paste the attached picture into the chat and ask what\'s in it.')?.words, 'ask', 'a question to lift out');
  assert.equal(picture('send fox.png to Claude and get feedback on the colours')?.words, 'ask');
  const quoted = picture('send this picture to ChatGPT and ask "What breed is this?"');
  assert.equal(quoted?.words, 'given');
  assert.equal(quoted.items[0].text, 'What breed is this?', 'quoted words are sent exactly');
  assert.equal(quoted.items[0].picture, FOX, 'with the picture itself');
  assert.equal(quoted.single, true);
  const withText = picture('send the attached picture and prompt to ChatGPT', [fox, note]);
  assert.equal(withText?.words, 'given', 'a picture and a text: the text is the words');
  assert.equal(withText.items[0].text, note.text);
  assert.equal(planJob('send the attached prompt to ChatGPT', [note])?.shape, 'attachment', 'a text alone goes as it always did');
  assert.equal(picture('send this picture to Mom on WhatsApp'), null, 'a person: the right conversation first, which is the loop\'s job');
  assert.equal(picture('paste this picture into ChatGPT and tell me what it says'), null, 'reading the answer back is the loop\'s job');
  assert.equal(picture('send these to ChatGPT', [fox, { ...fox, id: 'p2', name: 'owl.png' }]), null, 'two pictures: the loop, which pastes each by number');
  assert.equal(picture('open ChatGPT'), null, 'nothing asked to be sent');
}
{
  // Through the agent: a quoted question, sent with the picture, after the upload.
  const { app, computer } = picturegpt();
  const seen = [];
  const a = new HostAgent({ emit: (type, payload) => seen.push({ type, payload }), onCommand() {} }, { memory, routines });
  const llm = wordsModel('never asked');
  a.attachLLM(llm);
  a.attachComputer(computer);
  await a.run('send the attached picture to the chat with the question "What breed is this?"', { attachments: [fox] });
  assert.deepEqual(app.sent, [{ text: 'What breed is this?', pictures: 1 }], 'one message: the picture and the words');
  assert.deepEqual(app.imageWrites, [FOX], 'the picture put on the clipboard as a picture, once');
  assert.equal(app.enterWhileUploading, 0, 'Enter waited for the upload');
  assert.equal(llm.asked.length, 0, 'quoted words need no model');
  assert.equal(app.clip, 'the person\'s own clipboard', 'the person\'s clipboard text is given back');
  assert.equal(app.image, null);
  const summary = seen.filter((e) => e.type === 'summary' && e.payload).at(-1)?.payload?.text ?? '';
  assert.match(summary, /Sent the picture with "What breed is this\?" in ChatGPT/, summary);
  assert.equal(seen.filter((e) => e.type === 'phase').at(-1)?.payload?.phase, 'Completed');
}
{
  // The words lifted out of the instruction by a model, told a picture goes first.
  const { app, computer } = picturegpt({ uploadReads: 3 });
  const llm = wordsModel('What\'s in this picture?');
  const { seen } = await job('Paste the attached picture into the chat and ask what\'s in it.', [fox], { computer, llm });
  assert.deepEqual(app.sent, [{ text: 'What\'s in this picture?', pictures: 1 }]);
  assert.equal(app.enterWhileUploading, 0, 'a slower upload is waited for too');
  assert.equal(llm.asked.length, 1);
  assert.match(llm.asked[0].system, /They attached a picture/, 'the model is told the picture goes in first');
  assert.equal(seen.phases.at(-1), 'Completed');
  assert.equal(app.clip, 'the person\'s own clipboard');
}
{
  // Nothing to say: the picture on its own, and no model asked.
  const { app, computer } = picturegpt();
  const llm = wordsModel('should not be used');
  const { seen } = await job('Paste the attached picture into the chat', [fox], { computer, llm });
  assert.deepEqual(app.sent, [{ text: '', pictures: 1 }], 'sent on its own');
  assert.equal(llm.asked.length, 0);
  assert.equal(app.enterWhileUploading, 0);
  assert.match(seen.summaries.at(-1) ?? '', /^Sent the picture in /);
}
{
  // The picture cannot be put on the clipboard: nothing pasted, nothing sent.
  const { app, computer } = picturegpt({ imageFails: true });
  const { seen } = await job('Paste the attached picture into the chat', [fox], { computer, llm: wordsModel('') });
  assert.equal(app.imageWrites.length, 1, 'it was tried');
  assert.equal(app.pastes, 0, 'ctrl+v was never pressed — it would have pasted the person\'s own clipboard');
  assert.deepEqual(app.sent, []);
  assert.match(seen.summaries.at(-1) ?? '', /The picture did not go: the picture could not be put on the clipboard/);
  assert.equal(seen.phases.at(-1), 'Stopped');
  assert.equal(app.clip, 'the person\'s own clipboard', 'and their clipboard is as it was');
}
{
  // An upload that never finishes: Enter is never pressed into it, and it says why.
  const { app, computer } = picturegpt({ uploadReads: 1e9 });
  const result = await send({
    computer, sense: computer.sense, hwnd: '31', text: 'What is this?', picture: FOX,
    toMouse: (x, y) => ({ x, y }), uploadMs: 600,
  });
  assert.equal(result.ok, false);
  assert.match(result.why, /still uploading after 1 seconds/);
  assert.equal(app.enterWhileUploading, 0, 'Enter was never pressed while it uploaded');
  assert.deepEqual(app.sent, []);
}
{
  // No accessibility to find the box by: the loop, which can paste a picture by number.
  const { app, computer } = picturegpt({ locked: true });
  delete computer.sense;
  const { result, seen } = await job('Paste the attached picture into the chat', [fox], { computer, llm: wordsModel('') });
  assert.equal(result, undefined);
  assert.match(seen.errors[0]?.message ?? '', /can't use the mouse or keyboard/, 'it went to the loop');
  assert.deepEqual(app.imageWrites, [], 'not the exact route');
}
{
  // Words to lift out, and no model to lift them: the loop, not the picture without its question.
  const { app, computer } = picturegpt({ locked: true });
  const llm = wordsModel('', { broken: true });
  const { seen } = await job('Paste the attached picture into the chat and ask what\'s in it.', [fox], { computer, llm });
  assert.equal(llm.asked.length, 1, 'the model was asked');
  assert.match(seen.errors[0]?.message ?? '', /can't use the mouse or keyboard/, 'then the loop was handed the job');
  assert.deepEqual(app.sent, []);
}

console.log('job: all passed');
process.exit(0);
