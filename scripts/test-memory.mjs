#!/usr/bin/env node
/* ==========================================================================
   What Halo keeps: memory, saved shortcuts, and the chat archive.

   Everything is written to a throwaway folder (HALO_HOME), never to the
   memory of whoever runs this.

   Run with: node scripts/test-memory.mjs
   ========================================================================== */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HALO_HOME = mkdtempSync(join(tmpdir(), 'halo-test-'));
const { detect, Memory } = await import('../bridge/memory.mjs');
const { Routines } = await import('../bridge/routines.mjs');
const { ChatArchive } = await import('../bridge/chats.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};

console.log('what counts as being told something');
const TOLD = [
  ['remember that my default email is sam@work.com', { kind: 'remember', explicit: true, text: 'Your default email is sam@work.com' }],
  ['Remember I use Chrome', { kind: 'remember', explicit: true }],
  ['my brother is Ravi', { kind: 'remember', explicit: false, text: 'Your brother is Ravi' }],
  ['My sister is called Priya', { kind: 'remember', text: 'Your sister is Priya' }],
  ['my default browser is Firefox', { kind: 'remember', text: 'Your default browser is Firefox' }],
  ['I use Edge', { kind: 'remember', text: 'You use Edge' }],
  ['forget my brother', { kind: 'forget', about: 'my brother' }],
  ['what is my brother called?', null],
  ['is my brother Ravi', null],
  ['my password is hunter2', null],
  ['remember my pin is 1234', null],
  ['my brother is annoying today', null],
  ['open notepad', null],
  ['hello', null],
];
for (const [text, want] of TOLD) {
  const got = detect(text);
  const ok = want === null ? got === null : got && Object.entries(want).every(([k, v]) => got[k] === v);
  check(`${JSON.stringify(text)} -> ${want ? want.kind : 'nothing'}`, ok, JSON.stringify(got));
}

console.log('memory');
{
  const m = new Memory();
  const a = m.add('Your brother is Ravi');
  m.add('your brother is ravi.');
  check('the same thing twice is one fact', m.list().length === 1, JSON.stringify(m.list()));
  m.add('Open WhatsApp as the app', { key: 'open:whatsapp', value: 'app' });
  m.add('Open WhatsApp as the website', { key: 'open:whatsapp', value: 'site' });
  check('a keyed answer replaces the old one', m.value('open:whatsapp') === 'site' && m.list().length === 2);
  check('never a secret', m.add('my password is hunter2') === null);
  check('written for a prompt', m.forPrompt().includes('Your brother is Ravi'));
  const gone = m.forget('my brother');
  check('forgotten by description', gone.length === 1 && gone[0].id === a.id && m.list().length === 1);
  const again = new Memory().load();
  check('kept on disk', again.list().length === 1, readFileSync(join(process.env.HALO_HOME, 'memory.json'), 'utf8'));
}

console.log('shortcuts');
{
  const r = new Routines();
  const saved = r.save({ name: 'morning setup', task: 'open outlook and my calendar', steps: [{ do: 'Open Outlook' }, 'Open Calendar'] });
  check('saved with its steps as a hint', saved.steps.length === 2);
  check('run by its name', r.match('morning setup')?.id === saved.id);
  check('with run in front', r.match('run my morning setup')?.id === saved.id);
  check('with again after', r.match('Morning setup again')?.id === saved.id);
  check('not by a sentence about it', r.match('change my morning setup to open slack') === null);
  r.save({ name: 'Morning Setup', task: 'open outlook' });
  check('same name replaces', r.list().length === 1 && r.list()[0].task === 'open outlook');
  r.save({ name: 'download report', task: 'download the report' });
  check('a name that starts like a run word still matches', r.match('download report')?.name === 'download report');
  check('the note tells the planner to plan fresh', /plan it fresh/.test(Routines.note(saved)));
}

console.log('chat archive');
{
  const c = new ChatArchive();
  c.record({ id: 'm1', from: 'you', text: 'open notepad', done: true });
  c.record({ id: 'm2', from: 'pico', text: 'Op', done: false });
  c.record({ id: 'm2', from: 'pico', text: 'Opened Notepad.', done: true });
  check('a streamed reply is one message', c.current.messages.length === 2 && c.current.messages[1].text === 'Opened Notepad.');
  check('titled by what was said first', c.list()[0].title === 'open notepad');
  const first = c.currentId;
  c.start();
  c.record({ id: 'm3', from: 'you', text: 'what is the weather like', done: true });
  check('a new chat is a second chat', c.list().length === 2 && c.currentId !== first);
  check('search finds the old one by what was said', c.search('notepad').map((x) => x.id).join() === first);
  c.rename(first, 'Notepad test');
  check('renamed', c.list().find((x) => x.id === first).title === 'Notepad test');
  const msgs = c.open(first);
  check('reopened', c.currentId === first && msgs.length === 2);
  check('removing the open chat says so', c.remove(first) === true && c.currentId === null && c.list().length === 1);
  const added = c.importFrom([{ id: 'old1', title: 'from the island', updated: 5, messages: [{ id: 'x', from: 'you', text: 'hi' }] }]);
  const twice = c.importFrom([{ id: 'old1', title: 'from the island', updated: 5, messages: [{ id: 'x', from: 'you', text: 'hi' }] }]);
  check('importing an island\'s own history once, and only once', added === 1 && twice === 0);
  c.flush();
  const again = new ChatArchive().load();
  check('kept on disk', again.list().length === 2, JSON.stringify(again.list()));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
