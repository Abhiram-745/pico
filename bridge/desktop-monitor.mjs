/* Read-only desktop signals. No clicks, focus changes, screenshots or commands
   from watched content. Transcript formats are best-effort local adapters;
   an open window alone never proves that a job is running or finished. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  selectedApps: ['claude', 'codex', 'chrome', 'lovable', 'grok'], customApps: [],
  intervalSeconds: 15, aiSummaries: false, quiet: true,
});
const RECENT = 6 * 60 * 60_000;
const STALE = 10 * 60_000;
const MAX_EVENTS = 60;
const MAX_ROWS = 36;
const APPS = [
  { id: 'claude', label: 'Claude', process: /^(claude|claude-code)$/i, title: /\bclaude\b/i },
  { id: 'codex', label: 'Codex', process: /^codex$/i, title: /\bcodex\b/i },
  { id: 'chrome', label: 'Chrome', process: /^(chrome|msedge|firefox|brave)$/i, title: / - (Google Chrome|Microsoft.? Edge|Mozilla Firefox|Brave)$/i },
  { id: 'lovable', label: 'Lovable', process: /^lovable$/i, title: /\blovable\b/i },
  { id: 'grok', label: 'Grok', process: /^(grok|grokbot)$/i, title: /\bgrok(?:bot)?\b/i },
  { id: 'cursor', label: 'Cursor', process: /^cursor$/i, title: /\bcursor\b/i },
  { id: 'vscode', label: 'VS Code', process: /^code$/i, title: /visual studio code/i },
  { id: 'chatgpt', label: 'ChatGPT', process: /^chatgpt$/i, title: /\bchatgpt\b/i },
];
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

/** Keep UI text short and strip common credentials before publishing or AI. */
export function monitorText(value, max = 220) {
  return String(value ?? '')
    .replace(/(?:sk-(?:proj-|svcacct-)?[\w-]{12,}|gh[pousr]_[\w]{15,}|xox[baprs]-[\w-]{12,})/g, '[credential hidden]')
    .replace(/\b(?:Bearer\s+)[\w.\-]{12,}/gi, 'Bearer [hidden]')
    .replace(/\b(api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[hidden]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const textContent = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text' || part?.type === 'output_text' || part?.type === 'input_text').map((part) => part.text ?? '').join(' ') : '';
const projectName = (cwd) => monitorText(String(cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Untitled session', 70);

export function jsonLines(raw) {
  const rows = [];
  for (const line of String(raw).split('\n').slice(-1000)) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); } catch { /* truncated first/last lines */ }
  }
  return rows;
}

/** Codex rollout JSONL: explicit lifecycle events outrank file timestamps. */
export function parseCodexSession(raw, mtime, now = Date.now(), metadata = {}) {
  const rows = jsonLines(raw);
  let state = 'unknown', detail = 'Session activity is available; current task state is unknown.', confidence = 'limited';
  let cwd = metadata.cwd || '', asked = '', latest = '', id = metadata.id || '', lastActivity = mtime;
  let sawSignal = false;
  const inferActivity = (timestamp) => {
    const activityAt = Date.parse(timestamp);
    if (Number.isFinite(activityAt)) lastActivity = activityAt;
    state = 'working'; confidence = 'inferred';
    detail = 'Recent agent activity; turn completion has not been observed.';
    sawSignal = true;
  };
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type === 'session_meta') { cwd = p.cwd || cwd; id = p.id || id; }
    if (row.type === 'turn_context') cwd = p.cwd || cwd;
    if (row.type === 'event_msg') {
      const kind = p.type;
      const at = Date.parse(row.timestamp);
      if (Number.isFinite(at) && ['user_message', 'task_started', 'turn_started', 'task_complete', 'task_completed', 'turn_completed', 'turn_aborted', 'task_aborted', 'error', 'turn_failed', 'approval_requested', 'request_user_input'].includes(kind)) lastActivity = at;
      if (kind === 'user_message') { asked = p.message || ''; latest = ''; state = 'working'; confidence = 'inferred'; detail = 'A prompt was submitted; waiting for a lifecycle signal.'; sawSignal = true; }
      if (kind === 'task_started' || kind === 'turn_started') { latest = ''; state = 'working'; confidence = 'high'; detail = 'Codex reported that the turn started.'; sawSignal = true; }
      if (kind === 'task_complete' || kind === 'task_completed' || kind === 'turn_completed') { state = 'completed'; confidence = 'high'; latest = p.last_agent_message || latest; detail = 'Reply ended. No result excerpt was exposed; review it in the app.'; sawSignal = true; }
      if (kind === 'turn_aborted' || kind === 'task_aborted') { state = 'idle'; confidence = 'high'; detail = 'The Codex turn was interrupted.'; sawSignal = true; }
      if (kind === 'error' || kind === 'turn_failed') { state = 'failed'; confidence = 'high'; detail = 'Codex reported an error. Open the app for details.'; sawSignal = true; }
      if (kind === 'approval_requested' || kind === 'request_user_input') { state = 'waiting'; confidence = 'high'; detail = 'Codex requested your input or approval.'; sawSignal = true; }
      if (kind === 'agent_message') latest = p.message || latest;
      if (kind === 'agent_reasoning' || kind === 'agent_reasoning_raw_content') inferActivity(row.timestamp);
    }
    if (row.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') {
        latest = textContent(p.content) || latest;
        if (p.phase === 'commentary') inferActivity(row.timestamp);
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        inferActivity(row.timestamp);
        detail = p.name ? `Using ${monitorText(p.name, 60)}` : 'Running a local tool';
      }
    }
  }
  if (!sawSignal && !id && !rows.some((row) => row.type === 'session_meta')) return null;
  if (state === 'working' && now - lastActivity > STALE) { state = 'unknown'; confidence = 'limited'; detail = 'No recent lifecycle signal. The session may still be working.'; }
  return { sessionId: hash(id || cwd || raw.slice(-300)), project: projectName(cwd), state, detail, confidence, asked: monitorText(asked, 160), latest: monitorText(latest), lastActivity };
}

/** Claude end_turn is a finished reply, not proof the user's whole job passed. */
export function parseClaudeSession(raw, mtime, now = Date.now(), metadata = {}) {
  const rows = jsonLines(raw).filter((row) => !row.isSidechain);
  let state = 'unknown', detail = 'Current Claude task state is unknown.', confidence = 'limited';
  let cwd = metadata.cwd || '', id = metadata.id || '', asked = '', latest = '', sawTurn = false, lastActivity = mtime;
  for (const row of rows) {
    cwd = row.cwd || cwd; id = row.sessionId || id;
    if (!['user', 'assistant'].includes(row.type) || !row.message) continue;
    sawTurn = true;
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at)) lastActivity = at;
    const content = row.message.content;
    const text = textContent(content);
    if (row.type === 'user') {
      if (text.trim() && !/^<(system-reminder|command-|local-command|ide_)/.test(text.trim())) { asked = text; latest = ''; }
      state = 'working'; confidence = 'inferred'; detail = 'Claude received a prompt or tool result; current activity is inferred.';
    } else {
      latest = text || latest;
      const stop = row.message.stop_reason;
      if (stop === 'end_turn' || stop === 'stop_sequence') { state = 'completed'; confidence = 'high'; detail = 'Reply ended. No result excerpt was exposed; review it in the app.'; }
      else if (Array.isArray(content) && content.some((p) => p?.type === 'tool_use')) { state = 'working'; confidence = 'inferred'; detail = 'Claude requested a tool; completion has not been observed.'; }
      else { state = 'unknown'; confidence = 'limited'; detail = 'Claude wrote a reply; no end-of-turn signal is available.'; }
    }
  }
  if (!sawTurn && !id) return null;
  if (state === 'working' && now - lastActivity > STALE) { state = 'unknown'; confidence = 'limited'; detail = 'No recent transcript signal. Claude may still be working.'; }
  return { sessionId: hash(id || cwd || raw.slice(-300)), project: projectName(cwd), state, detail, confidence, asked: monitorText(asked, 160), latest: monitorText(latest), lastActivity };
}

/** Metadata lives at the start; huge session instructions may make even the
    first record larger than the header bound. Extract only quoted identity
    fields in that case, never status or instructions from an incomplete row. */
export function metadataFromHeader(header, appId) {
  const rows = jsonLines(header);
  if (appId === 'codex') {
    const meta = rows.find((row) => row.type === 'session_meta')?.payload;
    if (meta) return { id: meta.id || '', cwd: meta.cwd || '' };
  } else {
    const meta = rows.find((row) => row.sessionId || row.cwd);
    if (meta) return { id: meta.sessionId || '', cwd: meta.cwd || '' };
  }
  const quoted = (key) => {
    const match = String(header).match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!match) return '';
    try { const value = JSON.parse(match[1]); return typeof value === 'string' ? value : ''; } catch { return ''; }
  };
  if (appId === 'codex' && !/"type"\s*:\s*"session_meta"/.test(header)) return {};
  return { id: quoted(appId === 'codex' ? 'id' : 'sessionId'), cwd: quoted('cwd') };
}

async function tail(path, max = 128 * 1024) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const length = Math.min(info.size, max);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, info.size - length);
    const header = Buffer.alloc(Math.min(info.size, 16 * 1024));
    await file.read(header, 0, header.length, 0);
    return { raw: buffer.toString('utf8'), header: header.toString('utf8'), mtime: info.mtimeMs };
  } finally { await file.close(); }
}

/** Directory traversal is bounded even for years of local agent history. */
async function recentFiles(root, { depth = 1, now = Date.now() } = {}) {
  const found = [];
  const queue = [{ path: root, depth: 0 }];
  let visited = 0, available = false;
  while (queue.length && visited < 2200) {
    const dir = queue.shift();
    let entries;
    try { entries = await readdir(dir.path, { withFileTypes: true }); available = true; } catch { continue; }
    // Codex's YYYY/MM/DD directories are naturally ordered newest first.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (++visited > 2200) break;
      const path = join(dir.path, entry.name);
      if (entry.isDirectory() && dir.depth < depth && queue.length < 200) queue.push({ path, depth: dir.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { const info = await stat(path); if (now - info.mtimeMs < RECENT) found.push({ path, mtime: info.mtimeMs }); } catch { /* removed concurrently */ }
      }
    }
  }
  return { available, files: found.sort((a, b) => b.mtime - a.mtime).slice(0, 12) };
}

export async function readAgentSessions(selectedApps, now = Date.now()) {
  const result = [];
  const sources = [
    ['claude', join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'), 1, parseClaudeSession],
    ['codex', join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), 3, parseCodexSession],
  ];
  for (const [appId, root, depth, parse] of sources) {
    if (!selectedApps.includes(appId)) continue;
    const { files } = await recentFiles(root, { depth, now });
    for (const file of files) {
      try {
        const content = await tail(file.path);
        const metadata = metadataFromHeader(content.header, appId);
        const session = parse(content.raw, content.mtime, now, metadata);
        if (session) result.push({ appId, ...session, sessionId: hash(metadata.id || file.path) });
      } catch { /* being replaced */ }
    }
  }
  return result;
}

const WINDOW_SCRIPT = "$ErrorActionPreference='SilentlyContinue';Get-Process|Where-Object {$_.MainWindowTitle}|ForEach-Object {[pscustomobject]@{process=$_.ProcessName;title=$_.MainWindowTitle;hwnd=$_.MainWindowHandle.ToString()}}|ConvertTo-Json -Compress";
async function readWindows(sense) {
  if (sense?.windows) {
    try { const windows = await sense.windows(); if (Array.isArray(windows)) return { windows, available: true }; } catch { /* use process window titles */ }
  }
  if (process.platform !== 'win32') return { windows: [], available: false };
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOW_SCRIPT], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ windows: [], available: false });
      try { resolve({ windows: stdout.trim() ? [].concat(JSON.parse(stdout)) : [], available: true }); } catch { resolve({ windows: [], available: false }); }
    });
  });
}

/** Only explicit activity/approval controls are signals. Generic page copy
    such as "done", "continue" or a title containing "working" is not. */
export function accessibilitySignal(elements) {
  if (!Array.isArray(elements)) return null;
  const names = elements.filter((item) => item && item.type !== 'Edit' && item.type !== 'Password' && !item.password && !item.isPassword)
    .filter((item) => item.enabled !== false).map((item) => String(item.name ?? '').trim());
  if (names.some((name) => /^(stop generating|stop generation|stop response|stop streaming|cancel generation|interrupt agent)$/i.test(name))) {
    return { state: 'working', detail: 'A live generation control is visible in the app.', confidence: 'high', source: 'accessibility' };
  }
  if (names.some((name) => /^(permission required|approval required|approve this action|allow this command|waiting for your approval)$/i.test(name))) {
    return { state: 'waiting', detail: 'The app is showing an approval request.', confidence: 'high', source: 'accessibility' };
  }
  const liveStatuses = elements.filter((item) => /^(StatusBar|ProgressBar)$/i.test(item?.type ?? '')).map((item) => String(item.name ?? '').trim());
  if (liveStatuses.some((name) => /^(generation complete|task completed|build complete|response completed)$/i.test(name))) {
    return { state: 'completed', detail: 'The app exposes a completed status. Review the result in the app.', confidence: 'high', source: 'accessibility' };
  }
  if (liveStatuses.some((name) => /^(generation failed|task failed|build failed)$/i.test(name))) {
    return { state: 'failed', detail: 'The app exposes a failed status. Open the app for details.', confidence: 'high', source: 'accessibility' };
  }
  return null;
}

export function normalizeMonitorSettings(input = {}, previous = DEFAULT_MONITOR_SETTINGS) {
  const source = { ...input, ...input.settings };
  const settings = { ...previous };
  if (Array.isArray(source.selectedApps)) settings.selectedApps = [...new Set(source.selectedApps.filter((id) => APPS.some((app) => app.id === id)))];
  else settings.selectedApps = [...settings.selectedApps];
  if (Array.isArray(source.customApps)) settings.customApps = [...new Set(source.customApps.map((value) => monitorText(value, 60)).filter(Boolean))].slice(0, 12);
  else settings.customApps = [...settings.customApps];
  if (Number.isFinite(Number(source.intervalSeconds))) settings.intervalSeconds = Math.max(5, Math.min(120, Math.round(Number(source.intervalSeconds))));
  for (const key of ['aiSummaries', 'quiet']) if (typeof source[key] === 'boolean') settings[key] = source[key];
  return settings;
}

const monitorFingerprint = apps => hash(apps.map(app => `${app.id}:${app.state}:${app.latest || app.detail}:${Boolean(app.dismissed)}`).join('|'));
const TERMINAL = new Set(['completed', 'failed', 'waiting']);
// Result identity is content based so mirrored rollouts / repeated observations
// of the same reply do not become separate cards. Distinct prompts stay separate.
const resultId = (app) => hash(JSON.stringify([app.appId, app.project || '', app.state, app.asked || '', app.latest || (app.source === 'transcript' ? '' : app.detail)]));
export function distinctMonitorApps(apps) {
  const unique = new Map();
  const identities = new Set();
  for (const app of [...apps].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))) {
    if (identities.has(app.id)) continue;
    identities.add(app.id);
    const key = TERMINAL.has(app.state) ? resultId(app) : app.id;
    if (!unique.has(key)) unique.set(key, { ...app, resultId: resultId(app) });
  }
  return [...unique.values()];
}

function localSummary(apps, enabled, paused) {
  if (!enabled) return 'Choose the apps to watch, then start Desktop mode.';
  if (paused) return 'Watching is paused. Your last updates are still here.';
  const waiting = apps.filter((app) => app.state === 'waiting');
  const working = apps.filter((app) => app.state === 'working');
  if (waiting.length) return `${waiting.length} ${waiting.length === 1 ? 'app needs' : 'apps need'} your attention. ${working.length ? `${working.length} still working.` : 'Open the app to continue.'}`;
  if (working.length) return `${working.length} ${working.length === 1 ? 'session is' : 'sessions are'} working. You can get on with something else.`;
  const finished = apps.find((app) => app.state === 'completed' && !app.dismissed);
  if (finished) return `${finished.label}${finished.project ? ` · ${finished.project}` : ''}: ${finished.latest || `Reply finished${finished.asked ? ` for ${finished.asked}` : ''}. Open the app to review the result.`}`;
  if (!apps.length) return 'No selected apps found yet. Open an app or add its name to your watch list.';
  return 'Your selected apps are open. Waiting for a clear progress signal.';
}

export class DesktopMonitor {
  constructor({ sense = null, onUpdate = () => {}, summarize = null, readWindows: windowReader = null, readSessions = readAgentSessions, now = Date.now } = {}) {
    this.sense = sense; this.onUpdate = onUpdate; this.summarize = summarize;
    this.windowReader = windowReader || (() => readWindows(this.sense)); this.sessionReader = readSessions; this.now = now;
    this.settings = normalizeMonitorSettings();
    this.enabled = false; this.paused = false; this.apps = []; this.events = [];
    this._dismissed = new Set();
    this.updatedAt = null; this.error = null; this.summaryError = null;
    this.summary = { text: localSummary([], false, false), source: 'local', at: now() };
    this._epoch = 0; this._timer = null; this._busy = null; this._previous = new Map(); this._lastAiAt = 0; this._lastAiFingerprint = ''; this._aiController = null;
  }
  snapshot() {
    return structuredClone({ enabled: this.enabled, paused: this.paused, apps: this.apps, events: this.events, summary: this.summary, updatedAt: this.updatedAt, error: this.error, summaryError: this.summaryError, settings: this.settings });
  }
  dismiss(id) {
    if (!this.apps.some(app => app.resultId === id) && !this.events.some(event => event.id === id)) return false;
    this._dismissed.add(id);
    if (this._dismissed.size > 200) this._dismissed.delete(this._dismissed.values().next().value);
    this.events = this.events.filter(event => event.id !== id);
    this.apps = this.apps.map(app => app.resultId === id ? { ...app, dismissed: true } : app);
    this.summary = { text: localSummary(this.apps, this.enabled, this.paused), source: 'local', at: this.now() };
    this._publish();
    return true;
  }
  // Explicit user gesture only. Resolve a fresh, unambiguous app window;
  // never execute transcript links, commands or paths to open a result.
  async openResult(id) {
    const app = this.apps.find(app => app.resultId === id) || this.events.find(event => event.id === id);
    if (!app || !this.sense?.focus) return false;
    const inventory = await this.windowReader();
    const windows = Array.isArray(inventory) ? inventory : inventory?.windows || [];
    const definition = APPS.find(item => item.id === app.appId);
    const candidates = windows.filter(window => !/Halo Notch/i.test(window.title || '') && (definition
      ? definition.process.test(window.process || '') || definition.title.test(window.title || '')
      : `${window.process || ''} ${window.title || ''}`.toLowerCase().includes(app.label.toLowerCase())));
    const named = app.project ? candidates.filter(window => String(window.title || '').toLowerCase().includes(app.project.toLowerCase())) : [];
    const matches = named.length ? named : candidates;
    if (matches.length !== 1 || !/^\d+$/.test(String(matches[0].hwnd))) return false;
    return Boolean((await this.sense.focus(matches[0].hwnd))?.ok);
  }
  _publish() { try { this.onUpdate(this.snapshot()); } catch { /* a disconnected UI */ } }
  configure(input = {}) {
    this._epoch++;
    this._aiController?.abort();
    this.summaryError = null;
    this.settings = normalizeMonitorSettings(input, this.settings);
    if (typeof input.enabled === 'boolean') this.enabled = input.enabled;
    if (typeof input.paused === 'boolean') this.paused = input.paused;
    clearTimeout(this._timer);
    // Removing a source immediately removes its retained snippets too.
    const selected = new Set([...this.settings.selectedApps, ...this.settings.customApps.map((name) => `custom:${hash(name.toLowerCase())}`)]);
    this.apps = this.apps.filter((app) => selected.has(app.appId));
    this.events = this.events.filter((event) => selected.has(event.appId));
    this.summary = { text: localSummary(this.apps, this.enabled, this.paused), source: 'local', at: this.now() };
    this._publish();
    if (this.enabled && !this.paused) this._schedule(0);
    return this.snapshot();
  }
  start() { this._schedule(0); return this.snapshot(); }
  stop() { return this.configure({ enabled: false }); }
  _schedule(ms = this.settings.intervalSeconds * 1000) {
    clearTimeout(this._timer);
    if (!this.enabled || this.paused) return;
    this._timer = setTimeout(() => { void this.refresh(); }, ms);
    this._timer.unref?.();
  }
  async refresh() {
    if (!this.enabled || this.paused) return this.snapshot();
    if (this._busy) return this._busy;
    const epoch = this._epoch;
    this._busy = this._refresh(epoch).finally(() => { this._busy = null; this._schedule(); });
    return this._busy;
  }
  async _refresh(epoch) {
    const at = this.now();
    try {
      const [inventory, sessions] = await Promise.all([this.windowReader(), this.sessionReader(this.settings.selectedApps, at)]);
      if (epoch !== this._epoch || !this.enabled || this.paused) return this.snapshot();
      const definitions = APPS.filter((app) => this.settings.selectedApps.includes(app.id)).concat(this.settings.customApps.map((name) => ({ id: `custom:${hash(name.toLowerCase())}`, label: name, matches: (window) => `${window.process ?? window.name ?? ''} ${window.title ?? ''}`.toLowerCase().includes(name.toLowerCase()) })));
      const windows = Array.isArray(inventory) ? inventory : inventory?.windows ?? [];
      const available = Array.isArray(inventory) || inventory?.available === true;
      const apps = [];
      const accessibilityCache = new Map();
      for (const app of definitions) {
        const appSessions = sessions.filter((session) => session.appId === app.id).slice(0, 8);
        for (const session of appSessions) apps.push({ id: `${app.id}:${session.sessionId}`, appId: app.id, label: app.label, project: session.project, state: session.state, detail: session.detail, latest: session.latest, asked: session.asked, sessionId: session.sessionId, source: 'transcript', confidence: session.confidence, lastActivity: session.lastActivity, updatedAt: at });
        const own = windows.filter((window) => app.matches ? app.matches(window) : app.process.test(window.process ?? window.name ?? '') || app.title.test(window.title ?? ''));
        // A browser row describes a browser, never all its background tabs.
        for (const window of own.slice(0, appSessions.length ? 1 : 4)) {
          if (appSessions.length && !window.title) continue;
          let signal = null;
          if (this.sense?.elements && window.hwnd && !window.minimized) {
            if (accessibilityCache.has(window.hwnd)) signal = accessibilityCache.get(window.hwnd);
            else if (accessibilityCache.size < 8) {
              try { signal = accessibilitySignal(await this.sense.elements(window.hwnd, 90)); } catch { /* inaccessible window */ }
              accessibilityCache.set(window.hwnd, signal);
            }
          }
          if (epoch !== this._epoch || !this.enabled || this.paused) return this.snapshot();
          apps.push({ id: `${app.id}:window:${hash(window.hwnd || window.title || app.id)}`, appId: app.id, label: app.label, state: signal?.state || 'open', detail: signal?.detail || 'Open · waiting for a progress signal', source: signal?.source || 'window', confidence: signal?.confidence || 'limited', windowTitle: monitorText(window.title, 120), lastActivity: signal ? at : null, updatedAt: at });
        }
      }
      this.apps = distinctMonitorApps(apps).slice(0, MAX_ROWS).map(app => ({ ...app, dismissed: this._dismissed.has(app.resultId) }));
      const next = new Map();
      for (const app of this.apps) {
        // Text streaming is not a new event each poll; only meaningful state transitions.
        const fingerprint = `${app.state}:${app.source}:${TERMINAL.has(app.state) ? app.resultId : ''}`;
        next.set(app.id, fingerprint);
        if (this._previous.get(app.id) === fingerprint || !['working', 'waiting', 'completed', 'failed'].includes(app.state) || app.dismissed) continue;
        if (this.events.some(event => event.id === app.resultId)) continue;
        const title = app.state === 'completed' ? 'Reply finished' : app.state === 'waiting' ? 'Needs your attention' : app.state === 'working' ? 'Working' : 'Reported an error';
        const firstSeen = !this._previous.has(app.id);
        const eventAt = firstSeen && app.source === 'transcript' && app.lastActivity ? Math.min(at, app.lastActivity) : at;
        this.events.unshift({ id: app.resultId, appId: app.appId, label: app.label, project: app.project, state: app.state, title, detail: app.latest || app.detail, latest: app.latest, asked: app.asked, source: app.source, confidence: app.confidence, at: eventAt, observedAt: at });
      }
      this._previous = next;
      this.events = this.events.sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);
      this.updatedAt = at; this.error = available ? null : 'Window discovery is unavailable. Local agent sessions can still appear.';
      const fingerprint = monitorFingerprint(this.apps);
      if (this.summary.source !== 'openai' || !this.settings.aiSummaries || fingerprint !== this._lastAiFingerprint) {
        this.summary = { text: localSummary(this.apps, true, false), source: 'local', at };
      }
      this._publish();
      if (!this._aiController && this.settings.aiSummaries && this.summarize && this.apps.some(app => !app.dismissed) && this.now() - this._lastAiAt >= 60_000 && fingerprint !== this._lastAiFingerprint) {
        void this._refreshBriefing(epoch, at, fingerprint);
      }
    } catch {
      if (epoch === this._epoch) {
        this.error = 'Could not refresh desktop signals. The next check will retry.';
        this.apps = this.apps.map((app) => app.state === 'working' && this.now() - (app.lastActivity || app.updatedAt || 0) > STALE
          ? { ...app, state: 'unknown', confidence: 'limited', detail: 'The last progress signal is stale. The app may still be working.' } : app);
        this.summary = { text: localSummary(this.apps, true, false), source: 'local', at: this.now() };
        this._publish();
      }
    }
    return this.snapshot();
  }
  async _refreshBriefing(epoch, at, fingerprint) {
    this._lastAiAt = this.now();
    const controller = new AbortController();
    this._aiController = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    timeout.unref?.();
    try {
      const result = await this.summarize({ apps: this.apps.filter(app => !app.dismissed).map(({ label, project, state, detail, latest, source, confidence }) => ({ label, project, state, detail, latest, source, confidence })), updatedAt: at }, { signal: controller.signal });
      if (epoch !== this._epoch || !this.enabled || this.paused || controller.signal.aborted || monitorFingerprint(this.apps) !== fingerprint) return;
      const text = monitorText(typeof result === 'string' ? result : result?.text, 500);
      if (text) { this.summary = { text, source: 'openai', at: this.now() }; this.summaryError = null; this._lastAiFingerprint = fingerprint; this._publish(); }
      else throw new Error('Empty summary');
    } catch {
      if (epoch === this._epoch && this.enabled && !this.paused && monitorFingerprint(this.apps) === fingerprint) {
        this.summaryError = 'OpenAI summary unavailable. Showing local progress signals.';
        this._publish();
      }
    } finally {
      clearTimeout(timeout);
      if (this._aiController === controller) this._aiController = null;
    }
  }

}
