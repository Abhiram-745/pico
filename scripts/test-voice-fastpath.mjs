import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleVoice, voiceRequestAllowed } from '../bridge/voice.mjs';
import { actionSpace, decide, targetStillMatches, targetNamedInGoal } from '../bridge/fastpath.mjs';
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
console.log('Voice access, streamed audio, errors, target freshness, input cancellation, chat cancellation and malformed JEV heads passed.');
