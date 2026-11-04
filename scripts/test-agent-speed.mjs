/* Offline contracts for fast Agent decisions and outcome-only activity. */
import assert from 'node:assert/strict';
import { LLM, supportedEffort } from '../bridge/llm.mjs';
import { actionSpace, namedNavigation } from '../bridge/fastpath.mjs';
import { activityOutcome, liveActionLabel } from '../bridge/driver.mjs';

const control = (name, x = 10, extra = {}) => ({ type: 'MenuItem', name, rect: [x, 20, 80, 30], operable: true, enabled: true, ...extra });
const space = actionSpace([control('Locked chats')]);
assert.equal(namedNavigation('Open Locked chats view', space)?.row.label, 'Locked chats', 'sparse named menus need no vision decision');
assert.equal(namedNavigation('Open Locked chats view', actionSpace([control('Locked chats'), control('Locked chats', 110)])), null, 'ambiguous names need a look');
assert.equal(namedNavigation('Do not open Locked chats', space), null);
assert.equal(namedNavigation('Open Locked chats', actionSpace([control('Locked chats', 10, { enabled: false })])), null);
assert.equal(namedNavigation('Send a message to Locked chats', space), null, 'an incidental name is not navigation authority');
assert.equal(namedNavigation('Open Locked chats', space, ['clicked MenuItem "Locked chats"']), null, 'completed navigation does not repeat');
assert.equal(activityOutcome('clicked Button "Locked chats"'), 'Clicked Button "Locked chats"');
assert.equal(liveActionLabel({ type: 'click', target: 'Locked chats', why: 'I think I should inspect this first' }), 'Click Locked chats');
assert.equal(activityOutcome('I think I should find the right chat'), 'Action executed');
assert.equal(activityOutcome('clicked (320, 180)'), 'Clicked');
assert.equal(supportedEffort('gpt-5-mini'), 'minimal');
assert.equal(supportedEffort('gpt-5.4-mini'), 'none');
assert.equal(supportedEffort('gpt-6.1-sol'), 'low');
assert.equal(supportedEffort('gpt-6-astra'), 'low');

const tool = { type: 'function', function: { name: 'act', description: 'Act in a batch', parameters: { type: 'object', properties: {} } } };
const llm = new LLM({ apiKey: 'offline-test', provider: 'openai', baseUrl: 'https://api.openai.com/v1', tiers: { see: 'gpt-5.4-mini' } });
llm._slot = async () => {};
const chat = llm._body('gpt-5.4-mini', [], { maxTokens: 400, stream: false, tools: [tool], effort: 'none' });
assert.equal(chat.reasoning_effort, 'none');
assert.equal(chat.parallel_tool_calls, false);
assert.equal(chat.tool_choice, 'required');
const requests = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (body.reasoning?.effort === 'none') return Response.json({ error: { message: 'reasoning effort none is unsupported' } }, { status: 400 });
    return Response.json({ output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private reasoning must not become activity' }] },
      { type: 'function_call', name: 'act', arguments: JSON.stringify({ action: 'click', mark: 1, then: [{ action: 'key', keys: ['enter'] }] }) },
    ] });
  };
  const result = await llm.respond({ model: 'gpt-5.4-mini', system: 'Act only', content: [{ type: 'text', text: 'Open the chat' }], tools: [tool], effort: 'none' });
  assert.deepEqual(requests.map(body => body.reasoning.effort), ['none', 'minimal'], 'a refusal uses the next lowest effort, never a default thinking budget');
  assert.ok(requests.every(body => body.parallel_tool_calls === false && body.tool_choice === 'required'));
  assert.equal(result.text, '', 'reasoning items are not user output');
  assert.equal(result.call.args.then.length, 1);
  requests.length = 0;
  await llm.respond({ model: 'gpt-5.4-mini', system: 'Act only', content: [], tools: [tool], effort: 'none' });
  assert.deepEqual(requests.map(body => body.reasoning.effort), ['minimal'], 'remember the supported effort');
} finally { globalThis.fetch = originalFetch; }
// The existing Chat Completions path keeps the same single batched act call.
llm._responses = false;
requests.length = 0;
try {
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith('/chat/completions'));
    const body = JSON.parse(init.body); requests.push(body);
    if (body.reasoning_effort === 'none') return Response.json({ error: { message: 'Invalid reasoning_effort: none' } }, { status: 400 });
    return Response.json({ choices: [{ message: { reasoning_content: 'Private thought', tool_calls: [{ function: {
      name: 'act', arguments: JSON.stringify({ action: 'click', mark: 1, then: [{ action: 'key', keys: ['enter'] }] }),
    } }] } }] });
  };
  const result = await llm.respond({ model: 'gpt-5.4-mini', system: 'Act only', content: [], tools: [tool], effort: 'none' });
  assert.deepEqual(requests.map(body => body.reasoning_effort), ['none', 'minimal']);
  assert.ok(requests.every(body => body.parallel_tool_calls === false && body.tool_choice === 'required'));
  assert.equal(result.call.args.then.length, 1);
  assert.equal(result.text, '', 'provider reasoning_content is not exposed');
} finally { globalThis.fetch = originalFetch; }

console.log('Agent speed: named sparse navigation, outcome activity, sequential batches and minimal effort fallback passed.');
