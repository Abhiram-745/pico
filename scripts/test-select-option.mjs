import assert from 'node:assert/strict';
import { execute } from '../bridge/driver.mjs';
import { requestedOption, upgradeDropdownClick } from '../bridge/select.mjs';
import { actionSpace, shouldSubmitFilledField } from '../bridge/fastpath.mjs';

assert.equal(requestedOption('Set priority to High and enable notifications', 'Priority'), 'High');
assert.equal(requestedOption("Priority dropdown shows 'High'", 'Priority'), 'High');
assert.equal(requestedOption('Set priority to High', 'Country'), null);
// A label found with its brackets taken off is not another control's label with ITS brackets.
const both = 'choose Two in the Dropdown (select), then click Submit';
assert.equal(requestedOption(both, 'Dropdown (select)'), 'Two');
assert.equal(requestedOption(both, 'Dropdown (datalist)'), null);
assert.equal(requestedOption(both, 'Dropdown'), null);
assert.deepEqual(actionSpace([{ ...{ type: 'ComboBox', name: 'Priority', rect: [20, 20, 100, 30], enabled: true, operable: true, how: 'expand', readOnly: false } }]).table[0].operations, ['CLICK']);
assert.equal(shouldSubmitFilledField({ role: 'Edit', label: 'Search topic' }), false);
assert.equal(shouldSubmitFilledField({ role: 'SearchBox', label: 'Search the web' }), true);

let value = 'Normal', pressed = '', clicks = 0;
const control = () => ({ type: 'ComboBox', name: 'Priority', id: 'priority', value, rect: [20, 20, 100, 30] });
const sense = {
  hit: async () => ({ found: true, at: control() }),
  foreground: async () => ({ hwnd: '1' }),
  look: async () => ({ elements: [control()] }),
};
const computer = {
  click: async () => { clicks++; pressed = ''; },
  keypress: async ([key]) => { if (key === 'enter') value = pressed === 'high' ? 'High' : value; else pressed += key; },
  wait: async () => {},
};
const shot = {
  toPhysical: (x, y) => ({ x, y }),
  physToScreen: (x, y) => ({ x, y }),
  width: 100, height: 100, physical: { width: 100, height: 100 },
};
const action = { type: 'select_option', target: 'Priority dropdown', text: 'High', x: 50, y: 30 };
const upgraded = await upgradeDropdownClick({ type: 'click', target: 'Priority dropdown', x: 50, y: 30 }, {
  goal: 'Set priority to High and enable notifications', shot,
  sense: { hit: async () => ({ at: control() }) },
});
assert.equal(upgraded.type, 'select_option');
assert.equal(upgraded.text, 'High');
const corrected = await upgradeDropdownClick({ type: 'click', target: 'Priority dropdown', x: 4, y: 4 }, {
  goal: 'Set priority to High', shot, windowHwnd: '1',
  sense: { hit: async () => ({ at: { type: 'Pane', name: '' } }), look: async () => ({ elements: [control()] }) },
});
assert.equal(corrected.type, 'select_option');
assert.equal(corrected.x, 70, 'Accessibility geometry replaces a bad model point');
const first = await execute({ computer, sense, shot, action });
assert.equal(first.ok, true);
assert.equal(value, 'High');
assert.equal(clicks, 1);
const already = await execute({ computer, sense, shot, action });
assert.equal(already.ok, true);
assert.equal(clicks, 1, 'A selected value must not be clicked again');
const stale = await execute({ computer, sense: { ...sense, hit: async () => ({ found: true, at: { type: 'Button', name: 'Save project' } }) }, shot, action });
assert.equal(stale.stale, true);
assert.equal(clicks, 1, 'A changed target must not be clicked');
const wrongField = await execute({ computer, sense: { focused: async () => ({ at: { type: 'Edit', name: 'Search topic' } }) }, shot,
  action: { type: 'type', target: 'Project name field', text: 'Halo QA' } });
assert.equal(wrongField.stale, true, 'Typing into a different focused field must be refused');
console.log('Native dropdown selection, verification and stale-target guard passed.');
