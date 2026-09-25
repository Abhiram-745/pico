#!/usr/bin/env node
/* ==========================================================================
   Fast-path matcher tests.

   A fast path skips the model entirely, so a false match is worse than a
   slow one: "open the report from last week" typed into Start search and
   Enter pressed launches whatever the top result is. Every case marked
   null here must keep going to the full loop.

   Run with: node scripts/test-shortcuts.mjs
   ========================================================================== */

import { matchShortcut } from '../bridge/shortcuts.mjs';

/** [message, expected kind or null, expected detail (substring of name/url)] */
const CASES = [
  ['open notepad', 'app', 'Notepad'],
  ['Open Notepad', 'app', 'Notepad'],
  ['please open chrome', 'app', 'Google Chrome'],
  ['can you launch spotify for me', 'app', 'Spotify'],
  ['open vs code', 'app', 'Visual Studio Code'],
  ['start the calculator', 'app', 'Calculator'],
  ['open file explorer', 'app', 'File Explorer'],

  ['go to github.com', 'url', 'https://github.com/'],
  ['youtube.com', 'url', 'https://youtube.com/'],
  ['open https://news.ycombinator.com', 'url', 'news.ycombinator.com'],
  ['open youtube', 'url', 'youtube.com'],
  ['go to gmail', 'url', 'mail.google.com'],
  ['search the web for otters', 'url', 'q=otters'],
  ['google best pizza near me', 'url', 'q=best%20pizza%20near%20me'],
  ['search for salt and pepper grinders', 'url', 'salt%20and%20pepper'],
  ['search lofi beats on youtube', 'url', 'search_query=lofi%20beats'],

  // --- the web, said in so many words, whatever else is named ---
  ['google cheap flights', 'url', /q=cheap%20flights$/],
  ['search for cheap flights', 'url', /q=cheap%20flights$/],
  ['look up otters online', 'url', /q=otters$/],
  ['search google for otters', 'url', /q=otters$/],
  ['google file explorer shortcuts', 'url', 'q=file%20explorer%20shortcuts'],
  ['search the web for bluetooth settings', 'url', 'q=bluetooth%20settings'],
  // a folder's name as the thing looked for, not the place looked in
  ['search for music festivals near me', 'url', 'music%20festivals'],
  ['search for a drive thru near me', 'url', 'drive%20thru'],

  // --- a search of this computer is not a web search ---
  ['search for notepad', 'app', 'Notepad'],
  ['search file explorer for Reports', null],
  ['search my documents for report', null],
  ['look up bluetooth in settings', null],
  ['search downloads for the invoice', null],
  ['search this pc for budget.xlsx', null],
  ['search spotify for jazz', null],
  ['search for jazz on spotify', null],
  ['search for the budget spreadsheet in excel', null],
  ['search for files named report', null],

  // --- must go to the full loop ---
  ['open notepad and type hello', null],
  ['open notepad then write a poem', null],
  ['open the report from last week', null],
  ['open my downloads folder', null],
  ['open a new tab', null],
  ['hello', null],
  ['close chrome', null],
  ['send an email to sam', null],
  ['search for flights then book the cheapest', null],
];

/* Anything installed counts as a place too, from the Start-menu list once it
   has been read. Which apps are here differs by machine, so these are made
   from whatever is: searching in one, or for one, is never a web search. */
const NOT_WEB = [];
if (process.platform === 'win32') {
  const { installed } = await import('../bridge/apps.mjs');
  const here = (await installed())
    .filter((a) => /^[A-Za-z][A-Za-z ]{3,24}$/.test(a.name) && !/\b(?:uninstall|help|readme|setup|web|online)\b/i.test(a.name))
    .slice(0, 5);
  for (const a of here) NOT_WEB.push(`search ${a.name} for invoices`, `search for ${a.name}`);
}

let failed = 0;
const lines = [];

for (const text of NOT_WEB) {
  const r = matchShortcut(text);
  const ok = r?.kind !== 'url';
  if (!ok) failed += 1;
  lines.push(`  ${ok ? ' ' : '✗'} ${JSON.stringify(text).padEnd(46)} ${r ? `${r.kind} ${r.url ?? r.name}` : 'null'}${ok ? '' : '   (expected no web search)'}`);
}

for (const [text, kind, detail] of CASES) {
  const r = matchShortcut(text);
  const gotKind = r ? r.kind : null;
  const gotDetail = r ? (r.kind === 'app' ? r.name : r.url) : '';
  const ok = gotKind === kind && (!detail || (detail instanceof RegExp ? detail.test(gotDetail) : gotDetail.includes(detail)));
  if (!ok) failed += 1;
  lines.push(`  ${ok ? ' ' : '✗'} ${JSON.stringify(text).padEnd(46)} ${String(gotKind).padEnd(5)} ${gotDetail}`
    + `${ok ? '' : `   (expected ${kind}${detail ? ` ~ ${detail}` : ''})`}`);
}

if (failed) {
  console.error('\n  fast paths:\n');
  for (const l of lines) console.error(l);
  console.error(`\n  ${failed} of ${CASES.length + NOT_WEB.length} matched wrongly.\n`);
  process.exit(1);
}

console.log(`  fast paths: ${CASES.length + NOT_WEB.length} requests matched correctly`);
