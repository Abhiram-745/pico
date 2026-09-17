/* ==========================================================================
   Halo — the loop that does the work.

   Decide once, then carry it out. That is the whole shape of it.

   WHY IT IS SHAPED THIS WAY
   The first version asked one model, every single turn, "what next?" with the
   whole task in front of it. That answers a question nobody asked: given a
   task and a screen, there is always something else that could plausibly be
   done next. So "click the play button" became click play, then the next
   thing, then the next — accurate each time, and far past what was wanted.

   Now the task is planned once, into the fewest steps that complete it and a
   plain statement of what "done" looks like. After that the loop only ever
   carries out the current step. When the steps run out, the run is over.

   WHICH MODEL DOES WHAT
   Planning needs judgement, so it gets the strongest tier, once. Carrying out
   a step is reading the screen and pointing, so it gets the model measured
   to point most accurately for the money (see PROVIDERS in llm.mjs) — and a
   step that has stalled is handed to the planning tier instead.

   Every call goes through the Responses API with a reasoning effort. Chat
   Completions refuses an effort alongside tools for these models, and the
   old code's quiet retry without one meant nothing here ever reasoned.

   LANDING ON THINGS
   The model sees the screen at the width measured to make its clicks land
   (screen.mjs), names what it is clicking as well as where, and the point is
   then settled against the accessibility layer onto the middle of the
   control it meant (aim.mjs). The user's own pointer makes the click.

   SCROLLING
   A scroll is asked for in screens of the area being scrolled, carried out
   in real wheel notches, measured, corrected, and reported back — how far it
   really went and whether it hit the end (scroll.mjs).

   OPENING THINGS
   Apps and websites are opened directly, never by typing a name somewhere
   and hoping. Something that is both an installed app and a website is the
   person's call, so they are asked which (apps.mjs).

   WHEN SOMETHING ELSE TAKES THE SCREEN
   Keys go to whatever holds focus at the instant they are sent. A video
   going fullscreen mid-run used to make Halo skip the keystroke, look again,
   find the video still in front, skip again — until the turns ran out. Now
   the window being worked in is brought back, once, and the step is looked
   at afresh. If something takes the screen a second time, Halo stops and
   says what took it: fighting a window for focus is how text ends up
   somewhere nobody chose.

   WHEN A STEP GOES WRONG
   One missed click used to end the whole task: a few retries of the same
   step and then a verdict of failure. Now a step that keeps getting nowhere
   sends the rest of the plan back to the planner, with the current screen
   and what went wrong, and the run carries on from there. A few times, not
   forever.

   WHILE IT RUNS
   The plan is published as it changes, step by step, so the person can see
   where Halo is. They can pause, skip the step in hand, or say something —
   "no, the other one" — which is taken as a correction and re-plans what is
   left from the screen as it is.

   KNOWING IT IS DONE
   The verdict used to be a model judging one screenshot, and a compressed
   picture of small text is a poor witness. Windows can simply be asked what
   is in front, what has focus and what text it holds, so it is asked first;
   the picture is only consulted for what those facts cannot settle.

   WHAT IT SENDS
   A JPEG of the desktop, each turn, to the model provider. The settings
   panel says so in as many words; it is not buried here.
   ========================================================================== */

import { assess, describe, ACTION_PHASE, ALLOW } from './policy.mjs';
import * as apps from './apps.mjs';
import { isHaloWindow } from './apps.mjs';
import { settle, fit } from './aim.mjs';
import { scrollBy, regionChanged } from './scroll.mjs';

/** Identity of an action, for spotting a loop. */
const signature = (a) =>
  // Keys are normalised so "escape", "Esc" and "ESC" count as the same press —
  // the model varies the spelling while repeating itself.
  [a.type, a.x, a.y, a.to_x, a.to_y, a.text, a.app, a.url, a.scroll_direction,
    (a.keys || []).map((k) => String(k).toUpperCase().replace(/^ESCAPE$/, 'ESC')).join('+')].join('|');

/**
 * Did the screen meaningfully change?
 *
 * Two tests, because one number cannot answer both halves of the question.
 * The mean catches a whole new window: lots of the picture, a little
 * different. The largest single cell catches the opposite — a button going
 * blue, a checkbox filling in, a menu opening in a corner — which averages
 * away to nothing across a whole desktop, and was once clicked six times
 * over because of it.
 */
const UNCHANGED_BELOW = 1.2;   // mean grey-level difference, 0-255
const CELL_CHANGED_AT = 16;    // one region of the screen, clearly different
function sameScreen(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > peak) peak = d;
  }
  return (sum / a.length) < UNCHANGED_BELOW && peak < CELL_CHANGED_AT;
}

/**
 * Actions that are supposed to leave no trace on the screen. A screenshot
 * does not contain the pointer, so judging "move the mouse" by the picture
 * judges it by the one thing that cannot show it.
 */
const INVISIBLE = new Set(['move', 'wait']);

const POINTER = new Set(['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag']);
const KEYBOARD = new Set(['type', 'key']);
const OPENING = new Set(['open_app', 'open_url']);

/**
 * Actions that can legitimately put a different window in front: a click
 * that opens a dialog, Enter on a link, opening an app. After anything else
 * — typing, scrolling, waiting — a new window in front is not Halo's doing.
 */
const MAY_BRING_WINDOW = new Set(['click', 'double_click', 'right_click', 'middle_click', 'drag', 'key', 'open_app', 'open_url']);

/** How many identical actions in a row before the run is called stuck. */
const STUCK_AFTER = 4;

/** Turns allowed per planned step before it is re-planned (or abandoned). */
const TURNS_PER_STEP = 5;

/** Attempts at one step that change nothing before the rest is re-planned. */
const MISSES_BEFORE_REPLAN = 2;

/** Re-plans after things going wrong, and after the person steering, per run. */
const MAX_REPLANS = 3;
const MAX_CORRECTIONS = 4;

/** Shortened for a sentence: "Pico.sln - Notepad" stays, a 200-character tab title does not. */
const short = (title, max = 60) => {
  const t = String(title ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A scroll step that is about finding something is not done by scrolling once. */
const SCROLL_WITH_A_PURPOSE = /\b(?:until|till|to find|find|look(?:ing)? for|reach|see|showing|visible|where|to the)\b/i;

const image = (shot) => ({ type: 'image', b64: shot.b64, mime: shot.mime, detail: 'original' });

/* --------------------------------------------------------------------------
   Planning
   -------------------------------------------------------------------------- */
const PLAN_TOOL = [{
  type: 'function',
  function: {
    name: 'plan',
    description: 'State the smallest complete plan for the task.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The fewest steps that complete exactly what was asked. '
            + 'Usually one. Never add steps that were not asked for.',
          items: {
            type: 'object',
            properties: {
              do: {
                type: 'string',
                description: 'Exactly ONE action, a few words: a single click, a single key '
                  + 'combination, a single piece of text typed, one scroll, or opening one '
                  + 'app or website. Never combine two.',
              },
              kind: {
                type: 'string',
                enum: ['open', 'pointer', 'keyboard', 'scroll'],
                description: 'open = open an app or a website. pointer = click, drag or hover '
                  + 'something on screen. keyboard = type text or press keys. scroll = move '
                  + 'a page or list.',
              },
            },
            required: ['do', 'kind'],
          },
        },
        done_when: {
          type: 'string',
          description: 'What will be visible on screen once the task is complete.',
        },
        already_done: {
          type: 'boolean',
          description: 'True if the screen already shows the task as complete.',
        },
        question: {
          type: 'string',
          description: 'Ask ONE short question instead of planning, but only when '
            + 'the answer changes what you would actually do and you cannot tell '
            + 'from the screen — which file, which of two windows, what to write. '
            + 'Never ask to confirm something already clear. Leave empty to just '
            + 'get on with it.',
        },
      },
      required: ['steps', 'done_when', 'already_done'],
    },
  },
}];

/* The same tool, with no way to ask a question.

   Used for the pass after a question has been answered. The loop only ever
   acts on one question, so leaving `question` on the schema for the second
   pass meant offering the model an option whose answer would be thrown away
   — and it took it: asked something, was handed nothing back, and returned a
   plan of no steps, which the person was told as "There was nothing to do for
   that." They had just answered a question, so it was also plainly untrue.

   An affordance you intend to discard should not be offered. */
const PLAN_TOOL_DECIDE = [{
  ...PLAN_TOOL[0],
  function: {
    ...PLAN_TOOL[0].function,
    parameters: {
      ...PLAN_TOOL[0].function.parameters,
      properties: (() => {
        const { question, ...rest } = PLAN_TOOL[0].function.parameters.properties;
        return rest;
      })(),
    },
  },
}];

const PLAN_SYSTEM = (shot, facts, answered = null) => [
  'You plan work for someone operating a Windows 11 desktop.',
  `The screenshot is ${shot.width} by ${shot.height} pixels.`,
  facts.front ? `In front right now: ${facts.front}.` : '',
  facts.windows?.length ? `Open windows: ${facts.windows.join('; ')}.` : '',
  facts.apps?.length ? `Installed apps this may be about: ${facts.apps.join(', ')}.` : '',
  facts.note ? facts.note : '',
  facts.memory ? `\n${facts.memory}` : '',
  '',
  'Plan the smallest set of steps that does exactly what was asked, and',
  'nothing beyond it. If one click does it, the plan is one step.',
  '',
  'OPENING AN APP OR A WEBSITE IS ONE STEP, of kind "open": "Open WhatsApp",',
  '"Open youtube.com". Halo opens it directly — and if something is both an',
  'app and a website, Halo asks the person which. So never plan pressing Win',
  'and typing a name, and never plan typing a name into a browser\'s address',
  'bar: that searches the web for the name instead of going anywhere.',
  'If what the task needs is already open, "open" it anyway — that brings the',
  'open window to the front instead of starting a second copy.',
  '',
  'A WINDOW TITLE THAT NAMES A FILE says that file is open in it:',
  '"Pico.sln - Notepad" is Notepad with a solution file loaded, not a blank',
  'Notepad. Opening that app brings that file up. So if the task is to write',
  'something new, the document already there is not where it goes: plan a',
  'step that starts a new one, or ask which was meant. Typing into what',
  'somebody had open is the one outcome nobody asked for.',
  '',
  'USE THE APP THE TASK NAMES. If the task names an application, the job is',
  'done in that application, not on a website about it, unless the task says',
  'website, web, browser, or gives an address.',
  '',
  'Each other step is one single action. Scrolling to find something is one',
  'step of kind "scroll". Dragging is one step: take hold in one place, let',
  'go in another.',
  '',
  'Do not add steps that were not asked for. Do not tidy up, continue a',
  'sequence, verify by opening something else, or do the obvious next thing.',
  'Finishing early is correct; doing more than was asked is not.',
  '',
  'If what the task needs is not open yet, opening it is part of the job — it',
  'is not a reason to stop.',
  '',
  'If the screen already shows what was asked, say so with already_done.',
  '',
  'MESSAGING AND MAIL NEED THE RIGHT CONVERSATION OPENED FIRST.',
  'Sending a message to somebody is at least three steps, never one: open the',
  'application, open that person or group\'s conversation, then type. Opening',
  'the conversation is its own step — searching for them by name and clicking',
  'the result is two more. Whatever conversation happens to be on screen is',
  'not the right one unless it is the one named.',
  '',
  ...(answered ? [
    '',
    'YOU HAVE ALREADY ASKED YOUR ONE QUESTION, AND IT WAS ANSWERED:',
    `  you asked: ${answered.question}`,
    `  they said: ${answered.answer}`,
    'Plan it now, using that answer. There is nothing further to ask and no',
    'way to ask it. Anything still unstated is yours to choose sensibly: a',
    'subject line, which of two identical buttons, where to begin. Choose,',
    'and carry on. Returning no steps here tells the person there was',
    'nothing to do, immediately after they answered you, which is the one',
    'outcome that is certainly wrong.',
  ] : [
    '',
    'If one detail would genuinely change what you do, ask for it instead of',
    'guessing: which of two real files, which of two open windows, which',
    'person out of several. One short question, and only when the answer',
    'really decides something.',
    '',
    'You only get the one, so do not spend it on something you could settle',
    'yourself. Wording you were not given is yours to write from what was',
    'asked: a subject line, a search, a short message, a note. Picking a',
    'sensible one and getting on with it is what was wanted. And if the task',
    'already tells you what to write, that is the answer - do not ask for it',
    'again in other words.',
  ]),
].filter(Boolean).join('\n');

/* --------------------------------------------------------------------------
   Re-planning, part way through

   The same planner, asked a narrower question: here is where it stands,
   here is what went wrong, what is left? It cannot ask the person anything
   — a run that has already started does not get to open with a question
   again — but it can say plainly that what is left cannot be done from
   here, which is a far better ending than running out of turns.
   -------------------------------------------------------------------------- */
const REPLAN_TOOL = [{
  type: 'function',
  function: {
    name: 'replan',
    description: 'Plan what is left of the task, from the screen as it is now.',
    parameters: {
      type: 'object',
      properties: {
        steps: PLAN_TOOL[0].function.parameters.properties.steps,
        done_when: PLAN_TOOL[0].function.parameters.properties.done_when,
        already_done: {
          type: 'boolean',
          description: 'True if the screen already shows the whole task as complete.',
        },
        cannot: {
          type: 'string',
          description: 'Only if what is left genuinely cannot be done from here: one short '
            + 'plain sentence saying why, for the person. Leave empty otherwise.',
        },
      },
      required: ['steps', 'already_done'],
    },
  },
}];

const REPLAN_SYSTEM = (shot, facts) => [
  PLAN_SYSTEM(shot, facts, { question: '(none left)', answer: '(no more questions during a run)' })
    .split('\nYOU HAVE ALREADY ASKED')[0],
  '',
  'THIS TASK IS ALREADY UNDER WAY. You are shown what has been done, the step',
  'that went wrong or that the person corrected, and the screen as it is now.',
  'Plan ONLY what is left, starting from this screen. Do not repeat steps that',
  'are already done on screen. If the step that failed can be done a different',
  'way — a different control, a keyboard shortcut, scrolling to find it — plan',
  'that way. If the person said something, it is a correction: follow it.',
  'If the screen already shows the task complete, say so with already_done.',
].join('\n');

/* --------------------------------------------------------------------------
   Executing
   -------------------------------------------------------------------------- */
const ACT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Perform one action towards the current step.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag',
              'type', 'key', 'scroll', 'wait', 'open_app', 'open_url'],
          },
          target: {
            type: 'string',
            description: 'For anything aimed at the screen (clicks, move, drag, scroll): what '
              + 'exactly it is — its visible text or icon, what kind of control, and where '
              + '("the blue Send button at the bottom right of the chat", "the checkbox '
              + 'left of \'Remember me\'"). Written before the coordinates.',
          },
          x: { type: 'integer', description: 'Horizontal centre of the target, in screenshot pixels.' },
          y: { type: 'integer', description: 'Vertical centre of the target, in screenshot pixels.' },
          to_x: { type: 'integer', description: 'For "drag": where to let go, horizontally, in screenshot pixels.' },
          to_y: { type: 'integer', description: 'For "drag": where to let go, vertically, in screenshot pixels.' },
          text: { type: 'string', description: 'For "type": the text to type.' },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'For "key": a chord pressed together, e.g. ["ctrl","t"] or ["enter"].',
          },
          scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          scroll_amount: {
            type: 'number',
            description: 'For "scroll": how far, in screens of the area being scrolled. 0.3 nudges '
              + 'something partly hidden into view; 0.8 moves on to the next screenful; 3 goes a '
              + 'long way.',
          },
          scroll_to: {
            type: 'string',
            enum: ['top', 'bottom', 'start', 'end'],
            description: 'For "scroll": go all the way to one end instead of a distance.',
          },
          app: { type: 'string', description: 'For "open_app": the app\'s name, as the person would say it.' },
          url: { type: 'string', description: 'For "open_url": the full web address, e.g. https://www.youtube.com.' },
          why: {
            type: 'string',
            description: 'What you are about to do and what for, in one short plain '
              + 'sentence of about a dozen words. This is put on screen while the action '
              + 'happens and is the only account the person gets of it, so write it to '
              + 'them: "Opening the address bar so I can go to YouTube" — not the '
              + 'coordinates, and not the step read back to them.',
          },
        },
        required: ['action', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'step_done',
      description: 'The current step is already complete on screen. Move to the next one.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask',
      description:
        'Ask the person one short question, when the step cannot be carried out '
        + 'as planned and the answer decides what to do instead: something the '
        + 'step needs is not there, or there are two things it could mean. Never '
        + 'to confirm something already clear, and never instead of looking '
        + 'properly first.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handover',
      description:
        'Hand control back to the person. Use for passwords, PINs, two-factor '
        + 'codes, CAPTCHAs and Windows security prompts — never attempt these.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
  },
];

const ACT_SYSTEM = (shot, front) => [
  'You operate a Windows 11 desktop, one action at a time.',
  '',
  `The screenshot is ${shot.width} by ${shot.height} pixels. Give every coordinate`,
  'in that space, measured from its top-left corner, at the middle of the thing',
  'you mean. Look at where it actually is in the image.',
  front ? `In front right now: ${front}.` : '',
  '',
  'For anything aimed at the screen, write "target" first: the thing\'s visible',
  'text or icon, what kind of control it is, and where it is. Halo uses that to',
  'land exactly on the control you mean.',
  '',
  'Carry out THE CURRENT STEP and nothing else. The rest of the plan is not',
  'yours to do and later steps are not yours to start. If the current step is',
  'already done on screen, call step_done.',
  '',
  'OPENING: use open_app with the app\'s name, or open_url with a full web',
  'address. Never type an app\'s or a website\'s name into a browser\'s address',
  'bar — that searches the web for the name. If you do use the address bar',
  '(ctrl+l), type a full address such as youtube.com.',
  '',
  'SCROLLING: put x and y over the thing that should scroll, choose',
  'scroll_direction, and give scroll_amount in screens of that area — or',
  'scroll_to "top" or "bottom" to go all the way. After a scroll you are told',
  'how far it really moved and whether it reached the end; do not keep',
  'scrolling past an end.',
  '',
  'When the step is to click something you can see, click it. Never press',
  'ctrl+f to look for it — finding text on a page does not click anything. If',
  'you cannot see it, scroll to where it will be, or call ask. Useful keys:',
  'ctrl+t opens a browser tab, ctrl+l focuses its address bar, Escape closes',
  'a menu.',
  '',
  'To move or resize a window, or drag anything, use "drag": x and y are where',
  'to take hold, to_x and to_y where to let go.',
  '',
  'Every action carries a "why", and it is shown to the person, in the bar',
  'at the top of their screen, while that action happens. It is the only',
  'account they get of it. Say what you are doing and what it is for, in',
  'plain words: somebody watching over your shoulder should be able to',
  'follow the whole run from those lines alone. Not the coordinates, and',
  'not the step read back to them.',
  '',
  'Read the label. A list of rows — chats, mailboxes, folders, settings — is',
  'the easiest thing on a screen to be one row out on, and one row out is a',
  'different thing entirely. Before aiming at a row, read the text on it in',
  'the image and check it is the one you were asked for. "Archived" is not',
  '"Locked chats"; "Drafts" is not "Sent". If you cannot read it clearly,',
  'scroll it into full view rather than aiming at where you think it is.',
  '',
  'MESSAGING AND MAIL: OPEN IT BEFORE YOU WRITE IN IT.',
  'In WhatsApp, Messenger, Teams, Slack, Discord, Gmail, Outlook — anywhere a',
  'message goes to somebody — the conversation that is open decides who',
  'receives what you type. So before typing a message:',
  '  - Read the header of the open conversation. It names who you are talking',
  '    to. If it is not the person or group you were told to message, do not',
  '    type. Find the right conversation first.',
  '  - Use the search box to find them by name rather than hunting the list.',
  '    Click search, type the name, then click the matching result — and read',
  '    the result before clicking it.',
  '  - A newly opened application shows whichever conversation was last open.',
  '    That is not the one you want unless it happens to be.',
  'The same goes for a reply in mail: check the subject and the recipient on',
  'screen before typing into the box.',
  '',
  'Sending is the last action, never an incidental one. Type the message,',
  'look at what is in the box and who it is addressed to, and only then press',
  'Enter or click Send.',
  '',
  'The black bar at the top centre of the screen is Halo itself. It is not',
  'part of any task — never click or type into it.',
  '',
  'Never type a password, PIN, card number, one-time code, or answer a',
  'CAPTCHA. Call handover instead.',
].filter(Boolean).join('\n');

/**
 * Run one task against the real desktop.
 *
 * Every hook is optional except `gate`, which is how pause and stop reach
 * this loop: it resolves false when the run should end.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {object} opts.computer   from computer.mjs
 * @param {object} opts.llm        from llm.mjs
 * @param {number} opts.maxTurns
 * @param {object} opts.context    what the caller already settled:
 *   { note, choices, memory (for the prompt), browser }
 * @param {object} opts.hooks
 *   gate()            -> Promise<boolean>
 *   onPhase(phase)
 *   onStep({ index, total, text })
 *   onPlan({ steps: [{ do, kind, status }], index, doneWhen, finished?, succeeded? })
 *   onAction({ type, detail })
 *   onAudit(event, extra)
 *   onApproval({ id, summary, target, risk }) -> Promise<boolean>
 *   onHandover({ id, reason, appName })       -> Promise<void>
 *   onQuestion({ id, text, options })         -> Promise<{text, choice}|string>
 *   onSummary(text)
 *   onError({ title, message })
 *   steer()           -> [{ type: 'skip', index } | { type: 'correct', text }]
 *   remembered(key)   -> a kept answer, e.g. 'app' for 'open:whatsapp'
 *   remember(key, value, detail)
 *
 * @returns {Promise<{ succeeded: boolean, steps: string[] } | undefined>}
 */
export async function runTask({ task, computer, llm, maxTurns = 24, hooks = {}, context = {} }) {
  const {
    gate = async () => true,
    onPhase = () => {},
    onStep = () => {},
    onPlan = () => {},
    onAction = () => {},
    onAudit = () => {},
    onApproval = async () => false,
    onHandover = async () => {},
    onQuestion = async () => '',
    onSummary = () => {},
    onError = () => {},
    steer = () => [],
    remembered = () => null,
    remember = () => {},
  } = hooks;

  const sense = computer.sense ?? null;
  const debug = (...a) => { if (process.env.PICO_DEBUG) console.log(...a); };

  const fail = (failureClass, message) => {
    onPhase('Failed');
    onAudit('run_failed', { metadata: { failure_class: failureClass } });
    onError({ title: 'Halo stopped', message, recoverable: true });
  };

  const look = (raw) => computer.capture(raw ? { raw } : undefined);

  /** Ask, and read the answer whichever way it came back. */
  const askPerson = async (text, options = null) => {
    onAudit('question_asked', { metadata: { question: text } });
    onPhase('AwaitingApproval');
    const answer = await onQuestion({ id: `q_${Date.now()}`, text, options });
    if (answer && typeof answer === 'object') return { text: String(answer.text ?? '').trim(), choice: answer.choice ?? null };
    return { text: String(answer ?? '').trim(), choice: null };
  };

  onPhase('Starting');
  onAudit('run_started', { metadata: { model: llm.tiers.plan } });

  const reachable = await computer.available?.() ?? { ok: true };
  if (!reachable.ok) {
    return fail('desktop_unavailable',
      `Halo can't use the mouse or keyboard right now — ${reachable.why}. Unlock the screen and try again.`);
  }

  let shot;
  try {
    onPhase('Observing');
    shot = await look();
  } catch (err) {
    return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
  }
  if (!(await gate())) return;

  /* --- what is true before deciding anything --------------------------- */
  const front = await computer.foreground().catch(() => null);
  let workWindow = front && !isHaloWindow(front.title) ? front : null;

  /* Browsers only build their accessibility tree once something asks for it,
     and until they do every point in the window answers as one featureless
     pane — so the aim layer, which exists to put a click on the middle of the
     control the model described, had nothing to work with in the one place
     most tasks happen. Measured: the centre of a button read as `Pane` with
     nothing operable under it, and as `Button "Save changes"` a fifth of a
     second after being asked.

     Asked for here, while the plan is still being written, so the tree is
     built by the time the first click needs it rather than that click being
     the thing that waits for it. Both the window in front and the middle of
     the screen, because they are not always the same window. */
  if (sense) {
    const wake = (x, y) => sense.wake(x, y).catch?.(() => {});
    wake(shot.physical.width / 2, shot.physical.height / 2);
    const fw = front?.rect;
    if (Array.isArray(fw) && fw.length === 4) wake(fw[0] + (fw[2] / 2), fw[1] + (fw[3] / 2));
    sense.hit(shot.physical.width / 2, shot.physical.height / 2).catch?.(() => {});
  }
  const facts = {
    front: front?.title || computer.focusedWindow(),
    windows: [],
    apps: [],
    note: context.note || '',
    memory: context.memory || '',
  };
  try {
    const listed = (await sense?.windows()) ?? [];
    facts.windows = listed
      .filter((w) => !w.minimized && !w.tool && !isHaloWindow(w.title) && w.title !== 'Program Manager'
        && w.rect?.[0] < shot.physical.width && w.rect?.[1] < shot.physical.height)
      .slice(0, 10)
      .map((w) => w.title.slice(0, 80));
    if (!workWindow) {
      const top = listed.find((w) => !w.minimized && !w.tool && !isHaloWindow(w.title) && w.title !== 'Program Manager');
      if (top) workWindow = { hwnd: top.hwnd, title: top.title, process: top.process };
    }
  } catch { /* the plan can do without */ }
  try { facts.apps = (await apps.mentionedApps(task)).map((a) => a.name); } catch { /* likewise */ }

  /* --- decide, once ------------------------------------------------------ */
  onPhase('Thinking');
  let brief = task;
  let plan;
  let answered = null;        // the one question, and what was said back
  // At most one question. A second would be an interrogation, and the point is
  // to remove a guess, not to hand the work back — so the pass after an answer
  // is given a tool that cannot ask, rather than being asked not to.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const choice = await llm.respond({
        model: llm.tiers.plan,
        system: PLAN_SYSTEM(shot, facts, answered),
        content: [{ type: 'text', text: `Task: ${brief}` }, image(shot)],
        tools: answered ? PLAN_TOOL_DECIDE : PLAN_TOOL,
        effort: 'low',
        maxTokens: 3000,
      });
      plan = choice.call?.args;
    } catch (err) {
      return fail('model_error', err.message);
    }
    if (!(await gate())) return;

    const asked = String(plan?.question || '').trim();
    // A question alongside a usable plan is a model hedging. Take the plan.
    const hasSteps = Array.isArray(plan?.steps) && plan.steps.some((st) => st?.do);
    if (!asked || attempt > 0 || hasSteps || plan?.already_done) break;

    const answer = await askPerson(asked);
    if (!(await gate())) return;
    if (!answer.text) {
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'unanswered' } });
      onSummary('I asked what you meant and did not hear back, so I left it.');
      return;
    }
    /* Set out as a question and an answer rather than run together in
       brackets after the task. "Write an email (What should it say? just make
       it say test)" is one sentence that has to be untangled before it can be
       planned, and the thing most easily lost in it is the answer — which is
       the part that was just asked for. */
    answered = { question: asked, answer: answer.text };
    brief = task;
    onPhase('Thinking');
  }

  const toSteps = (list) => (Array.isArray(list)
    ? list.filter((s) => s?.do).slice(0, 8).map((s) => ({ do: String(s.do), kind: s.kind || 'pointer', status: 'pending' }))
    : []);
  let steps = toSteps(plan?.steps);

  /* The task said to open something, and the plan does not open it.

     This is what happened with "open notepad and type hello there" while a
     solution file happened to be open in Notepad: the planner saw Notepad in
     front, took it as already handled, and planned the typing alone. The
     first step then ran against whatever window was actually in front, which
     was somebody's file.

     The rule the planner is given is already right - open it anyway, because
     opening something already open brings its window to the front rather than
     starting a second copy - but a rule the model may or may not follow is
     not the place for this. "Open X" is in the words of the task, so it can
     be checked rather than hoped for. parseOpen is the same conservative
     parser the router uses: it recognises an app or an address by name and
     refuses whole sentences, so this cannot invent a step out of "open the
     report from last week". */
  const askedToOpen = (() => { try { return apps.parseOpen(task); } catch { return null; } })();
  if (askedToOpen && !steps.some((s) => s.kind === 'open')) {
    steps.unshift({ do: `Open ${askedToOpen.said || askedToOpen.name}`, kind: 'open', status: 'pending' });
    steps.length = Math.min(steps.length, 8);
    debug(`[plan] the task says to open "${askedToOpen.said || askedToOpen.name}" and the plan did not, so that step was put back`);
    onAudit('plan_repaired', { metadata: { added: 'open' } });
  }

  if (plan?.already_done && !steps.length) {
    onPhase('Completed');
    onAudit('run_completed', { metadata: { completed_actions: 0, already_done: true } });
    onSummary('That was already the case, so I left it alone.');
    return { succeeded: true, steps: [] };
  }

  /* No steps, and not because it was already done.

     This used to be reported as "There was nothing to do for that", which
     describes the task rather than what happened, and reads as a flat
     refusal. Said straight after the person answered a question it was worse
     than unhelpful, it was untrue: they had just supplied the missing detail
     and were told their request amounted to nothing.

     What actually happened is that planning produced nothing. So say that,
     and hand back something they can act on. */
  if (!steps.length) {
    onPhase('Failed');
    onAudit('run_failed', { metadata: { failure_class: 'no_plan', answered: Boolean(answered) } });
    onSummary(answered
      ? 'I could not work out how to do that, even with your answer. Could you tell me the first step you would take?'
      : 'I could not work out how to do that from here. Could you say it another way, or tell me where to start?');
    return;
  }

  let doneWhen = plan.done_when;
  onAudit('plan_made', { metadata: { steps: steps.length, done_when: doneWhen } });
  debug(`[plan] ${steps.map((s, i) => `${i + 1}.${s.kind}:${s.do}`).join(' | ')}`);

  /* --- carry it out ------------------------------------------------------ */
  let budget = Math.min(maxTurns, (steps.length * TURNS_PER_STEP) + 2);
  const done = [];            // what happened, in plain words, oldest first
  let stepIndex = 0;
  let lastSignature = null;
  let lastAction = null;
  let repeats = 0;
  let lastGrey = shot.grey;
  let feedback = null;        // the result of the last action, for the next turn
  const asked = new Set();    // one question each; a loop of them is an interrogation
  const choices = new Map(context.choices ?? []);   // name -> 'app' | 'site'
  let announced = -1;
  let staleSignature = null;  // an action already held back once for a changing screen

  let misses = 0;             // attempts at this step that got nowhere
  let turnsOnStep = 0;
  let replans = 0;            // after things going wrong
  let corrections = 0;        // after the person said something
  let thefts = 0;             // times another window took the screen
  let seenFront = front;      // what was in front when Halo last looked
  let lastActionType = null;
  let arrivalChecked = false; // a window that arrived after Halo looked, looked at once
  let misfireStep = -1;       // the step a click was last refused on — once each
  const typed = [];           // every piece of text typed, for the verdict
  const pressed = [];         // every key chord, likewise
  const opened = [];          // everything opened, likewise
  let turn = 0;

  /** The plan as it stands, for the interface. */
  const publish = (extra = {}) => onPlan({
    steps: steps.map((s) => ({ do: s.do, kind: s.kind, status: s.status })),
    index: stepIndex,
    doneWhen,
    ...extra,
  });
  publish();

  /** Look again, and note what is in front as Halo looks. */
  const observe = async (frame) => {
    shot = await look(frame);
    seenFront = await computer.foreground().catch(() => null);
    return shot;
  };

  const nextStep = (status = 'done') => {
    if (steps[stepIndex]) steps[stepIndex].status = status;
    stepIndex += 1;
    repeats = 0;
    lastSignature = null;
    feedback = null;
    misses = 0;
    turnsOnStep = 0;
    staleSignature = null;
    publish();
  };

  const openThing = async ({ name, url }) => {
    const r = await apps.open({ name, url }, {
      computer,
      task,
      choices,
      ask: async (question, options) => {
        const answer = await askPerson(question, options);
        onPhase('Acting');
        return answer;
      },
      gate,
      onAction,
      before: workWindow,
      remembered,
      remember,
      browser: context.browser ?? null,
    });
    if (r.ok) {
      if (r.window) workWindow = r.window;
      opened.push(r);
    }
    return { ok: r.ok, stop: r.stop, said: r.said };
  };

  /* --- another window taking the screen ------------------------------------
     `target` is the window the work is happening in; `thief` is what came to
     the front instead. The first time, the work window is put back and the
     run looks again. The second time, it stops and says what did it. Returns
     whether the run can carry on. */
  const stopForTheft = (thief, target, couldNotReturn = false) => {
    const who = thief?.title ? `"${short(thief.title)}"` : 'another window';
    const where = target?.title ? `"${short(target.title)}"` : 'the window I was working in';
    onStep(null);
    publish({ finished: true, succeeded: false });
    onPhase('Stopped');
    onAudit('run_stopped', { metadata: { failure_class: 'focus_stolen', by: thief?.title ?? '' } });
    onSummary(couldNotReturn
      ? `I stopped: ${who} took over the screen and I couldn't bring ${where} back, so I didn't type anything. Close or pause it, then ask me again.`
      : `I stopped: ${who} took over the screen again while I was working in ${where}. I brought it back once, but I won't keep fighting it for the keyboard. Close or pause ${who}, then ask me again.`);
  };

  const reclaim = async (thief, target, when) => {
    thefts += 1;
    onAudit('focus_stolen', { metadata: { by: thief?.title ?? '', from: target?.title ?? '', when, count: thefts } });
    debug(`[focus] "${thief?.title}" took the front from "${target?.title}" ${when} (${thefts})`);
    if (thefts > 1) { stopForTheft(thief, target); return false; }
    if (!target?.hwnd) { stopForTheft(thief, target, true); return false; }

    onAction({ type: 'Keypress', detail: `Bringing ${short(target.title, 40) || 'the window'} back to the front` });
    const ok = await computer.focus(target.hwnd).catch(() => false);
    await computer.wait(180);
    const now = await computer.foreground().catch(() => null);
    if (!ok || (now?.hwnd && String(now.hwnd) !== String(target.hwnd))) {
      stopForTheft(now?.hwnd && String(now.hwnd) !== String(target.hwnd) ? now : thief, target, true);
      return false;
    }
    workWindow = now?.hwnd ? now : target;
    return true;
  };

  /* --- re-planning ---------------------------------------------------------
     Resolves to 'continue' (a new plan is in place), 'done' (the screen
     already shows it finished), 'stopped' (it cannot be done, and the person
     has been told why), 'error' (the run has failed), or 'exhausted' (no
     re-plans left, so the caller carries on as it would have before). */
  const replan = async (why, { byPerson = false } = {}) => {
    if (byPerson ? corrections >= MAX_CORRECTIONS : replans >= MAX_REPLANS) return 'exhausted';
    if (byPerson) corrections += 1; else replans += 1;

    onPhase('Thinking');
    onAudit('plan_revising', { metadata: { reason: byPerson ? 'person' : 'stalled', count: byPerson ? corrections : replans } });
    debug(`[replan] ${why}`);

    const status = (s, i) => (i === stepIndex ? (byPerson ? 'in hand' : 'could not be done')
      : s.status === 'pending' ? 'not started' : s.status);
    let r;
    try {
      const choice = await llm.respond({
        model: llm.tiers.plan,
        system: REPLAN_SYSTEM(shot, { ...facts, front: seenFront?.title || facts.front }),
        content: [
          {
            type: 'text',
            text: [
              `Task: ${brief}`,
              `The plan so far: ${steps.map((s, i) => `${i + 1}. [${status(s, i)}] ${s.do}`).join(' ')}`,
              done.length ? `Done so far: ${done.slice(-10).join('; ')}.` : 'Nothing has been done yet.',
              `What happened: ${why}`,
              'Plan what is left, from the screen as it is now.',
            ].join('\n'),
          },
          image(shot),
        ],
        tools: REPLAN_TOOL,
        effort: 'low',
        maxTokens: 3000,
      });
      r = choice.call?.args;
    } catch (err) {
      fail('model_error', err.message);
      return 'error';
    }
    if (!(await gate())) return 'error';

    const fresh = toSteps(r?.steps);
    const cannot = String(r?.cannot || '').trim();
    if (steps[stepIndex]) steps[stepIndex].status = byPerson ? 'changed' : 'failed';

    if (r?.already_done && !fresh.length) {
      steps.forEach((s, i) => { if (i >= stepIndex && s.status === 'pending') s.status = 'done'; });
      stepIndex = steps.length;
      publish();
      return 'done';
    }
    if (!fresh.length) {
      onStep(null);
      publish({ finished: true, succeeded: false });
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'replan_empty' } });
      onSummary(cannot
        ? `I couldn't finish: ${cannot.replace(/^./, (c) => c.toLowerCase())}`
        : `I couldn't find another way to ${steps[stepIndex]?.do?.replace(/^./, (c) => c.toLowerCase()) || 'finish that'}, so I stopped there.`);
      return 'stopped';
    }

    /* The step that went wrong stays in the list, marked, and what comes
       next follows it: the person can see that Halo changed course, rather
       than the plan silently rewriting its own history. */
    const kept = steps.slice(0, stepIndex + 1);
    const room = Math.max(1, 12 - kept.length);
    steps = [...kept, ...fresh.slice(0, room)];
    stepIndex = kept.length;
    if (r?.done_when) doneWhen = r.done_when;
    budget = Math.min(maxTurns, turn + 1 + ((steps.length - stepIndex) * TURNS_PER_STEP) + 2);
    repeats = 0;
    lastSignature = null;
    misses = 0;
    turnsOnStep = 0;
    staleSignature = null;
    announced = -1;
    feedback = null;
    onAudit('plan_revised', { metadata: { steps: steps.length - stepIndex, reason: byPerson ? 'person' : 'stalled' } });
    debug(`[replan] now: ${steps.slice(stepIndex).map((s, i) => `${stepIndex + i + 1}.${s.kind}:${s.do}`).join(' | ')}`);
    publish();
    return 'continue';
  };

  /* --- the person, while it runs -------------------------------------------
     Pause is handled by the gate. Skipping and correcting arrive here, and
     are looked at before each decision and again before acting on one — a
     correction that lands while the model is thinking must not be followed
     by the very action it was correcting. Returns 'skipped', a replan
     outcome, or null when nothing was said. */
  const listen = async () => {
    const notes = (() => { try { return steer() || []; } catch { return []; } })();
    for (const n of notes) {
      if (n?.type === 'skip') {
        if (stepIndex >= steps.length) continue;
        if (Number.isInteger(n.index) && n.index !== stepIndex) continue;   // about a step already past
        onAudit('step_skipped', { metadata: { index: stepIndex } });
        done.push(`you skipped: ${steps[stepIndex].do}`);
        nextStep('skipped');
        return 'skipped';
      }
      if (n?.type === 'correct') {
        const said = String(n.text ?? '').trim().slice(0, 500);
        if (!said) continue;
        brief = `${brief}\n(while you were working, they said: ${said})`;
        done.push(`they said: ${said}`);
        const after = lastAction ? `, right after you ${describe(lastAction).replace(/^./, (c) => c.toLowerCase())}` : '';
        const outcome = await replan(`While you were on "${steps[stepIndex]?.do ?? 'the last step'}", the person said: "${said}"${after}. `
          + 'Treat it as a correction of what you were doing.', { byPerson: true });
        if (outcome === 'exhausted') {
          feedback = `The person said: "${said}". Take it into account.`;
          return 'noted';
        }
        return outcome;
      }
    }
    return null;
  };

  for (; turn < budget && stepIndex < steps.length; turn++) {
    if (!(await gate())) return;

    {
      const heard = await listen();
      if (heard === 'error' || heard === 'stopped') return;
      if (heard === 'done') break;
      if (heard === 'skipped' || heard === 'continue') continue;
    }
    if (stepIndex >= steps.length) break;

    const step = steps[stepIndex];
    const fg = await computer.foreground().catch(() => null);
    const frontTitle = fg?.title || computer.focusedWindow();

    /* Something came to the front since Halo last looked.

       If what Halo did last could have brought it — a click that opens a
       dialog, a key that follows a link — it probably did, and simply
       arrived after the picture was taken: look again, once, and carry on in
       it. If not — Halo only typed, or scrolled, or had not done anything
       yet — it came forward on its own, and it is not where the work is. */
    if (fg?.hwnd && !isHaloWindow(fg.title) && workWindow?.hwnd
      && String(fg.hwnd) !== String(workWindow.hwnd) && String(fg.hwnd) !== String(seenFront?.hwnd)) {
      if (lastActionType && MAY_BRING_WINDOW.has(lastActionType)) {
        if (!arrivalChecked) {
          arrivalChecked = true;
          workWindow = fg;
          try { await observe(); } catch (err) { return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`); }
          lastGrey = shot.grey;
          turn -= 1;         // a second look is not a turn spent on the step
          continue;
        }
      } else {
        const target = workWindow;
        if (!(await reclaim(fg, target, 'between steps'))) return;
        try { await observe(); } catch (err) { return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`); }
        lastGrey = shot.grey;
        feedback = `"${short(fg.title)}" came to the front on its own, not because of anything you did, so Halo put `
          + `"${short(target.title)}" back in front. Here is a fresh look; carry on with the step.`;
        continue;
      }
    } else if (fg?.hwnd && !isHaloWindow(fg.title) && (!workWindow?.hwnd || String(fg.hwnd) === String(workWindow.hwnd))) {
      workWindow = fg;         // the same window, with whatever title it has now
    }

    // Say what is being worked on before working on it.
    if (stepIndex !== announced) {
      announced = stepIndex;
      onStep({ index: stepIndex, total: steps.length, text: step.do });
    }
    turnsOnStep += 1;

    // A step that has stalled goes to the stronger model.
    const stuck = repeats >= 2;
    const model = stuck ? llm.tiers.plan : llm.tiers.see;

    onPhase('Thinking');
    let choice;
    try {
      choice = await llm.respond({
        model,
        system: ACT_SYSTEM(shot, frontTitle),
        content: [
          {
            type: 'text',
            text: [
              `Task: ${brief}`,
              `Plan: ${steps.map((s, i) => `${i + 1}. ${s.do}${s.status === 'pending' ? '' : ` (${s.status})`}`).join(' ')}`,
              done.length ? `Done so far: ${done.slice(-8).join('; ')}.` : null,
              `CURRENT STEP (${stepIndex + 1} of ${steps.length}, ${step.kind}): ${step.do}`,
              'Do only that step.',
              feedback ? `Result of your last action: ${feedback}` : null,
              repeats > 0
                ? `Your last attempt (${describe(lastAction)}) changed nothing on screen. Do it a `
                  + 'different way, or call step_done if it is already the case.'
                : null,
            ].filter(Boolean).join('\n'),
          },
          image(shot),
        ],
        tools: ACT_TOOLS,
        effort: 'low',
        maxTokens: 3000,
      });
    } catch (err) {
      return fail('model_error', err.message);
    }
    if (!(await gate())) return;

    // Anything said while the model was deciding outranks what it decided.
    {
      const heard = await listen();
      if (heard === 'error' || heard === 'stopped') return;
      if (heard === 'done') break;
      if (heard === 'skipped' || heard === 'continue') continue;
    }

    const name = choice.call?.name;
    const args = choice.call?.args ?? {};

    if (!choice.call || name === 'step_done') {
      nextStep('done');
      continue;
    }

    if (name === 'ask') {
      const question = String(args.question || '').trim();
      if (!question || asked.has(question)) { nextStep('done'); continue; }
      asked.add(question);

      const answer = await askPerson(question);
      if (!(await gate())) return;
      if (!answer.text) {
        onStep(null);
        publish({ finished: true, succeeded: false });
        onPhase('Stopped');
        onAudit('run_stopped', { metadata: { failure_class: 'unanswered' } });
        onSummary(`I asked — ${question} — and did not hear back, so I left it there.`);
        return;
      }
      /* Kept as its own line rather than folded into the task in brackets.
         Run together, the answer is the part that gets lost — and it is the
         part that was just asked for. */
      brief = `${brief}
(you asked: ${question}
 they said: ${answer.text})`;
      done.push(`you said: ${answer.text}`);
      repeats = 0;
      lastSignature = null;
      feedback = null;
      turnsOnStep = 0;
      onPhase('Observing');
      try { await observe(); } catch (err) {
        return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
      }
      lastGrey = shot.grey;
      continue;
    }

    if (name === 'handover') {
      onPhase('AwaitingTakeover');
      onAudit('takeover_requested', { metadata: { reason: args.reason } });
      await onHandover({
        id: `tko_${Date.now()}`,
        reason: args.reason || 'This step needs you.',
        appName: frontTitle,
      });
      if (!(await gate())) return;
      onPhase('Observing');
      try { await observe(); } catch (err) {
        return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
      }
      lastGrey = shot.grey;
      // Whatever they did may have put a different window in front, and it
      // was their choice to: that is where the work is now.
      if (seenFront?.hwnd && !isHaloWindow(seenFront.title)) workWindow = seenFront;
      done.push(`you did it yourself: ${step.do}`);
      nextStep('done');
      continue;
    }

    // --- an action ---------------------------------------------------------
    const action = { ...args, type: args.action };

    // A model with nothing to push back on it will happily press Escape
    // thirty times in a row. It did exactly that the first time this ran.
    const sig = signature(action);
    repeats = (sig === lastSignature && !INVISIBLE.has(action.type)) ? repeats + 1 : 0;
    lastSignature = sig;
    lastAction = action;
    if (repeats >= STUCK_AFTER) {
      const outcome = await replan(`The same action — ${describe(action).toLowerCase()} — was tried ${repeats + 1} times and kept having no effect.`);
      if (outcome === 'error' || outcome === 'stopped') return;
      if (outcome === 'done') break;
      if (outcome === 'continue') continue;
      onStep(null);
      publish({ finished: true, succeeded: false });
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'stuck' } });
      onSummary(
        `I stopped: the same step — ${describe(action).toLowerCase()} — kept `
        + 'having no effect, so repeating it was not going to get anywhere.',
      );
      return;
    }

    const risk = assess(action, frontTitle);
    const detail = describe(action);
    const phaseType = ACTION_PHASE[action.type] || 'Move';
    onAudit('action_assessed', { action_type: phaseType, risk });

    if (risk.decision === 'Handover') {
      onPhase('AwaitingTakeover');
      await onHandover({ id: `tko_${Date.now()}`, reason: risk.reason, appName: frontTitle });
      if (!(await gate())) return;
      done.push(`you did it yourself: ${step.do}`);
      try { await observe(); lastGrey = shot.grey; } catch { /* next turn retries */ }
      if (seenFront?.hwnd && !isHaloWindow(seenFront.title)) workWindow = seenFront;
      nextStep('done');
      continue;
    }

    if (risk.decision === 'RequireConfirmation') {
      onPhase('AwaitingApproval');
      const approved = await onApproval({
        id: `apr_${Date.now()}`,
        summary: detail,
        target: frontTitle || 'the active window',
        risk,
      });
      if (!approved) {
        onAudit('stop_requested', { metadata: { source: 'approval-denied' } });
        onStep(null);
        publish({ finished: true, succeeded: false });
        onPhase('Stopped');
        onAudit('run_stopped');
        return;
      }
      if (!(await gate())) return;
    }

    /* A job typed into the island leaves keyboard focus in the island, so
       the first keystrokes of a run would go into Halo itself. Give focus
       back to the window that was being worked in. The Windows key is
       exempt: it opens Start wherever focus is. */
    const keyboardAction = action.type === 'type'
      || (action.type === 'key' && !(action.keys || []).some((k) => /^(?:win|windows|meta|super|cmd)$/i.test(k)));
    /* Did the front window change while this was being decided?

       Between the screenshot the model looked at and the keystrokes landing
       there is a model call, a second or two, and anything at all may come
       to the front in it: a video going fullscreen, a notification taking
       focus, an app finishing its startup. Keys go to whatever holds focus
       at the instant they are sent, not to whatever was in the picture - so
       a step decided about Notepad can be typed into a web page.

       Seen on this machine: a browser window kept taking the foreground
       mid-run, and the verdict afterwards was "the screen showed a browser
       video rather than a Notepad document".

       Nothing is typed. The window that was decided about is brought back,
       once, and the step is looked at again with a picture of it in front;
       the second time something takes the screen, the run stops and names
       it. Skipping and looking again without bringing it back is what used
       to loop until the turns ran out. */
    if (keyboardAction && fg?.hwnd) {
      const atHand = await computer.foreground().catch(() => null);
      if (atHand?.hwnd && String(atHand.hwnd) !== String(fg.hwnd) && !isHaloWindow(atHand.title)
        && String(atHand.hwnd) !== String(workWindow?.hwnd)) {
        onAudit('action_skipped', { metadata: { reason: 'the front window changed while deciding' } });
        const target = isHaloWindow(fg.title) ? workWindow : fg;
        if (!(await reclaim(atHand, target, 'while deciding'))) return;
        feedback = `Nothing was typed: "${short(atHand.title) || 'another window'}" came to the front while you `
          + `were deciding, so Halo brought "${short(target?.title)}" back. Here is a fresh look — do the step `
          + 'again if it still needs doing.';
        onPhase('Observing');
        try { await observe(); } catch (err) {
          return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
        }
        lastGrey = shot.grey;
        lastSignature = null;
        repeats = 0;
        continue;
      }
    }

    if (keyboardAction && isHaloWindow(fg?.title ?? frontTitle)) {
      const back = workWindow?.hwnd ? await computer.focus(workWindow.hwnd) : false;
      const now = await computer.foreground().catch(() => null);
      if (!back || isHaloWindow(now?.title ?? computer.focusedWindow())) {
        onAudit('action_skipped', { metadata: { reason: 'focus is on Halo itself' } });
        feedback = 'Nothing was typed: keyboard focus is on Halo\'s own window. Click into the '
          + 'window you want to type into first.';
        continue;
      }
      await computer.wait(120);
    }

    const still = await computer.available?.() ?? { ok: true };
    if (!still.ok) {
      return fail('desktop_unavailable',
        `I stopped partway: ${still.why}, so the mouse and keyboard can't reach anything.`);
    }

    onPhase('Acting');
    onAction({ type: phaseType, detail });

    let result;
    try {
      // The same click, found stale once already, is clicked this time: a
      // video or an animation under the target is always "changing", and
      // must not make it unclickable.
      result = await execute({ computer, sense, shot, action, openThing, trustStale: staleSignature === sig, mayRefuse: misfireStep !== stepIndex });
    } catch (err) {
      return fail('action_failed', `That action did not go through: ${err.message}`);
    }
    /* Aimed at the wrong control, and told so by name. A second opinion, not
       a veto with a loop in it: once per step, then the click goes through
       and the screen decides. Not a miss either — nothing was tried. */
    if (result?.refused) {
      misfireStep = stepIndex;
      feedback = result.said;
      turnsOnStep -= 1;
      lastSignature = null;
      repeats = 0;
      onAudit('action_skipped', { metadata: { reason: 'aimed at the wrong control' } });
      continue;
    }
    if (result?.stale) {
      staleSignature = sig;
      repeats = 0;
      lastSignature = null;
      feedback = result.said;
      turnsOnStep -= 1;       // held back by Halo, not spent by the step
      onAudit('action_skipped', { metadata: { reason: 'screen changed under the target' } });
      onPhase('Observing');
      try { await observe(result.frame); } catch (err) {
        return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
      }
      lastGrey = shot.grey;
      continue;
    }
    staleSignature = null;
    if (result?.stop) {
      onStep(null);
      publish({ finished: true, succeeded: false });
      onPhase('Stopped');
      onAudit('run_stopped', { metadata: { failure_class: 'declined' } });
      onSummary(result.said ? `I left it: ${result.said}.` : 'I left it there.');
      return;
    }
    onAudit('action_executed', { action_type: phaseType, risk });
    lastActionType = action.type === 'type' && /[\r\n]/.test(action.text ?? '') ? 'key' : action.type;
    arrivalChecked = false;
    if (action.type === 'type' && action.text) typed.push({ text: String(action.text), window: fg?.title ?? '' });
    if (action.type === 'key') pressed.push((action.keys ?? []).join('+'));
    if (!(await gate())) return;

    // Let the screen settle before looking. Clicking and photographing in the
    // same instant catches the previous frame, and the model then repeats
    // itself — which is most of what "inconsistent" looked like.
    if (!result?.frame) {
      await computer.wait(KEYBOARD.has(action.type) ? 240 : OPENING.has(action.type) ? 600 : 160);
    }

    onPhase('Observing');
    try { await observe(result?.frame); } catch (err) {
      return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
    }

    /* A different window in front after typing, scrolling or waiting is not
       something those did. Taken while the keys were going in, most likely —
       which is the moment it matters most. */
    if (seenFront?.hwnd && !isHaloWindow(seenFront.title) && workWindow?.hwnd
      && String(seenFront.hwnd) !== String(workWindow.hwnd)) {
      if (MAY_BRING_WINDOW.has(lastActionType)) {
        workWindow = seenFront;
      } else {
        const thief = seenFront;
        const target = workWindow;
        if (!(await reclaim(thief, target, 'during an action'))) return;
        try { await observe(); } catch (err) {
          return fail('screen_unavailable', `Halo could not see the screen: ${err.message}`);
        }
        lastGrey = shot.grey;
        feedback = `${result?.said ?? detail}, but "${short(thief.title)}" came to the front on its own while it `
          + `happened, so some of it may have gone there. Halo brought "${short(target.title)}" back: check it `
          + 'and carry on with the step.';
        lastSignature = null;
        repeats = 0;
        continue;
      }
    } else if (seenFront?.hwnd && !isHaloWindow(seenFront.title) && !workWindow?.hwnd) {
      workWindow = seenFront;
    }

    const changed = INVISIBLE.has(action.type) || !sameScreen(lastGrey, shot.grey)
      || (action.type === 'scroll' && Math.abs(result?.moved ?? 0) > 0);
    feedback = result?.said
      ? `${result.said}${POINTER.has(action.type) || KEYBOARD.has(action.type) ? (changed ? ' — the screen changed.' : ' — nothing visibly changed.') : '.'}`
      : null;

    /* Does this action finish the step? Only when it is the kind of action
       the step is and it did something. A click while working on "type the
       message" is focusing the field, not typing it; a scroll while working
       on "click Send" is looking for Send, not clicking it. Those used to
       count as the step being done, and the run moved on without it. */
    const matches = (step.kind === 'pointer' && POINTER.has(action.type))
      || (step.kind === 'keyboard' && KEYBOARD.has(action.type))
      || (step.kind === 'open' && OPENING.has(action.type) && result?.ok)
      || (step.kind === 'scroll' && action.type === 'scroll' && !SCROLL_WITH_A_PURPOSE.test(step.do));
    const advance = matches && (changed || result?.ok);

    debug(`[turn ${turn}] step ${stepIndex + 1}/${steps.length} "${step.do}" via ${model} -> ${sig}`
      + ` | ${result?.said ?? ''} | screen ${changed ? 'changed' : 'UNCHANGED'} | ${advance ? 'ADVANCE' : 'stay'} | repeats=${repeats} misses=${misses}`);

    if (changed || result?.ok) {
      done.push(result?.said || detail);
      repeats = 0;
      lastSignature = null;
    }
    lastGrey = shot.grey;
    if (advance) {
      nextStep('done');
      continue;
    }

    /* Not done, and not getting there.

       An action that changed nothing, or an open that did not open, is a
       miss. A couple of those — or a step that has eaten its whole share of
       turns — and the rest of the plan goes back to the planner with the
       screen as it is now. That used to be where a run ended. */
    const openFailed = OPENING.has(action.type) && result && result.ok === false;
    if (openFailed || (!changed && !result?.ok)) misses += 1;
    const why = openFailed
      ? `Opening it did not work: ${result.said}.`
      : misses >= MISSES_BEFORE_REPLAN
        ? `${misses} attempts at "${step.do}" changed nothing on screen. The last was: ${result?.said ?? detail}.`
        : turnsOnStep >= TURNS_PER_STEP
          ? `"${step.do}" has taken ${turnsOnStep} tries without being finished. The last was: ${result?.said ?? detail}.`
          : null;
    if (why) {
      const outcome = await replan(why);
      if (outcome === 'error' || outcome === 'stopped') return;
      if (outcome === 'done') break;
      if (outcome === 'exhausted') misses = 0;      // carry on as before, until the turns run out
    }
  }

  /* --- and stop ---------------------------------------------------------- */
  onStep(null);

  /* A fresh look for the verdict.

     The picture left over from the loop was taken to decide the next action,
     not to judge the finished job: the last keystrokes may still have been
     drawing when it was taken. Judged on that frame, a run that had in fact
     typed "hello there" perfectly was reported back as having produced
     "hello ther".

     So look again, once, after letting the screen settle. A wrong verdict is
     cheap to avoid here and expensive to receive - it is the only account of
     the run the person gets. */
  try {
    await new Promise((r) => setTimeout(r, 450));
    shot = await look();
  } catch { /* the loop's last frame will have to do */ }

  const verdict = await verify(llm, {
    task, doneWhen, shot, done, computer, steps, typed, pressed, opened, finished: stepIndex >= steps.length,
  });
  publish({ finished: true, succeeded: verdict.succeeded });
  onPhase(verdict.succeeded ? 'Completed' : 'Stopped');
  onAudit(verdict.succeeded ? 'run_completed' : 'run_stopped', {
    metadata: { completed_actions: done.length, planned: steps.length, judged_by: verdict.by, replans, corrections },
  });
  onSummary(verdict.summary);
  return { succeeded: verdict.succeeded, steps: steps.filter((s) => s.status === 'done').map((s) => s.do) };
}

/* --------------------------------------------------------------------------
   Carrying out one action
   -------------------------------------------------------------------------- */

/**
 * What an action says it is aiming at, with the verb taken off the front.
 * "Click the Send button" describes the target well enough; the verb is noise.
 */
function targetPhrase(action) {
  return String(action.why || '')
    .replace(/^(?:click(?:ing)?|press(?:ing)?|tap(?:ping)?|select(?:ing)?|open(?:ing)?|choose|choosing)\s+(?:on\s+)?(?:the\s+)?/i, '')
    .trim();
}

/* Words that say nothing about which control this is. Two labels sharing only
   these are not in agreement about anything. */
const EMPTY_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'button', 'icon', 'menu', 'item',
  'tab', 'option', 'list', 'row', 'entry', 'field', 'box', 'link', 'control',
  'click', 'open', 'select', 'press', 'chat', 'chats', 'window', 'panel', 'bar',
  'left', 'right', 'top', 'bottom', 'side', 'sidebar', 'blue', 'grey', 'gray', 'green', 'red',
]);

const labelWords = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter((w) => w.length > 2 && !EMPTY_WORDS.has(w));

/**
 * Does the name of the thing under the pointer contradict what was aimed at?
 *
 * Deliberately reluctant: true only when both sides have real words and share
 * none of them. "Send" against "Send message" agrees, "Locked chats" against
 * "Archived" does not, and anything unnamed is no opinion rather than a veto.
 * A false positive costs a turn; too eager, and Halo stops clicking things.
 */
export function contradicts(want, found) {
  const w = labelWords(want);
  const f = labelWords(found);
  if (!w.length || !f.length) return false;
  for (const a of w) {
    for (const b of f) {
      if (a === b || a.includes(b) || b.includes(a)) return false;
    }
  }
  return true;
}

/** "Button 'Send'", or where it was, for the model and the log. */
const named = (landed, fallback) => {
  if (!landed) return fallback;
  const kind = String(landed.type || 'control').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return landed.name ? `the ${kind} "${landed.name}"` : `a ${kind}`;
};

/**
 * Has the screen changed around a point since the model looked at it?
 *
 * A model takes a couple of seconds to decide, and in that time a window can
 * open over the thing, a page can finish loading and push it down, or the
 * person can move something. Clicking where it used to be clicks whatever is
 * there now. Only a real change counts: a hover highlight or a blinking
 * caret moves the average far less than something arriving on top.
 */
async function changedUnder(computer, shot, point, half = 60) {
  if (!shot.raw) return { changed: false, frame: null };
  const now = await computer.frame().catch(() => null);
  if (!now || now.width !== shot.raw.width) return { changed: false, frame: now };
  const box = {
    x: Math.max(0, Math.round(point.x - half)),
    y: Math.max(0, Math.round(point.y - half)),
  };
  box.width = Math.min(now.width - box.x, half * 2);
  box.height = Math.min(now.height - box.y, half * 2);
  return { changed: regionChanged(shot.raw, now, box, 14), frame: now };
}

/**
 * @returns {Promise<{said:string, ok?:boolean, moved?:number, frame?:object, stop?:boolean, stale?:boolean}>}
 */
async function execute({ computer, sense, shot, action, openThing, trustStale = false, mayRefuse = false }) {
  const type = action.type;
  const hasPoint = Number.isFinite(action.x) && Number.isFinite(action.y);

  /* The model's point, settled onto the control it described. */
  const aimAt = async () => {
    const physical = shot.toPhysical(action.x, action.y);
    const aim = await settle(sense, physical, { target: action.target || action.why || '' });
    if (process.env.PICO_DEBUG) {
      console.log(`[aim] ${Math.round(physical.x)},${Math.round(physical.y)} -> ${Math.round(aim.x)},${Math.round(aim.y)} `
        + `(${aim.how}, moved ${aim.moved.toFixed(1)}px) on ${aim.landed ? `${aim.landed.type} "${aim.landed.name}"` : 'nothing known'}`
        + ` for "${action.target || action.why}"`);
    }
    return { ...aim, mouse: shot.physToScreen(aim.x, aim.y) };
  };

  switch (type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'move': {
      if (!hasPoint) return { said: `nothing was done: ${type} needs x and y` };
      if (!trustStale && type !== 'move') {
        const look = await changedUnder(computer, shot, shot.toPhysical(action.x, action.y));
        if (look.changed) {
          return {
            said: 'nothing was clicked: that part of the screen changed while deciding, so here is a fresh look',
            stale: true,
            frame: look.frame,
          };
        }
      }
      const aim = await aimAt();
      if (isHaloWindow(aim.window?.title)) {
        return { said: 'nothing was clicked: that point is on Halo\'s own bar, not the app behind it' };
      }
      /* Ask what is actually under there before pressing it. Refused at most
         once per step, and only when the application's own name for the
         control shares no word with what the step was aiming for — see
         contradicts(). Told to open Locked chats, Halo once pressed Archived,
         the row above it, and nothing in the run noticed. */
      const want = String(action.target || '') || targetPhrase(action);
      if (mayRefuse && type === 'click' && aim.landed?.name && want && contradicts(want, aim.landed.name)) {
        return {
          said: `nothing was clicked: the thing under that point is called "${String(aim.landed.name).slice(0, 80)}", `
            + `which is not "${want.slice(0, 80)}". Find it properly in the image and aim at its centre, or scroll `
            + 'to bring it into view',
          refused: true,
        };
      }
      // Said out loud when what was under the point is plainly not what the
      // model described — the cheapest way for it to notice a misclick is to
      // be told the name of what it actually hit.
      const described = String(action.target || '');
      const doubt = aim.landed?.name && /["“'‘]/.test(described) && fit(described, aim.landed.name) === 0
        ? ` (that is not the name you gave — check it was the right thing)`
        : '';
      const where = named(aim.landed, `(${action.x}, ${action.y})`) + doubt;
      if (type === 'move') { await computer.move(aim.mouse.x, aim.mouse.y); return { said: `moved the pointer over ${where}` }; }
      if (type === 'double_click') { await computer.doubleClick(aim.mouse.x, aim.mouse.y); return { said: `double-clicked ${where}` }; }
      const button = type === 'right_click' ? 'right' : type === 'middle_click' ? 'middle' : 'left';
      await computer.click(aim.mouse.x, aim.mouse.y, button);
      return { said: `${button === 'left' ? 'clicked' : `${button}-clicked`} ${where}` };
    }

    case 'drag': {
      if (!hasPoint) return { said: 'nothing was done: drag needs x and y' };
      // Taken hold of exactly where the model said: a window's title bar, a
      // slider's handle, a file — the middle of the control is not the point.
      const from = shot.toScreen(action.x, action.y);
      const to = shot.toScreen(action.to_x ?? action.x, action.to_y ?? action.y);
      await computer.drag([from, to]);
      return { said: `dragged from (${action.x}, ${action.y}) to (${action.to_x}, ${action.to_y})` };
    }

    case 'scroll': {
      const dir = action.scroll_direction
        || (action.scroll_to === 'top' || action.scroll_to === 'start' ? 'up' : null)
        || (action.scroll_to === 'bottom' || action.scroll_to === 'end' ? 'down' : null)
        || (Number(action.dy) < 0 ? 'up' : 'down');
      const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
      const sign = dir === 'up' || dir === 'left' ? -1 : 1;
      const point = hasPoint
        ? shot.toPhysical(action.x, action.y)
        : { x: shot.physical.width / 2, y: shot.physical.height / 2 };
      const toEnd = Boolean(action.scroll_to);
      const screens = Math.max(0.05, Math.min(20, Number(action.scroll_amount) || 0.7));

      const io = {
        sense,
        frame: () => computer.frame(),
        wheel: (px, py, units, ax) => {
          const m = shot.physToScreen(px, py);
          return computer.wheel(m.x, m.y, units, ax);
        },
      };
      // The distance is in screens of the area, and only scrollBy knows the
      // area; so it is asked for as a fraction and scaled there.
      const r = await scrollBy(io, { point, axis, distance: sign * screens, screens: true, toEnd, scale: shot.scale });

      const way = { up: 'up', down: 'down', left: 'left', right: 'right' }[dir];
      const end = { up: 'top', down: 'bottom', left: 'left edge', right: 'right edge' }[dir];
      const inShot = Math.round(Math.abs(r.moved) * (shot.width / shot.physical.width));
      if (!r.moved) {
        return {
          said: `scrolled ${way}, but nothing moved: that area is already at the ${end}, or does not scroll`,
          moved: 0, frame: r.frame, ok: false,
        };
      }
      const share = r.view ? (Math.abs(r.moved) / r.view) : 0;
      return {
        said: `scrolled ${way} ${inShot}px in the screenshot (${share.toFixed(2)} of the area)`
          + `${r.atEnd ? ` and reached the ${end}` : ''}`
          + `${Number.isFinite(r.percent) && r.percent >= 0 ? ` — now ${Math.round(r.percent)}% of the way down` : ''}`,
        moved: r.moved,
        frame: r.frame,
        ok: true,
      };
    }

    case 'type':
      await computer.type(action.text ?? '');
      return { said: `typed ${JSON.stringify(String(action.text ?? '').slice(0, 60))}` };

    case 'key':
      await computer.keypress(action.keys ?? []);
      return { said: `pressed ${(action.keys ?? []).join('+')}` };

    case 'wait':
      await computer.wait(900);
      return { said: 'waited a moment', ok: true };

    case 'open_app':
      return openThing({ name: action.app || action.target || '' });

    case 'open_url':
      return openThing({ url: action.url || '', name: action.target || '' });

    default:
      return { said: `"${type}" is not something Halo can do` };
  }
}

/* --------------------------------------------------------------------------
   Checking
   -------------------------------------------------------------------------- */
const REPORT_TOOL = [{
  type: 'function',
  function: {
    name: 'report',
    description: 'Say whether the task actually got done, judging by the facts and the screen.',
    parameters: {
      type: 'object',
      properties: {
        succeeded: { type: 'boolean', description: 'Is what was asked for actually true now?' },
        summary: {
          type: 'string',
          description: 'One short past-tense sentence for the person. If it did '
            + 'not work, say plainly what happened instead.',
        },
      },
      required: ['succeeded', 'summary'],
    },
  },
}];

/** Whitespace and quotes made uniform, so "hello  there" is "hello there". */
const squash = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Ask Windows what is true, rather than a picture of it.
 *
 * What is in front, what has keyboard focus and the text its own
 * application says it holds, and which windows are open. Every part is
 * optional: without the accessibility helper this returns what it can, and
 * the verdict falls back on the screenshot for the rest.
 */
export async function gatherFacts(computer) {
  const sense = computer.sense ?? null;
  const [front, focused, windows] = await Promise.all([
    computer.foreground?.().catch(() => null) ?? null,
    sense?.focused?.().catch?.(() => null) ?? null,
    sense?.windows?.().catch?.(() => null) ?? null,
  ]);
  return {
    front: front && !isHaloWindow(front.title) ? front : null,
    focused: focused?.found ? focused : null,
    windows: Array.isArray(windows) ? windows.filter((w) => w && !w.tool && !isHaloWindow(w.title)) : null,
  };
}

/**
 * What the facts say about this run, in two halves:
 *
 *   lines     plain statements for the verifier, each one read from Windows
 *   settled   { succeeded, summary } when the facts alone decide it, or null
 *
 * The facts only decide it when every step was the kind a fact can confirm
 * — opening an app, typing text — and every one of them is confirmed. A
 * click, a scroll or a key press leaves nothing Windows can be asked about,
 * so a run with any of those still goes to the screenshot. Facts never
 * decide a failure on their own: a message box that clears when Enter sends
 * it no longer holds the text, and that is success.
 */
export function readFacts(facts, { steps = [], typed = [], pressed = [], opened = [], finished = true } = {}) {
  const lines = [];
  const { front, focused, windows } = facts;

  if (front?.title) lines.push(`The window in front is titled "${clip(front.title, 120)}"${front.process ? ` (${front.process})` : ''}.`);

  const value = typeof focused?.value === 'string' ? focused.value : null;
  if (focused) {
    const kind = String(focused.at?.type || 'control').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const label = focused.at?.name ? ` "${clip(focused.at.name, 60)}"` : '';
    lines.push(`Keyboard focus is on the ${kind}${label}${focused.title ? ` in "${clip(focused.title, 100)}"` : ''}`
      + `${value !== null ? `, whose text reads: "${clip(value, 400)}"` : ''}.`);
  }

  // The helper reads at most 800 characters of a field. Text past that point
  // is not missing, it is unread.
  const readable = value !== null && value.length < 790;
  const typedFound = typed.map((t) => {
    const found = value !== null && squash(value).includes(squash(t.text));
    if (found) lines.push(`The text "${clip(t.text, 80)}" is in that focused field.`);
    else if (readable) lines.push(`The text "${clip(t.text, 80)}" is not in the focused field now (it may have been sent, or focus moved on).`);
    return found;
  });

  const openedFound = opened.map((o) => {
    if (o.kind !== 'app' || !windows) return null;          // a browser tab says nothing reliable about itself
    const words = apps.norm(o.label).split(' ').filter((w) => w.length > 2 && !['microsoft', 'google', 'the'].includes(w));
    const w = windows.find((x) => !x.minimized && words.some((k) => apps.norm(`${x.title ?? ''} ${x.process ?? ''}`).includes(k)));
    lines.push(w ? `A ${o.label} window is open, titled "${clip(w.title, 100)}".` : `No ${o.label} window is open now.`);
    return Boolean(w);
  });

  const confirmable = finished
    && steps.length > 0
    && steps.every((s) => s.status === 'done' && (s.kind === 'open' || s.kind === 'keyboard'))
    && pressed.length === 0
    && steps.filter((s) => s.kind === 'keyboard').length <= typed.length
    && typedFound.every(Boolean)
    && openedFound.length === steps.filter((s) => s.kind === 'open').length
    && openedFound.every((x) => x === true);

  let settled = null;
  if (confirmable) {
    const parts = [
      ...opened.map((o) => (o.outcome === 'already-open' ? `brought ${o.label} to the front` : `opened ${o.label}`)),
      ...typed.map((t) => `typed "${clip(t.text, 60)}"`),
    ];
    const where = typed.length && focused?.title ? ` — it's there in ${clip(focused.title, 60)}` : '';
    const sentence = parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
      : parts[0];
    settled = { succeeded: true, summary: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${where}.` };
  }
  return { lines, settled };
}

/**
 * Say honestly whether it worked.
 *
 * Facts first. When they settle it, that is the answer, and no model is
 * asked to squint at a JPEG. When they do not, they go to the verifier with
 * the screenshot as things it must not contradict — "the focused field
 * contains 'hello there'" is not something a blurry picture of the letters
 * gets to overrule.
 *
 * Worth a whole extra call when it comes to that, because the alternative
 * was reciting the plan back as though it had happened: a run that opened
 * nothing still reported "Notepad was opened and hello there was typed",
 * which is the one kind of wrong an agent must never be.
 */
async function verify(llm, { task, doneWhen, shot, done, computer = null, steps = [], typed = [], pressed = [], opened = [], finished = true }) {
  const plain = done.length ? `Done: ${done.join('; ')}.` : 'Nothing was carried out.';

  let known = { lines: [], settled: null };
  if (computer) {
    try {
      known = readFacts(await gatherFacts(computer), { steps, typed, pressed, opened, finished });
    } catch { /* no facts to be had: the screenshot decides alone */ }
  }
  if (process.env.PICO_DEBUG && known.lines.length) console.log(`[verify] facts: ${known.lines.join(' | ')}`);
  if (known.settled) return { ...known.settled, by: 'facts' };

  try {
    const choice = await llm.respond({
      model: llm.tiers.see,
      system: [
        'You check whether a desktop task actually got done.',
        '',
        'You are given FACTS read directly from Windows — what is in front, what',
        'has keyboard focus, the exact text in the focused field, which windows',
        'are open — and a screenshot. The facts are exact. Where they answer the',
        'question, believe them over the picture. Use the screenshot for what',
        'they do not cover.',
        '',
        'Judge by what is true now. Do not be generous: if what was asked for',
        'should be there and is not, it did not work.',
        '',
        'But some things are not visible in a screenshot, and a screenshot',
        'never contains the mouse pointer. Moving the pointer, waiting, and',
        'scrolling something already at its end all leave the picture as it',
        'was. If the task asked for one of those and it was carried out, it',
        'succeeded — do not mark it failed for not showing up in a picture',
        'that cannot show it.',
        '',
        'The actions carried out are an exact record of what was typed and',
        'pressed. The screenshot is a compressed picture, and small text in it',
        'does not always resolve letter for letter, so do not fail a task',
        'because a word looks a character short of what the record says was',
        'typed. Judge whether the right thing is there, not whether every',
        'pixel of it can be read.',
      ].join('\n'),
      content: [
        {
          type: 'text',
          text: [
            `Task: ${task}`,
            doneWhen ? `Complete when: ${doneWhen}` : null,
            `Actions carried out: ${done.length ? done.join('; ') : 'none'}`,
            known.lines.length ? `FACTS FROM WINDOWS (exact):\n- ${known.lines.join('\n- ')}` : null,
            'Here is the screen now.',
          ].filter(Boolean).join('\n'),
        },
        image(shot),
      ],
      tools: REPORT_TOOL,
      effort: 'low',
      maxTokens: 2000,
    });
    const r = choice.call?.args;
    if (r && typeof r.summary === 'string' && r.summary.trim()) {
      return { succeeded: Boolean(r.succeeded), summary: r.summary.trim(), by: known.lines.length ? 'facts+screen' : 'screen' };
    }
  } catch {
    /* fall through to the plain account below */
  }
  return { succeeded: done.length > 0, summary: plain, by: 'record' };
}

export { ALLOW };

/** The prompts and tools, for measuring them against a real screen. */
export const internals = {
  ACT_TOOLS, ACT_SYSTEM, PLAN_TOOL, PLAN_TOOL_DECIDE, PLAN_SYSTEM, REPLAN_TOOL, REPLAN_SYSTEM, image, verify,
};
