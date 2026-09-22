/* ==========================================================================
   Halo — hearing and speaking, through ElevenLabs.

   The notch listens for "hey Halo" and records what follows; this turns
   that recording into words (Scribe) and turns what Halo wants to say back
   into speech (Flash TTS). Both calls are made here, on this machine, so
   the key stays in this process — the page only ever sees audio and text.

   The key is read from .env (ELEVENLABS_API_KEY) on this machine and is
   never committed; without one, voice stays off. A voice can be chosen
   with ELEVENLABS_VOICE_ID.
   ========================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const BASE = 'https://api.elevenlabs.io/v1';

// "George", one of ElevenLabs' premade voices, which every account has.
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const STT_MODEL = 'scribe_v2';
const TTS_MODEL = 'eleven_flash_v2_5';

async function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of (await readFile(ENV_PATH, 'utf8')).split('\n')) {
      const t = line.trim();
      if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env */ }
  return '';
}

export class Voice {
  constructor({ apiKey, voiceId }) {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
  }

  /** @returns {Promise<Voice|null>} null when no key is configured */
  static async fromEnv() {
    const apiKey = await envValue('ELEVENLABS_API_KEY');
    if (!apiKey) return null;
    return new Voice({
      apiKey,
      voiceId: (await envValue('ELEVENLABS_VOICE_ID')) || DEFAULT_VOICE,
    });
  }

  redact(text) {
    return this.apiKey ? String(text ?? '').split(this.apiKey).join('sk_***') : String(text ?? '');
  }

  async _fail(res) {
    let msg = '';
    try {
      const body = await res.json();
      msg = body?.detail?.message || body?.detail || body?.message || '';
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch { /* not JSON */ }
    if (res.status === 401) return new Error('ElevenLabs rejected the key.');
    if (res.status === 429) return new Error('ElevenLabs is rate limiting. Try again in a moment.');
    return new Error(this.redact(msg || `ElevenLabs returned ${res.status}`));
  }

  /** Audio in, words out. */
  async transcribe(audio, mime = 'audio/wav') {
    const form = new FormData();
    const ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : 'wav';
    form.append('file', new Blob([audio], { type: mime }), `speech.${ext}`);
    form.append('model_id', STT_MODEL);
    form.append('tag_audio_events', 'false');
    const res = await fetch(`${BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await this._fail(res);
    const body = await res.json();
    return String(body?.text ?? '').trim();
  }

  /** Words in, MP3 out. */
  async speak(text) {
    const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: String(text).slice(0, 1200), model_id: TTS_MODEL }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await this._fail(res);
    return Buffer.from(await res.arrayBuffer());
  }
}
