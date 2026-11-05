/* ==========================================================================
   First run

   Shown until a model provider is configured. The key is pasted here rather
   than into a file, and the bridge validates it against OpenAI before saving
   — so a typo fails in front of you instead of on your first task.

   The endpoint behind this is loopback-only. Entering a key is safe from the
   machine the key already has to live on; it is never reachable from a paired
   phone.
   ========================================================================== */

import { mountBot } from '../react/bot.jsx';
import { isWindows } from './platform.js';

const el = (t, c, x) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (x != null) n.textContent = x;
  return n;
};

const SKIP_KEY = 'halo.setup.skipped';
const skipped = () => { try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } };
const rememberSkip = () => { try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* skipped for this load only */ } };

/** @returns {Promise<boolean>} true while the welcome gate should show. */
export async function needsSetup() {
  if (skipped()) return false;           // chose to continue without a key
  try {
    const res = await fetch('/setup/state');
    if (!res.ok) return false;            // not served by the bridge; skip setup
    const s = await res.json();
    return !s.hasKey && s.local && !s.geminiSelected;
  } catch {
    return false;                          // offline or standalone: don't block
  }
}

export function mountSetup(host, { onDone, petName = 'Halo' } = {}) {
  const root = el('div', 'setup');

  const card = el('div', 'setup__card');

  const pet = el('div', 'setup__pet');
  const bot = mountBot(pet, { size: 108, state: 'idle' });

  const title = el('h1', 'setup__title', `Hello, I'm ${petName}`);
  const lede = el('p', 'setup__lede', isWindows
    ? 'I work your Windows desktop for you — reading the screen, clicking, typing — ' +
      'and I stop to ask before anything I cannot undo.'
    : 'I am here to help with your desktop — chat any time, and I stop to ask ' +
      'before anything I cannot undo. Mouse and keyboard control needs Windows.');

  // --- step ---------------------------------------------------------------
  const step = el('div', 'setup__step');
  step.append(el('div', 'setup__steplabel', 'One thing first'));
  step.append(el('p', 'setup__stephelp',
    'Paste an OpenAI API key. It is saved on this computer only, and is never ' +
    'sent to your phone or put in a web page.'));

  const row = el('div', 'setup__row');
  const input = el('input', 'setup__input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'sk-…';
  input.setAttribute('aria-label', 'OpenAI API key');

  const reveal = el('button', 'setup__reveal', 'Show');
  reveal.type = 'button';
  reveal.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? 'Show' : 'Hide';
  });

  row.append(input, reveal);

  const error = el('p', 'setup__error');
  error.setAttribute('role', 'alert');

  const go = el('button', 'btn btn--primary setup__go', 'Continue');
  go.type = 'button';
  go.disabled = true;

  const link = el('a', 'setup__link', 'Get a key from OpenAI');
  link.href = 'https://platform.openai.com/api-keys';
  link.target = '_blank';
  link.rel = 'noreferrer';

  const skip = el('button', 'setup__link setup__skip', 'Skip for now — continue without a key');
  skip.type = 'button';
  skip.title = 'Chat, the island and Desktop view work; Agent tasks stay off until a model is set up.';

  step.append(row, error, go, link, skip);

  const foot = el('p', 'setup__foot',
    'During a task Halo sends screenshots of your desktop to OpenAI. ' +
    'Passwords and CAPTCHAs always come back to you.');

  card.append(pet, title, lede, step, foot);
  root.append(card);
  host.append(root);

  // --- behaviour ----------------------------------------------------------
  const sync = () => { go.disabled = input.value.trim().length < 20 || busy; };
  let busy = false;

  input.addEventListener('input', () => { error.textContent = ''; sync(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); submit(); }
  });
  go.addEventListener('click', submit);
  skip.addEventListener('click', () => {
    rememberSkip();
    root.classList.add('is-done');
    setTimeout(() => { root.remove(); onDone?.(); }, 420);
  });

  async function submit() {
    const key = input.value.trim();
    if (!key || busy) return;

    busy = true;
    go.textContent = 'Checking…';
    sync();
    error.textContent = '';

    try {
      const res = await fetch('/setup/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok || !body.ok) {
        error.textContent = body.error || `Could not save the key (${res.status}).`;
        return;
      }

      input.value = '';
      bot.set('success');
      root.classList.add('is-done');
      setTimeout(() => { root.remove(); onDone?.(); }, 420);
    } catch (err) {
      error.textContent = `Could not reach Halo: ${err.message}`;
    } finally {
      busy = false;
      go.textContent = 'Continue';
      sync();
    }
  }

  queueMicrotask(() => input.focus());
  return { root };
}
