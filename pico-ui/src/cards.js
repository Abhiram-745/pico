/* ==========================================================================
   Pico — decision cards

   Approval and takeover are the two moments where the whole safety model
   depends on the user actually reading something. In the shipped build they
   are flat text; here they get the strongest treatment in the product.

   All copy is the app's own wording. The policy's `reason` is rendered
   verbatim rather than paraphrased — it is the thing that explains *why*
   Windows/Pico stopped, and rewording it would be a safety regression.
   ========================================================================== */

import { bridge } from './bridge.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** Human label for the policy's risk categories. */
const CATEGORY_LABEL = {
  ExternalCommunication: 'Externally visible',
  Destructive: 'Destructive',
  Installation: 'Installs software',
  Account: 'Account change',
  Financial: 'Financial',
  SystemSettings: 'System settings',
  None: 'No category',
};

export function renderApproval(approval) {
  const card = el('div', 'card card--approval card-attention panel-in');

  const head = el('div', 'card__head');
  head.append(el('div', 'card__eyebrow', 'Review this action before Pico continues.'));

  const pills = el('div', 'card__pills');
  const risk = approval.risk || {};
  if (risk.level && risk.level !== 'None') {
    pills.append(pill(`${risk.level} risk`, 'pill--danger'));
  }
  if (risk.categories && risk.categories !== 'None') {
    pills.append(pill(CATEGORY_LABEL[risk.categories] || risk.categories, 'pill--risk'));
  }
  head.append(pills);

  card.append(head);
  card.append(el('h2', 'card__summary', approval.summary));

  if (approval.target) {
    const t = el('div', 'card__target');
    t.append(el('span', 'card__target-label', 'Target'), el('span', null, approval.target));
    card.append(t);
  }

  if (risk.reason) {
    card.append(el('p', 'card__reason', risk.reason));
  }

  card.append(el('p', 'card__note', 'This approval applies once. It does not pre-authorise later steps.'));

  const actions = el('div', 'card__actions');
  const allow = el('button', 'btn btn--primary', 'Allow once');
  const cancel = el('button', 'btn btn--danger', 'Cancel task');
  allow.type = cancel.type = 'button';
  allow.addEventListener('click', () => bridge.send('approve', { id: approval.id }));
  cancel.addEventListener('click', () => bridge.send('deny', { id: approval.id }));
  actions.append(cancel, allow);
  card.append(actions);

  // The consequential button should never be the one you hit by reflex.
  queueMicrotask(() => allow.focus());
  return card;
}

export function renderTakeover(takeover) {
  const card = el('div', 'card card--takeover card-attention panel-in');

  const head = el('div', 'card__head');
  head.append(el('div', 'card__eyebrow', 'Your turn'));
  head.append(pill('Human only', 'pill'));
  card.append(head);

  card.append(el('h2', 'card__summary', 'Please complete this step manually.'));

  if (takeover.reason) card.append(el('p', 'card__reason', takeover.reason));

  if (takeover.appName) {
    const t = el('div', 'card__target');
    t.append(el('span', 'card__target-label', 'Where'), el('span', null, takeover.appName));
    card.append(t);
  }

  card.append(el('p', 'card__note',
    'Windows security and elevated prompts require direct human control. Pico will take a fresh look when you continue.'));

  const actions = el('div', 'card__actions');
  const done = el('button', 'btn btn--primary', 'I have done it — continue');
  done.type = 'button';
  done.addEventListener('click', () => bridge.send('takeoverDone', { id: takeover.id }));
  actions.append(done);
  card.append(actions);

  queueMicrotask(() => done.focus());
  return card;
}

export function renderError(error) {
  const card = el('div', 'card card--error panel-in');

  const head = el('div', 'card__head');
  head.append(el('div', 'card__eyebrow', error.title || 'Something went wrong.'));
  card.append(head);

  card.append(el('p', 'card__reason', error.message || ''));

  if (error.recoverable) {
    card.append(el('p', 'card__note', 'No desktop action was run. You can try again.'));
  }
  return card;
}

function pill(text, cls = 'pill') {
  const p = document.createElement('span');
  p.className = cls.startsWith('pill') && cls !== 'pill' ? `pill ${cls}` : 'pill';
  p.textContent = text;
  return p;
}
