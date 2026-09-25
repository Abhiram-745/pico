#!/usr/bin/env node
/* ==========================================================================
   "Open X": what it means, and what to ask.

   The pure parts run anywhere. On Windows the resolver is also checked
   against what is really installed, which is the point of it — but those
   cases only assert shapes that hold on any machine with the named app.

   Run with: node scripts/test-apps.mjs
   ========================================================================== */

import { parseOpen, preference, readChoice, resolve, findApp, namedAsPlace, installedNamed } from '../bridge/apps.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

console.log('parseOpen');
const OPENS = [
  ['open whatsapp', { name: 'whatsapp', rest: '' }],
  ['Open Claude', { name: 'claude', rest: '' }],
  ['please open the whatsapp app', { name: 'whatsapp' }],
  ['open whatsapp web', { name: 'whatsapp' }],
  ['open claude in the browser', { name: 'claude' }],
  ['launch spotify and play some jazz', { name: 'spotify', rest: 'play some jazz' }],
  ['open whatsapp then message sam hello', { name: 'whatsapp', rest: 'message sam hello' }],
  ['go to youtube', { name: 'youtube' }],
  ['open claude.ai', { url: 'https://claude.ai' }],
  ['Open http://127.0.0.1:4177/pico-ui/fixtures/agent-lab.html in Chrome, enter project name Halo QA', { url: 'http://127.0.0.1:4177/pico-ui/fixtures/agent-lab.html', rest: 'enter project name Halo QA' }],
  ['open file explorer', { name: 'file explorer' }],
  ['can you open vs code', { name: 'vs code' }],
  ['switch to chrome', { name: 'chrome' }],
  ['open the report from last week', null],
  ['open my downloads folder', null],
  ['open a new tab', null],
  ['what is whatsapp', null],
  ['send sam a message on whatsapp', null],
];
for (const [text, want] of OPENS) {
  const got = parseOpen(text);
  const ok = want === null
    ? got === null
    : got && Object.entries(want).every(([k, v]) => got[k] === v);
  check(`${JSON.stringify(text)} -> ${JSON.stringify(got && { name: got.name, url: got.url, rest: got.rest })}`, ok, `wanted ${JSON.stringify(want)}`);
}

console.log('preference');
for (const [text, want] of [
  ['open whatsapp', null],
  ['open the whatsapp app', 'app'],
  ['open whatsapp desktop app', 'app'],
  ['open whatsapp web', 'site'],
  ['open claude in the browser', 'site'],
  ['open the claude website', 'site'],
  ['open claude.ai', 'site'],
  ['open spotify web app', 'site'],
  // Said of the app itself: "Excel online", "Outlook on the web"...
  ['open excel online', 'site'],
  ['open outlook on the web', 'site'],
  ['open the web version of word', 'site'],
  ['open word website', 'site'],
  ['open teams in the browser', 'site'],
  ['open spotify web player', 'site'],
  ['open the installed spotify', 'app'],
  ['open the spotify desktop app', 'app'],
  // ...not of the job after it, which is where these words used to count.
  ['open excel and make a budget for my online store', null],
  ['open outlook and email the website team', null],
  ['open spotify and play my online playlist', null],
  ['open whatsapp and send sam https://example.com', null],
]) {
  check(`${JSON.stringify(text)} -> ${preference(text)}`, preference(text) === want, `wanted ${want}`);
}
// With the name being opened: a plan step's, which need not be the "open X" one.
for (const [text, name, want] of [
  ['message sam on whatsapp web', 'whatsapp', 'site'],
  ['open excel online and paste the table into whatsapp', 'whatsapp', null],
  ['open excel online and paste the table into whatsapp', 'excel', 'site'],
  ['email the website team in outlook', 'outlook', null],
  ['open the whatsapp app and message sam', 'whatsapp', 'app'],
  ['open teams in the browser', 'microsoft teams', 'site'],
  // no name and no "open X": the whole text, as a chat job reads it
  ['paste each prompt into chatgpt on the web', null, 'site'],
]) {
  const got = preference(text, name);
  check(`${JSON.stringify(text)} (${name}) -> ${got}`, got === want, `wanted ${want}`);
}
check('"open the installed spotify" opens spotify', parseOpen('open the installed spotify')?.name === 'spotify');

console.log('readChoice');
const BOTH = [{ id: 'app', label: 'WhatsApp app' }, { id: 'site', label: 'WhatsApp Web' }];
const SITE_ONLY = [{ id: 'site', label: 'Open claude.ai' }, { id: 'cancel', label: 'No thanks' }];
for (const [answer, options, want] of [
  [{ choice: 'app', text: 'WhatsApp app' }, BOTH, 'app'],
  [{ choice: 'site', text: 'WhatsApp Web' }, BOTH, 'site'],
  ['the app', BOTH, 'app'],
  ['app', BOTH, 'app'],
  ['website', BOTH, 'site'],
  ['in the browser please', BOTH, 'site'],
  ['WhatsApp Web', BOTH, 'site'],
  ['yes', BOTH, null],
  ['no', BOTH, 'cancel'],
  ['yes', SITE_ONLY, 'site'],
  ['sure', SITE_ONLY, 'site'],
  ['no thanks', SITE_ONLY, 'cancel'],
  ['hmm', SITE_ONLY, null],
  // a correction, not a refusal
  ['no the claude gc on the discord', BOTH, null],
]) {
  const got = readChoice(answer, options);
  check(`${JSON.stringify(answer)} -> ${got}`, got === want, `wanted ${want}`);
}

console.log('namedAsPlace');
for (const [text, name, want] of [
  ['open discord and go to the claude gc', 'claude', true],
  ['open claude', 'claude', false],
  ['message sam on whatsapp group chat', 'whatsapp', false],
  ['open slack and post in the design channel', 'slack', false],
]) {
  check(`"${name}" in "${text}" -> ${namedAsPlace(text, name)}`, namedAsPlace(text, name) === want, `wanted ${want}`);
}

if (process.platform === 'win32') {
  console.log('resolve (this machine)');
  for (const name of ['whatsapp', 'claude', 'youtube', 'notepad', 'chrome', 'fortnite zzz']) {
    const app = await findApp(name);
    const r = await resolve(name, `open ${name}`);
    console.log(`        ${name.padEnd(13)} installed: ${app ? app.name : '—'}  ->  ${r.kind}${r.question ? `  "${r.question}"` : ''}`);
    if (name === 'youtube') check('youtube opens the site without asking', r.kind === 'site' || r.kind === 'ask');
    if (name === 'fortnite zzz') check('an unknown name is left to the planner', r.kind === 'unknown');
    if (app && ['whatsapp', 'claude'].includes(name)) check(`${name} (installed) asks app or website`, r.kind === 'ask' && r.options.length === 2);
    if (!app && ['whatsapp', 'claude'].includes(name)) check(`${name} (not installed) offers the website`, r.kind === 'missing-app');
  }
  const r = await resolve('whatsapp', 'open the whatsapp app');
  const app = await findApp('whatsapp');
  if (app) check('"the app" skips the question', r.kind === 'app');
  const w = await resolve('whatsapp', 'open whatsapp web');
  check('"web" skips the question', w.kind === 'site');

  /* An installed app is never swapped for its website because of a word in
     the rest of the job. With the app here it is the app, or the question;
     only with it missing is the website offered — and that is asked too. */
  for (const [name, text] of [
    ['excel', 'open excel and make a budget for my online store'],
    ['outlook', 'open outlook and email the website team'],
  ]) {
    const r2 = await resolve(name, text);
    check(`"${text}" -> ${r2.kind}`, r2.kind !== 'site', 'wanted the app, or the question');
  }
  check('"excel online" still means the website', (await resolve('excel', 'open excel online')).kind === 'site');

  // The shortcut matcher's and the router's view of the same list: at once, whole names only.
  const np = await findApp('notepad');
  if (np?.name === 'Notepad') check('installedNamed answers from the list already read', installedNamed('notepad')?.id === np.id);
  check('installedNamed wants the whole name', installedNamed('note') === null);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
