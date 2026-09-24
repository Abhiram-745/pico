/* One-move jobs planned with no model: quickplan.mjs. */
import assert from 'node:assert/strict';
import { planClick, planDrag, planShapeClick, planSearch, planChoose, matchShape, colourName, kindOf, dragLanded, valueOnScreen } from '../bridge/quickplan.mjs';

let n = 1;
const mk = (kind, role, name, rect) => ({ n: n++, kind, role, name, rect });

// The bell in Row 4, not Row 1: every word of the name, digits too.
n = 1;
const icons = [];
for (let r = 1; r <= 6; r++) for (const i of ['star', 'heart', 'bell']) icons.push(mk('control', 'Button', `${i} (row ${r})`, [100 + i.length * 40, 100 + r * 40, 30, 30]));
const bell = planClick('On the Toolbar rows page, click the bell button in Row 4.', icons);
assert.equal(bell?.name, 'bell (row 4)');
// Something left over is a job for the model, not a click.
assert.equal(planClick('On the Toolbar rows page, click the bell button in Row 4 and then close the tab.', icons), null);
// Two equally good names: not sure, so no plan.
assert.equal(planClick('click the bell', icons), null);
assert.equal(planClick('Open the settings and turn on dark mode', icons), null);

// "Three times": a count, taken out before the name is matched, and capped.
n = 1;
const adder = [mk('control', 'Button', 'Add Element', [100, 100, 120, 30]), mk('control', 'Hyperlink', 'Elemental Selenium', [100, 600, 140, 20])];
const three = planClick('On the Add/Remove Elements page, click Add Element three times.', adder);
assert.deepEqual([three?.mark, three?.times, three?.why], [1, 3, 'Clicking Add Element (1 of 3)']);
assert.equal(planClick('click the Add Element button twice', adder)?.times, 2);
assert.equal(planClick('press Add Element 5 times', adder)?.times, 5);
assert.equal(planClick('click Add Element 40 times', adder)?.times, 10);
assert.equal(planClick('click Add Element', adder)?.times, 1);
assert.equal(planClick('click Add Element three times and then delete one', adder), null);

// Search: the page's own box, the words, then Enter.
n = 1;
const wiki = [
  mk('control', 'Edit', 'Address and search bar', [300, 50, 900, 30]),
  mk('control', 'SearchBox', 'Search Wikipedia', [400, 120, 400, 34]),
  mk('control', 'Button', 'Search', [800, 120, 60, 34]),
];
const turing = planSearch('On Wikipedia, search for Alan Turing and open his article.', wiki);
assert.deepEqual([turing?.action, turing?.mark, turing?.text, turing?.then?.[0]?.keys], ['type', 2, 'Alan Turing', ['enter']]);
assert.equal(planSearch('search Wikipedia for Alan Turing', wiki)?.text, 'Alan Turing');
assert.equal(planSearch('search on Wikipedia for "Enigma machine"', wiki)?.text, 'Enigma machine');
assert.equal(planSearch('look up Alan Turing', wiki)?.text, 'Alan Turing');
// The site the box already searches is not part of the search; other places are.
assert.equal(planSearch('search for Alan Turing on Wikipedia', wiki)?.text, 'Alan Turing');
assert.equal(planSearch('search for restaurants in London', wiki)?.text, 'restaurants in London');
// "for" inside the words searched for stays there.
assert.equal(planSearch('search for Alan Turing for kids', wiki)?.text, 'Alan Turing for kids');
// Said of anything, not a search: find / look for.
assert.equal(planSearch('find the cheapest hotel for 2 nights in Paris', wiki), null);
assert.equal(planSearch('look for the Save button', wiki), null);
assert.equal(planSearch('search and replace cat with dog', wiki), null);
assert.equal(planSearch('search for it', wiki), null);
// Never the address bar, and not when two different boxes both search.
assert.equal(planSearch('search for halo', wiki.filter((k) => k.role !== 'SearchBox')), null);
assert.equal(planSearch('search for halo', [...wiki, mk('control', 'Edit', 'Search this site', [0, 0, 200, 30])]), null);

// A dropdown: the one a task names, or the page's only one when it is just "the dropdown".
n = 1;
const lonely = [mk('control', 'ComboBox', '', [300, 200, 200, 24]), mk('control', 'Hyperlink', 'Elemental Selenium', [300, 600, 140, 20])];
lonely[0].value = 'Please select an option';
const two = planChoose('On the Dropdown List page, choose Option 2 in the dropdown.', lonely);
assert.deepEqual([two?.action, two?.mark, two?.text], ['select_option', 1, 'Option 2']);
assert.equal(planChoose('select "Option 1" from the drop-down', lonely)?.text, 'Option 1');
assert.equal(planChoose('choose Option 2 in the dropdown', [{ ...lonely[0], value: 'Option 2' }])?.done, true);
// "The list" or "the menu" alone is not sure to be a select; a description is not a label.
assert.equal(planChoose('choose a file from the list', lonely), null);
assert.equal(planChoose('choose Option 2 from the list', lonely), null);
assert.equal(planChoose('choose Option 2 in the dropdown', [...lonely, mk('control', 'ComboBox', 'Sort by', [0, 0, 100, 20])]), null);
n = 1;
const pair = [mk('control', 'ComboBox', 'Dropdown (select)', [0, 0, 200, 24]), { ...mk('control', 'ComboBox', 'Dropdown (datalist)', [0, 40, 200, 24]), readOnly: false }];
assert.deepEqual([planChoose('choose Two in the Dropdown (select)', pair)?.action, planChoose('choose Two in the Dropdown (select)', pair)?.mark], ['select_option', 1]);
// A box with suggestions is typed into: Enter there submits the form.
const typed = planChoose('pick Seattle from the Dropdown datalist', pair);
assert.deepEqual([typed?.action, typed?.mark, typed?.text], ['type', 2, 'Seattle']);
assert.equal(planChoose('choose Two in the dropdown', pair), null);
assert.equal(planChoose('select all text in the editor', pair), null);

// Kanban: a quoted card into a named column.
n = 1;
const board = [
  mk('text', 'Text', 'Write report', [120, 200, 90, 18]),
  mk('text', 'Text', 'Book venue', [120, 260, 90, 18]),
  mk('text', 'Text', 'Send invoices', [760, 200, 90, 18]),
  mk('place', 'Group', 'To do', [100, 150, 300, 340]),
  mk('place', 'Group', 'Doing', [420, 150, 300, 340]),
  mk('place', 'Group', 'Done', [740, 150, 300, 340]),
];
const card = planDrag('On the Team board, move the card "Write report" into the Done column.', board);
assert.deepEqual([card?.action, card?.mark, card?.to_mark], ['drag', 1, 6]);
assert.equal(planDrag('move the card "Nothing" into the Done column', board), null);
assert.equal(planDrag('move "Send invoices" into the Done column', board)?.done, true);

// A list: to the top is onto the first of its own siblings.
n = 1;
const list = [
  ...['Apples', 'Bananas', 'Cherries', 'Dates', 'Elderberries'].map((x, i) => mk('control', 'ListItem', x, [100, 200 + i * 50, 360, 44])),
  mk('place', 'List', 'Shopping list', [96, 190, 370, 260]),
];
const top = planDrag('On the Shopping order page, drag Dates to the top of the list.', list);
assert.deepEqual([top?.mark, top?.to_mark], [4, 1]);
assert.equal(planDrag('drag Dates to the bottom of the list', list)?.to_mark, 5);
assert.equal(planDrag('drag Apples to the top of the list', list)?.done, true);

// A canvas: colour and outline, measured.
assert.equal(colourName([47, 168, 79]), 'green');
assert.equal(colourName([226, 74, 74]), 'red');
assert.equal(colourName([59, 111, 226]), 'blue');
assert.equal(colourName([240, 138, 36]), 'orange');
assert.equal(kindOf({ fill: 0.97 }), 'square');
assert.equal(kindOf({ fill: 0.78 }), 'circle');
assert.equal(kindOf({ fill: 0.5 }), 'triangle');
const shapes = [
  { rect: [0, 0, 40, 40], colour: [47, 168, 79], fill: 0.98 },
  { rect: [60, 0, 36, 36], colour: [47, 168, 79], fill: 0.79 },
  { rect: [120, 0, 44, 44], colour: [226, 74, 74], fill: 0.78 },
];
assert.equal(matchShape('green circle', shapes), shapes[1]);
assert.equal(matchShape('green', shapes), null);
n = 1;
const canvas = [mk('place', 'Image', '(unnamed picture)', [0, 0, 760, 420])];
assert.equal(planShapeClick('On the Shapes page, click the green circle.', canvas)?.target, 'green circle');
assert.equal(planShapeClick('click the green circle, then the red one', canvas), null);

// Where a planned drag should have left things, measured from the rectangles.
assert.equal(dragLanded(card.check, board), false);
const moved = board.map((k) => (k.name === 'Write report' ? { ...k, rect: [760, 240, 90, 18] } : k));
assert.equal(dragLanded(card.check, moved), true);
assert.equal(dragLanded(top.check, list), false);
const reordered = list.map((k) => (k.name === 'Dates' ? { ...k, rect: [100, 195, 360, 44] } : k.role === 'ListItem' ? { ...k, rect: [100, k.rect[1] + 50, 360, 44] } : k));
assert.equal(dragLanded(top.check, reordered), true);

// A value written on the page once, as a label and what follows it.
const receipt = ['Returns', 'Start a return using the order number on your receipt.', 'Store', 'Northgate Hardware',
  'Order number', 'NH-48213-KQ7', 'Total', '£37.40', 'Order number for the return', 'Confirm return'];
const returnTask = 'On the Returns page, put the order number from the receipt into the "Order number for the return" field and confirm the return.';
assert.equal(valueOnScreen(returnTask, receipt), 'NH-48213-KQ7');
assert.equal(valueOnScreen(returnTask, ['Order number: NH-1', 'Order number: NH-2']), null);   // two: ask instead
assert.equal(valueOnScreen(returnTask, ['Order number', 'Northgate Hardware']), null);          // not a code
assert.equal(valueOnScreen('fill in project name Halo QA', receipt), null);

console.log('quickplan ok');
