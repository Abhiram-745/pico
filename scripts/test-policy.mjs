#!/usr/bin/env node
/* What needs asking first (policy.mjs): the act, not the page it happens on.
   Run with: node scripts/test-policy.mjs */
import assert from 'node:assert/strict';
import { assess } from '../bridge/policy.mjs';

const click = (name, why, extra = {}) => ({ type: 'click', why, target: `Button "${name}"`, markedAs: { kind: 'control', role: 'Button', name }, ...extra });
const decide = (action, title) => assess(action, title).decision;

// A control that names its own act is judged by it, not by the page's title.
assert.equal(decide(click('Add Element', 'Clicking Add Element'), 'Add/Remove Elements - Google Chrome'), 'Allow');
assert.equal(decide({ type: 'type', why: 'Typing into the search box', text: 'stain', target: 'SearchBox "Search"', markedAs: { name: 'Search' } }, 'How to remove stains - Google Chrome'), 'Allow');
assert.equal(decide(click('Delete', 'Clicking Delete'), 'Add/Remove Elements - Google Chrome'), 'RequireConfirmation');

// One that only says yes means what its window means.
assert.equal(decide(click('Yes', 'Confirm'), 'Delete File'), 'RequireConfirmation');
assert.equal(decide(click('Continue', 'Carry on'), 'Checkout - Shop - Google Chrome'), 'RequireConfirmation');
assert.equal(decide({ type: 'key', why: 'Pressing Enter', keys: ['enter'] }, 'Checkout - Shop - Google Chrome'), 'RequireConfirmation');

// Buying, in the words shops use.
assert.equal(decide(click('Place your order', 'Placing the order'), 'Amazon.co.uk - Google Chrome'), 'RequireConfirmation');
assert.equal(decide(click('Buy now', 'Buying it'), 'Headphones - Google Chrome'), 'RequireConfirmation');

// Sending is still sending wherever a message can go: the window says where.
assert.equal(decide(click('Send', 'Sending the message to Ravi'), 'WhatsApp'), 'RequireConfirmation');
assert.equal(decide(click('Search', 'Submitting the search'), 'Wikipedia - Google Chrome'), 'Allow');

// Credentials are always handed back.
assert.equal(decide({ type: 'type', why: 'Typing the password', text: 'hunter2' }, 'Sign in - Google Chrome'), 'Handover');

console.log('policy: the act decides, the window says where — passed');
