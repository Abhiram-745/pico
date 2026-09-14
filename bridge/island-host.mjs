/* ==========================================================================
   Pico — the island host, from Node.

   Builds native/island-host.cs with the C# compiler that is part of every
   Windows install (.NET Framework 4's csc.exe) the first time it is needed,
   caches the result under %LOCALAPPDATA%\Pico, and keeps one copy running to
   place the island window.

   Why a compiled helper and not a script: PowerShell reaching Win32 through
   Add-Type is exactly what antivirus heuristics watch for, and on this
   machine Defender blocked two earlier scripts outright. A small compiled
   program that does only window placement is the ordinary way to do this.

   Optional throughout. If the compiler is missing or the build fails, the
   island still opens — it just is not pinned on top or shaped, and the
   bridge falls back to plain move/resize.
   ========================================================================== */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * overwrite a copy that an already-running Pico still has open — which fails
 * on Windows, and used to take the helper down with it.
 */
function cachedExe() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || '.';
  const dir = join(base, 'Pico');
  mkdirSync(dir, { recursive: true });
  const stamp = createHash('sha1').update(readFileSync(SOURCE)).digest('hex').slice(0, 10);
  return join(dir, `island-host-${stamp}.exe`);
}

/** Build if this exact source has not been built before. Resolves to the path. */
async function build() {
  const exe = cachedExe();
  if (existsSync(exe)) return exe;

  const csc = compiler();
  if (!csc) throw new Error('the Windows C# compiler was not found');

  // UI Automation is how a control is pressed without the pointer going to
  // it. It ships with .NET Framework, in the WPF folder rather than on the
  // compiler's default search path, so it is referenced by full path.
  const wpf = join(process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF');

  await new Promise((resolve, reject) => {
    // A console target, not winexe: the protocol is stdin/stdout, and a
    // winexe has no console to read from. The window is hidden at spawn.
    execFile(csc, [
      '/nologo', '/optimize+', '/target:exe',
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
      `/r:${join(wpf, 'UIAutomationClient.dll')}`,
      `/r:${join(wpf, 'UIAutomationTypes.dll')}`,
      `/r:${join(wpf, 'WindowsBase.dll')}`,
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
    // The helper answers every command with exactly one line, in order, so a
    // queue of one entry per command sent is enough to match answers to
    // questions. Most commands do not care and queue a null.
    this.waiting = [];
  }

  static async start() {
    if (process.platform !== 'win32') return null;
    const host = new IslandHost();
    try {
      const exe = await build();
      await host.launch(exe);
      return host;
    } catch (err) {
      console.warn(`[bridge] island host unavailable (${err.message}) — the notch will not stay on top`);
      return null;
    }
  }

  launch(exe) {
    return new Promise((resolve, reject) => {
      this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => reject(new Error('did not start')), 8000);
      this.proc.once('error', (e) => { clearTimeout(timer); reject(e); });
      this.proc.once('exit', () => { this.ready = false; this.proc = null; });

      createInterface({ input: this.proc.stdout }).on('line', (line) => {
        if (line === 'ready') { this.ready = true; clearTimeout(timer); resolve(); return; }
        if (line.startsWith('err')) console.warn(`[bridge] island host: ${line.slice(4)}`);
        const settle = this.waiting.shift();
        if (settle) settle(line);
      });
    });
  }

  send(line) {
    if (!this.ready || !this.proc) return false;
    try {
      this.proc.stdin.write(`${line}\n`);
      this.waiting.push(null);        // an answer will come; nobody is listening
      return true;
    } catch { return false; }
  }

  /**
   * Send, and wait for the one line that comes back.
   *
   * Bounded, because this is another process: if it stops answering, the
   * caller gets an empty answer rather than a promise that never settles.
   * The queue entry is left in place on a timeout — a late reply still
   * belongs to this command rather than to the next one.
   */
  request(line, ms = 3000) {
    if (!this.ready || !this.proc) return Promise.resolve('');
    return new Promise((resolve) => {
      let settled = false;
      const once = (answer) => { if (!settled) { settled = true; resolve(answer); } };
      try {
        this.proc.stdin.write(`${line}\n`);
        this.waiting.push(once);
      } catch {
        once('');
        return;
      }
      setTimeout(() => once(''), ms).unref?.();
    });
  }

  pin(hwnd) { return this.send(`pin ${hwnd}`); }

  /** Remove the resize border and round the corners. Once, after opening. */
  trim(hwnd) { return this.send(`trim ${hwnd}`); }

  /** Position and size in one call. Every number rounded — the host parses ints. */
  place(hwnd, rect) {
    const n = (v) => Math.round(v);
    return this.send(['place', hwnd, n(rect.x), n(rect.y), n(rect.width), n(rect.height)].join(' '));
  }

  /* ------------------------------------------------------------------------
     Pico's cursor — a layered window that follows the pointer while it works
     ---------------------------------------------------------------------- */
  cursorOn(pngPath) { return this.send(`cursor on ${pngPath}`); }
  cursorAt(x, y) { return this.send(`cursor at ${Math.round(x)} ${Math.round(y)}`); }
  cursorState(name) { return this.send(`cursor state ${name}`); }
  cursorOff() { return this.send('cursor off'); }

  /* Whose pointer is on screen.

     Only needed when something has to borrow the real one — a drag, a
     right-click, an application with no accessibility tree. Ordinary clicks
     go through `quietClick` and touch nothing of the user's at all.

     When it is borrowed: hiding the system cursor is what makes the run read
     as Pico's own cursor doing the moving rather than as your mouse being
     yanked around, and `cursorSave` / `cursorRestore` put the pointer back
     where you left it, so when Pico finishes nothing has moved. */
  cursorHide() { return this.send('cursor hide'); }
  cursorShow() { return this.send('cursor show'); }
  cursorSave() { return this.send('cursor save'); }
  cursorRestore() { return this.send('cursor restore'); }

  /**
   * Press what is at a point without the pointer going there.
   *
   * Through UI Automation, the accessibility layer — the same route a screen
   * reader takes. Coordinates are physical screen pixels, which is what UI
   * Automation reports and accepts. Resolves true only when something was
   * actually pressed; false means the bridge should use the pointer instead,
   * and there are plenty of honest reasons for that (games, custom-drawn
   * interfaces, anything with no accessibility tree).
   */
  async quietClick(x, y) {
    const answer = await this.request(`quiet click ${Math.round(x)} ${Math.round(y)}`);
    if (process.env.PICO_DEBUG) console.log(`[quiet] ${Math.round(x)},${Math.round(y)} -> ${answer || '(no answer)'}`);
    if (!answer.startsWith('ok done')) return null;
    // "ok done invoke Locked chats" — the third word on is what was pressed,
    // which is worth having: it is the only account of what a click actually
    // landed on that does not involve looking at a picture of it afterwards.
    return { pressed: answer.split(' ').slice(3).join(' ').trim() };
  }

  /**
   * Name what is at a point, pressing nothing.
   *
   * The check that stops a click going to the wrong row. Aiming is done from
   * a picture, and a picture cannot tell "Archived" from "Locked chats" as
   * reliably as the application itself can — it will happily point at the row
   * above the one it meant. This asks the application, before the click, what
   * is actually under the point.
   *
   * Resolves to the control's name, or null when there is nothing to ask
   * (no accessibility tree, an unnamed control, a canvas). Null means "no
   * opinion", never "wrong" — the click goes ahead.
   */
  async quietLook(x, y) {
    const answer = await this.request(`quiet look ${Math.round(x)} ${Math.round(y)}`);
    if (process.env.PICO_DEBUG) console.log(`[look] ${Math.round(x)},${Math.round(y)} -> ${answer || '(no answer)'}`);
    if (!answer.startsWith('ok is ')) return null;
    return answer.slice(6).trim() || null;
  }

  /**
   * Shut down without leaving the pointer invisible.
   *
   * Killing the helper outright runs none of its own cleanup — Windows just
   * stops the process — so the pointer is asked for back first, and the kill
   * only happens if it has not exited on its own by then. (The helper also
   * restores the pointer when stdin closes, and again on a timer, so there
   * are three ways out of hidden and none of them need this one to work.)
   */
  stop() {
    this.cursorShow();
    this.cursorOff();
    try { this.proc?.stdin.end(); } catch { /* gone */ }
    const proc = this.proc;
    setTimeout(() => {
      try { proc?.kill(); } catch { /* gone */ }
    }, 250).unref?.();
  }
}
