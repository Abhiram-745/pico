/* ==========================================================================
   Halo — the store, from React.

   The state lives in src/store.js, as it always has, because the phone and
   the palette read it too and neither is React. These hooks subscribe a
   component to one slice of it.

   WHY SLICES
   The store announces every change to everyone, including the pointer's
   position thirty times a second. A component that re-rendered on each of
   those would rebuild the island dozens of times a second while a reply
   streams in. Each hook here returns one field, compared by identity, so a
   component renders only when the thing it shows has actually changed —
   and a streamed reply re-renders one message, not the thread.
   ========================================================================== */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store } from '../src/store.js';

const subscribe = (fn) => store.subscribe((_, meta) => { if (meta.type !== 'cursor') fn(); });

/** One field of the store, re-rendering only when it changes identity. */
export function useStore(select) {
  const pick = useCallback(() => select(store.state), [select]);
  return useSyncExternalStore(subscribe, pick, pick);
}

// Stable selectors, defined once, so subscriptions are not re-made each render.
export const sel = {
  phase: (s) => s.phase,
  messages: (s) => s.messages,
  plan: (s) => s.plan,
  voice: (s) => s.voice,
  voiceShortcut: (s) => s.voiceShortcut,
  action: (s) => s.action,
  step: (s) => s.step,
  question: (s) => s.question,
  approval: (s) => s.approval,
  takeover: (s) => s.takeover,
  guardian: (s) => s.guardian,
  mode: (s) => s.mode,
  memory: (s) => s.memory,
  routines: (s) => s.routines,
  chats: (s) => s.chats,
  chatSearch: (s) => s.chatSearch,
  lastRun: (s) => s.lastRun,
  pause: (s) => s.pause,
  summary: (s) => s.summary,
  error: (s) => s.error,
  routed: (s) => s.routed,
  settings: (s) => s.settings,
  timeline: (s) => s.timeline,
  shell: (s) => s.shell,
  focusChatAt: (s) => s.focusChatAt,
  chord: (s) => s.chord,
  runbook: (s) => s.runbook,
  cursor: (s) => s.cursor,
  notchOpen: (s) => s.notchOpen,
  notchHover: (s) => s.notchHover,
};

/** Called for every store event of the given types — for reactions, not rendering. */
export function useStoreEvent(types, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = types.join('|');
  useEffect(() => store.subscribe((s, meta) => {
    if (key.split('|').includes(meta.type)) ref.current(s, meta);
  }), [key]);
}

const NAME_KEY = 'halo.pet.name.v1';

/** What the person has called Halo, kept in this window's storage. */
export function usePetName() {
  const [name, setName] = useState(() => {
    try { return localStorage.getItem(NAME_KEY) || 'Halo'; } catch { return 'Halo'; }
  });
  useEffect(() => {
    const onName = (e) => setName(e.detail || 'Halo');
    window.addEventListener('pico:name', onName);
    return () => window.removeEventListener('pico:name', onName);
  }, []);
  const save = useCallback((value) => {
    const v = String(value || '').trim().slice(0, 24) || 'Halo';
    try { localStorage.setItem(NAME_KEY, v); } catch { /* private mode */ }
    setName(v);
    window.dispatchEvent(new CustomEvent('pico:name', { detail: v }));
  }, []);
  return [name, save];
}

/** A value that only changes after it has stopped changing for `ms`. */
export function useDebounced(value, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** "3m", "2h", "Tue", "12 Aug" — how long ago, in as few characters as reads well. */
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(ts);
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
