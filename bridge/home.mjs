/* ==========================================================================
   Halo — where Halo keeps things on this machine.

   One folder, %LOCALAPPDATA%\Halo, and one module that knows where it is.
   Before this, three files each worked the path out for themselves, and
   when the app was renamed from Pico two of them moved and one did not —
   so the compiled helpers went to one folder and the audit log stayed in
   another, and nothing said which was current.

   WHAT LIVES HERE
     memory.json     facts the person has told Halo to keep      (memory.mjs)
     shortcuts.json  saved tasks, run again by name              (routines.mjs)
     chats.json      every conversation, for every window        (chats.mjs)
     sense-*.exe, island-host-*.exe   compiled helpers, rebuilt on demand

   THE MOVE FROM PICO
   Everything the old name wrote is carried across once, the first time
   Halo starts: files that do not exist under the new name are copied from
   the old folder. Copied, not moved — an older Pico that is still installed
   keeps working, and a copy that goes wrong can be done again. Compiled
   helpers are left behind on purpose; they are rebuilt from source in a
   second, and a stale one is worse than none.

   Writes go through a temporary file and a rename, so a crash half way
   through saving memory leaves yesterday's memory rather than half of it.
   ========================================================================== */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const NAME = 'Halo';
const OLD_NAME = 'Pico';

/** Data files worth carrying over from the old folder. Helpers are not. */
const CARRY = /\.(?:json|jsonl|log)$/i;

let migrated = false;

function base() {
  return process.env.LOCALAPPDATA || process.env.TEMP || '.';
}

/**
 * Copy what Pico left behind into Halo's folder, once per process.
 * Returns the names of the files that were carried over, for the log.
 */
export function migrateFromPico() {
  if (migrated || process.env.HALO_HOME) return [];
  migrated = true;
  const from = join(base(), OLD_NAME);
  const to = join(base(), NAME);
  const carried = [];
  try {
    if (!existsSync(from) || !statSync(from).isDirectory()) return carried;
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (!CARRY.test(name)) continue;
      const target = join(to, name);
      if (existsSync(target)) continue;          // Halo's own copy always wins
      try {
        copyFileSync(join(from, name), target);
        carried.push(name);
      } catch { /* one unreadable file is not a reason to skip the rest */ }
    }
  } catch { /* nothing to migrate, or nowhere to put it */ }
  return carried;
}

/** Halo's folder, created if needed. */
export function dataDir() {
  migrateFromPico();
  // HALO_HOME points everything somewhere else — for tests, which must never
  // write into the real memory of the person running them.
  const dir = process.env.HALO_HOME || join(base(), NAME);
  try { mkdirSync(dir, { recursive: true }); } catch { /* read-only: callers cope */ }
  return dir;
}

export const dataPath = (file) => join(dataDir(), file);

/** Read a JSON file, or `fallback` when it is missing or unreadable. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(dataPath(file), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file whole, or not at all.
 * Returns false instead of throwing: losing a save is worth a log line, not
 * the bridge.
 */
export function writeJson(file, value) {
  const path = dataPath(file);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.warn(`[bridge] could not save ${file}: ${err.message}`);
    return false;
  }
}

/**
 * A JSON file written at most once per `delay`, and on demand.
 *
 * Chats change with every streamed word of a reply. Serialising the whole
 * archive forty times a second is work nobody needs, so writes are gathered
 * up and the last state wins.
 */
export function debouncedWriter(file, delay = 500) {
  let timer = null;
  let latest = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (latest !== null) writeJson(file, latest);
    latest = null;
  };
  process.once('exit', flush);
  return {
    write(value) {
      latest = value;
      if (!timer) timer = setTimeout(flush, delay);
      timer.unref?.();
    },
    flush,
  };
}
