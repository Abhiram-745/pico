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
const VERB = 'open|launch|start|run|close|quit|minimi[sz]e|maximi[sz]e|click|double-?click|right-?click|press|type|write|enter|fill(?:\\s+in|\\s+out)?|search(?:\\s+for)?|google|look\\s+up|find|go\\s+to|navigate|visit|browse|download|upload|install|uninstall|save|rename|delete|move|copy|paste|cut|select|scroll|switch\\s+to|take|screenshot|play|pause|skip|mute|send|email|reply|forward|post|tweet|book|order|buy|log\\s+in|sign\\s+in|sign\\s+out|check|clear|empty|create|make|add|remove|set\\s+up|turn\\s+(?:on|off)|drag|zoom|refresh|reload|print|export|import|sort|filter|tick|untick|uncheck';

/** What may come before the verb without making it any less of an order. */
const POLITE = '\\s*(?:please|hey|yo|ok|okay|pico|can\\s+you|could\\s+you|would\\s+you|will\\s+you|i\\s+(?:want|need)\\s+you\\s+to|i\\s+(?:want|need)\\s+to|go\\s+ahead\\s+and|now|just)';

/**
 * The verb has to be the thing the sentence is doing, not a word that happens
 * to appear in it. "open" is also in "open question" and "type" in "what type
 * of file is this" — both of which are conversation, not work. So a verb only
 * counts in an imperative position: leading the message (after any politeness
 * that precedes it), or following "and" / "then" in a chain of steps.
 */
const IMPERATIVE_LEAD = new RegExp(`^(?:${POLITE}[,\\s]+)*(?:${VERB})\\b`, 'i');
const CHAINED_VERB = new RegExp(`\\b(?:and|then|,)\\s+(?:${VERB})\\b`, 'i');

const hasImperative = (t) => IMPERATIVE_LEAD.test(t) || CHAINED_VERB.test(t);

/* --------------------------------------------------------------------------
   Certainly a job on the screen

   Most messages with a verb in front are work, but not all — "find me a good
   book", "check my grammar" — so a verb alone still goes to the model. Some
   are said of nothing but a screen, though, and asking a model about those
   cost a third of a second at best — ten when the first model was unsure and
   a second was asked — before anything moved, for an answer that could only
   ever be "agent". Eight of the nine real-site tasks (qa-real.mjs) paid it;
   now none of them does.
   -------------------------------------------------------------------------- */

/** A page or a window named first: "On the Web form page, …", "In the
    Settings window, …". Nobody chats by placing themselves on a page. */
const SCREEN_PLACE = /^\s*(?:on|in|at)\s+(?:the\s+|this\s+|that\s+|my\s+)?(?:[^,.;:!?]|\.(?=\S)){0,60}?\b(?:page|tab|window|screen|site|website|form|dialog|panel|board|app|sidebar|toolbar|docs|documentation|index|repo|repository|article|dashboard|wikipedia|github|youtube|google|amazon|reddit|gmail|outlook|chatgpt|claude|lovable|notion|figma|spotify|discord|slack|whatsapp|linkedin|instagram|facebook)\b(?:[^,.;:!?]|\.(?=\S)){0,40},\s*/i;
/** …followed by an order, not a question: the verbs above, and the ones only a form uses. */
const ORDER = new RegExp(`^(?:${POLITE}[,\\s]+)*(?:${VERB}|choose|pick|set|put|toggle|expand|collapse|hover|leave|mark)\\b`, 'i');
/** Verbs nobody uses in conversation, leading the message. "Drag" and
    "scroll" only with where to: "drag racing" and "scroll of truth" are not. */
const SCREEN_VERB_LEAD = new RegExp(`^(?:${POLITE}[,\\s]+)*(?:(?:double-?|right-?)?click|tick|untick|uncheck|drag\\s.+?\\s(?:to|into|onto|over)\\s|scroll\\s+(?:up|down|left|right|to|through|back|until)\\b)`, 'i');
/** …or as a later step of a chain: "type the name, then click Save". */
const CHAINED_SCREEN_VERB = /\b(?:and|then|,)\s+(?:then\s+)?(?:(?:double-?|right-?)?click|tick|untick|uncheck)\b/i;

/* --------------------------------------------------------------------------
   Certainly a job in a desktop app

   "In File Explorer make a folder called Reports in Documents" and
   "calculate 12 times 7 in Calculator" came back from the rules undecided:
   the order is not the first word of the first one, and "calculate" is not
   an order in the second at all. Undecided goes to a model, and a model that
   is unsure answers chat — so Halo worked out 84 in words, or explained how
   to make a folder, while Calculator and Explorer sat there unused. Naming
   an app on this computer as the place to do it is as plain as naming a
   page: nobody says "in Notepad" about a conversation.

   A question still wins ("in Excel, how do I freeze a row?"), and so does a
   sentence with no order in it ("I love working in Excel"). "Calculate 12
   times 7" with no app named is a sum to answer, and is chat.
   -------------------------------------------------------------------------- */

/** Apps and places on this computer that are only ever that, by the names people use. */
const DESKTOP_APPS = String.raw`(?:(?:file|windows)\s+explorer|explorer|this\s+pc|notepad|calculator|calc|(?:windows\s+)?settings|control\s+panel|(?:ms\s+)?paint(?:\s+3d)?|word(?!\s+(?:order|for|of|form|count)\b)|excel|powerpoint|onenote|outlook|wordpad|start\s+menu|task\s+manager|device\s+manager|terminal|command\s+prompt|cmd|powershell|snipping\s+tool|photos|vs\s?code|visual\s+studio\s+code|recycle\s+bin|(?:documents|downloads|desktop|pictures|music|videos)\s+folder)`;
const DESKTOP_PLACE = new RegExp(String.raw`\b(?:in|inside|into|using|on|from|via)\s+(?:the\s+|my\s+|a\s+new\s+|windows\s+|microsoft\s+)?${DESKTOP_APPS}(?:\s+(?:app|window))?\b`, 'i');
/** An order for a desktop app: the screen verbs, and the ones only an app is given. */
const DESKTOP_ORDER = new RegExp(`^(?:${VERB}|choose|pick|set|put|toggle|expand|collapse|mark|calculate|compute|work\\s+out|draw|sketch|change|adjust|edit|format|insert|highlight|pin|unpin)\\b`, 'i');
const POLITE_LEAD = new RegExp(`^(?:${POLITE}[,\\s]+)*`, 'i');

/** Folders on this computer, said as places: "go to Downloads", "my documents". */
const KNOWN_FOLDER = /\b(?:documents|downloads|desktop|pictures|music|videos)\s+folder\b|\bmy\s+(?:documents|downloads|desktop|pictures|music|videos|files|computer|pc)\b|\b(?:this\s+pc|recycle\s+bin|program\s+files|appdata)\b|\b[c-h]:\\|\b(?:in|to|into|from|on|under)\s+(?:the\s+)?(?:documents|downloads|desktop|pictures|videos)\b/i;

/** "Save it as report.txt": only a program saves as. */
const SAVE_AS = /\bsave\s+(?:it|this|that|them|everything|the\s+\w+|a\s+copy)?\s*as\b/i;

/** Arithmetic asked for with no app named: a sum to answer in words. */
const A_SUM = new RegExp(`^(?:${POLITE}[,\\s]+)*(?:calculate|compute|work\\s+out|solve)\\b.*(?:\\d|\\b(?:plus|minus|times|divided|percent|squared|root)\\b)`, 'i');

/**
 * Where in the message a desktop app is named as the place to work — one of
 * the fixed names above, or an app on this computer by its exact Start-menu
 * name, when the caller can say what is installed (`installed(name)`, e.g.
 * apps.installedNamed). This file is also the browser preview's router
 * (scripts/build-site.mjs copies it as it is), so it cannot ask Windows
 * itself: without a caller that can, the fixed names are all there is.
 * Returns { index, end } or null.
 */
function desktopPlace(t, installed = null) {
  const m = DESKTOP_PLACE.exec(t);
  if (m) return { index: m.index, end: m.index + m[0].length };
  if (typeof installed !== 'function') return null;
  for (const p of t.matchAll(/\b(?:in|inside|into|using|on|from)\s+(?:the\s+|my\s+)?([a-z0-9][\w+'-]*(?:\s+[a-z0-9][\w+'-]*){0,2})/gi)) {
    const words = p[1].split(/\s+/);
    for (let k = words.length; k >= 1; k--) {
      const name = words.slice(0, k).join(' ');
      let found = null;
      try { found = installed(name); } catch { /* no list is no match */ }
      if (found) return { index: p.index, end: p.index + p[0].length - p[1].length + name.length };
    }
  }
  return null;
}

/** Named surfaces. Mentioning one is strong evidence the screen is involved. */
const APP_OR_SURFACE = /\b(?:chrome|edge|firefox|safari|browser|notepad|word|excel|powerpoint|outlook|gmail|mail|inbox|spotify|youtube|netflix|discord|slack|teams|zoom|whatsapp|telegram|vscode|vs\s?code|terminal|powershell|cmd|explorer|file\s?explorer|settings|control\s?panel|taskbar|start\s?menu|desktop|clipboard|calendar|calculator|photos|steam|figma|notion|github|reddit|twitter|instagram|facebook|linkedin|amazon|tab|window|folder|file|screen)\b/i;

/** A URL or bare domain is always a destination to go to. */
const LOOKS_LIKE_URL = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|dev|co|ai|app|gov|edu|uk)\b/i;

/* --------------------------------------------------------------------------
   Signals for a message that has something attached — pasted text, a file,
   a picture (see bridge/attachments.mjs for the shape). Checked only when
   there is at least one, so a message with nothing attached is routed
   exactly as it always was: neither pattern below can fire without an
   attachment to be about, and every existing case in test-intent.mjs sends
   none.
   -------------------------------------------------------------------------- */

/** Doing something WITH what was attached — "paste each one", "put this
    into…", "fill in…", "send this to…". Wider than the general VERB list
    above on purpose: "put" is not an instruction on its own ("put the
    kettle on" is prose to nobody in particular), but "put this into
    ChatGPT" with a picture attached plainly is. */
const ATTACHMENT_ACTION = /\b(?:paste|put|type|fill(?:\s+in|\s+out)?|send|enter|drop|upload|attach|copy|insert)\b/i;

/** Asking about what was attached rather than asking for it to be used
    somewhere — "what's in this image", "summarise this", "explain". */
const ATTACHMENT_QUESTION = /\bwhat.?s?\s+(?:in|on)\b|\bsummaris|\bsummariz|\bexplain\b|\bdescribe\b|\banaly[sz]e\b|\btell\s+me\s+about\b/i;

/** Putting what was attached into a named place: a paste or send, and where. */
const ATTACHMENT_TO_PLACE = /\b(?:paste|put|send|drop|upload|attach|insert)\b[^.?!]{0,60}?\b(?:into|in|to|onto)\s+(?:the\s+|my\s+|a\s+new\s+)?(?:chat|message\s+box|chat\s+box|prompt\s+box|chatgpt|claude|gemini|copilot|lovable|perplexity|grok|whatsapp|discord|slack|teams|telegram|messenger|notepad|word|gmail|outlook|email|paint|figma|notion)\b/i;

const clean = (text) => String(text ?? '').trim();

/**
 * Decide from the text alone.
 * @param {string} text
 * @param {object} [opts]
 * @param {Array} [opts.attachments]  pasted text, files or pictures sent
 *   along with this message — see bridge/attachments.mjs. Only ever makes
 *   the call more confident, never less: with none, this behaves exactly as
 *   it did before attachments existed.
 * @param {Function} [opts.installed]  name -> an installed app or null, from
 *   a list already read (apps.installedNamed); lets "in <any installed app>"
 *   count as a place to work. Optional: the fixed names work without it.
 * @returns {{mode:'chat'|'agent', why:string, certain:boolean}|null}
 *          null when the rules genuinely cannot call it.
 */
export function localRoute(text, { attachments = [], installed = null } = {}) {
  const t = clean(text);
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (!t) {
    // Nothing typed. With something attached, that is not "nothing to do"
    // — it is a picture or a document with no instruction on it, which is
    // answered rather than acted on: the safer of the two when nothing
    // says which.
    return hasAttachments
      ? { mode: 'chat', why: 'something was attached with nothing said about it', certain: true }
      : { mode: 'chat', why: 'nothing to do', certain: true };
  }

  if (PLEASANTRY.test(t)) return { mode: 'chat', why: 'a greeting', certain: true };

  if (ABOUT_PICO.some((re) => re.test(t))) {
    return { mode: 'chat', why: 'a question about Halo', certain: true };
  }

  if (hasAttachments) {
    /* Sent somewhere first, whatever it goes on to ask: "paste this picture
       into ChatGPT and ask what's in it" is a job — the question is for
       ChatGPT — but the question check below answered it about the
       picture instead, as conversation. */
    if (ATTACHMENT_TO_PLACE.test(t)) {
      return { mode: 'agent', why: 'an instruction to put what was attached somewhere', certain: true };
    }
    if (ATTACHMENT_QUESTION.test(t)) {
      return { mode: 'chat', why: 'asks about what was attached', certain: true };
    }
    if (ATTACHMENT_ACTION.test(t)) {
      return { mode: 'agent', why: 'an instruction for what was attached', certain: false };
    }
  }

  const surface = APP_OR_SURFACE.test(t);
  const inApp = desktopPlace(t, installed);

  // Prose asked for by name. Checked before the verbs, because "write" and
  // "tell" lead both kinds of sentence. Naming a place to put it flips it
  // back: "write a haiku in Notepad" is work.
  if (WANTS_PROSE.test(t) && !surface && !inApp) {
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
  // "Click", "tick", a page named first: an action on the screen, said so
  // plainly that asking a model would only cost the time. A question about
  // clicking ("what happens if I click…") is still a question.
  const place = SCREEN_PLACE.exec(t);
  const afterPlace = place ? t.slice(place[0].length) : '';
  if (SCREEN_VERB_LEAD.test(t)
    || (place && ORDER.test(afterPlace) && !ASKS_FOR_AN_ANSWER.some((re) => re.test(afterPlace)))
    || (!question && CHAINED_SCREEN_VERB.test(t))) {
    return { mode: 'agent', why: 'an action on the screen', certain: true };
  }

  /* An app on this computer named as the place, and an order to carry out
     in it — before it ("calculate 12 times 7 in Calculator") or after it
     ("in File Explorer make a folder"). Not a question, in either half. */
  if (inApp) {
    const body = t.replace(POLITE_LEAD, '');
    const lead = t.length - body.length;
    const order = inApp.index <= lead ? t.slice(inApp.end).replace(/^[\s,:;-]+/, '') : body;
    const asks = question || /\?\s*$/.test(t) || ASKS_FOR_AN_ANSWER.some((re) => re.test(order));
    if (!asks && (DESKTOP_ORDER.test(order) || CHAINED_VERB.test(t))) {
      return { mode: 'agent', why: 'an action in an app on this computer', certain: true };
    }
  }

  // "Save it as report.txt": only a program has a Save As.
  if (!question && verb && SAVE_AS.test(t)) {
    return { mode: 'agent', why: 'saving a file', certain: true };
  }

  // A sum with no app named is answered in words, not worked on a screen —
  // unless something is to be done with the answer ("…and type it").
  if (A_SUM.test(t) && !surface && !inApp && !CHAINED_VERB.test(t)) {
    return { mode: 'chat', why: 'a sum to answer', certain: true };
  }

  if (question && !verb) {
    return { mode: 'chat', why: 'a question, with nothing to act on', certain: true };
  }

  if (verb && surface) return { mode: 'agent', why: 'an action on a named app', certain: true };
  /* An order about a folder on this computer — "go to Downloads", "search
     my documents for the report" — is work on this computer, as plainly as
     one that names an app. */
  if (verb && KNOWN_FOLDER.test(t)) return { mode: 'agent', why: 'an action on a folder on this computer', certain: true };
  if (verb) return { mode: 'agent', why: 'an instruction', certain: false };

  return null;   // genuinely ambiguous — ask the model
}

const CLASSIFY_SYSTEM =
  'Classify the user message for a Windows desktop assistant. Answer with ' +
  'exactly one word.\n' +
  'AGENT - they want something done on their computer: opening apps, ' +
  'clicking, typing into a program, browsing, searching the web, managing ' +
  'files. If they mention something attached, AGENT also covers using it — ' +
  'pasting it in, filling it into a form, sending or uploading it.\n' +
  'CHAT - they are talking, greeting, asking a question, or want something ' +
  'written or explained back to them. If they mention something attached, ' +
  'CHAT also covers asking about it, describing it or summarising it.\n' +
  'If unsure, answer CHAT.';

/**
 * Route a message. Local rules first, the model only when they cannot call it.
 *
 * @param {string} text
 * @param {object} opts
 * @param {'auto'|'chat'|'agent'} opts.hint  explicit choice from the UI
 * @param {object} opts.llm                  attached provider, or null
 * @param {Array} [opts.attachments]         pasted text, files or pictures
 *   sent with this message — see bridge/attachments.mjs
 * @param {Function} [opts.installed]        name -> installed app or null (see localRoute)
 * @returns {Promise<{mode:'chat'|'agent', why:string, source:string}>}
 */
export async function route(text, { hint = 'auto', llm = null, attachments = [], installed = null } = {}) {
  if (hint === 'chat' || hint === 'agent') {
    return { mode: hint, why: 'you chose it', source: 'user' };
  }

  const local = localRoute(text, { attachments, installed });
  if (local?.certain) return { ...local, source: 'rules' };

  const fallback = local
    ? { ...local, source: 'rules' }
    : { mode: 'chat', why: 'not clearly an instruction', source: 'rules' };

  if (!llm) return fallback;

  // Said once, folded into both prompts below, so a model asked to settle
  // an otherwise-ambiguous message also knows there is something attached —
  // "put this in" reads as a job only once "this" names a real attachment.
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const attachmentNote = hasAttachments
    ? ` They also attached ${attachments.length} item${attachments.length === 1 ? '' : 's'} (pasted text, a file, or a picture).`
    : '';

  /* Ask the evaluation model first.

     This is a classification, not a conversation — which of two things is
     this sentence — and that is precisely what an evaluation model is for.
     Jev answers it in about a third of a second for nothing, with a
     probability attached, where the same question put to a chat model costs
     a two-second round trip and comes back as a word to be matched with a
     regular expression. It also cannot wander off and reply with a sentence,
     which the chat models sometimes do.

     The confidence is checked rather than taken: an answer the model itself
     is unsure of is worse than the local rules, which at least know what
     "open" means. Anything missing, slow or unconvincing falls through to
     the chat model below, exactly as before. */
  const answers = await llm.evaluate?.(
    `The person typed this to a desktop assistant: "${clean(text).slice(0, 500)}"${attachmentNote}`,
    {
      kind: {
        type: 'choice',
        instructions: 'Is this a job to carry out on the computer, or just conversation?',
        criteria: {
          agent: 'an instruction to operate the desktop: open, click, type, find, send, buy, play'
            + (hasAttachments ? ', or to do something with what they attached — paste it, fill it in, send it, upload it' : ''),
          chat: 'a question, a greeting, or a remark that expects an answer in words'
            + (hasAttachments ? ', including asking about, describing or summarising what they attached' : ''),
        },
      },
    },
    { timeout: 4000 },
  ).catch(() => null);
  const pick = answers?.kind;
  if (pick?.choice && (pick.probabilities?.[pick.choice] ?? 0) >= 0.7) {
    return {
      mode: pick.choice === 'agent' ? 'agent' : 'chat',
      why: pick.choice === 'agent' ? 'reads as an instruction' : 'reads as conversation',
      source: 'evaluation',
    };
  }

  try {
    const answer = await llm.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: `${clean(text).slice(0, 500)}${attachmentNote}` },
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
