#!/usr/bin/env node
/* ==========================================================================
   "Open X": what it means, and what to ask.

   The pure parts run anywhere. On Windows the resolver is also checked
   against what is really installed, which is the point of it — but those
   cases only assert shapes that hold on any machine with the named app.

   Run with: node scripts/test-apps.mjs
   ========================================================================== */

import { parseOpen, preference, readChoice, resolve, findApp } from '../bridge/apps.mjs';

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
]) {
  check(`${JSON.stringify(text)} -> ${preference(text)}`, preference(text) === want, `wanted ${want}`);
}

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
]) {
  const got = readChoice(answer, options);
  check(`${JSON.stringify(answer)} -> ${got}`, got === want, `wanted ${want}`);
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
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
