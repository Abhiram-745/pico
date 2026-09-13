#!/usr/bin/env node
/* ==========================================================================
   The intent router's test suite.

   This is the one piece of logic where being wrong is visible and annoying:
   misroute a greeting and Pico takes over the desktop to type "hello" into
   whatever happens to be focused. Every phrasing below is one that has to
   keep working, so a regex tweak that fixes one case cannot quietly break
   five others.

   Only the local rules are tested. The model tiebreak is exercised by the
   cases marked `ask`, which assert that the rules correctly decline to guess.

   Run with: node scripts/test-intent.mjs
   ========================================================================== */

import { localRoute } from '../bridge/intent.mjs';

/** [message, expected] — 'ask' means the rules should defer to the model. */
const CASES = [
  // --- greetings and small talk ---
  ['hello', 'chat'],
  ['hi', 'chat'],
  ['hey there', 'chat'],
  ['good morning', 'chat'],
  ['thanks!', 'chat'],
  ['thank you', 'chat'],
  ['ok', 'chat'],
  ['lol', 'chat'],
  ['bye', 'chat'],

  // --- about Pico itself ---
  ['who are you', 'chat'],
  ['what can you do', 'chat'],
  ['what is your name', 'chat'],
  ['how does this work', 'chat'],
  ['are you there?', 'chat'],

  // --- questions answered rather than performed ---
  ['what is the capital of France', 'chat'],
  ['explain quantum tunnelling', 'chat'],
  ['why is the sky blue', 'chat'],
  ['what type of file is this', 'chat'],
  ['what is the difference between a tab and a window', 'chat'],

  // --- asked for in words, not done ---
  ['write me a poem about rain', 'chat'],
  ['tell me a joke', 'chat'],
  ['give me some ideas for a birthday present', 'chat'],
  ['come up with a name for my cat', 'chat'],

  // --- plainly work ---
  ['open chrome', 'agent'],
  ['open notepad and type hello', 'agent'],
  ['chrome', 'agent'],
  ['google.com', 'agent'],
  ['https://news.ycombinator.com', 'agent'],
  ['go to youtube', 'agent'],
  ['search for flights to tokyo', 'agent'],
  ['can you open chrome', 'agent'],
  ['please close all my tabs', 'agent'],
  ['send an email to sam about tomorrow', 'agent'],
  ['minimise everything', 'agent'],
  ['take a screenshot', 'agent'],
  ['download the invoice from my inbox', 'agent'],
  ['switch to the spotify window and play something', 'agent'],

  // --- work, even though it asks for prose: it names where to put it ---
  ['write a haiku in notepad', 'agent'],

  // --- the rules should decline rather than guess ---
  ['the report from last week', 'ask'],
  ['my calendar for tomorrow', 'ask'],
];

let failed = 0;
const lines = [];

for (const [text, want] of CASES) {
  const result = localRoute(text);
  const got = result ? result.mode : 'ask';
  const ok = got === want;
  if (!ok) failed += 1;
  lines.push(
    `  ${ok ? ' ' : '✗'} ${JSON.stringify(text).padEnd(52)} ${got.padEnd(6)}` +
    `${ok ? '' : ` (expected ${want})`}`,
  );
}

if (failed) {
  console.error('\n  intent router:\n');
  for (const l of lines) console.error(l);
  console.error(`\n  ${failed} of ${CASES.length} routed wrongly.\n`);
  process.exit(1);
}

console.log(`  intent router: ${CASES.length} messages routed correctly`);
