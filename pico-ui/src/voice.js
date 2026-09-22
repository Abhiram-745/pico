/* ==========================================================================
   Halo — "hey Halo".

   The island listens, all the time it is open, for its name. Say "hey Halo,
   open Notepad" and it is done as if typed; say "hey Halo", wait for "Yes?",
   and then say the job. Whatever Halo asks — which of two people, may it
   send this — it says out loud, and the next thing you say is the answer.

   HOW IT HEARS
   The microphone runs into a small audio worklet that hands back 20ms
   frames. Loudness against a running noise floor marks where speech starts
   and stops, with 400ms kept from before the start so the "hey" is not
   clipped. Only those stretches are sent anywhere: the bridge passes them
   to ElevenLabs to be written down. Silence and room noise never leave the
   machine.

   HOW IT SPEAKS
   The bridge asks ElevenLabs for the audio and this plays it. While Halo is
   talking the microphone is ignored, so it does not answer itself.
   ========================================================================== */

import { store, isActive } from './store.js';
import { bridge } from './bridge.js';
import { permissions } from './permissions.js';

const KEY = 'halo.voice.v1';
const NAME_KEY = 'halo.pet.name.v1';
const FRAME_MS = 20;
const PREROLL_MS = 400;
const END_SILENCE_MS = 800;
const MAX_MS = 15_000;
const MIN_SPEECH_MS = 260;

/* --------------------------------------------------------------------------
   Reading what was said. Pure, so it can be tested without a microphone.
   -------------------------------------------------------------------------- */
const clean = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Was this addressed to Halo, and if so what followed the name?
 * @returns {string|null} the rest ('' for the name alone), or null
 */
export function heardWake(text, name = 'Halo') {
  const words = clean(text).split(' ').filter(Boolean);
  const names = new Set(['halo', 'hallo', 'haylo', 'hailo', 'halow', 'hello', clean(name)]);
  const greet = new Set(['hey', 'hi', 'hay', 'hei', 'ok', 'okay', 'oi', 'yo']);
  // Within the first few words: transcripts often open with a stray "um".
  for (let i = 0; i < Math.min(words.length, 5); i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (greet.has(a) && names.has(b)) return words.slice(i + 2).join(' ');
    if (a === 'heyhalo' || a === 'hihalo') return words.slice(i + 1).join(' ');
  }
  return null;
}

const ORDINALS = [
  /\b(first|one|1st|number one|the top)\b/, /\b(second|two|2nd|number two)\b/, /\b(third|three|3rd|number three)\b/,
  /\b(fourth|four|4th)\b/, /\b(fifth|five|5th)\b/, /\b(sixth|six|6th)\b/,
];

/** Which of the offered options was named, if any. */
export function matchOption(text, options = []) {
  const said = clean(text);
  if (!said || !options.length) return null;
  const exact = options.find((o) => said.includes(clean(o.label)));
  if (exact) return exact;
  // The most words in common, as long as one of them is not a filler word.
  const stop = new Set(['the', 'a', 'an', 'one', 'of', 'to', 'in', 'on', 'and', 'please', 'it', 'is', 'that']);
  let best = null;
  let bestScore = 0;
  for (const o of options) {
    const words = clean(o.label).split(' ').filter((w) => w.length > 1 && !stop.has(w));
    const score = words.filter((w) => said.split(' ').includes(w)).length;
    if (score > bestScore) { best = o; bestScore = score; }
  }
  if (best) return best;
  // From the last down, so "the second one" is second, not "one".
  let i = -1;
  for (let j = ORDINALS.length - 1; j >= 0 && i < 0; j--) if (ORDINALS[j].test(said)) i = j;
  return i >= 0 && i < options.length ? options[i] : null;
}

/** 'yes', 'no', or null when it was neither. No wins a tie. */
export function yesOrNo(text) {
  const said = clean(text);
  if (/\b(no|nope|nah|don't|do not|stop|cancel|deny|wait|hold on)\b/.test(said)) return 'no';
  if (/\b(yes|yeah|yep|yup|sure|go ahead|do it|allow|okay|ok|send it|go for it|please do|fine)\b/.test(said)) return 'yes';
  return null;
}

/** A question as it should sound, options and all. */
export function spokenQuestion(q) {
  const labels = (q?.options || []).map((o) => o.label).filter(Boolean);
  if (!labels.length) return q?.text || '';
  const list = labels.length === 2 ? `${labels[0]}, or ${labels[1]}` : `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
  return `${q.text} ${list}?`;
}

/* --------------------------------------------------------------------------
   Audio
   -------------------------------------------------------------------------- */
const WORKLET = `
class HaloTap extends AudioWorkletProcessor {
  constructor(o) { super(); this.size = o.processorOptions.size; this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('halo-tap', HaloTap);
`;

function wav(frames, rate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new DataView(new ArrayBuffer(44 + total * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, total * 2, true);
  let o = 44;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++, o += 2) {
      const v = Math.max(-1, Math.min(1, f[i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

/* --------------------------------------------------------------------------
   The listener
   -------------------------------------------------------------------------- */
class Voice {
  constructor() {
    this.state = { enabled: this._saved(), available: false, mode: 'off', text: '', error: '' };
    this._subs = new Set();
    this._queue = [];
    this._busy = false;
    this._expect = null;       // { kind: 'command'|'answer'|'approval', id?, options?, until }
    this._voiceTurn = false;   // the job in hand was asked for out loud
    this._mutedUntil = 0;
    this._audio = null;
  }

  _saved() {
    try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this._subs) fn(this.state);
  }

  _name() {
    try { return localStorage.getItem(NAME_KEY) || 'Halo'; } catch { return 'Halo'; }
  }

  _url(path) {
    const k = new URLSearchParams(location.search).get('k') || '';
    return `${path}?k=${encodeURIComponent(k)}`;
  }

  /** Start listening, if it is on. Safe to call more than once. */
  async start() {
    if (this._started) return;
    // Only in the island the bridge opened: a preview or a stray tab has no
    // key to spend and no business asking for the microphone.
    if (!new URLSearchParams(location.search).get('k')) return;
    this._started = true;
    try {
      const res = await fetch('/voice/state');
      if (!(await res.json()).ready) {
        this._set({ enabled: false, available: false, error: 'Voice needs an ElevenLabs key: set ELEVENLABS_API_KEY in the .env file next to Start Halo.cmd.' });
        return;
      }
    } catch { return; }
    this._set({ available: true });
    this._watchStore();
    if (this.state.enabled) await this._openMic();
  }

  async toggle() {
    if (!this.state.available) return;
    const enabled = !this.state.enabled;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
    this._set({ enabled });
    if (enabled) await this._openMic(); else this._closeMic();
  }

  async _openMic() {
    if (this._ctx) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this._set({ mode: 'off', error: 'This window has no microphone access.' });
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      try { this._ctx = new AudioContext({ sampleRate: 16000 }); } catch { this._ctx = new AudioContext(); }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this._ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const rate = this._ctx.sampleRate;
      const size = Math.round((rate * FRAME_MS) / 1000);
      const src = this._ctx.createMediaStreamSource(this._stream);
      this._node = new AudioWorkletNode(this._ctx, 'halo-tap', { processorOptions: { size } });
      this._node.port.onmessage = (e) => this._frame(e.data);
      src.connect(this._node);
      this._rate = rate;
      this._floor = 0.004;
      this._pre = [];
      this._seg = null;
      this._set({ mode: 'listening', error: '' });
    } catch (err) {
      this._closeMic();
      this._set({ mode: 'off', error: `Microphone unavailable: ${err.message}` });
    }
  }

  _closeMic() {
    try { this._node?.disconnect(); } catch { /* already */ }
    try { this._ctx?.close(); } catch { /* already */ }
    for (const t of this._stream?.getTracks?.() ?? []) t.stop();
    this._ctx = null;
    this._node = null;
    this._stream = null;
    this._seg = null;
    this._expect = null;
    this._set({ mode: 'off', text: '' });
  }

  /* --- one 20ms frame ---------------------------------------------------- */
  _frame(f) {
    if (performance.now() < this._mutedUntil) { this._pre = []; this._seg = null; return; }
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    const threshold = Math.max(0.012, this._floor * 3.2);

    if (!this._seg) {
      // The floor follows the room while nobody is speaking.
      if (rms < threshold) this._floor = (this._floor * 0.98) + (rms * 0.02);
      this._pre.push(f);
      if (this._pre.length > PREROLL_MS / FRAME_MS) this._pre.shift();
      this._loud = rms > threshold ? (this._loud || 0) + 1 : 0;
      if (this._loud >= 3) {
        this._seg = { frames: [...this._pre], speech: this._loud, quiet: 0 };
        this._pre = [];
        if (this.state.mode === 'listening' || this.state.mode === 'waiting') this._set({ mode: 'hearing' });
      }
      return;
    }

    const seg = this._seg;
    seg.frames.push(f);
    if (rms > threshold * 0.7) { seg.quiet = 0; seg.speech += 1; } else seg.quiet += 1;
    const long = seg.frames.length * FRAME_MS >= MAX_MS;
    if (seg.quiet * FRAME_MS >= END_SILENCE_MS || long) {
      this._seg = null;
      this._loud = 0;
      if (seg.speech * FRAME_MS < MIN_SPEECH_MS) { this._settle(); return; }
      this._queue.push(wav(seg.frames, this._rate));
      this._drain();
    }
  }

  /** Back to whichever resting state fits. */
  _settle() {
    if (!this._ctx) return;
    const mode = this._expect && this._expect.until > Date.now() ? 'waiting' : 'listening';
    if (this.state.mode !== 'speaking') this._set({ mode });
  }

  async _drain() {
    if (this._busy) return;
    this._busy = true;
    while (this._queue.length) {
      const audio = this._queue.shift();
      const listening = !this._expect || this._expect.until < Date.now();
      // Only show "thinking" once it is known to be for Halo; a passing
      // conversation should not light the island up.
      if (!listening) this._set({ mode: 'thinking', text: '' });
      let text = '';
      try {
        const res = await fetch(this._url('/voice/stt'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        text = String(body.text || '').trim();
      } catch (err) {
        this._set({ error: `Could not hear that: ${err.message}` });
      }
      if (text) await this._heard(text);
      this._settle();
    }
    this._busy = false;
  }

  /* --- what was said ------------------------------------------------------ */
  async _heard(text) {
    const expect = this._expect && this._expect.until > Date.now() ? this._expect : null;
    const wake = heardWake(text, this._name());

    if (wake !== null || expect?.kind === 'command') {
      const job = wake !== null ? wake : text;
      if (!job) {
        this._expect = { kind: 'command', until: Date.now() + 9000 };
        this._set({ text: 'Listening…' });
        await this.say('Yes?');
        this._set({ mode: 'waiting' });
        return;
      }
      this._expect = null;
      this._command(job);
      return;
    }
    if (!expect) return;           // not for Halo

    if (expect.kind === 'answer') {
      const q = store.state.question;
      if (!q || q.id !== expect.id) { this._expect = null; return; }
      const pick = matchOption(text, q.options || []);
      this._expect = null;
      this._set({ text });
      bridge.send('answerQuestion', { id: q.id, text: pick ? pick.label : text, ...(pick ? { choice: pick.id } : {}) });
      store.setQuestion(null);
      return;
    }

    if (expect.kind === 'approval') {
      const a = store.state.approval;
      if (!a || a.id !== expect.id) { this._expect = null; return; }
      const said = yesOrNo(text);
      if (!said) { await this.say('Sorry — yes or no?'); this._expect = { ...expect, until: Date.now() + 12_000 }; return; }
      this._expect = null;
      this._set({ text });
      bridge.send(said === 'yes' ? 'approve' : 'deny', { id: a.id });
    }
  }

  _command(job) {
    const running = isActive(store.state.phase);
    this._set({ text: job });
    if (running && /^(stop|cancel|halt|abort)\b/i.test(job)) { bridge.send('stop'); return; }
    if (running && /^pause\b/i.test(job)) { bridge.send('pause'); return; }
    if (/^(resume|carry on|continue|keep going)\b/i.test(job) && store.state.pause?.paused) { bridge.send('resume'); return; }
    this._voiceTurn = true;
    const plan = store.state.plan;
    if (running && plan && !plan.finished) {
      bridge.send('steer', { text: job });
      return;
    }
    const id = `you_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (plan?.finished) store.setPlan(null);
    store.addMessage({ id, from: 'you', text: job, done: true });
    bridge.send('submitTask', { text: job, mode: store.state.mode, id });
  }

  /* --- speaking ----------------------------------------------------------- */
  /** Say something out loud. Resolves when it has been said. */
  async say(text) {
    const line = String(text || '').trim();
    if (!line || !this.state.enabled) return;
    this._audio?.pause();
    this._set({ mode: 'speaking', text: line });
    this._mutedUntil = Infinity;
    try {
      const res = await fetch(this._url('/voice/tts'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: line }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      this._audio = audio;
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
    } catch (err) {
      this._set({ error: `Could not speak: ${err.message}` });
    } finally {
      // A moment's grace, so the tail of Halo's own voice is not heard as you.
      this._mutedUntil = performance.now() + 350;
      if (this._ctx) this._set({ mode: this._expect ? 'waiting' : 'listening' });
      else this._set({ mode: 'off' });
    }
  }

  /* --- what Halo asks, said out loud --------------------------------------- */
  _watchStore() {
    store.subscribe((state, meta) => {
      if (!this.state.enabled || !this._ctx) return;
      if (meta.type === 'question') {
        const q = meta.question;
        if (!q) { if (this._expect?.kind === 'answer') this._expect = null; this._settle(); return; }
        this._expect = { kind: 'answer', id: q.id, until: Date.now() + 60_000 };
        this.say(spokenQuestion(q)).then(() => { if (this._expect?.id === q.id) this._set({ mode: 'waiting' }); });
      } else if (meta.type === 'approval') {
        const a = meta.approval;
        if (!a) { if (this._expect?.kind === 'approval') this._expect = null; this._settle(); return; }
        if (permissions.decide(a)?.auto) return;
        this._expect = { kind: 'approval', id: a.id, until: Date.now() + 60_000 };
        this.say(`${a.summary}. Should I go ahead?`).then(() => { if (this._expect?.id === a.id) this._set({ mode: 'waiting' }); });
      } else if (meta.type === 'takeover' && meta.takeover) {
        this.say(`I need you to do this part yourself. ${meta.takeover.reason || ''}`);
      } else if (meta.type === 'summary' && meta.summary && this._voiceTurn) {
        this._voiceTurn = false;
        this.say(typeof meta.summary === 'string' ? meta.summary : meta.summary.text);
      } else if (meta.type === 'message' && this._voiceTurn && !meta.restored && !meta.streaming
        && meta.message?.from === 'pico' && meta.message.done && !isActive(state.phase)) {
        this._voiceTurn = false;
        this.say(meta.message.text);
      }
    });
  }
}

export const voice = new Voice();
