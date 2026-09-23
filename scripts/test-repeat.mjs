/* The same job once per item of a list: repeat.mjs. No desktop needed. */
import assert from 'node:assert/strict';
import { extractItems, readRange, selectRange, parseRepeat, splitInstruction, perItem, namedTarget, plain } from '../bridge/repeat.mjs';

/* The person's own table, as they wrote it: a number column in bold, a
   timestamp, a spec code, and the prompt with its title in bold. */
const TABLE = [
  '| # | Time | Spec | Prompt |',
  '| ------ | ------ | ------ | ------ |',
  '| **1**  | `:47`  | B11.1  | **Nervous vs hormonal response** — Split-screen. Left: cool electric blue, circuit-board style. |',
  '| **2**  | `:69`  | B11.1  | **Gland map** — Body as a control panel / night-time city skyline: each gland is a lit node. |',
  '| **3**  | `:107` | B11.2  | **Blood glucose feedback loop** — A brass balance scale with the pancreas at the pivot. |',
  '| **4**  | `:129` | B11.2  | **Type 1 vs Type 2 diabetes** — Two retro posters side by side. |',
  '| **5**  | `:150` | B11.3  | **Negative feedback** — A thermostat drawn as a friendly robot. |',
  '| **6**  | `:171` | B11.3  | **Thyroxine** — A furnace in the neck stoking the body. |',
  '| **7**  | `:190` | B11.4  | **Adrenaline** — A lightning bolt splitting into three arrows: heart, lungs, liver. |',
  '| **8**  | `:214` | B11.4  | **Menstrual cycle** — A 28-day clock face with four hormone hands. |',
].join('\n');

const t = extractItems(TABLE);
assert.equal(t.shape, 'table');
assert.equal(t.items.length, 8, 'header and separator are not items');
assert.deepEqual(t.items.map((i) => i.n), [1, 2, 3, 4, 5, 6, 7, 8], 'its own numbers, from the bold column');
assert.equal(t.items[0].title, 'Nervous vs hormonal response');
assert.equal(t.items[5].text, 'Thyroxine — A furnace in the neck stoking the body.', 'the prompt column, markdown off, title kept');
assert.ok(!t.items.some((i) => /`|\*\*/.test(i.text)), 'no markdown left in what is pasted');

// The same table pasted into the old one-line box: every row run together.
const flat = TABLE.replace(/\n/g, ' ');
const f = extractItems(flat);
assert.equal(f?.items.length, 8, 'a flattened table still comes apart into its rows');
assert.equal(f.items[6].title, 'Adrenaline');

// The person's exact message, instruction then table on one line.
const said = `on the chatgpt app from image 6 onwards paste each prompt from attached table into from image 6 onwards into chatgpt wwait for each image to generate and do up until final image please ${flat}`;
const job = parseRepeat(said, []);
assert.ok(job, 'recognised as a job over a list');
assert.equal(job.from, 'message');
assert.deepEqual(job.items.map((i) => i.n), [6, 7, 8], 'from 6 onwards, up until the final one');
assert.equal(job.all.length, 8);
assert.deepEqual(perItem(job.instruction), { how: 'chat', wait: true });
assert.equal(namedTarget(job.instruction), 'chatgpt');

// With the table attached instead: the words are the whole instruction.
const att = [{ id: 'a1', name: 'Pasted text', kind: 'text', mime: 'text/plain', size: TABLE.length, text: TABLE }];
const job2 = parseRepeat('on the chatgpt app from image 6 onwards paste each prompt from the attached table into chatgpt, wait for each image to generate, up until the final image', att);
assert.deepEqual(job2.items.map((i) => i.n), [6, 7, 8]);
assert.equal(job2.from, 'attachment');

// Ranges, read from the words only.
assert.deepEqual(readRange('from image 6 onwards'), { from: 6, to: null });
assert.deepEqual(readRange('prompts 3 to 5'), { from: 3, to: 5 });
assert.deepEqual(readRange('images 2-4 please'), { from: 2, to: 4 });
assert.deepEqual(readRange('do the first 3'), { from: 1, to: 3, first: true });
assert.deepEqual(readRange('the last 2'), { last: 2 });
assert.deepEqual(readRange('starting from the sixth one'), { from: 6, to: null });
assert.deepEqual(readRange('from prompt 3 up to prompt 7'), { from: 3, to: 7 });
assert.deepEqual(readRange('paste each prompt and wait for each image to generate'), { from: null, to: null }, '"to generate" is not a range');
assert.deepEqual(readRange('skip the first 2'), { from: 3, to: null });
assert.deepEqual(readRange('between 4 and 6'), { from: 4, to: 6 });
assert.deepEqual(readRange('only prompt 4'), { from: 4, to: 4 });

assert.deepEqual(selectRange(t.items, { from: 3, to: 5 }).map((i) => i.n), [3, 4, 5]);
assert.deepEqual(selectRange(t.items, { last: 2 }).map((i) => i.n), [7, 8]);
assert.equal(selectRange(t.items, { from: null, to: null }).length, 8);

// Numbered lists, with prompts that run over several lines.
const numbered = 'Prompts:\n1. A red fox in snow\n   at dawn, watercolour\n2. A lighthouse in a storm\n3) A city made of glass';
const n1 = extractItems(numbered);
assert.equal(n1.shape, 'numbered');
assert.deepEqual(n1.items.map((i) => i.text), ['A red fox in snow\n   at dawn, watercolour'.replace(/\n\s+/, '\n   '), 'A lighthouse in a storm', 'A city made of glass']
  .map((s) => s.replace(/[ \t]+\n/g, '\n')));
const n2 = extractItems('Image 1: a cat\nImage 2: a dog\nImage 3: a bird');
assert.deepEqual(n2.items.map((i) => [i.n, i.text]), [[1, 'a cat'], [2, 'a dog'], [3, 'a bird']]);
assert.notEqual(extractItems('2026. Budget is fine.\nNothing else here')?.shape, 'numbered', 'a year is not a list number');

// Bullets, headings, paragraphs, lines.
assert.equal(extractItems('- one thing\n- another thing\n- a third').items.length, 3);
const h = extractItems('## Image 1\nA calm lake\n\n## Image 2\nA busy market');
assert.deepEqual(h.items.map((i) => [i.n, i.text]), [[1, 'A calm lake'], [2, 'A busy market']]);
assert.equal(extractItems('First paragraph about foxes.\n\nSecond paragraph about owls.').shape, 'paragraphs');
assert.equal(extractItems('alpha\nbeta\ngamma').shape, 'lines');

// Not a list job: one thing, said once.
assert.equal(parseRepeat('open notepad and type hello', []), null);
assert.equal(parseRepeat('do these in order:\n1. open notepad\n2. type hello\n3. save it', []), null, 'steps of one job are not a list to repeat');
assert.equal(parseRepeat('send the attached prompt in the chat', [{ kind: 'text', text: 'Draw a fox.' }]), null, 'one prompt is one job, not a list');
assert.ok(parseRepeat('send each of these to claude', [{ kind: 'text', name: 'a.txt', text: 'one' }, { kind: 'text', name: 'b.txt', text: 'two' }]), 'several files, each');

// The split between what to do and the list it is done over.
const s = splitInstruction('paste each of these into claude:\n1. hello there\n2. and again', []);
assert.equal(s.instruction, 'paste each of these into claude:');
assert.equal(extractItems(s.listText).items.length, 2);

// What each item is for.
assert.deepEqual(perItem('send each of these to Dad on WhatsApp'), { how: 'chat', wait: false });
assert.deepEqual(perItem('ask claude each question and wait for the answer'), { how: 'chat', wait: true });
assert.equal(perItem('search each name on wikipedia').how, 'task');
assert.equal(namedTarget('in lovable, prompt each change'), 'lovable');

assert.equal(plain('**Bold** and `code` and *soft*'), 'Bold and code and soft');

console.log('repeat: all passed');
