import assert from 'node:assert/strict';
import { needsMilestones, normalizeMilestones, makeMilestones } from '../bridge/milestones.mjs';
import { checkMilestoneEvidence } from '../bridge/milestone-evidence.mjs';

assert.equal(needsMilestones('Open Chrome'), false);
assert.equal(needsMilestones('Open Chrome, find the test page, fill the form, and confirm it saved'), true);
let calls = 0;
const llm = { tiers: { plan: 'gpt-4.1-mini' }, respond: async (request) => {
  calls++;
  assert.equal(request.model, 'gpt-4.1-mini');
  assert.equal(request.tools[0].function.name, 'milestone_plan');
  return { call: { name: 'milestone_plan', args: { milestones: [
    { title: 'Open test page', done_when: 'Test page heading is visible' },
    { title: 'Submit form', done_when: 'Confirmation message is visible' },
  ] } } };
} };
const direct = await makeMilestones(llm, { task: 'Open Chrome' });
assert.equal(calls, 0, 'One-step requests must avoid a planning call');
assert.equal(direct.length, 1);
const complex = await makeMilestones(llm, { task: 'Open Chrome, find the test page, fill the form, and confirm it saved' });
assert.equal(calls, 1, 'Multi-step requests get exactly one plan call');
assert.deepEqual(complex.map(s => s.id), ['m0_1', 'm0_2']);
assert.deepEqual(complex.map(s => s.doneWhen), ['Test page heading is visible', 'Confirmation message is visible']);
const revised = normalizeMilestones({ milestones: [{ title: 'Confirm saved', done_when: 'Saved banner is visible' }, { title: 'Close page', done_when: 'Page is closed' }] }, 'test', 2);
assert.deepEqual(revised.map(s => s.id), ['m2_1', 'm2_2']);
assert.equal(normalizeMilestones(null, 'Open Chrome and fill the form')[0].id, 'm0_1');
assert.equal(normalizeMilestones(null, 'Open Chrome and fill the form').length, 2, 'Failed planning still shows outcome milestones');
const fakeSense = { look: async () => ({ elements: [
  { type: 'Edit', name: 'Project name', value: '' },
  { type: 'ComboBox', name: 'Priority', value: 'High' },
  { type: 'CheckBox', name: 'Enable notifications', checked: true },
], says: ['No project saved yet.'] }) };
assert.equal((await checkMilestoneEvidence({ doneWhen: "The project name field shows the text 'Halo QA'." }, fakeSense, '1')).confirmed, false);
assert.equal((await checkMilestoneEvidence({ doneWhen: "The Priority dropdown is set to 'High' and notifications are enabled." }, fakeSense, '1')).confirmed, true);
assert.equal((await checkMilestoneEvidence({ doneWhen: "The saved project details show 'Halo QA'." }, fakeSense, '1')).confirmed, false);
console.log('Milestone routing, stable IDs, completion conditions and fallback passed.');
