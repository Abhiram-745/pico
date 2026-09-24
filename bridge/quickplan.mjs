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
    .replace(/^(?:on|in|at|from)\s+(?:the\s+)?[^,.]{1,60},\s*/i, '')
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
  let query = (quoted ? quoted[1] : m[1].split(/\s+(?:and|then)\b|[,;.!?]/i)[0]).trim();
  /* "search for Alan Turing on Wikipedia" in a box called "Search
     Wikipedia": the last words name the site the box already searches, and
     typed in they would make a worse search. Only then — "restaurants in
     London" keeps its London. */
  if (!quoted) {
    const site = /\s+(?:on|in|at)\s+(?:the\s+)?([\w.'&-]+(?:\s+[\w.'&-]+){0,2})$/i.exec(query);
    if (site && wordsOf(site[1]).every((w) => wordsOf(box.name).includes(w))) query = query.slice(0, site.index).trim();
  }
  if (!query || query.length > 80 || /^(?:it|this|that|them|the results?)$/i.test(query)) return null;
  return {
    action: 'type', mark: box.n, text: query, name: box.name,
    then: [{ action: 'key', keys: ['enter'], why: 'Pressing Enter to search' }],
    why: `Searching for ${query}`,
  };
}

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
  if (combo.readOnly === false) return { action: 'type', mark: combo.n, text: option, name: what, why: `Typing ${option} into ${what}` };
  return { action: 'select_option', mark: combo.n, text: option, name: what, why: `Choosing ${option} in ${what}` };
}

/* --- drag ------------------------------------------------------------------ */

const DRAG = /^(?:drag|move|put)\s+(.+?)\s+(?:to|into|onto|in to|over to|under)\s+(.+)$/i;
const TOP = /^(?:the\s+)?(?:very\s+)?(top|start|beginning|front|first place|bottom|end|last place)\b(?:\s+of\s+(.+))?$/i;

const within = (outer, r) => r[0] >= outer[0] - 2 && r[1] >= outer[1] - 2
  && r[0] + r[2] <= outer[0] + outer[2] + 2 && r[1] + r[3] <= outer[1] + outer[3] + 2;

/** The thing named: its quoted name if it has one, else the words left. */
function findThing(phrase, marks, kinds) {
  const quoted = /["“'‘]([^"”'’]{1,80})["”'’]/.exec(phrase)?.[1];
  const want = norm(quoted ?? phrase.replace(/^(?:the\s+)?(?:card|item|row|file|task|entry|shape)\s+/i, ''));
  if (!want) return null;
  const exact = marks.filter((k) => kinds.includes(k.kind) && k.name && norm(k.name) === want);
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
  if (places.length !== 1) return null;
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
  if (!want?.item) return null;
  const item = marks.find((k) => k.kind === want.item.kind && k.role === want.item.role && k.name === want.item.name);
  if (!item) return null;
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
