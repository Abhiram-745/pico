/* ==========================================================================
   Pico — seeing the screen.

   A desktop agent that cannot look at the desktop is not an agent, so this
   module has two independent ways to produce a picture of it and prefers
   whichever works on the machine it lands on.

     1. Monitor capture. One call, the whole display, correct everywhere it
        is supported.
     2. Window compositing. Every visible top-level window is captured on
        its own and painted onto a canvas in z-order, back to front.

   The fallback is not paranoia. On the machine this was built for, monitor
   capture fails permanently with ERROR_INVALID_HANDLE while window capture
   works perfectly — so path 1 alone would have shipped an agent that could
   never see anything. Path 2 produces a faithful desktop, taskbar included.

   PowerShell was tried first and is a dead end: Windows Defender blocks any
   script that captures the screen (Behavior heuristic, confirmed by two
   separate detections). Writing around an antivirus signature is not
   something to do, so this uses prebuilt native capture instead.

   COORDINATES
   Windows reports window geometry in DPI-virtualised units and captures in
   real pixels — on this display a 1.25x difference, which silently put every
   click a quarter of the screen away from its target. Everything here works
   in physical pixels, and `toScreen()` is the single place that converts a
   model's answer back into the space the mouse uses.
   ========================================================================== */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let Monitor = null;
let Window = null;
let Jimp = null;

try {
  ({ Monitor, Window } = require('node-screenshots'));
  Jimp = require('jimp');
} catch (err) {
  console.warn(`[bridge] screen capture unavailable (${err.message})`);
}

/** Wrap a raw RGBA buffer as a Jimp image without re-encoding it. */
function fromRaw(data, width, height) {
  return new Promise((resolve, reject) => {
    new Jimp({ data, width, height }, (err, img) => (err ? reject(err) : resolve(img)));
  });
}

/**
 * Paint `src` (RGBA) onto `dst` (RGBA) at dx,dy, clipped to dst.
 * Row-wise copy: a window is contiguous horizontally, so this is a handful
 * of large memcpys rather than a per-pixel loop.
 */
function blit(dst, dw, dh, src, sw, sh, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(dw, dx + sw);
  const y1 = Math.min(dh, dy + sh);
  if (x1 <= x0 || y1 <= y0) return;

  const rowBytes = (x1 - x0) * 4;
  for (let y = y0; y < y1; y++) {
    const srcStart = (((y - dy) * sw) + (x0 - dx)) * 4;
    const dstStart = ((y * dw) + x0) * 4;
    src.copy(dst, dstStart, srcStart, srcStart + rowBytes);
  }
}

export class Screen {
  constructor() {
    this.mode = null;            // 'monitor' | 'composite'
    this.scale = 1;              // physical pixels per virtual unit
    this.bounds = null;          // virtual units — the space the mouse uses
  }

  static available() { return Boolean(Monitor && Window && Jimp); }

  /** Primary display, in the virtual units Windows hands to this process. */
  primary() {
    const all = Monitor.all();
    const m = all.find((x) => x.isPrimary()) || all[0];
    if (!m) throw new Error('no display found');
    return m;
  }

  /**
   * Work out which capture path this machine supports, once.
   * @returns {Promise<{mode:string, width:number, height:number, scale:number}>}
   */
  async detect() {
    if (!Screen.available()) throw new Error('the capture module is not installed');

    const m = this.primary();
    this.scale = m.scaleFactor() || 1;

    // Monitor geometry is physical; the mouse and window geometry are not.
    const physW = m.width();
    const physH = m.height();
    this.bounds = {
      width: Math.round(physW / this.scale),
      height: Math.round(physH / this.scale),
    };

    try {
      const img = await m.captureImage();
      if (img.width > 0) {
        this.mode = 'monitor';
        return { mode: this.mode, width: physW, height: physH, scale: this.scale };
      }
    } catch {
      /* fall through — window compositing below */
    }

    // Prove the fallback works before claiming the desktop is visible.
    const windows = Window.all();
    if (!windows.length) throw new Error('the screen could not be read');
    await windows[0].captureImage();

    this.mode = 'composite';
    return { mode: this.mode, width: physW, height: physH, scale: this.scale };
  }

  /** Full desktop as raw RGBA, in physical pixels. */
  async rawDesktop() {
    const m = this.primary();
    const scale = m.scaleFactor() || 1;
    const width = m.width();
    const height = m.height();

    if (this.mode === 'monitor') {
      const img = await m.captureImage();
      return { data: Buffer.from(await img.toRaw()), width: img.width, height: img.height, scale };
    }

    // Desktop grey behind everything, so an uncovered region reads as empty
    // rather than as black, which a model can mistake for a dark app.
    const canvas = Buffer.alloc(width * height * 4);
    for (let i = 0; i < canvas.length; i += 4) {
      canvas[i] = 0x1a; canvas[i + 1] = 0x1c; canvas[i + 2] = 0x22; canvas[i + 3] = 0xff;
    }

    const windows = Window.all()
      .filter((w) => {
        try { return !w.isMinimized(); } catch { return false; }
      })
      .sort((a, b) => a.z() - b.z());   // ascending: back to front

    for (const w of windows) {
      try {
        const img = await w.captureImage();
        const raw = Buffer.from(await img.toRaw());
        blit(
          canvas, width, height,
          raw, img.width, img.height,
          Math.round(w.x() * scale), Math.round(w.y() * scale),
        );
      } catch {
        /* one window refusing to be captured must not blind the whole run */
      }
    }

    return { data: canvas, width, height, scale };
  }

  /**
   * A JPEG of the desktop, downscaled so one turn costs tens of KB rather
   * than megabytes, plus the conversion from the model's coordinate space
   * back to the one the mouse uses.
   */
  async capture({ width = 1024, quality = 70 } = {}) {
    const desktop = await this.rawDesktop();
    const img = await fromRaw(desktop.data, desktop.width, desktop.height);

    const target = Math.min(width, desktop.width);
    img.resize(target, Jimp.AUTO).quality(quality);
    const buffer = await img.getBufferAsync('image/jpeg');

    const shotW = img.bitmap.width;
    const shotH = img.bitmap.height;

    /* A coarse thumbnail for answering "did anything actually happen?".
       An exact hash is useless here: a live desktop is never pixel-identical
       twice — the clock alone changes — so comparing full frames reports
       "something moved" every single time, which is exactly as unhelpful as
       reporting nothing ever does. 32 columns of grey is enough to see a menu
       open and blind to a blinking caret. */
    const thumb = img.clone().resize(32, Jimp.AUTO).greyscale();
    const grey = Buffer.alloc(thumb.bitmap.width * thumb.bitmap.height);
    for (let i = 0; i < grey.length; i++) grey[i] = thumb.bitmap.data[i * 4];

    // model space -> physical -> the virtual units SetCursorPos takes
    const kx = desktop.width / shotW / desktop.scale;
    const ky = desktop.height / shotH / desktop.scale;
    const maxX = Math.round(desktop.width / desktop.scale) - 1;
    const maxY = Math.round(desktop.height / desktop.scale) - 1;

    return {
      b64: buffer.toString('base64'),
      mime: 'image/jpeg',
      bytes: buffer.length,
      grey,
      width: shotW,
      height: shotH,
      mode: this.mode,
      toScreen: (x, y) => ({
        x: Math.round(Math.max(0, Math.min(maxX, Number(x) * kx))),
        y: Math.round(Math.max(0, Math.min(maxY, Number(y) * ky))),
      }),
    };
  }

  /** Title of whatever is in front, for the activity log. */
  focusedWindow() {
    try {
      const w = Window.all().find((x) => x.isFocused());
      return w ? `${w.appName()}${w.title() ? ` — ${w.title()}` : ''}` : '';
    } catch {
      return '';
    }
  }
}
