/* ==========================================================================
   Halo — the island host, from Node.

   Builds native/island-host.cs with the C# compiler that is part of every
   Windows install (.NET Framework 4's csc.exe) the first time it is needed,
   caches the result under %LOCALAPPDATA%\Halo, and keeps one copy running to
   place the island window.

   Why a compiled helper and not a script: PowerShell reaching Win32 through
   Add-Type is exactly what antivirus heuristics watch for, and on this
   machine Defender blocked two earlier scripts outright. A small compiled
   program that does only window placement is the ordinary way to do this.

   It also registers Halo's global chords, because a chord only reaches a
   program that is not in front if Windows was asked for it by a real window
   handle — see native/island-host.cs.

   Optional throughout. If the compiler is missing or the build fails, the
   island still opens — it just is not pinned on top or shaped, and the
   bridge falls back to plain move/resize.
   ========================================================================== */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './home.mjs';

const SOURCE = fileURLToPath(new URL('native/island-host.cs', import.meta.url));

function compiler() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Named after the source it was built from, so a new version never has to
 * overwrite a copy that an already-running Halo still has open — which fails
 * on Windows, and used to take the helper down with it.
 */
function cachedExe() {
  const dir = dataDir();
  const stamp = createHash('sha1').update(readFileSync(SOURCE)).digest('hex').slice(0, 10);
  return join(dir, `island-host-${stamp}.exe`);
}

/** Build if this exact source has not been built before. Resolves to the path. */
async function build() {
  const exe = cachedExe();
  if (existsSync(exe)) return exe;

  const csc = compiler();
  if (!csc) throw new Error('the Windows C# compiler was not found');

  await new Promise((resolve, reject) => {
    // A console target, not winexe: the protocol is stdin/stdout, and a
    // winexe has no console to read from. The window is hidden at spawn.
    execFile(csc, [
      '/nologo', '/optimize+', '/target:exe',
      `/out:${exe}`, SOURCE,
    ],
      { windowsHide: true, timeout: 60_000 },
      (err, stdout) => (err ? reject(new Error(String(stdout || err.message).trim())) : resolve()));
  });
  return exe;
}

export class IslandHost {
  constructor() {
    this.proc = null;
    this.ready = false;
    /** Called with a keybind id when its chord is pressed, anywhere. */
    this.onFired = null;
    this.onRegistered = null;
    this._exe = null;          // remembered so a lost helper can be relaunched
    this._stopping = false;    // stop() was called; an exit after this is not a crash
    this._restarts = 0;        // relaunch attempts since the last time it was ready
    this._hotkeys = new Map(); // id -> {mods, vk}, replayed after every relaunch
  }

  static async start() {
    if (process.platform !== 'win32') return null;
    const host = new IslandHost();
    try {
      const exe = await build();
      host._exe = exe;
      await host.launch(exe);
      return host;
    } catch (err) {
      // Given up on: nothing may relaunch a helper nobody holds.
      host.stop();
      console.warn(`[bridge] island host unavailable (${err.message}) — the notch will not stay on top`);
      return null;
    }
  }

  launch(exe) {
    return new Promise((resolve, reject) => {
      const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.proc = proc;
      // A line written in the instant between the helper dying and its exit
      // being heard fails as an 'error' on the pipe, which unheard would take
      // the whole bridge down. The exit below is what reports it.
      proc.stdin.on('error', () => {});
      let wasReady = false;
      // A helper that never says it is ready is not left running beside the
      // next attempt: two would both answer to the same window.
      const timer = setTimeout(() => {
        reject(new Error('did not start'));
        try { proc.kill(); } catch { /* gone */ }
      }, 8000);
      proc.once('error', (e) => { clearTimeout(timer); reject(e); });
      proc.once('exit', () => {
        clearTimeout(timer);
        // Settles a launch still waiting on "ready" — without it, a helper
        // that dies on its way up (blocked outright, say) left the bridge's
        // own startup awaiting a promise nothing would ever settle. A no-op
        // once it has resolved.
        reject(new Error('exited before it was ready'));
        if (this.proc !== proc) return;      // an older one, already replaced
        this.ready = false;
        this.proc = null;
        // Only a helper that was working is relaunched from here. One that
        // never got as far as ready failed its launch, and whoever launched
        // it hears that through the rejection above.
        if (wasReady) this.retry();
      });

      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (line === 'ready') {
          if (this.proc !== proc) return;      // an attempt already given up on
          wasReady = true;
          this.ready = true;
          this._restarts = 0;
          clearTimeout(timer);
          // A fresh process remembers none of the chords an earlier one had —
          // replayed here so a relaunch is invisible rather than a silent
          // loss of every global chord for the rest of the session. Empty on
          // the very first launch, so this is a no-op then.
          for (const [id, k] of this._hotkeys) this.send(`hotkey ${id} ${k.mods} ${k.vk}`);
          resolve();
          return;
        }
        if (line.startsWith('fired ')) { this.onFired?.(line.slice(6).trim()); return; }
        if (line.startsWith('released ')) {
          const [id, ms] = line.slice(9).trim().split(/\s+/);
          this.onReleased?.(id, Number(ms) || 0);
          return;
        }
        if (line.startsWith('registered ')) { this.onRegistered?.(line.slice(11).trim()); return; }
        if (line.startsWith('err')) console.warn(`[bridge] island host: ${line.slice(4)}`);
      });
    });
  }

  /* The helper can die without the bridge dying with it — nothing else here
     runs elevated or does anything risky, but it is still a process, and a
     process can be killed by something outside Halo entirely. Losing it used
     to mean losing pin/trim/place/deaf and every global chord for the rest
     of that bridge's life: `ready` stayed false forever, so every caller's
     `this.host?.ready` guard quietly fell back for good instead of trying
     again once the coast was clear.

     So one relaunch is tried automatically, reusing the exe already built —
     `build()` on a path that exists is just a stat call — with a short
     backoff and a small cap, so a helper that genuinely cannot run (blocked
     outright, the exe removed from under it) fails quietly rather than
     spinning forever. */
  retry() {
    if (this._stopping || !this._exe) return;
    if (this._restarts >= 3) return;
    this._restarts += 1;
    setTimeout(() => {
      if (this._stopping) return;
      // A relaunch that fails on its way up is tried again, within the cap;
      // one that comes up and later dies is relaunched from its own exit.
      this.launch(this._exe).catch(() => this.retry());
    }, 500);
  }

  send(line) {
    if (!this.ready || !this.proc) return false;
    try { this.proc.stdin.write(`${line}\n`); return true; } catch { return false; }
  }

  pin(hwnd) { return this.send(`pin ${hwnd}`); }

  /** Off the screen, still running. The window keeps its size and place. */
  hide(hwnd) { return this.send(`hide ${hwnd}`); }

  /** Back on screen, without stealing the keyboard from anything. */
  show(hwnd) { return this.send(`show ${hwnd}`); }

  /**
   * Ask Windows for a chord. `mods` is MOD_ALT 1 | MOD_CONTROL 2 | MOD_SHIFT 4,
   * `vk` a virtual-key code. Registering the same id again replaces it.
   * Kept, not just sent — see the replay in launch() — so a helper that
   * crashes and comes back still answers to every chord it did before.
   */
  hotkey(id, mods, vk) {
    this._hotkeys.set(id, { mods, vk });
    return this.send(`hotkey ${id} ${mods} ${vk}`);
  }

  /** Give every chord back to Windows. */
  clearHotkeys() {
    this._hotkeys.clear();
    return this.send('unhotkey');
  }

  /** Remove the resize border and round the corners. Once, after opening. */
  trim(hwnd) { return this.send(`trim ${hwnd}`); }

  /** Let the mouse through the island, or stop letting it. See Deaf(). */
  deaf(hwnd, on) { return this.send(`deaf ${hwnd} ${on ? 1 : 0}`); }

  /**
   * Position and size in one call. Every number rounded — the host parses
   * ints. `inset`, when given, is `{ side, top, squareTop }` — the browser
   * chrome around the content on the left/right and top (bottom mirrors the
   * sides) and whether to keep the top corners square — and asks the host to
   * clip the window down to exactly its content (see Clip() in
   * native/island-host.cs). Without it the window is placed as before, frame
   * and all: older callers still work.
   */
  place(hwnd, rect, inset = null) {
    const n = (v) => Math.round(v);
    const parts = ['place', hwnd, n(rect.x), n(rect.y), n(rect.width), n(rect.height)];
    if (inset) parts.push(n(inset.side), n(inset.top), inset.squareTop ? 1 : 0);
    return this.send(parts.join(' '));
  }

  stop() {
    this._stopping = true; // this exit is expected; retry() must not chase it
    try { this.proc?.stdin.end(); } catch { /* gone */ }
    try { this.proc?.kill(); } catch { /* gone */ }
  }
}
