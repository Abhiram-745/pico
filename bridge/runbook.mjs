/* ==========================================================================
   Halo — what worked last time.

   Facts (memory.mjs) are things the person told Halo. This is the other
   half: things Halo found out by doing the job. They are not the same, and
   keeping them apart matters — one is somebody's word and is never guessed
   at, the other is Halo's own experience and is allowed to be wrong.

   WHY
   Every run used to start from a screenshot and nothing else. Halo had
   worked out on Monday that the group chat in Discord is found by clicking
   the search box at the top of the sidebar, and on Tuesday it worked it out
   again, from scratch, badly, with the same three wrong clicks in the
   middle. A desktop is not a fresh puzzle every morning; the way to do a
   thing in an app is the same thing it was yesterday.

   So a run that succeeds leaves behind the route it took, filed under the
   app it happened in, and the planner is shown it next time that app comes
   up. It is offered as precedent, not instruction: the screen is still the
   authority, and a route that no longer matches what is there is meant to
   be ignored.

   WHAT IS KEPT
   The task as it was asked, and the steps that actually finished — nothing
   typed, nothing read off the screen, no window titles. Steps are short
   imperative lines the planner wrote ("Click the search box"), so they
   carry no content of their own. Anything shaped like a secret keeps the
   whole entry out, on the same principle as memory.mjs: this goes into a
   prompt, and a prompt goes to a model provider.
   ========================================================================== */

import { readJson, writeJson } from './home.mjs';

const FILE = 'runbook.json';

/** Per app, because that is what a route belongs to. */
const MAX_PER_APP = 6;
const MAX_APPS = 40;
const MAX_STEPS = 8;
const MAX_LEN = 160;

/** The same test memory.mjs uses. A route is prompt text like any other. */
const SECRET = /\b(?:password|passcode|passphrase|pin|otp|2fa|one-?time|verification code|security code|cvv|card number|credit card|social security|ssn|api key|token|secret)\b|\bsk-[a-z0-9]/i;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => tidy(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Words worth matching a new task against an old one on. */
const STOP = new Set([
  'the', 'a', 'an', 'my', 'me', 'to', 'in', 'on', 'at', 'of', 'for', 'and', 'then', 'with', 'please',
  'open', 'go', 'it', 'that', 'this', 'from', 'into', 'up', 'out', 'is', 'are', 'do', 'can', 'you',
]);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/** App name from a window: "Football Lads — Discord" is Discord's. */
export function appOf(window) {
  const raw = tidy(window?.process || window?.app || '');
  const name = raw.replace(/\.exe$/i, '');
  if (name) return name.toLowerCase();
  const title = tidy(window?.title || '');
  const tail = title.split(/[-—|]/).pop();
  return norm(tail).slice(0, 40);
}

export class Runbook {
  constructor(file = FILE) {
    this.file = file;
    this.byApp = new Map(Object.entries(readJson(file, {})));
  }

  save() {
    writeJson(this.file, Object.fromEntries([...this.byApp.entries()].slice(-MAX_APPS)));
  }

  /**
   * Keep the route a successful run took.
   *
   * @param {object} run
   *   app    which application it happened in
   *   task   what was asked, as it was asked
   *   steps  the steps that finished
   */
  record({ app, task, steps }) {
    const key = norm(app);
    const job = tidy(task).slice(0, MAX_LEN);
    const route = (Array.isArray(steps) ? steps : [])
      .map((s) => tidy(typeof s === 'string' ? s : s?.do).slice(0, MAX_LEN))
      .filter(Boolean)
      .slice(0, MAX_STEPS);

    if (!key || !job || route.length < 2) return null;
    if (SECRET.test(job) || route.some((s) => SECRET.test(s))) return null;

    const entry = { task: job, steps: route, when: Date.now(), used: 0 };
    const list = (this.byApp.get(key) ?? [])
      // One route per job: the newest way of doing a thing replaces the old
      // one rather than sitting next to it, contradicting it.
      .filter((e) => norm(e.task) !== norm(job));
    list.unshift(entry);
    this.byApp.set(key, list.slice(0, MAX_PER_APP));
    this.save();
    return entry;
  }

  /**
   * Routes worth showing the planner for this task, best first.
   *
   * Scored on words the two tasks share, with the app it is about counting
   * for a lot: a route from the right app is nearly always more use than a
   * closely-worded one from the wrong app.
   */
  find(task, { app = '', limit = 2 } = {}) {
    const asked = new Set(words(task));
    const here = norm(app);
    const out = [];

    for (const [key, list] of this.byApp) {
      const sameApp = here && (key === here || asked.has(key));
      if (!sameApp && !asked.has(key)) continue;
      for (const e of list) {
        const shared = words(e.task).filter((w) => asked.has(w)).length;
        const score = (sameApp ? 3 : 0) + shared;
        if (score > 0) out.push({ ...e, app: key, score });
      }
    }

    return out.sort((a, b) => b.score - a.score || b.when - a.when).slice(0, limit);
  }

  /** Those routes, as a line the planner can read. Empty when there are none. */
  forPrompt(task, { app = '' } = {}) {
    const found = this.find(task, { app });
    if (!found.length) return '';
    const lines = found.map((e) => `In ${e.app}, "${e.task}" was done like this: ${e.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
    return [
      'WHAT WORKED BEFORE, on this computer:',
      ...lines,
      'Treat it as precedent, not instruction. The screen in front of you decides;',
      'if it does not match, plan from what you can see.',
    ].join('\n');
  }

  list() {
    return [...this.byApp.entries()].flatMap(([app, list]) => list.map((e) => ({ app, ...e })));
  }

  clear() {
    this.byApp = new Map();
    this.save();
  }
}

export const runbook = new Runbook();
