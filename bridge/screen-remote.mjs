/* ==========================================================================
   Halo — the screen, as seen from the bridge's own thread.

   Same surface as Screen (screen.mjs), with the expensive half happening in
   screen-worker.mjs. Everything that returns to this thread is either a
   number or a buffer that was handed over rather than copied, and the only
   work done here is the arithmetic between a picture coordinate, a physical
   pixel and the unit the mouse takes.

   If the worker cannot start — an old Node, a machine where the capture
   module will not load off the main thread — this falls back to doing it
   here, exactly as before. Slower, and still correct.

   ONE AT A TIME
   Two captures at once would grab the same desktop twice and cost double for
   one answer, so a request that arrives while another is in flight waits for
   it. `frame()` deliberately does not share a capture's result: it is used
   to measure a scroll, and a frame from before the scroll is not a
   measurement of anything.
   ========================================================================== */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Screen, shotFrom } from './screen.mjs';

const WORKER = fileURLToPath(new URL('screen-worker.mjs', import.meta.url));

export class RemoteScreen {
  constructor(worker, info) {
    this.worker = worker;
    this.mode = info.mode;
    this.scale = info.scale;
    this.bounds = info.bounds;
    this.seq = 0;
    this.pending = new Map();
    this.inflight = null;

    worker.on('message', (msg) => {
      const settle = this.pending.get(msg.id);
      if (!settle) return;
      this.pending.delete(msg.id);
      settle(msg);
    });
    worker.on('error', (err) => this.failAll(err));
    worker.on('exit', () => this.failAll(new Error('the screen worker stopped')));
  }

  failAll(err) {
    this.dead = err;
    for (const settle of this.pending.values()) settle({ ok: false, error: String(err.message || err) });
    this.pending.clear();
  }

  /**
   * Start the worker, or resolve null when it cannot be had — the caller
   * then uses Screen directly.
   */
  static async start() {
    let worker;
    try {
      worker = new Worker(WORKER);
    } catch {
      return null;
    }
    try {
      const info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the screen worker did not answer')), 20_000);
        worker.once('error', (err) => { clearTimeout(timer); reject(err); });
        worker.once('message', (msg) => {
          clearTimeout(timer);
          if (msg.ok) resolve(msg.value); else reject(new Error(msg.error));
        });
        worker.postMessage({ id: 0, op: 'detect' });
      });
      worker.unref();
      return new RemoteScreen(worker, info);
    } catch (err) {
      try { await worker.terminate(); } catch { /* already gone */ }
      console.warn(`[bridge] the screen worker could not start (${err.message}); capturing on the main thread`);
      return null;
    }
  }

  ask(op, opts) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.ok ? resolve(msg.value) : reject(new Error(msg.error))));
      this.worker.postMessage({ id, op, opts });
    });
  }

  /** Detected at start-up; kept so this can stand in for Screen. */
  async detect() { return { mode: this.mode, scale: this.scale, width: this.bounds.width * this.scale, height: this.bounds.height * this.scale }; }

  async rawDesktop() {
    const v = await this.ask('raw');
    return { data: Buffer.from(v.raw.buffer, v.raw.byteOffset, v.raw.byteLength), width: v.width, height: v.height, scale: v.scale, originX: v.originX, originY: v.originY, mouseScale: v.mouseScale };
  }

  async capture(opts = {}) {
    /* A capture already on its way is the same answer this caller wants. A
       `raw` handed in is a frame someone already has, and re-grabbing the
       desktop for it would be measuring a different moment. */
    if (opts.raw) return this.local(opts);
    if (this.inflight) return this.inflight;
    this.inflight = this.ask('capture', { width: opts.width ?? null, quality: opts.quality ?? 80 })
      .then((v) => {
        const desktop = {
          data: Buffer.from(v.raw.buffer, v.raw.byteOffset, v.raw.byteLength),
          width: v.width,
          height: v.height,
          scale: v.scale,
          originX: v.originX,
          originY: v.originY,
          mouseScale: v.mouseScale,
        };
        return shotFrom(
          { b64: v.b64, bytes: v.bytes, grey: Buffer.from(v.grey.buffer, v.grey.byteOffset, v.grey.byteLength), shotW: v.shotW, shotH: v.shotH },
          desktop,
          v.mode,
        );
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Encoding a frame this thread already holds: nothing to grab, so it is
      done here rather than shipped across and back. */
  async local(opts) {
    this.fallback = this.fallback ?? (async () => {
      const s = new Screen();
      await s.detect();
      return s;
    })();
    return (await this.fallback).capture(opts);
  }

  stop() { this.worker.terminate().catch(() => {}); }
}
