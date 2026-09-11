/* ==========================================================================
   Permissions

   Approving every action by hand is the main reason Pico feels slow to use,
   so this makes approval a policy you set once instead of a prompt you answer
   every time.

   Three levels:

     ask       every consequential action waits for you (the shipped default)
     smart     reversible things go ahead; anything externally visible,
               destructive, financial or account-level still asks
     all       everything auto-approves for this session

   Two rules hold at every level, because they are not preferences:

     * Takeover is never auto-answered. Passwords, CAPTCHAs and UAC are not a
       permission Pico can grant itself — it cannot type a credential at all,
       so "accept" would be meaningless.
     * "all" is session-scoped and never persisted. A blanket yes should not
       outlive the session that gave it, and should never be something you
       forgot you turned on last week.
   ========================================================================== */

const LEVEL_KEY = 'pico.permissions.v1';

export const LEVELS = {
  ask: {
    id: 'ask',
    label: 'Ask every time',
    hint: 'Nothing consequential runs without you',
  },
  smart: {
    id: 'smart',
    label: 'Auto-approve reversible',
    hint: 'Undoable actions go ahead; sending, buying and deleting still ask',
  },
  all: {
    id: 'all',
    label: 'Accept all',
    hint: 'Everything runs. This session only',
  },
};

/* Categories the local policy reports, mapped to whether "smart" lets them
   through. These names come from the app's own risk vocabulary. */
const REVERSIBLE = new Set([
  'None',
  'Navigation',
  'Selection',
  'LocalDraft',
]);

const NEVER_SMART = new Set([
  'ExternalCommunication',  // sending, posting, publishing
  'Destructive',            // deleting
  'Financial',              // buying, paying, subscribing
  'Account',                // credentials, permissions, sharing
  'Installation',           // installing or executing new software
  'SystemSettings',
]);

class Permissions {
  constructor() {
    // "all" is deliberately not read back from storage — see the header.
    const saved = this._read();
    this.level = saved === 'smart' ? 'smart' : 'ask';
    this._subs = new Set();
  }

  _read() {
    try { return localStorage.getItem(LEVEL_KEY); } catch { return null; }
  }

  subscribe(fn) {
    this._subs.add(fn);
    fn(this.level);
    return () => this._subs.delete(fn);
  }

  set(level) {
    if (!LEVELS[level]) return;
    this.level = level;
    // Persist ask/smart only. "all" lapses when the session ends.
    try {
      if (level === 'all') localStorage.removeItem(LEVEL_KEY);
      else localStorage.setItem(LEVEL_KEY, level);
    } catch { /* private mode */ }
    for (const fn of this._subs) fn(level);
  }

  /**
   * Should this approval be answered automatically?
   * @param {{risk?: {categories?: string, level?: string}}} approval
   * @returns {{auto: boolean, why: string}}
   */
  decide(approval) {
    const cats = String(approval?.risk?.categories ?? 'None');

    if (this.level === 'all') {
      return { auto: true, why: 'Accept all is on for this session' };
    }

    if (this.level === 'smart') {
      const categories = cats.split(/[,\s|]+/).filter(Boolean);
      const blocked = categories.filter((c) => NEVER_SMART.has(c));
      if (blocked.length) {
        return { auto: false, why: `${blocked.join(', ')} always asks` };
      }
      const allOk = categories.every((c) => REVERSIBLE.has(c));
      return allOk
        ? { auto: true, why: 'Reversible — auto-approved' }
        : { auto: false, why: 'Unrecognised category, so asking' };
    }

    return { auto: false, why: 'Set to ask every time' };
  }

  /** Takeover is never automatic, at any level. */
  // eslint-disable-next-line class-methods-use-this
  decideTakeover() {
    return {
      auto: false,
      why: 'Pico cannot type a credential, so this always needs you',
    };
  }
}

export const permissions = new Permissions();
