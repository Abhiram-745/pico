import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadEnv } from './llm.mjs';

export async function voiceConfig() {
  const env = { ...await loadEnv(), ...process.env };
  return {
    key: env.ELEVENLABS_API_KEY || '',
    model: env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
    voice: env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  };
}

// Paid synthesis is only available to this app on loopback, never a LAN page.
export function voiceRequestAllowed(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(ip)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  } catch { return false; }
}

let active = 0;
let transcribing = 0;
const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'],
]);

async function transcribe(req, res, settings, fetchImpl, reply) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES.has(type)) return reply(415, { error: 'Unsupported recording format. Try Chrome or Edge.' });
  if (!settings.key) return reply(503, { error: 'ElevenLabs is not configured on this computer.' });
  if (transcribing >= 2) return reply(429, { error: 'Transcription is busy. Try again shortly.' });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, 45_000);
  res.on('close', cancel);
  transcribing++;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return reply(413, { error: 'Recording is too large. Keep it under one minute.' });
      chunks.push(chunk);
    }
    if (!size) return reply(400, { error: 'No audio was recorded. Check your microphone.' });
    if (controller.signal.aborted) return;
    const body = new FormData();
    body.set('model_id', 'scribe_v2');
    body.set('tag_audio_events', 'false');
    body.set('file', new Blob(chunks, { type }), `recording.${AUDIO_TYPES.get(type)}`);
    const upstream = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': settings.key }, body, signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return reply(502, { error: `ElevenLabs transcription returned ${upstream.status}. Check speech-to-text access and credits for this key.` });
    }
    const result = await upstream.json();
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) return reply(422, { error: 'No speech was detected. Try speaking closer to the microphone.' });
    if (text.length > 2000) return reply(413, { error: 'That request is too long. Please record a shorter version.' });
    return reply(200, { text });
  } catch {
    if (!res.destroyed) reply(502, { error: 'Could not transcribe the recording. Check your connection and try again.' });
  } finally {
    clearTimeout(timeout);
    res.off('close', cancel);
    transcribing--;
  }
}

export async function handleVoice(req, res, pathname, { fetchImpl = fetch, config = voiceConfig } = {}) {
  const reply = (status, data) => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (!voiceRequestAllowed(req)) return reply(403, { error: 'Voice is available only in the local Halo app.' });
  const settings = await config();
  if (pathname === '/voice/transcribe' && req.method === 'POST') return transcribe(req, res, settings, fetchImpl, reply);
  if (pathname === '/voice/state' && req.method === 'GET') {
    return reply(200, { configured: Boolean(settings.key), model: settings.model });
  }
  if (pathname !== '/voice/speak' || req.method !== 'POST') return reply(405, { error: 'Unsupported voice request.' });
  if (!String(req.headers['content-type']).startsWith('application/json')) return reply(415, { error: 'Expected JSON.' });
  if (!settings.key) return reply(503, { error: 'Add ELEVENLABS_API_KEY to the local .env file.' });
  if (active >= 2) return reply(429, { error: 'Voice is busy. Try again shortly.' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 20_000) return reply(413, { error: 'Voice request is too long.' });
  }
  let text;
  try { text = JSON.parse(body).text; } catch { return reply(400, { error: 'Invalid JSON.' }); }
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return reply(400, { error: 'Speak between 1 and 4,000 characters.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const cancel = () => controller.abort();
  res.on('close', cancel);
  active++;
  try {
    const upstream = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voice)}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': settings.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: text.trim(), model_id: settings.model }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return reply(502, { error: `ElevenLabs returned ${upstream.status}. Check the key, voice access and available credits.` });
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else reply(502, { error: 'Speech could not finish. Please try again.' });
    }
  } finally {
    active--;
    clearTimeout(timeout);
    res.off('close', cancel);
  }
}
