#!/usr/bin/env node
/* ==========================================================================
   What a message may carry: pasted text, files and pictures, checked on the
   way in (bridge/attachments.mjs), and the socket that has to bring a message
   that size in at all (bridge/ws.mjs). No desktop, no port.

   Run with: node scripts/test-attachments.mjs
   ========================================================================== */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  validateAttachments, attachmentEcho, prepareSubmitTask, MAX_ATTACHMENTS, MAX_SUBMIT_TEXT_LENGTH, MAX_IMAGE_ATTACHMENT_BYTES,
} from '../bridge/attachments.mjs';
import { decodeImageDataUrl, MAX_CLIPBOARD_IMAGE_BYTES } from '../bridge/clipboard-image.mjs';
import { WebSocketConnection } from '../bridge/ws.mjs';

// Every refusal below is logged once, on purpose; not while testing.
console.warn = () => {};

const png = `data:image/png;base64,${Buffer.alloc(300, 7).toString('base64')}`;
const text = { id: 'a1', name: 'table.md', kind: 'text', mime: 'text/markdown', size: 12, text: '| 1 | a fox |' };
const image = { id: 'a2', name: 'fox.png', kind: 'image', mime: 'image/png', size: 300, dataUrl: png, thumb: png };

/* --- what is let in ----------------------------------------------------- */
assert.deepEqual(validateAttachments(null), [], 'nothing attached');
assert.equal(validateAttachments([text, image]).length, 2);
assert.equal(validateAttachments(Array(9).fill(text)).length, MAX_ATTACHMENTS, 'capped at six');
assert.equal(validateAttachments([{ ...text, kind: 'pdf' }]).length, 0, 'an unknown kind is dropped');
assert.equal(validateAttachments([{ ...text, text: 42 }]).length, 0, 'text with no text is dropped');
assert.equal(validateAttachments([{ ...image, dataUrl: 'data:text/html;base64,PGI+' }]).length, 0, 'only a picture is a picture');
assert.equal(validateAttachments([{ ...image, dataUrl: `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}` }]).length, 0, 'over 8MB decoded');
assert.match(validateAttachments([{ ...text, id: 'no spaces allowed' }])[0].id, /^att_/, 'a bad id is replaced');

/* --- what the thread and the archive keep -------------------------------- */
const echoed = attachmentEcho(validateAttachments([image])[0]);
assert.equal(echoed.dataUrl, undefined, 'the picture itself is never echoed');
assert.equal(echoed.thumb, png);
const echoedText = attachmentEcho({ ...text, text: 'x'.repeat(1000) });
assert.equal(echoedText.text, undefined, 'nor the whole text');
assert.equal(echoedText.chars, 1000);
assert.equal(echoedText.preview.length, 240);

/* --- a message --------------------------------------------------------- */
assert.equal(prepareSubmitTask({ text: '   ' }), null, 'nothing said, nothing attached');
assert.equal(prepareSubmitTask({ text: '', attachments: [image] }).attachments.length, 1, 'a picture alone is a message');
assert.equal(prepareSubmitTask({ text: 'x'.repeat(MAX_SUBMIT_TEXT_LENGTH + 50) }).text.length, MAX_SUBMIT_TEXT_LENGTH, 'long, but capped');
assert.equal(prepareSubmitTask({ text: 'hi', mode: 'nonsense' }).mode, 'auto');

/* --- a picture let in is a picture that can be pasted ----------------------
   A picture is checked on the way in (above), by the shape of its data URL,
   and again on the way out to the clipboard (bridge/clipboard-image.mjs),
   by its bytes, since that is where a wrong one would do harm. The two have
   to agree about every real picture, and the way in must never let one
   through that is too big to paste. */
{
  const real = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARgAGAQJ/3ZBTTwAAAABJRU5ErkJggg==';
  const [letIn] = validateAttachments([{ ...image, dataUrl: real }]);
  assert.equal(letIn?.dataUrl, real, 'a real PNG is let in whole');
  assert.equal(decodeImageDataUrl(letIn.dataUrl)?.type, 'png', 'and can be put on the clipboard as one');
  assert.ok(MAX_IMAGE_ATTACHMENT_BYTES <= MAX_CLIPBOARD_IMAGE_BYTES, 'nothing let in is too big to paste');
  assert.equal(validateAttachments([image]).length, 1, 'three hundred bytes of 7s pass the shape check on the way in…');
  assert.equal(decodeImageDataUrl(image.dataUrl), null, '…and are never put on the clipboard as a PNG');
}

/* --- the socket: a big message, arriving in pieces ------------------------ */
function frame(body, { fin = true, op = 1 } = {}) {
  const p = Buffer.from(body, 'utf8');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let head;
  if (p.length < 126) head = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  const masked = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}
const socket = Object.assign(new EventEmitter(), { write() {}, destroy() {}, destroyed: false });
const conn = new WebSocketConnection(socket);
const got = [];
conn.on('message', (m) => got.push(m));

socket.emit('data', Buffer.concat([frame('one'), frame('two')]));             // two in one read
const big = JSON.stringify({ command: 'submitTask', payload: { text: 'go', attachments: [{ ...image, dataUrl: `data:image/png;base64,${'Q'.repeat(3_000_000)}` }] } });
const bigFrame = frame(big);
for (let i = 0; i < bigFrame.length; i += 16 * 1024) socket.emit('data', bigFrame.subarray(i, i + 16 * 1024));
const split = frame('a header split over three reads');
socket.emit('data', split.subarray(0, 1));
socket.emit('data', split.subarray(1, 3));
socket.emit('data', split.subarray(3));
socket.emit('data', Buffer.concat([frame('ab', { fin: false }), frame('cd', { fin: false, op: 0 }), frame('ef', { op: 0 })]));

assert.deepEqual(got.slice(0, 2), ['one', 'two']);
assert.equal(got[2], big, 'three megabytes in sixteen-kilobyte pieces, whole');
assert.equal(got[3], 'a header split over three reads');
assert.equal(got[4], 'abcdef', 'fragments joined');
conn.close();

console.log('attachments: all passed');
process.exit(0);
