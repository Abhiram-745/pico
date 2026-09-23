/* ==========================================================================
   Is this milestone really done? Checked against what the window reports,
   not against the model's word for it.

   Three kinds of evidence, cheapest first:
     1. A named field, dropdown or checkbox the condition talks about, and the
        value Windows says it has.
     2. Quoted text the condition needs ("shows 'Halo QA'"), looked for in
        everything the window says, its values and its title.
     3. Jev, given the window's text and values and the condition, for the
        rest — about half a second, text only.

   Returns { confirmed: true }, { confirmed: false, feedback }, or null when
   nothing could be checked — and null means the model's claim stands.
   ========================================================================== */

import { milestoneMet, windowState } from './judge.mjs';

const lower = (s) => String(s ?? '').trim().toLowerCase();
const wordsOf = (s) => lower(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

export async function checkMilestoneEvidence(milestone, sense, hwnd, llm = null, { title = '', task = '', snapshot = null } = {}) {
  if (!milestone?.doneWhen || !sense || !hwnd) return null;
  // A snapshot taken this moment is used as it is, rather than asking again.
  const seen = snapshot ?? await Promise.resolve().then(() => sense.look?.(hwnd, 160)).catch(() => null);
  if (!seen?.elements?.length) return null;
  const condition = String(milestone.doneWhen);
  const elements = seen.elements;
  const says = (seen.says || []).map((x) => (typeof x === 'string' ? x : x?.text || x?.name || ''));
  const texts = (seen.texts || []).map((t) => t?.name || '');

  /* 1. Named controls and their values. */
  const checks = [];
  const field = condition.match(/\b(?:the\s+)?([a-z][a-z0-9 ]{1,45}?)\s+(?:field|box|input)\s+(?:shows|contains|has|reads)\s+(?:the\s+text\s+)?['"‘“]([^'"’”]+)['"’”]/i);
  if (field) checks.push({ name: field[1], expected: field[2], roles: ['Edit', 'SearchBox', 'ComboBox', 'Document'] });
  const dropdown = condition.match(/\b(?:the\s+)?([a-z][a-z0-9 ]{1,45}?)\s+(?:dropdown|menu|select|combo\s*box)\s+(?:is\s+)?(?:set\s+)?(?:to|shows)\s+['"‘“]?([^'"’”.,;]+)['"’”]?/i);
  if (dropdown) checks.push({ name: dropdown[1], expected: dropdown[2], roles: ['ComboBox'] });
  for (const check of checks) {
    const control = elements.find((el) => check.roles.includes(el.type) && lower(el.name) === lower(check.name));
    if (!control) continue;
    const actual = String(control.value || '').trim();
    if (lower(actual) !== lower(check.expected)) {
      return { confirmed: false, feedback: `${control.name} currently shows ${actual ? JSON.stringify(actual) : 'nothing'}, not ${JSON.stringify(check.expected.trim())}. Complete this milestone before moving on.` };
    }
  }

  /* Any checkbox the condition names, with a word saying it should be on. */
  if (/\b(?:enabled|checked|ticked|turned on|switched on|selected|on)\b/i.test(condition)) {
    // Word stems, so a box called Enable notifications matches notifications are enabled.
    const want = wordsOf(condition).map((w) => w.slice(0, 5));
    for (const box of elements.filter((el) => el.type === 'CheckBox' && typeof el.checked === 'boolean')) {
      const named = wordsOf(box.name);
      if (!named.length || !named.every((w) => want.includes(w.slice(0, 5)))) continue;
      if (!box.checked) return { confirmed: false, feedback: `"${box.name}" is not ticked yet. Complete this milestone before moving on.` };
      checks.push({ name: box.name });
    }
  }

  /* 2. Quoted text the condition needs, looked for everywhere the window says anything. */
  const everything = lower([title, ...says, ...texts, ...elements.map((el) => `${el.name ?? ''} ${el.value ?? ''}`)].join(' \n '));
  /* Only quoted text the person actually gave. A planner writing "the page
     says 'Project saved'" is guessing wording it has never seen, and holding
     the run to that guess sent it back to redo finished work. What the
     person asked for ('Halo QA') must be there; a planner's guess is left to
     Jev below. */
  const said = lower(`${task} ${milestone.do ?? ''}`);
  const quoted = [...condition.matchAll(/['"‘“]([^'"’”]{2,60})['"’”]/g)].map((m) => m[1].trim())
    .filter((q) => q && (!task || said.includes(lower(q))));
  for (const q of quoted) {
    if (!everything.includes(lower(q))) {
      return { confirmed: false, feedback: `"${q}" is not shown anywhere in the window yet. Complete this milestone before moving on.` };
    }
  }

  /* 3. Everything else: Jev reads the window's text and values against the condition. */
  const judged = await milestoneMet(llm, { milestone, state: windowState({ window: title, says: [...says, ...texts], elements }) });
  if (judged?.met === false) {
    return { confirmed: false, feedback: `The window does not show this yet: ${condition}. Complete this milestone before moving on.` };
  }
  if (judged?.met === true) return { confirmed: true, by: 'jev' };
  return checks.length || quoted.length ? { confirmed: true } : null;
}
