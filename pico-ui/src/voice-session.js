import { bridge } from './bridge.js';
import { store, isActive } from './store.js';
import { stopVoice } from './voice.js';

const listeners = new Set();
export const voiceOwner = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
const idle = () => ({ active: false, phase: 'idle', level: 0, message: '', transcript: '', owner: null });
const notify = event => { for (const listener of listeners) listener(event); };
const apply = state => store.set({ voice: state }, { type: 'voice' });

store.subscribe((state, meta) => {
  if (meta.type !== 'voice' || !meta.remote) return;
  const previous = meta.previousVoice;
  if (previous?.owner === voiceOwner && state.voice.owner !== voiceOwner) {
    stopVoice(false);
    notify({ type: 'claim' });
  } else if (previous?.active && !state.voice.active) {
    stopVoice(false);
    notify({ type: 'stop' });
  }
});

export function onVoiceSession(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function claimVoice() {
  const state = { ...idle(), active: true, phase: 'requesting', owner: voiceOwner };
  apply(state);
  bridge.send('voiceSession', { action: 'claim', owner: voiceOwner, state });
}

export function updateVoice(patch) {
  if (store.state.voice.owner !== voiceOwner) return;
  const state = { ...store.state.voice, ...patch, owner: voiceOwner };
  apply(state);
  bridge.send('voiceSession', { action: 'update', owner: voiceOwner, state });
}

export function endVoice() {
  const sessionOwner = store.state.voice.owner;
  if (!sessionOwner && !store.state.voice.active) { stopVoice(); return; }
  apply(idle());
  bridge.send('voiceSession', { action: 'end', owner: sessionOwner });
  notify({ type: 'stop' });
  stopVoice();
}

/** End the listening session but leave the reply to be spoken: what a
    hold-to-talk release does. Nothing is stopped and no other window is told
    to go quiet — only the microphone is put down. */
export function releaseVoice() {
  if (store.state.voice.owner !== voiceOwner) return;
  apply(idle());
  bridge.send('voiceSession', { action: 'end', owner: voiceOwner });
}

/** One emergency action for the task and voice, including speech playback. */
export function stopEverything() {
  if (isActive(store.state.phase)) bridge.send('stop');
  endVoice();
}

export function isSpokenStop(text) {
  return /^(?:stop(?:\s+halo|\s+now|\s+everything)?|halo\s+stop|cancel\s+everything)[.!\s]*$/i.test(String(text).trim());
}
