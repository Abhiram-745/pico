/* ==========================================================================
   Halo — the island, as a real window on the real desktop.

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
import { existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Title marker, so the window can be found among a few hundred others. */
export const NOTCH_TITLE = 'Halo Notch';

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

/* How long the window takes to reach a new size.

   This is the number that decides whether the island feels quick. It used to
   be 320ms, which is a reasonable duration for something you are watching and
   far too long for something you are *waiting on*: the pointer arrives, and
   a third of a second later the island has finished getting out of its own
   way. Under 200ms the overshoot still reads as a spring and the island is
   simply there by the time you have looked at it.

   Do not chase it below about 140ms. The window cannot be resized faster than
   the compositor will redraw it, and asking it to tears the frame away from
   the page that is painting inside it. */
const MORPH_MS = 190;

/* How often the pointer is checked against the window rectangle.

   Every miss here is dead time before the island reacts — at 70ms the average
   wait was a frame and a half of nothing happening, which is exactly the part
   that felt sluggish. It is two comparisons against a cached rectangle, so
   the cost of asking more often is nil. */
const HOVER_MS = 25;

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
    this.profile = NotchWindow.profileDir();
    this.frame = { ...DEFAULT_FRAME };
    // Only the window this bridge opened may report its frame or ask to be
    // resized. Without this, any other tab left open on notch.html reports
    // its own geometry and the real island is placed to match a page that is
    // not it — which is exactly what happened.
    this.token = randomBytes(9).toString('base64url');
    this.size = { ...COMPACT };       // content size currently on screen
    this.placed = null;               // last rectangle actually placed
    // Whether the pointer is on the island. Kept here rather than inside the
    // watcher because it is only ever sent on a change, and a page that
    // connects between two changes would otherwise never be told at all —
    // which is the island failing to react the very first time it is hovered
    // after opening.
    this.over = false;
    this.hoverTimer = null;
    this.run = 0;

    /* Two shapes, and away.

       'island' is the strip at the top of the screen, centred, flush to the
       edge — a notch. 'card' is the same Halo as a window you can put
       wherever you like, which is the better shape when you are working with
       it rather than glancing at it. `hidden` is neither: the window still
       exists, still holds the conversation, and is simply not on the screen.
       Each is a keybind away (see pico-ui/src/keybinds.js). */
    this.mode = 'island';
    this.hidden = false;
    this.cardAt = null;         // { x, y } once it has been moved
  }

  /**
   * The island's private browser profile, renamed with the app.
   *
   * The profile is where the island kept its chats, its name and its
   * permission level before any of that lived with the bridge, so it is
   * moved rather than abandoned: the first chats window to connect sends
   * those old chats across (see chats.js). A profile still held open by an
   * island from before the rename cannot be moved; that one is used as it is
   * and moved next time.
   */
  static profileDir() {
    const fresh = join(tmpdir(), 'halo-notch-profile');
    const old = join(tmpdir(), 'pico-notch-profile');
    if (!existsSync(fresh) && existsSync(old)) {
      try { renameSync(old, fresh); } catch { return old; }
    }
    return fresh;
  }

  get isOpen() { return Boolean(this.proc && this.proc.exitCode === null); }

  /**
   * How wide the screen is, asked each time rather than remembered.
   *
   * A notch that is not in the middle is not a notch, and the screen stops
   * being the width it was when someone plugs in a monitor, changes the
   * resolution or moves the scaling slider. Remembering it from startup meant
   * the island sat off to one side until the bridge was restarted.
   */
  get width() {
    try {
      const w = nut?.getScreenSize?.().width;
      if (Number.isFinite(w) && w > 320) return w;
    } catch { /* fall back on what we were told */ }
    return this.screenWidth;
  }

  /**
   * Window rectangle that shows exactly `content`.
   *
   * An island is centred and flush to the top edge, the way a notch is. A
   * card sits where it was last put, or near the bottom-right to begin with,
   * and is kept fully on the screen.
   */
  rectFor({ width, height }) {
    const f = this.frame;
    const outerW = Math.round(width + (2 * f.side));
    const outerH = Math.round(height + f.top + f.bottom);
    if (this.mode === 'card') {
      const screenH = this.screenHeight;
      const margin = 28;
      const wantX = this.cardAt ? this.cardAt.x : this.width - outerW - margin;
      const wantY = this.cardAt ? this.cardAt.y : screenH - outerH - margin - 40;
      return {
        x: Math.round(Math.max(-f.side, Math.min(this.width - outerW + f.side, wantX))),
        y: Math.round(Math.max(0, Math.min(screenH - Math.min(outerH, screenH), wantY))),
        width: outerW,
        height: outerH,
      };
    }
    return {
      x: Math.round((this.width / 2) - (outerW / 2)),
      y: -f.top,
      width: outerW,
      height: outerH,
    };
  }

  /** How tall the screen is, asked each time, for the same reason as width. */
  get screenHeight() {
    try {
      const h = nut?.getScreenSize?.().height;
      if (Number.isFinite(h) && h > 240) return h;
    } catch { /* fall back */ }
    return Math.round(this.screenWidth * 0.5625);
  }

  /** Island or card. Returns the mode actually in force. */
  setMode(mode) {
    const next = mode === 'card' ? 'card' : 'island';
    if (next === this.mode) return this.mode;
    this.mode = next;
    // The page re-lays-out and reports its new size; this puts the window
    // where the new shape belongs in the meantime, so the switch does not
    // show a card-shaped page in an island-shaped window.
    this.placed = null;
    this.apply(this.rectFor(this.size));
    return this.mode;
  }

  /** Drag: where the card has been put, in screen pixels. */
  moveCard({ x, y }) {
    if (this.mode !== 'card') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.cardAt = { x, y };
    this.placed = null;
    this.apply(this.rectFor(this.size));
  }

  /**
   * Off the screen and back, without ending anything.
   *
   * The window is hidden rather than closed: closing it would take the
   * conversation, the run in hand and the socket with it, and bringing it
   * back would be a cold start. Hidden, it is the same Halo, not on screen.
   */
  setHidden(hidden) {
    const next = Boolean(hidden);
    if (next === this.hidden) return this.hidden;
    this.hidden = next;
    const h = this.hwnd ?? this.findWindow();
    if (!h) return this.hidden;
    if (next) {
      // Without the helper there is no ShowWindow to call, so it is parked
      // off the edge of the screen instead: the same thing to look at.
      if (!this.host?.hide(h)) {
        const r = this.rectFor(this.size);
        this.placed = null;
        this.apply({ ...r, y: -(r.height + 200) });
      }
    } else {
      this.host?.show(h);
      this.placed = null;
      this.apply(this.rectFor(this.size));
    }
    return this.hidden;
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
    // Already up, and opened by this bridge — nothing to do but make sure it
    // is still pinned and the right size. Spawning again would put a second
    // island on screen.
    const existing = this.findWindow();
    if (existing && this.isOpen) {
      this.hwnd = existing;
      this.host?.pin(existing);
      this.host?.trim(existing);
      this.apply(this.rectFor(this.size));
      return { ok: true, already: true };
    }

    // Left over from an earlier run of the bridge. It looks alive — its page
    // reconnects on its own and still shows what Halo is doing — but it is
    // carrying that run's token, so every size it reports is refused and it
    // can never change shape again. The island then lays its content out at
    // a size the window is not, and the text is clipped against a frame that
    // will not move: the bug this window cannot recover from on its own.
    //
    // So do not adopt it. Close it, and open one that this bridge can drive.
    if (existing) {
      console.log('[bridge] replacing an island left over from an earlier run');
      await this.close();
      // The browser has to let go of its profile directory before another
      // one can be started on it, and the window outliving the process by a
      // moment is the visible sign that it has not yet.
      for (let i = 0; i < 20 && this.findWindow(); i++) await sleep(100);
    }

    const browser = findBrowser();
    if (!browser) return { ok: false, error: 'No Chrome or Edge found to open the notch in.' };

    /* Twice, if need be.

       The window is found by its title, and its title is the page's title, so
       a window that never loaded the page is a window this can never find:
       not pinned, not stripped of its frame, not placed. It does not go away
       on its own either — it sits in the middle of the screen, titled with
       whatever went wrong, and the next launch walks straight past it because
       it is not called "Halo Notch".

       So a launch that produced nothing findable is cleaned up rather than
       left, and tried once more. `close` matches on the island's own profile
       directory, so it only ever reaches the island's own window. */
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await this.spawnWindow(browser);
      if (found) {
        this.host?.pin(found);
        this.host?.trim(found);
        this.apply(this.rectFor(this.size));
        return { ok: true, placed: true };
      }
      console.warn(`[bridge] the island window did not appear${attempt === 0 ? ' — clearing it and trying once more' : ''}`);
      await this.close();
      for (let i = 0; i < 20 && this.findWindow(); i++) await sleep(100);
    }
    return { ok: true, placed: false };
  }

  /** One launch. Resolves to the window handle, or null if it never showed. */
  async spawnWindow(browser) {
    const r = this.rectFor(COMPACT);
    this.proc = spawn(browser, [
      `--app=${this.url}?k=${this.token}`,
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      /* The island is black and the frame around it should be too. The
         window helper paints the frame black outright (see Trim in
         native/island-host.cs); this is for the machines where the helper
         could not be built, where the least Chrome can do is not draw a
         light grey one. */
      '--force-dark-mode',
      /* "Hey Halo": the island listens for its name and speaks its
         questions. This window only ever loads Halo's own page on
         localhost, so the microphone is granted without a prompt, and
         speech plays without waiting for a click. */
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${r.x},0`,
      `--window-size=${r.width},${r.height}`,
    ], { detached: true, stdio: 'ignore' });

    this.proc.on('exit', () => { this.proc = null; this.hwnd = null; this.placed = null; });
    this.proc.unref();

    return this.waitForWindow(8000);
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

    // A morph steps far more often than the window can actually change size,
    // and rounding means many of those steps ask for the rectangle it is
    // already in. Asking anyway is not free: every call is a real move, and
    // a burst of them is what makes the frame tear away from its content
    // mid-morph, leaving a band of window the page has not painted yet.
    const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    if (key === this.placed) return true;

    // Remembered only once it has actually happened. Recording the intention
    // instead means one refused placement is enough to convince this that the
    // window is somewhere it is not, and every later request for that same
    // rectangle is then skipped as redundant — the island stuck at one size
    // for good, with the page still politely asking.
    if (this.host?.ready) {
      const sent = this.host.place(h, rect);
      if (sent) this.placed = key;
      return sent;
    }

    if (!nut) return false;
    try {
      nut.moveWindow(h, { x: rect.x, y: rect.y });
      nut.resizeWindow(h, { width: rect.width, height: rect.height });
      this.placed = key;
      return true;
    } catch {
      this.hwnd = null;     // stale handle; found again next time
      this.placed = null;
      return false;
    }
  }

  /**
   * Spring from the current size to a new one, recentring every frame so the
   * island grows out from the middle rather than from its left edge. A newer
   * request cancels one in flight, so fast changes never queue up.
   */
  async morph(target, { duration = MORPH_MS } = {}) {
    const run = ++this.run;
    const from = { ...this.size };
    /* The upper bounds are a sanity rail against a page that has measured
       itself wrongly, not a design decision — so they are read off the screen
       rather than fixed, because the island's scale (see SCALE_KEY in
       island.js) can legitimately ask for an island half the width of the
       display, and a fixed 900 would quietly clip it. */
    const maxW = Math.max(320, Math.min(1800, Math.round(this.width * 0.92)));
    const to = {
      width: Math.max(120, Math.min(maxW, Math.round(target.width))),
      height: Math.max(30, Math.min(900, Math.round(target.height))),
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
      await sleep(16);
    }
    this.size = to;
  }

  /* ------------------------------------------------------------------------
     Is the pointer over the island?

     The page cannot be trusted to answer this about itself. A browser reports
     a pointer leaving whenever the window resizes under it — and hovering is
     what makes the island resize — so the island flickered between two sizes
     under a pointer that had not moved. Its own hit-testing is no better:
     after the pointer is put somewhere rather than moved there, :hover can
     still say the island is not under it.

     None of that is in doubt out here. There is a window, at a rectangle this
     process chose, and a pointer, at a position Windows will state plainly.
     So the bridge answers it and the page believes the bridge.
     ---------------------------------------------------------------------- */
  watchHover(onChange) {
    this.unwatchHover();
    if (!nut) return;

    this.hoverTimer = setInterval(() => {
      if (!this.hwnd && !this.findWindow()) return;
      let p;
      try { p = nut.getMousePos(); } catch { return; }

      // The frame is parked above the top of the screen, so only the part on
      // screen counts. A little slack once the pointer is on it, so a morph
      // moving the edge past a stationary pointer cannot rattle it on and off.
      const r = this.rectFor(this.size);
      const m = this.over ? 3 : 0;
      const top = Math.max(0, r.y);
      const now = p.x >= r.x - m && p.x < r.x + r.width + m
        && p.y >= top - m && p.y < r.y + r.height + m;

      if (now === this.over) return;
      this.over = now;
      onChange(now, `p=${p.x},${p.y} rect=${r.x},${r.y} ${r.width}x${r.height}`);
    }, HOVER_MS);
    this.hoverTimer.unref?.();
  }

  unwatchHover() {
    clearInterval(this.hoverTimer);
    this.hoverTimer = null;
    this.over = false;
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
    this.unwatchHover();
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = null;
    this.hwnd = null;
    this.placed = null;
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
