/* ==========================================================================
   Pico — starting with Windows.

   A shortcut in the user's Startup folder that runs the bridge, and nothing
   else. No window opens, no browser launches, no model is called: the bridge
   sits on a loopback port waiting to be asked for something. The island and
   the app window appear when you actually use them.

   That is the whole point of doing it this way. "Start with Windows" should
   not mean "have an app open all day"; it should mean Pico is there the
   moment you want it and invisible until then.

   A shortcut rather than a registry Run entry, because a shortcut can carry
   a window style — the console it would otherwise pop up stays minimised —
   and because it is somewhere the user can see, understand and delete.
   ========================================================================== */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'bridge', 'server.mjs');
const NAME = 'Pico.lnk';

function startupDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function shortcutPath() {
  const dir = startupDir();
  return dir ? join(dir, NAME) : null;
}

/** @returns {{supported:boolean, enabled:boolean, path:string|null}} */
export function state() {
  const path = shortcutPath();
  return {
    supported: process.platform === 'win32' && Boolean(path),
    enabled: Boolean(path && existsSync(path)),
    path,
  };
}

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => (err
        ? reject(new Error(String(stderr || stdout || err.message).trim()))
        : resolve(String(stdout).trim())));
  });
}

export async function enable() {
  const path = shortcutPath();
  if (!path) throw new Error('no Startup folder on this machine');

  // WScript.Shell is the ordinary way to write a .lnk and needs no imports
  // beyond COM — unlike anything that reaches into Win32, which antivirus
  // heuristics treat very differently.
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  await powershell([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(path)})`,
    `$s.TargetPath = ${q(process.execPath)}`,
    `$s.Arguments = '"' + ${q(SERVER)} + '"'`,
    `$s.WorkingDirectory = ${q(ROOT)}`,
    '$s.WindowStyle = 7',                      // minimised, so nothing pops up
    "$s.Description = 'Pico — desktop agent (runs quietly until you use it)'",
    '$s.Save()',
  ].join('; '));

  if (!existsSync(path)) throw new Error('the shortcut was not created');
  return state();
}

export async function disable() {
  const path = shortcutPath();
  if (path && existsSync(path)) await unlink(path).catch(() => {});
  return state();
}
