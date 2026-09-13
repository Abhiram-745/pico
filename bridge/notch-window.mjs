/* ==========================================================================
   Pico — the island, as a real window on the real desktop.

   A black rounded rectangle hanging from the top centre of the primary
   display, like the MacBook notch and the iPhone's Dynamic Island. It
   springs between sizes as the page asks for them.

   HOW IT IS BUILT
   A browser window in app mode, pointed at pico-ui/notch.html, with its own
   throwaway profile so it is a separate process that can be placed and
   closed without touching your normal browsing. Placement uses libnut's
   window calls, which ship prebuilt and need no compiler.

   HIDING THE TITLE BAR
   An app-mode browser window still has a title bar, and a notch with a title
   bar on top is not a notch. The page reports its inner and outer size; the
   difference is the frame, and the window is placed with its top edge above
   the screen by exactly that much. What remains visible is the page — black,
   flush to the top edge, with Windows 11 rounding the bottom corners.

   STAYING ON TOP
   A window that sits behind a maximized browser is not a notch. island-host
   (a tiny compiled helper, see island-host.mjs) pins it above other windows,
   hides it from the taskbar and Alt-Tab, drops its resize border, and moves
   and sizes it in one call per frame. Without the helper it still opens and
   morphs, but can be covered by other windows and keeps its frame.
   ========================================================================== */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Title marker, so the window can be found among a few hundred others. */
export const NOTCH_TITLE = 'Pico Notch';

/** Chrome on Windows 11 at 125%, measured. Replaced by the page's own report. */
const DEFAULT_FRAME = { side: 7, top: 30, bottom: 7 };
const COMPACT = { width: 236, height: 36 };

const CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
];

export function findBrowser() {
  return CANDIDATES.find((p) => p && !p.startsWith('undefined') && existsSync(p)) ?? null;
}

let nut = null;
try {
  nut = require('@nut-tree-fork/libnut-win32');
} catch {
  /* without it the window still opens; it just cannot be placed */
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Overshoots a touch and settles — the island's characteristic bounce. */
function easeOutBack(t) {
  const c1 = 1.15;
  const c3 = c1 + 1;
  return 1 + (c3 * (t - 1) ** 3) + (c1 * (t - 1) ** 2);
}

export class NotchWindow {
  /**
   * @param {object} opts
   * @param {string} opts.url          the page to load
   * @param {number} opts.screenWidth  in the same units as window rects
   */
  constructor({ url, screenWidth = 1920, host = null }) {
    this.url = url;
    this.host = host;
    this.screenWidth = screenWidth;
    this.proc = null;
    this.hwnd = null;
    this.profile = join(tmpdir(), 'pico-notch-profile');
    this.frame = { ...DEFAULT_FRAME };
    // Only the window this bridge opened may report its frame or ask to be
    // resized. Without this, any other tab left open on notch.html reports
    // its own geometry and the real island is placed to match a page that is
    // not it — which is exactly what happened.
    this.token = randomBytes(9).toString('base64url');
    this.size = { ...COMPACT };       // content size currently on screen
    this.run = 0;
  }

  get isOpen() { return Boolean(this.proc && this.proc.exitCode === null); }

  /** Window rectangle that shows exactly `content`, centred, flush to the top. */
  rectFor({ width, height }) {
    const f = this.frame;
    const outerW = Math.round(width + (2 * f.side));
    const outerH = Math.round(height + f.top + f.bottom);
    return {
      x: Math.round((this.screenWidth / 2) - (outerW / 2)),
      y: -f.top,
      width: outerW,
      height: outerH,
    };
  }

  /** The page's own measurement of the browser chrome around it. */
  learnFrame({ iw, ih, ow, oh }) {
    // A page that cannot report its own geometry sends zeroes, and believing
    // them would compute a frame of nothing — which puts the browser's title
    // bar back on screen. Only positive, self-consistent numbers count.
    if (![iw, ih, ow, oh].every((v) => Number.isFinite(v) && v > 0)) return;
    if (ow < iw || oh < ih) return;
    const side = Math.max(0, Math.min(16, Math.round((ow - iw) / 2)));
    const top = Math.max(0, Math.min(80, Math.round(oh - ih - side)));
    this.frame = { side, top, bottom: side };
  }

  async open() {
    // Already up — possibly left open by a previous run of the bridge, in
    // which case its page reconnects to this one on its own. Spawning again
    // would put a second island on screen.
    const existing = this.findWindow();
    if (existing) {
      this.hwnd = existing;
      this.host?.pin(existing);
      this.host?.trim(existing);
      this.apply(this.rectFor(this.size));
      return { ok: true, already: true };
    }

    const browser = findBrowser();
    if (!browser) return { ok: false, error: 'No Chrome or Edge found to open the notch in.' };

    const r = this.rectFor(COMPACT);
    this.proc = spawn(browser, [
      `--app=${this.url}?k=${this.token}`,
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      `--window-position=${r.x},0`,
      `--window-size=${r.width},${r.height}`,
    ], { detached: true, stdio: 'ignore' });

    this.proc.on('exit', () => { this.proc = null; this.hwnd = null; });
    this.proc.unref();

    const found = await this.waitForWindow(8000);
    if (found) {
      this.host?.pin(found);
      this.host?.trim(found);
      this.apply(this.rectFor(this.size));
    }
    return { ok: true, placed: Boolean(found) };
  }

  async waitForWindow(timeout) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const h = this.findWindow();
      if (h) { this.hwnd = h; return h; }
      await sleep(150);
    }
    return null;
  }

  findWindow() {
    if (!nut) return null;
    try {
      for (const h of nut.getWindows()) {
        try {
          if (String(nut.getWindowTitle(h) || '').includes(NOTCH_TITLE)) return h;
        } catch { /* windows come and go while enumerating */ }
      }
    } catch { /* enumeration failed entirely */ }
    return null;
  }

  apply(rect) {
    const h = this.hwnd ?? this.findWindow();
    if (!h) return false;
    this.hwnd = h;

    if (this.host?.ready) return this.host.place(h, rect);

    if (!nut) return false;
    try {
      nut.moveWindow(h, { x: rect.x, y: rect.y });
      nut.resizeWindow(h, { width: rect.width, height: rect.height });
      return true;
    } catch {
      this.hwnd = null;     // stale handle; found again next time
      return false;
    }
  }

  /**
   * Spring from the current size to a new one, recentring every frame so the
   * island grows out from the middle rather than from its left edge. A newer
   * request cancels one in flight, so fast changes never queue up.
   */
  async morph(target, { duration = 320 } = {}) {
    const run = ++this.run;
    const from = { ...this.size };
    const to = {
      width: Math.max(120, Math.min(900, Math.round(target.width))),
      height: Math.max(30, Math.min(760, Math.round(target.height))),
    };
    if (Math.abs(to.width - from.width) < 2 && Math.abs(to.height - from.height) < 2) {
      this.size = to;
      this.apply(this.rectFor(to));
      return;
    }

    const t0 = Date.now();
    for (;;) {
      if (run !== this.run) return;
      const t = Math.min(1, (Date.now() - t0) / duration);
      const e = easeOutBack(t);
      this.size = {
        width: from.width + ((to.width - from.width) * e),
        height: from.height + ((to.height - from.height) * e),
      };
      this.apply(this.rectFor(this.size));
      if (t >= 1) break;
      await sleep(8);
    }
    this.size = to;
  }

  raise() {
    const h = this.hwnd ?? this.findWindow();
    if (!h) return false;
    this.hwnd = h;
    if (this.host?.ready) { this.host.pin(h); return true; }
    if (!nut) return false;
    try { nut.focusWindow(h); return true; } catch { return false; }
  }

  async close() {
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = null;
    this.hwnd = null;
    this.size = { ...COMPACT };

    // The browser may have handed the window to a process this one did not
    // start (a window left from an earlier run, or Chrome's own relaunch).
    // Match on the island's private profile directory, which nothing but the
    // island uses — so this can never close one of the user's own windows.
    await new Promise((resolve) => {
      const marker = this.profile.replace(/'/g, "''");
      const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | "
        + `Where-Object { $_.CommandLine -like '*${marker}*' } | `
        + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: 'ignore', windowsHide: true });
      p.once('exit', resolve);
      p.once('error', resolve);
    });
  }

}
