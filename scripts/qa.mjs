#!/usr/bin/env node
/* ==========================================================================
   Halo QA: real tasks, on the real desktop, in a browser of its own.

   The unit tests check decisions against a pretend desktop. This checks the
   thing people actually see: does the pointer land on the right control, does
   a drag drop where it was meant to, does the job end finished.

     - The pages are in pico-ui/fixtures/qa. Each one knows its own task and
       can say, from the page's own state, whether it was done. Nothing is
       judged by a model and nothing is judged from a screenshot.
     - Chrome runs with its own profile and a debugging port, so the pages are
       read directly and your everyday browser is not touched.
     - The bridge is not needed and the island is not on screen, so nothing of
       Halo's own is in the way.

   It uses YOUR mouse and keyboard while it runs — do not touch them. Ctrl+C
   stops it.

   Run:   node scripts/qa.mjs                    every page, once
          node scripts/qa.mjs sort kanban -n 3   those pages, three times each
          node scripts/qa.mjs --label baseline   name the results file

   Results: one JSON line per run in artifacts/qa/<label>.jsonl, and a table.
   ========================================================================== */

import { createServer } from 'node:http';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { LLM } from '../bridge/llm.mjs';
import { Sense } from '../bridge/sense.mjs';
import { loadComputer } from '../bridge/computer.mjs';
import { runTask } from '../bridge/driver.mjs';
import { findBrowser } from '../bridge/notch-window.mjs';
import { chooseMonitor } from '../bridge/screen.mjs';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES_DIR = join(ROOT, 'pico-ui', 'fixtures', 'qa');
const ALL = ['form', 'icons', 'slider', 'copy', 'sort', 'kanban', 'canvas'];
const PORT = 4190;
const DEBUG_PORT = 9333;
const TASK_LIMIT_MS = 150_000;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`) >= 0 ? argv.indexOf(`--${name}`) : argv.indexOf(`-${name[0]}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const repeat = Math.max(1, Number(opt('n', 1)) || 1);
const label = opt('label', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
const skip = new Set([opt('n'), opt('label'), opt('display')].filter(Boolean));
const wanted = argv.filter((a) => !a.startsWith('-') && !skip.has(a));
const pages = wanted.length ? wanted.filter((p) => ALL.includes(p)) : ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Which screen to test on. The second display by default, so the primary
   stays free for whoever is working on it. Set before Halo's own screen code
   starts, which reads it. */
process.env.HALO_DISPLAY = opt('display', process.env.HALO_DISPLAY || 'secondary');

/* --- the pages ------------------------------------------------------------ */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  const path = join(PAGES_DIR, rel);
  if (!path.startsWith(PAGES_DIR)) return res.writeHead(403).end();
  let body;
  try { body = await readFile(path); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'text/plain', 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(PORT, '127.0.0.1');

/* --- a browser of its own -------------------------------------------------- */
const browser = findBrowser();
if (!browser) { console.error('No Chrome or Edge found.'); process.exit(1); }
const profile = join(process.env.LOCALAPPDATA || ROOT, 'Halo', 'qa-profile');
/* Started only when it is not already running: asking a running Chrome to
   start again opens yet another window, after the tab clean-up below. */
const running = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false);
if (!running) {
  spawn(browser, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    '--start-maximized', `http://127.0.0.1:${PORT}/form.html`,
  ], { detached: true, stdio: 'ignore' }).unref();
}

/* The QA window, maximised on the display being tested. Chrome's own window
   API does it without touching the pointer: unmaximise, move onto that
   display, maximise there. */
async function placeOnDisplay(targetId, browserWsUrl) {
  const { Monitor } = createRequire(import.meta.url)('node-screenshots');
  const all = Monitor.all();
  const m = chooseMonitor(all);
  const primary = all.find((d) => d.isPrimary()) ?? all[0];
  const ms = primary.scaleFactor() || 1;
  const ws2 = new WebSocket(browserWsUrl);
  await new Promise((r) => ws2.addEventListener('open', r, { once: true }));
  let n = 0;
  const call = (method, params) => new Promise((resolve) => {
    const id = ++n;
    const on = (e) => { const msg = JSON.parse(e.data); if (msg.id === id) { ws2.removeEventListener('message', on); resolve(msg.result ?? null); } };
    ws2.addEventListener('message', on);
    ws2.send(JSON.stringify({ id, method, params }));
    setTimeout(() => resolve(null), 3000);
  });
  const win = await call('Browser.getWindowForTarget', { targetId });
  if (win?.windowId) {
    await call('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
    await call('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: Math.round(m.x() / ms) + 40, top: Math.round(m.y() / ms) + 40, width: 1000, height: 700 } });
    await call('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } });
  }
  ws2.close();
  await sleep(500);
}

/* Exactly one QA tab. A profile that has been used before comes back with the
   tabs it had, and reading one of those while Halo works in another measures
   nothing — so every earlier one is closed and a fresh one opened. */
async function pageSocket() {
  const base = `http://127.0.0.1:${DEBUG_PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page');
      const fresh = await (await fetch(`${base}/json/new?http://127.0.0.1:${PORT}/form.html`, { method: 'PUT' })).json();
      /* Closed through the browser's own endpoint. /json/close was silently
         ignored, which left two windows both called "QA Agent Lab": Halo
         worked in one and this read the other, and a saved form was scored
         as not saved. */
      const version = await (await fetch(`${base}/json/version`)).json();
      const browserWs = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((r) => browserWs.addEventListener('open', r, { once: true }));
      pages.forEach((p, i) => browserWs.send(JSON.stringify({ id: i + 1, method: 'Target.closeTarget', params: { targetId: p.id } })));
      await sleep(400);
      browserWs.close();
      await placeOnDisplay(fresh.id, version.webSocketDebuggerUrl);
      await fetch(`${base}/json/activate/${fresh.id}`).catch(() => {});
      const left = (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === 'page');
      if (left.length !== 1) console.warn(`[qa] ${left.length} tabs open, expected 1`);
      return fresh.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('Chrome never opened its debugging port');
}

let ws;
let seq = 0;
const pending = new Map();
async function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 10_000);
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

ws = new WebSocket(await pageSocket());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
});

/* --- Halo's own parts, the same ones the bridge builds --------------------- */
const llm = await LLM.fromEnv();
if (!llm) { console.error('No model key in .env.'); process.exit(1); }
await llm.check();
const sense = await Sense.start();
const computer = await loadComputer({ sense });
if (!computer) { console.error('Desktop control unavailable.'); process.exit(1); }

/* Every model call, counted and timed, by kind. */
const calls = [];
let taskStart = null;
for (const name of ['respond', 'chat', 'stream', 'evaluate']) {
  const original = llm[name].bind(llm);
  llm[name] = async (...args) => {
    const t0 = performance.now();
    try { return await original(...args); } finally {
      const model = name === 'evaluate' ? 'jev' : (args[0]?.model || args[1]?.model || '?');
      calls.push({ kind: name, model, ms: Math.round(performance.now() - t0), at: Math.round(t0 - (taskStart ?? t0)) });
    }
  };
}

/* Bring the QA window to the front, and make sure it got there. Windows does
   not always hand over the focus, and a task started with another window in
   front — measured: another Chrome showing "Halo Agent Lab" — is Halo working
   in the wrong place, which says nothing about Halo. */
async function raise(title) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const list = (await sense?.windows()) ?? [];
    const w = list.find((x) => String(x.title || '').startsWith(title));
    if (w) await computer.focus(w.hwnd).catch(() => {});
    await sleep(300);
    const front = await computer.foreground().catch(() => null);
    if (String(front?.title || '').startsWith(title)) return true;
  }
  return false;
}

/* --- run ---------------------------------------------------------------------- */
await mkdir(join(ROOT, 'artifacts', 'qa'), { recursive: true });
const outFile = join(ROOT, 'artifacts', 'qa', `${label}.jsonl`);
const rows = [];
console.log(`Halo QA — ${pages.join(', ')} × ${repeat} — see ${llm.tiers.see}, plan ${llm.tiers.plan}, jev ${llm.gatewayKey ? 'on' : 'off'}`);
console.log('Hands off the mouse and keyboard.\n');

for (let round = 1; round <= repeat; round++) {
  for (const page of pages) {
    /* A locked screen or a screen saver is not a failed task: nothing can be
       tried at all, and recording it as a failure would poison the numbers. */
    const reachable = await computer.available?.() ?? { ok: true };
    if (!reachable.ok) {
      console.log(`\nStopped before "${page}": ${reachable.why}. Nothing was recorded for it — run again when the desktop is free.`);
      ws.close(); server.close(); sense?.stop();
      process.exit(2);
    }
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}.html` });
    await sleep(900);
    /* A title no other window has, so the window raised is this tab's. */
    const tag = Math.random().toString(36).slice(2, 6);
    await evaluate(`document.title = document.title + ' #${tag}'`);
    const title = await evaluate('document.title');
    const task = await evaluate('qa.task');
    if (!(await raise(title))) {
      console.log(`SKIP  ${page.padEnd(7)} the QA window would not come to the front — not measured`);
      continue;
    }

    calls.length = 0;
    const actions = [];
    const t0 = performance.now();
    taskStart = t0;
    let firstAction = null;
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; }, TASK_LIMIT_MS);

    let outcome = null;
    let error = null;
    try {
      outcome = await runTask({
        task,
        computer,
        llm,
        maxTurns: 24,
        context: { milestonePlanning: true },
        hooks: {
          gate: async () => !stopped,
          onAction: (a) => {
            if (firstAction === null) firstAction = Math.round(performance.now() - t0);
            actions.push({ type: a.type, detail: String(a.detail || '').slice(0, 120), at: Math.round(performance.now() - t0) });
          },
          onApproval: async () => true,
          onQuestion: async (q) => (q.options?.[0] ? { text: q.options[0].label ?? q.options[0], choice: q.options[0].id ?? null } : 'Use your best judgement.'),
          onHandover: async () => { stopped = true; },
          onError: (e) => { error = e?.message || String(e); },
        },
      });
    } catch (err) {
      error = err.message;
    }
    clearTimeout(timer);
    const total = Math.round(performance.now() - t0);
    const seen = await evaluate('qa.result()').catch(() => null) ?? { pass: false, detail: 'page unreadable' };

    const repeats = actions.filter((a, i) => i && a.type === actions[i - 1].type && a.detail === actions[i - 1].detail).length;
    const row = {
      label, page, round, task,
      pass: Boolean(seen.pass), detail: seen.detail,
      haloSaid: outcome?.succeeded ?? null,
      presses: seen.presses, misses: seen.misses,
      actions: actions.length, repeats,
      firstActionMs: firstAction, totalMs: total, timedOut: stopped && !outcome,
      calls: calls.length,
      callLog: calls.map((c) => ({ ...c })),
      byKind: calls.reduce((m, c) => ({ ...m, [c.model]: (m[c.model] || 0) + 1 }), {}),
      modelMs: calls.reduce((s, c) => s + c.ms, 0),
      error,
      log: actions,
      pressLog: seen.log,
    };
    rows.push(row);
    await appendFile(outFile, `${JSON.stringify(row)}\n`);
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${page.padEnd(7)} ${String(total).padStart(6)}ms  first ${String(firstAction ?? '-').padStart(5)}ms  `
      + `actions ${row.actions}  misses ${row.misses}/${row.presses}  calls ${row.calls}  ${row.pass ? '' : `— ${row.detail}${error ? ` · ${error}` : ''}`}`);
  }
}

/* --- summary ------------------------------------------------------------------ */
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const passed = rows.filter((r) => r.pass).length;
const presses = rows.reduce((s, r) => s + (r.presses || 0), 0);
const misses = rows.reduce((s, r) => s + (r.misses || 0), 0);
console.log(`\n${passed}/${rows.length} passed · misclicks ${misses}/${presses} · `
  + `median first action ${median(rows.map((r) => r.firstActionMs))}ms · median total ${median(rows.map((r) => r.totalMs))}ms · `
  + `median calls ${median(rows.map((r) => r.calls))}`);
console.log(`Saved to ${outFile}`);

ws.close();
server.close();
sense?.stop();
process.exit(0);
