/* Local-only controls for the read-only desktop companion. */
export function desktopRequestAllowed(req) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(ip)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (host.pathname !== '/' || host.search || host.hash || host.username || host.password) return false;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  } catch { return false; }
}

export async function handleDesktopRoutes(req, res, pathname, { monitor, persist = () => {}, onModeChange = () => {} }) {
  if (!pathname.startsWith('/desktop-monitor')) return false;
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!desktopRequestAllowed(req)) { reply(403, { error: 'Desktop monitoring is available on this computer only.' }); return true; }
  try {
    if (pathname === '/desktop-monitor' && req.method === 'GET') reply(200, monitor.snapshot());
    else if (pathname === '/desktop-monitor/refresh' && req.method === 'POST') reply(200, await monitor.refresh());
    else if (pathname === '/desktop-monitor/settings' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) { reply(413, { error: 'Settings are too large.' }); return true; }
      }
      let body;
      try { body = JSON.parse(raw); } catch { reply(400, { error: 'Settings must be valid JSON.' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(400, { error: 'Settings must be an object.' }); return true; }
      if ('settings' in body && (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))) { reply(400, { error: 'Settings must be an object.' }); return true; }
      const input = body.settings && typeof body.settings === 'object' ? { ...body.settings, ...body } : body;
      const patch = {};
      for (const key of ['enabled', 'paused', 'aiSummaries', 'quiet']) {
        if (key in input) {
          if (typeof input[key] !== 'boolean') { reply(400, { error: `${key} must be on or off.` }); return true; }
          patch[key] = input[key];
        }
      }
      for (const key of ['selectedApps', 'customApps']) {
        if (!(key in input)) continue;
        if (!Array.isArray(input[key]) || input[key].length > 30 || input[key].some(x => typeof x !== 'string' || !x.trim() || x.length > 80)) {
          reply(400, { error: 'Choose up to 30 app names, each under 80 characters.' }); return true;
        }
        patch[key] = [...new Set(input[key].map(x => x.trim()))];
      }
      if ('intervalSeconds' in input) {
        if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 5 || input.intervalSeconds > 120) {
          reply(400, { error: 'Choose a refresh interval between 5 and 120 seconds.' }); return true;
        }
        patch.intervalSeconds = Math.round(input.intervalSeconds);
      }
      const wasEnabled = monitor.snapshot().enabled;
      // Stop the action agent before any monitor work begins.
      if (patch.enabled === true && !wasEnabled) await onModeChange('desktop');
      await monitor.configure(patch);
      const state = monitor.snapshot();
      persist({ enabled: state.enabled, paused: state.paused, ...state.settings });
      if (patch.enabled === false && wasEnabled) await onModeChange('agent');
      reply(200, state);
    } else reply(405, { error: 'This desktop control does not support that request.' });
  } catch {
    reply(500, { error: 'Could not update desktop monitoring. Please try again.' });
  }
  return true;
}
