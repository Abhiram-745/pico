#!/usr/bin/env node
/* The last line a person reads after a task: what was done, in words, never
   a point on the screen. Run with: node scripts/test-recap.mjs */
import assert from 'node:assert/strict';
import { recap, told } from '../bridge/driver.mjs';

// A plan from the task's words names each action as it is done: turned round.
assert.equal(recap({ why: 'Ticking checkbox 1' }, 'clicked (233, 156)'), 'ticked checkbox 1');
assert.equal(recap({ why: 'Choosing Option 2 in Dropdown List' }, 'the dropdown now shows Option 2'), 'chose Option 2 in Dropdown List');
assert.equal(recap({ why: 'Searching for Alan Turing' }, 'typed "Alan Turing"'), 'searched for Alan Turing');
assert.equal(recap({ why: 'Opening Releases' }, 'clicked (946, 539)'), 'opened Releases');
assert.equal(recap({ why: 'Setting Example range to 8' }, 'Example range now reads 8'), 'set Example range to 8');

// A model's action: what the executor said, when it names the thing.
assert.equal(recap({ why: 'Click the Search button to run the search' }, 'clicked the button "Search"'), 'clicked the button "Search"');
// …and the model's own words, turned round, when all it has is a point.
assert.equal(recap({ why: 'Click the Search button' }, 'clicked (370, 230)'), 'clicked the Search button');
// Nothing to go on but the point: still something.
assert.equal(recap({}, 'clicked (370, 230)'), 'clicked (370, 230)');
assert.equal(recap({ why: 'Now the button' }, 'clicked (370, 230)'), 'now the button');

// The same thing done several times is said once.
assert.deepEqual(
  told(['clicked Add Element (1 of 3)', 'clicked Add Element (2 of 3)', 'clicked Add Element (3 of 3)']),
  ['clicked Add Element three times'],
);
assert.deepEqual(told(['typed Buy milk into New Todo Input', 'added Buy milk.', '', 'pressed Enter', 'pressed Enter']),
  ['typed Buy milk into New Todo Input', 'added Buy milk', 'pressed Enter twice']);

console.log('recap: the end of a task is said in words, repeats once — passed');
