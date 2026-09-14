/* ==========================================================================
   Pico bridge — lets a paired phone drive the desktop agent over the LAN.

   Security posture, deliberately conservative:

     * Binds to the LAN so a phone can reach it, but refuses any connection
       whose remote address is not in a private range. Nothing is exposed to
       the internet, and no relay or account is involved.
     * A phone must present a short pairing code, shown only on the laptop
       screen, before it is issued a token. The code rotates every run and
       expires.
     * Pairing attempts are rate limited, and the code is compared in constant
       time so it cannot be guessed by timing.
     * Commands are checked against an allowlist. A paired phone gets exactly
       the same authority as the desktop UI — no more.

   The phone is the user, so it may approve actions. It can never bypass an
   approval: the approval still has to happen.
   ========================================================================== */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import { upgrade } from './ws.mjs';
import { encode, toTerminal, toSVG } from './qr.mjs';
import { HostAgent } from './agent.mjs';
import { loadComputer } from './computer.mjs';
import { LLM, PROVIDERS } from './llm.mjs';
import { NotchWindow } from './notch-window.mjs';
import * as autostart from './autostart.mjs';
import { IslandHost } from './island-host.mjs';
import { check as checkUpdate, install as installUpdate, localBuild } from './updater.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PICO_BRIDGE_PORT) || 4177;

/* Commands a client may send. Must stay in sync with UI_COMMANDS in
   pico-ui/src/bridge.js — anything not listed here is dropped. */
const ALLOWED_COMMANDS = new Set([
  'submitTask', 'pause', 'resume', 'stop',
  'approve', 'deny', 'takeoverDone',
  'saveSettings', 'setName', 'answerQuestion', 'tuckAway',
  'openPalette', 'closePalette', 'movePalette',
  'openNotch', 'closeNotch',
]);

const MAX_TASK_LENGTH = 2000;   // mirrors the desktop app's own task limit

/* ---------------------------------------------------------------------------
   Pairing
   -------------------------------------------------------------------------*/
// Crockford-ish alphabet: no I, O, 0, 1, U — unambiguous when read off a screen
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';

function makeCode(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** RFC1918 / link-local / loopback only. */
function isPrivateAddress(addr = '') {
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^f[cd]/i.test(ip)) return true;          // unique local IPv6
  if (/^fe80:/i.test(ip)) return true;          // link-local IPv6
  return false;
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && isPrivateAddress(net.address)) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/* ---------------------------------------------------------------------------
   Bridge
   -------------------------------------------------------------------------*/
class Bridge {
  constructor() {
    this.clients = new Set();
    this.tokens = new Set();
    this.pairCode = makeCode();
    this.pairAttempts = new Map();   // ip -> { count, until }

    // Last-known host state, replayed to every client on connect so a phone
    // joining mid-task is not staring at a blank screen.
    this.snapshot = {
      phase: { phase: 'Idle' },
      summary: null,
      guardian: { ready: false },
      settings: null,
      pauseState: { paused: false },
      approval: null,
      takeover: null,
      question: null,
    };

    // The conversation so far, so a phone joining mid-thread sees it rather
    // than an empty window. Capped: this is a replay buffer, not a store.
    this.messages = [];

    this.transport = {
      emit: (type, payload) => this._fromHost(type, payload),
      onCommand: (handler) => { this._hostHandler = handler; },
    };

    this.agent = new HostAgent(this.transport);
    this.agent.start();
    this.llm = null;
    this.screenSize = null;
    this.notch = null;        // set once the server knows its own address
  }

  /**
   * Attach the model provider. The key lives only in this process — the
   * planner runs server-side and the phone receives nothing but the resulting
   * steps.
   */
  attachLLM(llm) {
    this.llm = llm;
    llm.onDowngrade = (from, to) => {
      console.warn(`[bridge] ${from} unavailable, using ${to} for this request`);
    };
    this.agent.attachLLM(llm);
    this.agent.settings = {
      ...this.agent.settings,
      // One task uses several: the strongest model plans it, then the
      // cheapest model that can actually do each step carries it out.
      model: `${llm.tiers.plan} + ${llm.tiers.see} / ${llm.tiers.fast}`,
      hasApiKey: true,
    };
    this.emitSettings();
    this.publishCapability();
  }

  /** Real mouse/keyboard/screen control, when the machine allows it. */
  async attachComputer(computer) {
    this.agent.attachComputer(computer);
    try { this.screenSize = await computer.size(); } catch { this.screenSize = null; }
    this.publishCapability();
  }

  /**
   * Say plainly whether Pico can actually work, and why not when it cannot.
   * The old build reported `guardian: ready` unconditionally and then ran a
   * scripted stand-in, so a machine with no key looked identical to a working
   * one right up until nothing happened.
   */
  publishCapability() {
    this._fromHost('guardian', {
      ready: true,                       // chat always works
      canAct: this.agent.canAct(),       // driving the desktop may not
      reason: this.agent.blockedReason(),
      // So the interface can place the live cursor on a map of the screen
      // at the right proportions instead of assuming 16:9.
      screen: this.agent.computer ? this.screenSize : null,
    });
  }

  emitSettings() {
    this._fromHost('settings', this.agent.settings);
  }

  /** Host -> every connected client. */
  _fromHost(type, payload) {
    if (type in this.snapshot) this.snapshot[type] = payload;

    if (type === 'message') {
      // Streamed replies arrive many times under one id; keep the latest of
      // each rather than a bubble per token.
      const i = this.messages.findIndex((m) => m.id === payload.id);
      if (i === -1) this.messages = [...this.messages, payload].slice(-40);
      else this.messages[i] = payload;
    }

    if (type === 'phase') showCursorFor(payload.phase);
    if (type === 'action' && /click/i.test(payload.type || '')) {
      islandHost?.cursorState('clicking');
    }

    if (type === 'phase') {
      // decision cards do not survive a phase change
      if (payload.phase !== 'AwaitingApproval') this.snapshot.approval = null;
      if (payload.phase !== 'AwaitingTakeover') this.snapshot.takeover = null;
    }
    this.broadcast({ type, payload });
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.paired && c.conn.open) c.conn.send(text);
    }
  }

  replay(client) {
    const s = this.snapshot;
    const send = (type, payload) => payload && client.conn.sendJSON({ type, payload });
    send('guardian', s.guardian);
    send('settings', s.settings);
    for (const m of this.messages) send('message', m);
    send('phase', s.phase);
    send('pauseState', s.pauseState);
    send('approval', s.approval);
    send('takeover', s.takeover);
    send('question', s.question);
    // Not part of the snapshot, because it is not the agent's state — but it
    // has to be replayed for the same reason everything else here is: a page
    // that has just connected knows nothing until it is told.
    if (this.notch?.hoverTimer) client.conn.sendJSON({ type: 'notchHover', payload: { over: this.notch.over } });
  }

  /** Rate limit: 5 wrong codes per address, then a 60s lockout. */
  throttled(ip) {
    const rec = this.pairAttempts.get(ip);
    if (!rec) return false;
    if (rec.until && Date.now() < rec.until) return true;
    if (rec.until && Date.now() >= rec.until) { this.pairAttempts.delete(ip); return false; }
    return false;
  }

  noteFailure(ip) {
    const rec = this.pairAttempts.get(ip) || { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= 5) {
      rec.until = Date.now() + 60_000;
      rec.count = 0;
      console.warn(`[bridge] pairing locked out for ${ip} (60s)`);
    }
    this.pairAttempts.set(ip, rec);
  }

  handleMessage(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;   // malformed input is dropped, never echoed back
    }
    if (!msg || typeof msg !== 'object') return;

    // --- pairing handshake ------------------------------------------------
    if (!client.paired) {
      if (msg.command === 'pair') {
        if (this.throttled(client.ip)) {
          client.conn.sendJSON({ type: 'paired', payload: { ok: false, reason: 'Too many attempts. Wait a minute.' } });
          return;
        }
        const byToken = typeof msg.token === 'string' && this.tokens.has(msg.token);
        const byCode = typeof msg.code === 'string' && constantTimeEqual(msg.code.toUpperCase().trim(), this.pairCode);

        if (!byToken && !byCode) {
          this.noteFailure(client.ip);
          client.conn.sendJSON({ type: 'paired', payload: { ok: false, reason: 'That code is not right.' } });
          return;
        }

        const token = byToken ? msg.token : randomBytes(24).toString('base64url');
        this.tokens.add(token);
        client.paired = true;
        this.pairAttempts.delete(client.ip);

        client.conn.sendJSON({ type: 'paired', payload: { ok: true, token, name: 'this laptop' } });
        this.replay(client);
        console.log(`[bridge] paired ${client.ip}${byToken ? ' (token)' : ' (code)'}`);
      }
      return;   // nothing else is accepted before pairing
    }

    // --- normal commands --------------------------------------------------
    const { command, payload = {} } = msg;

    // Loopback clients are auto-paired, but still send the handshake on
    // connect. Acknowledge it rather than logging it as a rejected command.
    if (command === 'pair') {
      client.conn.sendJSON({ type: 'paired', payload: { ok: true, token: null, name: 'this laptop' } });
      return;
    }

    if (!ALLOWED_COMMANDS.has(command)) {
      console.warn(`[bridge] rejected command "${command}" from ${client.ip}`);
      return;
    }

    if (command === 'submitTask') {
      const text = String(payload.text ?? '').slice(0, MAX_TASK_LENGTH).trim();
      if (!text) return;
      const mode = ['auto', 'chat', 'agent'].includes(payload.mode) ? payload.mode : 'auto';

      // Echo it to everyone, so the phone and the laptop show the same thread
      // rather than each keeping its own half of it. The sender already added
      // it locally under this id, and messages upsert by id, so echoing back
      // to the sender replaces its own copy rather than duplicating it.
      const id = typeof payload.id === 'string' && /^[\w-]{1,48}$/.test(payload.id)
        ? payload.id
        : `you_${Date.now()}`;
      this._fromHost('message', { id, from: 'you', text, done: true });

      console.log(`[bridge] message from ${client.ip} (${mode})`);
      this._hostHandler?.({ command, payload: { text, mode } });
      return;
    }

    // Opening a window on the laptop is a local action. A paired phone gets
    // the same authority as the desktop UI over the agent, but spawning a
    // browser process is not part of that.
    if (command === 'openNotch' || command === 'closeNotch') {
      if (!client.local) {
        console.warn(`[bridge] refused ${command} from ${client.ip} (not local)`);
        return;
      }
      this.onNotchCommand?.(command);
      return;
    }

    // approve/deny must name the decision they are answering, so a stale phone
    // cannot approve whatever happens to be pending now.
    if (command === 'answerQuestion') {
      const text = String(payload.text ?? '').slice(0, MAX_TASK_LENGTH).trim();
      if (!text) return;
      // The thread entry is written by the agent once the answer has landed,
      // so that the question and the answer appear together and in order.
      this._hostHandler?.({ command, payload: { text } });
      return;
    }

    if (command === 'approve' || command === 'deny') {
      const pending = this.snapshot.approval;
      if (!pending || pending.id !== payload.id) {
        console.warn(`[bridge] stale ${command} from ${client.ip}`);
        return;
      }
    }
    if (command === 'takeoverDone') {
      const pending = this.snapshot.takeover;
      if (!pending || pending.id !== payload.id) return;
    }

    this._hostHandler?.({ command, payload });
  }
}

/* ---------------------------------------------------------------------------
   HTTP + WebSocket
   -------------------------------------------------------------------------*/
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Write the key into .env without disturbing anything else in it. */
async function saveKey(key) {
  const envPath = join(ROOT, '.env');
  let lines = [];
  try {
    lines = (await readFile(envPath, 'utf8')).split('\n')
      .filter((l) => !l.trim().startsWith('OPENAI_API_KEY'))
      .filter((l, i, a) => !(l.trim() === '' && a[i + 1]?.trim() === ''));
  } catch { /* first run, no file yet */ }

  const body = [
    ...lines,
    '# Written by Pico setup. Keep this file private.',
    `OPENAI_API_KEY=${key}`,
    '',
  ].join('\n').replace(/^\s+/, '');

  await writeFile(envPath, body, { encoding: 'utf8', mode: 0o600 });
}

/* Pico's cursor. Shown only while Pico is actually working — the rest of the
   time there is nothing on screen and nothing running to draw it.

   WHOSE POINTER MOVES
   Ordinarily neither. A click now goes through the accessibility layer,
   which presses the control itself — Pico's cursor walks over and presses
   it, and the real pointer is not involved at all. A run made only of those
   leaves the user's mouse exactly where it is, visible and usable, with
   Pico's cursor working alongside it.

   Some things have no such route: a drag, a right-click, an application that
   exposes nothing. Windows has one pointer, so those borrow it — and only
   then does the system cursor go invisible, at the moment it is first moved
   rather than at the start of the run. It is put back where it was, and
   touching the mouse mid-run takes it straight back: the helper notices the
   pointer moving when nothing is driving it and returns it without being
   asked. */
/* The mark Pico's own cursor carries. Rendered from the character rig (see
   pico-ui/src/mascot.js) rather than being the old 1254px app icon, so the
   cursor shows the same Pico as everything else and at a size where it is
   legible instead of being a downscaled screenshot of one. */
const CURSOR_ART = join(ROOT, 'pico-ui', 'assets', 'pico-mark.png');
const WORKING = new Set([
  'Starting', 'Observing', 'Thinking', 'Acting', 'Paused',
  'AwaitingApproval', 'AwaitingTakeover',
]);
let islandHost = null;
let cursorShown = false;
let cursorOffTimer = null;
let pointerTaken = false;      // the system pointer has been hidden this run
let ghost = null;              // where Pico's own cursor is, when nothing real moves

function showCursorFor(phase) {
  if (!islandHost?.ready) return;
  const working = WORKING.has(phase);

  if (working && !cursorShown) {
    clearTimeout(cursorOffTimer);
    // Remember where the pointer is before anything moves it. The user's
    // pointer is NOT hidden here: most of what Pico does now happens through
    // the accessibility layer, where nothing of theirs is touched at all, and
    // hiding a pointer nothing is going to move would be taking something for
    // no reason. It goes only at the moment something really moves it — see
    // onPointer below.
    islandHost.cursorSave();
    islandHost.cursorOn(CURSOR_ART);
    cursorShown = true;
    pointerTaken = false;
    ghost = computer?.pointer ? { ...computer.pointer } : null;
    if (ghost) islandHost.cursorAt(ghost.x, ghost.y);
    if (process.env.PICO_DEBUG) console.log('[cursor] shown');
  }
  if (working) {
    islandHost.cursorState(phase === 'Thinking' ? 'thinking' : 'moving');

    // Nothing is being pointed at while Pico thinks, and thinking is most of
    // a run. So the pointer goes home and waits there between actions — what
    // crosses the screen in the meantime is Pico's cursor, and the user's is
    // where they left it whenever they look. (Once they touch the mouse
    // themselves the helper stops obeying this: it is their pointer again.)
    //
    // Only if it was ever taken. Putting a pointer "back" that never left
    // means dragging it away from wherever the user has since moved it, which
    // is the precise opposite of the point.
    if (phase === 'Thinking' && pointerTaken) islandHost.cursorRestore();
    return;
  }
  if (!cursorShown) return;

  // Linger a moment on the result rather than blinking out mid-gesture.
  islandHost.cursorState(phase === 'Completed' ? 'done' : 'moving');
  clearTimeout(cursorOffTimer);
  cursorOffTimer = setTimeout(() => {
    // Order matters the other way round on the way out: the pointer goes
    // back to where the user left it while it is still invisible, so they
    // never see it travel there. Untouched pointers are left alone.
    if (pointerTaken) islandHost?.cursorRestore();
    islandHost?.cursorOff();
    islandHost?.cursorShow();
    cursorShown = false;
    pointerTaken = false;
    ghost = null;
    if (process.env.PICO_DEBUG) console.log('[cursor] hidden');
  }, 1400);
}

/* The pointer must never be left invisible because the bridge went away.
   The helper restores it on stdin closing and again on a timer of its own,
   but asking politely first is faster and covers Ctrl-C. */
function releasePointer() {
  try { islandHost?.cursorShow(); } catch { /* the helper is already gone */ }
}
process.once('exit', releasePointer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.once(sig, () => {
    releasePointer();
    try { islandHost?.stop(); } catch { /* already gone */ }
    process.exit(0);
  });
}

/* A bug anywhere must not take the bridge down with it. When it did, the
   interface and the paired phone both lost their connection and the only
   symptom the user saw was that Pico stopped existing. Log it, keep
   serving. */
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaught:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[bridge] unhandled rejection:', err);
});

const BUILD = await localBuild();
const bridge = new Bridge();

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!isPrivateAddress(ip)) {
    res.writeHead(403).end('Bridge accepts local network connections only.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- setup -------------------------------------------------------------
  // Loopback only, like updates. Entering a key is safe from the machine the
  // key already has to live on; it must never be reachable from the phone.
  if (url.pathname === '/setup/key' && req.method === 'POST') {
    const isLocal = /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, ''));
    if (!isLocal) { res.writeHead(403).end('Setup is local-only.'); return; }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) { res.writeHead(413).end('{}'); return; }
    }

    let key = '';
    try { key = String(JSON.parse(raw).key || '').trim(); } catch { /* handled below */ }

    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (!key) { reply(400, { ok: false, error: 'Paste a key first.' }); return; }
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) {
      reply(400, { ok: false, error: 'That does not look like an OpenAI key. They start with "sk-".' });
      return;
    }

    // Prove it works before writing it, so a typo fails here rather than on
    // the first task.
    try {
      const probe = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (probe.status === 401) { reply(400, { ok: false, error: 'OpenAI rejected that key.' }); return; }
      if (!probe.ok) { reply(400, { ok: false, error: `OpenAI returned ${probe.status}. Try again.` }); return; }
    } catch {
      reply(502, { ok: false, error: 'Could not reach OpenAI. Check your connection.' });
      return;
    }

    try {
      await saveKey(key);
    } catch (err) {
      // Never echo the key, even in an error.
      reply(500, { ok: false, error: `Could not save the key: ${String(err.message).replace(key, '***')}` });
      return;
    }

    const fresh = await LLM.fromEnv();
    if (fresh) {
      bridge.attachLLM(fresh);
      console.log('[bridge] key saved; model provider attached');
    }
    reply(200, { ok: true });
    return;
  }

  if (url.pathname === '/setup/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      hasKey: Boolean(bridge.llm),
      provider: bridge.llm?.provider ?? null,
      local: /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, '')),
    }));
    return;
  }

  // --- updates -----------------------------------------------------------
  // Loopback only: an update rewrites files on disk, so a paired phone on the
  // network must not be able to trigger one.
  if (url.pathname.startsWith('/update/')) {
    const isLocal = /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, ''));
    if (!isLocal) { res.writeHead(403).end('Updates are local-only.'); return; }

    if (url.pathname === '/update/check') {
      try {
        const info = await checkUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(info));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }

    // Restarting is the last step of an update, so it belongs with it. The
    // replacement is spawned detached and waits for this process to release
    // the port before binding; clients reconnect on their own.
    if (url.pathname === '/update/restart' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ restarting: true }));

      setTimeout(() => {
        try {
          const script = fileURLToPath(new URL('server.mjs', import.meta.url));
          spawn(
            process.platform === 'win32' ? 'cmd' : 'sh',
            process.platform === 'win32'
              ? ['/c', 'timeout', '/t', '2', '/nobreak', '>nul', '&&', process.execPath, script]
              : ['-c', `sleep 2; "${process.execPath}" "${script}"`],
            { detached: true, stdio: 'ignore', cwd: ROOT, windowsHide: true },
          ).unref();
        } catch (err) {
          console.error('[bridge] restart failed:', err.message);
          return;   // stay alive rather than exiting with no replacement
        }
        console.log('[bridge] restarting');
        server.close();
        process.exit(0);
      }, 250);
      return;
    }

    if (url.pathname === '/update/install' && req.method === 'POST') {
      // Streamed as newline-delimited JSON so the UI can show real progress
      // rather than a spinner that means nothing.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      try {
        const out = await installUpdate((stage, pct) => {
          res.write(`${JSON.stringify({ stage, pct })}
`);
        });
        res.end(`${JSON.stringify({ stage: 'done', pct: 100, ...out })}
`);
      } catch (err) {
        res.end(`${JSON.stringify({ error: String(err.message) })}
`);
      }
      return;
    }

    res.writeHead(404).end('Not found');
    return;
  }

  // --- start with Windows -------------------------------------------------
  // Local only: it writes a shortcut into this user's Startup folder.
  if (url.pathname.startsWith('/startup/')) {
    const isLocal = /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, ''));
    if (!isLocal) { res.writeHead(403).end('Local only.'); return; }

    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    try {
      if (url.pathname === '/startup/state') return reply(200, autostart.state());
      if (url.pathname === '/startup/enable' && req.method === 'POST') {
        return reply(200, await autostart.enable());
      }
      if (url.pathname === '/startup/disable' && req.method === 'POST') {
        return reply(200, await autostart.disable());
      }
    } catch (err) {
      return reply(500, { error: String(err.message) });
    }
    res.writeHead(404).end('Not found');
    return;
  }

  // --- the notch window --------------------------------------------------
  // The notch page posts the height it wants as its content changes. Local
  // only: it resizes a window on this machine.
  if (url.pathname === '/notch/size' && req.method === 'POST') {
    const isLocal = /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, ''));
    if (!isLocal) { res.writeHead(403).end('Local only.'); return; }

    // Only the island this bridge opened. Any other page on notch.html —
    // a leftover tab, the hosted preview — must not move the real window.
    if (bridge.notch && url.searchParams.get('k') !== bridge.notch.token) {
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return;
    }

    const n = (k) => Number(url.searchParams.get(k));
    if (process.env.PICO_DEBUG) {
      console.log(`[notch/size] ${url.search}`);
    }
    if (bridge.notch) {
      bridge.notch.learnFrame({ iw: n('iw'), ih: n('ih'), ow: n('ow'), oh: n('oh') });
      if (Number.isFinite(n('w')) && Number.isFinite(n('h'))) {
        bridge.notch.morph({ width: n('w'), height: n('h') });
      }
    }

    res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    return;
  }

  // Pairing QR, rendered server-side so the laptop can show it anywhere.
  if (url.pathname === '/pair.svg') {
    const svg = toSVG(encode(pairingUrl()), { size: 260 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }

  if (url.pathname === '/pair.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ url: pairingUrl(), code: bridge.pairCode }));
    return;
  }

  // Redirect the root to the phone app rather than serving it in place: the
  // page uses relative URLs, so serving phone/index.html at "/" would resolve
  // its CSS, script and manifest against the wrong directory. The QR's #p=
  // fragment survives the redirect.
  if (url.pathname === '/') {
    res.writeHead(302, { Location: `/phone/${url.search}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';

  const path = join(ROOT, normalize(rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  try {
    const info = await stat(path);
    if (info.isDirectory()) { res.writeHead(404).end('Not found'); return; }
    let body = await readFile(path);

    // Mark pages served by the bridge so the UI picks the WebSocket transport
    // instead of its in-page mock. Keeps one build working in both places.
    if (extname(path).toLowerCase() === '.html') {
      body = Buffer.from(
        body.toString('utf8').replace('<html lang="en">', '<html lang="en" data-pico-bridge="true">'),
        'utf8',
      );
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  const ip = req.socket.remoteAddress || '';
  if (!isPrivateAddress(ip)) { socket.destroy(); return; }

  const conn = upgrade(req, socket, head);
  if (!conn) return;

  const local = /^(127\.0\.0\.1|::1)$/.test(ip.replace(/^::ffff:/, ''));
  const client = { conn, ip: ip.replace(/^::ffff:/, ''), paired: local, local };
  bridge.clients.add(client);

  // Anyone on the laptop itself already has full control of it, so the
  // laptop's own UI connects without a pairing code. Only remote (phone)
  // clients have to pair.
  if (local) {
    conn.sendJSON({ type: 'paired', payload: { ok: true, token: null, name: 'this laptop' } });
    bridge.replay(client);
  }

  conn.on('message', (raw) => bridge.handleMessage(client, raw));
  conn.on('close', () => bridge.clients.delete(client));
  conn.on('error', () => bridge.clients.delete(client));

  // A client has a short window to pair before it is dropped.
  setTimeout(() => { if (!client.paired) conn.close(1008, 'not paired'); }, 30_000);
});

const host = lanAddress();
const pairingUrl = () => `http://${host}:${PORT}/#p=${bridge.pairCode}`;

// Real desktop control is optional: on a platform that cannot be driven, or
// during local development, Pico still talks — it just says plainly that it
// cannot work rather than running a stand-in that looks like success.
//
// Pointer positions are broadcast as they happen so the interface can draw
// where Pico's cursor actually is. Windows has one system pointer and this
// is it; there is nothing to interpolate or guess. Throttled to about 30 a
// second, which is smooth to watch and cheap to send.
let lastPointer = 0;
let lastDrawn = 0;
const computer = await loadComputer({
  onPointer: ({ x, y, done }) => {
    const now = Date.now();

    // Something is really moving the pointer, so now it goes off screen —
    // and not a moment before. A run made entirely of presses through the
    // accessibility layer never reaches this line, and the user's cursor
    // stays visible and theirs throughout while Pico's works alongside it.
    if (cursorShown && !pointerTaken) {
      pointerTaken = true;
      islandHost?.cursorHide();
      if (process.env.PICO_DEBUG) console.log('[cursor] taking the pointer');
    }
    ghost = { x, y };

    // Two rates, because these two consumers want different things. The
    // cursor drawn on screen is the one the user is watching, so it gets
    // every frame it can use (~60 a second) — a cursor updated at 30Hz
    // visibly steps. The remote clients are watching a diagram of where
    // Pico is, and 30 a second is plenty for that and half the traffic.
    if (done || now - lastDrawn >= 15) {
      lastDrawn = now;
      islandHost?.cursorAt(x, y);
    }
    if (!done && now - lastPointer < 33) return;
    lastPointer = now;
    bridge.broadcast({ type: 'cursor', payload: { x, y, done } });
  },
});
/* Put the pointer back where the user left it. The driver calls this the
   moment it has finished looking at the screen, so across a whole run the
   pointer is only away from where they left it for the fraction of a second
   an action takes — and it is invisible for that. */
if (computer) computer.park = () => { if (pointerTaken) islandHost?.cursorRestore(); };

/* Press a control without the pointer.
   Answers false when it cannot, and the driver then uses the pointer — see
   quietClick in island-host.mjs.

   Pico's own cursor still walks over and presses it, because a thing that
   happens with no visible cause is worse than one you can watch. That walk
   moves nothing but the drawing: the user's pointer stays exactly where it
   is, and for a run made only of these it is never even hidden. */
if (computer) {
  computer.quiet = async ({ x, y, vx, vy }) => {
    if (!islandHost?.ready) return false;
    await walkGhost(vx, vy);
    islandHost.cursorState('clicking');
    const result = await islandHost.quietClick(x, y);
    islandHost.cursorState('moving');
    return result;
  };

  /* Ask the application what is under a point, without pressing it.
     The driver uses this to catch an aim that has landed on the wrong row
     before it commits to the click — see checkTarget in driver.mjs. */
  computer.probe = async ({ x, y }) => {
    if (!islandHost?.ready) return null;
    return islandHost.quietLook(x, y);
  };
}

/**
 * Walk Pico's drawn cursor to a point. Nothing real moves.
 *
 * Sampled by the clock rather than by step count, and short: this is the
 * gesture that says "it is doing that, there", not a journey to sit through.
 */
async function walkGhost(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const from = ghost ?? { x, y };
  const dist = Math.hypot(x - from.x, y - from.y);
  ghost = { x, y };
  if (dist < 4) { islandHost?.cursorAt(x, y); return; }

  /* Faster than it was. This walk is the gesture that says "it is doing that,
     there" — it is not a journey to sit through, and at the old timing a run
     of a dozen clicks spent four seconds of itself watching a mark slide
     across the screen. The trail behind the cursor now does the work of
     making the movement legible, which is what the slow version was really
     for. */
  const ms = Math.max(80, Math.min(210, 55 + (dist * 0.12)));
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms);
    const e = (t ** 3) * (10 - (15 * t) + (6 * t * t));   // minimum jerk, as a hand moves
    islandHost?.cursorAt(from.x + ((x - from.x) * e), from.y + ((y - from.y) * e));
    if (t >= 1) return;
    await new Promise((r) => setTimeout(r, 16));
  }
}
if (computer) await bridge.attachComputer(computer);

/* ---------------------------------------------------------------------------
   The notch

   Its own window, hanging from the top centre of the screen, opened from the
   app. The page measures itself and posts back the size it wants; the window
   springs to it (see notch-window.mjs).
   -------------------------------------------------------------------------*/
islandHost = await IslandHost.start();

bridge.notch = new NotchWindow({
  url: `http://localhost:${PORT}/pico-ui/notch.html`,
  screenWidth: bridge.screenSize?.width ?? 1920,
  host: islandHost,
});

/* An island can outlive the bridge that opened it — restarting the bridge
   leaves the window on screen, reconnecting happily, but holding a token
   this process has never heard of. Nothing it reports is believed after
   that, so it is stuck at whatever size it happened to be and its content
   is clipped against a frame that will not move again.

   Take it back at startup rather than waiting for the user to notice: the
   island they already had stays where it was, driven by the bridge that is
   actually running. */
if (bridge.notch.findWindow()) {
  try {
    await bridge.notch.open();
    watchIslandHover();
    bridge.broadcast({ type: 'notch', payload: { open: true } });
  } catch (err) {
    console.warn(`[bridge] could not take back the island (${err.message})`);
  }
}

/* The page is told whether the pointer is on it rather than working it out —
   see watchHover in notch-window.mjs for why it cannot work it out. */
function watchIslandHover() {
  bridge.notch.watchHover((over, where) => {
    if (process.env.PICO_DEBUG) console.log(`[hover] ${over ? 'on ' : 'off'} ${where}`);
    bridge.broadcast({ type: 'notchHover', payload: { over } });
  });
}

bridge.onNotchCommand = async (command) => {
  if (command === 'closeNotch') {
    await bridge.notch.close();
    bridge.broadcast({ type: 'notch', payload: { open: false } });
    return;
  }
  const result = await bridge.notch.open();
  if (!result.ok) {
    bridge._fromHost('error', {
      title: 'The notch could not open',
      message: result.error,
      recoverable: true,
    });
    return;
  }
  watchIslandHover();
  bridge.broadcast({ type: 'notch', payload: { open: true } });
};


// Model provider is optional: without a key the bridge still runs the
// scripted scenarios, so the UI is always demonstrable.
const llm = await LLM.fromEnv();
if (llm) {
  const status = await llm.check();
  if (status.ok) {
    bridge.attachLLM(llm);
    const label = PROVIDERS[llm.provider]?.label ?? llm.provider;
    console.log(`[bridge] ${label}: ${llm.tiers.fast} (fast) / ${llm.tiers.hard} (hard)`);
  } else {
    console.warn(`[bridge] model provider unavailable (${status.reason}); using scripted scenarios`);
  }
} else {
  console.log('[bridge] no API key in .env - add OPENAI_API_KEY to use a model; running scripted scenarios');
}

// Failing to bind is not a recoverable bug for the crash guard above to
// swallow: without the port there is no bridge, and a process that stays
// alive anyway just looks like Pico is running when it is not.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Pico is probably already running.`);
    console.error('  Close the other Pico window, or set PICO_BRIDGE_PORT to use another port.\n');
  } else {
    console.error('[bridge] server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log(`  Pico bridge is running${BUILD.sha ? `  (build ${BUILD.sha})` : ''}`);
  console.log(line);
  console.log(`\n  Phone:   ${pairingUrl()}`);
  console.log(`  Code:    ${bridge.pairCode}`);
  console.log(`  Desktop: http://localhost:${PORT}/pico-ui/app.html\n`);
  console.log(toTerminal(encode(pairingUrl())));
  console.log('  Scan with your phone camera, on the same Wi-Fi.');
  console.log('  Local network only — nothing is exposed to the internet.\n');
});
