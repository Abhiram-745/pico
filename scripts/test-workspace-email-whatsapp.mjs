import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopMonitor, whatsappTitleSignal } from '../bridge/desktop-monitor.mjs';
import { HaloComposio } from '../bridge/composio.mjs';
import { workspaceStatus, workspaceCompactStatus } from '../pico-ui/src/workspace-status.js';
let clock = 1_000_000;
const outlookSchema = { version: 'offline', inputParameters: { properties: Object.fromEntries(Object.entries({ filter: 'string', folder: 'string', top: 'integer', select: 'array', orderby: 'string', user_id: 'string' }).map(([key,type]) => [key, { type }])) } };
function mailFixture() {
  let messages = [{ id: 'one', subject: 'Review proposal', labelIds: ['INBOX'] }];
  let fail = false;
  const integration = new HaloComposio({ now: () => clock, key: '', config: { enabled: true, watchApps: ['gmail', 'outlook'], selectedAccounts: { gmail: 'g', outlook: 'o' } }, client: {
    connectedAccounts: { list: async () => ({ items: ['gmail','outlook'].map((app,i) => ({ id: i ? 'o' : 'g', toolkit: { slug: app }, status: 'ACTIVE' })) }) },
    tools: { getRawComposioToolBySlug: async () => outlookSchema, execute: async slug => {
      if (slug.startsWith('GMAIL') && fail) throw Error('offline');
      return { successful: true, data: slug.startsWith('GMAIL') ? { messages } : { value: messages } };
    } }
  } });
  return { integration, change: value => { messages = value; clock += 61000; }, fault: () => { fail = true; clock += 61000; } };
}
function monitor(options = {}) {
  const m = new DesktopMonitor({ now: () => clock, readWindows: async () => [], readSessions: async () => [], ...options });
  m.configure({ enabled: true, selectedApps: ['whatsapp'] });
  return m;
}
test('mail repeats dedupe; same-count replacement and changed content produce actionable updates; dismiss and removal persist', async () => {
  const f = mailFixture(); const m = monitor({ watchSignals: () => f.integration.pollSignals() });
  try {
    await m.refresh(); const initial = m.snapshot(); assert.equal(initial.events.length, 3);
    assert.match(initial.summary.text, /Review proposal/);
    await m.refresh(); assert.equal(m.snapshot().events.length, 3);
    const id = initial.apps[0].resultId; m.dismiss(id); await m.refresh(); assert(m.snapshot().apps.find(a => a.resultId === id).dismissed);
    f.change([{ id: 'two', subject: 'Invoice ready', labelIds: ['INBOX'] }]); await m.refresh();
    assert(!m.snapshot().apps.some(a => a.resultId === id)); assert.match(m.snapshot().summary.text, /Invoice ready/);
    const next = m.snapshot().apps[0].resultId;
    f.change([{ id: 'two', subject: 'Invoice revised', labelIds: ['INBOX'] }]); await m.refresh(); assert.notEqual(m.snapshot().apps[0].resultId, next);
    m.syncWatchSources({ enabled: false, watchApps: [], selectedAccounts: {} }); assert.equal(m.snapshot().apps.length, 0); assert.equal(m.snapshot().events.length, 0);
  } finally { m.stop(); }
});
test('one provider failure leaves Outlook healthy; desktop survives rejected watch source', async () => {
  const f = mailFixture(); f.fault(); const rows = await f.integration.pollSignals();
  assert(rows.some(a => a.appId === 'gmail' && a.state === 'unavailable')); assert(rows.some(a => a.appId === 'outlook' && a.state === 'waiting'));
  const m = monitor({ watchSignals: async () => { throw Error('offline'); }, readWindows: async () => [{ hwnd: '1', process: 'WhatsApp', title: '(3) WhatsApp' }] });
  try { await m.refresh(); assert.equal(m.snapshot().apps[0].state, 'waiting'); assert.equal(m.snapshot().sources.watch.available, false); } finally { m.stop(); }
});
test('WhatsApp is opt-in; badge only; no open-window inference or accessibility scraping; dismissal and badge changes', async () => {
  assert.equal(whatsappTitleSignal('WhatsApp'), null); assert.equal(whatsappTitleSignal('(0) WhatsApp'), null);
  let title = '(2) WhatsApp - Google Chrome';
  const m = monitor({ readWindows: async () => [{ hwnd: '5', process: 'chrome', title }], sense: { elements: () => { throw Error('Must not read WhatsApp content'); } } });
  try {
    await m.refresh(); assert.equal(m.snapshot().events.length, 1); const id = m.snapshot().apps[0].resultId;
    m.dismiss(id); await m.refresh(); assert.equal(m.snapshot().events.length, 0);
    title = '(4) WhatsApp'; await m.refresh(); assert.equal(m.snapshot().events.length, 1); assert.match(workspaceStatus(m.snapshot(), clock), /4 unread indicated/);
    title = 'WhatsApp'; await m.refresh(); assert.equal(m.snapshot().apps[0].state, 'open'); assert.equal(m.snapshot().events.length, 0);
    m.configure({ selectedApps: [] }); assert.equal(m.snapshot().apps.length, 0);
  } finally { m.stop(); }
});
test('late async summary cannot overwrite changed mail, dismissal, pause or removal', async () => {
  for (const action of ['change', 'dismiss', 'pause', 'remove']) {
    let release; let contentKey = 'one';
    const m = monitor({ watchSignals: async () => [{ id: 'mail', appId: 'gmail', label: 'Gmail', source: 'composio', state: 'waiting', detail: contentKey, contentKey }], summarize: () => new Promise(resolve => { release = resolve; }) });
    try {
      m.configure({ aiSummaries: true }); await m.refresh(); assert(release);
      if (action === 'change') { contentKey = 'two'; await m.refresh(); }
      if (action === 'dismiss') m.dismiss(m.snapshot().apps[0].resultId);
      if (action === 'pause') m.configure({ paused: true });
      if (action === 'remove') m.syncWatchSources({ enabled: false, watchApps: [], selectedAccounts: {} });
      release('STALE'); await new Promise(resolve => setImmediate(resolve)); assert.notEqual(m.snapshot().summary.text, 'STALE');
    } finally { m.stop(); }
  }
});
test('island selector uses latest evidence, pause and freshness', () => {
  const state = { enabled: true, updatedAt: clock, apps: [{ label: 'Codex', state: 'completed', detail: 'Old result', lastActivity: clock-100 }, { label: 'Outlook', state: 'waiting', detail: 'Invoice ready', lastActivity: clock }] };
  assert.equal(workspaceStatus(state, clock), 'Outlook: Invoice ready'); assert.match(workspaceStatus(state, clock+200000), /stale/); assert.match(workspaceStatus({ ...state, paused: true }, clock), /paused/);
});
test('removing or pausing while collection is pending cannot republish old cards', async () => {
  for (const action of ['remove', 'pause']) {
    let release;
    const m = monitor({ watchSignals: () => new Promise(resolve => { release = resolve; }) });
    try {
      const pending = m.refresh();
      if (action === 'pause') m.configure({ paused: true });
      else m.syncWatchSources({ enabled: false, watchApps: [], selectedAccounts: {} });
      release([{ id: 'old', appId: 'gmail', label: 'Gmail', source: 'composio', state: 'waiting', detail: 'obsolete' }]);
      await pending; assert.equal(m.snapshot().apps.length, 0); assert.equal(m.snapshot().events.length, 0);
    } finally { m.stop(); }
  }
});
function outlookFixture(schema = outlookSchema) {
  const calls = [];
  const client = {
    connectedAccounts: { list: async () => ({ items: [{ id: 'o', toolkit: { slug: 'outlook' }, status: 'ACTIVE' }] }), disable: async () => {} },
    tools: { getRawComposioToolBySlug: async () => schema, execute: async (...args) => { calls.push(args); return { successful: true, data: { value: [{ id: 'one', subject: 'Invoice', isRead: false }] } }; } }
  };
  const c = new HaloComposio({ now: () => clock, client, key: '', config: { enabled: true, watchApps: ['outlook'], selectedAccounts: { outlook: 'o' } } });
  return { c, client, calls };
}
test('Outlook uses exact official SDK args and fails closed on incompatible advertised schema', async () => {
  const { c, calls } = outlookFixture(); const rows = await c.pollSignals(); assert.equal(rows[0].state, 'waiting');
  assert.deepEqual(calls, [['OUTLOOK_QUERY_EMAILS', { userId: 'halo-local', connectedAccountId: 'o', version: 'offline', arguments: {
    filter: 'isRead eq false', folder: 'inbox', top: 10, select: ['id', 'subject', 'isRead', 'receivedDateTime', 'lastModifiedDateTime'], orderby: 'receivedDateTime desc', user_id: 'me'
  } }]]);
  for (const key of ['filter', 'folder', 'top', 'select', 'orderby', 'user_id']) {
    const schema = structuredClone(outlookSchema); delete schema.inputParameters.properties[key];
    const broken = outlookFixture(schema); const unavailable = await broken.c.pollSignals(); assert.equal(unavailable[0].state, 'unavailable'); assert.equal(broken.calls.length, 0);
  }
});
test('unchanged WhatsApp and mail preserve change time while successful observations advance', async () => {
  const f = mailFixture(); const m = monitor({ watchSignals: () => f.integration.pollSignals(), readWindows: async () => [{ hwnd: '5', process: 'WhatsApp', title: '(3) WhatsApp' }] });
  try {
    await m.refresh(); const first = m.snapshot();
    f.change([{ id: 'new', subject: 'New proposal', labelIds: [] }]); await m.refresh();
    assert.match(workspaceStatus(m.snapshot(), clock), /New proposal/);
    assert.equal(workspaceCompactStatus(m.snapshot(), clock), 'Gmail unread');
    const mailAt = m.snapshot().apps.find(a => a.appId === 'gmail').changedAt;
    clock += 61000; await m.refresh();
    for (const app of m.snapshot().apps) {
      assert.equal(app.observedAt, clock);
      assert.equal(app.changedAt, app.appId === 'whatsapp' ? first.apps.find(a => a.appId === 'whatsapp').changedAt : mailAt);
    }
    assert.match(workspaceStatus(m.snapshot(), clock), /New proposal/);
    assert.equal(workspaceCompactStatus(m.snapshot(), clock), 'Gmail unread');
  } finally { m.stop(); }
});
test('provider and global connection failures surface unavailable in actual island selector and local summary', async () => {
  for (const global of [true, false]) {
    const { c, client } = outlookFixture();
    if (global) client.connectedAccounts.list = async () => { throw Error('private provider error'); };
    else client.tools.execute = async () => { throw Error('private provider error'); };
    const m = monitor({ watchSignals: () => c.pollSignals() });
    try { await m.refresh(); const s = m.snapshot(); assert.equal(s.apps[0].state, 'unavailable'); assert.match(workspaceStatus(s, clock), /unavailable/i); assert.match(s.summary.text, /unavailable/i); assert.equal(s.apps.filter(a => a.state === 'waiting').length, 0); assert(!JSON.stringify(s).includes('private provider error')); } finally { m.stop(); }
  }
});
test('paused Composio settings changes clear retained cards and abort AI before persistence completes', async () => {
  const { handleComposioRoutes } = await import('../bridge/composio-routes.mjs');
  for (const paused of [false, true]) for (const patch of [{ enabled: false }, { watchApps: [] }, { selectedAccounts: {} }]) {
    const { c } = outlookFixture(); let release, aiSignal;
    const m = monitor({ watchSignals: () => c.pollSignals(), summarize: (_, { signal }) => { aiSignal = signal; return new Promise(resolve => { release = resolve; }); } });
    try {
      m.configure({ aiSummaries: true }); await m.refresh(); assert.equal(m.snapshot().events.length, 1);
      // Preserve a pending response even if the provider ignores cancellation.
      if (paused) m.configure({ paused: true });
      else assert.equal(aiSignal.aborted, false);
      let persistDone;
      const req = { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(patch); } };
      const route = handleComposioRoutes(req, { writeHead() {}, end() {} }, '/composio/settings', { composio: c, onWatchChange: state => m.syncWatchSources(state), persist: () => new Promise(resolve => { persistDone = resolve; }) });
      while (!persistDone) await new Promise(resolve => setImmediate(resolve));
      assert(aiSignal.aborted); assert.equal(m.snapshot().apps.length, 0); assert.equal(m.snapshot().events.length, 0);
      release('STALE'); persistDone(); await route; await new Promise(resolve => setImmediate(resolve)); assert.notEqual(m.snapshot().summary.text, 'STALE');
    } finally { m.stop(); }
  }
});
test('disconnect invalidates pending poll and cached revoked signals even if SDK listing lags', async () => {
  const { c, client } = outlookFixture(); let release;
  client.tools.execute = () => new Promise(resolve => { release = resolve; });
  const pending = c.pollSignals(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await c.disconnect('o'); release({ successful: true, data: { value: [{ id: 'revoked' }] } });
  assert.deepEqual(await pending, []); assert.deepEqual(await c.pollSignals(), []);
  clock += 61000; assert.deepEqual(await c.pollSignals(), []);
});
test('compact island names current provider and preserves unavailable, dismissal and lifecycle states', () => {
  const base = { enabled: true, updatedAt: clock };
  const gmail = { appId: 'gmail', label: 'Gmail', source: 'composio', state: 'waiting', changedAt: clock - 10 };
  const whatsapp = { appId: 'whatsapp', label: 'WhatsApp', source: 'window-title', state: 'waiting', contentKey: '3', changedAt: clock - 20, updatedAt: clock };
  const outlook = { appId: 'outlook', label: 'Outlook', source: 'composio', state: 'unavailable', detail: 'Watch unavailable', changedAt: clock };
  assert.equal(workspaceCompactStatus({ ...base, apps: [whatsapp] }, clock), 'WhatsApp 3 unread');
  assert.equal(workspaceCompactStatus({ ...base, apps: [whatsapp, gmail] }, clock), 'Gmail unread');
  assert.equal(workspaceCompactStatus({ ...base, apps: [gmail, outlook] }, clock), 'Outlook unavailable');
  assert.equal(workspaceCompactStatus({ ...base, apps: [gmail, { ...outlook, dismissed: true }] }, clock), 'Gmail unread');
  assert.equal(workspaceCompactStatus({ ...base, apps: [{ ...gmail, dismissed: true }] }, clock), 'Watching');
  assert.equal(workspaceCompactStatus({ ...base, apps: [{ label: 'Codex', state: 'working', changedAt: clock }] }, clock), 'Codex working');
  assert.equal(workspaceCompactStatus({ ...base, paused: true, apps: [gmail] }, clock), 'Watching paused');
  assert.equal(workspaceCompactStatus({ ...base, enabled: false, apps: [gmail] }, clock), 'Watching off');
  assert.equal(workspaceCompactStatus({ ...base, apps: [gmail] }, clock + 180001), 'Watch stale · refresh');
  assert.equal(workspaceCompactStatus({ ...base, error: 'Window discovery unavailable', apps: [] }, clock), 'Watch unavailable');
});
