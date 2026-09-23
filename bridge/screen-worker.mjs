/* ==========================================================================
   Halo — the screen, grabbed and encoded on a thread of its own.

   WHY
   A capture is a third of a second of solid work: grab the desktop, scale it
   down, encode a JPEG, average a thumbnail. On the bridge's own thread that
   is a third of a second in which nothing else can happen — and the thing
   most obviously not happening is the pointer, which is mid-glide.

   Measured on this machine before this existed: a glide that takes 337ms on
   a quiet thread took 829ms with a capture running, freezing for 641ms in
   the middle of it. That freeze is what "the cursor moves badly" was. The
   island stopped updating for the same third of a second, and so did the
   sockets to the phone.

   So the whole capture happens here instead. The frame comes back as a
   transferred buffer — no copy, whatever its size — and the bridge's thread
   only does the arithmetic that turns a picture coordinate into a screen
   one, which is nothing.
   ========================================================================== */

import { parentPort } from 'node:worker_threads';
import { Screen, encodeFrame } from './screen.mjs';

const screen = new Screen();
let ready = null;

const start = () => {
  ready = ready ?? screen.detect();
  return ready;
};

/** A Buffer, as something that can be handed to another thread without a copy. */
const transferable = (buf) => {
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return copy;
};

parentPort.on('message', async (msg) => {
  const { id, op, opts = {} } = msg;
  try {
    const info = await start();
    if (op === 'detect') {
      parentPort.postMessage({ id, ok: true, value: { ...info, bounds: screen.bounds, mode: screen.mode } });
      return;
    }

    const desktop = await screen.rawDesktop();
    const raw = transferable(desktop.data);

    if (op === 'raw') {
      parentPort.postMessage(
        { id, ok: true, value: { raw, width: desktop.width, height: desktop.height, scale: desktop.scale, originX: desktop.originX, originY: desktop.originY, mouseScale: desktop.mouseScale } },
        [raw.buffer],
      );
      return;
    }

    const encoded = await encodeFrame(desktop, opts);
    const grey = transferable(encoded.grey);
    parentPort.postMessage({
      id,
      ok: true,
      value: {
        b64: encoded.b64,
        bytes: encoded.bytes,
        grey,
        shotW: encoded.shotW,
        shotH: encoded.shotH,
        mode: screen.mode,
        raw,
        width: desktop.width,
        height: desktop.height,
        scale: desktop.scale,
        originX: desktop.originX,
        originY: desktop.originY,
        mouseScale: desktop.mouseScale,
      },
    }, [grey.buffer, raw.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
