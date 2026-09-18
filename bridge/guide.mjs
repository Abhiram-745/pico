/* ==========================================================================
   Halo — guide mode, from Node.

   The one place Halo draws a second cursor, and the exception that proves
   the rule: in guide mode Halo does not touch the mouse or the keyboard at
   all. It points at the thing to use next and says what to do there, and
   the person does it themselves. Nothing is clicked on their behalf, so
   there is no pointer to borrow and nothing to press invisibly — the arrow
   on screen is a picture, over everything, that clicks fall straight
   through.

   Builds native/guide-host.cs with the C# compiler inside Windows the first
   time it is needed and caches it by a hash of its source, exactly as the
   island host and the accessibility helper do.

   Optional throughout: without it, guide mode still says every step in the
   island, it just cannot point at the screen.
   ========================================================================== */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './home.mjs';

const SOURCE = fileURLToPath(new URL('native/guide-host.cs', import.meta.url));

function compiler() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const dir = join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = join(dir, 'csc.exe');
  return existsSync(csc) ? csc : null;
}

function cachedExe() {
  const stamp = createHash('sha1').update(readFileSync(SOURCE)).digest('hex').slice(0, 10);
  return join(dataDir(), `guide-${stamp}.exe`);
}

async function build() {
  const exe = cachedExe();
  if (existsSync(exe)) return exe;
  const csc = compiler();
  if (!csc) throw new Error('the Windows C# compiler was not found');

  await new Promise((resolve, reject) => {
    /* winexe, not exe: this draws a window and has no console of its own.
       Drawing and Forms are referenced by name — they are in the GAC beside
       the compiler, so there is nothing to find on disk. */
    execFile(csc, [
      '/nologo', '/optimize+', '/target:winexe',
      '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
      `/out:${exe}`, SOURCE,
    ], { windowsHide: true, timeout: 90_000 },
    (err, stdout) => (err ? reject(new Error(String(stdout || err.message).trim())) : resolve()));
  });
  return exe;
}

export class Guide {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.scale = 1;
    this.at = null;        // where it is pointing, in screen units
  }

  static async start({ scale = 1 } = {}) {
    if (process.platform !== 'win32') return null;
    const guide = new Guide();
    guide.scale = scale;
    try {
      guide.exe = await build();
      await guide.launch();
      return guide;
    } catch (err) {
      console.warn(`[bridge] the guide cursor is unavailable (${err.message}) — guide mode will still say each step`);
      return null;
    }
  }

  launch() {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error('the guide cursor did not start')), 8000);
      proc.once('error', (e) => { clearTimeout(timer); reject(e); });
      proc.once('exit', () => { this.ready = false; this.proc = null; });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (line.trim() === 'ready') {
          this.ready = true;
          clearTimeout(timer);
          this.send(`scale ${this.scale}`);
          resolve();
        } else if (process.env.PICO_DEBUG && line.trim()) {
          console.log(`[guide] ${line.trim()}`);
        }
      });
    });
  }

  send(line) {
    if (!this.proc?.stdin?.writable) return false;
    try {
      this.proc.stdin.write(`${line}\n`);
      return true;
    } catch { return false; }
  }

  /**
   * Point at something and say what to do there.
   * @param {number} x  screen units — the same ones the mouse uses
   * @param {number} y
   * @param {string} words  one short instruction, shown beside the arrow
   */
  point(x, y, words = '') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.at = { x: Math.round(x), y: Math.round(y) };
    return this.send(`point ${this.at.x} ${this.at.y} ${String(words).replace(/\s+/g, ' ').trim()}`);
  }

  /** Change the words without moving the arrow. */
  say(words) { return this.send(`say ${String(words).replace(/\s+/g, ' ').trim()}`); }

  hide() {
    this.at = null;
    return this.send('hide');
  }

  stop() {
    this.hide();
    try { this.proc?.stdin.end(); } catch { /* gone */ }
    const proc = this.proc;
    setTimeout(() => { try { proc?.kill(); } catch { /* gone */ } }, 300).unref?.();
  }
}
