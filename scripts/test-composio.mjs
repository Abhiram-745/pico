import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HaloComposio, WATCH_SLUGS, SEND_SLUGS, watchOpenUrl } from '../bridge/composio.mjs';
import { handleComposioRoutes } from '../bridge/composio-routes.mjs';
import { assessComposio } from '../bridge/policy.mjs';
import { DesktopMonitor } from '../bridge/desktop-monitor.mjs';
const account = { id: 'ca_test', toolkit: { slug: 'gmail' }, status: 'ACTIVE' };
function fixture(config = {}, guardian = async () => true) {
  const calls = [];
  const client = { connectedAccounts: { list: async q => { calls.push(['list', q]); return { items: [account] }; }, disable: async id => calls.push(['disable', id]) }, sessions: { create: async (id, options) => { calls.push(['session', id, options]); return { authorize: async app => { calls.push(['authorize', app]); return { redirectUrl: 'https://connect.composio.dev/link/mock' }; } }; } }, tools: { getRawComposioToolBySlug: async slug => ({ version: '20261103_00', inputParameters: { properties: { calendar_id: {}, timeMin: {}, timeMax: {} } } }), execute: async (slug, params) => { calls.push(['execute', slug, params]); return { successful: true, data: { messages: [{ labelIds: ['INBOX'] }] } }; } } };
  return { calls, client, integration: new HaloComposio({ client, key: '', config: { enabled: true, selectedAccounts: { gmail: account.id }, ...config }, guardian }) };
}
test('disabled and no-key paths do no network work or secret reads while disabled', async () => {
  let reads = 0;
  const c = new HaloComposio({ key: '', loadKey: async () => { reads++; return ''; } });
  assert.deepEqual(await c.connections(), []); assert.equal(reads, 0);
  c.configure({ enabled: true }); assert.deepEqual(await c.connections(), []); assert.equal(reads, 1);
  await assert.rejects(c.execute('GMAIL_FETCH_EMAILS', {}), /disabled or has no key/);
});
test('exact allowlist blocks unknown and MCP generic executors', async () => {
  const { integration, calls } = fixture();
  for (const slug of ['GMAIL_SEND_EMAIL', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'SLACK_SEND_MESSAGE', 'not_a_tool']) await assert.rejects(integration.execute(slug, {}), /not allowlisted/);
  assert.equal(calls.length, 0); assert.equal(WATCH_SLUGS.length, 9);
});
test('send requires matching single-use server receipt, not model boolean', async () => {
  const { integration, calls } = fixture();
  for (const slug of SEND_SLUGS) await assert.rejects(integration.execute(slug, {}, { approved: true }), /approval required/);
  const receipt = integration.approveSend('GMAIL_SEND_DRAFT', { id: 'draft1' }, account.id);
  await assert.rejects(integration.execute('GMAIL_SEND_DRAFT', { id: 'draft2' }, { accountId: account.id, approvalId: receipt }), /approval required/);
  await assert.rejects(integration.execute('GMAIL_SEND_DRAFT', { id: 'draft1' }, { accountId: account.id, approvalId: receipt }), /approval required/);
  assert.equal(calls.length, 0);
});
test('watch app gating and account ownership enforced before execution', async () => {
  const { integration, calls } = fixture();
  await assert.rejects(integration.execute('GMAIL_FETCH_EMAILS', {}, { watch: true }), /not allowed/);
  integration.configure({ watchApps: ['gmail'] });
  await assert.rejects(integration.execute('GMAIL_CREATE_EMAIL_DRAFT', {}, { watch: true }), /not allowed/);
  await assert.rejects(integration.execute('GMAIL_FETCH_EMAILS', {}, { accountId: 'other' }), /matching connection/);
  assert(!calls.some(x => x[0] === 'execute'));
  assert.throws(() => integration.configure({ watchApps: ['slack'] }));
  assert.throws(() => integration.configure({ enabled: 'yes' }));
});
test('execution uses schema version and explicit account without latest bypass', async () => {
  const { integration, calls } = fixture(); await integration.execute('GMAIL_FETCH_EMAILS', { query: 'test' });
  const params = calls.find(x => x[0] === 'execute')[2];
  assert.equal(params.version, '20261103_00'); assert.equal(params.connectedAccountId, account.id); assert(!('dangerouslySkipVersionCheck' in params));
});
test('reuse avoids OAuth and session authorize needs no custom auth config', async () => {
  const { integration, calls } = fixture(); assert.equal((await integration.connect('gmail')).reused, true);
  assert(!calls.some(x => x[0] === 'session'));
  assert.match((await integration.connect('googlecalendar')).redirectUrl, /^https:/);
  const options = calls.find(x => x[0] === 'session')[2]; assert.deepEqual(options.toolkits, ['gmail', 'outlook', 'googlecalendar', 'slack']); assert.deepEqual(options.tools.slack.enable, []);
  assert(!('authConfigs' in options));
});
test('mail tools require guardian and policy rejects generic send', async () => {
  const { integration, calls } = fixture({}, async () => false);
  await assert.rejects(integration.agentTool('search_mail', {}), /guardian/);
  await assert.rejects(integration.agentTool('GMAIL_SEND_DRAFT', {}), /guardian/);
  assert.equal(calls.length, 0); assert.equal(assessComposio('list_unread').decision, 'RequireConfirmation'); assert.equal(assessComposio('send').decision, 'Deny');
});
test('watch maps sampled unread and possible reply, throttles and avoids cache mutation', async () => {
  const { integration, calls } = fixture({ watchApps: ['gmail'] });
  const rows = await integration.pollSignals(); assert.equal(rows.length, 2); assert(rows[1].detail.includes('may need a reply'));
  rows.push({ junk: true }); assert.equal((await integration.pollSignals()).length, 2);
  assert.equal(calls.filter(x => x[0] === 'execute').length, 1);
  integration.configure({ enabled: false }); assert.deepEqual(await integration.pollSignals(), []);
});
test('calendar mapping only uses current schema and upcoming timed events', async () => {
  const { integration, client } = fixture({ watchApps: ['googlecalendar'], selectedAccounts: { googlecalendar: 'cal1' } });
  client.connectedAccounts.list = async () => ({ items: [{ id: 'cal1', toolkit: { slug: 'googlecalendar' }, status: 'ACTIVE' }] });
  client.tools.execute = async () => ({ successful: true, data: { items: [{ start: { dateTime: new Date(Date.now()+600000).toISOString() } }, { start: { date: '2026-11-05' } }] } });
  const rows = await integration.pollSignals(); assert.equal(rows.length, 1); assert.match(rows[0].detail, /^1 calendar/);
});
test('desktop cards can open only fixed provider destinations and dismiss', async () => {
  const { integration } = fixture({ watchApps: ['gmail'] }); let opened;
  const monitor = new DesktopMonitor({ watchSignals: () => integration.pollSignals(), openWatch: async app => { opened = watchOpenUrl(app); return true; }, readWindows: async () => [], readSessions: async () => [] });
  await monitor.configure({ enabled: true }); await monitor.refresh();
  const row = monitor.snapshot().apps.find(x => x.source === 'composio'); assert(row); assert(await monitor.openResult(row.resultId)); assert.equal(opened, 'https://mail.google.com/'); assert(monitor.dismiss(row.resultId)); assert.equal(watchOpenUrl('javascript:bad'), null); monitor.stop();
});
async function request(path, body, overrides = {}) {
  const { integration } = fixture(); let status, response;
  const req = { method: body === undefined ? 'GET' : 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); }, ...overrides };
  const res = { writeHead(code) { status = code; }, end(data) { response = JSON.parse(data); } };
  await handleComposioRoutes(req, res, path, { composio: integration }); return { status, response };
}
test('routes reject nonlocal and cross-origin requests, no executor or key echo', async () => {
  assert.equal((await request('/composio', undefined, { socket: { remoteAddress: '192.168.1.1' } })).status, 403);
  assert.equal((await request('/composio', undefined, { headers: { host: 'localhost:3000', origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/composio/execute', { slug: 'GMAIL_SEND_DRAFT', approved: true })).status, 404);
  assert.equal((await request('/composio/settings', { watchApps: ['bad'] })).status, 400);
  const result = await request('/composio'); assert.equal(result.status, 200); assert(!JSON.stringify(result.response).includes('apiKey'));
});
test('actual HostAgent guardian awaits Halo approval despite autoApproveAll', async () => {
  process.env.HALO_HOME = '/tmp/halo-composio-unit-test';
  const { HostAgent } = await import('../bridge/agent.mjs');
  const cards = [];
  const agent = { composio: {}, runToken: 1, settings: { autoApproveAll: true }, superseded: () => false, emit: (type, card) => cards.push({ type, card }) };
  let done = false;
  const pending = HostAgent.prototype.integrationGuardian.call(agent, { name: 'draft_reply_do_not_send', args: { body: 'mock draft' } }).then(x => { done = true; return x; });
  await Promise.resolve(); assert.equal(done, false); assert.equal(cards[0].type, 'approval'); agent._approveResolve(false); assert.equal(await pending, false);
});
test('configuration changes invalidate a pending guardian approval', async () => {
  let release; const { integration, calls } = fixture({}, () => new Promise(resolve => { release = resolve; }));
  const pending = integration.agentTool('search_mail', { query: 'test' });
  integration.configure({ selectedAccounts: { gmail: 'different' } }); release(true);
  await assert.rejects(pending, /changed during approval/); assert(!calls.some(x => x[0] === 'execute'));
});
test('valid send receipt works only once against a mock SDK', async () => {
  const { integration, calls } = fixture(); const args = { draft_id: 'mock-only' };
  const receipt = integration.approveSend('GMAIL_SEND_DRAFT', args, account.id);
  await integration.execute('GMAIL_SEND_DRAFT', args, { accountId: account.id, approvalId: receipt });
  await assert.rejects(integration.execute('GMAIL_SEND_DRAFT', args, { accountId: account.id, approvalId: receipt }), /approval required/);
  assert.equal(calls.filter(x => x[0] === 'execute').length, 1);
});
test('key saving uses injected secret store and returns no key', async () => {
  let saved; const c = new HaloComposio({ key: '', saveKey: async value => { saved = value; } });
  await c.setKey('mock-value-for-unit-test'); assert.equal(saved, 'mock-value-for-unit-test'); assert(c.state().hasKey); assert(!JSON.stringify(c.state()).includes(saved));
});

test('Connections missing-key enable path and disabled controls remain discoverable', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../pico-ui/react/connections.jsx', import.meta.url), 'utf8');
  for (const text of ['Halo/Composio', 'COMPOSIO_API_KEY', 'No API key loaded — Workspace email/calendar watch stays off until a key is saved.', 'Key available · Disabled — turn on Enable Composio.']) assert(ui.includes(text));
  assert.match(ui, /type="password"/); assert.match(ui, /disabled=\{busy \|\| demo \|\| !state\?\.hasKey\}/);
  assert.match(ui, /disabled=\{busy \|\| !state\?\.hasKey \|\| !state\?\.enabled/);
});
