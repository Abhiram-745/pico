/* ==========================================================================
   Halo — what is actually on this computer, and opening it.

   "Open WhatsApp" was being answered by opening a browser and searching
   Google for the word WhatsApp, which is not what anybody means. Nothing in
   Halo knew whether WhatsApp was installed, so a model looking at a picture
   of a desktop guessed — and the safest-looking guess from a picture is the
   browser, where typing a name into the address bar gets you a page of
   search results about it.

   So ask Windows. Get-StartApps lists everything in the Start menu — desktop
   programs and Store apps together, the same list Start search itself uses,
   each with the ID Windows launches it by. That turns "open the app" and
   "look it up on the web" from a guess into a fact.

   AND WHEN IT IS BOTH
   Plenty of things are an app here and a website too: WhatsApp, Claude,
   Spotify, Outlook, Teams. Which one is meant is the person's call, not a
   coin toss, so Halo asks — "the app, or the website?" — once, with the two
   answers as buttons. Saying which in the request ("open the WhatsApp app",
   "open claude.ai", "WhatsApp web") settles it without a question.

   OPENING
   An app is started by its Start-menu ID through the shell, exactly as
   clicking it in Start would, rather than by typing its name into Start
   search and pressing Enter — which launches whatever the top result
   happens to be, and is a web search when the index is slow. A website is
   handed straight to the default browser at its real address.
   ========================================================================== */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** How long a list of installed apps is worth believing. */
const FRESH_FOR = 5 * 60 * 1000;

/**
 * Things that have a website worth offering, by the name people use.
 *
 * `app` marks names that are commonly an installed app too — the ones worth
 * asking about. The rest are websites first (YouTube, Gmail, Reddit): if one
 * of those is not installed as an app, there is nothing to ask, and it just
 * opens in the browser.
 */
export const SITES = new Map([
  ['whatsapp', { url: 'https://web.whatsapp.com', label: 'WhatsApp Web', app: true }],
  ['claude', { url: 'https://claude.ai', label: 'claude.ai', app: true }],
  ['chatgpt', { url: 'https://chatgpt.com', label: 'chatgpt.com', app: true }],
  ['spotify', { url: 'https://open.spotify.com', label: 'Spotify Web Player', app: true }],
  ['outlook', { url: 'https://outlook.live.com', label: 'Outlook on the web', app: true }],
  ['teams', { url: 'https://teams.microsoft.com', label: 'Teams on the web', app: true }],
  ['microsoft teams', { url: 'https://teams.microsoft.com', label: 'Teams on the web', app: true }],
  ['slack', { url: 'https://app.slack.com', label: 'Slack in the browser', app: true }],
  ['discord', { url: 'https://discord.com/app', label: 'Discord in the browser', app: true }],
  ['notion', { url: 'https://www.notion.so', label: 'notion.so', app: true }],
  ['figma', { url: 'https://www.figma.com', label: 'figma.com', app: true }],
  ['telegram', { url: 'https://web.telegram.org', label: 'Telegram Web', app: true }],
  ['zoom', { url: 'https://app.zoom.us', label: 'Zoom in the browser', app: true }],
  ['trello', { url: 'https://trello.com', label: 'trello.com', app: true }],
  ['onedrive', { url: 'https://onedrive.live.com', label: 'OneDrive on the web', app: true }],
  ['word', { url: 'https://www.office.com/launch/word', label: 'Word on the web', app: true }],
  ['excel', { url: 'https://www.office.com/launch/excel', label: 'Excel on the web', app: true }],
  ['powerpoint', { url: 'https://www.office.com/launch/powerpoint', label: 'PowerPoint on the web', app: true }],
  ['onenote', { url: 'https://www.onenote.com/notebooks', label: 'OneNote on the web', app: true }],
  ['netflix', { url: 'https://www.netflix.com', label: 'netflix.com', app: true }],
  ['instagram', { url: 'https://www.instagram.com', label: 'instagram.com', app: true }],
  ['facebook', { url: 'https://www.facebook.com', label: 'facebook.com', app: true }],
  ['messenger', { url: 'https://www.messenger.com', label: 'messenger.com', app: true }],
  ['linkedin', { url: 'https://www.linkedin.com', label: 'linkedin.com', app: true }],
  ['x', { url: 'https://x.com', label: 'x.com', app: true }],
  ['twitter', { url: 'https://x.com', label: 'x.com', app: true }],
  ['tiktok', { url: 'https://www.tiktok.com', label: 'tiktok.com', app: true }],
  ['github', { url: 'https://github.com', label: 'github.com', app: true }],
  ['canva', { url: 'https://www.canva.com', label: 'canva.com', app: true }],
  ['prime video', { url: 'https://www.primevideo.com', label: 'primevideo.com', app: true }],
  ['disney+', { url: 'https://www.disneyplus.com', label: 'disneyplus.com', app: true }],
  ['youtube', { url: 'https://www.youtube.com', label: 'youtube.com' }],
  ['youtube music', { url: 'https://music.youtube.com', label: 'music.youtube.com', app: true }],
  ['gmail', { url: 'https://mail.google.com', label: 'Gmail' }],
  ['google', { url: 'https://www.google.com', label: 'google.com' }],
  ['google drive', { url: 'https://drive.google.com', label: 'Google Drive' }],
  ['google docs', { url: 'https://docs.google.com', label: 'Google Docs' }],
  ['google calendar', { url: 'https://calendar.google.com', label: 'Google Calendar' }],
  ['reddit', { url: 'https://www.reddit.com', label: 'reddit.com' }],
  ['amazon', { url: 'https://www.amazon.com', label: 'amazon.com' }],
  ['wikipedia', { url: 'https://www.wikipedia.org', label: 'wikipedia.org' }],
  ['bbc', { url: 'https://www.bbc.co.uk', label: 'bbc.co.uk' }],
]);

/** Names people use for an app that are not how the Start menu spells it. */
const ALIASES = new Map([
  ['vs code', 'visual studio code'],
  ['vscode', 'visual studio code'],
  ['code', 'visual studio code'],
  ['chrome', 'google chrome'],
  ['edge', 'microsoft edge'],
  ['teams', 'microsoft teams'],
  ['store', 'microsoft store'],
  ['explorer', 'file explorer'],
  ['files', 'file explorer'],
  ['calc', 'calculator'],
  ['cmd', 'command prompt'],
  ['powershell', 'windows powershell'],
  ['prime video', 'amazon prime video'],
]);

/** Noise words that are never part of an application's name. */
const FILLER = new Set([
    'the', 'my', 'a', 'an', 'up', 'please', 'pls', 'for', 'me', 'now', 'app', 'application',
  'desktop', 'program', 'website', 'site', 'web', 'page', 'online', 'browser', 'version',
]);

/** Halo's own windows: the app ("Halo") and the island ("Halo Notch"). One
    answer for every file that has to tell them from the work being done.
    The old names count too — an island left over from before the rename is
    still Halo's own, not something to type into. */
export const isHaloWindow = (title = '') =>
  /(?:^|— )(?:Halo|Pico)(?: Notch| palette| companion)?$/i.test(String(title).trim());

let cache = null;
let cachedAt = 0;
let inflight = null;

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * Everything in the Start menu: `[{ name, id }]`.
 *
 * Cached, because it is a PowerShell launch and the answer changes when
 * somebody installs something, which is not often. Never throws — a machine
 * that will not answer is treated as one with nothing installed.
 */
export async function installed() {
  if (process.platform !== 'win32') return [];
  if (cache && Date.now() - cachedAt < FRESH_FOR) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const out = await powershell(
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
      );
      const parsed = JSON.parse(out.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      cache = rows
        .filter((r) => r && r.Name && r.AppID)
        .map((r) => ({ name: String(r.Name), id: String(r.AppID) }));
    } catch {
      cache = cache ?? [];      // keep a stale list over no list at all
    }
    cachedAt = Date.now();
    inflight = null;
    return cache;
  })();

  return inflight;
}

export const norm = (s) => String(s ?? '').toLowerCase()
  .replace(/[’']/g, '')
  .replace(/[^a-z0-9+ ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Apps nobody means when they say a name, however well it matches. */
const NEVER = /\b(?:uninstall|readme|help|documentation|release notes|license|website|manual|setup|updater|crash reporter|safe mode|debug)\b/i;

/**
 * The installed app a name refers to, or null.
 *
 * Exact names win, then a name the Start menu entry starts with ("spotify"
 * for "Spotify Premium"), then a whole-word match anywhere ("teams" for
 * "Microsoft Teams"). Shorter entries beat longer ones at the same level, so
 * "Outlook" is preferred to "Outlook (classic)" and "Word" to "WordPad".
 */
export async function findApp(name) {
  const wanted = norm(name);
  if (!wanted) return null;
  const list = await installed();
  if (!list.length) return null;

  const forms = [wanted];
  if (ALIASES.has(wanted)) forms.push(ALIASES.get(wanted));

  let best = null;
  let bestScore = 0;
  for (const app of list) {
    if (NEVER.test(app.name)) continue;
    const n = norm(app.name);
    for (const f of forms) {
      let score = 0;
      if (n === f) score = 100;
      else if (n.startsWith(`${f} `)) score = 80;
      else if (` ${n} `.includes(` ${f} `)) score = 60;
      if (!score) continue;
      score -= Math.min(20, n.length - f.length) * 0.5;   // tighter names first
      if (score > bestScore) { bestScore = score; best = app; }
    }
  }
  return best;
}

/** Words in a request that are never the name of what it is about. */
const COMMON = new Set([
  'open', 'launch', 'start', 'run', 'go', 'to', 'and', 'then', 'send', 'message', 'write', 'type',
  'search', 'find', 'play', 'new', 'pico', 'on', 'in', 'it', 'of', 'with', 'from', 'at', 'is', 'this',
  'that', 'some', 'click', 'press', 'close', 'show', 'make', 'create', 'add', 'set', 'turn', 'off',
  'saying', 'say', 'hi', 'hello', 'about', 'what', 'my', 'your', 'can', 'you', 'get', 'take', 'look',
]);

/**
 * Installed apps a request seems to be about — for the planner, which then
 * knows that "message Sam on WhatsApp" can be done in an app that is here.
 * Deliberately shallow: names matched against the Start menu, no more.
 */
export async function mentionedApps(text) {
  const words = norm(text).split(' ').filter((w) => w.length > 1 && !FILLER.has(w) && !COMMON.has(w));
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) phrases.push(`${words[i]} ${words[i + 1]}`);
  phrases.push(...words);
  const found = new Map();
  for (const p of phrases) {
    const app = await findApp(p);
    if (app && !found.has(app.id)) found.set(app.id, app);
    if (found.size >= 5) break;
  }
  return [...found.values()];
}

/**
 * What a request says about app versus website, if anything.
 *   'app'  — "the WhatsApp app", "desktop app", "the application"
 *   'site' — "website", "on the web", "in the browser", "WhatsApp Web", a URL
 */
export function preference(text) {
  const t = norm(text);
  if (/\b(?:app|application|desktop app|desktop version|program)\b/.test(t) && !/\bweb ?app\b/.test(t)) return 'app';
  if (/\b(?:website|web site|site|web version|web app|on the web|online|in (?:the |my )?browser|in (?:chrome|edge|firefox)|web)\b/.test(t)) return 'site';
  if (/(?:https?:\/\/|www\.)|\b[a-z0-9-]+\.(?:com|net|org|io|ai|app|co|uk|so|us|tv|me)\b/i.test(String(text))) return 'site';
  return null;
}

/**
 * Split "open X" (and "open X and do Y") into the thing and the rest.
 * Returns null for anything that is not a request to open something by name.
 */
const POLITE = String.raw`(?:(?:please|pls|hey pico|pico|ok|okay|can you|could you|would you|will you|just|now|go ahead and)[,\s]+)*`;
const OPEN_VERB = String.raw`(?:open(?:\s+up)?|launch|start(?:\s+up)?|run|bring\s+up|pull\s+up|load|fire\s+up|go\s+to|goto|visit|take\s+me\s+to|switch\s+to)`;
const OPEN_RE = new RegExp(String.raw`^${POLITE}${OPEN_VERB}\s+(.+?)\s*[.!]*$`, 'i');
const THEN_RE = /\s*(?:,\s*)?(?:\band then\b|\bthen\b|\band\b|,)\s+/i;

export function parseOpen(text) {
  const t = String(text ?? '').trim();
  const m = t.match(OPEN_RE);
  if (!m) return null;

  let subject = m[1];
  let rest = '';
  const split = subject.split(THEN_RE);
  if (split.length > 1) {
    subject = split[0];
    rest = t.slice(t.indexOf(split[0]) + split[0].length).replace(/^\s*(?:,\s*)?(?:and then|then|and|,)\s+/i, '').trim();
  }

  const said = subject.trim();
  // "open youtube.com" / "open https://…": the thing is the address itself.
  const url = said.match(/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/i);
  if (url) return { name: said, url: /^https?:\/\//i.test(said) ? said : `https://${said}`, rest, said };

  // Strip the words that say which kind, keeping the name.
  const name = norm(said)
    .replace(/\b(?:in|on|with)\s+(?:the\s+|my\s+)?(?:browser|web|chrome|edge|firefox)\b/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER.has(w))
    .join(' ')
    .trim();

  // A whole sentence is not the name of an app ("open the report from last
  // week", "open my downloads folder"): those are jobs for the planner.
  if (!name || name.split(' ').length > 4) return null;
  if (/\b(?:folder|file(?! explorer)|files from|document|tab|window|email|message|chat with|conversation|settings for|photo|picture|video of|song|playlist|link|report|invoice|spreadsheet)\b/.test(name)) return null;

  return { name, rest, said };
}

/**
 * Decide what "open <name>" means on this computer.
 *
 * @returns {Promise<
 *   {kind:'app', app} |
 *   {kind:'site', site} |
 *   {kind:'ask', app, site, question, options} |
 *   {kind:'missing-app', name, site, question, options} |
 *   {kind:'unknown', name}
 * >}
 */
export async function resolve(name, requestText = '') {
  const key = norm(name);
  const site = SITES.get(key) ?? null;
  const app = await findApp(key);
  const wants = preference(requestText);
  const title = app?.name ?? (key.charAt(0).toUpperCase() + key.slice(1));

  if (app && wants === 'app') return { kind: 'app', app };
  if (site && wants === 'site') return { kind: 'site', site };

  if (app && site) {
    return {
      kind: 'ask',
      app,
      site,
      question: `Open the ${app.name} app, or ${site.label} in your browser?`,
      options: [
        { id: 'app', label: `${app.name} app` },
        { id: 'site', label: site.label },
      ],
    };
  }
  if (app) return { kind: 'app', app };

  if (site && !site.app) return { kind: 'site', site };
  if (site) {
    return {
      kind: 'missing-app',
      name: title,
      site,
      question: `${title} isn't installed as an app on this computer. Open ${site.label} in your browser instead?`,
      options: [
        { id: 'site', label: `Open ${site.label}` },
        { id: 'cancel', label: 'No thanks' },
      ],
    };
  }
  if (wants === 'site') return { kind: 'unknown', name: title, web: true };
  return { kind: 'unknown', name: title };
}

/**
 * Read an answer to one of the questions above, typed or tapped.
 * @returns {'app'|'site'|'cancel'|null}
 */
export function readChoice(answer, options = []) {
  const ids = new Set(options.map((o) => o.id));
  if (answer && typeof answer === 'object' && answer.choice) {
    return ids.has(answer.choice) ? answer.choice : null;
  }
  const t = norm(typeof answer === 'object' ? answer?.text : answer);
  if (!t) return null;
  const byLabel = options.find((o) => norm(o.label) === t);
  if (byLabel) return byLabel.id;
  if (/^(?:no|nope|cancel|stop|never ?mind|dont|do not|neither)\b/.test(t)) return 'cancel';

  const app = /\b(?:app|application|desktop|program|installed|first|1)\b/.test(t) && !/\bweb ?app\b/.test(t);
  const site = /\b(?:web|website|site|browser|online|chrome|edge|firefox|second|2)\b/.test(t);
  if (ids.has('app') && app && !site) return 'app';
  if (ids.has('site') && site && !app) return 'site';

  // A bare yes only answers a yes-or-no question: "the app or the website?"
  // cannot be answered with "yes".
  if (!ids.has('app') && ids.has('site') && /^(?:yes|yeah|yep|sure|ok|okay|go ahead|do it|please|open it)\b/.test(t)) return 'site';
  return null;
}

/* --------------------------------------------------------------------------
   Opening
   -------------------------------------------------------------------------- */

/** Start an app by its Start-menu ID, the way clicking it in Start does. */
export function launchApp(app) {
  return new Promise((resolve, reject) => {
    // No shell, so nothing in the ID is interpreted. explorer.exe exits with
    // 1 even on success, so its exit code means nothing either way.
    const p = spawn('explorer.exe', [`shell:AppsFolder\\${app.id}`], { detached: true, stdio: 'ignore', windowsHide: true });
    p.once('error', reject);
    p.unref();
    setTimeout(resolve, 80);
  });
}

/* Browsers Halo knows how to start with an address, for a person who has
   said which one they use. Anyone else's address goes to the default. */
const BROWSERS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  firefox: ['Mozilla Firefox', 'firefox.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
};
const ROOTS = () => [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);

/**
 * The browser a person has said they use, as a program to start — or null
 * for the default. Read from what they told Halo ("I use Firefox"), so the
 * answer is theirs rather than a guess from what happens to be installed.
 */
export function preferredBrowser(facts = []) {
  const said = facts.map((f) => (typeof f === 'string' ? f : f?.text ?? '')).join(' ').toLowerCase();
  if (!/\b(?:browser|use|prefer)\b/.test(said)) return null;
  for (const [name, rel] of Object.entries(BROWSERS)) {
    if (!said.split(/[^a-z]+/).includes(name)) continue;
    for (const root of ROOTS()) {
      const exe = join(root, ...rel);
      if (existsSync(exe)) return { name, exe };
    }
  }
  return null;
}

/** Hand an address to the default browser, or to the one the person uses. */
export function openUrl(url, browser = null) {
  let href;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not a web address');
    href = u.href;
  } catch {
    return Promise.reject(new Error(`"${url}" is not a web address`));
  }
  return new Promise((resolve, reject) => {
    const exe = browser?.exe || 'explorer.exe';
    const p = spawn(exe, [href], { detached: true, stdio: 'ignore', windowsHide: true });
    p.once('error', reject);
    p.unref();
    setTimeout(() => resolve(href), 80);
  });
}

/**
 * Wait for what was just opened to be there, and in front.
 *
 * Judged by the foreground window's title or process mentioning the app's
 * name — or, for apps whose windows never say their own name, by a window
 * that was not there before coming to the front. `foreground()` returns
 * `{ hwnd, title, process }` or null.
 *
 * `foreground` alone is not enough, and believing it cost a whole run: a
 * video went fullscreen and took the foreground while Notepad was starting,
 * Notepad's window came up perfectly well behind it, and Halo reported
 * "I started the Notepad app, but its window didn't come up" and stopped.
 *
 * So ask the other question too, when the caller can answer it: is there a
 * window of this app on screen at all? If there is, and something else is in
 * front of it, that is not a failure to open - it is a window that needs
 * raising, which is what `focus` is for. Opening something is a request to
 * have it in front, so put it there.
 */
export async function waitForWindow({ name, foreground, windows = null, focus = null, before = null, timeout = 12_000 }) {
  const words = norm(name).split(' ').filter((w) => w.length > 2 && !['microsoft', 'google', 'the'].includes(w));
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    let fg = null;
    try { fg = await foreground(); } catch { /* keep waiting */ }
    if (!fg) continue;
    const said = norm(`${fg.title ?? ''} ${fg.process ?? ''}`);
    if (words.some((w) => said.includes(w))) return fg;
    if (before && fg.hwnd && fg.hwnd !== before.hwnd && !isHaloWindow(fg.title)
      && !/^(?:search|start|searchhost|startmenuexperiencehost|explorer)$/.test(norm(fg.process))) {
      return fg;
    }
  }

  /* Nothing ever came to the front. Before calling that a failure to open,
     look for the window itself: something else holding the foreground is a
     different problem from the app not starting, and only one of the two is
     worth stopping for. */
  if (windows) {
    try {
      const list = (await windows()) ?? [];
      const found = list.find((w) => w && !w.minimized && !w.tool
        && words.some((x) => norm(`${w.title ?? ''} ${w.process ?? ''}`).includes(x)));
      if (found) {
        if (focus && found.hwnd) {
          try { await focus(found.hwnd); } catch { /* it is open either way */ }
        }
        return found;
      }
    } catch { /* no window list to consult: the answer below stands */ }
  }
  return null;
}

/* --------------------------------------------------------------------------
   Opening, start to finish
   -------------------------------------------------------------------------- */

/**
 * What an already-open window is showing, from its title.
 *
 * "Pico.sln - Notepad" is Notepad showing Pico.sln; "Untitled - Notepad" is
 * a blank one; a title that is only the app's name says nothing more.
 */
export function showing(title, appName) {
  const t = String(title ?? '').trim();
  if (!t) return null;
  const words = norm(appName).split(' ').filter((w) => w.length > 2 && !['microsoft', 'google', 'the'].includes(w));
  const parts = t.split(/\s+[-—–|]\s+/).map((p) => p.trim()).filter(Boolean);
  const rest = parts.filter((p) => !words.some((w) => norm(p).includes(w)));
  const doc = rest.join(' - ').replace(/^\*+|\*+$/g, '').trim();
  if (!doc || /^(?:untitled|new tab|home|start|welcome)$/i.test(doc)) return null;
  return doc;
}

/** A window of this app that is already on screen, or null. */
async function openWindowOf(appName, windows) {
  if (!windows) return null;
  const words = norm(appName).split(' ').filter((w) => w.length > 2 && !['microsoft', 'google', 'the'].includes(w));
  if (!words.length) return null;
  try {
    const list = (await windows()) ?? [];
    return list.find((w) => w && !w.minimized && !w.tool && !isHaloWindow(w.title)
      && words.some((x) => norm(`${w.title ?? ''} ${w.process ?? ''}`).includes(x))) ?? null;
  } catch { return null; }
}

const hostOf = (url) => {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return ''; }
};

/**
 * Open an app or a website, asking which when it is both.
 *
 * The one way Halo opens things. There used to be two — one for "open X"
 * typed on its own, one for a plan step that opens something — and they had
 * already drifted: only one of them noticed an app was already running with
 * someone's file in it, and only the other would offer a website when the
 * app was not installed. Everything either did is here.
 *
 * @param {object} what   { name } or { url } — as said, or as planned
 * @param {object} io
 *   computer    foreground(), focus(hwnd), sense.windows()
 *   task        the whole request, for "the app" / "the website" wording
 *   choices     Map of name -> 'app' | 'site' already settled this run
 *   ask(question, options) -> Promise<{ text, choice }>
 *   gate()      -> Promise<boolean>, false once the run is stopped
 *   onAction({ type, detail })
 *   before      the window in front before opening, to recognise a new one
 *   remembered(key) -> 'app' | 'site' | null   an answer kept from before
 *   remember(key, pick, { app, site })         keep an answer just given
 *   browser     { exe } of the browser the person uses, or null
 *   unknown     'skip' to return early for a name that is neither an app nor
 *               a known site (the planner may know it as a folder or a
 *               setting), or 'fail' to say so
 *
 * @returns {Promise<{
 *   outcome: 'opened'|'already-open'|'not-opened'|'declined'|'unclear'|'unknown'|'stopped',
 *   ok: boolean,      it is open and in front (or a page was handed over)
 *   kind: 'app'|'site'|'url'|null,
 *   key, pick, label, window,
 *   said,             what happened, for a model
 *   summary,          what happened, for the person
 *   note,             for a plan carrying on in what was opened
 * }>}
 */
export async function open(what, io = {}) {
  const {
    computer = null, task = '', choices = new Map(), ask = null, gate = async () => true,
    onAction = () => {}, before = null, remembered = () => null, remember = () => {},
    browser = null, unknown = 'fail',
  } = io;
  const foreground = () => computer?.foreground?.() ?? null;
  const windows = computer?.sense ? () => computer.sense.windows() : null;
  const focus = (h) => computer?.focus?.(h);

  let name = String(what?.name ?? '').trim();
  let url = what?.url ? String(what.url).trim() : null;

  /* --- an address ------------------------------------------------------- */
  if (url) {
    const host = hostOf(url);
    if (!host || !host.includes('.')) {
      name = name || url;                     // "open_url: whatsapp" is a name
      url = null;
    } else {
      /* An address for a site that is also an installed app is still the
         person's call. The planner turning "open WhatsApp" into
         web.whatsapp.com is exactly the guess the question exists to stop —
         unless the request itself said website, or it was settled already. */
      const known = [...SITES.entries()].find(([, s]) => hostOf(s.url) === host);
      const settled = known && (preference(task) || choices.has(known[0]) || remembered(`open:${known[0]}`));
      if (known && known[1].app && !settled && await findApp(known[0])) {
        name = known[0];
        url = null;
      } else {
        onAction({ type: 'Keypress', detail: `Open ${host}` });
        const href = await openUrl(url, browser);
        const fg = await waitForWindow({ name: host.split('.')[0], foreground, before, timeout: 6000, windows, focus });
        return {
          outcome: 'opened', ok: true, kind: 'url', key: null, pick: 'site', label: host, window: fg ?? null,
          said: `opened ${href} in the browser`,
          summary: `Opened ${host}.`,
          note: `Already done before this: opened ${href} in the browser${fg?.title ? `; its window is titled "${fg.title}"` : ''}. Carry on there.`,
        };
      }
    }
  }

  /* --- a name ----------------------------------------------------------- */
  const key = norm(name);
  let decision = await resolve(key, task);
  const settled = choices.get(key) ?? (preference(task) ? null : remembered(`open:${key}`));
  if (settled === 'app' && decision.app) decision = { kind: 'app', app: decision.app };
  if (settled === 'site' && decision.site) decision = { kind: 'site', site: decision.site };

  if (decision.kind === 'unknown') {
    return {
      outcome: 'unknown', ok: false, kind: null, key, pick: null, label: decision.name, window: null,
      skip: unknown === 'skip',
      said: `there is no app called "${name}" on this computer${decision.web ? '' : ' and it is not a website Halo knows'}`,
      summary: `I couldn't find anything called "${name}" to open.`,
      note: '',
    };
  }

  if (decision.kind === 'ask' || decision.kind === 'missing-app') {
    if (!ask) {
      return { outcome: 'unclear', ok: false, kind: null, key, pick: null, label: name, window: null, said: 'it could be the app or the website, and there was no way to ask', summary: 'I was not sure whether you meant the app or the website, so I left it.', note: '' };
    }
    const answer = await ask(decision.question, decision.options);
    if (!(await gate())) return { outcome: 'stopped', ok: false, stop: true, kind: null, key, pick: null, label: name, window: null, said: '', summary: '', note: '' };
    const pick = readChoice(answer, decision.options);
    if (!pick || pick === 'cancel') {
      return {
        outcome: pick === 'cancel' ? 'declined' : 'unclear',
        ok: false, stop: true, kind: null, key, pick: null, label: name, window: null,
        said: pick === 'cancel' ? 'you said not to' : `you answered "${answer?.text ?? ''}"`,
        summary: pick === 'cancel'
          ? 'Okay — I left it.'
          : `I wasn't sure which you meant from "${answer?.text ?? ''}", so I left it. Say "the app" or "the website".`,
        note: '',
      };
    }
    choices.set(key, pick);
    // A real choice between two real things is worth keeping, so the same
    // name is not asked about again. "No thanks" to a missing app is not.
    if (decision.kind === 'ask') remember(`open:${key}`, pick, { app: decision.app, site: decision.site });
    decision = pick === 'app' ? { kind: 'app', app: decision.app } : { kind: 'site', site: decision.site };
  }

  if (decision.kind === 'site') {
    onAction({ type: 'Keypress', detail: `Open ${decision.site.label}` });
    const href = await openUrl(decision.site.url, browser);
    const fg = await waitForWindow({ name: decision.site.label, foreground, before, timeout: 6000, windows, focus });
    return {
      outcome: 'opened', ok: true, kind: 'site', key, pick: 'site', label: decision.site.label, window: fg ?? null,
      said: `opened ${href} in the browser`,
      summary: `Opened ${decision.site.label}.`,
      note: `Already done before this: opened ${decision.site.label} in the browser${fg?.title ? `; its window is titled "${fg.title}"` : ''}. Carry on there.`,
    };
  }

  /* --- an app ----------------------------------------------------------- */
  const app = decision.app;
  /* Was it already open, and with what in it?

     "Opened Notepad" is true either way and useless in the case that
     matters: the app was already running with somebody's file loaded, and
     what comes to the front is that file, not a blank page. The next step
     is usually to type, and typing into a document someone was working on
     is not a small mistake. So find out first, and say which it was — to
     the model and to the person, in the same breath. */
  const already = await openWindowOf(app.name, windows);
  onAction({ type: 'Keypress', detail: already ? `Bring ${app.name} to the front` : `Open ${app.name}` });
  await launchApp(app);
  const fg = await waitForWindow({ name: app.name, foreground, before, windows, focus });

  if (!fg) {
    return {
      outcome: 'not-opened', ok: false, kind: 'app', key, pick: 'app', label: app.name, window: null,
      said: `started ${app.name}, but no window of it came to the front yet`,
      summary: `I started ${app.name}, but its window didn't come up.`,
      note: '',
    };
  }

  const title = fg.title || already?.title || '';
  const doc = already ? showing(title, app.name) : null;
  if (already) {
    return {
      outcome: 'already-open', ok: true, kind: 'app', key, pick: 'app', label: app.name, window: fg, wasOpen: true,
      said: `brought ${app.name} to the front - it was already open, showing "${title}". `
        + 'That is what is on screen now, not a blank one. If this step needs somewhere new to write, '
        + 'start a new document first rather than typing into that.',
      summary: doc
        ? `${app.name} was already open, showing ${doc}.`
        : `${app.name} was already open, so I brought it to the front.`,
      note: `Already done before this: ${app.name} was ALREADY OPEN and has been brought to the front. `
        + `${title ? `Its window is titled "${title}". ` : ''}Whatever is in it is work that was already there, `
        + 'not a blank start. If this job needs somewhere new to write, begin a new document first rather '
        + 'than typing into that one.',
    };
  }
  return {
    outcome: 'opened', ok: true, kind: 'app', key, pick: 'app', label: app.name, window: fg, wasOpen: false,
    said: `opened the ${app.name} app`,
    summary: `Opened ${app.name}.`,
    note: `Already done before this: opened ${app.name}, which is now in front.${title ? ` Its window is titled "${title}".` : ''} Carry on in it.`,
  };
}
