import { useState } from 'react';
import { monitorRequest } from '../src/monitor-client.js';

export const desktopExcerpt = value => String(value || '')
  .replace(/!?\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
  .replace(/`+/g, '').replace(/(^|\s)[#*_]+(?=\S)/g, '$1')
  .replace(/\s+/g, ' ').trim();

export async function desktopRequest(path, body, signal) {
  return monitorRequest(`/desktop-monitor${path}`, { body: body || {}, signal, timeoutMs: 25000 });
}

export function DesktopResultActions({ id }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async action => {
    setBusy(true); setError('');
    try { await desktopRequest(`/${action}/${encodeURIComponent(id)}`); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <div className="h-result-actions">
    <button type="button" disabled={busy} onClick={() => act('open')}>Open result <span aria-hidden="true">↗</span></button>
    <button type="button" disabled={busy} onClick={() => act('dismiss')}>Dismiss</button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
