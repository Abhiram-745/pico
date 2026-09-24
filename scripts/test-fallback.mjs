#!/usr/bin/env node
/* OpenAI rate limited: the same call goes to xkiro, on the model for the same job.
   No network: fetch is a stand-in. Run with: node scripts/test-fallback.mjs */
import assert from 'node:assert/strict';
import { LLM, PROVIDERS } from '../bridge/llm.mjs';

const seen = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  seen.push({ host: new URL(url).host, model: body.model });
  if (url.includes('openai')) return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers: { 'retry-after-ms': '1' } });
  return Response.json({ choices: [{ message: { role: 'assistant', content: 'from xkiro' } }] });
};

const openai = new LLM({ apiKey: 'sk-test', baseUrl: PROVIDERS.openai.baseUrl, provider: 'openai', tiers: { ...PROVIDERS.openai.tiers } });
const x = PROVIDERS.xkiro;
const xkiro = new LLM({ apiKey: 'xk-test', baseUrl: x.baseUrl, provider: 'xkiro', tiers: { ...x.tiers } });

// Without a fallback, a rate limit is still an error.
await assert.rejects(() => openai.chat([{ role: 'user', content: 'hi' }]), /Rate limited/);

let told = null;
openai.useFallback(xkiro);
openai.onFallback = (name, to) => { told = `${name} -> ${to}`; };
seen.length = 0;
const text = await openai.chat([{ role: 'user', content: 'hi' }], { model: openai.tiers.plan });
assert.equal(text, 'from xkiro');
assert.equal(told, 'chat -> xkiro');
const last = seen.at(-1);
assert.equal(last.host, 'api.xkiro.com', 'the retry went to xkiro');
// gpt-4o-mini serves both plan and fast at OpenAI, so either xkiro model for those jobs is right.
const jobs = Object.keys(openai.tiers).filter((t) => openai.tiers[t] === openai.tiers.plan);
assert.ok(jobs.map((t) => x.tiers[t]).includes(last.model), 'on the model for the same job');
assert.ok(seen.filter((s) => s.host.includes('openai')).length >= 1, 'OpenAI was tried first');

// Anything else is not a reason to switch.
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
await assert.rejects(() => openai.chat([{ role: 'user', content: 'hi' }]), /rejected/);

console.log('fallback: a rate limit moves the call to xkiro, nothing else does — passed');
