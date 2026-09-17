/* ==========================================================================
   Halo — what the person has told it, kept.

   Every conversation used to start from nothing. Tell Halo which email
   account is yours on Monday and it asked again on Tuesday; say your
   brother is Ravi and "message my brother" was a question rather than a
   job. Asking the same thing twice is the fastest way for an assistant to
   feel like a form.

   So facts are kept, in %LOCALAPPDATA%\Halo\memory.json, and handed to the
   planner and to the chat model as things that are simply true.

   WHAT COUNTS AS BEING TOLD
   Deliberately narrow, and always visible:
     - "remember that …" — said outright.
     - a plain statement about yourself: "my default email is …", "my
       brother is Ravi", "I use Chrome". Not questions, not long sentences,
       not anything with a password or a code in it.
     - an answer to "the app, or the website?", so the same name is never
       asked about twice.
   Every one of them puts a line in the conversation saying what was kept,
   with a way to take it back, and every one can be seen and deleted from
   the app window. Nothing is remembered that the person was not shown.

   WHAT IS NEVER KEPT
   Anything shaped like a secret. A memory is sent to the model provider as
   part of every prompt, and a password is not something to repeat to a
   third party on every request.
   ========================================================================== */

import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './home.mjs';

const FILE = 'memory.json';
const MAX_FACTS = 200;
const MAX_LENGTH = 240;

/** Never kept, whatever else the sentence says. */
const SECRET = /\b(?:password|passcode|passphrase|pin|otp|2fa|one-?time|verification code|security code|cvv|card number|credit card|social security|ssn|api key|token|secret)\b|\bsk-[a-z0-9]/i;

const RELATIONS = 'brother|sister|mum|mom|mother|dad|father|wife|husband|partner|boyfriend|girlfriend|son|daughter|boss|manager|friend|best friend|flatmate|roommate|colleague|coworker|cousin|uncle|aunt|grandma|grandpa|grandmother|grandfather|assistant|doctor|dentist|accountant';

const THINGS = 'email|e-?mail address|email account|browser|web browser|search engine|music app|editor|code editor|text editor|calendar|phone number|address|work email|personal email|timezone|time zone|name|nickname|language|city|company|team|job|role';

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
const newId = () => `mem_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9@. ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Turn "I" into "you" so a fact reads the same to the model and the person. */
function secondPerson(text) {
  return tidy(text)
    .replace(/\bI am\b/gi, 'you are')
    .replace(/\bI'm\b/gi, "you're")
    .replace(/\bI\b/g, 'you')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bme\b/gi, 'you');
}

const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Is this message something to remember — or to forget?
 *
 * @returns {null
 *   | { kind: 'remember', text, explicit: boolean }
 *   | { kind: 'forget', about }}
 *
 * Kept as rules rather than a model call on every message. A rule is cheap,
 * predictable, and wrong in ways that can be listed; and every hit is shown
 * to the person, so a miss costs a sentence and a false positive costs a tap.
 */
export function detect(message) {
  const raw = tidy(message);
  if (!raw || raw.length > 200 || SECRET.test(raw)) return null;

  const forget = raw.match(/^(?:please\s+)?(?:forget|stop remembering|don'?t remember)\s+(?:that\s+|about\s+)?(.+)$/i);
  if (forget) return { kind: 'forget', about: tidy(forget[1]) };

  const told = raw.match(/^(?:please\s+|hey\s+halo,?\s+|halo,?\s+)?(?:remember|note|keep in mind|don'?t forget)(?:\s+that)?[,:]?\s+(.{3,})$/i);
  if (told) return { kind: 'remember', text: upperFirst(secondPerson(told[1])), explicit: true };

  // A question is never a statement of fact, however it starts.
  if (/\?\s*$/.test(raw) || /^(?:what|who|where|when|which|how|why|is|are|do|does|can|could|would|should)\b/i.test(raw)) return null;

  const relation = raw.match(new RegExp(`^(?:[Aa]nd\\s+)?[Mm]y\\s+((?:older |younger |little |big )?(?:${RELATIONS}))(?:'s name)?\\s+is\\s+(?:called\\s+)?([A-Z][\\w'-]+(?:\\s+[A-Z][\\w'-]+)?)(?:\\s*[,(-].*)?$`));
  if (relation) return { kind: 'remember', text: `Your ${relation[1].toLowerCase()} is ${relation[2]}`, explicit: false };

  const thing = raw.match(new RegExp(`^(?:and\\s+)?my\\s+((?:default |preferred |main |usual |work |personal |primary )?(?:${THINGS}))\\s+is\\s+(.{2,80})$`, 'i'));
  if (thing) return { kind: 'remember', text: `Your ${thing[1].toLowerCase()} is ${tidy(thing[2])}`, explicit: false };

  const uses = raw.match(/^i\s+(?:always\s+|usually\s+|mostly\s+)?(?:use|prefer)\s+(chrome|google chrome|edge|microsoft edge|firefox|brave|opera|arc|vivaldi|outlook|gmail|spotify|apple music|vs ?code|visual studio code|notepad\+\+|notion|obsidian|teams|slack|discord|whatsapp|telegram)(?:\s+(?:for\s+.{2,40}|as my .{2,30}))?$/i);
  if (uses) return { kind: 'remember', text: upperFirst(secondPerson(raw)), explicit: false };

  return null;
}

class Memory {
  constructor() {
    this.facts = [];
    this.loaded = false;
    this._subs = new Set();
  }

  load() {
    if (this.loaded) return this;
    const data = readJson(FILE, { facts: [] });
    this.facts = (Array.isArray(data?.facts) ? data.facts : [])
      .filter((f) => f && typeof f.id === 'string' && typeof f.text === 'string');
    this.loaded = true;
    return this;
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  _save() {
    writeJson(FILE, { facts: this.facts });
    for (const fn of this._subs) fn(this.list());
  }

  /** Newest first, as the person would read them. */
  list() {
    this.load();
    return [...this.facts].sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created));
  }

  /**
   * Keep a fact. One with the same `key` replaces the old one — you have one
   * default browser, not a history of them — and so does the same wording.
   * Returns the stored fact, or null when it was not something to keep.
   */
  add(text, { key = null, value = null, source = 'told' } = {}) {
    this.load();
    const clean = tidy(text).slice(0, MAX_LENGTH);
    if (!clean || SECRET.test(clean)) return null;

    const same = this.facts.find((f) => (key && f.key === key) || norm(f.text) === norm(clean));
    const now = Date.now();
    if (same) {
      // A new answer to a keyed question replaces the words; the same fact
      // said again only freshens it, so "ravi" typed in a hurry does not
      // overwrite "Ravi".
      const sameWords = norm(same.text) === norm(clean);
      Object.assign(same, { text: sameWords ? same.text : clean, key: key ?? same.key ?? null, value: value ?? same.value ?? null, updated: now, source });
      this._save();
      return same;
    }
    const fact = { id: newId(), text: clean, key, value, source, created: now, updated: now };
    this.facts.push(fact);
    if (this.facts.length > MAX_FACTS) {
      this.facts.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
      this.facts.length = MAX_FACTS;
    }
    this._save();
    return fact;
  }

  remove(id) {
    this.load();
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    if (this.facts.length !== before) this._save();
    return this.facts.length !== before;
  }

  /** Forget whatever best matches a description: "forget my brother". */
  forget(about) {
    this.load();
    const words = norm(secondPerson(about)).split(' ').filter((w) => w.length > 2 && !['that', 'the', 'your', 'you'].includes(w));
    if (!words.length) return [];
    const gone = this.facts.filter((f) => {
      const t = norm(f.text);
      return words.every((w) => t.includes(w));
    });
    if (!gone.length) return [];
    this.facts = this.facts.filter((f) => !gone.includes(f));
    this._save();
    return gone;
  }

  clear() {
    this.load();
    this.facts = [];
    this._save();
  }

  /** A stored value by key: `memory.value('open:whatsapp')` -> 'app'. */
  value(key) {
    this.load();
    return this.facts.find((f) => f.key === key)?.value ?? null;
  }

  /**
   * The facts, written for a prompt. Empty when there are none, so a prompt
   * never carries a heading with nothing under it.
   */
  forPrompt(limit = 40) {
    const list = this.list().slice(0, limit);
    if (!list.length) return '';
    return [
      'THINGS THE PERSON HAS TOLD YOU (true, and theirs; use them instead of asking again):',
      ...list.map((f) => `  - ${f.text}`),
    ].join('\n');
  }
}

export const memory = new Memory();
export { Memory };
