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

let failed = 0;
const lines = [];

for (const [text, kind, detail] of CASES) {
  const r = matchShortcut(text);
  const gotKind = r ? r.kind : null;
  const gotDetail = r ? (r.kind === 'app' ? r.name : r.url) : '';
  const ok = gotKind === kind && (!detail || gotDetail.includes(detail));
  if (!ok) failed += 1;
  lines.push(`  ${ok ? ' ' : '✗'} ${JSON.stringify(text).padEnd(46)} ${String(gotKind).padEnd(5)} ${gotDetail}`
    + `${ok ? '' : `   (expected ${kind}${detail ? ` ~ ${detail}` : ''})`}`);
}

if (failed) {
  console.error('\n  fast paths:\n');
  for (const l of lines) console.error(l);
  console.error(`\n  ${failed} of ${CASES.length} matched wrongly.\n`);
  process.exit(1);
}

console.log(`  fast paths: ${CASES.length} requests matched correctly`);
