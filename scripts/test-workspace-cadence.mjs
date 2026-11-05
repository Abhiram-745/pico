import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HaloComposio } from '../bridge/composio.mjs';
import { DesktopMonitor, whatsappTitleSignal } from '../bridge/desktop-monitor.mjs';
import { workspaceStatus, workspaceCompactStatus, workspaceNotice } from '../pico-ui/src/workspace-status.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let now = 0, serial = 0;
  const timers = new Map();
  const scheduler = { setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  let calls = 0, fail = false, items = [{ id: '1', subject: 'One', labelIds: ['INBOX'] }], pending = null;
  const client = { connectedAccounts: { list: async () => ({ items: [{ id: 'g', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] }) }, tools: {
    getRawComposioToolBySlug: async () => ({ version: 'offline' }),
    execute: async () => { calls++; if (pending) return pending; if (fail) throw Error('offline'); return { successful: true, data: { messages: items } }; }
  } };
  const config = { enabled: true, watchApps: ['gmail'], selectedAccounts: { gmail: 'g' } };
  const c = new HaloComposio({ now: () => now, scheduler, client, key: '', config });
  return { c, scheduler, config, client, timers, now: () => now, calls: () => calls,
    setNow(value) { now = value; }, fault(value) { fail = value; }, items(value) { items = value; }, pending(value) { pending = value; },
    async advance(ms) { now += ms; for (const [id,t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } await flush(); },
    async due() { now = Math.max(now, c.watchCadence().nextPollAt); return c.pollSignals(); }
  };
}
test('remote zero-clock cadence: two bounded fast checks, baseline then quiet backoff; manual storm cannot bypass', async () => {
  const f = fixture(); await f.c.pollSignals();
  assert.equal(f.calls(), 1); assert.equal(f.c.watchCadence().nextPollAt, 15000);
  await Promise.all(Array.from({ length: 50 }, () => f.c.pollSignals())); assert.equal(f.calls(), 1);
  await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), 15000);
  await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), 60000);
  await f.due(); await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), 120000);
  f.items([{ id: '2', subject: 'Two' }]); await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), 15000);
});
test('remote concurrent polls coalesce and changed config cannot bypass minimum or publish old data', async () => {
  const f = fixture(); let release; f.pending(new Promise(resolve => { release = resolve; }));
  const polls = Array.from({ length: 30 }, () => f.c.pollSignals()); await flush(); assert.equal(f.calls(), 1);
  f.c.configure({ watchApps: [] });
  release({ successful: true, data: { messages: [{ id: 'obsolete' }] } });
  for (const rows of await Promise.all(polls)) assert.deepEqual(rows, []);
  f.pending(null); f.c.configure(f.config); await f.c.pollSignals(); assert.equal(f.calls(), 1);
  await f.advance(15000); assert.equal((await f.c.pollSignals()).length, 2); assert.equal(f.calls(), 2);
});
test('provider failure retries 30/60/120/240/300 seconds and recovers immediately at due time', async () => {
  const f = fixture(); f.fault(true);
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), delay);
  }
  f.fault(false); const rows = await f.due(); assert(rows.every(row => row.state === 'waiting'));
  assert.equal(f.c.watchCadence().nextPollAt - f.now(), 15000);
});
test('timed out SDK request stays leased: retry reports unavailable without overlapping network calls', async () => {
  const f = fixture(); let release; f.pending(new Promise(resolve => { release = resolve; }));
  const first = f.c.pollSignals(); await flush(); assert.equal(f.calls(), 1);
  await f.advance(6000); assert.equal((await first)[0].state, 'unavailable');
  await f.due(); assert.equal(f.calls(), 1);
  release({ successful: true, data: { messages: [{ id: 'late' }] } }); await flush(); f.pending(null);
  const rows = await f.due(); assert.equal(f.calls(), 2); assert(rows[0].detail.includes('One')); assert(rows[0].detail.includes('subject: One'));
});
test('disabled/no key stay offline with mock secret loader and scheduler', async () => {
  let loads = 0; const c = new HaloComposio({ key: '', loadKey: async () => { loads++; return ''; } });
  assert.deepEqual(await c.pollSignals(), []); assert.equal(loads, 0);
  c.configure({ enabled: true, watchApps: ['gmail'], selectedAccounts: { gmail: 'g' } });
  assert.equal((await c.pollSignals())[0].state, 'unavailable'); assert.equal(loads, 1);
  await c.pollSignals(); assert.equal(loads, 1);
});
test('local discovery adapts independently from remote; quiet preserves responsiveness and pause cancels scheduling', async () => {
  const f = fixture(); let count = 3;
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: async () => [{ hwnd: '1', process: 'WhatsApp', title: `(${count}) WhatsApp` }] });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'], intervalSeconds: 15, quiet: true });
    for (const expected of [5000,5000,5000,15000,15000,15000,30000]) { await m.refresh(); assert.equal(m.snapshot().cadence.intervalMs, expected); }
    count = 4; await m.refresh(); assert.equal(m.snapshot().cadence.intervalMs, 5000);
    m.configure({ paused: true }); assert.equal(f.timers.size, 0);
    m.configure({ paused: false }); assert.equal(m.snapshot().cadence.nextRefreshAt, f.now());
  } finally { m.stop(); }
});
test('hung local source times out deterministically and cannot overlap; stale vanished badge removes events', async () => {
  const f = fixture(); let release, reads = 0;
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: () => { reads++; return new Promise(resolve => { release = resolve; }); } });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'] });
    const first = m.refresh(); await f.advance(8000); await first; assert.equal(m.snapshot().sources.windows.available, false);
    await m.refresh(); assert.equal(reads, 1);
    release([]); await flush(); m.windowReader = async () => [{ hwnd: '1', process: 'WhatsApp', title: '(3) WhatsApp' }];
    await m.refresh(); assert.equal(m.snapshot().events.length, 1);
    m.windowReader = async () => []; await m.refresh(); assert.equal(m.snapshot().events.length, 0);
  } finally { m.stop(); }
});
test('WhatsApp bounded ASCII formats reject overflow, ambiguous/localized or embedded badges conservatively', () => {
  for (const title of ['(1) WhatsApp', '[9999] WhatsApp - Chrome', 'WhatsApp (42)']) assert(whatsappTitleSignal(title));
  for (const title of ['(10000) WhatsApp', '(99999999999999999999) WhatsApp', '(1.5) WhatsApp', '(-2) WhatsApp', '(٣) WhatsApp', '(1,000) WhatsApp', 'Chat (3) WhatsApp', '(3+) WhatsApp', 'WhatsApp (3)junk']) assert.equal(whatsappTitleSignal(title), null, title);
});
test('mirrored desktop/Web badges dedupe and Gmail dismissal covers duplicate evidence without hiding changes', async () => {
  const f = fixture(); const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], watchSignals: () => f.c.pollSignals(), readWindows: async () => [{ hwnd: '1', process: 'WhatsApp', title: '(3) WhatsApp' }, { hwnd: '2', process: 'chrome', title: '(3) WhatsApp - Chrome' }] });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'] }); await m.refresh(); assert.equal(m.snapshot().apps.filter(a => a.appId === 'whatsapp').length, 1);
    m.dismiss(m.snapshot().apps.find(a => a.appId === 'gmail').resultId);
    assert(m.snapshot().apps.filter(a => a.appId === 'gmail').every(a => a.dismissed));
    f.items([{ id: 'new', subject: 'Changed', labelIds: ['INBOX'] }]); await f.advance(15000); await m.refresh();
    assert(m.snapshot().apps.filter(a => a.appId === 'gmail').every(a => !a.dismissed));
  } finally { m.stop(); }
});
test('stable selectors do not mutate input; timestamp zero valid; old source observations show stale', () => {
  const apps = [{ id: 'z', label: 'Outlook', state: 'waiting', changedAt: 0 }, { id: 'a', label: 'Gmail', state: 'waiting', changedAt: 0 }];
  const state = { enabled: true, updatedAt: 0, apps };
  assert.equal(workspaceStatus(state, 0), workspaceStatus({ ...state, apps: [...apps].reverse() }, 0)); assert.equal(apps[0].id, 'z');
  assert.match(workspaceCompactStatus({ ...state, updatedAt: 400000, apps: [{ ...apps[0], observedAt: 0 }] }, 400000), /stale/);
});
test('notice selector rejects obsolete, dismissed, quiet, historical and foreground observations', () => {
  const current = { resultId: 'current' }, event = { id: 'current', at: 10, state: 'waiting' };
  const m = { enabled: true, apps: [current], events: [{ id: 'old', at: 20, state: 'waiting' }, event] };
  assert.equal(workspaceNotice(m, new Set(), 30).id, 'current');
  assert.equal(workspaceNotice(m, new Set(), 30, true), null);
  assert.equal(workspaceNotice({ ...m, settings: { quiet: true } }, new Set(), 30), null);
  assert.equal(workspaceNotice({ ...m, apps: [{ ...current, dismissed: true }] }, new Set(), 30), null);
  assert.equal(workspaceNotice(m, new Set(['current']), 30), null);
  assert.equal(workspaceNotice(m, null, 30), null);
  assert.equal(workspaceNotice(m, new Set(), 70000), null);
});
test('remote scheduler deadline caps quiet local delay without bypassing five-second floor', async () => {
  const f = fixture(); const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, watchCadence: () => ({ active: true, nextPollAt: f.now() + 15000, inFlight: false }), readSessions: async () => [], readWindows: async () => [] });
  try {
    m.configure({ enabled: true, intervalSeconds: 120, selectedApps: [] });
    for (let i = 0; i < 8; i++) await m.refresh();
    assert.equal(m.nextRefreshAt - f.now(), 15000);
    m.watchCadence = () => ({ active: true, nextPollAt: f.now() - 1 }); m._schedule();
    assert.equal(m.nextRefreshAt - f.now(), 5000);
  } finally { m.stop(); }
});
test('sample reorder keeps subject, identity and meaningful time; rollback cannot move change time backwards', async () => {
  const f = fixture(); f.setNow(100000); f.items([{ id: 'z', subject: 'Z' }, { id: 'a', subject: 'A' }]);
  const first = await f.c.pollSignals(); f.items([{ id: 'a', subject: 'A' }, { id: 'z', subject: 'Z' }]);
  const next = await f.due(); assert.equal(next[0].contentKey, first[0].contentKey); assert.equal(next[0].detail, first[0].detail); assert.equal(next[0].changedAt, first[0].changedAt);
  f.setNow(90000); f.c.configure(f.config); // Config change invalidates content, rate bound still prevents a premature request.
  assert.deepEqual(await f.c.pollSignals(), []); assert.equal(f.calls(), 2);
});
test('dismissed unchanged evidence stays dismissed after disappearance, while genuinely changed badges return', async () => {
  const f = fixture(); let title = '(3) WhatsApp';
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: async () => title ? [{ hwnd: '1', process: 'WhatsApp', title }] : [] });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'] }); await m.refresh(); m.dismiss(m.snapshot().apps[0].resultId);
    title = ''; await m.refresh(); title = '(3) WhatsApp'; await m.refresh(); assert(m.snapshot().apps[0].dismissed); assert.equal(m.snapshot().events.length, 0);
    f.setNow(-100); title = '(4) WhatsApp'; await m.refresh(); assert(!m.snapshot().apps[0].dismissed); assert.equal(m.snapshot().apps[0].changedAt, 0);
  } finally { m.stop(); }
});
test('late schema after provider timeout cannot dispatch a fresh SDK execution', async () => {
  const f = fixture(); let release;
  f.client.tools.getRawComposioToolBySlug = () => new Promise(resolve => { release = resolve; });
  const poll = f.c.pollSignals(); await flush(); assert(release);
  await f.advance(6000); assert.equal((await poll)[0].state, 'unavailable');
  release({ version: 'offline' }); await flush(); assert.equal(f.calls(), 0);
});
test('a disappearing mirrored window preserves badge change time and dismissal identity', async () => {
  const f = fixture(); let windows = [{ hwnd: '1', process: 'WhatsApp', title: '(3) WhatsApp' }, { hwnd: '2', process: 'chrome', title: '(3) WhatsApp - Chrome' }];
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: async () => windows });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'] }); await m.refresh();
    const first = m.snapshot().apps[0]; m.dismiss(first.resultId); windows = windows.filter(w => w.hwnd !== (first.windowTitle.includes('Chrome') ? '2' : '1'));
    f.setNow(5000); await m.refresh(); assert.equal(m.snapshot().apps[0].changedAt, first.changedAt); assert.equal(m.snapshot().apps[0].resultId, first.resultId); assert(m.snapshot().apps[0].dismissed);
  } finally { m.stop(); }
});
test('local empty startup stays at baseline; first fault after long quiet starts its own bounded retry streak', async () => {
  const f = fixture(); let fail = false;
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: async () => { if (fail) throw Error('offline'); return []; } });
  try {
    m.configure({ enabled: true, selectedApps: [], intervalSeconds: 15 });
    await m.refresh(); assert.equal(m.snapshot().cadence.intervalMs, 15000);
    for (let i = 0; i < 10; i++) await m.refresh();
    fail = true;
    for (const delay of [30000,60000,120000,120000]) { await m.refresh(); assert.equal(m.snapshot().cadence.intervalMs, delay); }
    fail = false; await m.refresh(); assert.equal(m.snapshot().cadence.intervalMs, 15000);
  } finally { m.stop(); }
});
test('failed Gmail backs off independently while changing Outlook stays fast; skipped samples keep timestamps', async () => {
  const f = fixture(); let outlookCalls = 0, gmailCalls = 0;
  f.client.connectedAccounts.list = async () => ({ items: ['gmail','outlook'].map((app,i) => ({ id: i ? 'o' : 'g', toolkit: { slug: app }, status: 'ACTIVE' })) });
  f.client.tools.getRawComposioToolBySlug = async () => ({ version: 'offline', inputParameters: { properties: Object.fromEntries(Object.entries({ filter: 'string', folder: 'string', top: 'integer', select: 'array', orderby: 'string', user_id: 'string' }).map(([key,type]) => [key,{ type }])) } });
  f.client.tools.execute = async slug => {
    if (slug.startsWith('GMAIL')) { gmailCalls++; throw Error('offline'); }
    outlookCalls++; return { successful: true, data: { value: [{ id: `o${outlookCalls}`, subject: `Update ${outlookCalls}` }] } };
  };
  f.c.configure({ watchApps: ['gmail','outlook'], selectedAccounts: { gmail: 'g', outlook: 'o' } });
  let rows = await f.c.pollSignals(), priorGmail = rows.find(row => row.appId === 'gmail');
  const retryTimes = [30000, 90000, 210000, 450000, 750000]; let index = 0;
  for (let at = 15000; at <= 765000; at += 15000) {
    f.setNow(at); rows = await f.c.pollSignals();
    assert.equal(outlookCalls, at / 15000 + 1);
    const gmail = rows.find(row => row.appId === 'gmail');
    if (retryTimes.includes(at)) { index++; assert.equal(gmail.observedAt, at); }
    else assert.deepEqual(gmail, priorGmail, 'not-due Gmail must keep cached observation/change times');
    priorGmail = gmail;
    assert.equal(gmailCalls, index + 1);
    const cadence = f.c.watchCadence();
    assert.equal(cadence.nextPollAt, at + 15000);
    assert.equal(cadence.providers.find(p => p.accountId === 'o').nextPollAt, at + 15000);
    assert.equal(cadence.providers.find(p => p.accountId === 'g').nextPollAt, retryTimes[index] ?? 1050000);
    assert.match(rows.find(row => row.appId === 'outlook').detail, new RegExp(`Update ${outlookCalls}`));
  }
});
test('healthy but not-due provider preserves its full cached sample during another provider retry', async () => {
  const f = fixture(); let calls = { gmail: 0, outlook: 0 };
  f.client.connectedAccounts.list = async () => ({ items: ['gmail','outlook'].map((app,i) => ({ id: i ? 'o' : 'g', toolkit: { slug: app }, status: 'ACTIVE' })) });
  f.client.tools.getRawComposioToolBySlug = async () => ({ version: 'offline', inputParameters: { properties: Object.fromEntries(Object.entries({ filter: 'string', folder: 'string', top: 'integer', select: 'array', orderby: 'string', user_id: 'string' }).map(([key,type]) => [key,{ type }])) } });
  f.client.tools.execute = async slug => { const app = slug.startsWith('GMAIL') ? 'gmail' : 'outlook'; calls[app]++; if (app === 'gmail') throw Error('offline'); return { successful: true, data: { value: [{ id: 'same', subject: 'Stable' }] } }; };
  f.c.configure({ watchApps: ['gmail','outlook'], selectedAccounts: { gmail: 'g', outlook: 'o' } });
  await f.c.pollSignals(); f.setNow(15000); await f.c.pollSignals(); f.setNow(30000);
  const before = (await f.c.pollSignals()).find(row => row.appId === 'outlook'); // next Outlook at 90s, Gmail also at 90s
  f.setNow(90000); await f.c.pollSignals(); // Outlook due 150s, Gmail due 210s
  f.setNow(150000); const cachedGmail = (await f.c.pollSignals()).find(row => row.appId === 'gmail'); // Outlook now quiet 120s -> 270s
  const reads = calls.outlook; f.setNow(210000);
  const after = await f.c.pollSignals(); assert.equal(calls.outlook, reads);
  const outlook = after.find(row => row.appId === 'outlook'); assert.equal(outlook.observedAt, 150000); assert.equal(outlook.changedAt, before.changedAt);
  assert.equal(cachedGmail.observedAt, 90000); assert.equal(after.find(row => row.appId === 'gmail').observedAt, 210000);
});
test('connection-list faults retain global exponential gate while per-provider schedules remain visible', async () => {
  const f = fixture(); await f.c.pollSignals();
  f.client.connectedAccounts.list = async () => { throw Error('offline'); };
  for (const delay of [30000,60000,120000,240000,300000]) { await f.due(); assert.equal(f.c.watchCadence().nextPollAt - f.now(), delay); assert(f.c.watchCadence().connectionFaults > 0); }
  assert.equal(f.calls(), 1); assert.equal(f.c.watchCadence().providers.length, 1);
});
test('broadcast and refresh HTTP snapshots contain scheduled future deadlines and monotonic non-collection revisions', async () => {
  const f = fixture(), updates = [];
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, readSessions: async () => [], readWindows: async () => [{ hwnd: '1', process: 'WhatsApp', title: '(3) WhatsApp' }], onUpdate: snapshot => updates.push(snapshot) });
  try {
    m.configure({ enabled: true, selectedApps: ['whatsapp'] });
    const first = await m.refresh();
    assert.equal(first.cadence.nextRefreshAt, 5000); assert.equal(updates.at(-1).cadence.nextRefreshAt, first.cadence.nextRefreshAt);
    await f.advance(5000); await m.refresh();
    assert.equal(updates.at(-1).cadence.nextRefreshAt, 10000); assert.equal(m.snapshot().cadence.nextRefreshAt, 10000);
    const prior = m.snapshot(); m.dismiss(prior.apps[0].resultId); const dismissed = m.snapshot();
    assert.equal(prior.updatedAt, dismissed.updatedAt); assert(dismissed.revision > prior.revision);
    m.configure({ paused: true }); assert.equal(updates.at(-1).cadence.nextRefreshAt, null); assert(m.snapshot().revision > dismissed.revision);
    const second = new DesktopMonitor({ now: f.now, scheduler: f.scheduler }); assert.notEqual(second.snapshot().instanceId, first.instanceId);
    for (const update of updates.filter(update => update.updatedAt !== null && !update.paused)) assert(update.cadence.nextRefreshAt > update.updatedAt);
  } finally { m.stop(); }
});
test('stable ID-selected subject is explicitly sampled, never claimed latest', async () => {
  const f = fixture(); f.items([{ id: 'z', subject: 'Newest', receivedDateTime: '2026-11-06T00:00:00Z' }, { id: 'a', subject: 'Older', receivedDateTime: '2026-11-01T00:00:00Z' }]);
  const rows = await f.c.pollSignals(); assert.match(rows[0].detail, /Sampled subject: Older/); assert.doesNotMatch(rows[0].detail, /Latest sampled subject/i);
});
test('actual local GET/refresh routes serve the next scheduled deadline after a fired timer', async () => {
  const { handleDesktopRoutes } = await import('../bridge/desktop-routes.mjs');
  const f = fixture(), updates = [];
  const m = new DesktopMonitor({ now: f.now, scheduler: f.scheduler, onUpdate: value => updates.push(value), readSessions: async () => [], readWindows: async () => [] });
  const route = async (method, path) => {
    let value, status;
    await handleDesktopRoutes({ method, headers: { host: 'localhost:4177' }, socket: { remoteAddress: '127.0.0.1' } }, { writeHead(code) { status = code; }, end(raw) { value = JSON.parse(raw); } }, path, { monitor: m });
    assert.equal(status, 200); return value;
  };
  try {
    m.configure({ enabled: true, selectedApps: [] }); await m.refresh();
    await f.advance(15000); await m.refresh();
    for (const [method,path] of [['GET','/desktop-monitor'], ['POST','/desktop-monitor/refresh']]) {
      const value = await route(method,path);
      assert(value.cadence.nextRefreshAt > f.now());
      assert.equal(value.cadence.nextRefreshAt, m.nextRefreshAt);
      assert.equal(value.revision, updates.at(-1).revision);
    }
  } finally { m.stop(); }
});

test('simultaneous provider notices drain by signal priority without consuming unseen events', () => {
  const events = [
    { id: 'whatsapp', at: 30, state: 'waiting' },
    { id: 'gmail', at: 40, state: 'waiting' },
    { id: 'gemini', at: 50, state: 'completed' },
    { id: 'failure', at: 20, state: 'failed' },
  ];
  const monitor = { enabled: true, events, apps: events.map(e => ({ resultId: e.id })) };
  const seen = new Set();
  for (const id of ['failure', 'gmail', 'whatsapp', 'gemini']) {
    assert.equal(workspaceNotice(monitor, seen, 60).id, id);
    seen.add(id);
  }
  assert.equal(workspaceNotice(monitor, seen, 60), null);
  const newer = { id: 'new', at: 65, state: 'waiting' };
  assert.equal(workspaceNotice({ ...monitor, events: [...events, newer], apps: [...monitor.apps, { resultId: newer.id }] }, seen, 70).id, 'new');
});

test('settled flash relinquishes words while its object can retain hovered geometry', async () => {
  const { islandFlashActive } = await import('../pico-ui/src/workspace-status.js');
  for (const kind of ['reply', 'done']) {
    const flash = { kind, text: 'Old notice' };
    assert.equal(islandFlashActive(flash, false), true);
    assert.equal(islandFlashActive(flash, true), false);
  }
  assert.equal(islandFlashActive({ kind: 'fail' }, true), true);
  assert.equal(islandFlashActive(null, false), false);
});

test('island re-evaluates notices on flash clear and uses Workspace copy after the beat', async () => {
  const { readFile } = await import('node:fs/promises');
  const island = await readFile(new URL('../pico-ui/react/island.jsx', import.meta.url), 'utf8');
  assert.match(island, /\[monitor, flash, running, streaming, waitingOnPerson, voice.active, pinned, showFlash\]/);
  assert.match(island, /new Set\(\[latest.id, \.\.\.seen\]/);
  assert.match(island, /!voice.active && !islandFlashActive\(flash, beatOver\)/);
  assert.match(island, /view === 'compact' \?[^\n]*workspaceCompactStatus\(monitor\)/);
  assert.match(island, /if \(hoverRef.current\) \{ flashTimer.current = setTimeout\(done, 400\); return; \}/);
});
