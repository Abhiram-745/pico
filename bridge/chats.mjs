/* ==========================================================================
   Halo — every conversation, kept on this machine, for every window.

   Chats used to be saved by the island alone, in its browser's storage. The
   island runs in a private browser profile of its own, and the app window
   in the person's everyday browser, so the two could never have shared that
   storage even in principle: the app window had no history at all, and a
   phone never would.

   The bridge sees every message anyway — it is what relays them — so it
   keeps the archive, in %LOCALAPPDATA%\Halo\chats.json, and every window
   reads the same one. pico-ui/src/chats.js is the other half: the one place
   the interface asks for the list, opens, renames, deletes and searches.

   WHAT IS KEPT
   What was said, by whom, and when. Never screenshots or coordinates; the
   thread never carried them and this must not be where they start.
   ========================================================================== */

import { randomBytes } from 'node:crypto';
import { readJson, debouncedWriter } from './home.mjs';

const FILE = 'chats.json';
const MAX_CHATS = 200;
const MAX_MESSAGES = 200;

const newId = () => `c_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The first thing the person said, which is what a chat is about. */
function titleFor(messages) {
  const first = messages.find((m) => m.from === 'you' && tidy(m.text));
  if (!first) return 'New chat';
  const t = tidy(first.text);
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/* Only the fields a message is. Anything else hung on one is not part of the
   conversation. `memoryId` rides along so a "Remembered …" line reopened
   later can still offer to forget what it remembered. */
const clean = (m) => {
  const out = { id: String(m.id), from: m.from, text: String(m.text ?? ''), done: m.done !== false, at: m.at ?? Date.now() };
  if (m.memoryId) out.memoryId = String(m.memoryId);
  /* What was attached, as the thread shows it — a name, a size, a small
     thumbnail or the first lines — so a chat reopened later still shows the
     chip a message was sent with, and a message that was only a picture is
     not an empty bubble. Only that shape (attachmentEcho in
     attachments.mjs): the picture itself and the whole of a pasted text went
     to the model once and are never written down. */
  if (Array.isArray(m.attachments) && m.attachments.length) {
    out.attachments = m.attachments.slice(0, 6).filter((a) => a && typeof a === 'object').map((a) => {
      const kept = { id: String(a.id ?? ''), name: String(a.name ?? '').slice(0, 120), kind: a.kind === 'image' ? 'image' : 'text', mime: String(a.mime ?? ''), size: Number(a.size) || 0 };
      if (kept.kind === 'image' && typeof a.thumb === 'string' && a.thumb.startsWith('data:image/') && a.thumb.length <= 60 * 1024) kept.thumb = a.thumb;
      if (kept.kind === 'text') {
        if (Number.isFinite(a.chars)) kept.chars = a.chars;
        if (typeof a.preview === 'string') kept.preview = a.preview.slice(0, 240);
      }
      return kept;
    });
  }
  return out;
};

class ChatArchive {
  constructor() {
    this.chats = [];
    this.currentId = null;
    this.loaded = false;
    this.writer = debouncedWriter(FILE, 600);
  }

  load() {
    if (this.loaded) return this;
    const data = readJson(FILE, null);
    this.chats = (Array.isArray(data?.chats) ? data.chats : [])
      .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages));
    this.currentId = typeof data?.current === 'string' && this.chats.some((c) => c.id === data.current)
      ? data.current
      : null;
    this.loaded = true;
    return this;
  }

  _persist() {
    this.writer.write({ current: this.currentId, chats: this.chats });
  }

  flush() { this.writer.flush(); }

  get current() {
    this.load();
    return this.chats.find((c) => c.id === this.currentId) ?? null;
  }

  /** The thread that was open when Halo last stopped, finished. */
  restore() {
    return (this.current?.messages ?? []).map((m) => ({ ...m, done: true }));
  }

  /**
   * A message arrived or changed. Streamed replies land many times under one
   * id, so this replaces in place rather than appending.
   * Returns true when the list of chats itself changed (a new chat, a new
   * title), which is when the interface's menu needs telling.
   */
  record(message) {
    this.load();
    if (!message?.id || !message.from) return false;
    let listChanged = false;
    let chat = this.current;
    if (!chat) {
      // An empty reply placeholder does not start a chat on its own.
      if (!tidy(message.text) && message.from !== 'you') return false;
      chat = { id: this.currentId ?? newId(), title: '', named: false, created: Date.now(), updated: Date.now(), messages: [] };
      this.currentId = chat.id;
      this.chats.push(chat);
      listChanged = true;
    }
    const entry = clean(message);
    const i = chat.messages.findIndex((m) => m.id === entry.id);
    if (i === -1) {
      chat.messages.push(entry);
      if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
      listChanged = true;
    } else {
      chat.messages[i] = { ...entry, at: chat.messages[i].at };
    }
    if (!chat.named) {
      const title = titleFor(chat.messages);
      if (title !== chat.title) { chat.title = title; listChanged = true; }
    }
    chat.updated = Date.now();
    if (this.chats.length > MAX_CHATS) {
      this.chats.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
      this.chats.length = MAX_CHATS;
      listChanged = true;
    }
    this._persist();
    return listChanged;
  }

  /** Start again. The chat is only written down once something is said in it. */
  start() {
    this.load();
    this.currentId = null;
    this._persist();
  }

  /** Make an earlier chat current. Returns its messages, or null. */
  open(id) {
    this.load();
    const chat = this.chats.find((c) => c.id === id);
    if (!chat) return null;
    this.currentId = id;
    this._persist();
    return chat.messages.map((m) => ({ ...m, done: true }));
  }

  rename(id, title) {
    this.load();
    const chat = this.chats.find((c) => c.id === id);
    const clean = tidy(title).slice(0, 80);
    if (!chat) return false;
    // An empty name hands naming back to the chat itself.
    chat.named = Boolean(clean);
    chat.title = clean || titleFor(chat.messages);
    this._persist();
    return true;
  }

  /** Returns whether the chat removed was the one open. */
  remove(id) {
    this.load();
    const wasCurrent = this.currentId === id;
    this.chats = this.chats.filter((c) => c.id !== id);
    if (wasCurrent) this.currentId = null;
    this._persist();
    return wasCurrent;
  }

  /** Newest first, without the messages: what a menu needs. */
  list() {
    this.load();
    return this.chats
      .filter((c) => c.messages.length)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .map((c) => {
        const last = [...c.messages].reverse().find((m) => m.from !== 'event' && tidy(m.text));
        return {
          id: c.id,
          title: c.title || 'New chat',
          updated: c.updated ?? 0,
          count: c.messages.length,
          preview: last ? tidy(last.text).slice(0, 90) : '',
        };
      });
  }

  /**
   * Chats containing every word of the query, in the title or anything said.
   * Each hit carries the line it was found in, so a result explains itself.
   */
  search(query, limit = 30) {
    this.load();
    const words = tidy(query).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) return this.list().slice(0, limit);
    const hits = [];
    for (const c of this.chats) {
      if (!c.messages.length) continue;
      const hay = `${c.title}\n${c.messages.map((m) => m.text).join('\n')}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const line = c.messages.find((m) => words.some((w) => String(m.text).toLowerCase().includes(w)));
      let snippet = '';
      if (line) {
        const text = tidy(line.text);
        const at = Math.max(0, text.toLowerCase().indexOf(words.find((w) => text.toLowerCase().includes(w))) - 30);
        snippet = `${at > 0 ? '…' : ''}${text.slice(at, at + 100)}${text.length > at + 100 ? '…' : ''}`;
      }
      hits.push({ id: c.id, title: c.title || 'New chat', updated: c.updated ?? 0, count: c.messages.length, preview: snippet });
    }
    return hits.sort((a, b) => b.updated - a.updated).slice(0, limit);
  }

  /**
   * Chats a window saved for itself before the archive lived here. Merged by
   * id, so importing the same island twice changes nothing.
   */
  importFrom(list) {
    this.load();
    let added = 0;
    for (const c of Array.isArray(list) ? list.slice(0, MAX_CHATS) : []) {
      if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages) || !c.messages.length) continue;
      if (this.chats.some((x) => x.id === c.id)) continue;
      const messages = c.messages
        .filter((m) => m && m.id && ['you', 'pico', 'event'].includes(m.from))
        .slice(-MAX_MESSAGES)
        .map((m) => ({ ...clean(m), done: true, at: c.updated ?? Date.now() }));
      if (!messages.length) continue;
      this.chats.push({
        id: c.id,
        title: tidy(c.title) || titleFor(messages),
        named: false,
        created: Number(c.created) || Date.now(),
        updated: Number(c.updated) || Date.now(),
        messages,
      });
      added += 1;
    }
    if (added) this._persist();
    return added;
  }
}

export const chatArchive = new ChatArchive();
export { ChatArchive };
