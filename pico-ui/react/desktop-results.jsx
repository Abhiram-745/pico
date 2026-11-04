import { useState } from 'react';
import { store } from '../src/store.js';

export const desktopExcerpt = value => String(value || '')
  .replace(/!?\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
  .replace(/`+/g, '').replace(/(^|\s)[#*_]+(?=\S)/g, '$1')
  .replace(/\s+/g, ' ').trim();

export async function desktopRequest(path, body, signal) {
  const response = await fetch(`/desktop-monitor${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
  });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || 'Could not update desktop progress.');
  if (Array.isArray(state.apps)) store.set({ desktopMonitor: state }, { type: 'desktopMonitor' });
  return state;
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
