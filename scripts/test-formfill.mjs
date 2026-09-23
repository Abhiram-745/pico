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

console.log('Form planning: order, no-ops, refusals and tick direction passed.');
