import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LLM, PROVIDERS, GEMINI_MODELS, OPENAI_ALLOWED, providerOrder } from '../bridge/llm.mjs';
import { matchesGeminiWindow, DesktopMonitor, normalizeMonitorSettings, DEFAULT_MONITOR_SETTINGS, readAgentSessions } from '../bridge/desktop-monitor.mjs';
import { ModelProviderSettings, handleModelProviderRoutes } from '../bridge/model-provider.mjs';
import { SITES, parseOpen, preference } from '../bridge/apps.mjs';
import { workspaceStatus, workspaceCompactStatus, workspaceNotice } from '../pico-ui/src/workspace-status.js';

const KEY = 'offline-gemini-test-key';
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai';
const tool = { type: 'function', function: { name: 'act', description: 'Choose a safe action', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } };
const make = (patch = {}) => new LLM({ provider: 'gemini', baseUrl: 'https://wrong.invalid', apiKey: KEY, tiers: { ...PROVIDERS.gemini.tiers }, ...patch });
const completion = (content = 'Offline reply') => Response.json({ choices: [{ message: { role: 'assistant', content } }] });
const toolReply = (calls = [{ id: 'one', type: 'function', function: { name: 'act', arguments: '{"action":"observe"}' } }]) => Response.json({ choices: [{ message: { content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function withFetch(mock, run) { const original = globalThis.fetch; globalThis.fetch = mock; try { return await run(); } finally { globalThis.fetch = original; } }
const env = patch => ({ PICO_PROVIDER: 'gemini', GEMINI_API_KEY: KEY, ...patch });

test('optional Gemini env selection defaults every tier to current Flash-Lite; does not auto-select for key presence', async () => {
  assert(!providerOrder({ GEMINI_API_KEY: KEY }).includes('gemini'));
  assert.deepEqual(providerOrder({ PICO_PROVIDER: 'GEMINI' }), ['gemini']);
  await withFetch(() => { throw Error('configuration must be offline'); }, async () => {
    assert.equal(await LLM.fromEnv({ env: { GEMINI_API_KEY: KEY } }), null);
    const llm = await LLM.fromEnv({ env: env() });
    assert.equal(llm.provider, 'gemini'); assert.equal(llm.baseUrl, endpoint); assert.equal(llm._responses, false);
    assert.deepEqual(new Set(Object.values(llm.tiers)), new Set(['gemini-3.5-flash-lite']));
  });
});
test('Gemini permits only the two current Flash choices and ignores unrelated model/base/gateway overrides', async () => {
  const llm = await LLM.fromEnv({ env: env({ GEMINI_MODEL: 'gemini-3.8-flash', PICO_MODEL: 'gpt-5.4-mini', PICO_MODEL_SEE: 'arbitrary-large-pro', PICO_BASE_URL: 'https://wrong.invalid', AI_GATEWAY_API_KEY: 'mock-gateway', OPENAI_API_KEY: 'mock-openai', PICO_FALLBACK: 'on' }) });
  assert(Object.values(llm.tiers).every(model => model === 'gemini-3.8-flash')); assert.equal(llm.gatewayKey, null); assert.equal(llm.fallback, undefined);
  const rejected = await LLM.fromEnv({ env: env({ GEMINI_MODEL: 'gemini-2.0-flash', PICO_MODEL_FAST: 'gemini-3.1-pro' }) });
  assert.equal(rejected.model, GEMINI_MODELS[0]);
  assert.throws(() => make({ tiers: { fast: 'large-pro' } }), /supported Gemini/);
  assert.throws(() => llm.useFallback(make()), /explicitly selected/);
  await withFetch(() => { throw Error('must not fetch'); }, async () => {
    await assert.rejects(llm.chat([], { model: 'google/arbitrary-pro' }), /supported Flash/);
    assert.equal(await llm.evaluate({}, { test: {} }), null);
  });
});
test('OpenAI model allowlist, adoption and fallback defaults remain unchanged', async () => {
  const llm = await LLM.fromEnv({ env: { PICO_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-openai', PICO_MODEL: 'gpt-large', PICO_MODEL_SEE: 'gemini-3.8-flash' } });
  assert(Object.values(llm.tiers).every(model => OPENAI_ALLOWED.includes(model)));
  llm.adopt(['gemini-3.8-flash','gpt-large','gpt-4.1-mini']); assert(Object.values(llm.tiers).every(model => OPENAI_ALLOWED.includes(model)));
  assert.deepEqual(OPENAI_ALLOWED, ['gpt-5.4-mini','gpt-5.4-nano','gpt-5-mini','gpt-5-nano','gpt-4.1-mini','gpt-4.1-nano','gpt-4o-mini','o3-mini','o4-mini']);
});
test('missing Gemini key never falls through to configured OpenAI and never calls a network endpoint', async () => {
  let calls = 0;
  await withFetch(() => { calls++; throw Error('unexpected network'); }, async () => {
    assert.equal(await LLM.fromEnv({ env: { PICO_PROVIDER: 'gemini', OPENAI_API_KEY: 'mock-openai' } }), null);
    const noKey = make({ apiKey: '' }); assert.equal((await noKey.check()).ok, false);
    await assert.rejects(noKey.chat([]), /configured API key/); assert.equal(calls, 0);
  });
});
test('exact Gemini chat and model-list endpoint/auth; no native key header, URL key, or Responses request', async () => {
  const calls = [];
  await withFetch(async (url, init) => { calls.push([url, init]); return url.endsWith('/models') ? Response.json({ data: [{ id: 'gemini-3.8-pro' }] }) : completion(); }, async () => {
    const llm = make(); assert.equal(await llm.chat([{ role: 'user', content: 'Hello' }]), 'Offline reply'); assert.equal((await llm.check()).ok, true);
    assert.deepEqual(calls.map(([url]) => url), [`${endpoint}/chat/completions`, `${endpoint}/models`]);
    for (const [url,init] of calls) { assert.equal(init.headers.Authorization, `Bearer ${KEY}`); assert(!('x-goog-api-key' in init.headers)); assert(!url.includes(KEY)); }
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body, { model: GEMINI_MODELS[0], messages: [{ role: 'user', content: 'Hello' }], stream: false, reasoning_effort: 'minimal', max_tokens: 300, temperature: .3 });
    assert.equal(llm.model, GEMINI_MODELS[0]);
  });
});
test('Gemini responds through Chat Completions with function tools and image_url payload; tool args are parsed safely', async () => {
  await withFetch(async (url, init) => {
    assert.equal(url, `${endpoint}/chat/completions`);
    const body = JSON.parse(init.body); assert.equal(body.tool_choice, 'required'); assert.deepEqual(body.tools, [tool]); assert(!('parallel_tool_calls' in body)); assert(!('max_output_tokens' in body));
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.messages.at(-1).content, [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    return toolReply();
  }, async () => {
    const output = await make().respond({ system: 'Act safely', content: [{ type: 'text', text: 'Look' }, { type: 'image', mime: 'image/png', b64: 'AAAA', detail: 'original' }], tools: [tool] });
    assert.deepEqual(output.call.args, { action: 'observe' }); assert.equal(output.call.name, 'act');
  });
});
test('Gemini malformed, unknown and multiple tool calls remain non-actions', async () => {
  const cases = [
    [{ function: { name: 'act', arguments: '{partial' } }],
    [{ function: { name: 'act', arguments: 'null' } }],
    [{ function: { name: 'act', arguments: '[]' } }],
    [{ function: { name: 'send_arbitrary', arguments: '{}' } }],
    [{ function: { name: 'act', arguments: '{}' } }, { function: { name: 'act', arguments: '{}' } }],
  ];
  for (const calls of cases) await withFetch(async () => toolReply(calls), async () => assert.equal((await make().toolCall([], { tools: [tool] })).call, null));
});
test('Gemini SSE handles split UTF-8 frames, final DONE and immediate delta delivery', async () => {
  const encoder = new TextEncoder(), chunks = [': keepalive\n', 'data: {"choices":[{"delta":{"content":"Hello "}}]}\n', 'data: {"choices":[{"delta":{"content":"世界"}}]}\n', 'data: [DONE]\n'];
  let cancelled = false;
  await withFetch(async (_url, init) => { assert.equal(JSON.parse(init.body).stream, true); return new Response(new ReadableStream({ start(controller) { for (const text of chunks) { const bytes = encoder.encode(text); controller.enqueue(bytes.slice(0, bytes.length - 3)); controller.enqueue(bytes.slice(bytes.length - 3)); } }, cancel() { cancelled = true; } })); }, async () => {
    const deltas = []; assert.equal(await make().stream([], { onDelta: piece => deltas.push(piece) }), 'Hello 世界'); assert.deepEqual(deltas, ['Hello ', '世界']); assert(cancelled);
  });
});
test('Gemini blocked SSE cancellation cancels the reader and rejects without late deltas', async () => {
  const abort = new AbortController(); let cancelled = false; const deltas = [];
  await withFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), async () => {
    const pending = make().stream([], { signal: abort.signal, onDelta: piece => deltas.push(piece) }); await flush(); abort.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert(cancelled); assert.deepEqual(deltas, []);
  });
});
test('Gemini aborted JSON completion and already-cancelled calls cannot return actions or consume requests', async () => {
  const abort = new AbortController(); let release, calls = 0;
  await withFetch(async () => { calls++; return { ok: true, text: () => new Promise(resolve => { release = resolve; }) }; }, async () => {
    const pending = make().toolCall([], { tools: [tool], signal: abort.signal }); await flush(); abort.abort(); release('{"choices":[{"message":{"tool_calls":[]}}]}');
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(make().chat([], { signal: abort.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
  });
});
test('Gemini HTTP, stream and network errors redact the injected key and do not fallback', async () => {
  for (const mock of [async () => Response.json({ error: { message: `Provider rejected ${KEY}` } }, { status: 403 }), async () => { throw Error(`Network ${KEY}`); }, async () => new Response(`data: {"error":{"message":"Stream ${KEY}"}}\n\n`)]) {
    await withFetch(mock, async () => {
      let error; try { await make().stream([]); } catch (caught) { error = caught; }
      assert(error); assert(!error.message.includes(KEY));
    });
  }
});
function monitorFixture() {
  let now = 100000, windows = [{ hwnd: '1', process: 'msedge', title: 'Gemini - Google Chrome' }], elements = [], reads = 0, sessions = [];
  const timers = new Map(); let serial = 0;
  const scheduler = { setTimeout(fn, ms) { timers.set(++serial,{ fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); } };
  const m = new DesktopMonitor({ now: () => now, scheduler, readWindows: async () => windows, readSessions: async () => sessions, sense: { elements: async () => { reads++; return elements; } } });
  return { m, tick() { now += 5000; }, now: () => now, reads: () => reads, windows(value) { windows = value; }, elements(value) { elements = value; }, sessions(value) { sessions = value; } };
}
test('Gemini matches anchored browser/PWA/host titles and conservative desktop processes', () => {
  for (const process of ['chrome', 'msedge.exe', 'brave', 'firefox']) {
    for (const title of ['Gemini', 'Google Gemini', 'Gemini - Google Chrome', 'Google Gemini - Microsoft Edge', 'Gemini - Brave', 'Gemini - Firefox', 'A prompt - Google Gemini - Google Chrome', 'A prompt | Google Gemini', 'A prompt - Google Gemini', 'gemini.google.com', 'https://gemini.google.com/app/123 - Google Chrome', 'gemini.google.com/app - Microsoft Edge', 'Gemini - A chat']) {
      assert(matchesGeminiWindow({ process, title }), `${process}: ${title}`);
    }
    for (const title of ['Comparing Gemini models - Google Chrome', 'Ask Gemini - Gmail', 'News about Gemini - Firefox', 'ChatGPT - Google Chrome', 'Gemini models explained - Brave', 'gemini.google.com.evil.test', 'https://evil.test/gemini.google.com', 'Article about gemini.google.com', 'A prompt - Gemini - Google Chrome']) {
      assert(!matchesGeminiWindow({ process, title }), `${process}: ${title}`);
    }
  }
  for (const process of ['gemini', 'Gemini.exe', 'GeminiSetup.exe', 'geminiDesktop', 'geminiapp']) assert(matchesGeminiWindow({ process, title: '' }));
  for (const process of ['notepad', 'chatgpt', 'gemini-news', 'mygemini', 'geminiclienthelper']) assert(!matchesGeminiWindow({ process, title: 'Google Gemini' }));
  assert(!matchesGeminiWindow(null));
});
test('Gemini watch is opt-in, window/PWA titles only and plain open window never proves progress', async () => {
  assert(!DEFAULT_MONITOR_SETTINGS.selectedApps.includes('gemini')); assert(normalizeMonitorSettings({ selectedApps: ['gemini'] }).selectedApps.includes('gemini'));
  const f = monitorFixture();
  try {
    f.m.configure({ enabled: true, selectedApps: [] }); await f.m.refresh(); assert.equal(f.m.snapshot().apps.length, 0); assert.equal(f.reads(), 0);
    f.m.configure({ selectedApps: ['gemini'] }); await f.m.refresh(); assert.equal(f.m.snapshot().apps[0].state, 'open'); assert.equal(f.m.snapshot().events.length, 0); assert.equal(workspaceCompactStatus(f.m.snapshot(), f.now()), 'Gemini open');
    f.windows([{ hwnd: '2', process: 'chrome', title: 'A prompt - Google Gemini - Google Chrome' }]); await f.m.refresh(); assert.equal(f.m.snapshot().apps.length, 1);
    f.windows([{ hwnd: '3', process: 'chrome', title: 'Comparing Gemini models - Google Chrome' }]); await f.m.refresh(); assert.equal(f.m.snapshot().apps.length, 0);
  } finally { f.m.stop(); }
});
test('Gemini uses only explicit enabled control/status evidence, never chat text, edits, disabled controls or transcripts', async () => {
  const f = monitorFixture();
  try {
    f.m.configure({ enabled: true, selectedApps: ['gemini'] });
    f.sessions([{ appId: 'gemini', sessionId: 'private', state: 'completed', latest: 'DO NOT EXPOSE' }]);
    f.elements([{ type: 'Text', name: 'Stop' }, { type: 'Button', name: 'Stop', enabled: false }, { type: 'ProgressBar', name: 'Stop' }, { type: 'Text', name: 'Stop generating' }, { type: 'Edit', name: 'generation complete' }, { type: 'Button', name: 'Stop generating', enabled: false }, { type: 'StatusBar', name: 'generation complete', isPassword: true }]);
    await f.m.refresh(); assert.equal(f.m.snapshot().apps[0].state, 'open'); assert(!JSON.stringify(f.m.snapshot()).includes('DO NOT EXPOSE'));
    for (const [type,name,state] of [['Button','Stop generating','working'], ['Button','Stop','working'], ['Button','Stop response','working'], ['Button','Approval required','waiting'], ['StatusBar','Response completed','completed'], ['StatusBar','Generation failed','failed']]) {
      f.elements([{ type, name }]); f.tick(); await f.m.refresh(); assert.equal(f.m.snapshot().apps[0].state, state); assert.match(workspaceCompactStatus(f.m.snapshot(), f.now()), /Gemini/);
    }
    f.elements([{ type: 'Text', name: 'Done' }]); await f.m.refresh(); assert.equal(f.m.snapshot().apps[0].state, 'open');
    assert.deepEqual(await readAgentSessions(['gemini'], f.now()), []);
  } finally { f.m.stop(); }
});
test('unchanged Gemini controls keep change time; dismissal/pause/removal and shared island foreground protection hold', async () => {
  const f = monitorFixture();
  try {
    f.m.configure({ enabled: true, selectedApps: ['gemini'], quiet: false }); f.elements([{ type: 'StatusBar', name: 'Response completed' }]); await f.m.refresh();
    const first = f.m.snapshot(); f.tick(); await f.m.refresh(); assert.equal(f.m.snapshot().apps[0].changedAt, first.apps[0].changedAt);
    assert.equal(workspaceNotice(f.m.snapshot(), new Set(), f.now(), true), null);
    f.m.dismiss(first.apps[0].resultId); await f.m.refresh(); assert.equal(workspaceCompactStatus(f.m.snapshot(), f.now()), 'Watching');
    f.m.configure({ paused: true }); assert.equal(workspaceCompactStatus(f.m.snapshot(), f.now()), 'Watching paused');
    f.m.configure({ paused: false, selectedApps: [] }); await f.m.refresh(); assert.equal(f.m.snapshot().apps.length, 0);
  } finally { f.m.stop(); }
});
test('Gemini pending accessibility observation cannot republish after configuration cancellation', async () => {
  const f = monitorFixture(); let release;
  try {
    f.m.sense.elements = () => new Promise(resolve => { release = resolve; }); f.m.configure({ enabled: true, selectedApps: ['gemini'] });
    const pending = f.m.refresh(); await flush(); assert(release); f.m.configure({ selectedApps: [] });
    release([{ type: 'StatusBar', name: 'Response completed' }]); await pending; assert.equal(f.m.snapshot().apps.length, 0);
  } finally { f.m.stop(); }
});
test('Gemini known opening target is a fixed website with installed-app/site choice semantics', () => {
  assert.equal(SITES.get('gemini').url, 'https://gemini.google.com/'); assert.equal(SITES.get('gemini').app, true);
  assert.equal(parseOpen('open Gemini web').name, 'gemini'); assert.equal(preference('open Gemini web','gemini'), 'site');
  assert.equal(preference('open Gemini app','gemini'), 'app');
});
test('local provider selection persists only non-secret preferences and does no model probes, auth or API calls', async () => {
  const saved = [], attached = [];
  const service = new ModelProviderSettings({ loadEnvironment: async () => env({ OPENAI_API_KEY: 'mock-openai' }), persist: patch => saved.push(patch), onChange: llm => attached.push(llm) });
  await withFetch(() => { throw Error('must remain offline'); }, async () => {
    const before = await service.state(); assert.equal(before.geminiKeyAvailable, true); assert.equal(before.configuredOnly, true);
    const state = await service.select({ provider: 'gemini', model: 'gemini-3.8-flash' }); assert.equal(state.geminiSelected, true); assert.equal(attached[0].provider, 'gemini');
    assert(Object.values(attached[0].tiers).every(model => model === 'gemini-3.8-flash'));
    assert.deepEqual(saved, [{ provider: 'gemini', model: 'gemini-3.8-flash' }]); assert(!JSON.stringify(state).includes(KEY)); assert(!JSON.stringify(saved).includes(KEY));
  });
});
test('selecting missing-key Gemini detaches old provider rather than silently using it; active foreground refuses changes', async () => {
  let attached = 'old', busy = false;
  const service = new ModelProviderSettings({ loadEnvironment: async () => ({ OPENAI_API_KEY: 'mock-openai' }), onChange: llm => { attached = llm; }, canChange: () => !busy });
  const selected = await service.select({ provider: 'gemini' }); assert.equal(attached, null); assert.equal(selected.geminiKeyAvailable, false); assert.equal(selected.geminiSelected, true);
  busy = true; await assert.rejects(service.select({ provider: 'default' }), { status: 409 });
  for (const patch of [{ provider: 'gemini', model: 'gemini-pro' }, { provider: 'other' }, { provider: 'gemini', key: KEY }]) await assert.rejects(service.select(patch), { status: 400 });
});
test('provider routes reject remote/cross-origin/key-entry requests and redact configuration failures', async () => {
  const service = new ModelProviderSettings({ loadEnvironment: async () => env(), persist: () => { throw Error(KEY); } });
  const route = async (body, extra = {}) => {
    let status, result;
    const req = { method: 'POST', headers: { host: 'localhost:4177', origin: 'http://localhost:4177' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); }, ...extra };
    await handleModelProviderRoutes(req, { writeHead(code) { status = code; }, end(raw) { result = JSON.parse(raw); } }, '/model-provider', service); return { status,result };
  };
  assert.equal((await route({ provider: 'gemini' }, { socket: { remoteAddress: '10.0.0.2' } })).status, 403);
  assert.equal((await route({}, { headers: { host: 'localhost:4177', origin: 'https://wrong.invalid' } })).status, 403);
  assert.equal((await route({ provider: 'gemini', key: KEY })).status, 400);
  const failure = await route({ provider: 'gemini' }); assert.equal(failure.status, 400); assert(!JSON.stringify(failure).includes(KEY));
  const get = await route(undefined, { method: 'GET' }); assert.equal(get.status, 200); assert.equal(get.result.geminiKeyAvailable, true); assert(!JSON.stringify(get).includes(KEY));
});
test('actual UI watch/provider wiring and direct OpenAI-only summary contract remain discoverable', async () => {
  for (const file of ['pico-ui/react/watch.jsx', 'pico-ui/react/workspace.jsx', 'pico-ui/react/desktop-peek.jsx']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8'); assert.match(text, /gemini/);
  }
  const ui = await readFile(new URL('../pico-ui/react/provider-settings.jsx', import.meta.url), 'utf8'); assert.match(ui, /\/model-provider/); assert.match(ui, /Halo reply\/action provider/); assert.match(ui, /Existing environment \(OpenAI \/ configured\)/); assert.match(ui, /direct OpenAI-only/); assert.match(ui, /needs no API key/); assert.match(ui, /API key missing/); assert.match(ui, /access not verified/); assert.doesNotMatch(ui, /localStorage/); assert.match(ui, /type="password"/); assert.match(ui, /Halo\/Gemini/); assert.match(ui, /GEMINI_API_KEY/); assert.match(ui, /Save key securely/);
  const settingsUI = await readFile(new URL('../pico-ui/react/app.jsx', import.meta.url), 'utf8'); assert.match(settingsUI, /Current Halo provider/); assert.match(settingsUI, /API key configured; access not verified/); assert.match(settingsUI, /API key missing/);
  const summary = await readFile(new URL('../bridge/desktop-summary.mjs', import.meta.url), 'utf8'); assert.match(summary, /api\.openai\.com/); assert.doesNotMatch(summary, /generativelanguage/);
  const server = await readFile(new URL('../bridge/server.mjs', import.meta.url), 'utf8'); assert.match(server, /handleModelProviderRoutes/); assert.match(server, /bridge\.llm !== llm/);
});
test('Watch copy leads to app/session detection without keys; API settings are explicitly optional', async () => {
  for (const file of ['watch.jsx', 'workspace.jsx']) {
    const text = await readFile(new URL(`../pico-ui/react/${file}`, import.meta.url), 'utf8');
    assert.match(text, /Google Gemini app or gemini\.google\.com/);
    assert.match(text, /no API key/); assert.match(text, /no chat history scrape/);
  }
  const ui = await readFile(new URL('../pico-ui/react/provider-settings.jsx', import.meta.url), 'utf8');
  assert.match(ui, /Optional: use Gemini API for Halo’s own replies/);
  assert.match(ui, /Settings → Watching — no API key/);
});

test('Gemini abort inside a streamed delta prevents later frames in that same batch', async () => {
  const abort = new AbortController(), deltas = [];
  const frames = 'data: {"choices":[{"delta":{"content":"First"}}]}\ndata: {"choices":[{"delta":{"content":"Late"}}]}\ndata: [DONE]\n';
  await withFetch(async () => new Response(frames), async () => {
    await assert.rejects(make().stream([], { signal: abort.signal, onDelta: value => { deltas.push(value); abort.abort(); } }), { name: 'AbortError' });
    assert.deepEqual(deltas, ['First']);
  });
});
test('a foreground task starting during provider preparation prevents preference persistence and replacement', async () => {
  let release, busy = false, writes = 0, changes = 0;
  const service = new ModelProviderSettings({ loadEnvironment: () => new Promise(resolve => { release = resolve; }), canChange: () => !busy, persist: () => writes++, onChange: () => changes++ });
  const selection = service.select({ provider: 'gemini' }); await flush(); busy = true; release(env());
  await assert.rejects(selection, { status: 409 }); assert.equal(writes, 0); assert.equal(changes, 0); assert.equal(service.preferences.provider, 'default');
});
test('configured environment Gemini model stays visible even without a key', async () => {
  const service = new ModelProviderSettings({ loadEnvironment: async () => ({ PICO_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-3.8-flash' }) });
  const state = await service.state(); assert.equal(state.geminiSelected, true); assert.equal(state.geminiModel, 'gemini-3.8-flash'); assert.equal(state.geminiKeyAvailable, false); assert.equal(state.effectiveProvider, 'gemini');
});
test('existing authorized setup can invalidate cached configuration without breaking explicit Gemini preference', async () => {
  let environment = {}, loads = 0;
  const service = new ModelProviderSettings({ loadEnvironment: async () => { loads++; return { ...environment }; } });
  assert.equal(await service.createLLM(), null); environment = { OPENAI_API_KEY: 'offline-openai' };
  service.invalidateEnvironment(); assert.equal((await service.createLLM()).provider, 'openai'); assert.equal(loads, 2);
  await service.select({ provider: 'gemini' }); environment.GEMINI_API_KEY = KEY;
  service.invalidateEnvironment(); assert.equal((await service.createLLM()).provider, 'gemini');
});

test('Chrome and Gemini selected together retain separate control evidence', async () => {
  const f = monitorFixture();
  try {
    f.elements([{ type: 'Text', name: 'Stop generating' }]);
    f.m.configure({ enabled: true, selectedApps: ['chrome', 'gemini'] });
    await f.m.refresh();
    assert.equal(f.m.snapshot().apps.find(a => a.appId === 'gemini').state, 'open');
    f.elements([{ type: 'Button', name: 'Stop generating', enabled: true }]);
    f.tick(); await f.m.refresh();
    assert.equal(f.m.snapshot().apps.find(a => a.appId === 'gemini').state, 'working');
  } finally { f.m.stop(); }
});

test('Gemini credential save is injected, local-only, redacted and refreshes selected provider', async () => {
  let stored = '', attached, loads = 0;
  const service = new ModelProviderSettings({ preferences: { provider: 'gemini' }, loadGeminiKey: async () => { loads++; return stored; }, saveGeminiKey: async key => { stored = key; }, onChange: llm => { attached = llm; } });
  assert.equal((await service.state()).geminiKeyAvailable, false);
  const route = async (extra = {}) => {
    let status, body;
    const req = { method: 'POST', headers: { host: 'localhost:4177', origin: 'http://localhost:4177' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ key: KEY }); }, ...extra };
    await handleModelProviderRoutes(req, { writeHead(s) { status = s; }, end(raw) { body = JSON.parse(raw); } }, '/model-provider/key', service);
    assert(!JSON.stringify(body).includes(KEY)); return { status, body };
  };
  assert.equal((await route({ socket: { remoteAddress: '10.0.0.2' } })).status, 403); assert.equal(stored, '');
  assert.equal((await route({ headers: { host: 'localhost:4177', origin: 'https://wrong.invalid' } })).status, 403);
  const result = await route(); assert.equal(result.status, 200); assert(result.body.geminiKeyAvailable); assert.equal(stored, KEY); assert.equal(attached.provider, 'gemini'); assert.equal(loads, 2);
  const preferred = new ModelProviderSettings({ loadEnvironment: async () => env(), loadGeminiKey: async () => { throw Error('must not load'); } });
  assert((await preferred.state()).geminiKeyAvailable);
  const failing = new ModelProviderSettings({ saveGeminiKey: async () => { throw Error(KEY); } });
  const original = service.saveGeminiKey; service.saveGeminiKey = failing.saveGeminiKey;
  assert.equal((await route()).status, 400);
  service.saveGeminiKey = async () => { throw Object.assign(Error(KEY), { status: 409 }); };
  assert.equal((await route()).status, 409); service.saveGeminiKey = original;
});

test('LLM environment resolution loads injected Gemini credential only when needed', async () => {
  let loads = 0;
  const loadGeminiKey = async () => { loads++; return KEY; };
  const stored = await LLM.fromEnv({ env: { PICO_PROVIDER: 'gemini' }, loadGeminiKey });
  assert.equal(stored.provider, 'gemini'); assert.equal(stored.apiKey, KEY); assert.equal(loads, 1);
  await LLM.fromEnv({ env: env(), loadGeminiKey }); assert.equal(loads, 1);
  assert.equal(await LLM.fromEnv({ env: {}, loadGeminiKey }), null); assert.equal(loads, 1);
});

test('empty credential reload keeps selected Gemini detached; active task blocks key writes', async () => {
  let writes = 0, attached = 'old', busy = false, selection;
  const service = new ModelProviderSettings({ preferences: { provider: 'gemini' }, loadGeminiKey: async () => '', saveGeminiKey: async () => { writes++; }, onChange: (llm, next) => { attached = llm; selection = next; }, canChange: () => !busy });
  const state = await service.saveKey({ key: KEY }); assert.equal(attached, null); assert.equal(state.geminiKeyAvailable, false); assert.equal(selection.provider, 'gemini');
  busy = true; await assert.rejects(service.saveKey({ key: KEY }), { status: 409 }); assert.equal(writes, 1);
});
test('credential helpers on non-Windows load empty and reject saves without a store', async () => {
  if (process.platform === 'win32') return; // Never touch the real Windows store in tests.
  const { loadGeminiKey, saveGeminiKey } = await import('../bridge/gemini-secret.mjs');
  const { loadComposioKey, saveComposioKey } = await import('../bridge/composio-secret.mjs');
  assert.equal(await loadGeminiKey(), ''); assert.equal(await loadComposioKey(), '');
  await assert.rejects(saveGeminiKey(KEY), /requires Windows Credential Manager/);
  await assert.rejects(saveComposioKey(KEY), /requires Windows Credential Manager/);
});
