import assert from 'node:assert/strict';
import { desktopRequestAllowed, handleDesktopRoutes } from '../bridge/desktop-routes.mjs';

const local = { host: 'localhost:4177', origin: 'http://localhost:4177', 'sec-fetch-site': 'same-origin' };
const request = ({method='GET',headers=local,ip='127.0.0.1',raw='',chunks}={}) => ({
  method, headers, socket: {remoteAddress:ip},
  async *[Symbol.asyncIterator]() { for (const chunk of chunks ?? [raw]) yield Buffer.from(chunk); },
});
assert.equal(desktopRequestAllowed(request()), true);
assert.equal(desktopRequestAllowed(request({ip:'::ffff:127.0.0.1'})), true);
assert.equal(desktopRequestAllowed(request({ip:'::1',headers:{host:'[::1]:4177',origin:'http://[::1]:4177'}})), true);
for (const options of [
  {ip:'192.168.1.2'}, {ip:'::'}, {headers:{host:'evil.example'}},
  {headers:{...local,origin:'https://evil.example'}},
  {headers:{...local,origin:'http://localhost:4178'}},
  {headers:{...local,'sec-fetch-site':'cross-site'}},
  {headers:{...local,'sec-fetch-site':'same-site'}},
  {headers:{host:'localhost:4177/path'}},
]) assert.equal(desktopRequestAllowed(request(options)), false, JSON.stringify(options));

let state, calls, saved;
const reset = (enabled=false) => {
  state = {enabled,paused:false,apps:[],events:[],settings:{selectedApps:['codex'],customApps:[],intervalSeconds:15,aiSummaries:false,quiet:true}};
  calls = []; saved = [];
};
const monitor = {
  snapshot:()=>structuredClone(state),
  async configure(patch) {
    calls.push(['configure',structuredClone(patch)]);
    for (const [key,value] of Object.entries(patch)) {
      if (['enabled','paused'].includes(key)) state[key]=value;
      else state.settings[key]=value;
    }
  },
  async refresh() { calls.push(['refresh']); return this.snapshot(); },
};
const deps = {
  monitor,
  persist(settings) { calls.push(['persist']); saved.push(settings); },
  async onModeChange(mode) { calls.push(['mode',mode]); await Promise.resolve(); },
};
async function run(path='/desktop-monitor', options={}, overrides={}) {
  let status, data, headers;
  const response = { writeHead(code,h) {status=code;headers=h;}, end(body) {data=body?JSON.parse(body):null;} };
  const handled = await handleDesktopRoutes(request(options),response,path,{...deps,...overrides});
  return {handled,status,data,headers};
}
const post = (body) => ({method:'POST',raw:JSON.stringify(body)});
reset();
assert.equal((await run('/unrelated')).handled,false);
assert.equal((await run()).status,200);
assert.equal((await run()).headers['Cache-Control'],'no-store');
for (const [path,method] of [['/desktop-monitor','POST'],['/desktop-monitor/settings','GET'],['/desktop-monitor/refresh','GET'],['/desktop-monitor/nope','POST']]) {
  assert.equal((await run(path,{method})).status,405);
}
assert.equal(calls.length,0);
assert.equal((await run('/desktop-monitor/refresh',{method:'POST'})).status,200);
assert.deepEqual(calls,[['refresh']]);
reset();
assert.equal((await run('/desktop-monitor/settings',{...post({enabled:true}),ip:'10.0.0.1'})).status,403);
assert.equal(calls.length,0);
for (const raw of ['', '{', 'null','[]','"hello"','true']) {
  assert.equal((await run('/desktop-monitor/settings',{method:'POST',raw})).status,400,raw);
}
assert.equal((await run('/desktop-monitor/settings',{method:'POST',chunks:['{"customApps":["', 'a'.repeat(9000),'which-app"]}']})).status,413);
for (const body of [
  {enabled:'yes'}, {paused:0}, {aiSummaries:'true'}, {quiet:null},
  {selectedApps:'codex'}, {selectedApps:['']}, {customApps:[1]},
  {customApps:['a'.repeat(81)]}, {selectedApps:Array(31).fill('codex')},
  {intervalSeconds:4}, {intervalSeconds:301}, {intervalSeconds:'15'}, {intervalSeconds:null},
  {settings:[]}, {settings:'invalid'}, {settings:null},
]) assert.equal((await run('/desktop-monitor/settings',post(body))).status,400,JSON.stringify(body));
assert.equal(calls.length,0,'Invalid requests must not change modes, configure, or persist.');

const enabled = await run('/desktop-monitor/settings',post({enabled:true,settings:{selectedApps:['codex','codex',' claude '],customApps:[' My editor '],intervalSeconds:15.6,aiSummaries:true}}));
assert.equal(enabled.status,200);
assert.deepEqual(calls.map(x=>x[0]),['mode','configure','persist']);
assert.deepEqual(calls[0],['mode','desktop']);
assert.deepEqual(enabled.data.settings.selectedApps,['codex','claude']);
assert.equal(saved[0].enabled,true);
assert.equal(saved[0].intervalSeconds,16);
assert.deepEqual(saved[0].customApps,['My editor']);
assert.equal('apps' in saved[0],false,'Persist preferences, not observed app content.');

calls=[];
await run('/desktop-monitor/settings',post({enabled:true,paused:true}));
assert.deepEqual(calls.map(x=>x[0]),['configure','persist'],'Already-enabled settings do not stop the agent again.');
calls=[];
await run('/desktop-monitor/settings',post({enabled:false}));
assert.deepEqual(calls.map(x=>x[0]),['configure','persist','mode']);
assert.deepEqual(calls[2],['mode','agent']);
assert.equal(saved.at(-1).enabled,false);
reset();
const failed = await run('/desktop-monitor/settings',post({enabled:true}),{onModeChange:async()=>{throw new Error('private diagnostics');}});
assert.equal(failed.status,500);
assert.equal(state.enabled,false,'A failed agent stop must not enable monitoring.');
assert.equal(JSON.stringify(failed.data).includes('private diagnostics'),false);
assert.equal(calls.length,0);
console.log('Desktop routes: local origin/method guards, validation, size limits, ordered mode transitions and preference persistence passed.');

reset(true);
const eventId = '0123456789abcdef';
const resultMonitor = { ...monitor,
  dismiss(id) { calls.push(['dismiss', id]); return id === eventId; },
  async openResult(id) { calls.push(['open', id]); return id === eventId; },
};
assert.equal((await run(`/desktop-monitor/open/${eventId}`, { method: 'GET' }, { monitor: resultMonitor })).status, 405);
assert.equal((await run(`/desktop-monitor/open/${eventId}`, { method: 'POST', ip: '10.0.0.1' }, { monitor: resultMonitor })).status, 403);
assert.equal((await run('/desktop-monitor/open/../../cmd', { method: 'POST' }, { monitor: resultMonitor })).status, 405);
assert.equal(calls.length, 0, 'read requests and remote callers cannot focus windows');
assert.equal((await run(`/desktop-monitor/open/${eventId}`, { method: 'POST' }, { monitor: resultMonitor })).data.opened, true);
assert.deepEqual(calls, [['open', eventId]], 'only a server-known opaque result ID is passed');
assert.equal((await run('/desktop-monitor/open/ffffffffffffffff', { method: 'POST' }, { monitor: resultMonitor })).status, 409);
assert.equal((await run(`/desktop-monitor/dismiss/${eventId}`, { method: 'POST' }, { monitor: resultMonitor })).status, 200);
assert.equal((await run('/desktop-monitor/dismiss/ffffffffffffffff', { method: 'POST' }, { monitor: resultMonitor })).status, 404);
console.log('Result routes: explicit local-only open/dismiss, opaque IDs and unavailable-window handling passed.');
