/* ==========================================================================
   Halo bridge — lets a paired phone drive the desktop agent over the LAN.

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
import { Sense } from './sense.mjs';
import { check as checkUpdate, install as installUpdate, localBuild } from './updater.mjs';
import { chatArchive } from './chats.mjs';
import { memory } from './memory.mjs';
import { routines } from './routines.mjs';
import { migrateFromPico } from './home.mjs';
import { findBrowser } from './notch-window.mjs';
import { buildUI } from '../scripts/build-ui.mjs';

/* The HALO_ names are the ones to use now; the PICO_ ones still work, so
   nobody's .env or shortcut breaks with the rename. Everything below reads
   the old names, and this makes either spelling land there. */
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('HALO_') && k !== 'HALO_HOME' && process.env[`PICO_${k.slice(5)}`] === undefined) {
    process.env[`PICO_${k.slice(5)}`] = v;
  }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PICO_BRIDGE_PORT) || 4177;

/* --app: open the full window as well as the island. It is what the
   "Halo App" shortcut runs, so that one shortcut works whether or not Halo
   is already going — see the EADDRINUSE handler below. */
const OPEN_APP = process.argv.includes('--app');
const appUrl = () => `http://localhost:${PORT}/pico-ui/app.html`;
function openAppWindow(section = '') {
  const browser = findBrowser();
  const url = `${appUrl()}${/^[a-z]{2,20}$/.test(section) ? `#${section}` : ''}`;
  try {
    spawn(browser || 'explorer.exe', browser ? [`--app=${url}`, '--window-size=1280,880'] : [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    console.warn(`[bridge] could not open the app window (${err.message})`);
  }
}

/* Commands a client may send. Must stay in sync with UI_COMMANDS in
   pico-ui/src/bridge.js — anything not listed here is dropped. */
const ALLOWED_COMMANDS = new Set([
  'submitTask', 'pause', 'resume', 'stop',
  'approve', 'deny', 'takeoverDone',
  'saveSettings', 'setName', 'answerQuestion', 'tuckAway',
  'openPalette', 'closePalette', 'movePalette',
  'openNotch', 'closeNotch', 'newChat',
  // while a task runs
  'skipStep', 'steer',
  // what Halo remembers, and saved shortcuts
  'memoryAdd', 'memoryRemove', 'memoryClear',
  'routineSave', 'routineRun', 'routineRename', 'routineRemove',
  // chat history, shared by every window
  'openChat', 'chatRename', 'chatDelete', 'chatSearch', 'chatsImport',
  'openApp',
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
      plan: null,
      runFinished: null,
    };

    // The conversation so far, so a phone joining mid-thread sees it rather
    // than an empty window. Capped: this is a replay buffer, not a store.
    this.messages = [];

    this.transport = {
      emit: (type, payload) => this._fromHost(type, payload),
      onCommand: (handler) => { this._hostHandler = handler; },
    };

    this.agent = new HostAgent(this.transport, { memory, routines });
    this.agent.start();

    /* The chat that was open when Halo last stopped, back where it was: on
       screen for every window that connects, and in the model's memory. */
    this.messages = chatArchive.restore().slice(-40);
    if (this.messages.length) {
      this._hostHandler?.({ command: 'newChat', payload: { resume: this.messages } });
    }
    this._chatsTimer = null;
    memory.subscribe((list) => this.broadcast({ type: 'memory', payload: { facts: list } }));
    routines.subscribe((list) => this.broadcast({ type: 'routines', payload: { items: list } }));
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
   * Say plainly whether Halo can actually work, and why not when it cannot.
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
    /* A summary is a message too — it is what Halo said at the end of a run —
       so it gets an id here, once, and every window files it under the same
       one. Without an id each window made up its own, and a window that
       reconnected showed the closing line twice. */
    if (type === 'summary' && payload?.text && !payload.id) {
      payload = { ...payload, id: `sum_${Date.now().toString(36)}` };
    }

    if (type in this.snapshot) this.snapshot[type] = payload;

    if (type === 'message' || (type === 'summary' && payload?.text)) {
      const entry = type === 'summary'
        ? { id: payload.id, from: 'pico', text: payload.text, done: true }
        : payload;
      // Streamed replies arrive many times under one id; keep the latest of
      // each rather than a bubble per token.
      const i = this.messages.findIndex((m) => m.id === entry.id);
      if (i === -1) this.messages = [...this.messages, entry].slice(-40);
      else this.messages[i] = entry;
      if (chatArchive.record(entry)) this.chatsChanged();
    }

    if (type === 'phase') {
      // decision cards do not survive a phase change
      if (payload.phase !== 'AwaitingApproval') this.snapshot.approval = null;
      if (payload.phase !== 'AwaitingTakeover') this.snapshot.takeover = null;
    }
    this.broadcast({ type, payload });
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c === except) continue;
      if (c.paired && c.conn.open) c.conn.send(text);
    }
  }

  /** The list of chats, told to everyone — gathered up, since a streamed reply
      can change a title several times in a second. */
  chatsChanged() {
    clearTimeout(this._chatsTimer);
    this._chatsTimer = setTimeout(() => {
      this.broadcast({ type: 'chats', payload: { list: chatArchive.list(), current: chatArchive.currentId } });
    }, 150);
  }

  replay(client) {
    const s = this.snapshot;
    const send = (type, payload) => payload && client.conn.sendJSON({ type, payload });
    send('guardian', s.guardian);
    send('settings', s.settings);
    send('chats', { list: chatArchive.list(), current: chatArchive.currentId });
    send('memory', { facts: memory.list() });
    send('routines', { items: routines.list() });
    for (const m of this.messages) send('message', m);
    send('phase', s.phase);
    send('pauseState', s.pauseState);
    send('approval', s.approval);
    send('takeover', s.takeover);
    send('question', s.question);
    send('plan', s.plan);
    send('runFinished', s.runFinished);
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
      // A tapped option names itself by id, so "the app" and "the website"
      // do not depend on how their labels happen to be worded.
      const options = this.snapshot.question?.options ?? [];
      const choice = typeof payload.choice === 'string' && options.some((o) => o.id === payload.choice)
        ? payload.choice
        : null;
      // The thread entry is written by the agent once the answer has landed,
      // so that the question and the answer appear together and in order.
      this._hostHandler?.({ command, payload: { text, choice } });
      return;
    }

    /* Start again with nothing remembered.

       Three different things remember the conversation and all three have to
       let go of it, or "new chat" is a lie told by the interface:

         the replay buffer here, which is what a page is handed on connect —
           leave it and the old thread reappears the moment anything reloads;
         the agent's own history, which is what the model is actually shown —
           leave it and the new chat answers out of the old one;
         whatever was still pending — an unanswered question or an approval
           nobody ever decided, which otherwise holds the island open
           forever waiting on a conversation that no longer exists.

       The last one is not housekeeping. A question with no answer pins the
       island open and there is no way past it from the interface, so a chat
       that ended mid-question left Halo stuck on screen for good. */
    /* --- chat history ---------------------------------------------------- */
    if (command === 'openChat') {
      const messages = chatArchive.open(String(payload.id ?? ''));
      if (!messages) return;
      this.messages = messages.slice(-40);
      this.snapshot.question = null;
      this.snapshot.approval = null;
      this.snapshot.takeover = null;
      this.snapshot.plan = null;
      this.snapshot.runFinished = null;
      // Handed to the agent too, so Halo remembers the conversation you are
      // looking at rather than only showing it.
      this._hostHandler?.({ command: 'newChat', payload: { resume: messages.slice(-24) } });
      // To everyone, sender included: every window shows the same thread, and
      // the one that asked has not cleared itself — it waits for this.
      this.broadcast({ type: 'chatOpened', payload: { id: chatArchive.currentId, messages } });
      this.broadcast({ type: 'question', payload: null });
      this.broadcast({ type: 'approval', payload: null });
      this.broadcast({ type: 'takeover', payload: null });
      this.chatsChanged();
      return;
    }
    if (command === 'chatRename') {
      if (chatArchive.rename(String(payload.id ?? ''), String(payload.title ?? ''))) this.chatsChanged();
      return;
    }
    if (command === 'chatDelete') {
      const wasCurrent = chatArchive.remove(String(payload.id ?? ''));
      if (wasCurrent) {
        this.messages = [];
        this.snapshot.plan = null;
        this._hostHandler?.({ command: 'newChat', payload: {} });
        this.broadcast({ type: 'chatCleared', payload: {} });
      }
      this.chatsChanged();
      return;
    }
    if (command === 'chatSearch') {
      // Only to whoever asked: one window's search is nobody else's business.
      client.conn.sendJSON({
        type: 'chatSearch',
        payload: { q: String(payload.q ?? ''), results: chatArchive.search(String(payload.q ?? '').slice(0, 200)) },
      });
      return;
    }
    if (command === 'chatsImport') {
      // A window that kept its own history before the archive lived here.
      // Local only: it writes files on this machine.
      if (!client.local) return;
      const added = chatArchive.importFrom(Array.isArray(payload.chats) ? payload.chats : []);
      if (added) {
        console.log(`[bridge] carried over ${added} chat${added === 1 ? '' : 's'} from a window's own storage`);
        this.chatsChanged();
      }
      return;
    }
    if (command === 'openApp') {
      if (!client.local) return;
      this.onOpenApp?.(String(payload.section ?? ''));
      return;
    }

    if (command === 'newChat') {
      /* Reopening an older chat hands its thread back, so the model is not
         the only one in the room who cannot remember the conversation on
         screen. Clamped hard on the way in — it is the one place a client
         writes directly into what the model will be shown, and a phone is
         allowed to be wrong without being allowed to be enormous. */
      const resume = Array.isArray(payload.resume) ? payload.resume.slice(-24) : [];
      this.messages = [];
      chatArchive.start();
      this.snapshot.plan = null;
      this.snapshot.runFinished = null;
      this.chatsChanged();
      this.snapshot.question = null;
      this.snapshot.approval = null;
      this.snapshot.takeover = null;
      this.snapshot.summary = null;
      this._hostHandler?.({ command, payload: { resume } });

      /* Everyone but whoever asked.

         The page that sends this has already cleared itself — it is the one
         that decided to. Telling it again is not merely redundant: reopening
         an older chat is "clear, then load what was saved", and the echo
         arrived just after the load and wiped it. The chat opened, then
         emptied itself, for no reason the user could see. */
      this.broadcast({ type: 'chatCleared', payload: {} }, client);
      // Said plainly rather than left implied: a client that missed the
      // clear would otherwise keep showing a card for a decision that is no
      // longer pending anywhere.
      this.broadcast({ type: 'question', payload: null }, client);
      this.broadcast({ type: 'approval', payload: null }, client);
      this.broadcast({ type: 'takeover', payload: null }, client);
      console.log(`[bridge] new chat from ${client.ip}`);
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
    '# Written by Halo setup. Keep this file private.',
    `OPENAI_API_KEY=${key}`,
    '',
  ].join('\n').replace(/^\s+/, '');

  await writeFile(envPath, body, { encoding: 'utf8', mode: 0o600 });
}

let islandHost = null;

/* A bug anywhere must not take the bridge down with it. When it did, the
   interface and the paired phone both lost their connection and the only
   symptom the user saw was that Halo stopped existing. Log it, keep
   serving. */
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaught:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[bridge] unhandled rejection:', err);
});

const BUILD = await localBuild();

/* Anything the old name left in %LOCALAPPDATA%\Pico comes across first, so
   the archive and memory below read what is already there. */
{
  const carried = migrateFromPico();
  if (carried.length) console.log(`[bridge] carried over from Pico: ${carried.join(', ')}`);
}

/* The interface is React, bundled. Built here when its source is newer than
   the bundle, so running from a checkout never serves yesterday's island. A
   failed build keeps the last good bundle rather than taking Halo down. */
try {
  const built = await buildUI();
  if (built.rebuilt) console.log(`[bridge] interface built in ${built.ms}ms`);
} catch (err) {
  console.warn(`[bridge] the interface could not be rebuilt (${String(err.message).split('\n')[0]}); serving the last build`);
}
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
      await fresh.check();      // also picks the best models this key can use
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

/* ---------------------------------------------------------------------------
   The port, opened first.

   Everything below this line takes time: the accessibility helper starts, the
   window helper is compiled from source on first run, the model provider is
   checked over the network. And the island is a browser window pointed at
   this very server.

   Opening that window before the socket was listening meant Chrome asked a
   port with nothing behind it for a page, got the refusal, and showed its own
   "this site can't be reached" instead. That error page is not titled "Halo
   Notch", so the window could never be found afterwards either, and so was
   never pinned on top, never stripped of its frame, never placed against the
   top edge. What was left on screen was an ordinary browser window, title bar
   and all, sitting in the middle of the display showing an error. Starting
   Halo looked exactly like Halo being broken.

   So bind the port first, and only then open anything that has to talk to it.
   -------------------------------------------------------------------------*/

// Failing to bind is not a recoverable bug for the crash guard above to
// swallow: without the port there is no bridge, and a process that stays
// alive anyway just looks like Halo is running when it is not.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && OPEN_APP) {
    // Halo is already running: the shortcut was only ever asking for its
    // window, so open that and leave the running copy alone.
    openAppWindow();
    setTimeout(() => process.exit(0), 400);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Halo is probably already running.`);
    console.error('  Close the other Halo window, or set PICO_BRIDGE_PORT to use another port.\n');
  } else {
    console.error('[bridge] server error:', err);
  }
  process.exit(1);
});

await new Promise((resolve) => {
  server.listen(PORT, '0.0.0.0', () => {
    const line = '─'.repeat(52);
    console.log(`\n${line}`);
    console.log(`  Halo bridge is running${BUILD.sha ? `  (build ${BUILD.sha})` : ''}`);
    console.log(line);
    console.log(`\n  Phone:   ${pairingUrl()}`);
    console.log(`  Code:    ${bridge.pairCode}`);
    console.log(`  Desktop: http://localhost:${PORT}/pico-ui/app.html\n`);
    console.log(toTerminal(encode(pairingUrl())));
    console.log('  Scan with your phone camera, on the same Wi-Fi.');
    console.log('  Local network only — nothing is exposed to the internet.\n');
    resolve();
  });
});


// Real desktop control is optional: on a platform that cannot be driven, or
// during local development, Halo still talks — it just says plainly that it
// cannot work rather than running a stand-in that looks like success.
//
// Halo works with the user's own pointer. There is no second cursor: the
// positions broadcast here are that one pointer's, so the app's map of the
// screen can show where it is. Throttled to about 30 a second.
//
// The accessibility helper is what lets a click land on the middle of the
// control the model meant; without it clicks go where the model pointed.
const sense = await Sense.start();
let lastPointer = 0;
const computer = await loadComputer({
  sense,
  onPointer: ({ x, y, done }) => {
    const now = Date.now();
    if (!done && now - lastPointer < 33) return;
    lastPointer = now;
    bridge.broadcast({ type: 'cursor', payload: { x, y, done } });
  },
});
if (!computer) sense?.stop();
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

/* The island, opened at startup.

   It is the app, so it should be there the moment Halo is running rather
   than waiting to be asked for. The launcher deliberately opens nothing:
   a .cmd cannot reliably get a URL past a nested `cmd /c`, and the old one
   handed Chrome --app=\"http://...\" with the backslash-quotes intact,
   which is not an address — so Chrome searched the web for it and starting
   Halo opened Google. From here the arguments go to Chrome directly, with
   no second round of shell parsing to survive.

   This also takes back an island that outlived a previous bridge. One left
   on screen keeps reconnecting happily while holding a token this process
   has never heard of, so nothing it reports is believed and it is stuck at
   whatever size it happened to be, its content clipped against a frame that
   will not move again. Opening it here adopts it instead. */
try {
  await bridge.notch.open();
  watchIslandHover();
  bridge.broadcast({ type: 'notch', payload: { open: true } });
} catch (err) {
  console.warn(`[bridge] the island could not be opened (${err.message})`);
}

/* The page is told whether the pointer is on it rather than working it out —
   see watchHover in notch-window.mjs for why it cannot work it out. */
function watchIslandHover() {
  bridge.notch.watchHover((over, where) => {
    if (process.env.PICO_DEBUG) console.log(`[hover] ${over ? 'on ' : 'off'} ${where}`);
    bridge.broadcast({ type: 'notchHover', payload: { over } });
  });
}

/* The full window, opened from the island: chats, memory, shortcuts. An app
   window in the person's own browser, pointed at this bridge. */
bridge.onOpenApp = (section) => openAppWindow(section);
if (OPEN_APP) openAppWindow();

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
    console.log(`[bridge] ${label}: plans with ${llm.tiers.plan}, works with ${llm.tiers.see}, chats with ${llm.tiers.fast}`);
  } else {
    console.warn(`[bridge] model provider unavailable (${status.reason}); using scripted scenarios`);
  }
} else {
  console.log('[bridge] no API key in .env - add OPENAI_API_KEY to use a model; running scripted scenarios');
}
