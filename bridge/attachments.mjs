/* ==========================================================================
   Halo — attachments: pasted text, files and pictures sent with a message.

   Kept apart from server.mjs, with no side effects and nothing imported from
   it, so this can be imported on its own — by a test, or by anything else in
   the bridge — without also pulling in the server's own startup: building
   the interface, binding the real port, loading the real mouse and
   keyboard, opening a window. server.mjs merely imports validateAttachments,
   attachmentEcho and prepareSubmitTask from here; nothing below knows the
   bridge exists.

   Shape of one attachment, as it arrives from the UI's submitTask:
     { id, name, kind: 'image'|'text', mime, size, text?, dataUrl?, thumb? }
   kind 'text'  — text holds the full contents, capped at 200,000 chars.
   kind 'image' — dataUrl is a data:image/(png|jpeg|webp|gif);base64,... URL,
                  already downscaled by the browser to at most 2048px on its
                  longest side; thumb is a JPEG data URL of at most 320px,
                  for display only.
   At most 6 attachments per message, and the whole payload at most 20MB
   decoded (MAX_PAYLOAD_BYTES in pico-ui/src/attachments.js) — the outer
   bound on that is ws.mjs's own 32MB frame-size limit, which the base64 of
   20MB still fits inside.

   Tested directly by scripts/test-attachments.mjs.
   ========================================================================== */

import { randomBytes } from 'node:crypto';

// submitTask used to share the same 2000-char cap as answerQuestion (see
// MAX_ANSWER_LENGTH in server.mjs), and hit it silently: a pasted table of
// twenty image prompts, or a few paragraphs of instructions, lost everything
// past the first screenful with nothing on screen to say so — the bug this
// file exists to fix. 100,000 chars is comfortably past anything anyone
// pastes by hand, while still refusing a message built to exhaust memory.
export const MAX_SUBMIT_TEXT_LENGTH = 100_000;

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_NAME = 120;
export const MAX_TEXT_ATTACHMENT_CHARS = 200_000;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_THUMB_LENGTH = 60 * 1024;
const ATTACHMENT_ID_RE = /^[\w-]{1,48}$/;
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;

let attachmentSeq = 0;
/** An id for an attachment that arrived without one, or with an invalid one. */
function makeAttachmentId() {
  attachmentSeq = (attachmentSeq + 1) % 1_000_000;
  return `att_${Date.now().toString(36)}${attachmentSeq.toString(36)}${randomBytes(2).toString('hex')}`;
}

/** The byte length of a base64 data URL's decoded payload, without decoding it. */
function decodedByteLength(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return Infinity;                // not shaped like a data URL at all
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * The attachments array from a submitTask payload, trusted no further than
 * any other message off the wire. Anything that does not match the contract
 * is dropped — never passed to the model, never written to disk — and
 * logged once, so a client sending the wrong shape is visible in the console
 * rather than silently short a picture or a document.
 *
 * @param {unknown} list
 * @returns {Array<object>} at most MAX_ATTACHMENTS validated attachments
 */
export function validateAttachments(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_ATTACHMENTS) {
    console.warn(`[bridge] dropped ${list.length - MAX_ATTACHMENTS} attachment(s) past the limit of ${MAX_ATTACHMENTS}`);
  }
  const out = [];
  for (const raw of list.slice(0, MAX_ATTACHMENTS)) {
    if (!raw || typeof raw !== 'object') {
      console.warn('[bridge] dropped an attachment: not an object');
      continue;
    }
    const kind = raw.kind === 'image' || raw.kind === 'text' ? raw.kind : null;
    if (!kind) {
      console.warn(`[bridge] dropped an attachment: kind must be "image" or "text", got ${JSON.stringify(raw.kind)}`);
      continue;
    }
    const name = String(raw.name ?? '').slice(0, MAX_ATTACHMENT_NAME) || (kind === 'image' ? 'Image' : 'Pasted text');
    if (raw.mime == null || raw.size == null) {
      console.warn(`[bridge] dropped attachment "${name}": missing mime or size`);
      continue;
    }
    const id = typeof raw.id === 'string' && ATTACHMENT_ID_RE.test(raw.id) ? raw.id : makeAttachmentId();
    const base = { id, name, kind, mime: String(raw.mime), size: Number(raw.size) || 0 };

    if (kind === 'text') {
      if (typeof raw.text !== 'string') {
        console.warn(`[bridge] dropped text attachment "${name}": no text`);
        continue;
      }
      out.push({ ...base, text: raw.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) });
      continue;
    }

    // kind === 'image'
    if (typeof raw.dataUrl !== 'string' || !IMAGE_DATA_URL_RE.test(raw.dataUrl)) {
      console.warn(`[bridge] dropped image attachment "${name}": not a png/jpeg/webp/gif data URL`);
      continue;
    }
    if (decodedByteLength(raw.dataUrl) > MAX_IMAGE_ATTACHMENT_BYTES) {
      console.warn(`[bridge] dropped image attachment "${name}": over 8MB decoded`);
      continue;
    }
    const entry = { ...base, dataUrl: raw.dataUrl };
    if (typeof raw.thumb === 'string' && raw.thumb.startsWith('data:image/')) entry.thumb = raw.thumb;
    out.push(entry);
  }
  return out;
}

/**
 * What a validated attachment becomes once it is shown in the thread or
 * written to the chat archive: enough to display a bubble, never enough to
 * reconstruct the picture or the pasted document. Those go to the model
 * alone (see HostAgent.run in agent.mjs), never to disk or a second window.
 */
export function attachmentEcho(a) {
  const out = { id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size };
  if (a.kind === 'image') {
    if (typeof a.thumb === 'string' && a.thumb.startsWith('data:image/') && a.thumb.length <= MAX_THUMB_LENGTH) {
      out.thumb = a.thumb;
    }
  } else if (a.kind === 'text') {
    const text = String(a.text ?? '');
    out.chars = text.length;
    out.preview = text.slice(0, 240);
  }
  return out;
}

/**
 * A raw submitTask payload, turned into what the rest of the bridge acts on
 * — capped, trimmed text and validated attachments — or null when there is
 * truly nothing to do: no words, and nothing attached either. Text alone
 * used to be the only way to say something; a message can now be just a
 * picture or a pasted document, so emptiness is judged on both together.
 *
 * @param {object} payload
 * @returns {{text: string, attachments: Array<object>, mode: string}|null}
 */
export function prepareSubmitTask(payload = {}) {
  const text = String(payload?.text ?? '').slice(0, MAX_SUBMIT_TEXT_LENGTH).trim();
  const attachments = validateAttachments(payload?.attachments);
  if (!text && !attachments.length) return null;
  const mode = ['auto', 'chat', 'agent'].includes(payload?.mode) ? payload.mode : 'auto';
  return { text, attachments, mode };
}
