/* ==========================================================================
   Halo — putting a message in a chat app, sending it, and waiting.

   ChatGPT, Claude, Lovable, Gemini, WhatsApp, Discord: whatever the app, the
   job is the same three moves, and none of them needs a model to decide.

     1. the box      found by asking Windows what is under a few points near
                     the bottom of the window (sense `composer`), clicked with
                     the person's own pointer, and checked to have the caret
     2. the words    put on the clipboard and pasted — exact, instant, and the
                     same for three words or three thousand — then checked to
                     be in the box, and sent with Enter (or the Send button,
                     for an app where Enter is a new line). A picture, when
                     there is one, goes in first, pasted as a picture
                     (clipboard-image.mjs); the app uploads it and keeps Send
                     disabled until it has, so Send is watched, and Enter
                     waits for it
     3. the answer   waited for, where the app says it is still writing: the
                     send button turns into a stop button while a reply or a
                     picture is being made, and back again when it is done.
                     These apps refuse a second message while the first is
                     still going, so this wait is not politeness — without it
                     every other item would be dropped.

   Why not the general loop: it looks at a screenshot and asks a model what
   to do next, every time. For a list of twenty prompts that is twenty times
   the same three decisions, each one a chance to click the wrong thing, and
   the person's own run showed it — prompt 2 sent, prompt 1 said to be
   missing, then a stop. Here each decision is made once, by code, and
   checked against what Windows reports rather than what a picture shows.

   The pointer is the person's own and moves where they can see it (see
   no-extra-cursor in the project notes). UI Automation is only asked where
   things are, never used to press them.
   ========================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The send button's other faces. While a reply is being written the button
   at the end of the box is some kind of stop: "Stop streaming" (ChatGPT),
   "Stop response" (Claude, Gemini), "Stop generating", plain "Stop". */
export const STOP = /\bstop\b(?!\s*(?:dictation|recording|listening|voice))|\bcancel (?:response|generation|reply)\b|\binterrupt\b/i;
export const SEND = /\bsend\b|\bsubmit\b/i;

/** Lower case, one space: how two pieces of text are compared. */
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/* A pasted picture, waited for. The app uploads it before it can be sent,
   and says so the only way it can be read: Send stays disabled — ChatGPT
   shows it greyed, Claude the same — until the upload is done. Enter
   pressed before then is ignored by some apps and, by others, sends the
   words without the picture they were about. */
export const UPLOAD_MS = 30_000;      // a big picture on a slow line, and no longer
const QUIET_APP_MS = 2500;            // an app that names no buttons at all: a moment, then on
const SETTLE_MS = 1200;               // Send already enabled before the paste: watched this long for the upload to disable it

/**
 * Where a desktop point goes for the mouse. UI Automation answers in desktop
 * pixels; the mouse is driven in the primary display's scaled units (see
 * physToScreen in screen.mjs) — a shot knows the ratio.
 */
export function mouseFor(shot) {
  const scale = Number(shot?.raw?.mouseScale ?? shot?.scale) || 1;
  return (x, y) => ({ x: Math.round(Number(x) / scale), y: Math.round(Number(y) / scale) });
}

/** The box and its buttons as Windows reports them now, or null. */
export async function readBox(sense, hwnd) {
  const r = await Promise.resolve().then(() => sense?.composer?.(hwnd)).catch(() => null);
  if (!r?.found || !Array.isArray(r.field?.rect) || r.field.rect.length !== 4) return null;
  const buttons = (Array.isArray(r.buttons) ? r.buttons : []).filter((b) => b && typeof b.name === 'string');
  return {
    rect: r.field.rect,
    name: String(r.field.name || ''),
    type: String(r.field.type || ''),
    // null when the app does not say what is in it — not the same as empty
    value: typeof r.field.value === 'string' ? r.field.value : null,
    buttons,
    stop: buttons.find((b) => STOP.test(b.name) && !SEND.test(b.name)) ?? null,
    send: buttons.find((b) => SEND.test(b.name) && !STOP.test(b.name)) ?? null,
  };
}

/** Find the box, giving a tree that is still being built a moment or two. */
export async function findBox(sense, hwnd, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    const box = await readBox(sense, hwnd);
    if (box) return box;
    await sleep(250 + (i * 250));
  }
  return null;
}

/**
 * Bring a window to the front and make sure it stayed there. Hit tests see
 * only the window on top, and keys go to whatever holds focus, so nothing
 * below is worth doing until this is true.
 */
export async function bringForward(computer, sense, hwnd) {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve().then(() => computer.focus(hwnd)).catch(() => false);
    await sleep(140 + (i * 160));
    const fg = await Promise.resolve().then(() => sense?.foreground?.()).catch(() => null);
    if (fg?.hwnd && String(fg.hwnd) === String(hwnd)) return true;
  }
  return false;
}

/**
 * The last way to find the box: click where chat apps keep it — across the
 * middle, just above the bottom edge — and ask Windows what took the caret.
 * For an app whose tree does not lead from a point up to its text field,
 * which a hit test needs and a click does not. Only a writable text field
 * counts; anything else and nothing is typed.
 */
async function boxByClicking({ computer, sense, hwnd, toMouse }) {
  const w = (await Promise.resolve().then(() => sense?.windows?.()).catch(() => null))?.find((x) => String(x.hwnd) === String(hwnd));
  const r = Array.isArray(w?.rect) && w.rect.length === 4 ? w.rect : null;
  if (!r) return null;
  for (const up of [96, 140]) {
    const at = toMouse(r[0] + (r[2] * 0.55), r[1] + r[3] - up);
    await computer.click(at.x, at.y);
    await sleep(160);
    const f = await Promise.resolve().then(() => sense?.focused?.()).catch(() => null);
    const el = f?.at;
    const writable = el && (el.type === 'Edit' || (el.how === 'value' && el.readOnly === false)) && el.readOnly !== true;
    if (writable && Array.isArray(el.rect) && el.rect[2] >= 80) {
      return {
        rect: el.rect, name: String(el.name || ''), type: String(el.type || ''),
        value: typeof el.value === 'string' ? el.value : null, buttons: [], stop: null, send: null,
      };
    }
  }
  return null;
}

/** The box as whatever holds the caret says it is — no click, just a read. */
async function focusBox(sense) {
  const f = await Promise.resolve().then(() => sense?.focused?.()).catch(() => null);
  const el = f?.at;
  if (!el || !Array.isArray(el.rect)) return null;
  return {
    rect: el.rect, name: String(el.name || ''), type: String(el.type || ''),
    value: typeof el.value === 'string' ? el.value : (typeof f.value === 'string' ? f.value : null),
    buttons: [], stop: null, send: null,
  };
}

/** Is the caret in the box? Read from what Windows says holds focus. */
async function caretIn(sense, box) {
  const f = await Promise.resolve().then(() => sense?.focused?.()).catch(() => null);
  const at = f?.at;
  if (!at) return null;                       // cannot tell — not the same as no
  const r = Array.isArray(at.rect) ? at.rect : null;
  if (!r) return null;
  const [bx, by, bw, bh] = box.rect;
  const overlaps = r[0] < bx + bw && r[0] + r[2] > bx && r[1] < by + bh && r[1] + r[3] > by;
  return overlaps && r[2] * r[3] <= (bw * bh * 4) + 40_000;
}

/**
 * Wait until the app will take the message: its Send button reports
 * enabled. The box is read every few hundred milliseconds for at most
 * `limitMs`, and the gate is asked every time, so pause and stop reach a
 * wait for a slow upload the way they reach anything else.
 *
 * `wasEnabled`: Send was already enabled before the picture went in — an
 * app that never disables it for an empty box. Then "enabled" proves
 * nothing straight away, so it is watched a moment for the upload to
 * disable it, and waited for again if it does.
 *
 * An app that names none of its buttons cannot say when it is ready: it is
 * given a moment, and the send is judged from the box afterwards. Send
 * still disabled at the end — or never there at all, in an app whose
 * buttons can be read — means the picture is still uploading or never
 * arrived. Nothing is sent then, and what is in the box is left for the
 * person, rather than a message going without the picture it was about.
 *
 * @returns {Promise<{ ok: boolean, box?: object, why?: string, stopped?: boolean, by?: string }>}
 */
async function readyToSend({ reread, gate, onLive = () => {}, wasEnabled = false, limitMs = UPLOAD_MS }) {
  const t0 = Date.now();
  let named = false;          // has the app named any of the box's buttons yet?
  let box = null;
  for (;;) {
    if (!(await gate())) return { ok: false, stopped: true };
    box = (await reread()) ?? box;
    if (box?.buttons?.length) named = true;
    const enabled = Boolean(box?.send) && box.send.enabled !== false;
    const waited = Date.now() - t0;
    if (enabled && (!wasEnabled || waited >= SETTLE_MS)) return { ok: true, box, by: 'send-enabled' };
    if (!named && waited >= QUIET_APP_MS) return { ok: true, box, by: 'unsaid' };
    if (waited >= limitMs) {
      return {
        ok: false,
        box,
        why: box?.send
          ? `the picture was still uploading after ${Math.round(limitMs / 1000)} seconds, so it was not sent`
          : 'the picture did not show up in the message box, so nothing was sent',
      };
    }
    onLive(`Waiting for the picture to upload · ${Math.round(waited / 1000)}s`);
    await sleep(350);
  }
}

/**
 * Put `text` in the chat box and send it — after `picture`, when there is
 * one: a data URL, pasted into the box as a picture first. Either may be
 * left out; a picture with no words is sent on its own.
 *
 * @returns {{ ok: boolean, why?: string, box?: object, asked?: boolean }}
 */
export async function send({ computer, sense, hwnd, text = '', picture = null, toMouse, gate = async () => true, onLive = () => {}, confirmDraft = null, busyMs = 300_000, uploadMs = UPLOAD_MS }) {
  const words = String(text ?? '');
  if (!(await bringForward(computer, sense, hwnd))) {
    return { ok: false, why: 'the window would not come to the front' };
  }
  let box = await findBox(sense, hwnd);
  const byClick = !box;
  if (!box) box = await boxByClicking({ computer, sense, hwnd, toMouse });
  if (!box) return { ok: false, why: 'I could not find the message box in that window' };
  /* Read again the way it was found: by hit test, or — for a box only a
     click could find — by what holds the caret. */
  const reread = async () => (await readBox(sense, hwnd)) ?? (byClick ? await focusBox(sense) : null);
  if (!(await gate())) return { ok: false, stopped: true };

  /* Still writing its last answer: an app takes no new message then —
     ChatGPT keeps the words in the box and sends nothing, and the list
     stopped on a message that "did not send". Waited out here instead. It
     only happens when the last answer was not waited for: a list sent
     without waiting, an answer skipped, or a chat the person left going. */
  if (box.stop) {
    onLive('Waiting for the last answer to finish');
    const until = Date.now() + busyMs;
    while (box.stop && Date.now() < until) {
      await sleep(650);
      if (!(await gate())) return { ok: false, stopped: true };
      box = (await reread()) ?? box;
    }
    if (box.stop) return { ok: false, why: 'the app was still writing its last answer' };
  }

  /* A box that already has something in it. On the first item that is the
     person's own draft, and it is theirs to keep or throw away; on a later
     item it is what the last one left behind, which must not be sent in
     front of this one. */
  const leftover = box.value !== null && flat(box.value).length > 0 && flat(box.value) !== flat(box.name);
  if (leftover && confirmDraft) {
    const keep = await confirmDraft(box.value);
    if (keep === false) return { ok: false, why: 'the message box already had something in it, so I left it alone', declined: true };
  }

  // Click where the words go: inside the box, left of centre, on its first
  // line — clear of any buttons that sit inside the box itself.
  const [x, y, w, h] = box.rect;
  const px = x + Math.max(14, Math.min(w * 0.3, w - 90));
  const py = y + Math.min(h / 2, 22);
  const at = toMouse(px, py);
  onLive('Clicking the message box');
  await computer.click(at.x, at.y);
  await sleep(90);
  if ((await caretIn(sense, box)) === false) {
    const mid = toMouse(x + (w / 2), y + (h / 2));
    await computer.click(mid.x, mid.y);
    await sleep(120);
  }
  if (!(await gate())) return { ok: false, stopped: true };

  if (leftover) {
    await computer.keypress(['ctrl', 'a']);
    await sleep(40);
    await computer.keypress(['backspace']);
    await sleep(60);
  }

  /* The picture first, the way a person adds one: pasted where the caret
     is, as a picture. If it cannot be put on the clipboard, nothing is
     pasted at all — ctrl+v would paste the person's own last copy instead —
     and nothing is sent. Then the upload is waited out, before any words
     go in: an empty box whose Send comes on is the app saying it has the
     picture, which a box with words in it could not say. */
  if (picture) {
    const pre = (await reread()) ?? box;
    const wasEnabled = Boolean(pre.send) && pre.send.enabled !== false;
    onLive('Pasting the picture');
    const put = await Promise.resolve().then(() => computer.writeClipboardImage?.(picture)).catch(() => false);
    if (!put) return { ok: false, why: 'the picture could not be put on the clipboard, so nothing was pasted' };
    if (!(await gate())) return { ok: false, stopped: true };
    await sleep(60);
    await computer.keypress(['ctrl', 'v']);
    await sleep(250);
    const ready = await readyToSend({ reread, gate, onLive, wasEnabled, limitMs: uploadMs });
    if (ready.stopped) return { ok: false, stopped: true };
    if (!ready.ok) return { ok: false, why: ready.why };
    box = ready.box ?? box;
  }

  const head = flat(words).slice(0, 36);
  if (words) {
    onLive(picture ? 'Pasting the words to go with it' : 'Pasting');
    const put = await computer.writeClipboard(words);
    if (!put) return { ok: false, why: 'the clipboard could not be set' };
    await sleep(40);
    await computer.keypress(['ctrl', 'v']);
    await sleep(220);

    /* In the box? Checked against the start of the text, which is what a
       box reports first — a long paste is cut short in the report, not in
       the box. An app that says nothing about its value is taken on trust
       here and checked properly once it is sent. */
    box = (await reread()) ?? box;
    if (box.value !== null && head && !flat(box.value).includes(head.slice(0, 24))) {
      await sleep(250);
      box = (await reread()) ?? box;
      if (box.value !== null && !flat(box.value).includes(head.slice(0, 24))) {
        // Once more, from the click: focus may have gone somewhere on the way.
        await computer.click(at.x, at.y);
        await sleep(90);
        await computer.keypress(['ctrl', 'a']);
        await computer.keypress(['ctrl', 'v']);
        await sleep(260);
        box = (await reread()) ?? box;
        if (box.value !== null && !flat(box.value).includes(head.slice(0, 24))) {
          return { ok: false, why: 'the text did not arrive in the message box' };
        }
      }
    }
  }
  if (!(await gate())) return { ok: false, stopped: true };

  /* Words pasted after a picture can find the app still busy with it, or
     busy again: Send is looked at once more, and waited for if it is off. */
  if (picture) {
    const now = (await reread()) ?? box;
    if (now.send && now.send.enabled === false) {
      const ready = await readyToSend({ reread, gate, onLive, limitMs: uploadMs });
      if (ready.stopped) return { ok: false, stopped: true };
      if (!ready.ok) return { ok: false, why: ready.why };
    }
  }

  onLive('Sending');
  await computer.keypress(['enter']);
  const sentBy = await sentYet(reread, head, { picture: Boolean(picture) });
  if (sentBy) return { ok: true, box, by: sentBy };

  // Enter makes a new line in some apps. Their send button does not.
  const now = (await reread()) ?? box;
  if (now.send && now.send.enabled !== false && Array.isArray(now.send.rect)) {
    const [sx, sy, sw, sh] = now.send.rect;
    const s = toMouse(sx + (sw / 2), sy + (sh / 2));
    await computer.click(s.x, s.y);
    const again = await sentYet(reread, head, { picture: Boolean(picture) });
    if (again) return { ok: true, box: now, by: again };
  }
  return { ok: false, why: 'the message did not send' };
}

/** Did it go? The box emptied, or a stop button appeared. A picture sent on
    its own leaves no words to watch leave the box; what goes instead is
    Send, which was only there, enabled, because the picture was. An app
    that names no buttons and keeps no words says nothing either way, and
    is taken on trust, as one that keeps its value to itself always was. */
async function sentYet(reread, head, { picture = false } = {}) {
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 260 : 220);
    const box = await reread();
    if (!box) continue;                       // the page redrawing under a new chat
    if (box.stop) return 'stop';
    if (head && box.value !== null && !flat(box.value).includes(head.slice(0, 24))) return 'emptied';
    if (!head && picture && box.buttons.length && !(box.send && box.send.enabled !== false)) return 'cleared';
    if ((box.value === null || (!head && !box.buttons.length)) && i >= 2) return 'assumed';
  }
  return null;
}

/**
 * Wait until the app has finished answering: its stop button has come and
 * gone, or — for an app that has none — the window has gone still.
 *
 * @returns {{ ok: boolean, ms: number, by?: string, timedOut?: boolean, stopped?: boolean }}
 */
export async function waitForAnswer({ computer, sense, hwnd, gate = async () => true, onLive = () => {}, timeoutMs = 300_000, settleMs = 1600, skip = () => false }) {
  const t0 = Date.now();
  let sawStop = false;
  let clearSince = null;
  let lastGrey = null;
  let stillSince = null;
  let changed = false;
  let polls = 0;
  for (;;) {
    const ms = Date.now() - t0;
    if (ms > timeoutMs) return { ok: false, ms, timedOut: true };
    if (!(await gate())) return { ok: false, ms, stopped: true };
    // The person said to move on: the answer is theirs to judge, not this.
    if (skip()) return { ok: true, ms, skipped: true };

    const box = await readBox(sense, hwnd);
    const writing = Boolean(box?.stop);
    if (writing) { sawStop = true; clearSince = null; } else if (box && clearSince === null) clearSince = Date.now();

    /* The picture as a second witness, every other poll: a coarse grey
       thumbnail of the display, compared with the last one. An app with no
       stop button to watch is judged by this alone. */
    if (polls % 2 === 0) {
      const shot = await Promise.resolve().then(() => computer.capture()).catch(() => null);
      if (shot?.grey && lastGrey) {
        const moved = greyDiff(shot.grey, lastGrey) > 0.9;
        if (moved) { changed = true; stillSince = null; } else if (stillSince === null) stillSince = Date.now();
      }
      if (shot?.grey) lastGrey = shot.grey;
    }
    polls += 1;

    const secs = Math.round(ms / 1000);
    onLive(writing ? `Waiting for it to finish · ${secs}s` : sawStop ? 'Finishing up' : `Waiting for an answer · ${secs}s`);

    // It was writing, and now it has stopped for long enough to trust.
    if (sawStop && !writing && clearSince !== null && Date.now() - clearSince >= settleMs) {
      return { ok: true, ms, by: 'stop-button' };
    }
    // It never showed a stop button: go by the screen going still after it moved.
    if (!sawStop && ms > 6000 && changed && stillSince !== null && Date.now() - stillSince >= 3500) {
      return { ok: true, ms, by: 'screen-still' };
    }
    // Nothing moved at all for a long while: nothing is coming.
    if (!sawStop && !changed && ms > 20_000) return { ok: true, ms, by: 'nothing-happened' };
    await sleep(650);
  }
}

/** Mean absolute difference of two grey thumbnails, 0–255. */
function greyDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
