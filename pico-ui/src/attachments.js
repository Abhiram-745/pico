/* ==========================================================================
   Halo — attachments

   Everything that turns a File, a clipboard paste or a big block of pasted
   text into the attachment shape the bridge contract expects, and back down
   into the small shape the thread keeps.

   THE THREE SHAPES
   A "full" attachment is what goes to the host in submitTask: it carries the
   whole picture (dataUrl) or the whole text (text), and is only ever kept in
   memory for as long as the composer is holding it — never written to the
   store.

   A "display" attachment is what the thread keeps, forever, in every message:
   for an image, only `thumb` (a small JPEG); for text, only `chars` and a
   ~240-character `preview`. The point is that the conversation history never
   grows a copy of every picture and file ever sent — see chats.js and
   store.js, which persist exactly this trimmed shape.

   A "bridge" attachment is the full shape trimmed to exactly the fields
   submitTask is documented to accept, so the composer's own bookkeeping
   (chars/lines/preview, kept for the chip UI) never leaks into the payload.

   WHY IMAGES ARE DOWNSCALED HERE, IN THE BROWSER
   The alternative is sending the original file and asking the host to
   resize it, which means a multi-megabyte upload for a screenshot before
   anyone finds out whether it was even usable. Canvas can do this in a few
   milliseconds and the composer can show the *real* thumbnail immediately.
   ========================================================================== */

/** How many attachments one message may carry, and how heavy the whole
    submitTask payload (every dataUrl and every text, added up) may be.
    Counted in decoded bytes, and the wire carries pictures as base64 — a
    third bigger — inside one WebSocket frame that bridge/ws.mjs refuses past
    32MB by closing the connection. 20MB decoded is about 27MB sent, which
    leaves room for the JSON around it; any more and the send that failed
    would also cut the window off from the bridge. */
export const MAX_ATTACHMENTS = 6;
export const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

/** Text attachments: the file itself, and the text kept once read. */
export const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;

/** A paste bigger than this becomes an attachment instead of landing in the box. */
export const PASTE_CHAR_THRESHOLD = 1500;
export const PASTE_LINE_THRESHOLD = 25;

/** Images: downscaled so the longest side is at most this, JPEG unless the
    original was a PNG small enough to keep as one. */
export const IMAGE_MAX_SIDE = 2048;
export const IMAGE_PNG_KEEP_BYTES = 1.5 * 1024 * 1024;
export const IMAGE_JPEG_QUALITY = 0.85;

/** The thread's own thumbnail: small enough to keep in every message forever. */
export const THUMB_MAX_SIDE = 320;
export const THUMB_JPEG_QUALITY = 0.82;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'yaml', 'yml',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sql',
]);

const makeId = () => `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 'image' | 'text' | null — null means Halo has no reader for this file yet. */
export function classifyFile(file) {
  const ext = extOf(file?.name);
  const mime = String(file?.type || '').toLowerCase();
  if (IMAGE_EXTS.has(ext) || IMAGE_MIMES.has(mime)) return 'image';
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/')) return 'text';
  return null;
}

/** The line the composer shows for a file Halo cannot read yet. */
export function unsupportedNote(file) {
  const ext = extOf(file?.name);
  return ext
    ? `Halo can't read .${ext} files yet — paste the text instead.`
    : `Halo can't read that file yet — paste the text instead.`;
}

export function countLines(text) {
  if (!text) return 0;
  return String(text).split(/\r\n|\r|\n/).length;
}

export function byteLengthOf(text) {
  try { return new TextEncoder().encode(String(text ?? '')).length; } catch { return String(text ?? '').length; }
}

/** Rough decoded size of a data URL, for the payload budget. */
function dataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const i = dataUrl.indexOf(',');
  if (i === -1) return 0;
  return Math.round(((dataUrl.length - i - 1) * 3) / 4);
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How much of the payload budget one already-built attachment spends. */
export function estimateAttachmentBytes(att) {
  if (!att) return 0;
  if (att.kind === 'image') return dataUrlBytes(att.dataUrl) + dataUrlBytes(att.thumb);
  return byteLengthOf(att.text);
}

export function totalPayloadBytes(list) {
  return (list || []).reduce((sum, a) => sum + estimateAttachmentBytes(a), 0);
}

/* --------------------------------------------------------------------------
   Reading files
   -------------------------------------------------------------------------- */
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/** A drawable source for canvas, however this browser can manage it. Loading
    through createImageBitmap decodes off the main thread and — for an
    animated GIF — hands back only the first frame, which is exactly what is
    wanted here; the <img> fallback is for whatever cannot do that. */
async function loadDrawable(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not decode ${file.name}`));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeDrawable(source) {
  if (source && typeof source.close === 'function') source.close();
}

function sizeOf(source) {
  return { w: source.width ?? source.naturalWidth ?? 0, h: source.height ?? source.naturalHeight ?? 0 };
}

function drawScaled(source, w, h, maxSide, mime, quality) {
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, cw, ch);
  return canvas.toDataURL(mime, quality);
}

/**
 * A picture, downscaled to the bridge's contract: the full copy sent up
 * (longest side <= 2048px, JPEG ~q0.85 — or the original PNG, kept whole,
 * only when it already is one and is small enough) and a small JPEG thumb
 * for the thread to keep forever.
 */
export async function buildImageAttachment(file) {
  const source = await loadDrawable(file);
  const { w, h } = sizeOf(source);
  const keepPng = file.type === 'image/png' && file.size <= IMAGE_PNG_KEEP_BYTES;
  const outMime = keepPng ? 'image/png' : 'image/jpeg';
  const dataUrl = drawScaled(source, w, h, IMAGE_MAX_SIDE, outMime, IMAGE_JPEG_QUALITY);
  const thumb = drawScaled(source, w, h, THUMB_MAX_SIDE, 'image/jpeg', THUMB_JPEG_QUALITY);
  closeDrawable(source);
  return {
    id: makeId(),
    name: file.name || 'image',
    kind: 'image',
    mime: outMime,
    size: dataUrlBytes(dataUrl),
    dataUrl,
    thumb,
  };
}

/** A text-like file, read whole and capped at the bridge's own limit. */
export async function buildTextFileAttachment(file) {
  const raw = await readAsText(file);
  const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
  return {
    id: makeId(),
    name: file.name || 'text',
    kind: 'text',
    mime: file.type || 'text/plain',
    size: file.size,
    text,
    chars: text.length,
    lines: countLines(text),
    preview: text.slice(0, 240),
  };
}

/** The flow the user actually hit: paste a huge table, and it becomes an
    attachment named for what it is rather than a wall of text in the box. */
export function buildPastedTextAttachment(text, name = 'Pasted text') {
  const raw = String(text ?? '');
  const capped = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
  return {
    id: makeId(),
    name,
    kind: 'text',
    mime: 'text/plain',
    size: byteLengthOf(capped),
    text: capped,
    chars: capped.length,
    lines: countLines(capped),
    preview: capped.slice(0, 240),
  };
}

/** Whether a paste is big enough that it should become an attachment rather
    than text dropped straight into the box. */
export function shouldAttachPaste(text) {
  if (!text) return false;
  return text.length > PASTE_CHAR_THRESHOLD || countLines(text) > PASTE_LINE_THRESHOLD;
}

/**
 * One File in, one of two outcomes: `{ ok: true, attachment }` for
 * something Halo can read, or `{ ok: false, note }` — a sentence for the
 * composer to show rather than a silent drop.
 */
export async function attachmentFromFile(file) {
  const kind = classifyFile(file);
  if (kind === 'image') return { ok: true, attachment: await buildImageAttachment(file) };
  if (kind === 'text') {
    if (file.size > MAX_TEXT_FILE_BYTES) {
      return { ok: false, note: `${file.name} is over ${formatBytes(MAX_TEXT_FILE_BYTES)} — too big for Halo to read yet.` };
    }
    return { ok: true, attachment: await buildTextFileAttachment(file) };
  }
  return { ok: false, note: unsupportedNote(file) };
}

/* --------------------------------------------------------------------------
   Shrinking a full attachment down for where it is going
   -------------------------------------------------------------------------- */

/** The thread's own copy: never the picture or the whole text, only enough
    to redraw the chip — see the bridge contract in the task brief. */
export function toDisplayAttachment(att) {
  if (att.kind === 'image') {
    return { id: att.id, name: att.name, kind: 'image', mime: att.mime, size: att.size, thumb: att.thumb };
  }
  return { id: att.id, name: att.name, kind: 'text', mime: att.mime, size: att.size, chars: att.chars, preview: att.preview };
}

/** Exactly the fields submitTask documents — the chip's own bookkeeping
    (lines, preview) is a UI convenience and never part of the wire shape. */
export function toBridgeAttachment(att) {
  if (att.kind === 'image') {
    return { id: att.id, name: att.name, kind: 'image', mime: att.mime, size: att.size, dataUrl: att.dataUrl, thumb: att.thumb };
  }
  return { id: att.id, name: att.name, kind: 'text', mime: att.mime, size: att.size, text: att.text };
}
