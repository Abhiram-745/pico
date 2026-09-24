/* ==========================================================================
   Halo — one-move jobs, planned with no model.

   "Click the bell button in Row 4", "move the card "Write report" into the
   Done column", "drag Dates to the top of the list", "click the green
   circle". Each names one thing and, for a drag, one place, and Windows (or
   the picture, for a canvas) names the same things. Matching them is string
   work; spending a two-second vision call on it was most of what these jobs
   took, and the model sometimes matched worse — the bell in Row 1 for the
   bell in Row 4.

   Every plan here has to explain the WHOLE task: once the verb, the target
   and the place are taken out, nothing but filler may be left. "Click Save
   and then close the window" leaves "close window" over, and goes to the
   model. What comes back is one ordinary action on the numbered marks,
   checked at the end exactly like any other.
   ========================================================================== */

const STOP = new Set(['the', 'a', 'an', 'button', 'btn', 'icon', 'link', 'tab', 'item', 'entry', 'in', 'on', 'at', 'of',
  'to', 'into', 'onto', 'from', 'that', 'this', 'its', 'it', 'please', 'card', 'row', 'column', 'col', 'list', 'lane',
  'section', 'box', 'area', 'group', 'shape', 'one', 'just', 'labelled', 'labeled', 'called', 'named', 'says', 'marked']);

/* Row, column and list are filler around a target, but part of a name
   ("bell (row 4)"): a name's own words are taken out before filler is. */
const wordsOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .filter((w) => w && (w.length > 1 || /\d/.test(w)));
const stem = (w) => (w.length > 4 ? w.replace(/(?:es|s)$/, '') : w).slice(0, 6);
const norm = (s) => wordsOf(s).join(' ');

/** "On the Team board, " and "In Settings, " are where, not what. */
export function withoutPlace(task) {
  return String(task ?? '').trim()
    // A dot inside a name ("On the Node.js docs index, …") is not the end of the place.
    .replace(/^(?:on|in|at|from)\s+(?:the\s+)?(?:[^,.]|\.(?=\S)){1,60},\s*/i, '')
    .replace(/^please\s+/i, '')
    .replace(/[.!\s]+$/, '');
}

/** Words of `rest` left after `taken` (by stem) and filler are removed. */
function leftover(rest, taken) {
  const gone = new Set(taken.flatMap(wordsOf).map(stem));
  return wordsOf(rest).filter((w) => !gone.has(stem(w)) && !STOP.has(w));
}

const CLICKABLE = new Set(['Button', 'Hyperlink', 'MenuItem', 'TabItem', 'ListItem', 'TreeItem', 'CheckBox', 'RadioButton', 'SplitButton', 'Image']);

/**
 * "click the X": the one control whose every word is in the task.
 * @param {string} task
 * @param {Array} marks   buildMarks() output
 * @returns {{action:'click', mark:number, why:string, name:string}|null}
 */
/* "three times", "twice", "5 times": how many clicks, taken out of the words
   before the target is matched. Capped: a real task says a few, and a
   hundred clicks from a misread number is not a slip anyone wants. */
const COUNTS = { once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function timesIn(rest) {
  const m = /\s*,?\s*\b(once|twice|thrice|(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+times)\b/i.exec(rest);
  if (!m) return { rest, times: 1 };
  const n = m[2] ? (Number(m[2]) || COUNTS[m[2].toLowerCase()]) : COUNTS[m[1].toLowerCase()];
  return { rest: (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim(), times: Math.max(1, Math.min(10, n || 1)) };
}

export function planClick(task, marks = []) {
  const m = /^(?:click|press|tap|hit)\s+(?:on\s+)?(.+)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const { rest, times } = timesIn(m[1]);
  const have = new Set(wordsOf(rest).map(stem));
  const scored = marks
    .filter((k) => k.kind === 'control' && CLICKABLE.has(k.role) && k.name)
    .map((k) => ({ k, need: wordsOf(k.name) }))
    .filter(({ need }) => need.length > 0 && need.every((w) => have.has(stem(w))))
    .sort((a, b) => b.need.length - a.need.length);
  if (!scored.length) return null;
  // The most specific name wins, and it has to be the only one that specific.
  if (scored[1] && scored[1].need.length === scored[0].need.length) return null;
  const best = scored[0].k;
  if (leftover(rest, [best.name]).length) return null;
  return { action: 'click', mark: best.n, name: best.name, times, why: `Clicking ${best.name}${times > 1 ? ` (1 of ${times})` : ''}` };
}

/* --- search ---------------------------------------------------------------- */

/**
 * "search for Alan Turing", "search Wikipedia for Alan Turing and open his
 * article": the page's own search box, the words, Enter. Only the searching
 * is planned — anything after it ("and open his article") is left to the
 * loop, which gets the results page to look at. Measured on Wikipedia: two
 * vision turns spent clicking the search box before a third typed in it.
 *
 * Only "search" and "look up" start one. "Find" and "look for" are said of
 * anything — "find the cheapest hotel for 2 nights" would have typed "2
 * nights" into a search box — and the words between the verb and "for" are
 * a site's name, a few words at most, never a sentence of their own.
 * @returns {{action:'type', mark:number, text:string, then:object[], why:string}|null}
 */
export function planSearch(task, marks = []) {
  const said = withoutPlace(task);
  const m = /^(?:search|look up)\s+(?:(?:on|in)\s+)?(?:(?:the\s+)?(?!for\b)[\w.'&-]+(?:\s+(?!for\b)[\w.'&-]+){0,2}\s+)?for\s+(.+)$/i.exec(said)
    ?? /^(?:search|look up)\s+(?!for\b|and\b|then\b|or\b|with\b|by\b|through\b|in\b|on\b)(.+)$/i.exec(said);
  if (!m) return null;
  // The page's box, never the browser's own address bar.
  const boxes = marks.filter((k) => k.kind === 'control' && ['Edit', 'SearchBox', 'ComboBox'].includes(k.role)
    && /search/i.test(k.name) && !/address/i.test(k.name));
  const names = new Set(boxes.map((k) => k.name));
  if (!boxes.length || names.size !== 1) return null;
  const box = boxes[0];
  const quoted = /^["“'‘]([^"”'’]{1,80})["”'’]/.exec(m[1].trim());
  const head = quoted ? quoted[0] : m[1].trim().split(/\s+(?:and|then)\b|[,;.!?]/i)[0];
  const tail = m[1].trim().slice(head.length).trim();
  let query = (quoted ? quoted[1] : head).trim();
  /* "search for Alan Turing on Wikipedia" in a box called "Search
     Wikipedia": the last words name the site the box already searches, and
     typed in they would make a worse search. Only then — "restaurants in
     London" keeps its London. */
  if (!quoted) {
    const site = /\s+(?:on|in|at)\s+(?:the\s+)?([\w.'&-]+(?:\s+[\w.'&-]+){0,2})$/i.exec(query);
    if (site && wordsOf(site[1]).every((w) => wordsOf(box.name).includes(w))) query = query.slice(0, site.index).trim();
  }
  if (!query || query.length > 80 || /^(?:it|this|that|them|the results?)$/i.test(query)) return null;
  /* What it should look like once it has worked, when that can be read off
     the window's name (the driver's title check): a plain search is its
     results; "and open his article" is a page called by what was searched
     for that is not a list of results. Measured on Wikipedia: asked of Jev
     in the task's own words, "search for Alan Turing and open his article"
     came back "not yet" with the article open, and cost a vision turn. Any
     other tail ("and click the second result") is the loop's to do. */
  const check = !tail ? { title: query }
    : OPEN_IT.test(tail) ? { title: query, titleNot: RESULTS_PAGE } : null;
  return {
    action: 'type', mark: box.n, text: query, name: box.name,
    then: [{ action: 'key', keys: ['enter'], why: 'Pressing Enter to search' }],
    why: `Searching for ${query}`,
    ...(check ? { check } : { partial: true }),
  };
}

const OPEN_IT = /^(?:[,;]\s*)?(?:and\s+|then\s+)*(?:open|go\s+to|view|read|show\s+me)\s+(?:his|her|their|its|the)\s+(?:article|page|profile|entry|result|wiki(?:pedia)?\s+(?:article|page))\s*[.!]?$/i;
/* How a results page names itself, where the thing searched for is also in the name. */
const RESULTS_PAGE = 'search results|results for|no results|search\\s*[-–—:|]';

/* --- a dropdown ------------------------------------------------------------ */

/* The words that say "a dropdown" without saying which one. Only the first
   kind can stand for the page's one dropdown on their own: "the list" or
   "the menu" is as often a list of files as a select. */
const DROPDOWN_WORDS = /\b(?:drop[\s-]?down(?:\s+(?:list|menu|box))?|select(?:\s+(?:box|list|menu))?|combo\s*box|picker|list|menu|box|field)\b/gi;
const SAYS_DROPDOWN = /\b(?:drop[\s-]?down|select|combo\s*box|picker)\b/i;

/**
 * "choose Option 2 in the dropdown", "select Large from the Size menu".
 * formfill.mjs sets dropdowns a task names by their label; this is the one
 * a page never labelled. Real pages leave a select unlabelled often enough
 * — the-internet's Dropdown List page does — and Windows then gives it no
 * name at all: measured there, the fast path never saw it, and the vision
 * model spent a minute clicking at a native popup it could not read, once
 * following a link off the page. "The dropdown", said of a window with
 * exactly one, is that one, named or not.
 *
 * The option goes in by select_option, which types its first letters and
 * reads back what the box shows: a wrong guess is a failed action the loop
 * sees, not a silent one.
 * @returns {{action:'select_option', mark:number, text:string, name:string, why:string}|{done:true}|null}
 */
export function planChoose(task, marks = []) {
  const said = withoutPlace(task);
  const m = /^(?:choose|select|pick)\s+(.+?)\s+(?:in|from|on)\s+(?:the\s+)?(.+)$/i.exec(said);
  if (!m) return null;
  const quoted = /^["“'‘]([^"”'’]{1,60})["”'’]$/.exec(m[1].trim());
  const option = (quoted ? quoted[1] : m[1]).replace(/^the\s+/i, '').trim();
  // select_option's own rule: a plain label it can type the start of. "A
  // file", "any size" or "one of them" is a description, not a label.
  if (!/^[a-z0-9 ]{1,60}$/i.test(option) || /^(?:a|an|any|some|one of)\s/i.test(option)) return null;
  const combos = marks.filter((k) => k.kind === 'control' && k.role === 'ComboBox');
  if (!combos.length) return null;
  const place = m[2].replace(/["“”'‘’()]/g, ' ');
  const naming = leftover(place.replace(DROPDOWN_WORDS, ' '), []);
  // The most specific name wins, and it has to be the only one that specific.
  const have = new Set(wordsOf(place).map(stem));
  const scored = combos.filter((k) => k.name)
    .map((k) => ({ k, need: wordsOf(k.name) }))
    .filter(({ need }) => need.length && need.every((w) => have.has(stem(w))))
    .sort((a, b) => b.need.length - a.need.length);
  let combo = null;
  if (scored.length && !(scored[1] && scored[1].need.length === scored[0].need.length)
    && !leftover(place.replace(DROPDOWN_WORDS, ' '), [scored[0].k.name]).length) combo = scored[0].k;
  // Only "the dropdown": there has to be just the one.
  else if (!naming.length && SAYS_DROPDOWN.test(place) && combos.length === 1) combo = combos[0];
  if (!combo) return null;
  if (String(combo.value ?? '').trim().toLowerCase() === option.toLowerCase()) return { done: true };
  const what = combo.name || 'the dropdown';
  /* A box with suggestions (a datalist, an autocomplete) takes the words
     typed: the Enter that commits a select's choice submits the form from
     one of these — measured on a real page, half filled (formfill.mjs). */
  if (combo.takesText === true) return { action: 'type', mark: combo.n, text: option, name: what, why: `Typing ${option} into ${what}` };
  return { action: 'select_option', mark: combo.n, text: option, name: what, why: `Choosing ${option} in ${what}` };
}

/* --- a key ------------------------------------------------------------------- */

const KEY_NAMES = {
  enter: 'enter', return: 'enter', escape: 'escape', esc: 'escape', tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert', home: 'home', end: 'end',
  'page up': 'pageup', pageup: 'pageup', 'page down': 'pagedown', pagedown: 'pagedown',
  up: 'up', down: 'down', left: 'left', right: 'right',
  'up arrow': 'up', 'down arrow': 'down', 'left arrow': 'left', 'right arrow': 'right',
  'arrow up': 'up', 'arrow down': 'down', 'arrow left': 'left', 'arrow right': 'right',
};
const MODIFIERS = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'win', windows: 'win' };

/** "the K key", "Enter", "ctrl+s", "Ctrl + Shift + T" → the names keypress takes, or null. */
export function keysIn(phrase) {
  const p = String(phrase ?? '').trim().toLowerCase()
    .replace(/^the\s+/, '').replace(/\s+(?:keys?|button)$/, '').replace(/^["“'‘](.+)["”'’]$/, '$1').trim();
  const one = (w) => KEY_NAMES[w] ?? (/^[a-z0-9]$/.test(w) || /^f(?:[1-9]|1[0-2])$/.test(w) ? w : null);
  if (one(p)) return [one(p)];
  const bits = p.includes('+') ? p.split(/\s*\+\s*/) : p.split(/\s+/);
  if (bits.length < 2 || bits.length > 4) return null;
  const mods = bits.slice(0, -1).map((b) => MODIFIERS[b]);
  const last = one(bits[bits.length - 1]);
  return mods.every(Boolean) && last ? [...new Set(mods), last] : null;
}

/**
 * "press the K key", "hit Escape", "press ctrl+s": the key, and nothing
 * else. Not when the page has a button by that very name — "press Delete"
 * beside a Delete button means the button (planClick's).
 * @returns {{action:'key', keys:string[], why:string}|null}
 */
export function planKey(task, marks = []) {
  const m = /^(?:press|hit|tap|push)\s+(?:the\s+)?(.+?)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const keys = keysIn(m[1]);
  if (!keys) return null;
  const said = m[1].replace(/\s+(?:keys?|button)$/i, '').replace(/^the\s+/i, '').trim();
  if (marks.some((k) => k.kind === 'control' && CLICKABLE.has(k.role) && norm(k.name) === norm(said))) return null;
  const shown = keys.map((k) => (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1))).join('+');
  return { action: 'key', keys, why: `Pressing ${shown}` };
}

/* --- ticking boxes ------------------------------------------------------------ */

const TICK_ON = /^(?:tick|check|select|enable|turn\s+on|switch\s+on|mark)\s+/i;
const TICK_OFF = /^(?:untick|un-tick|uncheck|un-check|deselect|clear|disable|turn\s+off|switch\s+off|unmark)\s+/i;
const LEAVE = /^(?:leave|keep)\s+(.+?)\s+(?:as\s+it\s+is|as\s+is|alone|unchanged|the\s+way\s+it\s+is|how\s+it\s+is)$/i;

/**
 * "tick checkbox 1 and leave checkbox 2 as it is", "untick Remember me".
 * Every clause has to be about a box — ticking, unticking or leaving it —
 * and name exactly one. A box already as asked is not clicked; nothing to
 * click at all is done. Boxes a page never labelled are named by the words
 * beside them (withLabels, marks.mjs): measured on the-internet, this was
 * nineteen seconds of vision turns for one tick.
 * @returns {{action:'click', mark:number, then?:object[], why:string}|{done:true}|null}
 */
export function planTick(task, marks = []) {
  const boxes = marks.filter((k) => k.kind === 'control' && ['CheckBox', 'RadioButton'].includes(k.role) && k.name && typeof k.checked === 'boolean');
  if (!boxes.length) return null;
  const clauses = withoutPlace(task).split(/\s*(?:,|;|\band\s+then\b|\bthen\b|\band\b)\s*/i).map((c) => c.trim()).filter(Boolean);
  const clicks = [];
  for (const clause of clauses) {
    const leave = LEAVE.exec(clause);
    const on = !leave && TICK_ON.test(clause);
    const off = !leave && TICK_OFF.test(clause);
    if (!leave && !on && !off) return null;              // a clause about something else
    const phrase = leave ? leave[1] : clause.replace(on ? TICK_ON : TICK_OFF, '');
    const have = new Set(wordsOf(phrase).map(stem));
    const scored = boxes.map((k) => ({ k, need: wordsOf(k.name) }))
      .filter(({ need }) => need.length && need.every((w) => have.has(stem(w))))
      .sort((a, b) => b.need.length - a.need.length);
    if (!scored.length || (scored[1] && scored[1].need.length === scored[0].need.length)) return null;
    const box = scored[0].k;
    if (leftover(phrase, [box.name, 'checkbox check box tickbox radio option']).length) return null;
    if (!leave && box.checked !== on) clicks.push({ box, on });
  }
  if (!clicks.length) return { done: true };
  const say = ({ box, on }) => `${on ? 'Ticking' : 'Unticking'} ${box.name}`;
  const [first, ...rest] = clicks;
  return {
    action: 'click', mark: first.box.n, name: first.box.name, why: say(first),
    then: rest.map((c) => ({ action: 'click', markRef: c.box, why: say(c) })),
  };
}

/* --- one field ---------------------------------------------------------------- */

const TEXT_ROLES = new Set(['Edit', 'SearchBox', 'Spinner', 'ComboBox']);
/* What a person calls a field by what goes in it, and the role Windows gives it. */
const FIELD_KINDS = { number: ['Spinner'], search: ['SearchBox'] };

/**
 * "type 42 into the number box", "enter Halo into the Project name field".
 * One field, named in the task by its label or by what it holds, and the
 * words for it. formfill.mjs plans two fields or more; one on its own, or
 * one Windows named nothing, was a vision turn.
 * @returns {{action:'type', mark:number, text:string, why:string}|null}
 */
export function planField(task, marks = []) {
  const m = /^(?:type|enter|put|write|fill\s+in)\s+["“'‘]?(.+?)["”'’]?\s+(?:into|in|in\s+to)\s+(?:the\s+)?(.+?)\s+(?:box|field|input|text\s*box)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const [, text, label] = m;
  if (!text.trim() || text.length > 200) return null;
  const fields = marks.filter((k) => k.kind === 'control' && TEXT_ROLES.has(k.role)
    && (k.takesText === true || k.role === 'Spinner') && !/address/i.test(k.name));
  const have = new Set(wordsOf(label).map(stem));
  const named = fields.filter((k) => k.name && wordsOf(k.name).length && wordsOf(k.name).every((w) => have.has(stem(w)))
    && !leftover(label, [k.name]).length);
  const kind = FIELD_KINDS[norm(label)];
  const byKind = kind ? fields.filter((k) => kind.includes(k.role)) : [];
  const pick = named.length === 1 ? named[0] : (!named.length && byKind.length === 1 ? byKind[0] : null);
  if (!pick) return null;
  return { action: 'type', mark: pick.n, text: text.trim(), name: pick.name || label, why: `Typing ${text.trim()} into ${pick.name || `the ${label} box`}` };
}

/* --- a link ------------------------------------------------------------------- */

/**
 * "open the Releases page", "go to the File system section", "follow the
 * Pricing link": the one link called exactly that. Exactly — "File system"
 * is never "Virtual File System", and "Releases" never "+ 1 release".
 * An app or a site by name ("open Notepad") went to the opener before the
 * loop ever started; here it has to be a link on the page.
 * @returns {{action:'click', mark:number, name:string, check:object, why:string}|null}
 */
/** The name of the link a task asks to open, or null: "open the File system page" → "File system". */
export function linkWanted(task) {
  const m = /^(?:open|go\s+to|follow|visit|navigate\s+to)\s+(?:the\s+)?["“'‘]?(.+?)["”'’]?(?:\s+(?:page|link|section|tab|article|entry))?$/i.exec(withoutPlace(task));
  if (!m) return null;
  const name = m[1].replace(/\s+(?:page|link|section|tab|article|entry)$/i, '').trim();
  return norm(name) ? name : null;
}

export function planLink(task, marks = []) {
  const said = linkWanted(task);
  if (!said) return null;
  const want = norm(said);
  const isLink = (k) => k.kind === 'control' && ['Hyperlink', 'TabItem'].includes(k.role);
  let links = marks.filter((k) => isLink(k) && norm(k.name) === want);
  /* A count after the name is not part of it: GitHub's "Releases" became
     "Releases (2)" the day a second release was made, and the plan found
     nothing. Only when nothing is called exactly that, and only a count. */
  if (!links.length && !/\d$/.test(want)) {
    links = marks.filter((k) => isLink(k) && /\s\(?\d[\d,.]*\)?\s*$/.test(String(k.name).trim())
      && norm(String(k.name).trim().replace(/\s*\(?\d[\d,.]*\)?\s*$/, '')) === want);
  }
  if (!links.length) return null;
  // The same link twice (a nav bar and a footer) is one place to go; two different ones is not sure.
  if (new Set(links.map((k) => k.value ?? k.name)).size > 1) return null;
  const link = [...links].sort((a, b) => a.rect[1] - b.rect[1])[0];
  // The page it opens is called by the name asked for, not by the count beside it.
  return { action: 'click', mark: link.n, name: link.name, why: `Opening ${link.name}`, check: { title: said } };
}

/* --- sorting a table -------------------------------------------------------- */

/**
 * "sort Example 1 by Last Name, A to Z": a click on that column's header, in
 * that table — the page has two with the same headers, so the one under
 * the heading the task names. One click sorts ascending on a table that is
 * not sorted yet; whether it did is read off the column afterwards (check),
 * not taken on trust, because a second click would sort it the other way.
 * @returns {{action:'click', mark:number, check:object, why:string}|null}
 */
export function planSort(task, marks = []) {
  const m = /^sort\s+(?:the\s+)?(?:(.+?)\s+)?by\s+(?:the\s+)?(.+?)(?:\s*,?\s*(a\s*(?:to|-)\s*z|ascending|smallest\s+first|lowest\s+first))?(?:\s+column)?$/i.exec(withoutPlace(task));
  if (!m) return null;
  const [, tableName, column] = m;
  const headers = marks.filter((k) => k.kind === 'control' && ['DataItem', 'HeaderItem', 'Button', 'Text', 'Hyperlink'].includes(k.role)
    && norm(k.name) === norm(column.replace(/\s+column$/i, '')));
  if (!headers.length) return null;
  let header = headers.length === 1 ? headers[0] : null;
  if (!header && tableName) {
    // Under the heading that names the table, and above the next heading like it.
    const heading = marks.find((k) => k.kind === 'text' && norm(k.name) === norm(tableName.replace(/^table\s+/i, '')));
    if (!heading) return null;
    const below = headers.filter((k) => k.rect[1] > heading.rect[1]).sort((a, b) => a.rect[1] - b.rect[1]);
    header = below[0] ?? null;
  }
  if (!header) return null;
  return { action: 'click', mark: header.n, name: header.name, why: `Sorting by ${header.name}`,
    check: { column: { x: header.rect[0], w: header.rect[2], below: header.rect[1] + header.rect[3], name: header.name }, order: 'asc' } };
}

/* --- adding an item ---------------------------------------------------------- */

/**
 * "add a todo called Buy milk", "add an item named Eggs": the one field for
 * new things, the words, Enter. A field for new things is one whose name
 * says so — "New Todo Input", "Add item", "What needs to be done?".
 * @returns {{action:'type', mark:number, text:string, then:object[], check:object, why:string}|null}
 */
export function planAdd(task, marks = []) {
  const m = /^add\s+(?:a|an|one|another|the)?\s*(?:new\s+)?([\w-]+(?:\s+[\w-]+)?)\s+(?:called|named|that\s+says|saying)\s+(.+)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const [, thing] = m;
  /* The name runs to a "then": "add a todo called Buy milk, then change it
     to Buy oat milk" is two things to do, and "Buy milk and eggs" one name. */
  const [said, after] = m[2].split(/\s*(?:[,;]\s*and\s+then|[,;]\s*then|\s+and\s+then|\s+then)\s+/i);
  const text = said.replace(/^["“'‘]|["”'’]$/g, '').trim();
  if (!text || text.length > 200) return null;
  // "…then change it to X": the item, renamed where it is.
  const rename = after ? /^(?:change|rename|edit)\s+(?:it|that|the\s+\w+)\s+to\s+["“'‘]?(.+?)["”'’]?$/i.exec(after.trim()) : null;
  if (after && !rename) return null;
  const fields = marks.filter((k) => k.kind === 'control' && TEXT_ROLES.has(k.role) && k.takesText === true && !/address/i.test(k.name)
    && (/\b(?:new|add)\b|what needs to be done/i.test(k.name) || wordsOf(k.name).some((w) => stem(w) === stem(norm(thing).split(' ').pop() ?? ''))));
  if (fields.length !== 1) return null;
  const field = fields[0];
  const then = [{ action: 'key', keys: ['enter'], why: `Adding ${text}` }];
  if (rename) {
    /* Editing a list item is a double-click on its words, all of them
       chosen, the new ones, Enter — TodoMVC's own way, and most lists'.
       The item is found again by its words once it exists, nearest the
       field it went in from. */
    const [x, y, w, h] = field.rect;
    const newName = rename[1].trim();
    then.push(
      { action: 'double_click', markRef: { kind: 'text', role: 'Text', name: text, rect: [x, y + h, w, h] }, why: `Opening ${text} to edit it` },
      { action: 'key', keys: ['ctrl', 'a'], why: 'Choosing all of its words' },
      { action: 'type', text: newName, why: `Typing ${newName}` },
      { action: 'key', keys: ['enter'], why: `Saving it as ${newName}` },
    );
    return { action: 'type', mark: field.n, text, name: field.name, then, why: `Typing ${text} into ${field.name}`, check: { shows: newName } };
  }
  return {
    action: 'type', mark: field.n, text, name: field.name, then,
    why: `Typing ${text} into ${field.name}`,
    check: { shows: text },
  };
}

/* --- hovering ------------------------------------------------------------------ */

const ORDINALS = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, last: -1 };

/**
 * "hover over the first picture and open its View profile link". What a
 * hover shows is not on the page until the pointer is there, so the plan is
 * the hover, then the link by its name — found in the read taken after the
 * hover, the one nearest the picture. Pictures are counted in reading order.
 * @returns {{action:'move', mark:number, then:object[], why:string}|null}
 */
export function planHover(task, marks = []) {
  const m = /^hover\s+(?:over|on)?\s*(?:the\s+)?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\s+(?:picture|image|photo|avatar|card|tile)\s+(?:and|then|,)\s*(?:then\s+)?(?:open|click|follow)\s+(?:its|the)\s+["“'‘]?(.+?)["”'’]?\s+(?:link|button)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const pictures = marks.filter((k) => k.kind === 'control' && k.role === 'Image' && k.rect[2] >= 40 && k.rect[3] >= 40)
    .sort((a, b) => (Math.abs(a.rect[1] - b.rect[1]) > 20 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0]));
  if (pictures.length < 2) return null;
  const at = ORDINALS[m[1].toLowerCase()];
  const picture = at < 0 ? pictures[pictures.length - 1] : pictures[at];
  if (!picture) return null;
  const name = m[2].trim();
  return {
    action: 'move', mark: picture.n, name: picture.name, why: `Hovering over the ${m[1].toLowerCase()} picture`,
    then: [{ action: 'click', markRef: { kind: 'control', role: 'Hyperlink', name, rect: picture.rect }, why: `Opening ${name}` }],
  };
}

/* --- drag ------------------------------------------------------------------ */

const DRAG = /^(?:drag|move|put)\s+(.+?)\s+(?:to|into|onto|on to|in to|over to|over|under)\s+(.+)$/i;
const TOP = /^(?:the\s+)?(?:very\s+)?(top|start|beginning|front|first place|bottom|end|last place)\b(?:\s+of\s+(.+))?$/i;

const within = (outer, r) => r[0] >= outer[0] - 2 && r[1] >= outer[1] - 2
  && r[0] + r[2] <= outer[0] + outer[2] + 2 && r[1] + r[3] <= outer[1] + outer[3] + 2;

/** The thing named: its quoted name if it has one, else the words left. */
function findThing(phrase, marks, kinds) {
  const quoted = /["“'‘]([^"”'’]{1,80})["”'’]/.exec(phrase)?.[1];
  /* "box A", "the A box", "card Write report": the kind of thing is not its
     name. the-internet's boxes are called "A" and "B" and nothing else. */
  const raw = String(quoted ?? phrase.replace(/^(?:the\s+)?(?:card|item|row|file|task|entry|shape|box|tile|square|block)\s+/i, '')
    .replace(/\s+(?:card|item|box|tile|square|block)$/i, '')).trim().toLowerCase();
  const want = norm(raw);
  // A name of one letter ("A") is all a name can be; norm() drops such words as filler.
  const single = !want && /^[a-z0-9]$/.test(raw) ? raw : null;
  if (!want && !single) return null;
  const exact = marks.filter((k) => kinds.includes(k.kind) && k.name
    && (single ? String(k.name).trim().toLowerCase() === single : norm(k.name) === want));
  if (exact.length) {
    // Text and control both reporting the same card is one thing: prefer the control.
    return exact.sort((a, b) => (a.kind === 'control' ? -1 : 1) - (b.kind === 'control' ? -1 : 1))[0];
  }
  return null;
}

/**
 * "drag X to Y" / "move X into the Y column" / "drag X to the top of the list".
 * @returns {{action:'drag', mark:number, to_mark:number, why:string}|{done:true}|null}
 */
export function planDrag(task, marks = []) {
  const m = DRAG.exec(withoutPlace(task));
  if (!m) return null;
  const [, itemPhrase, placePhrase] = m;
  const item = findThing(itemPhrase, marks, ['control', 'text']);
  if (!item) return null;

  const end = TOP.exec(placePhrase.trim());
  if (end) {
    // Its own list: the smallest place holding it, and the things in there like it.
    const home = marks.filter((k) => k.kind === 'place' && within(k.rect, item.rect) && k.rect[3] > item.rect[3] * 1.5)
      .sort((a, b) => (a.rect[2] * a.rect[3]) - (b.rect[2] * b.rect[3]))[0];
    if (!home) return null;
    if (end[2] && leftover(end[2], [home.name]).length) return null;
    const siblings = marks.filter((k) => k.kind === item.kind && k.role === item.role && within(home.rect, k.rect)
      && Math.abs(k.rect[0] - item.rect[0]) < 40)
      .sort((a, b) => a.rect[1] - b.rect[1]);
    if (siblings.length < 2) return null;
    const first = /^(?:top|start|beginning|front|first)/i.test(end[1]);
    const target = first ? siblings[0] : siblings[siblings.length - 1];
    if (target.n === item.n) return { done: true };
    return { action: 'drag', mark: item.n, to_mark: target.n, why: `Dragging ${item.name} to the ${first ? 'top' : 'bottom'}`,
      check: { item: { kind: item.kind, role: item.role, name: item.name }, end: first ? 'top' : 'bottom', home: { name: home.name } } };
  }

  // A named place: a column, a folder, a list.
  const bare = placePhrase.replace(/^(?:the\s+)?/i, '').replace(/\s+(?:column|list|lane|folder|section|box|area|group|stage|pile|bucket)$/i, '');
  const want = norm(bare.replace(/["“”'‘’]/g, ''));
  if (!want) return null;
  const places = marks.filter((k) => k.kind === 'place' && norm(k.name) === want);
  if (places.length !== 1) {
    /* Onto another thing, not into a place: "drag box A onto box B". What
       happens there is the page's to decide — swap, reorder, nest — so the
       check is only that the thing is now where the other one was. */
    const target = places.length ? null : findThing(placePhrase, marks.filter((k) => k !== item), ['control', 'text']);
    if (!target) return null;
    return { action: 'drag', mark: item.n, to_mark: target.n, why: `Dragging ${item.name} onto ${target.name}`,
      check: { item: { kind: item.kind, role: item.role, name: item.name }, onto: { name: target.name, rect: target.rect } } };
  }
  const place = places[0];
  if (within(place.rect, item.rect)) return { done: true };
  return { action: 'drag', mark: item.n, to_mark: place.n, why: `Dragging ${item.name} into ${place.name}`,
    check: { item: { kind: item.kind, role: item.role, name: item.name }, place: { name: place.name } } };
}

/* --- a shape in a picture ---------------------------------------------------- */

const COLOURS = ['red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'purple', 'violet', 'pink', 'magenta', 'black', 'white', 'grey', 'gray', 'brown'];
const KINDS = { circle: 'circle', round: 'circle', dot: 'circle', ball: 'circle', oval: 'circle', ellipse: 'circle',
  square: 'square', rectangle: 'square', box: 'square', block: 'square', triangle: 'triangle', diamond: 'triangle' };

/** The name a person would give an [r, g, b]. */
export function colourName([r, g, b]) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const v = max / 255; const s = max ? (max - min) / max : 0;
  if (v < 0.2) return 'black';
  if (s < 0.18) return v > 0.85 ? 'white' : 'grey';
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = ((b - r) / (max - min)) + 2;
  else h = ((r - g) / (max - min)) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 14 || h >= 345) return v < 0.55 && s > 0.4 ? 'brown' : 'red';
  if (h < 40) return v < 0.6 ? 'brown' : 'orange';
  if (h < 68) return 'yellow';
  if (h < 165) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** Circle, square or triangle, from how much of its box a shape fills. */
export function kindOf(shape) {
  const fill = shape.fill ?? 0;
  if (fill > 0.9) return 'square';
  if (fill > 0.64) return 'circle';
  if (fill > 0.3) return 'triangle';
  return null;
}

/**
 * What in a picture the task describes: "the green circle".
 * @param {string} described   e.g. 'green circle' or the whole task
 * @param {Array} shapes       zoom.shapesIn() output, with colour and fill
 * @returns {object|null}      the one shape that fits, or null
 */
export function matchShape(described, shapes = []) {
  const w = wordsOf(described).map((x) => (x === 'gray' ? 'grey' : x === 'violet' ? 'purple' : x === 'magenta' ? 'pink' : x));
  const colour = w.find((x) => COLOURS.includes(x));
  const kind = w.map((x) => KINDS[x]).find(Boolean);
  if (!colour && !kind) return null;
  const fits = shapes.filter((s) => s.colour && (!colour || colourName(s.colour) === colour) && (!kind || kindOf(s) === kind));
  return fits.length === 1 ? fits[0] : null;
}

/**
 * "click the green circle" on a page whose only unnamed picture is a canvas.
 * @returns {{action:'click', mark:number, target:string, why:string}|null}
 */
export function planShapeClick(task, marks = []) {
  const m = /^(?:click|press|tap|hit)\s+(?:on\s+)?(.+)$/i.exec(withoutPlace(task));
  if (!m) return null;
  const w = wordsOf(m[1]);
  const colour = w.find((x) => COLOURS.includes(x));
  const kind = w.map((x) => KINDS[x]).find(Boolean);
  if (!colour || !kind) return null;
  const left = w.filter((x) => !STOP.has(x) && !COLOURS.includes(x) && !KINDS[x]);
  if (left.length) return null;
  const pictures = marks.filter((k) => k.kind === 'place' && /unnamed picture/i.test(k.name));
  if (pictures.length !== 1) return null;
  const target = `${colour} ${kind}`;
  return { action: 'click', mark: pictures[0].n, target, why: `Clicking the ${target}` };
}

/**
 * Did the drag land where it was asked to? Measured from the window's own
 * rectangles — exact, where a question about the window's words is not: a
 * page's text does not say which column a card is in, or which row is on top.
 * @param {{item:object, place?:object, end?:'top'|'bottom', home?:object}} want
 * @param {Array} marks   buildMarks() of a fresh read
 * @returns {boolean|null}  null when it cannot tell
 */
export function dragLanded(want, marks = []) {
  /* Something added: it is on the page now, as a line of text or a control. */
  if (want?.shows) return marks.some((k) => k.name && norm(k.name) === norm(want.shows)) ? true : null;
  /* A column sorted A to Z: its cells, top to bottom, under the header,
     until the table ends (a gap bigger than a row). */
  if (want?.column) {
    const { x, w, below } = want.column;
    const cells = marks.filter((k) => k.kind === 'control' && k.name && k.rect[1] >= below - 2
      && k.rect[0] < x + w - 4 && k.rect[0] + k.rect[2] > x + 4 && norm(k.name) !== norm(want.column.name))
      .sort((a, b) => a.rect[1] - b.rect[1]);
    const run = [];
    for (const c of cells) {
      if (run.length && c.rect[1] - (run[run.length - 1].rect[1] + run[run.length - 1].rect[3]) > Math.max(24, run[0].rect[3])) break;
      run.push(c);
    }
    if (run.length < 2) return null;
    const names = run.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return names.every((n, i) => n === sorted[i]);
  }
  if (!want?.item) return null;
  const item = marks.find((k) => k.kind === want.item.kind && k.role === want.item.role && k.name === want.item.name);
  if (!item) return null;
  if (want.onto) {
    // Where the other thing was: a swap puts it exactly there, a reorder near.
    const [ox, oy, ow, oh] = want.onto.rect;
    const cx = item.rect[0] + (item.rect[2] / 2);
    const cy = item.rect[1] + (item.rect[3] / 2);
    return cx >= ox - 6 && cx <= ox + ow + 6 && cy >= oy - 6 && cy <= oy + oh + 6;
  }
  if (want.place) {
    const place = marks.find((k) => k.kind === 'place' && k.name === want.place.name);
    if (!place) return null;
    const cx = item.rect[0] + (item.rect[2] / 2);
    const cy = item.rect[1] + (item.rect[3] / 2);
    return cx >= place.rect[0] && cx <= place.rect[0] + place.rect[2] && cy >= place.rect[1] && cy <= place.rect[1] + place.rect[3];
  }
  if (want.end && want.home) {
    const home = marks.find((k) => k.kind === 'place' && k.name === want.home.name);
    if (!home) return null;
    const ys = marks.filter((k) => k.kind === item.kind && k.role === item.role && k !== item && within(home.rect, k.rect)
      && Math.abs(k.rect[0] - item.rect[0]) < 40).map((k) => k.rect[1]);
    if (!ys.length) return null;
    return want.end === 'top' ? item.rect[1] < Math.min(...ys) : item.rect[1] > Math.max(...ys);
  }
  return null;
}

/**
 * A value the task says is on screen: "put the order number from the
 * receipt into …". Read off the window when it is written there once, as a
 * label and the thing after it — "Order number" then "NH-48213-KQ7", or
 * "Order number: NH-48213-KQ7".
 * @param {string} task
 * @param {string[]} lines   the window's text, in reading order
 * @returns {string|null}
 */
export function valueOnScreen(task, lines = []) {
  const m = /\b(?:put|enter|type|copy|fill in|paste|use)\s+(?:the\s+|their\s+|your\s+)?(.{3,40}?)\s+(?:from|on|shown on|in|off)\s+(?:the\s+)?\S+/i.exec(String(task ?? ''));
  if (!m) return null;
  const want = norm(m[1]);
  if (!want) return null;
  const found = new Set();
  const clean = lines.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  clean.forEach((line, i) => {
    const same = new RegExp(`^${want.replace(/ /g, '[^a-z0-9]+')}\s*[:#-]?\s*(.*)$`, 'i').exec(line);
    if (!same) return;
    const inline = same[1].trim();
    const value = inline || clean[i + 1] || '';
    // One token, with a digit in it: an order number, a code, a reference.
    if (/^[A-Za-z0-9][\w./#-]{2,39}$/.test(value) && /\d/.test(value)) found.add(value);
  });
  return found.size === 1 ? [...found][0] : null;
}
