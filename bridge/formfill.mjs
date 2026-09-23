/* ==========================================================================
   Halo — a form the task spells out, filled without asking a model.

   "Fill in project name Halo QA, search topic desktop agents, set priority to
   High, enable notifications, and save" names every field, every value and
   the button to finish with. Windows names every field on the page. Matching
   the two is string work, and spending two vision calls (four to five
   seconds) to have a model do that matching was most of the time a form
   took.

   So when the task and the window line up, the form becomes one batch:
   the fields top to bottom, then the one button the task names. It takes
   two fields or more; or one field and the button the task names (a search
   box and Search); or a setting that carries its own exact value (a
   dropdown choice, a slider number). A field named in the task whose value
   is on screen rather than in the words is filled from the window's text by
   the caller, or dropped. Nothing is sent: "send" is never the button. The
   batch runs through the same checks as any other (each target found again
   before it is used, stop at the first thing that goes differently), and
   the job is verified at the end the same way.
   ========================================================================== */

import { valueAfterLabel } from './fastpath.mjs';
import { requestedOption } from './select.mjs';

const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1);
const stem = (w) => w.slice(0, 5);

/** Every word of the label (by stem) appears in the task. */
const named = (task, label) => {
  const have = new Set(words(task).map(stem));
  const need = words(label).filter((w) => !['the', 'a', 'an', 'of', 'for', 'to'].includes(w));
  return need.length > 0 && need.every((w) => have.has(stem(w)));
};

const ON = /\b(?:enable|enabled|check|tick|turn on|switch on|select|opt in|agree|allow)\b/i;
const OFF = /\b(?:disable|uncheck|untick|turn off|switch off|deselect|opt out|do not|don't)\b/i;
/* Never "send": a message goes to whichever conversation is open, and that
   is decided by looking, not by matching words. */
const FINISH = /^(?:save|submit|confirm|apply|create|add|search|go|continue|next|done|ok|register|sign up|update|finish)\b/i;

/**
 * @param {string} task
 * @param {Array} elements   sense.look() elements
 * @returns {Array<{action:string, el:object, text?:string, why:string}>|null}
 */
export function planForm(task, elements = []) {
  const els = (Array.isArray(elements) ? elements : [])
    .filter((el) => el?.name && Array.isArray(el.rect) && !el.offscreen && el.enabled !== false);
  const steps = [];
  const used = new Set();

  for (const el of els) {
    const key = `${el.type}|${el.name}`;
    if (used.has(key)) continue;
    if ((el.type === 'Edit' || el.type === 'SearchBox') && el.readOnly !== true) {
      const value = valueAfterLabel(task, el.name);
      if (!value) {
        /* Named in the task, but its value is not in the task's words — "put
           the order number from the receipt into the Order number field". The
           caller fills it from what the window says, or drops the step. */
        if (named(task, el.name) && !String(el.value ?? '').trim()) {
          used.add(key);
          steps.push({ action: 'type', el, text: null, needsValue: true, why: `Filling in ${el.name}` });
        }
        continue;
      }
      used.add(key);
      if (String(el.value ?? '').trim() === value) continue;
      steps.push({ action: 'type', el, text: value, why: `Typing ${value} into ${el.name}` });
    } else if (el.type === 'Slider' && Array.isArray(el.range)) {
      const n = Number(String(requestedOption(task, el.name) ?? '').replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n) || !String(requestedOption(task, el.name) ?? '').match(/\d/)) continue;
      used.add(key);
      if (Math.abs(el.range[2] - n) < 0.5) continue;
      steps.push({ action: 'set_value', el, text: String(n), why: `Setting ${el.name} to ${n}` });
    } else if (el.type === 'ComboBox') {
      const option = requestedOption(task, el.name);
      if (!option) continue;
      used.add(key);
      if (String(el.value ?? '').trim().toLowerCase() === option.toLowerCase()) continue;
      steps.push({ action: 'select_option', el, text: option, why: `Choosing ${option} for ${el.name}` });
    } else if ((el.type === 'CheckBox' || el.type === 'RadioButton') && typeof el.checked === 'boolean' && named(task, el.name)) {
      // Said which way, near its name: "enable notifications", "untick marketing".
      const at = String(task).toLowerCase().indexOf(words(el.name).filter((w) => !ON.test(w))[0] ?? '');
      const around = at >= 0 ? String(task).slice(Math.max(0, at - 30), at + 40) : String(task);
      const want = OFF.test(around) ? false : ON.test(around) || ON.test(el.name) ? true : null;
      if (want === null) continue;
      used.add(key);
      if (el.checked === want) continue;
      steps.push({ action: 'click', el, why: `${want ? 'Ticking' : 'Unticking'} ${el.name}` });
    }
  }
  // The one button that finishes it, if the task names one.
  const finish = els.filter((el) => el.type === 'Button' && FINISH.test(String(el.name).trim()) && named(task, el.name));
  /* Enough to go on: two fields or more; or one field and the button the
     task names; or settings that carry their own exact value (a dropdown
     choice, a slider number), which cannot be misread. */
  const exact = steps.length > 0 && steps.every((st) => st.action === 'select_option' || st.action === 'set_value');
  if (!(steps.length >= 2 || (steps.length >= 1 && finish.length === 1) || exact)) return null;

  // Top to bottom, the way a person fills a form in.
  steps.sort((a, b) => (a.el.rect[1] - b.el.rect[1]) || (a.el.rect[0] - b.el.rect[0]));
  if (finish.length === 1) steps.push({ action: 'click', el: finish[0], why: `Clicking ${finish[0].name}` });
  return steps;
}
