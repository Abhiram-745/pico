#!/usr/bin/env node
/* OpenAI rate limited: the same call goes to xkiro, on the model for the same job.
   No network: fetch is a stand-in. Run with: node scripts/test-fallback.mjs */
import assert from 'node:assert/strict';
import { LLM, PROVIDERS, limitWait } from '../bridge/llm.mjs';

const x = PROVIDERS.xkiro;
const limited = (message = 'Rate limit reached', { code = 'rate_limit_exceeded', headers = { 'retry-after-ms': '1' } } = {}) => new Response(JSON.stringify({ error: { message, code } }), { status: 429, headers });
const fine = (content) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });

const seen = [];
let openaiSays = () => limited();
let xkiroSays = () => fine('from xkiro');
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  seen.push({ host: new URL(url).host, model: body.model });
  return url.includes('openai') ? openaiSays() : xkiroSays();
};
const fromOpenAI = () => seen.filter((s) => s.host.includes('openai')).length;

const make = () => {
  const openai = new LLM({ apiKey: 'sk-test', baseUrl: PROVIDERS.openai.baseUrl, provider: 'openai', tiers: { ...PROVIDERS.openai.tiers } });
  const xkiro = new LLM({ apiKey: 'xk-test', baseUrl: x.baseUrl, provider: 'xkiro', tiers: { ...x.tiers } });
  return { openai, xkiro };
};

// How long a limit asks for, from its headers or its words.
assert.equal(limitWait(new Response('', { headers: { 'retry-after-ms': '850' } }), null), 850);
assert.equal(limitWait(new Response('', { headers: { 'retry-after': '2' } }), null), 2000);
assert.equal(limitWait(null, { error: { message: 'Limit 200000, Used 199000. Please try again in 1.2s. Visit …' } }), 1200);
assert.equal(limitWait(null, { error: { message: 'on requests per day (RPD). Please try again in 6m0s.' } }), 360_000);
assert.equal(limitWait(null, { error: { message: 'Please try again in 1h2m3.5s.' } }), 3_723_500);
assert.equal(limitWait(null, { error: { message: 'Please try again in 350ms.' } }), 350);
assert.equal(limitWait(null, { error: { message: 'Slow down.' } }), null);

{
  const { openai, xkiro } = make();
  // Without a fallback, a rate limit is still an error.
  await assert.rejects(() => openai.chat([{ role: 'user', content: 'hi' }]), /Rate limited/);

  let told = null;
  openai.useFallback(xkiro);
  openai.onFallback = (name, to, forMs) => { told = { said: `${name} -> ${to}`, forMs }; };
  seen.length = 0;
  const text = await openai.chat([{ role: 'user', content: 'hi' }], { model: openai.tiers.plan });
  assert.equal(text, 'from xkiro');
  assert.equal(told.said, 'chat -> xkiro');
  assert.ok(told.forMs >= 20_000, 'a spell of at least 20s');
  const last = seen.at(-1);
  assert.equal(last.host, 'api.xkiro.com', 'the retry went to xkiro');
  // gpt-4o-mini serves both plan and fast at OpenAI, so either xkiro model for those jobs is right.
  const jobs = Object.keys(openai.tiers).filter((t) => openai.tiers[t] === openai.tiers.plan);
  assert.ok(jobs.map((t) => x.tiers[t]).includes(last.model), 'on the model for the same job');
  assert.ok(fromOpenAI() >= 1, 'OpenAI was tried first');

  // Inside the spell, the next call goes straight to xkiro — OpenAI is not asked again.
  seen.length = 0;
  told = null;
  assert.equal(await openai.chat([{ role: 'user', content: 'and again' }]), 'from xkiro');
  assert.equal(fromOpenAI(), 0, 'no second round of being told no');
  assert.equal(told, null, 'said once a spell, not once a call');

  // A call with a picture goes to xkiro's reader of pictures, whatever job it was.
  seen.length = 0;
  const shot = { type: 'image', b64: 'AAAA', mime: 'image/png', detail: 'high' };
  const tool = { type: 'function', function: { name: 'act', description: 'act', parameters: { type: 'object', properties: {} } } };
  xkiroSays = () => Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'act', arguments: '{}' } }] } }] });
  const out = await openai.respond({ model: openai.tiers.plan, system: 's', content: [{ type: 'text', text: 'look' }, shot], tools: [tool] });
  assert.equal(out.call?.name, 'act');
  assert.equal(seen.at(-1).model, x.tiers.see, 'a screenshot is read by the model that reads them');
  xkiroSays = () => fine('from xkiro');

  // xkiro failing inside the spell: OpenAI after all, which may have recovered.
  seen.length = 0;
  xkiroSays = () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  openaiSays = () => fine('from openai');
  assert.equal(await openai.chat([{ role: 'user', content: 'hi' }]), 'from openai');
  xkiroSays = () => fine('from xkiro');
}

{
  // A long wait is not sat through when there is somewhere else to go.
  const { openai, xkiro } = make();
  let forMs = 0;
  openai.useFallback(xkiro);
  openai.onFallback = (_n, _t, ms) => { forMs = ms; };
  openaiSays = () => limited('Rate limit reached on requests per day (RPD). Please try again in 6m0s.', { headers: {} });
  seen.length = 0;
  const t0 = Date.now();
  assert.equal(await openai.chat([{ role: 'user', content: 'hi' }]), 'from xkiro');
  assert.equal(fromOpenAI(), 1, 'asked OpenAI once, not three times');
  assert.ok(Date.now() - t0 < 1000, 'and did not wait');
  assert.equal(forMs, 360_000, 'stays on xkiro for as long as the limit said');
}

{
  // Out of quota: nothing to wait for, and the spell is the longest.
  const { openai, xkiro } = make();
  openaiSays = () => limited('You exceeded your current quota', { code: 'insufficient_quota', headers: {} });
  seen.length = 0;
  await assert.rejects(() => openai.chat([{ role: 'user', content: 'hi' }]), /no credits left/);
  assert.equal(fromOpenAI(), 1, 'no retries for an empty account');

  let forMs = 0;
  openai.useFallback(xkiro);
  openai.onFallback = (_n, _t, ms) => { forMs = ms; };
  assert.equal(await openai.chat([{ role: 'user', content: 'hi' }]), 'from xkiro');
  assert.equal(forMs, 600_000);

  // An empty prepaid balance, as OpenAI actually words it: the same.
  const fresh = make();
  openaiSays = () => limited('You have no credits remaining. Add credits to continue using the API.', { code: 'credit_balance_exhausted', headers: {} });
  seen.length = 0;
  await assert.rejects(() => fresh.openai.chat([{ role: 'user', content: 'hi' }]), /no credits left/);
  assert.equal(fromOpenAI(), 1, 'no retries for an empty balance either');
}

{
  // A stream that fails part-way on xkiro is not started over on OpenAI.
  const { openai, xkiro } = make();
  openai.useFallback(xkiro);
  openai._limitedUntil = Date.now() + 60_000;
  const said = [];
  xkiro.stream = async (_m, { onDelta }) => { onDelta('Hel'); throw new Error('connection dropped'); };
  openaiSays = () => fine('should not be asked');
  seen.length = 0;
  await assert.rejects(() => openai.stream([{ role: 'user', content: 'hi' }], { onDelta: (p) => said.push(p) }), /dropped/);
  assert.deepEqual(said, ['Hel']);
  assert.equal(fromOpenAI(), 0);
}

{
  // OpenAI down (a 5xx): the call would fail, so xkiro answers it, for a short spell.
  const { openai, xkiro } = make();
  let told = null;
  openai.useFallback(xkiro);
  openai.onFallback = (_n, _t, ms, status) => { told = { ms, status }; };
  openaiSays = () => new Response(JSON.stringify({ error: { message: 'The server had an error while processing your request.' } }), { status: 500 });
  assert.equal(await openai.chat([{ role: 'user', content: 'hi' }]), 'from xkiro');
  assert.deepEqual(told, { ms: 20_000, status: 500 });
}

{
  // Both out — OpenAI's credits and xkiro's day — one error with both reasons, at once, and then without asking.
  const { openai, xkiro } = make();
  openai.useFallback(xkiro);
  openai.onFallback = () => {};
  openaiSays = () => limited('You have no credits remaining.', { code: 'credit_balance_exhausted', headers: {} });
  xkiroSays = () => new Response(JSON.stringify({ error: { message: "You've reached today's free-model token quota.", code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '10182', 'x-ratelimit-window': 'day' } });
  seen.length = 0;
  const t0 = Date.now();
  const err = await openai.chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
  assert.match(err.message, /^OpenAI has no credits left.*xkiro's allowance for today is used up — it resets at \d\d:\d\d\.$/, err.message);
  assert.ok(Date.now() - t0 < 1000, 'no sitting through a limit that lifts in hours');
  assert.equal(seen.length, 2, 'each asked once');
  seen.length = 0;
  const again = await openai.chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
  assert.equal(again.message, err.message);
  assert.equal(seen.length, 0, 'and then neither is asked again until one of them is back');
  xkiroSays = () => fine('from xkiro');
}

{
  // A limit that lifts in a few seconds is waited out whole, once; a longer one is not waited for at all.
  const { openai } = make();
  let n = 0;
  openaiSays = () => (++n === 1 ? limited('Please try again in 300ms.', { headers: {} }) : fine('after the wait'));
  assert.equal(await openai.chat([{ role: 'user', content: 'hi' }]), 'after the wait');
  n = 0;
  openaiSays = () => limited('Please try again in 40s.', { headers: {} });
  const t0 = Date.now();
  const err = await openai.chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
  assert.ok(Date.now() - t0 < 1000 && /Rate limited/.test(err.message), `${Date.now() - t0}ms: ${err.message}`);
}

{
  // Anything else is not a reason to switch.
  const { openai, xkiro } = make();
  openai.useFallback(xkiro);
  openaiSays = () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  seen.length = 0;
  await assert.rejects(() => openai.chat([{ role: 'user', content: 'hi' }]), /rejected/);
  assert.equal(seen.length, 1, 'xkiro was not asked');
}

console.log('fallback: a rate limit or a server error moves calls to xkiro for the spell, pictures to its reader, nothing else moves them — passed');
