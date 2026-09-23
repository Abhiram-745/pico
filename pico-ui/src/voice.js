import { bridge } from './bridge.js';
import { store } from './store.js';

let controller, audio, objectUrl, armed = false;
let enabled = false;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('halo-voice') : null;
const status = (text) => window.dispatchEvent(new CustomEvent('halo:voice-status', { detail: text }));

export function stopVoice(broadcast = true) {
  controller?.abort(); controller = null;
  audio?.pause(); audio = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  status('');
  if (broadcast) channel?.postMessage('stop');
}
channel?.addEventListener('message', () => { armed = false; stopVoice(false); });
export function setVoiceEnabled(value) { enabled = value; if (!value) { armed = false; stopVoice(); } }

export async function speak(text) {
  stopVoice();
  const current = new AbortController(); controller = current;
  const player = new Audio(); audio = player;
  status('Preparing voice…');
  try {
    const response = await fetch('/voice/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 4000) }), signal: current.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Voice is unavailable.');
    if (current.signal.aborted) return;
    player.onended = () => { if (controller === current) stopVoice(false); };
    player.onerror = () => { if (controller === current) { stopVoice(false); status('Audio playback failed. Try Listen again.'); } };
    // Start playback after the first MP3 frames, without waiting for the whole reply.
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
      const media = new MediaSource();
      objectUrl = URL.createObjectURL(media); player.src = objectUrl;
      await new Promise((resolve, reject) => {
        media.addEventListener('sourceopen', resolve, { once: true });
        current.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
      const buffer = media.addSourceBuffer('audio/mpeg');
      const reader = response.body.getReader();
      let started = false;
      while (!current.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        await new Promise((resolve, reject) => {
          const cleanup = () => { buffer.removeEventListener('updateend', finish); buffer.removeEventListener('error', fail); current.signal.removeEventListener('abort', fail); };
          const finish = () => { cleanup(); resolve(); };
          const fail = () => { cleanup(); reject(new Error('Audio stream stopped.')); };
          buffer.addEventListener('updateend', finish, { once: true });
          buffer.addEventListener('error', fail, { once: true });
          current.signal.addEventListener('abort', fail, { once: true });
          buffer.appendBuffer(value);
        });
        if (!started) { await player.play(); started = true; status('Speaking'); }
      }
      if (!current.signal.aborted && media.readyState === 'open') media.endOfStream();
    } else {
      const blob = await response.blob();
      if (current.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); player.src = objectUrl;
      await player.play(); status('Speaking');
    }
  } catch (error) {
    if (controller !== current || current.signal.aborted) return;
    stopVoice(false);
    status(error.name === 'NotAllowedError' ? 'Click Listen on the reply to enable playback.' : error.message);
  }
}

bridge.onSend((command) => {
  if (['submitTask', 'steer', 'stop', 'newChat', 'openChat'].includes(command)) {
    stopVoice(); armed = enabled && ['submitTask', 'steer'].includes(command);
  }
});
store.subscribe((state, meta) => {
  if (meta.cleared || ['Failed', 'Stopped'].includes(state.phase)) { armed = false; stopVoice(false); return; }
  const message = meta.message;
  if (meta.type === 'message' && armed && message?.from === 'pico' && message.done && message.text) {
    armed = false; speak(message.text);
  }
});
