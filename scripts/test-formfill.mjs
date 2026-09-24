#!/usr/bin/env node
/* A form the task spells out, planned without a model — and left alone when
   the task does not spell it out. Run with: node scripts/test-formfill.mjs */
import assert from 'node:assert/strict';
import { planForm } from '../bridge/formfill.mjs';

const task = 'On the Halo Agent Lab page, fill in project name Halo QA, search topic desktop agents, set priority to High, enable notifications, and save the project.';
const form = [
  { type: 'Edit', name: 'Address and search bar', value: '127.0.0.1', rect: [200, 50, 900, 40] },
  { type: 'Button', name: 'Reset form', rect: [300, 600, 150, 40] },
  { type: 'Edit', name: 'Search topic', value: '', rect: [100, 400, 800, 40] },
  { type: 'Edit', name: 'Project name', value: '', rect: [100, 300, 800, 40] },
  { type: 'ComboBox', name: 'Priority', value: 'Normal', rect: [100, 480, 200, 40] },
  { type: 'CheckBox', name: 'Enable notifications', checked: false, rect: [100, 540, 20, 20] },
  { type: 'Button', name: 'Save project', rect: [100, 600, 150, 40] },
];
const plan = planForm(task, form).map((s) => [s.action, s.el.name, s.text ?? null]);
assert.deepEqual(plan, [
  ['type', 'Project name', 'Halo QA'],
  ['type', 'Search topic', 'desktop agents'],
  ['select_option', 'Priority', 'High'],
  ['click', 'Enable notifications', null],
  ['click', 'Save project', null],
], 'top to bottom, the button last; the address bar and Reset are never touched');

// Already right is not redone.
const half = form.map((el) => (el.name === 'Project name' ? { ...el, value: 'Halo QA' } : el.name === 'Enable notifications' ? { ...el, checked: true } : el));
assert.deepEqual(planForm(task, half).map((s) => s.el.name), ['Search topic', 'Priority', 'Save project']);

// Not a form the task spells out: left to the ordinary loop.
assert.equal(planForm('search wikipedia for alan turing', [{ type: 'SearchBox', name: 'Search Wikipedia', value: '', rect: [0, 0, 10, 10] }]), null);
assert.equal(planForm('send a message to John saying hi', [{ type: 'Edit', name: 'Message', value: '', rect: [0, 0, 10, 10] }, { type: 'Button', name: 'Send', rect: [0, 20, 10, 10] }]), null);

// "untick" means off.
const off = planForm('set first name Ada and last name Lovelace, untick marketing emails', [
  { type: 'Edit', name: 'First name', value: '', rect: [0, 0, 10, 10] },
  { type: 'Edit', name: 'Last name', value: '', rect: [0, 20, 10, 10] },
  { type: 'CheckBox', name: 'Marketing emails', checked: true, rect: [0, 40, 10, 10] },
]);
assert.deepEqual(off.map((s) => [s.el.name, s.text ?? s.why]), [['First name', 'Ada'], ['Last name', 'Lovelace'], ['Marketing emails', 'Unticking Marketing emails']]);

// One exact setting is enough on its own: a slider number.
const slider = planForm('On the Sound settings page, set the Volume slider to 70. Leave Bass alone.', [
  { type: 'Slider', name: 'Volume', range: [0, 100, 20], rect: [0, 0, 500, 20] },
  { type: 'Slider', name: 'Bass', range: [0, 100, 50], rect: [0, 40, 500, 20] },
]);
assert.deepEqual(slider.map((s) => [s.action, s.el.name, s.text]), [['set_value', 'Volume', '70']]);

// One field whose value is on screen, and the button the task names.
const ret = planForm('put the order number from the receipt into the "Order number for the return" field and confirm the return', [
  { type: 'Edit', name: 'Order number for the return', value: '', rect: [0, 0, 300, 30] },
  { type: 'Button', name: 'Confirm return', rect: [0, 40, 100, 30] },
]);
assert.deepEqual(ret.map((s) => [s.action, s.el.name, Boolean(s.needsValue)]), [['type', 'Order number for the return', true], ['click', 'Confirm return', false]]);

// A real page with two dropdowns told apart only by brackets, one of them a
// box with suggestions (selenium.dev's web form). The select is chosen from;
// the datalist is typed into, because Enter in it submitted the form half
// filled; and neither is mistaken for the other.
const webForm = [
  { type: 'Edit', name: 'Address and search bar', value: 'selenium.dev/selenium/web/web-form.html', rect: [200, 50, 900, 40] },
  { type: 'Edit', name: 'Text input', value: '', readOnly: false, rect: [100, 200, 400, 36] },
  { type: 'Edit', name: 'Textarea', value: '', readOnly: false, rect: [100, 320, 400, 80] },
  { type: 'ComboBox', name: 'Dropdown (select)', value: 'Open this select menu', readOnly: true, rect: [600, 200, 400, 36] },
  { type: 'ComboBox', name: 'Dropdown (datalist)', value: '', readOnly: false, rect: [600, 260, 400, 36] },
  { type: 'Button', name: 'Submit', rect: [100, 700, 100, 36] },
];
const steps = (t) => planForm(t, webForm)?.map((s) => [s.action, s.el.name, s.text ?? null]) ?? null;
assert.deepEqual(steps('On the Web form page, type Halo test into Text input, type hello from Halo into Textarea, choose Two in the Dropdown (select), then click Submit.'), [
  ['type', 'Text input', 'Halo test'],
  ['select_option', 'Dropdown (select)', 'Two'],
  ['type', 'Textarea', 'hello from Halo'],
  ['click', 'Submit', null],
], 'the datalist is left alone when only the select is named');
assert.deepEqual(steps('On the Web form page, type Seattle into the Dropdown (datalist), then click Submit.'), [
  ['type', 'Dropdown (datalist)', 'Seattle'],
  ['click', 'Submit', null],
]);
assert.deepEqual(steps('set Dropdown (datalist) to Chicago and Dropdown (select) to Three'), [
  ['select_option', 'Dropdown (select)', 'Three'],
  ['type', 'Dropdown (datalist)', 'Chicago'],
]);

console.log('Form planning: order, no-ops, refusals, tick direction and look-alike dropdowns passed.');
