/* ==========================================================================
   Halo — the same job, once per item of a list.

   "From image 6 onwards, paste each prompt from the attached table into
   ChatGPT, wait for each image, and carry on to the last one."

   That is not one piece of work with a finish line, which is the only shape
   the loop in driver.mjs knows. It is a short job — put this text in that
   box, send it, wait — done twenty times over, and the hard part is not any
   one of the twenty. It is keeping hold of the list: which items, in what
   order, exactly as written, starting where the person said and stopping
   where they said. A model asked to do the whole thing from a screenshot
   loses the list inside two items. Measured on the person's own run: it sent
   prompt 2, said prompt 1 had not gone, and stopped — having been asked for 6
   onwards.

   So the list is taken apart here, in code, where it cannot drift:

     the items      out of a markdown table, a numbered or bulleted list,
                    headed sections, paragraphs or lines — whichever the text
                    actually is — verbatim, never retyped by a model
     the range      "from 6 onwards", "3 to 9", "the first five", "up until
                    the final one", matched against the list's own numbers
                    when it has them and positions when it does not
     the target     the app the words name, or the window in front

   and job.mjs carries them out, one item at a time, in the open.

   Everything in this file is a pure function of the words and the list, so
   it is tested without a desktop (scripts/test-repeat.mjs).
   ========================================================================== */

/* Words that say "do it for each one" rather than "do it once". Checked on
   the instruction only — the list itself is full of words like "every".
   Not "in order": "do these in order: 1. open Notepad 2. type hello" is one
   job written as its steps, and taken apart it would be three separate
   runs, each with no idea the others happened. */
const EACH = /\b(?:each|every|all (?:of )?(?:the|these|those|my)|one by one|one at a time|one after (?:another|the other)|in turn|for all|them all|all \d+|each of)\b/i;

/* What an item is called in the instruction: "image 6", "prompt 3", "row 2". */
const UNIT = '(?:images?|imgs?|pictures?|pics?|prompts?|items?|rows?|lines?|numbers?|no\\.?|entr(?:y|ies)|questions?|messages?|slides?|posts?|ones?|#)';

const ORDINALS = new Map(Object.entries({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
}));
const NUMBER_WORDS = [...ORDINALS.keys()].sort((a, b) => b.length - a.length).join('|');

/** "sixth" -> 6, "6th" -> 6, "6" -> 6. */
function toNumber(word) {
  const w = String(word ?? '').toLowerCase().trim();
  if (ORDINALS.has(w)) return ORDINALS.get(w);
  const n = Number(w.replace(/(?:st|nd|rd|th)$/, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Markdown emphasis off, so what is pasted is what a person would paste. */
export function plain(text) {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const firstWords = (text, n = 7) => {
  const words = plain(text).replace(/\s+/g, ' ').split(' ').filter(Boolean);
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
};

/* --------------------------------------------------------------------------
   Taking the list apart
   -------------------------------------------------------------------------- */

/**
 * A table pasted into a one-line box arrives as one line: every row run into
 * the next, "| … | | ---- | ---- | | **2** | …". Put the rows back on lines of
 * their own before reading it. Only where a row visibly ends and the next
 * begins with a number or a separator, so a pipe inside a prompt is left alone.
 */
function unflattenTable(text) {
  const t = String(text ?? '');
  if (!/\|/.test(t) || (t.match(/\|/g) || []).length < 6) return t;
  return t
    .replace(/\|\s+\|(?=\s*:?-{3,})/g, '|\n|')
    .replace(/\|\s+\|(?=\s*(?:\*\*|__)?\s*#?\d{1,4}\s*(?:\*\*|__)?\s*\|)/g, '|\n|');
}

function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
const numberIn = (cell) => {
  const m = String(cell ?? '').replace(/[*_`#\s]/g, '').match(/^(?:no\.?|n)?(\d{1,4})\.?$/i);
  return m ? Number(m[1]) : null;
};

/** The rows of a markdown table, as items. Null when the text holds no table. */
function fromTable(text) {
  const lines = unflattenTable(text).split(/\r?\n/);
  const rows = [];
  const cut = [];              // rows whose line stops before its closing pipe
  let header = null;
  for (const line of lines) {
    if (!/^\s*\|.*\|/.test(line)) continue;
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    if (isSeparator(cells)) {
      /* The row above a separator is the header, not an item — unless it
         plainly is an item. The person's own table had no header at all:
         its first row was prompt 1, and markdown's rule would have quietly
         dropped it. A numbered first cell or a paragraph in a cell is data. */
      if (rows.length === 1 && !header) {
        const top = rows[0];
        const looksLikeData = numberIn(top[0]) !== null || top.some((c) => c.length > 40);
        if (!looksLikeData) { header = rows.pop(); cut.pop(); }
      }
      continue;
    }
    rows.push(cells);
    cut.push(!/\|\s*$/.test(line));
  }
  if (rows.length < 1) return null;
  // A first row of short words with no number in it is a header even
  // without a separator under it: "| # | Time | Prompt |".
  if (!header && rows.length > 2 && numberIn(rows[0][0]) === null
    && rows[0].every((c) => c.length <= 24) && rows.slice(1).some((r) => r.some((c) => c.length > 40))) {
    header = rows.shift();
    cut.shift();
  }
  const width = Math.max(...rows.map((r) => r.length));

  /* Which column is the thing to paste. The header says so when it has a
     word for it; otherwise it is the column with the most words in it — a
     prompt is a paragraph, and a number, a timestamp or a code is not. */
  let column = -1;
  if (header) {
    column = header.findIndex((h) => /prompt|text|message|content|description|body|caption|copy/i.test(h));
  }
  if (column < 0) {
    let best = -1;
    for (let c = 0; c < width; c++) {
      const avg = rows.reduce((sum, r) => sum + String(r[c] ?? '').length, 0) / rows.length;
      if (avg > best) { best = avg; column = c; }
    }
  }
  /* And which column numbers them, if one does: mostly whole numbers. */
  let numbered = -1;
  for (let c = 0; c < width && numbered < 0; c++) {
    if (c === column) continue;
    const nums = rows.filter((r) => numberIn(r[c]) !== null).length;
    if (nums >= Math.max(2, Math.ceil(rows.length * 0.7))) numbered = c;
  }

  const items = rows
    .map((r, i) => {
      const raw = String(r[column] ?? '').trim();
      if (!raw) return null;
      const bold = raw.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/);
      return {
        n: numbered >= 0 ? numberIn(r[numbered]) : i + 1,
        title: bold ? plain(bold[1]).slice(0, 80) : firstWords(raw),
        text: plain(raw),
        /* A last row with no closing pipe was cut off on its way here — a
           message trimmed to a length limit ends exactly like that — and
           pasting half a prompt is worse than saying so. */
        ...(cut[i] && i === rows.length - 1 ? { cut: true } : {}),
      };
    })
    .filter(Boolean);
  return items.length ? { shape: 'table', items } : null;
}

/* "6. …", "6) …", "Image 6: …", "Prompt #6 — …", "**6.** …", "### Image 6". */
const NUMBERED = new RegExp(
  `^\\s*(?:[-*•]\\s+)?(?:\\*\\*|__)?\\s*(?:${UNIT}\\s*)?#?(\\d{1,4})(?:\\*\\*|__)?\\s*(?:[.):\\]–—-]|\\*\\*)\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  'i',
);
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*•]|•)\s+(.+)$/;

/** Items that each start on a line of their own and may run on over several. */
function fromMarkers(text, marker) {
  const items = [];
  let current = null;
  let seenStart = false;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const hit = marker(line);
    if (hit) {
      seenStart = true;
      current = { n: hit.n ?? items.length + 1, title: hit.title ?? '', lines: hit.first ? [hit.first] : [] };
      items.push(current);
      continue;
    }
    if (!seenStart) continue;                 // an introduction before the list
    if (current) current.lines.push(line);
  }
  const out = items
    .map((it) => {
      const text = plain(it.lines.join('\n').replace(/\n{3,}/g, '\n\n'));
      return text ? { n: it.n, title: it.title || firstWords(text), text } : null;
    })
    .filter(Boolean);
  return out.length >= 2 ? out : null;
}

function fromNumbered(text) {
  const items = fromMarkers(text, (line) => {
    if (HEADING.test(line)) return null;
    const m = line.match(NUMBERED);
    if (!m) return null;
    // "6. " needs something after it; "2026. Budget" is a year, not an item.
    if (Number(m[1]) > 500) return null;
    const rest = m[2] ?? '';
    const bold = rest.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/);
    return { n: Number(m[1]), title: bold ? plain(bold[1]).slice(0, 80) : '', first: rest };
  });
  return items ? { shape: 'numbered', items } : null;
}

function fromHeadings(text) {
  const items = fromMarkers(text, (line) => {
    const m = line.match(HEADING);
    if (!m) return null;
    const num = m[1].match(/(\d{1,4})/);
    return { n: num ? Number(num[1]) : null, title: plain(m[1]).slice(0, 80), first: '' };
  });
  return items ? { shape: 'headings', items } : null;
}

function fromBullets(text) {
  const items = fromMarkers(text, (line) => {
    const m = line.match(BULLET);
    return m ? { first: m[1] } : null;
  });
  return items ? { shape: 'bullets', items: items.map((it, i) => ({ ...it, n: i + 1 })) } : null;
}

function fromBlocks(text) {
  const blocks = String(text ?? '').split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter((b) => b.length >= 12);
  if (blocks.length < 2) return null;
  return { shape: 'paragraphs', items: blocks.map((b, i) => ({ n: i + 1, title: firstWords(b), text: plain(b) })) };
}

function fromLines(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  return { shape: 'lines', items: lines.map((l, i) => ({ n: i + 1, title: firstWords(l), text: plain(l) })) };
}

/**
 * The items in a piece of text, verbatim, in order: `{ shape, items: [{ n,
 * title, text }] }`, or null when it is not a list. `n` is the list's own
 * number for the item when it has one ("**6**", "6.", "Image 6") and its
 * position otherwise — so "from 6 onwards" means the item marked 6.
 */
export function extractItems(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const table = fromTable(t);
  if (table && table.items.length >= 1 && (table.items.length >= 2 || /\n\s*\|/.test(unflattenTable(t)))) return table;
  return fromNumbered(t) ?? fromHeadings(t) ?? fromBullets(t) ?? fromBlocks(t) ?? fromLines(t);
}

/* --------------------------------------------------------------------------
   Which of them
   -------------------------------------------------------------------------- */

/**
 * The part of the list asked for: `{ from, to }` in the list's own numbers,
 * `to` null for "to the end". Read from the instruction only — never from
 * the list, which is full of numbers of its own.
 */
export function readRange(instruction) {
  const t = ` ${String(instruction ?? '').toLowerCase().replace(/[’']/g, "'")} `;
  const NUM = `(\\d{1,4}(?:st|nd|rd|th)?|${NUMBER_WORDS})`;
  const U = `(?:the\\s+)?(?:${UNIT}\\s*)?(?:number\\s*)?#?`;
  let from = null;
  let to = null;
  let m;

  // "skip the first 2" — before "first 2", which it contains
  if ((m = t.match(new RegExp(`\\b(?:skip(?:ping)?|miss(?:ing)? out|leave out|except)\\s+(?:the\\s+)?first\\s+${NUM}\\b`)))) {
    const k = toNumber(m[1]);
    if (k) from = k + 1;
  }
  // "first 5" / "the first five"
  if (from === null && (m = t.match(new RegExp(`\\b(?:the\\s+)?first\\s+${NUM}\\b(?!\\s*(?:st|nd|rd|th))`)))) {
    const k = toNumber(m[1]);
    if (k && k > 1) return { from: 1, to: k, first: true };
  }
  // "last 3"
  if ((m = t.match(new RegExp(`\\b(?:the\\s+)?last\\s+${NUM}\\b`)))) {
    const k = toNumber(m[1]);
    if (k) return { last: k };
  }
  // "6-9", "6 to 9", "images 6 through 9", "between 6 and 9"
  if ((m = t.match(new RegExp(`\\b${U}${NUM}\\s*(?:-|–|—|to|through|thru|till|until)\\s*${U}${NUM}\\b`)))) {
    const a = toNumber(m[1]);
    const b = toNumber(m[2]);
    if (a && b && b >= a) return { from: a, to: b };
  }
  if ((m = t.match(new RegExp(`\\bbetween\\s+${U}${NUM}\\s+and\\s+${U}${NUM}\\b`)))) {
    const a = toNumber(m[1]);
    const b = toNumber(m[2]);
    if (a && b) return { from: Math.min(a, b), to: Math.max(a, b) };
  }
  // "from image 6", "starting at 6", "6 onwards", "sixth onwards"
  if (from === null && (m = t.match(new RegExp(`\\b(?:from|starting (?:at|from|with)|start(?:ing)? (?:at|from)|beginning (?:at|from|with)|begin (?:at|from|with))\\s+${U}${NUM}\\b`)))) {
    from = toNumber(m[1]);
  }
  if (from === null && (m = t.match(new RegExp(`\\b${U}${NUM}\\s*(?:onwards?|on\\b|and (?:up|after|beyond|on|onwards)|forwards?|and every one after|to the end|till the end|until the end)`)))) {
    from = toNumber(m[1]);
  }
  // "up to 9", "until image 9", "to 9", "through 9" — a number after one of these
  if ((m = t.match(new RegExp(`\\b(?:up to|up until|upto|until|till|til|to|through|thru)\\s+(?:and including\\s+)?${U}${NUM}\\b`)))) {
    const b = toNumber(m[1]);
    // "…wait for each image to generate" has no number after "to"; this only
    // fires on a number, and a "from" of the same number is not a range.
    if (b && (from === null || b >= from)) to = b;
  }
  // "only 4" / "just prompt 4"
  if (from === null && to === null && (m = t.match(new RegExp(`\\b(?:only|just)\\s+${U}${NUM}\\b`)))) {
    const k = toNumber(m[1]);
    if (k) return { from: k, to: k };
  }
  if (from === null && to === null) return { from: null, to: null };
  return { from, to };
}

/** Apply a range to a list, by the list's own numbers. */
export function selectRange(items, range) {
  if (!Array.isArray(items) || !items.length) return [];
  if (range?.last) return items.slice(-range.last);
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  if (from === null && to === null) return items.slice();
  /* The list's own numbers when it has them and they are unique; positions
     when it has none, or when they repeat and so cannot be what was meant. */
  const numbers = items.map((it) => it.n);
  const own = numbers.every((n) => Number.isInteger(n)) && new Set(numbers).size === numbers.length;
  if (own) return items.filter((it) => (from === null || it.n >= from) && (to === null || it.n <= to));
  return items.slice(Math.max(0, (from ?? 1) - 1), to ?? items.length);
}

/* --------------------------------------------------------------------------
   Is this that kind of job at all?
   -------------------------------------------------------------------------- */

/**
 * The instruction and the list, pulled apart. With a text attachment the
 * list is the attachment and the words are the instruction. Without one, a
 * message that states the job and then pastes the list under it — which is
 * what the person did — is split where the list starts.
 */
export function splitInstruction(task, attachments = []) {
  const texts = (Array.isArray(attachments) ? attachments : []).filter((a) => a?.kind === 'text' && String(a.text ?? '').trim());
  if (texts.length) {
    return { instruction: String(task ?? '').trim(), listText: texts.map((a) => String(a.text)).join('\n\n'), from: 'attachment', files: texts };
  }
  const raw = String(task ?? '');
  /* The one-line case first: the instruction, then the first row of a table
     on the same line — "…until final image please | **1** | `:47` | …" —
     which is what a table pasted into a single-line box turns into. */
  const firstLine = raw.split(/\r?\n/)[0];
  const pipe = firstLine.search(/\|\s*(?:\*\*|__)?\s*#?\d{1,4}\s*(?:\*\*|__)?\s*\|/);
  if (pipe > 20) {
    return { instruction: raw.slice(0, pipe).trim(), listText: raw.slice(pipe), from: 'message', files: [] };
  }
  const lines = unflattenTable(raw).split(/\r?\n/);
  const start = lines.findIndex((l, i) => i > 0 && (/^\s*\|/.test(l) || NUMBERED.test(l) || HEADING.test(l) || BULLET.test(l)));
  if (start > 0) {
    return { instruction: lines.slice(0, start).join('\n').trim(), listText: lines.slice(start).join('\n'), from: 'message', files: [] };
  }
  return { instruction: raw.trim(), listText: '', from: 'none', files: [] };
}

/**
 * A job of this shape, taken apart — or null when it is not one.
 *
 *   { instruction, all, items, range, shape, from }
 *
 * `items` is the part asked for, in order; `all` is the whole list, so the
 * person can be told "6 to 20 of 20".
 */
export function parseRepeat(task, attachments = []) {
  const { instruction, listText, from, files } = splitInstruction(task, attachments);
  if (!instruction) return null;
  const range = readRange(instruction);
  const saysEach = EACH.test(instruction) || range.from !== null || range.to !== null || Boolean(range.last);
  if (!saysEach) return null;

  let list = listText ? extractItems(listText) : null;
  /* Several files and "each of these": the files are the items. */
  if ((!list || list.items.length < 2) && files.length >= 2) {
    list = { shape: 'files', items: files.map((f, i) => ({ n: i + 1, title: String(f.name || `File ${i + 1}`), text: String(f.text) })) };
  }
  if (!list || !list.items.length) return null;
  // One item is a list only when the person pointed at it by number.
  if (list.items.length < 2 && range.from === null) return null;

  const items = selectRange(list.items, range);
  return { instruction, all: list.items, items, range, shape: list.shape, from };
}

/* --------------------------------------------------------------------------
   What each item is for
   -------------------------------------------------------------------------- */

/* Apps where an item is a message to something that answers — and the
   answer has to finish before the next can go, because these apps refuse a
   second message while the first is still being written. */
const ANSWERING = /\b(?:chat\s?gpt|openai|claude|gemini|bard|copilot|perplexity|grok|deepseek|poe|mistral|le chat|lovable|bolt(?:\.new)?|v0|replit|cursor|midjourney|ideogram|leonardo|character\.?ai|pi\.ai|meta ai)\b/i;
/* Apps where an item is a message to people: sent, and on to the next. */
const MESSAGING = /\b(?:whatsapp|discord|slack|teams|telegram|messenger|signal|imessage|messages|instagram|twitter|x\.com|linkedin|snapchat|gmail|outlook|email)\b/i;

/**
 * How each item is carried out: `chat` (put it in the message box and send
 * it), with or without waiting for the reply; or `task` (anything else, done
 * by the general loop with the item in hand).
 */
export function perItem(instruction) {
  const t = String(instruction ?? '');
  const sends = /\b(?:paste|send|submit|prompt|ask|message|enter|post|put|type|drop|give|feed|run)\b/i.test(t);
  const answering = ANSWERING.test(t);
  const messaging = MESSAGING.test(t);
  const chatWords = /\b(?:chat|message box|prompt box|text box|input box|composer|chat box)\b/i.test(t);
  const waitWords = /\bwait\b|\bgenerat|\bfinish|\brespon|\breply|\banswer|\bdone\b|\bcomplete|\bload/i.test(t);
  if (sends && (answering || messaging || chatWords)) {
    return { how: 'chat', wait: answering || (waitWords && !messaging) };
  }
  return { how: 'task', wait: waitWords };
}

/** Is this an app that answers — an assistant, rather than people? */
export const answering = (name) => ANSWERING.test(String(name ?? ''));

/**
 * Does an instruction ask for something to be SENT, not just put in a box?
 * "prompt it to…", "ask Claude…", "send this to…", "paste this into
 * ChatGPT". Typing is not sending: "type hello in ChatGPT" leaves it in the
 * box for the person, and pressing Enter on their behalf would be a guess.
 */
export function sendsMessage(instruction) {
  const t = String(instruction ?? '');
  return /\b(?:prompt|ask|send|submit|paste|message|tell\s+(?:it|them|him|her|\w+)\s+to|request|query)\b/i.test(t);
}

/** The app an instruction names, as a plain lowercase key: "chatgpt". */
export function namedTarget(instruction) {
  const t = String(instruction ?? '').toLowerCase();
  const m = t.match(ANSWERING) ?? t.match(MESSAGING);
  if (!m) return null;
  return m[0].replace(/\s+/g, '').replace(/\.new$/, '');
}

export const internals = { unflattenTable, fromTable, fromNumbered, fromHeadings, fromBullets, fromBlocks, fromLines, toNumber };
