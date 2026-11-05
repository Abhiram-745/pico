/* ==========================================================================
   Halo — settings

   Backed by the real settings.json shape:
     { installationId, model, pauseOnPhysicalInput, maximumComputerTurns,
       overlayLeft, overlayTop }
   There is deliberately no key field here. The key lives in .env beside the
   bridge (or in Windows Credential Manager for the C# host); typing it into a
   page would mean routing a secret through the browser and over the socket to
   reach the machine it already has to live on. The host only ever reports
   whether one exists.
   ========================================================================== */

import { store } from './store.js';
import { bridge } from './bridge.js';

// Fast chat choices first; screenshots use the bridge's separate see tier.
const KNOWN_MODELS = ['gpt-4o-mini', 'gpt-5.4-nano', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-5.4-mini', 'gpt-5-mini', 'gpt-5-nano', 'o3-mini', 'o4-mini'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function field(label, help, control) {
  const wrap = el('div', 'setting');
  const head = el('div', 'setting__head');
  head.append(el('label', 'setting__label', label));
  wrap.append(head, control);
  if (help) wrap.append(el('p', 'setting__help', help));
  return wrap;
}

export function renderSettings(state) {
  const s = state.settings;
  const usingGemini = /gemini/i.test(s.provider || '');
  const root = el('div', 'settings panel-in');

  const head = el('div', 'settings__head');
  head.append(el('h2', 'settings__title', 'Settings'));
  const back = el('button', 'btn btn--ghost', 'Back');
  back.type = 'button';
  back.addEventListener('click', () => store.setSettingsOpen(false));
  head.append(back);
  root.append(head);

  // --- model -------------------------------------------------------------
  const modelWrap = el('div', 'setting__control');
  const model = el('input', 'input');
  model.type = 'text';
  model.value = s.model;
  model.setAttribute('list', 'pico-models');
  model.spellcheck = false;

  const datalist = el('datalist');
  datalist.id = 'pico-models';
  for (const m of (usingGemini ? ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] : KNOWN_MODELS)) {
    const o = document.createElement('option');
    o.value = m;
    datalist.append(o);
  }
  modelWrap.append(model, datalist);

  root.append(field(
    'Model',
    usingGemini ? 'Gemini API provider: Flash-Lite is the cheap/fast default; choose its model in installed Settings.' : 'Choose a mini or nano model. Default: gpt-4o-mini for fast replies.',
    modelWrap,
  ));

  // --- pause on physical input -------------------------------------------
  const pauseWrap = el('div', 'setting__control');
  const pauseToggle = el('button', 'switch');
  pauseToggle.type = 'button';
  pauseToggle.setAttribute('role', 'switch');
  pauseToggle.setAttribute('aria-checked', String(s.pauseOnPhysicalInput));
  pauseToggle.append(el('span', 'switch__thumb'));
  pauseToggle.addEventListener('click', () => {
    const next = pauseToggle.getAttribute('aria-checked') !== 'true';
    pauseToggle.setAttribute('aria-checked', String(next));
  });
  pauseWrap.append(pauseToggle, el('span', 'setting__inline-label', 'Pause when I touch the mouse or keyboard'));

  root.append(field(
    'Physical input',
    'Recommended. Halo ignores its own synthetic events, so only genuine input pauses a run.',
    pauseWrap,
  ));

  // --- auto-approve everything ---------------------------------------------
  const autoApproveWrap = el('div', 'setting__control');
  const autoApproveToggle = el('button', 'switch switch--danger');
  autoApproveToggle.type = 'button';
  autoApproveToggle.setAttribute('role', 'switch');
  autoApproveToggle.setAttribute('aria-checked', String(Boolean(s.autoApproveAll)));
  autoApproveToggle.append(el('span', 'switch__thumb'));
  autoApproveToggle.addEventListener('click', () => {
    const next = autoApproveToggle.getAttribute('aria-checked') !== 'true';
    if (next && !window.confirm(
      'Halo will no longer stop to ask before sending, deleting, buying, installing, or ' +
      'anything else it would normally pause for. Every action still gets logged, but ' +
      'nothing waits for you to approve it first.\n\nTurn this on?',
    )) return;
    autoApproveToggle.setAttribute('aria-checked', String(next));
  });
  autoApproveWrap.append(autoApproveToggle, el('span', 'setting__inline-label', 'Skip all approvals'));

  root.append(field(
    'Approvals',
    'Off by default. On, Halo acts on every step without asking first — only for a machine and account you fully trust. Still logged, never asked.',
    autoApproveWrap,
  ));

  // --- max turns ----------------------------------------------------------
  const turnsWrap = el('div', 'setting__control');
  const turns = el('input', 'input input--num');
  turns.type = 'number';
  turns.min = '1';
  turns.max = '500';
  turns.value = String(s.maximumComputerTurns);
  turnsWrap.append(turns);

  root.append(field(
    'Maximum turns',
    'Hard ceiling on model turns for a single task.',
    turnsWrap,
  ));

  // --- where the key lives --------------------------------------------------
  // No input here on purpose. The key is read from .env by the bridge, which
  // runs on this machine; a field in the page would mean putting a secret
  // through the browser and over the socket to get it there.
  const keyWrap = el('div', 'setting__control');
  const keyState = el('div', 'setting__inline-label',
    s.hasApiKey ? 'A key is configured' : 'No key found');
  keyWrap.append(keyState);

  root.append(field(
    'API key',
    'The bridge reads configured environment keys. Optional Gemini replies/actions require GEMINI_API_KEY and explicit provider selection in installed Settings. Watching the existing Gemini web/PWA window needs no API key. Keys stay server-side.',
    keyWrap,
  ));

  // --- privacy note -------------------------------------------------------
  const note = el('div', 'settings__note');
  note.append(el('strong', null, 'During a task, Halo sends screenshots to the selected model provider.'));
  note.append(el('span', null,
    ' Provider data controls apply. Watching uses local signals; optional desktop AI briefings remain direct OpenAI. Screenshots are never written to the local audit log.'));
  root.append(note);

  // --- save ---------------------------------------------------------------
  const actions = el('div', 'settings__actions');
  const save = el('button', 'btn btn--primary', 'Save settings');
  save.type = 'button';
  save.addEventListener('click', () => {
    const patch = {
      model: model.value.trim() || s.model,
      pauseOnPhysicalInput: pauseToggle.getAttribute('aria-checked') === 'true',
      autoApproveAll: autoApproveToggle.getAttribute('aria-checked') === 'true',
      maximumComputerTurns: Math.max(1, Number(turns.value) || s.maximumComputerTurns),
    };
    bridge.send('saveSettings', patch);
    store.setSettingsOpen(false);
  });
  actions.append(save);
  root.append(actions);

  return root;
}
