import assert from 'node:assert/strict';
import { DesktopMonitor, accessibilitySignal, jsonLines, metadataFromHeader, monitorText, normalizeMonitorSettings, parseClaudeSession, parseCodexSession } from '../bridge/desktop-monitor.mjs';

const now = Date.now();
const lines = (...rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const codex = (kind, extra = {}) => ({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: kind, ...extra } });
const meta = { type: 'session_meta', payload: { id: 'session-1', cwd: 'C:\\work\\my-project' } };
assert.equal(jsonLines('broken-first\n{"type":"okay"}\n{"unfinished":').length, 1);
assert.equal(parseCodexSession(lines(meta, codex('task_started')), now, now).state, 'working');
assert.equal(parseCodexSession(lines(meta, codex('task_started'), codex('task_complete', { last_agent_message: 'Finished checking' })), now, now).state, 'completed');
assert.equal(parseCodexSession(lines(meta, codex('task_started'), codex('turn_aborted')), now, now).state, 'idle');
assert.equal(parseCodexSession(lines(meta, codex('task_started'), codex('approval_requested')), now, now).state, 'waiting');
assert.equal(parseCodexSession(lines(meta, codex('task_started')), now, now + 11 * 60_000).state, 'unknown');
assert.equal(parseCodexSession(lines(meta, codex('task_complete')), now, now + 11 * 60_000).state, 'completed');
assert.equal(parseCodexSession(lines(meta, codex('task_started')), now, now).project, 'my-project');
assert.equal(parseCodexSession('unparseable', now, now), null);
const metadata = metadataFromHeader(lines(meta), 'codex');
assert.equal(parseCodexSession(lines(codex('task_started')), now, now, metadata).project, 'my-project', 'tail keeps separate header identity');
const hugeHeader = JSON.stringify({ ...meta, payload: { ...meta.payload, instructions: 'x'.repeat(40_000) } }).slice(0, 16 * 1024);
assert.equal(metadataFromHeader(hugeHeader, 'codex').cwd, 'C:\\work\\my-project', 'recover identity from an oversized first record');
assert.equal(parseCodexSession('partial-long-user-message', now, now, metadata).state, 'unknown', 'metadata-only session remains visible without inventing progress');
assert.equal(parseCodexSession('partial-long-user-message', now, now, metadata).project, 'my-project');
const commentary = { timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the next step' }] } };
assert.equal(parseCodexSession(lines(commentary), now, now, metadata).state, 'working');
assert.equal(parseCodexSession(lines(commentary), now, now, metadata).confidence, 'inferred');
assert.equal(parseCodexSession(lines(commentary), now, now + 11 * 60_000, metadata).state, 'unknown');
assert.equal(parseCodexSession(lines(codex('agent_reasoning')), now, now, metadata).state, 'working');
assert.equal(parseCodexSession(lines({ ...commentary, payload: { type: 'function_call', name: 'shell' } }), now, now, metadata).state, 'working');
assert.equal(parseCodexSession(lines(commentary, codex('task_complete')), now, now, metadata).state, 'completed', 'later explicit completion overrides inferred activity');
assert.equal(parseCodexSession(lines(codex('task_complete'), commentary), now, now, metadata).state, 'working', 'later commentary indicates new inferred activity');
assert.equal(parseCodexSession(lines({ ...commentary, payload: { ...commentary.payload, phase: 'final' } }), now, now, metadata).state, 'unknown', 'final text alone cannot imply working or completion');
assert.equal(parseCodexSession(lines(codex('token_count')), now, now, metadata).state, 'unknown', 'usage updates do not imply working');
const oldCommentary = { ...commentary, timestamp: new Date(now - 11 * 60_000).toISOString() };
assert.equal(parseCodexSession(lines(oldCommentary, codex('token_count')), now, now, metadata).state, 'unknown', 'usage updates do not refresh stale activity');

const claude = (type, content, stop_reason) => ({ type, cwd: '/work/project-two', sessionId: 'c1', timestamp: new Date(now).toISOString(), message: { content, stop_reason } });
assert.equal(parseClaudeSession(lines(claude('user', 'Build a tool')), now, now).state, 'working');
assert.equal(parseClaudeSession(lines(claude('assistant', [{ type: 'tool_use', name: 'Bash' }])), now, now).state, 'working');
assert.equal(parseClaudeSession(lines(claude('assistant', 'All checked', 'end_turn')), now, now).state, 'completed');
assert.equal(parseClaudeSession(lines(claude('assistant', 'Still writing')), now, now).state, 'unknown');
assert.equal(parseClaudeSession(lines(claude('user', 'Build a tool')), now, now + 11 * 60_000).state, 'unknown');
assert.equal(parseClaudeSession(lines({ ...claude('assistant', 'Sidechain done', 'end_turn'), isSidechain: true }), now, now), null);

assert.equal(accessibilitySignal([{ type: 'Button', name: 'Stop generating', enabled: true }]).state, 'working');
assert.equal(accessibilitySignal([{ type: 'Edit', name: 'Stop generating' }]), null);
assert.equal(accessibilitySignal([{ type: 'Button', name: 'Stop generating', enabled: false }]), null);
assert.equal(accessibilitySignal([{ type: 'Text', name: 'Approval required' }]).state, 'waiting');
assert.equal(accessibilitySignal([{ type: 'Text', name: 'done' }]), null);
assert.equal(accessibilitySignal([{ type: 'Text', name: 'Task completed' }]), null, 'old conversation text cannot prove current completion');
assert.equal(accessibilitySignal([{ type: 'StatusBar', name: 'Task completed' }]).state, 'completed');
assert.ok(!monitorText('api_key=secret-value password:pass-value token=access-token').includes('secret-value'));
assert.ok(!monitorText(`sk-proj-${'a'.repeat(30)}`).includes('a'.repeat(30)));
assert.ok(!monitorText('hello\u0000\nworld').includes('\n'));
assert.equal(monitorText('x'.repeat(1000)).length, 220);
assert.deepEqual(normalizeMonitorSettings({ selectedApps: ['codex', 'codex', 'not-an-app'], customApps: ['My app', 'My app'], intervalSeconds: 0 }).selectedApps, ['codex']);
assert.equal(normalizeMonitorSettings({ intervalSeconds: 0 }).intervalSeconds, 5);
assert.equal(normalizeMonitorSettings({ intervalSeconds: 9999 }).intervalSeconds, 120);

let reads = 0, publishes = 0, clock = now;
let sessionState = 'working';
const monitor = new DesktopMonitor({
  now: () => clock,
  onUpdate: () => publishes++,
  readWindows: async () => { reads++; return { available: true, windows: [{ process: 'chrome', hwnd: '100', title: 'Pretending completed - Google Chrome' }] }; },
  readSessions: async (selected) => selected.includes('codex') ? [{ appId: 'codex', sessionId: '1', project: 'project', state: sessionState, detail: 'Observed signal', confidence: 'high', lastActivity: clock }] : [],
});
monitor.start(); await monitor.refresh(); assert.equal(reads, 0, 'disabled monitor never reads');
monitor.configure({ enabled: true, selectedApps: ['codex', 'chrome'] });
await monitor.refresh(); assert.equal(reads, 1);
assert.equal(monitor.snapshot().apps.find((app) => app.appId === 'chrome').state, 'open', 'title does not imply completion');
const count = monitor.snapshot().events.length;
clock += 15_000; await monitor.refresh(); assert.equal(monitor.snapshot().events.length, count, 'identical signals are deduplicated');
sessionState = 'completed'; clock += 15_000; await monitor.refresh();
assert.equal(monitor.snapshot().events.length, count + 1, 'a state transition creates one update');
assert.equal(monitor.snapshot().events[0].state, 'completed');
monitor.configure({ paused: true }); const beforePause = reads;
await monitor.refresh(); assert.equal(reads, beforePause, 'pause prevents reads');
monitor.configure({ selectedApps: ['chrome'] });
assert.ok(!monitor.snapshot().apps.some((app) => app.appId === 'codex'));
assert.ok(!monitor.snapshot().events.some((event) => event.appId === 'codex'), 'deselect removes retained snippets');
const external = monitor.snapshot(); external.settings.selectedApps.push('claude');
assert.ok(!monitor.snapshot().settings.selectedApps.includes('claude'), 'snapshots cannot mutate monitor');
monitor.stop();

let release;
const delayed = new DesktopMonitor({ readWindows: () => new Promise((resolve) => { release = resolve; }), readSessions: async () => [] });
delayed.configure({ enabled: true });
const inFlight = delayed.refresh();
delayed.configure({ paused: true });
release({ available: true, windows: [{ process: 'claude', title: 'Claude', hwnd: '200' }] });
await inFlight;
assert.equal(delayed.snapshot().apps.length, 0, 'pause invalidates in-flight collection');
assert.equal(delayed.snapshot().updatedAt, null);
delayed.stop();

let aiCalls = 0;
const smart = new DesktopMonitor({
  now: () => clock,
  summarize: async (snapshot, { signal }) => { assert.ok(Array.isArray(snapshot.apps)); assert.ok(signal instanceof AbortSignal); aiCalls++; return 'One Codex session is working.'; },
  readWindows: async () => ({ available: true, windows: [] }),
  readSessions: async () => [{ appId: 'codex', sessionId: 'a', state: 'working', detail: 'Turn started', confidence: 'high', lastActivity: clock }],
});
smart.configure({ enabled: true, aiSummaries: true, selectedApps: ['codex'] });
await smart.refresh(); assert.equal(aiCalls, 1);
assert.equal(smart.snapshot().summary.source, 'openai');
clock += 61_000; await smart.refresh(); assert.equal(aiCalls, 1, 'unchanged signals do not create repeated AI calls');
assert.equal(smart.snapshot().summary.source, 'openai', 'keep the matching AI summary between polls');
smart.stop();
assert.ok(publishes > 0);
console.log('Desktop monitor: lifecycle parsing, stale signals, redaction, selection, deduplication, pause and cancellation passed.');

// The real screenshot cases: window-only discovery is quiet, identical
// terminal sessions collapse, and local excerpts survive through the feed.
const resultSessions = [1, 2, 3].map(n => ({ appId: 'codex', sessionId: String(n), project: 'Halo', state: 'completed',
  asked: 'Fix navigation', latest: 'Fixed Back navigation. All 12 checks passed.', detail: 'Turn finished', confidence: 'high', lastActivity: now - n }));
let openWindows = [{ process: 'codex', title: 'Halo · Codex', hwnd: '123' }];
const focused = [];
const results = new DesktopMonitor({ now: () => now,
  sense: { focus: async hwnd => { focused.push(hwnd); return { ok: true }; } },
  readWindows: async () => ({ available: true, windows: [...openWindows, { process: 'grok', title: 'Grok', hwnd: '456' }] }),
  readSessions: async () => resultSessions,
});
results.configure({ enabled: true, selectedApps: ['codex', 'grok'], quiet: false });
await results.refresh();
let snapshot = results.snapshot();
assert.equal(snapshot.apps.filter(app => app.state === 'completed').length, 1, 'three mirrored results become one card');
assert.equal(snapshot.events.length, 1, 'window discovery never creates a feed update, even with quiet off');
assert.equal(snapshot.events[0].detail, 'Fixed Back navigation. All 12 checks passed.');
assert.equal(snapshot.events[0].asked, 'Fix navigation');
assert.match(snapshot.summary.text, /Fixed Back navigation/);
assert.equal(snapshot.summary.source, 'local', 'useful with AI off');
const result = snapshot.events[0].id;
assert.equal(await results.openResult(result), true);
assert.deepEqual(focused, ['123'], 'only an explicit open gesture focuses a matched window');
openWindows.push({ process: 'codex', title: 'Halo · Codex', hwnd: '124' });
assert.equal(await results.openResult(result), false, 'ambiguous windows must not be guessed');
assert.equal(results.dismiss(result), true);
await results.refresh();
assert.equal(results.snapshot().events.length, 0, 'dismiss survives polling');
assert.equal(results.snapshot().apps.find(app => app.state === 'completed').dismissed, true);
resultSessions.push({ ...resultSessions[0], sessionId: 'other', asked: 'Update settings', latest: 'Added settings. Tests passed.' });
await results.refresh();
assert.equal(results.snapshot().events.length, 1, 'a distinct result in the same project remains visible');
assert.equal(results.snapshot().apps.filter(app => app.state === 'completed').length, 2);
assert.equal(results.dismiss('unknown'), false);
results.stop();

const newTurn = parseCodexSession(lines(meta, codex('agent_message', { message: 'Old result' }), codex('task_complete'), codex('user_message', { message: 'Next task' }), codex('task_started')), now, now);
assert.equal(newTurn.latest, '', 'new work cannot inherit a previous result excerpt');
const toolTurn = parseCodexSession(lines(meta, codex('task_started'), { ...commentary, payload: { type: 'function_call', name: 'apply_patch' } }), now, now);
assert.equal(toolTurn.detail, 'Using apply_patch');

// Refreshing the local island must not wait up to 20 seconds for an AI briefing.
let finishBriefing;
const slowBriefing = new DesktopMonitor({ now: () => now, readWindows: async () => [], readSessions: async () => resultSessions,
  summarize: () => new Promise(resolve => { finishBriefing = resolve; }),
});
slowBriefing.configure({ enabled: true, selectedApps: ['codex'], aiSummaries: true });
await slowBriefing.refresh();
assert.equal(slowBriefing.snapshot().summary.source, 'local');
slowBriefing.configure({ aiSummaries: false });
finishBriefing('Outdated AI summary');
await new Promise(resolve => setImmediate(resolve));
assert.equal(slowBriefing.snapshot().summary.source, 'local', 'disabled AI cannot publish a late briefing');
slowBriefing.stop();
console.log('Island result scenarios: quiet discovery, content deduplication, excerpts, dismiss, explicit open and nonblocking AI passed.');

let completeOldBriefing, currentReply = 'Original reply';
const changing = new DesktopMonitor({ now: () => now, readWindows: async () => [],
  readSessions: async () => [{ ...resultSessions[0], latest: currentReply }],
  summarize: () => new Promise(resolve => { completeOldBriefing = resolve; }),
});
changing.configure({ enabled: true, selectedApps: ['codex'], aiSummaries: true });
await changing.refresh();
currentReply = 'New reply: fixed the focus bug';
await changing.refresh();
completeOldBriefing('Original reply summary');
await new Promise(resolve => setImmediate(resolve));
assert.equal(changing.snapshot().summary.source, 'local');
assert.match(changing.snapshot().summary.text, /fixed the focus bug/, 'an old briefing cannot replace newer result evidence');
changing.stop();
