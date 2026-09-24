/* Does Pico work at the same time as the person, or instead of them?

   Runs a click, a scroll and a drag through the agent, and watches the real
   mouse the whole time. */
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { findBrowser } from './bridge/notch-window.mjs';

const require = createRequire(import.meta.url);
const m = require('@nut-tree-fork/libnut-win32');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sep = String.fromCharCode(92);
const PAGE = 'file:///' + String(process.env.SP).split(sep).join('/') + '/drag.html';

const find = () => {
  for (const h of m.getWindows()) {
    try { if (String(m.getWindowTitle(h) || '').startsWith('DRAG')) return h; } catch { /* gone */ }
  }
  return null;
};
const titleOf = (h) => { try { return String(m.getWindowTitle(h) || ''); } catch { return ''; } };

let h = find();
if (!h) {
  spawn(findBrowser(), [`--app=${PAGE}`, '--window-position=60,40', '--window-size=980,850'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50 && !h; i++) { await sleep(300); h = find(); }
}
if (!h) { console.log('test page did not open'); process.exit(1); }

function submit(text) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(4177, '127.0.0.1', () => {
      sock.write(['GET /ws HTTP/1.1', 'Host: localhost:4177', 'Upgrade: websocket',
        'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    const frame = (t) => {
      const body = Buffer.from(t);
      const mask = randomBytes(4);
      const head = body.length < 126
        ? Buffer.from([0x81, 0x80 | body.length])
        : Buffer.from([0x81, 0xfe, body.length >> 8, body.length & 255]);
      return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]))]);
    };
    let buf = Buffer.alloc(0);
    let up = false;
    const done = (v) => { try { sock.end(); } catch { /* */ } resolve(v); };
    sock.on('data', (chunk) => {
      if (!up) {
        const i = chunk.indexOf('\r\n\r\n');
        up = true;
        buf = chunk.subarray(i + 4);
        sock.write(frame(JSON.stringify({ command: 'submitTask', payload: { text, mode: 'agent' } })));
      } else buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const t2 = buf.subarray(off, off + len).toString();
        buf = buf.subarray(off + len);
        let msg; try { msg = JSON.parse(t2); } catch { continue; }
        if (msg.type === 'summary' || msg.type === 'error') done(msg);
      }
    });
    sock.on('error', () => done(null));
    setTimeout(() => done(null), 90000);
  });
}

const jobs = [
  ['scroll', 'scroll down the page'],
  ['drag', 'drag the slider handle to the right'],
];

let still = 0;
for (const [label, task] of jobs) {
  m.focusWindow(h);
  await sleep(500);
  m.moveMouse(1750, 300);
  await sleep(300);
  const home = m.getMousePos();
  let drift = 0;
  const watch = setInterval(() => {
    const p = m.getMousePos();
    drift = Math.max(drift, Math.abs(p.x - home.x) + Math.abs(p.y - home.y));
  }, 60);

  const before = titleOf(h);
  await submit(task);
  clearInterval(watch);
  await sleep(800);
  const after = titleOf(h);

  const changed = after !== before;
  if (drift <= 3) still += 1;
  console.log(`${label.padEnd(7)} ${changed ? 'WORKED' : 'no change'}   ${before.replace('DRAG ', '')} -> ${after.replace('DRAG ', '')}`);
  console.log(`        mouse ${drift <= 3 ? 'NEVER MOVED' : `moved ${drift}px`}`);
}
console.log(`\n${still}/${jobs.length} with the mouse never moving`);
