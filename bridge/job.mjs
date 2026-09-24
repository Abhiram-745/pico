/* ==========================================================================
   Halo — one job, whatever shape it is.

   The single door every desktop job goes through, from the agent and from
   the QA harness alike, so the two can never disagree about how a job is
   carried out.

   Most jobs are one piece of work and go straight to the loop in driver.mjs.
   Two shapes are carried out here instead, because a model deciding each
   move from a screenshot is the wrong tool for both:

     a list        "from image 6 onwards, paste each prompt from the attached
                   table into ChatGPT and wait for each image" — the same
                   short job once per item, in order, exactly as written.
                   The list is taken apart in code (repeat.mjs) and each item
                   is sent and waited for in code (chatbox.mjs).

     one message   "send the attached prompt to Claude" — a list of one.

     one picture   "paste this picture into ChatGPT and ask what's in it" —
                   a list of one whose message starts with the picture,
                   pasted as a picture (clipboard-image.mjs), then the words
                   to go with it, sent once the app has taken the picture in.

   Anything else about a list — "search each of these names on Wikipedia" —
   is still a list here, but each item is done by the general loop, handed
   that one item and nothing else.

   `attachments` are what the person sent with the words: pasted text,
   files, pictures. Each is { id, name, kind: 'text'|'image', mime, size,
   text?, dataUrl? }.
   ========================================================================== */

import { runTask } from './driver.mjs';
import { parseRepeat, perItem, namedTarget, answering, sendsMessage } from './repeat.mjs';
import { send, waitForAnswer, mouseFor } from './chatbox.mjs';
import * as apps from './apps.mjs';

/** How long one answer may take. Pictures are slow; four minutes is not. */
const ANSWER_LIMIT_MS = 5 * 60_000;

/* Said while a list runs: leave one out by its number ("skip 8", "skip
   prompt 12"), or end it after the one in hand ("stop after this one",
   "that's enough"). */
const SKIP_ONE = /\bskip\s+(?:(?:prompt|item|line|message|number|no\.?|#)\s*)?(\d{1,3})\b/i;
const ENDS_LIST = /\b(?:stop|enough|no more|last one|finish (?:after|with)|leave it there|that(?:'| wi)?ll do)\b/i;

/**
 * Carry out one job on the real desktop.
 *
 * Takes exactly what runTask takes, plus `attachments`, and resolves to what
 * runTask resolves to: { succeeded, steps } or undefined when stopped.
 */
export async function runJob({ task, attachments = [], computer, llm, maxTurns = 24, hooks = {}, context = {} }) {
  const list = Array.isArray(attachments) ? attachments : [];
  const ordinary = () => runTask({ task, computer, llm, maxTurns, hooks, context: { ...context, attachments: list } });
  /* Guide mode is the person's hands on the mouse, never Halo's: the loop
     knows how to point instead of press, and nothing in this file does. */
  if (context.guide) return ordinary();
  const shape = planJob(task, list) ?? (list.length || !computer.sense ? null : await planPrompt(task, llm));
  if (!shape) return ordinary();
  /* One message is something the loop can also do, from pictures, where
     there is no accessibility to find the box by. A list is not: sent the
     loop's way it is lost within two items, so that says so instead. */
  if (shape.single && shape.how === 'chat' && !computer.sense) return ordinary();
  if (shape.picture) {
    /* A desktop that cannot put a picture on the clipboard cannot send one
       this way either; the loop says so in its own words. */
    if (typeof computer.writeClipboardImage !== 'function') return ordinary();
    /* The person said something to go with the picture, not in quotes: a
       fast model lifts it out. If it cannot, the loop is handed the whole
       instruction — rather than the picture going without its question. */
    if (shape.words === 'ask') {
      const words = await messageIn(task, llm, { picture: true });
      if (words === null) return ordinary();
      shape.items[0].text = words;
    }
  }
  return runList({ shape, task, attachments: list, computer, llm, maxTurns, hooks, context });
}

/* Asking for the answer back is a different job: sending is the easy half,
   and reading a reply off the screen is the loop's work, not this file's. */
const REPORT_BACK = /\b(?:tell me|let me know|what (?:it|they|he|she) (?:says?|said|replie[sd]|thinks?)|read (?:me )?(?:the|its|their) (?:answer|reply|response)|summari[sz]e (?:the|its|their)|show me|and (?:copy|bring) (?:the|its) (?:answer|reply|response))\b/i;

/**
 * "Prompt Lovable to make the animation smoother", "ask ChatGPT for five
 * names for a bakery": one message to an assistant app, written in the
 * person's words. The words to send are in the instruction — quoted, or said
 * in passing — and a fast model lifts them out as the message itself, in the
 * person's own voice, with nothing added. Then it is the same exact send as
 * everything above, instead of a model hunting for the box in a screenshot
 * and typing into whatever had focus — which is how "prompt it to make a
 * better scrollytelling animation" ended with the message gone from the box.
 *
 * Only for assistants. Messaging a person means opening the right
 * conversation first, which is a job for the loop.
 */
export async function planPrompt(task, llm) {
  const t = String(task ?? '').trim();
  if (!t || t.length > 6000) return null;
  const target = namedTarget(t);
  if (!target || !answering(target) || !sendsMessage(t) || REPORT_BACK.test(t)) return null;

  const message = quotedIn(t) || (await messageIn(t, llm)) || '';
  if (!message || message.length < 2) return null;
  const only = { n: 1, title: 'your message', text: message };
  return {
    instruction: t, all: [only], items: [only], range: {}, shape: 'prompt', from: 'message',
    how: 'chat', target, single: true,
    // One message: sent, and the run is over, unless they asked to wait.
    wait: /\bwait\b|\bgenerat|\bfinish/i.test(t),
  };
}

/** Words the person put in quotes: the message itself, exactly. */
const quotedIn = (t) => String(t ?? '').match(/["“]([^"”]{2,})["”]/)?.[1]?.trim() || '';

/* What the fast model is told when it lifts a message out of an instruction —
   and, when a picture goes in first, what the words are for then. */
const MESSAGE_SYSTEM = [
  'Someone asked a desktop assistant to send a message to an AI app such as ChatGPT, Claude or Lovable.',
  'Reply with JSON only: {"message": "..."} — the exact words to type into that app\'s message box and send,',
  'as the person would send them to the app, in their own voice. Keep every specific they gave; fix obvious',
  'typos; add nothing. Leave out anything addressed to the assistant rather than the app: which app, opening',
  'it, going to a project, waiting. If they are not asking for a message to be sent, reply {"message": ""}.',
];
const WITH_PICTURE = [
  'They attached a picture, and it is pasted into the message box first: the words are only what goes with it.',
  '"Paste this picture into ChatGPT and ask what\'s in it" is {"message": "What\'s in this picture?"}. Never',
  'describe the picture or mention attaching it. If they said nothing to go with it, reply {"message": ""}.',
];

/**
 * The message in an instruction, lifted out by a fast model in the person's
 * own voice: '' when they asked for nothing to be said, null when it could
 * not be asked or its answer made no sense — which is not the same as
 * nothing to say, and the caller does not treat it as that.
 */
async function messageIn(task, llm, { picture = false } = {}) {
  if (!llm?.chat) return null;
  try {
    const reply = await llm.chat([
      { role: 'system', content: [...MESSAGE_SYSTEM, ...(picture ? WITH_PICTURE : [])].join('\n') },
      { role: 'user', content: String(task ?? '') },
    ], { model: llm.tiers?.text || llm.tiers?.fast, maxTokens: 500, signal: AbortSignal.timeout(7000) });
    const json = String(reply ?? '').match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const said = JSON.parse(json)?.message;
    return typeof said === 'string' ? said.trim() : null;
  } catch { return null; }
}

/* The words of an instruction that only say a picture is to be sent, and
   where: "send the attached image to ChatGPT", "paste this picture into the
   chat". Anything left once these, the app's name and the picture's own
   name are taken out is something the person wants said with the picture,
   and only then is a model asked for the words. Erring the other way would
   send the picture without the question it was sent for; erring this way
   costs one quick question to a model, which answers "" when there is
   nothing to say. */
const JUST_SENDING = new Set(('please kindly just now then here also and for me can could would will you go '
  + 'paste send put drop post share upload attach attached submit give enter this that the my a an it its '
  + 'picture image photo screenshot screen shot pic file one in into to on onto inside over chat window app '
  + 'box message composer tab browser website site').split(' '));

function saysMoreThanSend(task, { target = '', name = '' } = {}) {
  const own = new Set(String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return String(task ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean)
    .some((w) => !JUST_SENDING.has(w) && !own.has(w) && !(target && w.length >= 2 && target.includes(w.replace(/'/g, ''))));
}

/**
 * The shape of a job, or null for an ordinary one.
 *   { instruction, all, items, range, how: 'chat'|'task', wait, target }
 */
export function planJob(task, attachments = []) {
  const job = parseRepeat(task, attachments);
  if (job) return { ...job, ...perItem(job.instruction), target: namedTarget(job.instruction) };

  const t = String(task ?? '');
  const texts = attachments.filter((a) => a?.kind === 'text' && String(a.text ?? '').trim());
  const pictures = attachments.filter((a) => a?.kind === 'image' && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/'));

  /* A single attached text, to be sent in a chat app: a list of one. The
     general loop could do it, but it would have to find the box, paste, send
     and judge it all from pictures — and this is the same three moves the
     list path already does exactly. Not with a picture attached as well:
     sent this way the picture was simply left behind. That is the next
     shape's, below. */
  if (texts.length === 1 && !pictures.length && sendsMessage(t) && !REPORT_BACK.test(t)) {
    const how = perItem(t);
    if (how.how === 'chat') {
      const only = { n: 1, title: String(texts[0].name || 'the attachment'), text: String(texts[0].text).trim() };
      return { instruction: t, all: [only], items: [only], range: {}, shape: 'attachment', from: 'attachment', ...how, target: namedTarget(t), single: true };
    }
  }

  /* One picture, for an assistant: "paste this picture into ChatGPT and ask
     what's in it", "send the attached image to Claude". The same exact
     route as a text — the box found by Windows, the picture pasted as a
     picture, the words to go with it pasted after it, sent only once the
     app has finished taking the picture in (chatbox.mjs) — rather than the
     loop finding all of that from screenshots.

     The words: an attached text if there is one (the prompt the picture
     goes with), else what the person quoted, else — only if the
     instruction says more than where the picture goes — what a fast model
     lifts out of it; runJob asks, since this has to answer at once. None at
     all is a picture sent on its own.

     Only an assistant, or "the chat" in front. Sending a picture to a
     person means opening the right conversation first, which is the loop's
     job, as it is for a message (planPrompt). */
  if (pictures.length === 1 && texts.length <= 1 && sendsMessage(t) && !REPORT_BACK.test(t)) {
    const how = perItem(t);
    const target = namedTarget(t);
    if (how.how === 'chat' && (!target || answering(target))) {
      const name = String(pictures[0].name || 'the picture');
      const given = texts.length ? String(texts[0].text).trim() : quotedIn(t);
      const only = { n: 1, title: name, text: given, picture: pictures[0].dataUrl };
      return {
        instruction: t, all: [only], items: [only], range: {}, shape: 'picture', from: 'attachment',
        ...how, target, single: true, picture: true,
        words: given ? 'given' : (saysMoreThanSend(t, { target, name }) ? 'ask' : 'none'),
      };
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   A list
   -------------------------------------------------------------------------- */
async function runList({ shape, task, attachments, computer, llm, maxTurns, hooks, context }) {
  const {
    gate = async () => true, onPhase = () => {}, onPlan = () => {}, onAction = () => {}, onAudit = () => {},
    onSummary = () => {}, onError = () => {}, onQuestion = async () => '', remembered = () => null, remember = () => {},
    steer = () => [],
  } = hooks;
  const sense = computer.sense ?? null;
  const { items, all } = shape;
  const noun = nounFor(shape.instruction, shape);

  onPhase('Starting');
  onAudit('run_started', { metadata: { model: 'list', items: items.length, of: all.length, how: shape.how } });

  /* Nothing in the range asked for. The commonest reason is the one the
     person actually hit: the list was cut short on its way in, so "from 6
     onwards" pointed past its end. Say which, rather than doing nothing. */
  if (!items.length) {
    const cut = all.some((it) => it.cut);
    const nums = all.map((it) => it.n).filter(Number.isInteger);
    const span = nums.length ? `${Math.min(...nums)} to ${Math.max(...nums)}` : `1 to ${all.length}`;
    const said = `The list I was given only has ${noun}s ${span}${cut ? ', and the last one looks cut off' : ''}, so there is nothing ${describeRange(shape.range)} to do.`
      + (cut ? ' Try attaching the table with the paperclip, or pasting it again — the whole of it should come through now.' : '');
    onPlan(null);
    onPhase('Stopped');
    onAudit('run_stopped', { metadata: { list: true, empty: true } });
    onSummary(said);
    return { succeeded: false, steps: [] };
  }

  /* The timeline: one row per item, so the island can show "Prompt 7 of 15"
     and tick each one off as it really goes. */
  const rows = items.map((it) => ({
    id: `item_${it.n}`,
    do: `${cap(noun)} ${it.n}${it.title ? ` · ${it.title}` : ''}`.slice(0, 100),
    kind: 'milestone',
    status: 'pending',
    doneWhen: shape.how === 'chat' ? (shape.wait ? 'sent, and the answer finished' : 'sent') : 'done',
  }));
  let index = 0;
  let live = 'Getting ready';
  const activity = [];
  const publish = (extra = {}) => onPlan({
    steps: rows.map((r) => ({ ...r })),
    index,
    doneWhen: `${items.length} ${noun}${items.length === 1 ? '' : 's'} done`,
    revision: 0,
    list: true,             // the island shows `live` in place of "Step n of m" (island.jsx)
    live,
    activity: activity.slice(-30).map((text, i) => ({ id: `a${i}`, text })),
    ...extra,
  });
  const say = (text) => { live = text; publish(); };
  publish();

  /* Skip, and anything said, while the list runs. agent.mjs keeps them
     until asked, and only the loop ever asked — so during a list both did
     nothing at all. Skip is the row in hand, or the row it names. What is
     said cannot rewrite a list half done, except to end it ("stop after
     this one") or leave one out ("skip 8"); anything else is answered
     plainly rather than silently dropped. */
  const skips = new Set();       // rows not to do
  let lastOne = false;           // end after the row in hand
  const heard = (at) => {
    const kept = [];
    for (const s of [].concat((() => { try { return steer() ?? []; } catch { return []; } })())) {
      if (s?.type === 'skip') {
        const row = Number.isInteger(s.index) ? s.index : at;
        if (row >= at && rows[row]) skips.add(row);
      } else if (s?.type === 'correct' && String(s.text ?? '').trim()) {
        const text = String(s.text).trim();
        const named = SKIP_ONE.exec(text);
        const row = named ? items.findIndex((it, j) => j >= at && it.n === Number(named[1])) : -1;
        if (row >= 0) { skips.add(row); activity.push(`Will skip ${noun} ${items[row].n}, as asked`); } else if (ENDS_LIST.test(text)) { lastOne = true; activity.push(`Stopping after ${noun} ${items[at]?.n ?? ''}, as asked`.trim()); } else kept.push(text);
      }
    }
    return kept;
  };

  if (shape.how !== 'chat') {
    return eachByLoop({ shape, rows, items, computer, llm, maxTurns, hooks, context, attachments, publish, say, activity, setIndex: (i) => { index = i; }, noun, heard, skips, isLast: () => lastOne });
  }

  /* --- where it goes ----------------------------------------------------- */
  if (!sense) {
    const said = 'I need Windows accessibility to find the message box, and it is not available on this machine.';
    finish({ onPhase, onAudit, onSummary, onPlan: publish }, { succeeded: false, said, rows });
    return { succeeded: false, steps: [] };
  }
  onPhase('Observing');
  say('Finding the chat window');
  const target = await findTarget({ computer, sense, shape, context, task, gate, onPhase, onAction, onQuestion, remembered, remember });
  if (!(await gate())) return undefined;
  if (!target?.hwnd) {
    const said = target?.said ?? `I could not find ${shape.target ? `a ${shape.target} window` : 'the chat window'} to send ${noun}s to.`;
    finish({ onPhase, onAudit, onSummary, onPlan: publish }, { succeeded: false, said, rows });
    return { succeeded: false, steps: [] };
  }
  activity.push(`Using "${target.title}"`);

  // The shot is only for the ratio between desktop pixels and mouse units.
  const toMouse = mouseFor(await Promise.resolve().then(() => computer.capture()).catch(() => null));
  const before = await Promise.resolve().then(() => computer.readClipboard()).catch(() => '');

  const sent = [];
  let failure = null;
  let stopped = false;
  let endedEarly = false;
  /* What was said that a list under way cannot act on: answered in its
     activity, so it is not a correction that silently went nowhere. */
  const answer = (said) => {
    for (const text of said) activity.push(`Not changed: "${text.slice(0, 60)}" — a list already under way can only skip items or stop early. Stop it and ask again to change it.`);
    if (said.length) publish();
  };
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      index = i;
      answer(heard(i));
      if (lastOne && i > 0) {
        for (let j = i; j < rows.length; j++) rows[j].status = 'skipped';
        endedEarly = true;
        break;
      }
      if (skips.has(i)) {
        rows[i].status = 'skipped';
        activity.push(`Skipped ${noun} ${it.n}, as asked`);
        publish();
        continue;
      }
      rows[i].status = 'pending';
      if (!(await gate())) { stopped = true; break; }
      onPhase('Acting');
      say(`${cap(noun)} ${it.n} of ${all.length} · pasting`);
      onAction({ type: 'Keypress', detail: `Pasting ${noun} ${it.n}` });

      const result = await send({
        computer, sense, hwnd: target.hwnd, text: it.text, picture: it.picture ?? null, toMouse, gate,
        onLive: (t) => say(`${cap(noun)} ${it.n} · ${t.toLowerCase()}`),
        confirmDraft: i === 0 ? (draft) => confirmDraft({ onQuestion, onPhase, draft, target }) : null,
      });
      if (result.stopped) { stopped = true; break; }
      if (!result.ok) {
        rows[i].status = 'failed';
        failure = { item: it, why: result.why, declined: result.declined };
        break;
      }
      sent.push(it);
      activity.push(`Sent ${noun} ${it.n}${it.title ? ` (${it.title})` : ''}`);
      onAudit('action_executed', { action_type: 'Paste', metadata: { item: it.n } });

      if (shape.wait) {
        /* Not a working phase: Halo has let go of the mouse while the app
           thinks, so the island takes clicks again and Pause and Stop are
           in reach for the minutes a picture can take. */
        onPhase('Waiting');
        const waited = await waitForAnswer({
          computer, sense, hwnd: target.hwnd, gate, timeoutMs: ANSWER_LIMIT_MS,
          onLive: (t) => say(`${cap(noun)} ${it.n} of ${all.length} · ${t.toLowerCase()}`),
          // Skip while it answers: sent already, so not waited for. The next
          // one waits for the app to be free before it goes in (chatbox.mjs).
          skip: () => { answer(heard(i)); return skips.has(i); },
        });
        if (waited.stopped) { stopped = true; rows[i].status = 'done'; break; }
        if (waited.timedOut) {
          rows[i].status = 'failed';
          failure = { item: it, why: `it was still going after ${Math.round(ANSWER_LIMIT_MS / 60000)} minutes`, sentOk: true };
          break;
        }
        activity.push(waited.skipped
          ? `Moved on from ${noun} ${it.n} without waiting for the answer, as asked`
          : `${cap(noun)} ${it.n} finished (${Math.round(waited.ms / 1000)}s)`);
      }
      rows[i].status = 'done';
      publish();
    }
  } finally {
    // The clipboard is the person's: what they had on it before goes back.
    if (typeof before === 'string' && before) await Promise.resolve().then(() => computer.writeClipboard(before)).catch(() => {});
  }
  if (stopped) return undefined;

  const left = items.filter((_, j) => rows[j].status === 'skipped');
  index = Math.min(sent.length + left.length, rows.length - 1);
  // Everything asked for went, apart from what the person took out.
  const succeeded = !failure && sent.length + left.length === items.length;
  const said = summaryFor({ shape, noun, sent, items, failure, target, skipped: left, endedEarly });
  finish({ onPhase, onAudit, onSummary, onPlan: publish }, { succeeded, said, rows });
  return { succeeded, steps: rows.filter((r) => r.status === 'done').map((r) => r.do) };
}

/* Anything that is not "send it in a chat": each item done by the general
   loop, handed only that item. Its own summaries are collected rather than
   shown one by one — the person asked for one job, and gets one account of
   it at the end. */
async function eachByLoop({ shape, rows, items, computer, llm, maxTurns, hooks, context, publish, say, activity, setIndex, noun, heard, skips, isLast }) {
  const { gate = async () => true, onPhase = () => {}, onAudit = () => {}, onSummary = () => {} } = hooks;
  const outcomes = [];
  let endedEarly = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    setIndex(i);
    /* Said between items: a correction is for the one about to start, and
       reaches its run first thing. */
    const early = heard(i);
    if (isLast() && i > 0) {
      for (let j = i; j < rows.length; j++) rows[j].status = 'skipped';
      endedEarly = true;
      break;
    }
    if (skips.has(i)) {
      rows[i].status = 'skipped';
      activity.push(`Skipped ${noun} ${it.n}, as asked`);
      publish();
      continue;
    }
    if (!(await gate())) return undefined;
    say(`${cap(noun)} ${it.n} of ${shape.all.length}`);
    let said = '';
    /* Skip, while this item's run is going, ends that run: its own Skip
       means "not that action, something else", which would keep it going. */
    const skipped = () => skips.has(i);
    const result = await runTask({
      task: `${shape.instruction}\n\nDo this for ONE ${noun} only — ${noun} ${it.n}, which is attachment 1. Do nothing for any other.`,
      computer,
      llm,
      maxTurns: Math.max(6, Math.min(maxTurns, 16)),
      context: {
        ...context,
        milestonePlanning: false,
        attachments: [{ id: `item_${it.n}`, name: `${cap(noun)} ${it.n}`, kind: 'text', mime: 'text/plain', size: it.text.length, text: it.text }],
        note: [context.note, `This is ${noun} ${it.n} of a list of ${shape.all.length}; the others are handled separately.`].filter(Boolean).join(' '),
      },
      hooks: {
        ...hooks,
        gate: async () => !skipped() && await gate(),
        steer: () => [...early.splice(0), ...heard(i)].map((text) => ({ type: 'correct', text })),
        /* The inner run's own line of what it is doing, under this item's
           name — its checklist is its business, the list is this one's. */
        onPlan: (p) => {
          const line = p?.live ?? [...(p?.steps ?? [])].reverse().find((s) => s.status === 'pending')?.do;
          if (line && !p?.finished) say(`${cap(noun)} ${it.n} · ${line}`);
        },
        onSummary: (text) => { said = text; },
        onPhase: (phase) => { if (!['Completed', 'Stopped', 'Failed'].includes(phase)) onPhase(phase); },
      },
    });
    if (skipped()) {
      rows[i].status = 'skipped';
      activity.push(`Skipped ${noun} ${it.n}, as asked`);
      publish();
      continue;
    }
    if (result === undefined) return undefined;          // stopped by the person
    rows[i].status = result.succeeded ? 'done' : 'failed';
    outcomes.push({ it, ok: Boolean(result.succeeded), said });
    activity.push(`${cap(noun)} ${it.n}: ${said || (result.succeeded ? 'done' : 'did not work')}`);
    publish();
    if (!result.succeeded) break;
  }
  const good = outcomes.filter((o) => o.ok);
  const bad = outcomes.find((o) => !o.ok);
  const left = items.filter((_, j) => rows[j].status === 'skipped');
  const succeeded = !bad && good.length + left.length === items.length;
  const leftWords = left.length ? `, and ${endedEarly ? 'stopped before' : 'skipped'} ${rangeWords(left)}, as you asked` : '';
  const said = succeeded
    ? (left.length
      ? `Done — ${good.length} of ${items.length} ${noun}${items.length === 1 ? '' : 's'}${good.length ? ` (${rangeWords(good.map((o) => o.it))})` : ''}${leftWords}.`
      : `Done — all ${items.length} ${noun}${items.length === 1 ? '' : 's'} (${rangeWords(items)}).`)
    : `Did ${good.length} of ${items.length} ${noun}s. ${cap(noun)} ${bad?.it.n ?? ''} did not work${bad?.said ? `: ${bad.said}` : ''}, so I stopped there.`;
  finish({ onPhase, onAudit, onSummary, onPlan: publish }, { succeeded, said, rows });
  return { succeeded, steps: rows.filter((r) => r.status === 'done').map((r) => r.do) };
}

/* --------------------------------------------------------------------------
   Finding the chat window
   -------------------------------------------------------------------------- */
const BROWSERS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;

async function findTarget({ computer, sense, shape, context, task, gate, onPhase, onAction, onQuestion, remembered, remember }) {
  const listed = ((await sense.windows().catch(() => null)) ?? [])
    .filter((w) => w?.hwnd && !w.tool && !apps.isHaloWindow(w.title) && w.title && w.title !== 'Program Manager');

  if (!shape.target) {
    // "In the chat": the window the person was using, which is the one in
    // front once Halo's own are set aside.
    const front = listed.find((w) => !w.minimized);
    return front ? { hwnd: front.hwnd, title: front.title } : null;
  }

  // Squashed the same way as what it is compared with: "character.ai" is
  // "characterai" in both, where a plain lower-casing left the dot in one.
  const key = squash(shape.target);
  const said = apps.preference(shape.instruction) ?? apps.preference(task);
  /* The app itself (its own process), or a browser showing it. Not any
     window whose title happens to hold the name: a terminal titled "Claude
     Code" or a Notepad open on "chatgpt prompts.txt" also says it, and an
     item pasted there and sent with Enter is a command run, or a file
     changed, that nobody asked for. */
  const isIt = (w) => squash(w.process).includes(key)
    || (BROWSERS.test(String(w.process || '')) && squash(w.title).includes(key));
  const matches = listed.filter(isIt);
  const rank = (w) => {
    const browser = BROWSERS.test(String(w.process || ''));
    let score = 0;
    if (said === 'site') score += browser ? 0 : 10;
    else score += browser ? 5 : 0;             // the app, unless they said the website
    if (w.minimized) score += 3;
    return score;
  };
  matches.sort((a, b) => rank(a) - rank(b));
  if (matches[0]) return { hwnd: matches[0].hwnd, title: matches[0].title };

  /* Not open: open it the way every other opening happens — the app by its
     Start-menu id, the site in the browser, and the person asked which when
     it is both and they have not said. */
  onAction({ type: 'Keypress', detail: `Open ${shape.target}` });
  const opened = await apps.open({ name: shape.target }, {
    computer, task: shape.instruction, gate,
    ask: async (question, options) => {
      /* Waiting on the person, as a phase: while the run is Observing the
         island lets clicks through it (see WORKING in server.mjs), and the
         question is answered by clicking the island. */
      onPhase('AwaitingApproval');
      const a = await onQuestion({ id: `q_${Date.now()}`, text: question, options });
      onPhase('Observing');
      return a && typeof a === 'object' ? a : { text: String(a ?? ''), choice: null };
    },
    onAction, remembered, remember, browser: context.browser ?? null,
  }).catch(() => null);
  if (!opened || !opened.ok) return { said: opened?.summary || `I could not open ${shape.target}.` };
  await new Promise((r) => setTimeout(r, 1500));      // a chat app takes a moment to draw its box
  const again = ((await sense.windows().catch(() => null)) ?? [])
    .filter((w) => w?.hwnd && !w.tool && !apps.isHaloWindow(w.title))
    .find(isIt)
    ?? (opened.window?.hwnd ? opened.window : null);
  return again ? { hwnd: again.hwnd, title: again.title } : { said: `I opened ${shape.target} but could not find its window.` };
}

/** Ask once before sending over something the person had already typed. */
async function confirmDraft({ onQuestion, onPhase, draft, target }) {
  onPhase('AwaitingApproval');
  const a = await onQuestion({
    id: `q_${Date.now()}`,
    text: `The message box in "${target.title}" already has something in it ("${String(draft).replace(/\s+/g, ' ').slice(0, 60)}…"). Replace it?`,
    options: [{ id: 'replace', label: 'Replace it' }, { id: 'leave', label: 'Leave it, stop' }],
  });
  onPhase('Acting');
  const choice = a && typeof a === 'object' ? a.choice : null;
  const text = String((a && typeof a === 'object' ? a.text : a) ?? '');
  if (choice === 'leave' || /\b(?:no|leave|stop|keep|don'?t)\b/i.test(text)) return false;
  return true;
}

/* --------------------------------------------------------------------------
   Words
   -------------------------------------------------------------------------- */
const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s._-]+/g, '');
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** What the items are called, from how the person called them. */
function nounFor(instruction, shape) {
  const t = String(instruction ?? '').toLowerCase();
  const m = t.match(/\b(prompt|image|picture|message|question|line|row|item|name|post|email|slide)s?\b/);
  if (m) return m[1] === 'picture' ? 'image' : m[1];
  if (shape?.single) return 'message';
  return 'item';
}

function describeRange(range = {}) {
  if (range.last) return `in the last ${range.last}`;
  if (range.from != null && range.to != null) return `from ${range.from} to ${range.to}`;
  if (range.from != null) return `from ${range.from} onwards`;
  if (range.to != null) return `up to ${range.to}`;
  return 'in it';
}

function rangeWords(items) {
  const nums = items.map((it) => it.n);
  if (nums.length === 1) return `${nums[0]}`;
  const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return consecutive ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(', ');
}

function summaryFor({ shape, noun, sent, items, failure, target, skipped = [], endedEarly = false }) {
  const where = target?.title ? ` in ${String(target.title).replace(/\s+-\s+(?:Google Chrome|Microsoft Edge|Mozilla Firefox)$/i, '')}` : '';
  const waited = shape.wait ? ' and waited for each to finish' : '';
  if (!failure && !sent.length && skipped.length) return `Nothing sent: you skipped ${skipped.length === 1 ? 'it' : `all ${skipped.length}`}.`;
  /* A picture is said to have gone as a picture, with the words that went
     with it: those may have been lifted out of the instruction by a model,
     so the person is shown exactly what was sent in their name. */
  if (shape.picture && !failure && sent.length) {
    const words = String(sent[0].text ?? '').replace(/\s+/g, ' ').trim();
    const withWords = words ? ` with "${words.length > 80 ? `${words.slice(0, 79)}…` : words}"` : '';
    return `Sent the picture${withWords}${where}${shape.wait ? ' and waited for the answer' : ''}.`;
  }
  if (shape.picture && failure && !failure.declined) {
    return failure.sentOk ? `The picture was sent, but ${failure.why}.` : `The picture did not go: ${failure.why}.`;
  }
  if (shape.single && !failure) return `Sent it${where}${shape.wait ? ' and waited for the answer' : ''}.`;
  if (!failure && skipped.length) {
    const why = endedEarly ? `stopped before ${rangeWords(skipped)}, as you asked` : `skipped ${rangeWords(skipped)}, as you asked`;
    return `Done — sent ${noun}${sent.length === 1 ? '' : 's'} ${rangeWords(sent)}${where}${waited}, and ${why}. That's ${sent.length} of ${items.length}.`;
  }
  if (!failure) {
    return `Done — sent ${noun}s ${rangeWords(sent)}${where}${waited}. That's ${sent.length} of ${sent.length}.`;
  }
  const upTo = sent.length ? `Sent ${sent.length} of ${items.length} (${noun}${sent.length === 1 ? '' : 's'} ${rangeWords(sent)})${where}. ` : '';
  if (failure.declined) return `${upTo}I stopped: ${failure.why}.`;
  if (failure.sentOk) return `${upTo}${cap(noun)} ${failure.item.n} was sent, but ${failure.why}, so I stopped before the next one.`;
  return `${upTo}${cap(noun)} ${failure.item.n} did not go: ${failure.why}. I stopped there so nothing is sent out of order.`;
}

function finish({ onPhase, onAudit, onSummary, onPlan }, { succeeded, said, rows }) {
  onPlan({ finished: true, succeeded, ...(rows ? { steps: rows.map((r) => ({ ...r })) } : {}) });
  onPhase(succeeded ? 'Completed' : 'Stopped');
  onAudit(succeeded ? 'run_completed' : 'run_stopped', { metadata: { list: true } });
  onSummary(said);
}
