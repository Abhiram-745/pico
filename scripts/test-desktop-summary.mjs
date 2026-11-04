import assert from 'node:assert/strict';
import { summarizeDesktop, summaryFacts } from '../bridge/desktop-summary.mjs';
import { providerOrder } from '../bridge/llm.mjs';

assert.equal(providerOrder({ OPENAI_API_KEY: 'test', APINEX_API_KEY: 'test' })[0], 'openai');
assert.deepEqual(providerOrder({ PICO_PROVIDER: 'APINEX' }), ['apinex']);
assert.deepEqual(providerOrder({ PICO_PROVIDER: 'openai' }), ['openai']);

const config = { apiKey: 'private-test-key', model: 'gpt-4o-mini' };
const snapshot = { updatedAt: 123, rawTranscript: 'never serialize this', apps: [{
  id: 'claude', label: 'Claude', state: 'working', source: 'transcript', confidence: 'high',
  detail: 'Writing tests\napi_key=private-token C:\\Users\\Private\\project',
  project: 'Companion', latest: 'Checking the pause controls. password=hidden-value C:\\Users\\Private\\notes ' + 'x'.repeat(300),
  title: 'private window title', transcript: 'full private transcript', lastActivity: 100,
}] };
const facts = summaryFacts(snapshot);
assert.equal(facts.apps[0].state, 'working');
assert.equal(facts.apps[0].project, 'Companion');
assert.ok(facts.apps[0].latest.length <= 180);
assert.ok(!facts.apps[0].latest.includes('hidden-value'));
assert.ok(!JSON.stringify(facts).includes('private-token'));
assert.ok(!JSON.stringify(facts).includes('Private'));
assert.ok(!JSON.stringify(facts).includes('private window title'));
assert.ok(!JSON.stringify(facts).includes('transcript":"'));
assert.equal(summaryFacts({ apps: Array.from({length: 40}, () => ({state:'invented',detail:'x'.repeat(300)})) }).apps.length, 16);
assert.equal(summaryFacts({apps:[{state:'invented'}]}).apps[0].state, 'unknown');

let calls = 0;
const fetchImpl = async (url, init) => {
  calls++;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.Authorization, 'Bearer private-test-key');
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.tools, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.ok(!init.body.includes('never serialize this'));
  assert.ok(!init.body.includes('full private transcript'));
  assert.ok(!init.body.includes('private window title'));
  assert.ok(!init.body.includes('private-token'));
  return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Claude is working on tests.'}]}]})};
};
assert.equal((await summarizeDesktop(snapshot,{config,fetchImpl})).text, 'Claude is working on tests.');
assert.equal(calls, 1);
await assert.rejects(summarizeDesktop(snapshot,{config:{apiKey:'',model:'test'},fetchImpl}), /Add an OpenAI API key/);
assert.equal(calls, 1);
assert.equal((await summarizeDesktop({apps:[]},{config,fetchImpl})).source, 'local');
assert.equal(calls, 1);
for (const status of [401,403,429,500]) {
  await assert.rejects(summarizeDesktop(snapshot,{config,fetchImpl:async()=>({ok:false,status})}), /OpenAI/);
}
await assert.rejects(summarizeDesktop(snapshot,{config,fetchImpl:async()=>{throw new Error('private-test-key');}}), (err) => !err.message.includes(config.apiKey));
await assert.rejects(summarizeDesktop(snapshot,{config,fetchImpl:async()=>({ok:true,json:async()=>({output:[]})})}), /no desktop summary/);
const controller = new AbortController(); controller.abort();
await assert.rejects(summarizeDesktop(snapshot,{config,fetchImpl,signal:controller.signal}), /cancelled/);
const running = new AbortController();
const pending = summarizeDesktop(snapshot,{config,signal:running.signal,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
setTimeout(()=>running.abort(),10);
await assert.rejects(pending, /cancelled/);
console.log('Desktop summary: provider preference, bounded metadata, direct OpenAI, safe errors and cancellation passed.');
