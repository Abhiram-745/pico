/* ==========================================================================
   Halo — seeing the screen.

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
   in physical pixels, and a shot's own conversions — toPhysical, toScreen,
   physToScreen — are the only places a point changes from one space to
   another.
   ========================================================================== */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let Monitor = null;
let Window = null;
let Jimp = null;
let jpeg = null;

try {
  ({ Monitor, Window } = require('node-screenshots'));
  Jimp = require('jimp');
} catch (err) {
  console.warn(`[bridge] screen capture unavailable (${err.message})`);
}
try {
  // Jimp's own encoder, used directly: Jimp's wrapper around it, and its
  // resize, were most of a second per screenshot — every turn.
  jpeg = require('jpeg-js');
} catch { /* the Jimp path below still works, just slower */ }

/** Wrap a raw RGBA buffer as a Jimp image without re-encoding it. */
function fromRaw(data, width, height) {
  return new Promise((resolve, reject) => {
    new Jimp({ data, width, height }, (err, img) => (err ? reject(err) : resolve(img)));
  });
}

/**
 * Bilinear downscale of an RGBA buffer — the same filter the accuracy
 * figures were measured with, in a tight loop over typed arrays instead of
 * through Jimp, which took three times as long.
 */
function downscale(src, sw, sh, dw) {
  const dh = Math.max(1, Math.round((sh * dw) / sw));
  const out = Buffer.allocUnsafe(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;

  const x0s = new Int32Array(dw);
  const x1s = new Int32Array(dw);
  const wxs = new Uint16Array(dw);
  for (let x = 0; x < dw; x++) {
    const sx = Math.max(0, ((x + 0.5) * fx) - 0.5);
    const x0 = Math.min(sw - 1, Math.floor(sx));
    x0s[x] = x0 * 4;
    x1s[x] = Math.min(sw - 1, x0 + 1) * 4;
    wxs[x] = Math.round((sx - x0) * 256);
  }

  for (let y = 0; y < dh; y++) {
    const sy = Math.max(0, ((y + 0.5) * fy) - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const r0 = y0 * sw * 4;
    const r1 = Math.min(sh - 1, y0 + 1) * sw * 4;
    const wy = Math.round((sy - y0) * 256);
    const iy = 256 - wy;
    let o = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const a = x0s[x];
      const b = x1s[x];
      const wx = wxs[x];
      const ix = 256 - wx;
      for (let c = 0; c < 3; c++) {
        const top = (src[r0 + a + c] * ix) + (src[r0 + b + c] * wx);
        const bot = (src[r1 + a + c] * ix) + (src[r1 + b + c] * wx);
        out[o + c] = ((top * iy) + (bot * wy)) >> 16;
      }
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** A 64-wide greyscale thumbnail, by averaging blocks of the frame. */
function thumbnail(src, sw, sh, tw = 64) {
  const th = Math.max(1, Math.round((sh * tw) / sw));
  const grey = Buffer.alloc(tw * th);
  const bx = sw / tw;
  const by = sh / th;
  for (let ty = 0; ty < th; ty++) {
    const ya = Math.floor(ty * by);
    const yb = Math.min(sh, Math.floor((ty + 1) * by));
    for (let tx = 0; tx < tw; tx++) {
      const xa = Math.floor(tx * bx);
      const xb = Math.min(sw, Math.floor((tx + 1) * bx));
      let sum = 0;
      let n = 0;
      // Every other pixel is plenty to average a block of a thousand.
      for (let y = ya; y < yb; y += 2) {
        let i = ((y * sw) + xa) * 4;
        for (let x = xa; x < xb; x += 2, i += 8) {
          sum += (src[i] * 77) + (src[i + 1] * 150) + (src[i + 2] * 29);
          n += 1;
        }
      }
      grey[(ty * tw) + tx] = n ? (sum / n) >> 8 : 0;
    }
  }
  return grey;
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
   * How wide the picture sent to the model should be.
   *
   * This is most of click accuracy, and it was measured rather than chosen.
   * On a 2560x1440 display at 125%, 51 labelled targets, the same model:
   *
   *   1024 wide  (what Halo sent)   36% of clicks landed on the target
   *   1280 wide                     78%
   *   1600 wide                     94-98%, median 2px from the centre
   *   2048 wide                     96%, and 40% slower
   *
   * What matters is how big the screen's text ends up in the picture, which
   * depends on the display's scaling as much as on its resolution — so the
   * width follows the logical size (1600 for 2048 logical pixels), within
   * limits, and never exceeds the screen itself.
   */
  static modelWidth(physicalWidth, scale = 1) {
    const logical = physicalWidth / (scale || 1);
    return Math.round(Math.min(physicalWidth, Math.max(1280, Math.min(2048, logical * 0.78125))));
  }

  /**
   * A JPEG of the desktop for the model, plus every conversion between the
   * three spaces a point can be in: the picture, physical screen pixels
   * (what UI Automation and the raw frame use), and the units the mouse
   * takes. Keeps the raw frame, so a close-up or a scroll measurement works
   * on exactly what the model saw.
   */
  async capture({ width = null, quality = 80, raw = null } = {}) {
    const desktop = raw ?? await this.rawDesktop();
    const target = Math.min(width ?? Screen.modelWidth(desktop.width, desktop.scale), desktop.width);

    let buffer;
    let shotW;
    let shotH;
    if (jpeg) {
      // ~250ms, where the same through Jimp was ~900ms: every turn waits on it.
      const small = target === desktop.width
        ? { data: desktop.data, width: desktop.width, height: desktop.height }
        : downscale(desktop.data, desktop.width, desktop.height, target);
      buffer = jpeg.encode(small, quality).data;
      shotW = small.width;
      shotH = small.height;
    } else {
      // A copy: resizing must not disturb the frame kept for measuring.
      const img = await fromRaw(Buffer.from(desktop.data), desktop.width, desktop.height);
      if (target !== desktop.width) img.resize(target, Jimp.AUTO, Jimp.RESIZE_BILINEAR);
      img.quality(quality);
      buffer = await img.getBufferAsync('image/jpeg');
      shotW = img.bitmap.width;
      shotH = img.bitmap.height;
    }

    /* A coarse thumbnail for answering "did anything actually happen?".
       An exact hash is useless here: a live desktop is never pixel-identical
       twice — the clock alone changes — so comparing full frames reports
       "something moved" every single time, which is exactly as unhelpful as
       reporting nothing ever does.

       64 columns rather than 32, because the comparison also asks whether
       any single cell changed a lot, and at 32 a cell is a large enough piece
       of the desktop to average a pressed button back into the wallpaper.
       Each cell is the average of its block of the full frame, so a small
       change counts for its real share of the cell rather than depending on
       whether a resize happened to sample it. */
    const grey = thumbnail(desktop.data, desktop.width, desktop.height, 64);

    // model space -> physical -> the virtual units SetCursorPos takes.
    //
    // Half a model pixel, added back. A model pixel covers kx screen pixels,
    // and `x * kx` is the left edge of that block rather than the middle of
    // it — so every coordinate came back biased up and to the left by half a
    // block. On a 2560-wide screen shown to the model 1024 wide that is more
    // than a pixel in each axis, for free, on every single click.
    const kx = desktop.width / shotW / desktop.scale;
    const ky = desktop.height / shotH / desktop.scale;
    const maxX = Math.round(desktop.width / desktop.scale) - 1;
    const maxY = Math.round(desktop.height / desktop.scale) - 1;
    const toScreen = (x, y) => ({
      x: Math.round(Math.max(0, Math.min(maxX, ((Number(x) + 0.5) * kx) - 0.5))),
      y: Math.round(Math.max(0, Math.min(maxY, ((Number(y) + 0.5) * ky) - 0.5))),
    });

    // The picture -> physical pixels, unrounded: the centre of the block of
    // screen pixels a picture pixel stands for.
    const px = desktop.width / shotW;
    const py = desktop.height / shotH;
    const toPhysical = (x, y) => ({
      x: Math.max(0, Math.min(desktop.width - 1, ((Number(x) + 0.5) * px) - 0.5)),
      y: Math.max(0, Math.min(desktop.height - 1, ((Number(y) + 0.5) * py) - 0.5)),
    });
    // Physical pixels -> the units the mouse takes. SetCursorPos in a process
    // that is not DPI aware works in scaled units; one of those is 1.25
    // physical pixels here, so this is as close as the mouse can be put.
    const physToScreen = (x, y) => ({
      x: Math.round(Math.max(0, Math.min(maxX, Number(x) / desktop.scale))),
      y: Math.round(Math.max(0, Math.min(maxY, Number(y) / desktop.scale))),
    });

    return {
      b64: buffer.toString('base64'),
      mime: 'image/jpeg',
      bytes: buffer.length,
      grey,
      width: shotW,
      height: shotH,
      mode: this.mode,
      scale: desktop.scale,
      physical: { width: desktop.width, height: desktop.height },
      raw: desktop,
      toScreen,
      toPhysical,
      physToScreen,
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
