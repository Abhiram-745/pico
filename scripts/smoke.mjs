#!/usr/bin/env node
/* ==========================================================================
   Talk to a running bridge exactly the way the interface does, and print
   every event that comes back.

   This is how the chat-or-work fork is checked against the real thing rather
   than against a description of it: send "hello", watch nothing happen to the
   desktop; send "open notepad", watch the phases and actions go by.

   Usage:
     node scripts/smoke.mjs "hello"
     node scripts/smoke.mjs --mode=agent "open notepad"
     node scripts/smoke.mjs --wait=90 "search the web for otters"
   ========================================================================== */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const text = args.filter((a) => !a.startsWith('--')).join(' ') || 'hello';
const mode = opt('mode', 'auto');
const waitMs = Number(opt('wait', '25')) * 1000;
const port = Number(opt('port', '4177'));
// --send=openNotch sends a bare command instead of a message.
const command = opt('send', null);

const t0 = Date.now();
const at = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`;

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let lastMessageId = null;
let cursorCount = 0;
let sent = false;

ws.addEventListener('open', () => {
  console.log(`${at()}  connected`);
  ws.send(JSON.stringify({ command: 'pair' }));
});

ws.addEventListener('message', (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  const { type, payload = {} } = msg;

  switch (type) {
    case 'paired':
      // A loopback client is paired on connect and then acknowledged again
      // when it sends the handshake anyway, so this arrives twice. Submitting
      // on each would run the task twice.
      if (sent) break;
      sent = true;
      if (command) {
        console.log(`${at()}  paired, sending command: ${command}`);
        ws.send(JSON.stringify({ command, payload: {} }));
        break;
      }
      console.log(`${at()}  paired, sending: ${JSON.stringify(text)} (mode=${mode})`);
      ws.send(JSON.stringify({ command: 'submitTask', payload: { text, mode } }));
      break;

    case 'routed':
      console.log(`${at()}  ROUTED -> ${payload.mode.toUpperCase()}  (${payload.why}, by ${payload.source})`);
      break;

    case 'message':
      // Streamed replies arrive many times; print the growth, not every frame.
      if (payload.id !== lastMessageId) {
        lastMessageId = payload.id;
        console.log(`${at()}  message [${payload.from ?? 'pico'}] starts`);
      }
      if (payload.done) console.log(`${at()}  message done: ${JSON.stringify(payload.text)}`);
      break;

    case 'phase':
      console.log(`${at()}  phase: ${payload.phase}`);
      break;

    case 'action':
      console.log(`${at()}    action ${payload.type}: ${payload.detail ?? ''}`);
      break;

    case 'cursor':
      cursorCount += 1;
      if (payload.done) console.log(`${at()}    pointer -> ${payload.x},${payload.y} (${cursorCount} steps)`);
      break;

    case 'approval':
      console.log(`${at()}  APPROVAL: ${payload.summary} [${payload.risk.level}/${payload.risk.categories}]`);
      console.log(`${at()}            ${payload.risk.reason}`);
      console.log(`${at()}            -> approving`);
      ws.send(JSON.stringify({ command: 'approve', payload: { id: payload.id } }));
      break;

    case 'takeover':
      console.log(`${at()}  HANDOVER: ${payload.reason}`);
      break;

    case 'summary':
      console.log(`${at()}  summary: ${payload.text}`);
      break;

    case 'error':
      console.log(`${at()}  ERROR: ${payload.title} — ${payload.message}`);
      break;

    case 'guardian':
      console.log(`${at()}  guardian: canAct=${payload.canAct} screen=${JSON.stringify(payload.screen)}` +
        `${payload.reason ? ` reason="${payload.reason}"` : ''}`);
      break;

    case 'settings':
      console.log(`${at()}  settings: model=${payload.model} hasKey=${payload.hasApiKey}`);
      break;

    default:
      break;   // auditEvent and friends are noise here
  }
});

ws.addEventListener('error', (e) => {
  console.error('socket error:', e.message ?? e);
  process.exit(1);
});

setTimeout(() => {
  console.log(`${at()}  done watching`);
  ws.close();
  process.exit(0);
}, waitMs);
