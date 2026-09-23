/* ==========================================================================
   Minimal RFC 6455 WebSocket server.

   Written by hand so the bridge has zero npm dependencies — it has to be
   runnable from a release zip with nothing but Node installed, and a remote
   control surface is the last place you want an unaudited dependency tree.

   Supports what the bridge actually needs: text frames, ping/pong, close,
   fragmentation, and client-masked payloads. No permessage-deflate.
   ========================================================================== */

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xa,
};

/* A single frame's payload used to be capped well below anything legitimate:
   the phone sent short JSON commands, and anything larger was either a bug
   or an attempt to exhaust memory. A message can now carry an attachment —
   pasted text, a file, a picture (see bridge/attachments.mjs) — up to 6 of
   them, each an image at most 8MB decoded. 32MB leaves comfortable headroom
   for that whole payload once base64 and JSON overhead are added, while
   still refusing a frame built only to exhaust memory. */
const MAX_MESSAGE = 32 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.id = randomBytes(8).toString('hex');

    // Bytes read off the socket, not yet enough to make a whole frame.
    // Buffered as a list of chunks rather than one growing Buffer — see
    // _readFrame and _take for why: a large message can arrive as hundreds
    // of small TCP reads, and re-concatenating everything seen so far on
    // every single one of them is quadratic in the chunk count.
    this._chunks = [];
    this._chunksLen = 0;
    this._fragments = [];
    this._fragmentsLen = 0;
    this._fragmentOp = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', (err) => { this.emit('error', err); this._closed(); });

    // Drop half-open connections rather than leaking sockets.
    this._alive = true;
    this._heartbeat = setInterval(() => {
      if (!this.open) return;
      if (!this._alive) { this.close(1001, 'timeout'); return; }
      this._alive = false;
      this.ping();
    }, 30_000);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this._heartbeat);
    this.emit('close');
  }

  _onData(chunk) {
    // A connection already closed — too large, unmasked, gone — reads no
    // further: what is still arriving is the rest of the frame it refused.
    if (!this.open) { this._chunks = []; this._chunksLen = 0; return; }
    this._chunks.push(chunk);
    this._chunksLen += chunk.length;

    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) { this._chunks = []; this._chunksLen = 0; return; }
    }
  }

  /** The first `n` buffered bytes (fewer when fewer are here), left in place. */
  _head(n) {
    const out = Buffer.allocUnsafe(Math.min(n, this._chunksLen));
    let filled = 0;
    for (const c of this._chunks) {
      if (filled >= out.length) break;
      filled += c.copy(out, filled, 0, Math.min(c.length, out.length - filled));
    }
    return out;
  }

  /* The next `n` buffered bytes, removed from the buffer. Each byte is
     copied at most once, when its whole frame is here — never again on every
     later read, which is what one growing Buffer.concat per TCP read did: a
     24MB picture arriving in 64KB pieces meant hundreds of copies of
     everything that had arrived so far. */
  _take(n) {
    if (n <= 0) return Buffer.alloc(0);
    const first = this._chunks[0];
    if (first.length >= n) {
      if (first.length === n) this._chunks.shift();
      else this._chunks[0] = first.subarray(n);
      this._chunksLen -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this._chunks[0];
      const need = n - filled;
      if (c.length <= need) {
        c.copy(out, filled);
        filled += c.length;
        this._chunks.shift();
      } else {
        c.copy(out, filled, 0, need);
        this._chunks[0] = c.subarray(need);
        filled += need;
      }
    }
    this._chunksLen -= n;
    return out;
  }

  /** Returns a frame, or null when more bytes are needed. */
  _readFrame() {
    if (this._chunksLen < 2) return null;
    // The longest header there is: 2 bytes, 8 of length, 4 of mask.
    const b = this._head(14);

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'too large'); return null; }
      len = Number(big);
      offset += 8;
    }

    if (len > MAX_MESSAGE) { this.close(1009, 'too large'); return null; }

    // RFC 6455 §5.1: every client frame must be masked.
    if (!masked) { this.close(1002, 'unmasked frame'); return null; }

    if (this._chunksLen < offset + 4 + len) return null;
    const mask = Buffer.from(b.subarray(offset, offset + 4));
    this._take(offset + 4);

    const data = this._take(len);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = data[i] ^ mask[i & 3];
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this._send(OP.PONG, payload);
        return;

      case OP.PONG:
        this._alive = true;
        return;

      case OP.CLOSE:
        this.close(1000, '');
        return;

      case OP.TEXT:
      case OP.BINARY:
        if (fin) { this._deliver(opcode, payload); return; }
        this._fragmentOp = opcode;
        this._fragments = [payload];
        this._fragmentsLen = payload.length;
        return;

      case OP.CONT: {
        // A continuation with no message begun is a protocol error, not the
        // first piece of one.
        if (this._fragmentOp === null) { this.close(1002, 'unexpected continuation'); return; }
        this._fragments.push(payload);
        this._fragmentsLen += payload.length;
        if (this._fragmentsLen > MAX_MESSAGE) { this.close(1009, 'too large'); return; }
        if (!fin) return;
        const full = Buffer.concat(this._fragments, this._fragmentsLen);
        const op = this._fragmentOp;
        this._fragments = [];
        this._fragmentsLen = 0;
        this._fragmentOp = null;
        this._deliver(op, full);
        return;
      }

      default:
        this.close(1002, 'bad opcode');
    }
  }

  _deliver(opcode, payload) {
    this._alive = true;
    if (opcode !== OP.TEXT) return;      // the bridge is text-only
    this.emit('message', payload.toString('utf8'));
  }

  _send(opcode, payload = Buffer.alloc(0)) {
    if (!this.open || this.socket.destroyed) return;

    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;   // FIN + opcode; server frames are unmasked

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._closed();
    }
  }

  send(text) {
    this._send(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    this._send(OP.PING);
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._send(OP.CLOSE, payload);
    this.open = false;
    clearInterval(this._heartbeat);
    // Give the close frame a moment to flush.
    setTimeout(() => this.socket.destroy(), 60);
    this.emit('close');
  }
}

/**
 * Complete the HTTP upgrade handshake.
 * @returns {WebSocketConnection|null}
 */
export function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];

  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }

  const accept = createHash('sha1').update(key + GUID).digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  socket.setNoDelay(true);
  const conn = new WebSocketConnection(socket);
  if (head?.length) conn._onData(head);
  return conn;
}
