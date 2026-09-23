#!/usr/bin/env node
/* ==========================================================================
   Halo QA on real websites, through the app's own front door.

   scripts/qa.mjs measures the driver on pages written for it. This measures
   what a person actually gets: real sites nobody wrote for Halo — a
   Bootstrap form, a React to-do app, Wikipedia, GitHub, an HTML5
   drag-and-drop page — and the task handed to HostAgent.run(), exactly as a
   message from the app is. So the routing (chat or job), the openers and
   shortcuts, the no-model planners, the batching, the Jev checkpoints and
   the model tiers are all the ones the app uses, at the app's speed.

   Each task is scored from the page's own state once Halo says it is done —
   the URL a form submitted to, the value a select holds, the order of two
   boxes — never by a model and never from a screenshot.

   Same isolated Chrome as qa.mjs (its own profile and debugging port), on the
   second display unless told otherwise. It uses YOUR mouse and keyboard
   while it runs, and needs the internet.

   Run:   node scripts/qa-real.mjs                       every task, once
          node scripts/qa-real.mjs form todo -n 2        those, twice each
          node scripts/qa-real.mjs --label real-base     name the results file
   ========================================================================== */

import { mkdir, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEBUG_PORT = 9333;
const TASK_LIMIT_MS = 120_000;

/* Pass checks run in the page after the run: an expression that evaluates to
   { pass, detail }. Kept to what the page itself says. */
const TASKS = [
  {
    id: 'form',
    url: 'https://www.selenium.dev/selenium/web/web-form.html',
    task: 'On the Web form page, type Halo test into Text input, type hello from Halo into Textarea, choose Two in the Dropdown (select), then click Submit.',
    check: `(() => { const u = new URL(location.href); const q = u.searchParams;
      return { pass: /submitted-form/.test(u.pathname) && q.get('my-text') === 'Halo test' && (q.get('my-textarea') || '').trim() === 'hello from Halo' && q.get('my-select') === '2',
        detail: u.pathname.split('/').pop() + ' text=' + q.get('my-text') + ' textarea=' + q.get('my-textarea') + ' select=' + q.get('my-select') }; })()`,
  },
  {
    id: 'range',
    url: 'https://www.selenium.dev/selenium/web/web-form.html',
    task: 'On the Web form page, set the Example range slider to 8.',
    check: `(() => { const r = document.querySelector('input[name=my-range]'); return { pass: r?.value === '8', detail: 'range=' + r?.value }; })()`,
  },
  {
    id: 'dropdown',
    url: 'https://the-internet.herokuapp.com/dropdown',
    task: 'On the Dropdown List page, choose Option 2 in the dropdown.',
    check: `(() => { const s = document.querySelector('#dropdown'); return { pass: s?.value === '2', detail: 'value=' + s?.value }; })()`,
  },
  {
    id: 'checkbox',
    url: 'https://the-internet.herokuapp.com/checkboxes',
    task: 'On the Checkboxes page, tick checkbox 1 and leave checkbox 2 as it is.',
    check: `(() => { const b = [...document.querySelectorAll('#checkboxes input')]; return { pass: b[0]?.checked === true && b[1]?.checked === true, detail: b.map((x) => x.checked).join(',') }; })()`,
  },
  {
    id: 'add3',
    url: 'https://the-internet.herokuapp.com/add_remove_elements/',
    task: 'On the Add/Remove Elements page, click Add Element three times.',
    check: `(() => { const n = document.querySelectorAll('#elements button').length; return { pass: n === 3, detail: n + ' added' }; })()`,
  },
  {
    id: 'dnd',
    url: 'https://the-internet.herokuapp.com/drag_and_drop',
    task: 'On the Drag and Drop page, drag box A onto box B.',
    check: `(() => { const a = document.querySelector('#column-a header')?.textContent.trim(); return { pass: a === 'B', detail: 'first box now ' + a }; })()`,
  },
  {
    id: 'todo',
    url: 'https://todomvc.com/examples/react/dist/',
    task: 'On the TodoMVC page, add a todo called Buy milk.',
    check: `(() => { const l = [...document.querySelectorAll('.todo-list li label')].map((x) => x.textContent.trim()); return { pass: l.includes('Buy milk'), detail: l.join(' | ') || 'no todos' }; })()`,
  },
  {
    id: 'wiki',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    task: 'On Wikipedia, search for Alan Turing and open his article.',
    check: `(() => ({ pass: /^Alan Turing\\b/.test(document.title), detail: document.title }))()`,
  },
  {
    id: 'github',
    url: 'https://github.com/Abhiram-745/pico',
    task: 'On the GitHub page for pico, open the Releases page.',
    check: `(() => ({ pass: /\\/releases/.test(location.pathname), detail: location.pathname }))()`,
  },
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`) >= 0 ? argv.indexOf(`--${name}`) : argv.indexOf(`-${name[0]}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const repeat = Math.max(1, Number(opt('n', 1)) || 1);
const label = opt('label', `real-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
const skip = new Set([opt('n'), opt('label'), opt('display')].filter(Boolean));
const wanted = argv.filter((a) => !a.startsWith('-') && !skip.has(a));
const tasks = wanted.length ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The second display unless told otherwise, set before Halo's screen code reads it.
process.env.HALO_DISPLAY = opt('display', process.env.HALO_DISPLAY || 'secondary');

const { LLM } = await import('../bridge/llm.mjs');
const { Sense } = await import('../bridge/sense.mjs');
const { loadComputer } = await import('../bridge/computer.mjs');
const { HostAgent } = await import('../bridge/agent.mjs');
const { findBrowser } = await import('../bridge/notch-window.mjs');
const { chooseMonitor } = await import('../bridge/screen.mjs');

/* --- a browser of its own (as qa.mjs) --------------------------------------- */
const browser = findBrowser();
if (!browser) { console.error('No Chrome or Edge found.'); process.exit(1); }
const profile = join(process.env.LOCALAPPDATA || ROOT, 'Halo', 'qa-profile');
const running = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false);
if (!running) {
  spawn(browser, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--start-maximized', 'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();
}

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

async function pageSocket() {
  const base = `http://127.0.0.1:${DEBUG_PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page');
      const fresh = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
      const version = await (await fetch(`${base}/json/version`)).json();
      const browserWs = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((r) => browserWs.addEventListener('open', r, { once: true }));
      pages.forEach((p, k) => browserWs.send(JSON.stringify({ id: k + 1, method: 'Target.closeTarget', params: { targetId: p.id } })));
      await sleep(400);
      browserWs.close();
      await placeOnDisplay(fresh.id, version.webSocketDebuggerUrl);
      await fetch(`${base}/json/activate/${fresh.id}`).catch(() => {});
      return fresh.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('Chrome never opened its debugging port');
}

let ws;
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
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
await cdp('Page.enable').catch(() => {});

/* --- Halo, assembled the way the bridge assembles it ------------------------- */
const llm = await LLM.fromEnv();
if (!llm) { console.error('No model key in .env.'); process.exit(1); }
await llm.check();
const sense = await Sense.start();
const computer = await loadComputer({ sense });
if (!computer) { console.error('Desktop control unavailable.'); process.exit(1); }

const events = [];
let hostHandler = null;
let handedOver = false;
const transport = {
  emit: (type, payload) => {
    events.push({ type, payload, at: performance.now() });
    // A question gets its first offered answer, as qa.mjs does; a takeover is a fail.
    if (type === 'question' && payload) {
      const first = payload.options?.[0];
      setTimeout(() => hostHandler?.({ command: 'answerQuestion', payload: { text: first?.label ?? first ?? 'Use your best judgement.', choice: first?.id ?? null } }), 50);
    }
    /* A hand-over is Halo giving up on the task, so it is a fail — and the
       run waits for the person to say they are done, which here nobody
       would: the first version of this sat on one for sixteen minutes. */
    if (type === 'takeover' && payload) {
      handedOver = true;
      agent.cancelled = true;
      setTimeout(() => hostHandler?.({ command: 'takeoverDone', payload: {} }), 50);
    }
  },
  onCommand: (handler) => { hostHandler = handler; },
};
const agent = new HostAgent(transport);
agent.attachComputer(computer);
agent.attachLLM(llm);
agent.settings = { ...agent.settings, autoApproveAll: true, hasApiKey: true };

/* Every model call, counted and timed. */
const calls = [];
let taskStart = 0;
for (const name of ['respond', 'chat', 'stream', 'evaluate']) {
  const original = llm[name]?.bind(llm);
  if (!original) continue;
  llm[name] = async (...args) => {
    const t0 = performance.now();
    try { return await original(...args); } finally {
      const model = name === 'evaluate' ? 'jev' : (args[0]?.model || args[1]?.model || '?');
      calls.push({ kind: name, model, ms: Math.round(performance.now() - t0), at: Math.round(t0 - taskStart) });
    }
  };
}

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
console.log(`Halo QA on real sites — ${tasks.map((t) => t.id).join(', ')} × ${repeat} — see ${llm.tiers.see}, plan ${llm.tiers.plan}, jev ${llm.gatewayKey ? 'on' : 'off'}`);
console.log('Hands off the mouse and keyboard.\n');

for (let round = 1; round <= repeat; round++) {
  for (const t of tasks) {
    const reachable = await computer.available?.() ?? { ok: true };
    if (!reachable.ok) { console.log(`\nStopped before "${t.id}": ${reachable.why}.`); break; }

    await cdp('Page.navigate', { url: t.url });
    for (let i = 0; i < 40; i++) {           // loaded, and settled a moment
      await sleep(250);
      if (await evaluate('document.readyState').catch(() => '') === 'complete') break;
    }
    await sleep(600);
    const tag = Math.random().toString(36).slice(2, 6);
    await evaluate(`document.title = document.title + ' #${tag}'`).catch(() => {});
    const title = await evaluate('document.title').catch(() => '');
    if (!(await raise(title))) { console.log(`SKIP  ${t.id.padEnd(9)} the QA window would not come to the front`); continue; }

    calls.length = 0;
    events.length = 0;
    handedOver = false;
    const t0 = performance.now();
    taskStart = t0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; agent.cancelled = true; }, TASK_LIMIT_MS);
    let error = null;
    try { await agent.run(t.task); } catch (err) { error = err.message; }
    clearTimeout(timer);
    const total = Math.round(performance.now() - t0);
    await sleep(400);
    const seen = await evaluate(t.check).catch((err) => ({ pass: false, detail: `unreadable: ${err.message}` })) ?? { pass: false, detail: 'unreadable' };

    const actions = events.filter((e) => e.type === 'action').map((e) => ({ type: e.payload?.type, detail: String(e.payload?.detail || '').slice(0, 120), at: Math.round(e.at - t0) }));
    const routed = events.find((e) => e.type === 'routed')?.payload;
    const phases = events.filter((e) => e.type === 'phase').map((e) => e.payload?.phase);
    const summary = events.filter((e) => e.type === 'summary').map((e) => e.payload?.text).pop() ?? null;
    const errors = events.filter((e) => e.type === 'error' && e.payload).map((e) => e.payload.message || e.payload.title);
    const row = {
      label, id: t.id, round, task: t.task, url: t.url,
      pass: Boolean(seen.pass), detail: seen.detail,
      routed: routed ? `${routed.mode} (${routed.source})` : null,
      finalPhase: phases.at(-1) ?? null,
      handedOver,
      firstActionMs: actions[0]?.at ?? null, totalMs: total, timedOut,
      actions: actions.length, calls: calls.length,
      byModel: calls.reduce((m, c) => ({ ...m, [c.model]: (m[c.model] || 0) + 1 }), {}),
      modelMs: calls.reduce((s, c) => s + c.ms, 0),
      callLog: calls.map((c) => ({ ...c })),
      summary, error: error ?? errors[0] ?? null,
      log: actions,
    };
    rows.push(row);
    await appendFile(outFile, `${JSON.stringify(row)}\n`);
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${t.id.padEnd(9)} ${String(total).padStart(6)}ms  first ${String(row.firstActionMs ?? '-').padStart(5)}ms  `
      + `actions ${row.actions}  calls ${row.calls} ${JSON.stringify(row.byModel)}  ${row.pass ? '' : `— ${row.detail}${row.error ? ` · ${row.error}` : ''}`}`);
    agent.cancelled = false;
  }
}

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const passed = rows.filter((r) => r.pass).length;
console.log(`\n${passed}/${rows.length} passed · median first action ${median(rows.map((r) => r.firstActionMs))}ms · `
  + `median total ${median(rows.map((r) => r.totalMs))}ms · median calls ${median(rows.map((r) => r.calls))}`);
console.log(`Saved to ${outFile}`);

ws.close();
sense?.stop();
process.exit(0);
