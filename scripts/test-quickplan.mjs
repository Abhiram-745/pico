/* One-move jobs planned with no model: quickplan.mjs. */
import assert from 'node:assert/strict';
import { planClick, planDrag, planShapeClick, planSearch, planChoose, planKey, planTick, planField, planAdd, planSort, planLink, planHover, matchShape, colourName, kindOf, dragLanded, valueOnScreen } from '../bridge/quickplan.mjs';
import { buildMarks } from '../bridge/marks.mjs';

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
const pair = [mk('control', 'ComboBox', 'Dropdown (select)', [0, 0, 200, 24]), { ...mk('control', 'ComboBox', 'Dropdown (datalist)', [0, 40, 200, 24]), takesText: true }];
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

/* --- the real pages ----------------------------------------------------------
   What Windows reported for each real-site QA page (scripts/qa-real.mjs),
   read from Chrome on 2026-09-24 and cut down to what these plans use. */
const REAL = {"checkbox":{"window":[0,0,2256,1432],"elements":[{"type":"Document","name":"The Internet","rect":[0,131,2256,1302],"value":"https://the-internet.herokuapp.com/check","id":"RootWebArea"},{"type":"CheckBox","name":"","rect":[400,264,20,21],"checked":false},{"type":"CheckBox","name":"","rect":[400,308,20,21],"checked":true}],"texts":[{"name":"Checkboxes","rect":[400,187,1456,57]},{"name":"checkbox 1","rect":[420,262,129,28]},{"name":"checkbox 2","rect":[420,306,129,28]}]},"number":{"window":[0,0,2256,1432],"elements":[{"type":"Edit","name":"Address and search bar","rect":[237,77,1826,37],"value":"the-internet.herokuapp.com/inputs","takesText":true,"id":"view_1012"},{"type":"Document","name":"The Internet","rect":[0,131,2256,1302],"value":"https://the-internet.herokuapp.com/input","id":"RootWebArea"},{"type":"Spinner","name":"","rect":[775,332,706,49],"takesText":true}],"texts":[{"name":"Inputs","rect":[775,187,706,57]},{"name":"Number","rect":[775,269,86,28]}]},"keys":{"window":[0,0,2256,1432],"elements":[{"type":"Edit","name":"Address and search bar","rect":[237,77,1826,37],"value":"the-internet.herokuapp.com/key_presses","takesText":true,"id":"view_1012"},{"type":"Document","name":"The Internet","rect":[0,131,2256,1302],"value":"https://the-internet.herokuapp.com/key_p","id":"RootWebArea"},{"type":"Edit","name":"","rect":[400,332,1456,49],"takesText":true,"id":"target"}],"texts":[{"name":"Key Presses","rect":[400,187,1456,57]}]},"github":{"window":[0,0,2256,1432],"elements":[{"type":"Edit","name":"Address and search bar","rect":[237,77,1778,37],"value":"github.com/Abhiram-745/pico","takesText":true,"id":"view_1012"},{"type":"Document","name":"GitHub - Abhiram-745/pico: Personal Pico desktop agent downloads · GitHub","rect":[0,131,2256,1302],"value":"https://github.com/Abhiram-745/pico","id":"RootWebArea"},{"type":"Hyperlink","name":"Releases","rect":[1620,931,93,37],"value":"https://github.com/Abhiram-745/pico/rele"},{"type":"Hyperlink","name":"+ 1 release","rect":[1620,1067,89,24],"value":"https://github.com/Abhiram-745/pico/rele"}],"texts":[]},"sort":{"window":[0,0,2256,1432],"elements":[{"type":"Document","name":"The Internet","rect":[0,131,2256,1302],"value":"https://the-internet.herokuapp.com/table","id":"RootWebArea"},{"type":"DataItem","name":"Last Name","rect":[401,505,163,48]},{"type":"DataItem","name":"First Name","rect":[563,505,166,48]},{"type":"DataItem","name":"Smith","rect":[401,553,163,48]},{"type":"DataItem","name":"John","rect":[563,553,166,48]},{"type":"DataItem","name":"Bach","rect":[401,600,163,48]},{"type":"DataItem","name":"Frank","rect":[563,600,166,48]},{"type":"DataItem","name":"Doe","rect":[401,647,163,48]},{"type":"DataItem","name":"Jason","rect":[563,647,166,48]},{"type":"DataItem","name":"Conway","rect":[401,694,163,49]},{"type":"DataItem","name":"Tim","rect":[563,694,166,49]},{"type":"DataItem","name":"Last Name","rect":[401,907,163,49]},{"type":"DataItem","name":"First Name","rect":[563,907,166,49]},{"type":"DataItem","name":"Smith","rect":[401,955,163,48]},{"type":"DataItem","name":"John","rect":[563,955,166,48]},{"type":"DataItem","name":"Bach","rect":[401,1002,163,48]},{"type":"DataItem","name":"Frank","rect":[563,1002,166,48]},{"type":"DataItem","name":"Doe","rect":[401,1049,163,48]},{"type":"DataItem","name":"Jason","rect":[563,1049,166,48]},{"type":"DataItem","name":"Conway","rect":[401,1096,163,49]},{"type":"DataItem","name":"Tim","rect":[563,1096,166,49]}],"texts":[{"name":"Example 1","rect":[400,370,1456,50]},{"name":"Example 2","rect":[400,773,1456,49]}]},"todo":{"window":[0,0,2256,1432],"elements":[{"type":"Edit","name":"Address and search bar","rect":[237,77,1826,37],"value":"todomvc.com/examples/react/dist/","takesText":true,"id":"view_1012"},{"type":"Document","name":"TodoMVC: React","rect":[0,131,2256,1302],"value":"https://todomvc.com/examples/react/dist/","id":"RootWebArea"},{"type":"Edit","name":"New Todo Input","rect":[940,326,826,98],"takesText":true}],"texts":[]},"dnd":{"window":[0,0,2256,1432],"elements":[{"type":"Document","name":"The Internet","rect":[0,131,2256,1302],"value":"https://the-internet.herokuapp.com/drag_","id":"RootWebArea"}],"texts":[{"name":"Drag and Drop","rect":[400,187,556,57]},{"name":"A","rect":[504,265,17,28]},{"name":"B","rect":[827,265,17,28]}]}};
const marksOf = (id) => buildMarks(REAL[id], { within: REAL[id].window });

// Checkboxes the page never labelled: named by the words beside them.
{
  const marks = marksOf('checkbox');
  const t = planTick('On the Checkboxes page, tick checkbox 1 and leave checkbox 2 as it is.', marks);
  assert.equal(t?.action, 'click');
  assert.equal(marks.find((k) => k.n === t.mark)?.name, 'checkbox 1');
  assert.deepEqual(t.then, [], 'checkbox 2 is left as it is');
  assert.equal(planTick('untick checkbox 2', marks)?.name, 'checkbox 2');
  assert.equal(planTick('tick checkbox 2', marks)?.done, true, 'already ticked: nothing to do');
  assert.equal(planTick('tick checkbox 1 and untick checkbox 2', marks)?.then?.length, 1);
  assert.equal(planTick('tick checkbox 1 and then submit the form', marks), null, 'something else to do: the loop');
  assert.equal(planTick('tick checkbox', marks), null, 'two fit equally: not sure');
}

// One field, by what it holds when it has no name of its own.
{
  const marks = marksOf('number');
  const f = planField('On the Inputs page, type 42 into the number box.', marks);
  assert.deepEqual([f?.action, f?.text, marks.find((k) => k.n === f?.mark)?.role], ['type', '42', 'Spinner']);
  assert.equal(planField('type 42 into the Number field', marks)?.mark, f.mark, 'or by the label above it');
  assert.equal(planField('type 42 into the address box', marks), null, 'never the browser\'s own bar');
  assert.equal(planField('type 42 into the price box', marks), null);
}

// A key, and not a button of the same name.
{
  assert.deepEqual(planKey('On the Key Presses page, press the K key.', marksOf('keys'))?.keys, ['k']);
  assert.deepEqual(planKey('hit Escape', [])?.keys, ['escape']);
  assert.deepEqual(planKey('press Ctrl+Shift+T', [])?.keys, ['ctrl', 'shift', 't']);
  assert.deepEqual(planKey('press the page down key', [])?.keys, ['pagedown']);
  assert.equal(planKey('press Delete', [{ n: 1, kind: 'control', role: 'Button', name: 'Delete', rect: [0, 0, 60, 20] }]), null, 'the button, not the key');
  assert.equal(planKey('press Add Element', []), null);
  assert.equal(planKey('press the K key and then type hello', []), null);
}

// A link called exactly that.
{
  const marks = marksOf('github');
  const l = planLink('On the GitHub page for pico, open the Releases page.', marks);
  assert.equal(marks.find((k) => k.n === l?.mark)?.name, 'Releases', 'not "+ 1 release"');
  assert.deepEqual(l.check, { title: 'Releases' });
  n = 1;
  const nav = [mk('control', 'Hyperlink', 'Virtual File System', [0, 0, 120, 20]), mk('control', 'Hyperlink', 'File system', [0, 30, 90, 20])];
  assert.equal(planLink('On the Node.js docs index, open the File system page.', nav)?.mark, 2);
  assert.equal(planLink('open Notepad', nav), null, 'an app, not a link: the opener\'s');
  assert.equal(planLink('open the Releases page and download the installer', marks), null);
}

// Sorting the table the task names, checked by reading the column.
{
  const marks = marksOf('sort');
  const s = planSort('On the Data Tables page, sort Example 1 by Last Name, A to Z.', marks);
  const header = marks.find((k) => k.n === s?.mark);
  assert.equal(header?.name, 'Last Name');
  assert.ok(header.rect[1] < 700, 'the header of Example 1, not Example 2');
  assert.equal(dragLanded(s.check, marks), false, 'as loaded: Smith, Bach, Doe, Conway');
  const names = ['Bach', 'Conway', 'Doe', 'Smith'];
  const cells = marks.filter((k) => k.role === 'DataItem' && k.rect[1] > header.rect[1] && k.rect[1] < 700 && k.rect[0] < 500).sort((a, b) => a.rect[1] - b.rect[1]);
  const sorted = marks.map((k) => (cells.includes(k) ? { ...k, name: names[cells.indexOf(k)] } : k));
  assert.equal(dragLanded(s.check, sorted), true);
  assert.equal(planSort('sort Example 1 by Last Name, Z to A', marks), null, 'the other way round: not one click');
}

// Adding a to-do, checked by seeing it on the list.
{
  const marks = marksOf('todo');
  const a = planAdd('On the TodoMVC page, add a todo called Buy milk.', marks);
  assert.deepEqual([a?.action, a?.text, a?.then?.[0]?.keys], ['type', 'Buy milk', ['enter']]);
  assert.equal(marks.find((k) => k.n === a.mark)?.name, 'New Todo Input');
  assert.equal(dragLanded(a.check, marks), null);
  assert.equal(dragLanded(a.check, [...marks, { n: 99, kind: 'text', role: 'Text', name: 'Buy milk', rect: [900, 450, 200, 40] }]), true);
  assert.equal(planAdd('add a todo called Buy milk and mark it done', marks)?.text, 'Buy milk and mark it done', 'the name is taken as said');
}

// Adding, then renaming where it is: a double-click on its words, all of them, the new ones, Enter.
{
  const marks = marksOf('todo');
  const r = planAdd('On the TodoMVC page, add a todo called Buy milk, then change it to Buy oat milk.', marks);
  assert.equal(r?.text, 'Buy milk');
  assert.deepEqual(r.then.map((t) => t.action), ['key', 'double_click', 'key', 'type', 'key']);
  assert.equal(r.then[1].markRef.name, 'Buy milk');
  assert.equal(r.then[3].text, 'Buy oat milk');
  assert.deepEqual(r.check, { shows: 'Buy oat milk' });
  assert.equal(planAdd('add a todo called Buy milk, then share the list', marks), null, 'a then it cannot do: the loop');
}

// A hover, then what it shows, found by name nearest the picture (the-internet's Hovers page).
{
  n = 1;
  const hovers = [
    ...[400, 670, 940].map((x) => mk('control', 'Image', 'User Avatar', [x, 332, 241, 241])),
    mk('control', 'Hyperlink', 'Elemental Selenium', [1087, 629, 215, 28]),
  ];
  const h = planHover('On the Hovers page, hover over the first picture and open its View profile link.', hovers);
  assert.deepEqual([h?.action, h?.mark], ['move', 1]);
  assert.deepEqual([h.then[0].action, h.then[0].markRef.name, h.then[0].markRef.rect[0]], ['click', 'View profile', 400]);
  assert.equal(planHover('hover over the third picture and open its View profile link', hovers)?.mark, 3);
  assert.equal(planHover('hover over the first picture', hovers), null, 'nothing to open: not planned');
}

// A box dragged onto another box, checked by where it is afterwards.
{
  const marks = marksOf('dnd');
  const d = planDrag('On the Drag and Drop page, drag box A onto box B.', marks);
  assert.equal(d?.action, 'drag');
  assert.deepEqual([marks.find((k) => k.n === d.mark)?.name, marks.find((k) => k.n === d.to_mark)?.name], ['A', 'B']);
  assert.equal(dragLanded(d.check, marks), false, 'not moved yet');
  const swapped = marks.map((k) => (k.name === 'A' ? { ...k, rect: [827, 265, 17, 28] } : k.name === 'B' ? { ...k, rect: [504, 265, 17, 28] } : k));
  assert.equal(dragLanded(d.check, swapped), true, 'A is where B was');
}

// A search that opens what it found is checked by the window's name.
{
  n = 1;
  const wikiBox = [mk('control', 'SearchBox', 'Search Wikipedia', [400, 120, 400, 34])];
  assert.deepEqual(planSearch('On Wikipedia, search for Alan Turing and open his article.', wikiBox)?.check?.title, 'Alan Turing');
  assert.ok(new RegExp(planSearch('search for Alan Turing and open his article', wikiBox).check.titleNot, 'i').test('Alan Turing - Search results - Wikipedia'));
  assert.deepEqual(planSearch('search for pathlib', wikiBox)?.check, { title: 'pathlib' });
  assert.equal(planSearch('search for Alan Turing and click the second result', wikiBox)?.partial, true);
}

console.log('quickplan ok');
