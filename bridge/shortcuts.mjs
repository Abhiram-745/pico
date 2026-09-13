/* ==========================================================================
   Pico — fast paths for simple jobs.

   "Open Notepad" does not need a vision model to look at the screen, think,
   press a key, look again and think again. It needs three keystrokes. Sending
   it through the full loop took several seconds of screenshots and model
   calls to do what a person does without looking.

   So a short list of unambiguous requests is carried out directly:

     open <a known app>      Start menu search, by keyboard — you see it happen
     go to <a site>          handed to the default browser
     search the web for X    a search results page in the default browser

   Anything not matched exactly goes to the full loop, which is also where a
   fast path falls back to if it cannot confirm it worked. The app list is a
   closed list on purpose: typing an arbitrary phrase into Start search and
   pressing Enter launches whatever the top result happens to be.
   ========================================================================== */

import { spawn } from 'node:child_process';

/** What to type into Start search, and how to recognise the window after. */
const APPS = {
  notepad: { search: 'Notepad', window: /notepad/i },
  calculator: { search: 'Calculator', window: /calculator/i },
  calc: { search: 'Calculator', window: /calculator/i },
  chrome: { search: 'Google Chrome', window: /chrome/i },
  'google chrome': { search: 'Google Chrome', window: /chrome/i },
  edge: { search: 'Microsoft Edge', window: /edge/i },
  'microsoft edge': { search: 'Microsoft Edge', window: /edge/i },
  firefox: { search: 'Firefox', window: /firefox/i },
  word: { search: 'Word', window: /word/i },
  'microsoft word': { search: 'Word', window: /word/i },
  excel: { search: 'Excel', window: /excel/i },
  powerpoint: { search: 'PowerPoint', window: /powerpoint/i },
  outlook: { search: 'Outlook', window: /outlook/i },
  teams: { search: 'Microsoft Teams', window: /teams/i },
  spotify: { search: 'Spotify', window: /spotify/i },
  discord: { search: 'Discord', window: /discord/i },
  slack: { search: 'Slack', window: /slack/i },
  whatsapp: { search: 'WhatsApp', window: /whatsapp/i },
  telegram: { search: 'Telegram', window: /telegram/i },
  steam: { search: 'Steam', window: /steam/i },
  'vs code': { search: 'Visual Studio Code', window: /visual studio code|code/i },
  vscode: { search: 'Visual Studio Code', window: /visual studio code|code/i },
  'visual studio code': { search: 'Visual Studio Code', window: /visual studio code|code/i },
  terminal: { search: 'Terminal', window: /terminal|powershell|command prompt/i },
  powershell: { search: 'PowerShell', window: /powershell/i },
  'command prompt': { search: 'Command Prompt', window: /command prompt|cmd/i },
  cmd: { search: 'Command Prompt', window: /command prompt|cmd/i },
  'file explorer': { search: 'File Explorer', window: /explorer/i },
  explorer: { search: 'File Explorer', window: /explorer/i },
  files: { search: 'File Explorer', window: /explorer/i },
  settings: { search: 'Settings', window: /settings/i },
  paint: { search: 'Paint', window: /paint/i },
  'snipping tool': { search: 'Snipping Tool', window: /snipping/i },
  photos: { search: 'Photos', window: /photos/i },
  camera: { search: 'Camera', window: /camera/i },
  clock: { search: 'Clock', window: /clock/i },
  calendar: { search: 'Calendar', window: /calendar|outlook/i },
  'microsoft store': { search: 'Microsoft Store', window: /store/i },
  store: { search: 'Microsoft Store', window: /store/i },
  'task manager': { search: 'Task Manager', window: /task manager/i },
  notion: { search: 'Notion', window: /notion/i },
  obsidian: { search: 'Obsidian', window: /obsidian/i },
  figma: { search: 'Figma', window: /figma/i },
  zoom: { search: 'Zoom', window: /zoom/i },
};

const POLITE = String.raw`(?:(?:please|pls|hey pico|pico|ok|okay|can you|could you|would you|just|now)[,\s]+)*`;
const TRAILER = String.raw`(?:\s+(?:please|pls|for me|now|app))*\s*[.!]*`;

const OPEN_APP = new RegExp(String.raw`^${POLITE}(?:open|launch|start|run|bring up|pull up)\s+(?:up\s+)?(?:the\s+|my\s+)?([a-z][a-z .]{1,30}?)${TRAILER}$`, 'i');

const DOMAIN = String.raw`(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|co|ai|app|gov|edu|uk|me|tv|gg|so|xyz)(?:\/\S*)?`;
const GO_TO = new RegExp(String.raw`^${POLITE}(?:(?:open|go to|goto|visit|navigate to|load|browse to|take me to)\s+)?(${DOMAIN})${TRAILER}$`, 'i');

/** Sites people name without a dot. */
const SITES = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  reddit: 'https://www.reddit.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  netflix: 'https://www.netflix.com',
  amazon: 'https://www.amazon.com',
  chatgpt: 'https://chatgpt.com',
  linkedin: 'https://www.linkedin.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  wikipedia: 'https://www.wikipedia.org',
};
const GO_TO_SITE = new RegExp(String.raw`^${POLITE}(?:open|go to|goto|visit|navigate to|take me to)\s+(${Object.keys(SITES).join('|')})${TRAILER}$`, 'i');

const WEB_SEARCH = new RegExp(String.raw`^${POLITE}(?:search|google|look up|search the web|search online|search google)\s+(?:the web\s+|online\s+|google\s+)?(?:for\s+)?(.{2,200}?)\s*[.!?]*$`, 'i');
const YT_SEARCH = new RegExp(String.raw`^${POLITE}(?:search|find|look up|play)\s+(?:for\s+)?(.{2,120}?)\s+on\s+youtube\s*[.!?]*$`, 'i');

/**
 * Match a request against the fast paths.
 * @returns {null | {kind:'app', name:string, app:object}
 *                | {kind:'url', url:string, label:string}}
 */
export function matchShortcut(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 220) return null;

  // Any second step ("open notepad and type hello") is a job for the loop.
  // A search query may contain "and" on its own ("salt and pepper"), but
  // never a sequencing word.
  const isSearch = WEB_SEARCH.test(t) || YT_SEARCH.test(t);
  if (/\b(?:then|after that|afterwards)\b/i.test(t)) return null;
  if (!isSearch && /\band\b|[,;]/i.test(t)) return null;

  let m = t.match(YT_SEARCH);
  if (m) {
    return {
      kind: 'url',
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}`,
      label: `Searched YouTube for “${m[1]}”.`,
    };
  }

  m = t.match(GO_TO_SITE);
  if (m) {
    const key = m[1].toLowerCase();
    return { kind: 'url', url: SITES[key], label: `Opened ${key.charAt(0).toUpperCase()}${key.slice(1)}.` };
  }

  m = t.match(GO_TO);
  if (m) {
    const raw = m[1];
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return { kind: 'url', url: u.href, label: `Opened ${u.hostname.replace(/^www\./, '')}.` };
    } catch {
      return null;
    }
  }

  m = t.match(WEB_SEARCH);
  if (m && !/\bon\s+(?:youtube|my|the)\b/i.test(m[1])) {
    return {
      kind: 'url',
      url: `https://www.google.com/search?q=${encodeURIComponent(m[1])}`,
      label: `Searched the web for “${m[1]}”.`,
    };
  }

  m = t.match(OPEN_APP);
  if (m) {
    const name = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const app = APPS[name];
    if (app) return { kind: 'app', name: app.search, app };
    if (SITES[name]) return { kind: 'url', url: SITES[name], label: `Opened ${name}.` };
  }

  return null;
}

/** Hand a URL to the default browser. No shell, so nothing in it is parsed. */
function openUrl(url) {
  return new Promise((resolve, reject) => {
    const p = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true });
    p.once('error', reject);
    p.unref();
    // explorer.exe exits with 1 even on success, so its code means nothing.
    setTimeout(resolve, 60);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Carry a matched shortcut out. Resolves true when it is done and confirmed,
 * false when the caller should fall back to the full loop.
 *
 * @param {object} sc        from matchShortcut
 * @param {object} computer  from computer.mjs
 * @param {object} hooks     onAction({type, detail}), gate()
 */
export async function runShortcut(sc, computer, { onAction = () => {}, gate = async () => true } = {}) {
  if (sc.kind === 'url') {
    onAction({ type: 'Keypress', detail: sc.label.replace(/\.$/, '') });
    await openUrl(sc.url);
    return true;
  }

  // An app, through Start search — the same three keystrokes a person uses,
  // visibly, rather than launching a path behind the user's back.
  onAction({ type: 'Keypress', detail: 'Open Start' });
  await computer.keypress(['WIN']);
  await sleep(380);
  if (!(await gate())) return true;

  onAction({ type: 'Type', detail: `Search for ${sc.name}` });
  await computer.type(sc.name);
  await sleep(520);
  if (!(await gate())) return true;

  onAction({ type: 'Keypress', detail: `Open ${sc.name}` });
  await computer.keypress(['ENTER']);

  // Confirm it actually came up before calling it done.
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    await sleep(200);
    if (sc.app.window.test(computer.focusedWindow())) return true;
  }
  return false;
}
