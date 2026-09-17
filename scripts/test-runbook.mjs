#!/usr/bin/env node
/* ==========================================================================
   What worked last time: kept, found again, and never kept when it should
   not be.

   Run with: node scripts/test-runbook.mjs
   ========================================================================== */

import { Runbook, appOf } from '../bridge/runbook.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

// A runbook that writes to a file nothing else uses.
const book = new Runbook('runbook.test.json');
book.clear();

console.log('appOf');
check('from the process name', appOf({ process: 'Discord.exe', title: 'Football Lads - Discord' }) === 'discord');
check('from the window title when there is no process',
  appOf({ title: 'Inbox — Outlook' }) === 'outlook',
  appOf({ title: 'Inbox — Outlook' }));

console.log('\nrecord');
const kept = book.record({
  app: 'Discord',
  task: 'open discord and go to the claude gc',
  steps: ['Open Discord', 'Click the search box at the top of the sidebar', 'Type claude', 'Click the claude group in the results'],
});
check('a successful route is kept', Boolean(kept) && kept.steps.length === 4);
check('a one-step route is not worth keeping', book.record({ app: 'Discord', task: 'x', steps: ['Click it'] }) === null);
check('nothing with a secret in it is kept',
  book.record({ app: 'Bank', task: 'type my password into the box', steps: ['Click the field', 'Type the password'] }) === null);

console.log('\nfind');
const hit = book.find('go to the claude gc on discord', { app: 'Discord' });
check('the route comes back for the same app', hit.length === 1 && hit[0].steps.length === 4);
check('and for the app named in the task alone', book.find('open discord and find the claude gc').length === 1);
check('an unrelated task in another app finds nothing',
  book.find('write a poem in notepad', { app: 'Notepad' }).length === 0);

console.log('\nforPrompt');
const prompt = book.forPrompt('go to the claude gc', { app: 'Discord' });
check('reads as precedent, not instruction', /precedent, not instruction/i.test(prompt), prompt);
check('carries the steps', /Click the search box/.test(prompt));
check('nothing to say when nothing is known', book.forPrompt('do something new', { app: 'Excel' }) === '');

console.log('\nreplacing');
book.record({ app: 'Discord', task: 'open discord and go to the claude gc', steps: ['Open Discord', 'Press ctrl+k', 'Type claude'] });
const again = book.find('claude gc', { app: 'Discord' });
check('the same job keeps one route, the newest', again.length === 1 && again[0].steps.length === 3);

book.clear();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
