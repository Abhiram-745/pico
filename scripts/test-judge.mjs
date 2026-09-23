#!/usr/bin/env node
/* Jev's quick judgements: thresholds, fallbacks, and the milestone evidence
   that uses them. No network — the evaluator is scripted.
   Run with: node scripts/test-judge.mjs */
import assert from 'node:assert/strict';
import { stagesNeeded, milestoneMet, windowState, actionWorked } from '../bridge/judge.mjs';
import { checkMilestoneEvidence } from '../bridge/milestone-evidence.mjs';
import { makeMilestones } from '../bridge/milestones.mjs';
import { valueAfterLabel } from '../bridge/fastpath.mjs';

const jev = (p) => ({ evaluate: async (state, questions) => ({ [Object.keys(questions)[0]]: { probability: p } }) });

assert.deepEqual(await stagesNeeded(jev(0.9), 'fill the form and save'), { several: true, p: 0.9 });
assert.deepEqual(await stagesNeeded(jev(0.1), 'open youtube'), { several: false, p: 0.1 });
assert.equal(await stagesNeeded(jev(0.5), 'drag Dates up'), null, 'unsure is no answer');
assert.equal(await stagesNeeded({}, 'anything'), null, 'no Jev, no answer');
assert.equal(await stagesNeeded({ evaluate: async () => { throw new Error('down'); } }, 'x'), null, 'a failure is no answer');

/* A one-step job never pays for a plan call, when Jev says so — even if the
   words would have fooled the keyword guess. */
let planned = 0;
const planner = { ...jev(0.1), tiers: { plan: 'p' }, respond: async () => { planned += 1; return null; } };
const one = await makeMilestones(planner, { task: 'Open Chrome, then check the weather and also the news' });
assert.equal(planned, 0);
assert.equal(one.length, 1);

const state = windowState({
  window: 'QA Agent Lab',
  says: ['Saved project: Halo QA.'],
  elements: [{ type: 'Edit', name: 'Project name', value: 'Halo QA' }, { type: 'CheckBox', name: 'Enable notifications', checked: true }, { type: 'Slider', name: 'Volume', range: [0, 100, 70] }],
});
assert.match(state.controlValues, /Edit "Project name" = "Halo QA"/);
assert.match(state.controlValues, /CheckBox "Enable notifications" = checked/);
assert.match(state.controlValues, /Slider "Volume" = 70/);

assert.deepEqual(await milestoneMet(jev(0.8), { milestone: { do: 'Save', doneWhen: 'Saved message shows' }, state }), { met: true, p: 0.8 });
assert.deepEqual(await milestoneMet(jev(0.1), { milestone: { do: 'Save', doneWhen: 'Saved message shows' }, state }), { met: false, p: 0.1 });
assert.equal(await milestoneMet(jev(0.5), { milestone: { do: 'Save', doneWhen: 'x' }, state }), null);

const unchanged = await actionWorked(jev(0.9), { expect: 'x', before: state, after: state });
assert.equal(unchanged.worked, false, 'nothing changed at all is not a success, whatever Jev would say');

/* Milestone evidence: named controls first, quoted text next, Jev last. */
const sense = { look: async () => ({ elements: [
  { type: 'Edit', name: 'Project name', value: 'Halo QA' },
  { type: 'CheckBox', name: 'Enable notifications', checked: false },
], says: ['No project saved yet.'] }) };
const box = await checkMilestoneEvidence({ doneWhen: 'Notifications are enabled.' }, sense, '1', jev(0.9));
assert.equal(box.confirmed, false, 'an unticked box the condition names is not done, whatever Jev says');
const quoted = await checkMilestoneEvidence({ doneWhen: "The page says 'Saved project'." }, sense, '1', jev(0.9));
assert.equal(quoted.confirmed, false, 'quoted text that is nowhere in the window is not there');
const judged = await checkMilestoneEvidence({ doneWhen: 'The project has a name.' }, sense, '1', jev(0.9));
assert.deepEqual(judged, { confirmed: true, by: 'jev' });
const refused = await checkMilestoneEvidence({ doneWhen: 'The project has been saved.' }, sense, '1', jev(0.05));
assert.equal(refused.confirmed, false);
assert.equal(await checkMilestoneEvidence({ doneWhen: 'The project has been saved.' }, sense, '1', null), null, 'nothing to go on: the claim stands');

/* A field's value read straight from the goal, with no model call — and
   left to the model whenever the words do not plainly settle it. */
const form = 'On the Halo Agent Lab page, fill in project name Halo QA, search topic desktop agents, set priority to High, enable notifications, and save the project.';
for (const [goal, label, want] of [
  [form, 'Project name', 'Halo QA'], [form, 'Search topic', 'desktop agents'], [form, 'Priority', null],
  ['search wikipedia for alan turing', 'Search Wikipedia', 'alan turing'],
  ['set the subject to "Quarterly report" and send', 'subject', 'Quarterly report'],
  ['send a message to John saying hi', 'Message', null],
  ['email bob with subject: lunch plans', 'Subject', 'lunch plans'],
  ['open the search box and type cats', 'Search', null],
  ['fill first name Ada and last name Lovelace', 'Last name', 'Lovelace'],
  // A quoted label followed by field is not a value: that one is on screen, for the model to read.
  ['put the order number from the receipt into the "Order number for the return" field and confirm', 'Order number for the return', null],
]) assert.equal(valueAfterLabel(goal, label), want, `${label} in "${goal}"`);

console.log('Judge: stage count, milestone proof, window state, action check and fallbacks passed.');
