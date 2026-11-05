/* Offline contracts for fast Agent decisions and outcome-only activity. */
import assert from 'node:assert/strict';
import { LLM, PROVIDERS, fetchPatiently, completionTimeout, openaiAllowed, supportedEffort } from '../bridge/llm.mjs';
import { route } from '../bridge/intent.mjs';
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
assert.equal(completionTimeout([{ type: 'text', text: 'short tool' }]), 20_000);
assert.equal(completionTimeout([], { hard: true }), 45_000);
assert.equal(completionTimeout([{ type: 'image' }]), 90_000);
assert.equal(completionTimeout([{ role: 'user', content: [{ type: 'image' }] }]), 90_000);
assert.equal(completionTimeout([{ role: 'user', content: [{ type: 'image_url' }] }], { desktopMs: 45_000 }), 45_000);
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
  assert.ok(requests.every(body => body.max_output_tokens === 1400), 'ordinary agent turns use a smaller default');
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

// Hard turns keep room, explicit caller budgets win, and truncation expands safely.
const budgeted = new LLM({ apiKey: 'offline-test', provider: 'openai',
  tiers: { see: 'gpt-5.4-mini', hard: 'gpt-5.4' } });
budgeted._slot = async () => {};
try {
  const budgets = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); budgets.push(body.max_output_tokens);
    if (budgets.length === 3) return Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    return Response.json({ output: [{ type: 'function_call', name: 'act', arguments: '{}' }] });
  };
  const req = { system: 'Act', content: [], tools: [tool] };
  await budgeted.respond({ ...req, model: budgeted.tiers.hard });
  await budgeted.respond({ ...req, maxTokens: 2200 });
  await budgeted.respond(req);
  assert.deepEqual(budgets, [3000, 2200, 1400, 2800]);
} finally { globalThis.fetch = originalFetch; }

budgeted._responses = false;
try {
  const budgets = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); budgets.push(body.max_completion_tokens);
    return Response.json({ choices: [{ finish_reason: budgets.length === 1 ? 'length' : 'tool_calls',
      message: { tool_calls: [{ function: { name: 'act', arguments: budgets.length === 1 ? '{' : '{"text":"complete"}' } }] } }] });
  };
  const result = await budgeted.toolCall([], { model: budgeted.tiers.see, tools: [tool] });
  assert.deepEqual(budgets, [1400, 2800]);
  assert.equal(result.call.args.text, 'complete');
  budgets.length = 1;
  await budgeted.toolCall([], { model: budgeted.tiers.hard, tools: [tool] });
  assert.equal(budgets.at(-1), 3000);
} finally { globalThis.fetch = originalFetch; }

// Direct chat must emit unfinished sentences before the next model chunk.
const conversational = new LLM({ apiKey: 'offline-test', provider: 'openai',
  baseUrl: 'https://api.openai.com/v1', tiers: { ...PROVIDERS.openai.tiers } });
const deltas = [];
conversational.stream = async (_messages, options) => {
  assert.equal(options.model, 'gpt-4o-mini');
  assert.equal(options.maxTokens, 384);
  options.onDelta('Hello');
  assert.deepEqual(deltas, ['Hello'], 'first words arrive without waiting for punctuation');
  options.onDelta(' there.');
  return 'Hello there.';
};
assert.equal(await conversational.converse([{ role: 'user', content: 'hello' }], {
  onDelta: piece => deltas.push(piece),
}), 'Hello there.');
assert.equal(deltas.join(''), 'Hello there.');
assert.equal(conversational.tiers.see, 'gpt-4.1-mini');
assert.ok(Object.values(conversational.tiers).every(openaiAllowed));

// Stream completion must not wait for a provider to close its connection.
const encoder = new TextEncoder();
for (const finalNewline of [true, false]) {
  let cancelled = false;
  const streamed = new LLM({ apiKey: 'offline-test', provider: 'openai', tiers: PROVIDERS.openai.tiers });
  streamed._post = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}' + (finalNewline ? '\n\ndata: [DONE]\n\n' : '')));
      if (!finalNewline) controller.close();
    }, cancel() { cancelled = true; },
  }));
  assert.equal(await streamed.stream([], { signal: AbortSignal.timeout(1000) }), 'Hi');
  if (finalNewline) assert.equal(cancelled, true);
}
try {
  const abort = new AbortController();
  globalThis.fetch = async () => {
    setTimeout(() => abort.abort(), 10);
    return Response.json({}, { status: 503, headers: { 'retry-after': '3' } });
  };
  await assert.rejects(fetchPatiently('https://offline.test', { signal: abort.signal }), { name: 'AbortError' });
} finally { globalThis.fetch = originalFetch; }
const routed = await route('perhaps tomorrow would be better', { llm: {
  provider: 'openai', tiers: { fast: 'gpt-4o-mini' },
  evaluate: () => { throw new Error('Direct OpenAI routing must use only its allowlisted classifier'); },
  chat: async () => 'Not AGENT; CHAT',
} });
assert.equal(routed.mode, 'chat', 'malformed classifier output cannot authorize desktop work');

console.log('Agent speed: navigation, batches, effort fallback, immediate streaming, cancellation and strict intent passed.');

// Similar menu names must not suppress a navigation that has not happened.
assert.equal(namedNavigation('Open Chat', actionSpace([control('Chat')]), ['clicked MenuItem "Chats"'])?.row.label, 'Chat');
const { HostAgent } = await import('../bridge/agent.mjs');
const lifecycleEvents = [];
const host = new HostAgent({ onCommand() {}, emit(type, payload) { lifecycleEvents.push({ type, payload }); } }, {
  memory: { forPrompt: () => '', detect: () => null, add: () => null }, routines: { match: () => null },
});
const pendingQuestion = host.ask({ text: 'Which window?' });
host.handle({ command: 'stop' });
assert.deepEqual(await pendingQuestion, { text: '', choice: null });
assert.equal(lifecycleEvents.some(e => e.type === 'message'), false, 'cancelled question must not post stale chat');
let approval, takeover = false;
host._approveResolve = value => { approval = value; };
host._takeoverResolve = () => { takeover = true; };
host.handle({ command: 'newChat' });
assert.equal(approval, false);
assert.equal(takeover, true);
let finishRoute;
host.attachLLM({ provider: 'openai', tiers: { fast: 'gpt-4o-mini' }, chat: () => new Promise(resolve => { finishRoute = resolve; }) });
const pendingRun = host.run('perhaps tomorrow would be better');
await new Promise(resolve => setImmediate(resolve));
host.handle({ command: 'stop' });
finishRoute('AGENT');
await pendingRun;
assert.equal(lifecycleEvents.some(e => e.type === 'routed'), false, 'stopped classifier cannot dispatch work');
console.log('Agent lifecycle: pending waits and stopped classification passed.');

// Cancelling a quota wait must not sleep for the rest of the minute or fetch.
const queuedLLM = new LLM({ apiKey: 'offline-test', provider: 'openai', tiers: PROVIDERS.openai.tiers });
queuedLLM._rpm = 1;
queuedLLM._sent = [Date.now()];
const quotaAbort = new AbortController();
let fetchedAfterCancel = false;
try {
  globalThis.fetch = async () => { fetchedAfterCancel = true; throw new Error('unexpected fetch'); };
  const queuedReply = queuedLLM.chat([], { signal: quotaAbort.signal });
  quotaAbort.abort();
  await assert.rejects(queuedReply, { name: 'AbortError' });
  assert.equal(fetchedAfterCancel, false);
  assert.equal(queuedLLM._sent.length, 1);
  queuedLLM._sent = [];
  await assert.rejects(queuedLLM.chat([], { signal: quotaAbort.signal }), { name: 'AbortError' });
  assert.equal(queuedLLM._sent.length, 0, 'already-cancelled calls consume no quota');
} finally { globalThis.fetch = originalFetch; }
console.log('Quota waits: immediate cancellation without fetching or spending quota passed.');
const routeAbort = new AbortController();
let classifierSignal;
const cancelledRoute = route('perhaps tomorrow would be better', { signal: routeAbort.signal, llm: {
  provider: 'openai', tiers: { fast: 'gpt-4o-mini' },
  chat: (_turns, { signal }) => new Promise((resolve, reject) => {
    classifierSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }),
} });
routeAbort.abort();
assert.equal((await cancelledRoute).mode, 'chat');
assert.equal(classifierSignal.aborted, true, 'stop propagates to the intent request');

// Ready windows are checked immediately; cancellation never restores focus.
const { waitForWindow, open: openApp } = await import('../bridge/apps.mjs');
let firstWindowRead = false;
const readyWindow = { hwnd: 'ready', title: 'Notepad', process: 'notepad' };
const readyRead = waitForWindow({ name: 'Notepad', foreground: async () => { firstWindowRead = true; return readyWindow; } });
await Promise.resolve();
assert.equal(firstWindowRead, true, 'no fixed sleep before the first readiness probe');
assert.equal(await readyRead, readyWindow);
let stoppedWindowWait = false;
let focusAfterStop = false;
assert.equal(await waitForWindow({
  name: 'Notepad', timeout: 1000,
  foreground: async () => { stoppedWindowWait = true; return readyWindow; },
  gate: async () => !stoppedWindowWait,
  windows: async () => [readyWindow],
  focus: async () => { focusAfterStop = true; },
}), null);
assert.equal(focusAfterStop, false);
let allowFallback = true;
assert.equal(await waitForWindow({
  name: 'Notepad', timeout: 0, gate: async () => allowFallback,
  foreground: async () => null,
  windows: async () => { allowFallback = false; return [readyWindow]; },
  focus: async () => { focusAfterStop = true; },
}), null);
assert.equal(focusAfterStop, false, 'stop during window listing cannot focus a stale target');
assert.equal((await openApp({ url: 'https://example.com' }, { gate: async () => false })).outcome, 'stopped');

// A delayed availability result must not overwrite Stop with Failed.
const staleEvents = [];
const staleHost = new HostAgent({ onCommand() {}, emit(type, payload) { staleEvents.push({ type, payload }); } }, {
  memory: { forPrompt: () => '', detect: () => null }, routines: { match: () => null },
});
staleHost.canAct = () => true;
let availabilityDone;
staleHost.computer = { available: () => new Promise(resolve => { availabilityDone = resolve; }) };
const pendingWork = staleHost.work('Open Notepad');
staleHost.handle({ command: 'stop' });
const eventCount = staleEvents.length;
availabilityDone({ ok: false, why: 'locked' });
await pendingWork;
assert.equal(staleEvents.length, eventCount, 'stale availability must emit nothing after Stop');
console.log('Open readiness: immediate probe, stop-safe fallback focus and stale availability passed.');

// Provider changes must see an in-flight classifier, including before a chat
// has emitted its streaming placeholder. Only the current request owns it.
{
  const pendingClassifiers = [];
  host.attachLLM({ provider: 'openai', tiers: { fast: 'gpt-4o-mini' },
    chat: () => new Promise(resolve => pendingClassifiers.push(resolve)),
    converse: async () => 'Offline reply',
  });
  const older = host.run('perhaps the other option might suit us better');
  await new Promise(resolve => setImmediate(resolve));
  const oldOwner = host._routeAbort; assert(oldOwner);
  const newer = host.run('perhaps tomorrow might suit us better instead');
  await new Promise(resolve => setImmediate(resolve));
  const currentOwner = host._routeAbort; assert(currentOwner); assert.notEqual(currentOwner, oldOwner); assert(oldOwner.signal.aborted);
  pendingClassifiers[0]('CHAT'); await older;
  assert.equal(host._routeAbort, currentOwner, 'late prior classification cannot clear current ownership');
  pendingClassifiers[1]('CHAT'); await newer;
  assert.equal(host._routeAbort, null, 'settled classification releases provider-switch guard');
}
console.log('Provider switch ownership: pending classification and stale completion guards passed.');

// Stop on the same tick must invalidate the run before it resets cancelled.
{
  const events = [];
  const agent = new HostAgent({ onCommand() {}, emit(type, payload) { events.push({ type, payload }); } }, {
    memory: { forPrompt: () => '', detect: () => null }, routines: { match: () => null },
  });
  const pending = agent.run('Open Notepad');
  agent.handle({ command: 'stop' });
  const count = events.length;
  await pending;
  assert.equal(events.length, count);
  assert.equal(agent.cancelled, true);
  for (const command of ['stop', 'deny', 'newChat']) {
    agent.cancelled = false;
    const question = agent.ask({ text: 'Proceed?' });
    agent.handle({ command });
    await question;
    assert.equal(agent._answerResolve, null);
    assert.equal(events.filter(e => e.type === 'message').length, 0);
    for (const type of ['approval', 'question', 'takeover']) {
      assert.equal(events.filter(e => e.type === type).at(-1)?.payload, null);
    }
  }
}
console.log('Agent cancellation: 3 wait-clearing commands and same-tick Stop passed.');

// A provider ignoring abort cannot revive a streaming bubble after Stop.
{
  const events = [];
  const agent = new HostAgent({ onCommand() {}, emit(type, payload) { events.push({ type, payload }); } }, {
    memory: { forPrompt: () => '' }, routines: {},
  });
  let finish, delta;
  agent.attachLLM({ converse: async (_turns, options) => {
    delta = options.onDelta;
    return new Promise(resolve => { finish = resolve; });
  } });
  const reply = agent.converse('hello', agent.runToken);
  await new Promise(resolve => setImmediate(resolve));
  delta('Hello');
  agent.handle({ command: 'stop' });
  assert.equal(events.filter(e => e.type === 'message').at(-1).payload.remove, true);
  const count = events.length;
  delta(' late'); finish('Hello late'); await reply;
  assert.equal(events.length, count);
  assert.equal(agent._chatAbort, null);
}
console.log('Streaming lifecycle: synchronous Stop cleanup and ignored-abort late deltas passed.');

// Settle timers must never overwrite a new run's foreground phase.
{
  const agent = new HostAgent({ onCommand() {}, emit: () => {} });
  agent.handle({ command: 'stop' });
  assert.equal(agent.phase, 'Stopped');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(agent.phase, 'Idle');
  agent.setPhase('Completed');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(agent.phase, 'Idle');
  agent.setPhase('Completed');
  agent.setPhase('Starting');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(agent.phase, 'Starting');
  agent.setPhase('Idle');
}
console.log('Completed/Stopped settle to Idle without overwriting a new run.');
