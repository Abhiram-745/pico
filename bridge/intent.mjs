/* ==========================================================================
   Halo — intent router: is this a message, or a job?

   "hello" must not open Notepad and type "hello". Before this file, every
   line typed into Halo was treated as a task to perform on the desktop,
   which made small talk indistinguishable from an instruction.

   Two stages, in this order:

     1. Local rules. Free and instant, and they settle the overwhelming
        majority: greetings and questions about Halo itself are chat;
        an imperative aimed at an app or the screen is a job.
     2. The model, only for what the rules genuinely cannot call. One nano
        request, constrained to a single word.

   A wrong answer is not symmetrical. Treating a job as chat costs the user
   one extra click; treating chat as a job takes over their desktop. So the
   undecided case resolves to chat, and the UI always shows which was chosen
   with a one-click way to override it.
   ========================================================================== */

export const MODES = ['auto', 'chat', 'agent'];

/* --------------------------------------------------------------------------
   Signals for chat
   -------------------------------------------------------------------------- */

/** A whole message that is only a greeting, thanks, or a sign-off. */
const PLEASANTRY = /^(?:hi|hii+|hey+|hello|yo|sup|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening|night)|thanks?|thank\s+you|ty|thx|cheers|ok|okay|k|cool|nice|great|lol|haha|bye|goodbye|see\s+ya|gn|gm)(?:\s+(?:there|again|pico|buddy|mate|man|bro|friend))?\b[\s!.?,]*$/i;

/**
 * Asking for something written back, not done. "write" is a desktop verb in
 * "write this into the file" and a request for prose in "write me a poem" —
 * the object is what separates them.
 */
const WANTS_PROSE = /\b(?:write|draft|compose|make\s+up|come\s+up\s+with|think\s+of|give|tell|suggest)\s+(?:me|us)?\s*(?:a|an|some|the)?\s*(?:poem|story|joke|jokes|song|essay|haiku|limerick|rap|riddle|quote|caption|tagline|slogan|name|names|idea|ideas|summary|explanation|example|examples|recipe|list\s+of)\b/i;

/** Asking Halo about itself, rather than telling it to do something. */
const ABOUT_PICO = [
  /\b(?:who|what)\s+(?:are|r)\s+(?:you|u)\b/i,
  /\bwhat(?:.s| is)?\s+your\s+name\b/i,
  /\bwhat\s+(?:can|could|do)\s+(?:you|u)\s+do\b/i,
  /\bhow\s+(?:do|does)\s+(?:you|this|it)\s+work\b/i,
  /\bare\s+(?:you|u)\s+(?:there|ok|working|alive|real)\b/i,
  /\bcan\s+(?:you|u)\s+(?:hear|see|help)\b/i,
  /\bwhat\s+(?:is|are)\s+(?:pico|your)\b/i,
];

/** Questions and requests for prose, which are answered rather than performed. */
const ASKS_FOR_AN_ANSWER = [
  /^\s*(?:what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will)\b/i,
  /\b(?:explain|describe|tell me about|what do you think|your (?:opinion|thoughts))\b/i,
  /\b(?:define|meaning of|difference between)\b/i,
];

/* --------------------------------------------------------------------------
   Signals for a job

   A verb alone is not enough — "open" is in "open question" and "type" is in
   "what type of file". Each of these has to be the thing the sentence is
   actually doing, so they are weighed against the question signals below
   rather than trusted on their own.
   -------------------------------------------------------------------------- */

/** Verbs that only make sense as something done to the machine. */
const VERB = 'open|launch|start|run|close|quit|minimi[sz]e|maximi[sz]e|click|double-?click|right-?click|press|type|write|enter|fill(?:\\s+in|\\s+out)?|search(?:\\s+for)?|google|look\\s+up|find|go\\s+to|navigate|visit|browse|download|upload|install|uninstall|save|rename|delete|move|copy|paste|cut|select|scroll|switch\\s+to|take|screenshot|play|pause|skip|mute|send|email|reply|forward|post|tweet|book|order|buy|log\\s+in|sign\\s+in|sign\\s+out|check|clear|empty|create|make|add|remove|set\\s+up|turn\\s+(?:on|off)|drag|zoom|refresh|reload|print|export|import|sort|filter';

/**
 * The verb has to be the thing the sentence is doing, not a word that happens
 * to appear in it. "open" is also in "open question" and "type" in "what type
 * of file is this" — both of which are conversation, not work. So a verb only
 * counts in an imperative position: leading the message (after any politeness
 * that precedes it), or following "and" / "then" in a chain of steps.
 */
const IMPERATIVE_LEAD = new RegExp(
  `^(?:\\s*(?:please|hey|yo|ok|okay|pico|can\\s+you|could\\s+you|would\\s+you|will\\s+you|i\\s+(?:want|need)\\s+you\\s+to|i\\s+(?:want|need)\\s+to|go\\s+ahead\\s+and|now|just)[,\\s]+)*(?:${VERB})\\b`,
  'i',
);
const CHAINED_VERB = new RegExp(`\\b(?:and|then|,)\\s+(?:${VERB})\\b`, 'i');

const hasImperative = (t) => IMPERATIVE_LEAD.test(t) || CHAINED_VERB.test(t);

/** Named surfaces. Mentioning one is strong evidence the screen is involved. */
const APP_OR_SURFACE = /\b(?:chrome|edge|firefox|safari|browser|notepad|word|excel|powerpoint|outlook|gmail|mail|inbox|spotify|youtube|netflix|discord|slack|teams|zoom|whatsapp|telegram|vscode|vs\s?code|terminal|powershell|cmd|explorer|file\s?explorer|settings|control\s?panel|taskbar|start\s?menu|desktop|clipboard|calendar|calculator|photos|steam|figma|notion|github|reddit|twitter|instagram|facebook|linkedin|amazon|tab|window|folder|file|screen)\b/i;

/** A URL or bare domain is always a destination to go to. */
const LOOKS_LIKE_URL = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|dev|co|ai|app|gov|edu|uk)\b/i;

const clean = (text) => String(text ?? '').trim();

/**
 * Decide from the text alone.
 * @returns {{mode:'chat'|'agent', why:string, certain:boolean}|null}
 *          null when the rules genuinely cannot call it.
 */
export function localRoute(text) {
  const t = clean(text);
  if (!t) return { mode: 'chat', why: 'nothing to do', certain: true };

  if (PLEASANTRY.test(t)) return { mode: 'chat', why: 'a greeting', certain: true };

  if (ABOUT_PICO.some((re) => re.test(t))) {
    return { mode: 'chat', why: 'a question about Halo', certain: true };
  }

  const surface = APP_OR_SURFACE.test(t);

  // Prose asked for by name. Checked before the verbs, because "write" and
  // "tell" lead both kinds of sentence. Naming a place to put it flips it
  // back: "write a haiku in Notepad" is work.
  if (WANTS_PROSE.test(t) && !surface) {
    return { mode: 'chat', why: 'asks for something written back', certain: true };
  }

  // A single bare word is small talk far more often than an instruction —
  // unless the word is an app, in which case it names a thing to open.
  if (t.split(/\s+/).length === 1 && !LOOKS_LIKE_URL.test(t)) {
    return surface
      ? { mode: 'agent', why: 'names an app to open', certain: true }
      : { mode: 'chat', why: 'a single word, not an instruction', certain: true };
  }

  // A destination beats everything else: "google.com" is never small talk.
  if (LOOKS_LIKE_URL.test(t)) return { mode: 'agent', why: 'names a site to open', certain: true };

  const verb = hasImperative(t);
  const question = ASKS_FOR_AN_ANSWER.some((re) => re.test(t));

  // "can you open Chrome" is phrased as a question but is plainly a job, so a
  // question only wins when nothing is actually being asked for on screen.
  if (question && !verb) {
    return { mode: 'chat', why: 'a question, with nothing to act on', certain: true };
  }

  if (verb && surface) return { mode: 'agent', why: 'an action on a named app', certain: true };
  if (verb) return { mode: 'agent', why: 'an instruction', certain: false };

  return null;   // genuinely ambiguous — ask the model
}

const CLASSIFY_SYSTEM =
  'Classify the user message for a Windows desktop assistant. Answer with ' +
  'exactly one word.\n' +
  'AGENT - they want something done on their computer: opening apps, ' +
  'clicking, typing into a program, browsing, searching the web, managing ' +
  'files.\n' +
  'CHAT - they are talking, greeting, asking a question, or want something ' +
  'written or explained back to them.\n' +
  'If unsure, answer CHAT.';

/**
 * Route a message. Local rules first, the model only when they cannot call it.
 *
 * @param {string} text
 * @param {object} opts
 * @param {'auto'|'chat'|'agent'} opts.hint  explicit choice from the UI
 * @param {object} opts.llm                  attached provider, or null
 * @returns {Promise<{mode:'chat'|'agent', why:string, source:string}>}
 */
export async function route(text, { hint = 'auto', llm = null } = {}) {
  if (hint === 'chat' || hint === 'agent') {
    return { mode: hint, why: 'you chose it', source: 'user' };
  }

  const local = localRoute(text);
  if (local?.certain) return { ...local, source: 'rules' };

  const fallback = local
    ? { ...local, source: 'rules' }
    : { mode: 'chat', why: 'not clearly an instruction', source: 'rules' };

  if (!llm) return fallback;

  try {
    const answer = await llm.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: clean(text).slice(0, 500) },
      ],
      { model: llm.tiers.fast, maxTokens: 8, signal: AbortSignal.timeout(6000) },
    );
    if (/agent/i.test(answer)) return { mode: 'agent', why: 'reads as an instruction', source: 'model' };
    if (/chat/i.test(answer)) return { mode: 'chat', why: 'reads as conversation', source: 'model' };
  } catch {
    /* the provider is down or slow — the local guess still stands */
  }

  return fallback;
}
