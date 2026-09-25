import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleVoice, voiceRequestAllowed } from '../bridge/voice.mjs';
import { actionSpace, decide, targetStillMatches, focusLanded, targetNamedInGoal, namesSite } from '../bridge/fastpath.mjs';
import { execute } from '../bridge/driver.mjs';
import { HostAgent } from '../bridge/agent.mjs';

const request = (origin, host = 'localhost:4177', ip = '127.0.0.1') => ({ socket: { remoteAddress: ip }, headers: { host, origin } });
assert.equal(voiceRequestAllowed(request('http://localhost:4177')), true);
assert.equal(voiceRequestAllowed(request('https://unrelated.example')), false);
assert.equal(voiceRequestAllowed(request(undefined, 'attacker.example')), false);
assert.equal(voiceRequestAllowed(request(undefined, 'localhost:4177', '192.168.1.2')), false);

let calls = 0, upstreamStatus = 200;
const server = createServer((req, res) => handleVoice(req, res, req.url, {
  config: async () => ({ key: 'test-key', model: 'eleven_flash_v2_5', voice: 'test-voice' }),
  fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers['xi-api-key'], 'test-key');
    assert.equal(JSON.parse(options.body).text, 'Hello Halo');
    assert.equal(JSON.parse(options.body).model_id, 'eleven_flash_v2_5');
    return new Response(upstreamStatus === 200 ? 'mock-mp3-bytes' : 'private upstream detail', { status: upstreamStatus });
  },
}));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const state = await (await fetch(`${base}/voice/state`)).json();
  assert.deepEqual(state, { configured: true, model: 'eleven_flash_v2_5' });
  const post = (text, extra = {}) => fetch(`${base}/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ text }) });
  assert.equal((await post('', {})).status, 400);
  assert.equal((await post('Hello Halo', { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('a'.repeat(4001))).status, 400);
  assert.equal(calls, 0);
  const audio = await post('Hello Halo');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await audio.text(), 'mock-mp3-bytes');
  upstreamStatus = 401;
  const failed = await post('Hello Halo');
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes('private upstream detail'));
} finally { server.close(); server.closeAllConnections(); }

const field = { name: 'Search', type: 'Edit', id: 'search', rect: [10, 20, 100, 25], enabled: true, operable: true };
assert.equal(targetStillMatches(field, { found: true, at: { ...field } }), true);
assert.equal(targetStillMatches(field, { found: true, at: { ...field, name: 'Delete' } }), false);
assert.equal(targetStillMatches(field, { found: true, at: { ...field, rect: [10, 90, 100, 25] } }), false);
assert.equal(targetStillMatches(field, { found: true, at: { ...field, enabled: false } }), false);
assert.equal(targetStillMatches(field, null), false);

// Focus after a click: the same field, even when it widened or grew as it took focus.
const box = { name: 'Search Wikipedia', type: 'SearchBox', rect: [400, 120, 300, 34] };
assert.equal(focusLanded(box, { found: true, at: { ...box, rect: [380, 118, 520, 38] } }), true, 'a search box that widened on focus');
assert.equal(focusLanded(box, { found: true, at: { ...box, type: 'ComboBox' } }), true, 'reported as a combo box once suggestions show');
assert.equal(focusLanded(box, { found: true, at: { name: 'Address and search bar', type: 'Edit', rect: [300, 10, 900, 30] } }), false, 'the address bar is not the search box');
assert.equal(focusLanded(box, { found: true, at: { ...box, rect: [400, 600, 300, 34] } }), false, 'a same-named field somewhere else');
assert.equal(focusLanded(box, { found: true, at: { ...box, type: 'Button' } }), false);
assert.equal(focusLanded(box, { found: false }), false);

const input = [];
let currentField = field;
const computer = {
  click: async () => input.push('click'), wait: async () => {},
  keypress: async () => input.push('select'), type: async () => input.push('type'),
};
const execution = {
  computer, sense: { hit: async () => ({ found: true, at: currentField }), focused: async () => ({ found: true, at: currentField }) },
  shot: { physToScreen: (x, y) => ({ x, y }) },
  action: { type: 'type', text: 'cats', observedTarget: field, replaceValue: true },
};
assert.equal((await execute({ ...execution, gate: async () => false })).stop, true);
assert.deepEqual(input, [], 'Cancellation before execution must not click or select');
currentField = { ...field, name: 'Other field' };
assert.equal((await execute(execution)).stale, true);
assert.deepEqual(input, [], 'A changed target must receive no input');
currentField = field;
await execute(execution);
assert.deepEqual(input, ['click', 'select', 'type']);
input.length = 0;
let gates = 0;
assert.equal((await execute({ ...execution, gate: async () => ++gates === 1 })).stop, true);
assert.deepEqual(input, ['click'], 'Cancellation after focus must stop selection and typing');

const space = actionSpace([field]);
assert.equal(targetNamedInGoal('Click the Search button', {row:{label:'Search'}}), true);
assert.equal(targetNamedInGoal('Click the latest project', {row:{label:'Random project'}}), false);
assert.equal(targetNamedInGoal('Do not click Cancel', {row:{label:'Cancel'}}), false);
const llm = { evaluate: async (_, questions) => {
  const probabilities = Object.fromEntries(Object.keys(questions.operation.criteria).map(k => [k, 0]));
  probabilities.CLICK = 0.55; probabilities.TYPE_TEXT = 0.45;
  return {
    operation: { choice: 'CLICK', probabilities },
    click_target: { choice: '999', probabilities: { '999': 1 } },
    type_text_target: { choice: '999', probabilities: { '999': 1 } },
  };
} };
assert.equal(await decide(llm, { goal: 'Search for cats', ...space }), null, 'Merged heads must not execute an invented target');

/* OPEN_URL is offered in a browser, or for a job that names a site — never to
   a desktop job in a desktop window, where choosing it opened the browser on
   an address a model made up. */
const offersOpenUrl = async (args) => {
  let offered = null;
  await decide({ evaluate: async (_, questions) => { offered = Object.keys(questions.operation.criteria); return null; } }, { ...space, ...args });
  return offered.includes('OPEN_URL');
};
assert.equal(await offersOpenUrl({ goal: 'Make a folder called Reports in Documents', window: 'Documents - File Explorer' }), false, 'no OPEN_URL for a folder job in Explorer');
assert.equal(await offersOpenUrl({ goal: 'Type hello into the document', window: 'Untitled - Notepad' }), false, 'no OPEN_URL for typing in Notepad');
assert.equal(await offersOpenUrl({ goal: 'Make a budget for my online store', window: 'Book1 - Excel' }), false, '"online store" is not a site');
assert.equal(await offersOpenUrl({ goal: 'Search for cats', window: 'Google - Google Chrome', browser: true }), true, 'a browser keeps OPEN_URL');
assert.equal(await offersOpenUrl({ goal: 'Open the price page', task: 'compare the price on amazon.com and ebay', window: 'Documents - File Explorer' }), true, 'a named site keeps OPEN_URL');
assert.equal(await offersOpenUrl({ goal: 'Look up otters on YouTube', window: 'Untitled - Notepad' }), true);
assert.equal(await offersOpenUrl({ goal: 'Open the company website', window: 'Untitled - Notepad' }), true);
assert.equal(namesSite('go to https://example.com'), true);
assert.equal(namesSite('rename the file to report.docx'), false, 'a file name is not an address');
assert.equal(namesSite('in file explorer make a folder called Reports'), false);
const events = [];
const host = new HostAgent({ onCommand() {}, emit(type, payload) { events.push({ type, payload }); } }, { memory: { forPrompt: () => '' } });
let interrupted = false;
host.attachLLM({ converse: (_, { signal }) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => { interrupted = true; reject(new Error('cancelled')); }, { once: true });
}) });
const oldReply = host.converse('Old question');
host._chatAbort.abort();
await oldReply;
assert.equal(interrupted, true);
assert.ok(events.some(e => e.payload?.remove), 'An interrupted reply must remove its thinking placeholder');
assert.ok(!events.some(e => e.payload?.text?.includes('cancelled')), 'Cancellation must not publish a provider error');
console.log('Voice access, streamed audio, errors, target freshness, input cancellation, chat cancellation, malformed JEV heads and OPEN_URL outside a browser passed.');
