/* ==========================================================================
   The bridge's own log, on disk.

   The bridge used to write only to its console window, so when Halo
   disappeared — the console closed, a crash, the machine asleep through a
   restart — there was nothing afterwards to say which. Everything it prints
   now also goes to %LOCALAPPDATA%\Halo\bridge.log, with the time, and every
   way out of the process leaves its reason there as the last line.

   Kept small: past 1 MB the file is moved to bridge.old.log and started
   again, so it never grows without end. Never the key: console output
   already goes through redact() where a key could appear, and nothing else
   is added here.
   ========================================================================== */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { format } from 'node:util';
import { dataPath } from './home.mjs';

const LIMIT = 1024 * 1024;

export function logToDisk({ build = '' } = {}) {
  if (process.env.HALO_NO_LOG) return;
  const file = dataPath('bridge.log');
  let size = 0;
  try { size = statSync(file).size; } catch { /* first run */ }
  if (size > LIMIT) { try { renameSync(file, dataPath('bridge.old.log')); size = 0; } catch { /* keep appending */ } }

  const write = (level, args) => {
    // The console's colours are escape codes, which are noise in a file.
    const line = `${new Date().toISOString()} ${level} ${format(...args).replace(/\x1b\[[0-9;]*m/g, '')}\n`;
    try { appendFileSync(file, line); size += line.length; } catch { /* a full disk is not a reason to stop */ }
    if (size > LIMIT) { try { renameSync(file, dataPath('bridge.old.log')); size = 0; } catch { /* next time */ } }
  };
  for (const [name, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const own = console[name].bind(console);
    console[name] = (...args) => { own(...args); write(level, args); };
  }
  write('info', [`[bridge] started — build ${build || '?'}, pid ${process.pid}, node ${process.version}`]);

  /* Why it stopped, as the last thing in the file. A closed console window
     is SIGHUP on Windows; Ctrl+C is SIGINT. */
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.prependListener(sig, () => write('info', [`[bridge] stopping: ${sig}${sig === 'SIGHUP' ? ' (its console window was closed)' : ''}`])); } catch { /* not on this platform */ }
  }
  process.prependListener('exit', (code) => write('info', [`[bridge] exited with code ${code}`]));
  return file;
}
