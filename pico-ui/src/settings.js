/* ==========================================================================
   Pico — settings

   Backed by the real settings.json shape:
     { installationId, model, pauseOnPhysicalInput, maximumComputerTurns,
       overlayLeft, overlayTop }
   The API key is deliberately *not* in that file — it lives in Windows
   Credential Manager, so this form is write-only for the key and the host
   only ever reports whether one exists.
   ========================================================================== */

import { store } from './store.js';
import { bridge } from './bridge.js';

/* Only models that support the Responses API computer tool can drive the
   desktop loop. The field stays free-text because the host accepts any safe
   model ID, but these are the known-good ones. */
const KNOWN_MODELS = [
  'gpt-5.6',
  'gpt-5.4-mini',
  'computer-use-preview',
];

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
  for (const m of KNOWN_MODELS) {
    const o = document.createElement('option');
    o.value = m;
    datalist.append(o);
  }
  modelWrap.append(model, datalist);

  root.append(field(
    'Model',
    'Must support Computer use in the Responses API. Text-only models cannot drive the desktop loop.',
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
    'Recommended. Pico ignores its own synthetic events, so only genuine input pauses a run.',
    pauseWrap,
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

  // --- api key ------------------------------------------------------------
  const keyWrap = el('div', 'setting__control');
  const key = el('input', 'input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.placeholder = s.hasApiKey
    ? 'A key is already stored. Leave blank to keep it.'
    : 'No key is stored yet. An API key is required to run tasks.';
  keyWrap.append(key);

  root.append(field(
    'OpenAI API key',
    'Stored in Windows Credential Manager, never in settings.json or the audit log.',
    keyWrap,
  ));

  // --- privacy note -------------------------------------------------------
  const note = el('div', 'settings__note');
  note.append(el('strong', null, 'During a task, Pico sends full-desktop screenshots to OpenAI.'));
  note.append(el('span', null,
    ' Responses API state may be retained per your organisation’s data controls. Screenshots are never written to the local audit log.'));
  root.append(note);

  // --- save ---------------------------------------------------------------
  const actions = el('div', 'settings__actions');
  const save = el('button', 'btn btn--primary', 'Save settings');
  save.type = 'button';
  save.addEventListener('click', () => {
    const patch = {
      model: model.value.trim() || s.model,
      pauseOnPhysicalInput: pauseToggle.getAttribute('aria-checked') === 'true',
      maximumComputerTurns: Math.max(1, Number(turns.value) || s.maximumComputerTurns),
    };
    if (key.value) patch.apiKey = key.value;
    bridge.send('saveSettings', patch);
    key.value = '';
    store.setSettingsOpen(false);
  });
  actions.append(save);
  root.append(actions);

  return root;
}
