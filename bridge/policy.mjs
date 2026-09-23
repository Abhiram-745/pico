/* ==========================================================================
   Halo — what needs asking first.

   OpenAI's computer-use model ships its own safety checks, which is what the
   approval cards were originally wired to. That model is not available to
   every key — it is not available to this one — so the loop runs on an
   ordinary vision model, and the judgement has to live here instead.

   The rule is about reversibility, not about danger in the abstract. Halo
   may click around, scroll, read and type all day. What it must not do
   silently is the small set of things that reach outside the machine or
   cannot be taken back: sending, publishing, buying, deleting, installing,
   and signing in or out.

   Two inputs decide it: what the action is, and what the agent said it was
   for. The second matters because "click at 1840,120" tells you nothing —
   "click Send to deliver the email" tells you everything.
   ========================================================================== */

/** Somewhere a message could actually be sent from. */
const MESSAGING = new RegExp(
  '\\b(?:whatsapp|messenger|telegram|signal|discord|slack|teams|gmail|outlook|mail|inbox'
  + '|imessage|instagram|twitter|linkedin|facebook|reddit|compose|new message|to:|subject)\\b', 'i');

/**
 * Things that leave the machine and cannot be recalled.
 *
 * Narrow on purpose. This used to fire on the word "submit" wherever it
 * appeared, so pressing Enter in a Wikipedia search box was weighed as
 * sending a message and stopped the run to ask — for a keystroke that does
 * nothing but run a search. An interruption that is usually wrong teaches
 * people to wave the next one through, which is the opposite of the point.
 *
 * So it now takes both: a verb that really is sending, and somewhere it
 * could really be sent from. "Send" in WhatsApp still asks. "Submit" on a
 * search page does not.
 */
const EXTERNAL = {
  categories: 'ExternalCommunication',
  level: 'High',
  test: /\b(?:send|sending|reply|replying|forward|post|posting|publish|tweet|dm)\b/i,
  needs: MESSAGING,
  reason: 'Sending a message is externally visible and cannot be undone.',
};

/** Things that destroy data. */
const DESTRUCTIVE = {
  categories: 'DataLoss',
  level: 'High',
  test: /\b(?:delete|deleting|remove|removing|erase|wipe|empty\s+(?:the\s+)?(?:bin|trash)|discard|clear\s+(?:all|history)|format|uninstall|overwrite|drop\s+table)\b/i,
  reason: 'This removes something, and Halo cannot put it back.',
};

/** Things that spend money. */
const PURCHASE = {
  categories: 'Payment',
  level: 'High',
  test: /\b(?:buy|buying|purchase|pay|paying|checkout|check\s+out|place\s+(?:the\s+)?order|confirm\s+(?:the\s+)?(?:order|booking|payment)|subscribe|renew)\b/i,
  reason: 'This spends money.',
};

/** Things that change the machine itself. */
const SYSTEM = {
  categories: 'SystemChange',
  level: 'High',
  test: /\b(?:install|installing|run\s+(?:the\s+)?installer|elevate|administrator|registry|shut\s*down|restart\s+(?:the\s+)?(?:pc|computer|machine)|sign\s+out|log\s+out|disable\s+(?:defender|firewall|antivirus))\b/i,
  reason: 'This changes the computer itself, not just what is on screen.',
};

/** Things only the person can legitimately do. */
const HUMAN_ONLY = {
  categories: 'Credentials',
  test: /\b(?:password|passphrase|passcode|pin\b|2fa|two-?factor|otp\b|one-?time\s+code|verification\s+code|captcha|recaptcha|credit\s+card|card\s+number|cvv|security\s+code|social\s+security|log\s+in|login|sign\s+in)\b/i,
  reason: 'Halo never types a credential, and never answers a CAPTCHA.',
};

const RULES = [EXTERNAL, DESTRUCTIVE, PURCHASE, SYSTEM];

export const ALLOW = {
  level: 'None',
  decision: 'Allow',
  categories: 'None',
  reason: 'No protected or high-impact operation was detected.',
};

/**
 * Judge one proposed action.
 *
 * @param {object} action   { type, why, text, keys }
 * @param {string} windowTitle  whatever is in front, for context
 * @returns {{decision:'Allow'|'RequireConfirmation'|'Handover',
 *            level:string, categories:string, reason:string}}
 */
export function assess(action = {}, windowTitle = '') {
  // The agent's own words carry the intent; the window says where it lands.
  // What it is clicking ("the Send button") counts towards weighing a click,
  // but not towards handing over: a "Sign in" button can be pressed by
  // anyone, it is the password field that is the person's alone.
  const said = `${action.why ?? ''} ${action.text ?? ''} ${action.paste_text ?? ''} ${(action.keys ?? []).join(' ')}`;
  const context = `${said} ${action.target ?? ''} ${windowTitle}`;

  // Credentials are never approvable — they are handed back, every time.
  // Checked against what the agent means to do, not the window title alone:
  // a sign-in page in the background must not hijack an unrelated click.
  if (HUMAN_ONLY.test.test(said)) {
    return {
      decision: 'Handover',
      level: 'High',
      categories: HUMAN_ONLY.categories,
      reason: HUMAN_ONLY.reason,
    };
  }

  // Only acts that commit something need weighing. Moving, looking, scrolling
  // and waiting change nothing, whatever the window happens to be.
  // Pasting commits: it puts text into whatever has focus, exactly as typing
  // does, and the rules below weigh what that text says. Copying takes a
  // reading and changes nothing, so it is weighed like looking.
  const commits = ['click', 'double_click', 'right_click', 'middle_click',
    'drag', 'type', 'key', 'paste', 'hold_and_press', 'select_option', 'set_value'].includes(action.type);
  if (!commits) return { ...ALLOW };

  for (const rule of RULES) {
    // A rule with `needs` applies only where that context is present too.
    if (rule.needs && !rule.needs.test(context)) continue;
    if (rule.test.test(context)) {
      return {
        decision: 'RequireConfirmation',
        level: rule.level,
        categories: rule.categories,
        reason: rule.reason,
      };
    }
  }

  return { ...ALLOW };
}

/** One line describing an action, for the card and the activity log. */
export function describe(action = {}) {
  const why = String(action.why || '').trim();
  if (why) return why.charAt(0).toUpperCase() + why.slice(1);

  switch (action.type) {
    case 'click': return 'Click something on screen';
    case 'double_click': return 'Double-click something on screen';
    case 'right_click': return 'Open a context menu';
    case 'middle_click': return 'Middle-click something on screen';
    case 'drag': return 'Drag something across the screen';
    case 'type': return 'Enter text';            // never the text itself
    case 'key': return `Press ${(action.keys || []).join('+')}`;
    case 'switch_to': return 'Switch to another window';
    case 'hold_and_press': return 'Hold keys and press others';
    case 'select_text': return 'Select a span of text';
    case 'select_option': return 'Choose a dropdown option';
    case 'set_value': return 'Set a slider';
    case 'copy': return 'Copy the selection';
    case 'paste': return 'Paste what was copied';   // never the text itself
    case 'scroll': return 'Scroll the view';
    case 'move': return 'Move the pointer';
    case 'wait': return 'Wait for the app to respond';
    case 'screenshot': return 'Take a fresh look';
    default: return 'Act on the desktop';
  }
}

/** Action type -> the phase vocabulary the interface already speaks. */
export const ACTION_PHASE = {
  click: 'Click',
  double_click: 'Click',
  right_click: 'Click',
  middle_click: 'Click',
  type: 'Type',
  key: 'Keypress',
  scroll: 'Scroll',
  move: 'Move',
  wait: 'Wait',
  screenshot: 'Screenshot',
  drag: 'Drag',
  copy: 'Keypress',
  paste: 'Type',
  switch_to: 'Move',
  hold_and_press: 'Keypress',
  select_text: 'Click',
  select_option: 'Click',
  set_value: 'Click',
};
