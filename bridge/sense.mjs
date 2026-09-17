/* ==========================================================================
   Halo — the accessibility layer, from Node.

   Builds native/sense.cs with the C# compiler inside Windows the first time
   it is needed, caches it under %LOCALAPPDATA%\Halo by a hash of its source,
   and keeps one copy running to answer questions about what is on screen.

   It only ever looks. The pointer and the keyboard stay in computer.mjs, so
   the user's own cursor is still the thing that does every click; this
   answers "what exactly is under that point, and where is its middle".

   Optional throughout. Every call resolves — to null when the helper is
   missing, has died, or took too long — and every caller carries on without
   it, the way it did before this existed.
   ========================================================================== */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './home.mjs';

const SOURCE = fileURLToPath(new URL('native/sense.cs', import.meta.url));

function compiler() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const dir = join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = join(dir, 'csc.exe');
  return existsSync(csc) ? { csc, wpf: join(dir, 'WPF') } : null;
}

function cachedExe() {
  const dir = dataDir();
  const stamp = createHash('sha1').update(readFileSync(SOURCE)).digest('hex').slice(0, 10);
  return join(dir, `sense-${stamp}.exe`);
}

/** Builds of older sources. One that is still running cannot be deleted,
    which is fine: it goes the next time. */
function tidy(keep) {
  try {
    const dir = dirname(keep);
    for (const name of readdirSync(dir)) {
      if (/^sense-[0-9a-f]{10}\.exe$/.test(name) && join(dir, name) !== keep) {
        try { unlinkSync(join(dir, name)); } catch { /* in use */ }
      }
    }
  } catch { /* nothing to tidy */ }
}

async function build() {
  const exe = cachedExe();
  if (existsSync(exe)) return exe;
  const tools = compiler();
  if (!tools) throw new Error('the Windows C# compiler was not found');

  await new Promise((resolve, reject) => {
    // UI Automation ships with .NET Framework, in the WPF folder rather than
    // on the compiler's default search path, so it is referenced by path.
    execFile(tools.csc, [
      '/nologo', '/optimize+', '/target:exe',
      `/r:${join(tools.wpf, 'UIAutomationClient.dll')}`,
      `/r:${join(tools.wpf, 'UIAutomationTypes.dll')}`,
      `/r:${join(tools.wpf, 'WindowsBase.dll')}`,
      `/out:${exe}`, SOURCE,
    ], { windowsHide: true, timeout: 90_000 },
    (err, stdout) => (err ? reject(new Error(String(stdout || err.message).trim())) : resolve()));
  });
  tidy(exe);
  return exe;
}

export class Sense {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.pending = new Map();
    this.seq = 0;
    this.exe = null;
    this.starting = null;
  }

  static async start() {
    if (process.platform !== 'win32') return null;
    const sense = new Sense();
    try {
      sense.exe = await build();
      await sense.launch();
      return sense;
    } catch (err) {
      console.warn(`[bridge] accessibility helper unavailable (${err.message}) — clicks aim by eye alone`);
      return null;
    }
  }

  launch() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error('did not start')), 8000);
      proc.once('error', (e) => { clearTimeout(timer); reject(e); });
      proc.once('exit', () => {
        this.ready = false;
        this.proc = null;
        this.starting = null;
        for (const settle of this.pending.values()) settle(null);
        this.pending.clear();
      });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (line === 'ready') { this.ready = true; clearTimeout(timer); resolve(); return; }
        const space = line.indexOf(' ');
        if (space < 0) return;
        const settle = this.pending.get(line.slice(0, space));
        if (!settle) return;     // a late answer to a request that already timed out
        this.pending.delete(line.slice(0, space));
        let value = null;
        try { value = JSON.parse(line.slice(space + 1)); } catch { /* malformed: null */ }
        settle(value && !value.error ? value : null);
      });
    });
    return this.starting;
  }

  /** Ask one question. Resolves to the parsed answer, or null. */
  async request(command, ms = 2000) {
    if (!this.ready) {
      // Died since starting: one quiet attempt to bring it back.
      if (!this.exe) return null;
      try { await this.launch(); } catch { return null; }
    }
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, ms);
      timer.unref?.();
      this.pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
      try {
        this.proc.stdin.write(`${id} ${command}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** Physical pixels throughout. */
  hit(x, y) { return this.request(`hit ${Math.round(x)} ${Math.round(y)}`, 1800); }
  near(x, y, r = 24) { return this.request(`near ${Math.round(x)} ${Math.round(y)} ${Math.round(r)}`, 2800); }
  scrollable(x, y) { return this.request(`scrollable ${Math.round(x)} ${Math.round(y)}`, 1800); }
  windowAt(x, y) { return this.request(`window ${Math.round(x)} ${Math.round(y)}`, 800); }
  /**
   * Ask the window under a point to build its accessibility tree.
   *
   * Chromium — Chrome, Edge, anything Electron — keeps no tree until a screen
   * reader asks for one, and answers every question with a single featureless
   * pane until it does. Asked for while the plan is still being written, so
   * the tree is ready by the time the first click needs it rather than the
   * click waiting on it.
   */
  wake(x, y) { return this.request(`wake ${Math.round(x)} ${Math.round(y)}`, 2500); }
  /** `{ name, usable }` — usable is false while locked, behind a screen saver, or at a UAC prompt. */
  desktop() { return this.request('desktop', 800); }
  /** Milliseconds since the last keyboard or mouse input, from anyone. */
  async idle() { return (await this.request('idle', 800))?.ms ?? null; }
  cursor() { return this.request('cursor', 800); }
  foreground() { return this.request('fg', 800); }
  /** What really holds keyboard focus — the title, the element, and its own
      value. Facts for the verdict, rather than a model's reading of a JPEG. */
  focused() { return this.request('focused', 1800); }
  async windows() { return (await this.request('windows', 1500))?.windows ?? null; }
  focus(hwnd) { return this.request(`focus ${hwnd}`, 1800); }
  async elements(hwnd, max = 200) { return (await this.request(`elements ${hwnd} ${max}`, 6000))?.elements ?? null; }

  stop() {
    try { this.proc?.stdin.end(); } catch { /* gone */ }
    try { this.proc?.kill(); } catch { /* gone */ }
  }
}
