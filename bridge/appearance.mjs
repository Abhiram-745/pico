import { readJson, writeJson } from './home.mjs';
import { desktopRequestAllowed } from './desktop-routes.mjs';
const choices = new Set(['system', 'light', 'dark']);
export function appearancePreference() {
  const saved = readJson('appearance.json', {});
  return { preference: choices.has(saved.preference) ? saved.preference : 'system' };
}
export async function handleAppearance(req, res, broadcast) {
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!desktopRequestAllowed(req)) { reply(403, { error: 'Appearance is local-only.' }); return; }
  if (req.method === 'GET') { reply(200, appearancePreference()); return; }
  if (req.method !== 'POST') { reply(405, { error: 'Use GET or POST.' }); return; }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024) { reply(413, { error: 'Preference is too large.' }); return; }
  }
  let value;
  try { value = JSON.parse(raw)?.preference; } catch { /* validated below */ }
  if (!choices.has(value)) { reply(400, { error: 'Choose System, Light, or Dark.' }); return; }
  const state = { preference: value };
  if (!writeJson('appearance.json', state)) { reply(500, { error: 'Could not save appearance.' }); return; }
  broadcast({ type: 'appearance', payload: state });
  reply(200, state);
}
