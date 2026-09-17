/* ==========================================================================
   Halo — chats, for every window

   The one place the interface starts, opens, renames, deletes and searches
   conversations. The island and the app window both come here, so there is
   one answer to "which chat is this" and one list of the ones before it.

   WHERE THEY ARE KEPT
   With the bridge, in %LOCALAPPDATA%\Halo\chats.json (bridge/chats.mjs).

   They used to be kept by the island alone, in its own browser storage, and
   that could never have been shared: the island runs in a private browser
   profile and the app window in your everyday one, so each had storage the
   other could not see. The bridge relays every message anyway, so it keeps
   them, and every window — the phone too — reads the same history.

   Chats the island saved for itself before this are sent to the bridge the
   first time it connects, once, and then removed from the island's storage.

   WITHOUT A BRIDGE
   The hosted preview has no bridge, so there the chats are kept in this
   page's own storage, with the same shape and the same calls. Nothing above
   this file needs to know which.

   WHAT IS NEVER WRITTEN HERE
   Messages, and nothing else. No screenshots, no coordinates, no typed
   passwords — the host redacts those before the UI ever sees them and this
   must not be the thing that quietly puts them back.
   ========================================================================== */

import { store } from './store.js';
import { bridge } from './bridge.js';

const LEGACY_KEY = 'halo.chats.v1';          // what the island kept for itself
const LOCAL_KEY = 'halo.chats.preview.v1';    // the bridgeless preview's own copy
const MAX_CHATS = 60;

const now = () => Date.now();
const newId = () => `c_${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function titleFor(messages) {
  const first = messages.find((m) => m.from === 'you' && tidy(m.text));
  if (!first) return 'New chat';
  const t = tidy(first.text);
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

const read = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

/* --------------------------------------------------------------------------
   The preview's stand-in for bridge/chats.mjs. Same calls, same list shape.
   -------------------------------------------------------------------------- */
class LocalArchive {
  constructor() {
    const data = read(LOCAL_KEY);
    this.chats = Array.isArray(data?.chats) ? data.chats : [];
    this.current = typeof data?.current === 'string' ? data.current : null;
    this.timer = null;
  }

  save() { write(LOCAL_KEY, { current: this.current, chats: this.chats.slice(0, MAX_CHATS) }); }

  list() {
    return this.chats
      .filter((c) => c.messages?.length)
      .sort((a, b) => b.updated - a.updated)
      .map((c) => ({
        id: c.id,
        title: c.title || 'New chat',
        updated: c.updated,
        count: c.messages.length,
        preview: tidy([...c.messages].reverse().find((m) => m.from !== 'event')?.text).slice(0, 90),
      }));
  }

  record(messages) {
    if (!messages.length) return;
    let chat = this.chats.find((c) => c.id === this.current);
    if (!chat) {
      chat = { id: newId(), title: '', named: false, updated: now(), messages: [] };
      this.current = chat.id;
      this.chats.push(chat);
    }
    chat.messages = messages.map(({ id, from, text, memoryId }) => ({ id, from, text: String(text ?? ''), done: true, ...(memoryId ? { memoryId } : {}) }));
    if (!chat.named) chat.title = titleFor(chat.messages);
    chat.updated = now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 400);
  }

  search(q) {
    const words = tidy(q).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) return this.list();
    return this.list().filter((c) => {
      const chat = this.chats.find((x) => x.id === c.id);
      const hay = `${chat.title}\n${chat.messages.map((m) => m.text).join('\n')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
}

class Chats {
  constructor() {
    this.mode = null;
    this.local = null;
    this._unsubscribe = null;
  }

  /**
   * Called once by each page, with how it is connected.
   * `mode` is what connect() in bridge.js returned.
   */
  attach({ mode }) {
    if (this.mode) return this;
    this.mode = mode;

    if (mode === 'mock') {
      this.local = new LocalArchive();
      store.setChats({ list: this.local.list(), current: this.local.current });
      const open = this.local.chats.find((c) => c.id === this.local.current);
      if (open?.messages?.length) store.loadMessages(open.messages);
      this._unsubscribe = store.subscribe((s, meta) => {
        if (meta.type !== 'message' || meta.restored) return;
        this.local.record(s.messages);
        store.setChats({ list: this.local.list(), current: this.local.current });
      });
      return this;
    }

    // With a bridge: send anything this window kept for itself across, once.
    const legacy = read(LEGACY_KEY);
    if (Array.isArray(legacy?.chats) && legacy.chats.length) {
      bridge.send('chatsImport', { chats: legacy.chats });
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* it will be offered again, and merged by id */ }
    }
    return this;
  }

  get list() { return store.state.chats.list; }
  get currentId() { return store.state.chats.current; }

  /** Start again: this window clears at once, and the bridge tells the rest. */
  newChat() {
    store.clearMessages();
    store.setQuestion(null);
    store.setApproval(null);
    store.setTakeover(null);
    store.setPlan(null);
    store.setLastRun(null);
    if (this.local) {
      this.local.current = null;
      this.local.save();
      store.setChats({ list: this.local.list(), current: null });
    }
    bridge.send('newChat');
  }

  /** Reopen an earlier chat, in every window. */
  open(id) {
    if (this.local) {
      const chat = this.local.chats.find((c) => c.id === id);
      if (!chat) return;
      this.local.current = id;
      this.local.save();
      store.setPlan(null);
      store.loadMessages(chat.messages);
      store.setChats({ list: this.local.list(), current: id });
      bridge.send('newChat', { resume: chat.messages.map((m) => ({ from: m.from, text: m.text })) });
      return;
    }
    // The bridge answers with chatOpened, to every window at once; clearing
    // here first would flash an empty thread for no reason.
    bridge.send('openChat', { id });
  }

  rename(id, title) {
    if (this.local) {
      const chat = this.local.chats.find((c) => c.id === id);
      if (!chat) return;
      chat.named = Boolean(tidy(title));
      chat.title = tidy(title) || titleFor(chat.messages);
      this.local.save();
      store.setChats({ list: this.local.list(), current: this.local.current });
      return;
    }
    bridge.send('chatRename', { id, title });
  }

  remove(id) {
    if (this.local) {
      const wasCurrent = this.local.current === id;
      this.local.chats = this.local.chats.filter((c) => c.id !== id);
      if (wasCurrent) { this.local.current = null; store.clearMessages(); }
      this.local.save();
      store.setChats({ list: this.local.list(), current: this.local.current });
      return;
    }
    bridge.send('chatDelete', { id });
  }

  /** Results arrive in store.state.chatSearch. An empty query clears them. */
  search(q) {
    const query = tidy(q);
    if (!query) { store.setChatSearch(null); return; }
    if (this.local) { store.setChatSearch({ q: query, results: this.local.search(query) }); return; }
    bridge.send('chatSearch', { q: query });
  }
}

export const chats = new Chats();
