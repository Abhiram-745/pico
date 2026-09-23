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
                     for an app where Enter is a new line)
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
 * Put `text` in the chat box and send it.
 *
 * @returns {{ ok: boolean, why?: string, box?: object, asked?: boolean }}
 */
export async function send({ computer, sense, hwnd, text, toMouse, gate = async () => true, onLive = () => {}, confirmDraft = null }) {
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

  onLive('Pasting');
  const put = await computer.writeClipboard(text);
  if (!put) return { ok: false, why: 'the clipboard could not be set' };
  await sleep(40);
  await computer.keypress(['ctrl', 'v']);
  await sleep(220);

  /* In the box? Checked against the start of the text, which is what a
     box reports first — a long paste is cut short in the report, not in the
     box. An app that says nothing about its value is taken on trust here
     and checked properly once it is sent. */
  const head = flat(text).slice(0, 36);
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
  if (!(await gate())) return { ok: false, stopped: true };

  onLive('Sending');
  await computer.keypress(['enter']);
  const sentBy = await sentYet(reread, head);
  if (sentBy) return { ok: true, box, by: sentBy };

  // Enter makes a new line in some apps. Their send button does not.
  const now = (await reread()) ?? box;
  if (now.send && now.send.enabled !== false && Array.isArray(now.send.rect)) {
    const [sx, sy, sw, sh] = now.send.rect;
    const s = toMouse(sx + (sw / 2), sy + (sh / 2));
    await computer.click(s.x, s.y);
    const again = await sentYet(reread, head);
    if (again) return { ok: true, box: now, by: again };
  }
  return { ok: false, why: 'the message did not send' };
}

/** Did it go? The box emptied, or a stop button appeared. */
async function sentYet(reread, head) {
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 260 : 220);
    const box = await reread();
    if (!box) continue;                       // the page redrawing under a new chat
    if (box.stop) return 'stop';
    if (box.value !== null && !flat(box.value).includes(head.slice(0, 24))) return 'emptied';
    if (box.value === null && i >= 2) return 'assumed';
  }
  return null;
}

/**
 * Wait until the app has finished answering: its stop button has come and
 * gone, or — for an app that has none — the window has gone still.
 *
 * @returns {{ ok: boolean, ms: number, by?: string, timedOut?: boolean, stopped?: boolean }}
 */
export async function waitForAnswer({ computer, sense, hwnd, gate = async () => true, onLive = () => {}, timeoutMs = 300_000, settleMs = 1600 }) {
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
