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
import { existsSync, statSync, mkdirSync } from 'node:fs';
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

function cachedExe() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || '.';
  const dir = join(base, 'Pico');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'island-host.exe');
}

/** Build if missing or older than its source. Resolves to the exe path. */
async function build() {
  const exe = cachedExe();
  const fresh = existsSync(exe) && statSync(exe).mtimeMs >= statSync(SOURCE).mtimeMs;
  if (fresh) return exe;

  const csc = compiler();
  if (!csc) throw new Error('the Windows C# compiler was not found');

  await new Promise((resolve, reject) => {
    execFile(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, SOURCE],
      { windowsHide: true, timeout: 60_000 },
      (err, stdout) => (err ? reject(new Error(String(stdout || err.message).trim())) : resolve()));
  });
  return exe;
}

export class IslandHost {
  constructor() {
    this.proc = null;
    this.ready = false;
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
      });
    });
  }

  send(line) {
    if (!this.ready || !this.proc) return false;
    try { this.proc.stdin.write(`${line}\n`); return true; } catch { return false; }
  }

  pin(hwnd) { return this.send(`pin ${hwnd}`); }

  /** One call: position, size and shape. Every number rounded — the host parses ints. */
  place(hwnd, rect, inset, radius) {
    const n = (v) => Math.round(v);
    return this.send([
      'place', hwnd,
      n(rect.x), n(rect.y), n(rect.width), n(rect.height),
      n(inset.left), n(inset.top), n(inset.right), n(inset.bottom),
      n(radius),
    ].join(' '));
  }

  stop() {
    try { this.proc?.stdin.end(); } catch { /* gone */ }
    try { this.proc?.kill(); } catch { /* gone */ }
  }
}
