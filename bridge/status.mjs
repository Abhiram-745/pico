/* ==========================================================================
   Halo — what is going on across this machine.

   Halo is meant to be the person's agent, not a toy that clicks things on
   request. That starts with knowing the state of things: whether their
   Claude Code sessions are working or waiting on them, which chat apps are
   running and shouting for attention, what is open.

   WHERE IT COMES FROM — only things that can be read without driving the UI
     Claude Code   the .jsonl transcript each session in ~/.claude/projects
                   appends to. A file touched seconds ago, ending on a tool
                   call, is working; ending on a reply, it is waiting for you.
     Windows       one PowerShell call: every process name and every window
                   title. Chat apps and web apps put their unread count in
                   the title — "(3) WhatsApp" — so the title is the badge.
     Apps          a short catalogue of the ones worth naming. Anything not in
                   it that has an unread count in its title is still reported.

   What this cannot see, it says so rather than guessing: WhatsApp running
   with no count in its title is "running", not "no messages".
   ========================================================================== */

import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Apps worth naming: [id, label, process-name pattern, title pattern]. */
const CATALOGUE = [
  ['whatsapp', 'WhatsApp', /^whatsapp/i, /whatsapp/i],
  ['claude', 'Claude', /^claude$/i, /^claude$/i],
  ['discord', 'Discord', /^discord/i, /discord/i],
  ['slack', 'Slack', /^slack$/i, /slack/i],
  ['telegram', 'Telegram', /^telegram/i, /telegram/i],
  ['signal', 'Signal', /^signal$/i, /^signal$/i],
  ['teams', 'Teams', /^(?:ms-)?teams/i, /microsoft teams/i],
  ['outlook', 'Outlook', /^(?:outlook|olk)$/i, /outlook/i],
  ['spotify', 'Spotify', /^spotify$/i, /spotify/i],
  ['zoom', 'Zoom', /^zoom$/i, /zoom/i],
  ['notion', 'Notion', /^notion$/i, /notion/i],
  ['cursor', 'Cursor', /^cursor$/i, /cursor/i],
  ['vscode', 'VS Code', /^code$/i, /visual studio code/i],
  ['chrome', 'Chrome', /^chrome$/i, / - google chrome$/i],
  ['edge', 'Edge', /^msedge$/i, / - microsoft.? edge$/i],
];

const BROWSERS = /^(?:chrome|msedge|firefox|brave|opera|arc)$/i;
const ACTIVE_MS = 25_000;      // a transcript written this recently is mid-work
const RECENT_MS = 6 * 3600_000;
const MAX_SESSIONS = 6;

/* ---------------------------------------------------------------------------
   Windows and processes
   -------------------------------------------------------------------------*/
const SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$p=Get-Process;" +
  "[pscustomobject]@{" +
  "names=@($p|Select-Object -ExpandProperty ProcessName -Unique);" +
  "windows=@($p|Where-Object {$_.MainWindowTitle}|ForEach-Object {[pscustomobject]@{name=$_.ProcessName;title=$_.MainWindowTitle}})" +
  "}|ConvertTo-Json -Compress -Depth 4";

function readProcesses() {
  if (process.platform !== 'win32') return Promise.resolve({ names: [], windows: [], failed: true });
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: 12_000, maxBuffer: 4 << 20 },
      (err, out) => {
        if (err) return resolve({ names: [], windows: [], failed: true });
        try {
          const j = JSON.parse(out);
          resolve({ names: [].concat(j.names ?? []), windows: [].concat(j.windows ?? []) });
        } catch { resolve({ names: [], windows: [], failed: true }); }
      });
  });
}

/** "(3) WhatsApp" → 3, "Inbox (12) - Gmail" → 12, "WhatsApp" → null. */
export function unreadIn(title) {
  const m = String(title).match(/^\((\d{1,4})\+?\)\s|\s\((\d{1,4})\+?\)(?:\s|$)|^(\d{1,4}) unread/i);
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null;
}

/** Turn processes and windows into one row per app the person would name. */
export function appsFrom({ names, windows }) {
  const rows = [];
  const used = new Set();
  for (const [id, label, procRe, titleRe] of CATALOGUE) {
    const running = names.some((n) => procRe.test(n));
    const own = windows.filter((w) => procRe.test(w.name));
    /* A browser tab counts too: WhatsApp Web is "(2) WhatsApp" in Chrome. */
    const hosted = id === 'chrome' || id === 'edge' ? []
      : windows.filter((w) => !procRe.test(w.name) && BROWSERS.test(w.name) && titleRe.test(w.title));
    if (!running && !hosted.length) continue;
    const all = [...own, ...hosted];
    for (const w of all) used.add(w);
    const counts = all.map((w) => unreadIn(w.title)).filter((n) => n != null);
    rows.push({
      id, label, running: true,
      via: !own.length && hosted.length ? 'in the browser' : null,
      unread: counts.length ? Math.max(...counts) : null,
      title: (all[0]?.title ?? '').slice(0, 120),
      windows: all.length,
    });
  }
  /* Anything else announcing a count in its title. */
  for (const w of windows) {
    if (used.has(w) || /^(?:explorer|powershell|cmd|windowsterminal|conhost)$/i.test(w.name)) continue;
    const n = unreadIn(w.title);
    if (n == null) continue;
    rows.push({ id: `win:${w.name}`, label: w.title.replace(/^\(\d+\+?\)\s*/, '').slice(0, 40) || w.name, running: true, via: null, unread: n, title: w.title.slice(0, 120), windows: 1 });
  }
  return rows;
}

/* ---------------------------------------------------------------------------
   Claude Code sessions
   -------------------------------------------------------------------------*/
function tail(file, bytes = 96 * 1024) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : '';

const NOISE = /^<(?:system-reminder|command-|local-command|ide_)/;

/** Read the end of one transcript: what it is called, and where it stands. */
export function sessionFrom(raw, mtimeMs, now = Date.now()) {
  const rows = [];
  for (const line of String(raw).split('\n').slice(1)) {   // the first line may be cut in half
    try { rows.push(JSON.parse(line)); } catch { /* partial or odd line */ }
  }
  const turns = rows.filter((r) => (r.type === 'user' || r.type === 'assistant') && r.message && !r.isSidechain);
  if (!turns.length) return null;
  const last = turns.at(-1);
  const cwd = rows.findLast((r) => r.cwd)?.cwd ?? '';
  const asked = turns.findLast((r) => r.type === 'user' && textOf(r.message.content).trim() && !NOISE.test(textOf(r.message.content).trim()));
  const said = turns.findLast((r) => r.type === 'assistant' && textOf(r.message.content).trim());
  const lastContent = Array.isArray(last.message.content) ? last.message.content : [];
  const wantsTool = last.type === 'assistant' && lastContent.some((c) => c?.type === 'tool_use');
  const age = now - mtimeMs;
  let state;
  if (age < ACTIVE_MS || (last.type === 'user' && age < 90_000)) state = 'working';
  else if (wantsTool && age < 5 * 60_000) state = 'working';
  else if (last.type === 'assistant' && age < RECENT_MS) state = 'waiting';   // finished a reply; the next move is theirs
  else state = 'idle';
  const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    project: basename(cwd.replace(/[\\/]+$/, '')) || 'unknown',
    state,
    age,
    asked: clip(textOf(asked?.message.content ?? ''), 140),
    latest: clip(textOf(said?.message.content ?? ''), 200),
  };
}

function claudeSessions(now = Date.now()) {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const found = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return { available: false, sessions: [] }; }
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(root, d, f);
      try {
        const st = statSync(path);
        if (now - st.mtimeMs < RECENT_MS) found.push({ path, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const f of found.slice(0, MAX_SESSIONS)) {
    try {
      const s = sessionFrom(tail(f.path), f.mtime, now);
      if (s) sessions.push(s);
    } catch { /* unreadable while being written */ }
  }
  return { available: true, sessions };
}

/* ---------------------------------------------------------------------------
   The whole picture
   -------------------------------------------------------------------------*/
export async function gather() {
  const proc = await readProcesses();
  return {
    at: Date.now(),
    claudeCode: claudeSessions(),
    apps: appsFrom(proc),
    sawWindows: !proc.failed,
  };
}

const since = (ms) => ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3600_000)}h ago`;

/** The same picture as a few plain lines, for the model to answer from. */
export function describe(status, agent = {}) {
  if (!status) return '';
  const out = ["What you can see of the user's computer right now (private notes for you — never quote them). When they ask how things are going, answer like a person in one or two short sentences, naming only what they asked about; if something is not in these notes, say you cannot see it. Never reply with a TASK: line to such a question."];
  out.push(agent.busy
    ? `Halo (you) is working on: ${agent.task || 'a task'} — ${agent.phase}.`
    : agent.lastTask ? `Halo is idle. Last job: "${agent.lastTask}" (${agent.lastOk ? 'finished' : 'did not finish'}).` : 'Halo is idle.');
  const cc = status.claudeCode;
  if (cc?.available) {
    if (!cc.sessions.length) out.push('Claude Code: no session active in the last 6 hours.');
    for (const s of cc.sessions) {
      out.push(`- Claude Code, project "${s.project}": ${s.state === 'working' ? 'WORKING now' : s.state === 'waiting' ? 'finished, waiting on the user' : 'idle'}, last activity ${since(s.age)}. Asked: "${s.asked}". Latest: "${s.latest}"`);
    }
  } else out.push('Claude Code: not installed or no sessions folder.');
  if (!status.sawWindows) out.push('Could not read the list of open apps this time.');
  for (const p of status.apps ?? []) {
    out.push(`- ${p.label}: running${p.via ? ` ${p.via}` : ''}; ${p.unread != null ? `${p.unread} unread shown in its title` : 'unread count unknown (Halo can only read counts an app shows in its window title)'}.`);
  }
  return out.join('\n');
}
