/* ==========================================================================
   First run

   Shown until a model provider is configured. The key is pasted here rather
   than into a file, and the bridge validates it against xkiro before saving
   — so a typo fails in front of you instead of on your first task.

   The endpoint behind this is loopback-only. Entering a key is safe from the
   machine the key already has to live on; it is never reachable from a paired
   phone.
   ========================================================================== */

import { Mascot } from './mascot.js';

const el = (t, c, x) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (x != null) n.textContent = x;
  return n;
};

/** @returns {Promise<boolean>} true once a provider is configured. */
export async function needsSetup() {
  try {
    const res = await fetch('/setup/state');
    if (!res.ok) return false;            // not served by the bridge; skip setup
    const s = await res.json();
    return !s.hasKey && s.local;
  } catch {
    return false;                          // offline or standalone: don't block
  }
}

export function mountSetup(host, { onDone, petName = 'Halo' } = {}) {
  const root = el('div', 'setup');

  const card = el('div', 'setup__card');

  const pet = el('div', 'setup__pet');
  pet.append(new Mascot({ size: 108 }).el);

  const title = el('h1', 'setup__title', `Hello, I'm ${petName}`);
  const lede = el('p', 'setup__lede',
    'I work your Windows desktop for you — reading the screen, clicking, typing — ' +
    'and I stop to ask before anything I cannot undo.');

  // --- step ---------------------------------------------------------------
  const step = el('div', 'setup__step');
  step.append(el('div', 'setup__steplabel', 'One thing first'));
  step.append(el('p', 'setup__stephelp',
    'Paste an xkiro API key. It is saved on this computer only, and is never ' +
    'sent to your phone or put in a web page.'));

  const row = el('div', 'setup__row');
  const input = el('input', 'setup__input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'sk-…';
  input.setAttribute('aria-label', 'xkiro API key');

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

  const link = el('a', 'setup__link', 'Get a free key from xkiro');
  link.href = 'https://xkiro.com/';
  link.target = '_blank';
  link.rel = 'noreferrer';

  step.append(row, error, go, link);

  const foot = el('p', 'setup__foot',
    'During a task Halo sends screenshots of your desktop to xkiro (Qwen3.8 Omni Flash). ' +
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
