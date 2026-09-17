/* ==========================================================================
   Halo — saved tasks, run again by name.

   Some jobs are the same job every day: open the mail, the calendar and the
   team chat; put the music on; start the stand-up notes. Typing the whole
   thing out each morning is exactly the kind of chore Halo exists to take
   away, so a task that went well can be kept under a name — "morning setup"
   — and started again from the island with that name alone.

   CALLED ROUTINES HERE, SHORTCUTS TO THE PERSON
   shortcuts.mjs already means the fast paths for simple jobs, so this file
   has a different name to keep the two apart in the code. On screen, and
   on disk (shortcuts.json), they are shortcuts, because that is what the
   person asked for.

   NEVER A RECORDING
   What is kept is what was asked for, plus the steps it took last time as a
   hint — never the clicks. Replaying clicks is how a saved task ends up
   pressing whatever happens to be where the Send button was yesterday.
   Every run is planned fresh against the screen as it is now; the old steps
   only tell the planner what worked before.
   ========================================================================== */

import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './home.mjs';

const FILE = 'shortcuts.json';
const MAX = 60;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const norm = (s) => tidy(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const newId = () => `sc_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

/** Words that may lead a request to run one, and are not part of its name. */
const RUN_WORDS = /^(?:please\s+|halo,?\s+|hey halo,?\s+)?(?:(?:run|do|start|play|begin|kick off)\s+)?(?:my\s+|the\s+)?/i;
const TRAILING = /\s+(?:shortcut|routine|again|now|please)$/i;

class Routines {
  constructor() {
    this.items = [];
    this.loaded = false;
    this._subs = new Set();
  }

  load() {
    if (this.loaded) return this;
    const data = readJson(FILE, { shortcuts: [] });
    this.items = (Array.isArray(data?.shortcuts) ? data.shortcuts : [])
      .filter((r) => r && typeof r.id === 'string' && r.name && r.task);
    this.loaded = true;
    return this;
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  _save() {
    writeJson(FILE, { shortcuts: this.items });
    for (const fn of this._subs) fn(this.list());
  }

  /** Most recently run first (then most recently made): the order a menu wants. */
  list() {
    this.load();
    return [...this.items].sort((a, b) => ((b.lastRun ?? b.created) - (a.lastRun ?? a.created)));
  }

  get(id) {
    this.load();
    return this.items.find((r) => r.id === id) ?? null;
  }

  /**
   * Keep a task under a name. Saving under a name that already exists
   * replaces it — the person is updating "morning setup", not making a
   * second one they then have to tell apart.
   */
  save({ name, task, steps = [] }) {
    this.load();
    const cleanName = tidy(name).slice(0, 48);
    const cleanTask = tidy(task).slice(0, 2000);
    if (!cleanName || !cleanTask) return null;

    const hint = (Array.isArray(steps) ? steps : [])
      .map((s) => tidy(typeof s === 'string' ? s : s?.do))
      .filter(Boolean)
      .slice(0, 12);
    const now = Date.now();
    const same = this.items.find((r) => norm(r.name) === norm(cleanName));
    if (same) {
      Object.assign(same, { name: cleanName, task: cleanTask, steps: hint, updated: now });
      this._save();
      return same;
    }
    const item = { id: newId(), name: cleanName, task: cleanTask, steps: hint, created: now, updated: now, runs: 0, lastRun: null };
    this.items.push(item);
    if (this.items.length > MAX) {
      this.items.sort((a, b) => (b.lastRun ?? b.created) - (a.lastRun ?? a.created));
      this.items.length = MAX;
    }
    this._save();
    return item;
  }

  rename(id, name) {
    const item = this.get(id);
    const clean = tidy(name).slice(0, 48);
    if (!item || !clean) return null;
    item.name = clean;
    item.updated = Date.now();
    this._save();
    return item;
  }

  remove(id) {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (before !== this.items.length) this._save();
    return before !== this.items.length;
  }

  /** Note a run, so the most used float to the top. */
  touch(id) {
    const item = this.get(id);
    if (!item) return;
    item.runs = (item.runs ?? 0) + 1;
    item.lastRun = Date.now();
    this._save();
  }

  /**
   * The shortcut a message asks to run, or null.
   *
   * Only a message that is the name — with at most "run" in front of it or
   * "again" after — counts. "morning setup" runs it; "change my morning
   * setup so it opens Slack too" is a sentence about it, and goes to the
   * router like any other.
   */
  match(message) {
    this.load();
    if (!this.items.length) return null;
    const whole = norm(message);
    const said = norm(String(message ?? '').trim().replace(RUN_WORDS, '').replace(TRAILING, ''));
    if (!whole) return null;
    return this.items.find((r) => norm(r.name) === whole || norm(r.name) === said) ?? null;
  }

  /** What the planner is told when one of these is run. */
  static note(item) {
    const last = item.steps?.length
      ? ` Last time it took these steps: ${item.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}.`
      : '';
    return `This is the person's saved shortcut "${item.name}".${last} That is only a hint of what worked `
      + 'before: plan it fresh against what is on screen now, and skip anything that is already done.';
  }
}

export const routines = new Routines();
export { Routines };
