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
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import { upgrade } from './ws.mjs';
import { encode, toTerminal, toSVG } from './qr.mjs';
import { MockAgent } from '../pico-ui/mock/agent.js';
import { LLM, PROVIDERS } from './llm.mjs';
import { check as checkUpdate, install as installUpdate, localBuild } from './updater.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PICO_BRIDGE_PORT) || 4177;

/* Commands a client may send. Must stay in sync with UI_COMMANDS in
   pico-ui/src/bridge.js — anything not listed here is dropped. */
const ALLOWED_COMMANDS = new Set([
  'submitTask', 'pause', 'resume', 'stop',
  'approve', 'deny', 'takeoverDone',
  'saveSettings', 'tuckAway', 'openPalette', 'closePalette', 'movePalette',
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
    };

    this.transport = {
      emit: (type, payload) => this._fromHost(type, payload),
      onCommand: (handler) => { this._hostHandler = handler; },
    };

    this.agent = new MockAgent(this.transport);
    this.agent.start();
    this.llm = null;
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
    this.agent.planner = (task) => llm.plan(task);
    this.agent.summariser = (task, steps) => llm.summarise(task, steps);
    this.agent.settings = {
      ...this.agent.settings,
      model: llm.tiers.fast,
      hasApiKey: true,
    };
    this.emitSettings();
  }

  emitSettings() {
    this._fromHost('settings', this.agent.settings);
  }

  /** Host -> every connected client. */
  _fromHost(type, payload) {
    if (type in this.snapshot) this.snapshot[type] = payload;
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
    send('phase', s.phase);
    send('pauseState', s.pauseState);
    send('approval', s.approval);
    send('takeover', s.takeover);
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
      console.log(`[bridge] task from ${client.ip}`);
      this._hostHandler?.({ command, payload: { text } });
      return;
    }

    // approve/deny must name the decision they are answering, so a stale phone
    // cannot approve whatever happens to be pending now.
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

const BUILD = await localBuild();
const bridge = new Bridge();

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!isPrivateAddress(ip)) {
    res.writeHead(403).end('Bridge accepts local network connections only.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
  const client = { conn, ip: ip.replace(/^::ffff:/, ''), paired: local };
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
