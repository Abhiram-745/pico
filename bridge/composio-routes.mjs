import { desktopRequestAllowed } from './desktop-routes.mjs';
export async function handleComposioRoutes(req, res, path, { composio, persist = () => {}, onWatchChange = () => {} }) {
  if (!path.startsWith('/composio')) return false;
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (!desktopRequestAllowed(req)) { reply(403, { error: 'Tools settings are local-only.' }); return true; }
  try {
    if (req.method === 'GET' && path === '/composio') {
      let connections = [], connectionError = '';
      try { connections = await composio.connections(); } catch { connectionError = 'Connections unavailable. Check dependency installation, key, and network.'; }
      reply(200, { ...composio.state(), connections, connectionError }); return true;
    }
    if (req.method !== 'POST') { reply(405, { error: 'Unsupported request.' }); return true; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) { reply(413, { error: 'Request too large.' }); return true; } }
    let body; try { body = JSON.parse(raw); } catch { reply(400, { error: 'Invalid JSON.' }); return true; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(400, { error: 'Invalid request.' }); return true; }
    if (path === '/composio/settings') { composio.configure(body); onWatchChange(composio.state()); await persist(composio.config); reply(200, composio.state()); }
    else if (path === '/composio/key') { await composio.setKey(body.key); reply(200, { ok: true }); }
    else if (path === '/composio/connect') reply(200, await composio.connect(body.app));
    else if (path === '/composio/disconnect') { await composio.disconnect(body.id); onWatchChange({ ...composio.state(), disconnectedId: body.id }); reply(200, { ok: true }); }
    else reply(404, { error: 'Unknown Tools control.' });
  } catch { reply(400, { error: 'Tools request failed. Check the key, feature toggle, and selected account.' }); }
  return true;
}
