import React, { useEffect, useState } from 'react';
export function ConnectionsCard({ demo }) {
  const [state, setState] = useState(null), [key, setKey] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [link, setLink] = useState('');
  const refresh = async () => { const r = await fetch('/composio'); const data = await r.json(); if (!r.ok) throw new Error(data.error); setState(data); };
  useEffect(() => { if (demo) return; refresh().catch(() => setError('Tools status unavailable.')); const timer = setInterval(() => refresh().catch(() => {}), 15000); return () => clearInterval(timer); }, [demo]);
  const action = async (path, body) => {
    setBusy(true); setError(''); setLink('');
    try { const r = await fetch(`/composio/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); if (data.redirectUrl) setLink(data.redirectUrl); if (data.reused) setError('Existing connection found. Select it below; no new consent is needed.'); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="h-card h-connections"><div className="h-card__title">Tools / Connections</div>
    <p>Connect apps through Composio for quiet watch updates. Mail sending requires Halo approval. This is separate from Grok Bot MCP.</p>
    <label><input type="checkbox" disabled={busy || demo || !state?.hasKey} checked={state?.enabled || false} onChange={e => action('settings', { enabled: e.target.checked })}/> Enable Composio</label>
    <label>Local Composio user ID <input className="h-input" key={state?.userId} defaultValue={state?.userId || 'halo-local'} onBlur={e => { if (state && e.target.value !== state.userId) action('settings', { userId: e.target.value }); }}/></label>
    <p role="status">{!state ? 'Loading local Tools status…' : !state.hasKey ? 'No API key loaded — Workspace email/calendar watch stays off until a key is saved.' : state.enabled ? 'Key available · Enabled' : 'Key available · Disabled — turn on Enable Composio.'}</p>
    <form className="h-connections__key" onSubmit={e => { e.preventDefault(); const value = key; setKey(''); action('key', { key: value }); }}>
      <input className="h-input" type="password" autoComplete="off" placeholder="Composio API key" value={key} onChange={e => setKey(e.target.value)} aria-label="Composio API key"/>
      <button disabled={busy || !key || demo}>Save key securely</button>
    </form>
    <p>Save a key to Windows Credential Manager: Generic Credential Halo/Composio, or set process environment COMPOSIO_API_KEY before starting Halo. Then turn on Enable Composio, connect Gmail/Outlook/Calendar, select an account, and enable Watch. Never enter a Gmail password.</p>
    {['gmail', 'outlook', 'googlecalendar', 'slack'].map(app => <div className="h-connections__app" key={app}>
      <label><input type="checkbox" disabled={busy || !state?.hasKey || !state?.enabled || demo || app === 'slack'} checked={state?.watchApps?.includes(app) || false} onChange={e => action('settings', { watchApps: e.target.checked ? [...state.watchApps, app] : state.watchApps.filter(x => x !== app) })}/> Watch {app}</label>
      {app !== 'slack' && <select aria-label={`Selected ${app} account`} value={state?.selectedAccounts?.[app] || ''} disabled={busy || demo || !state?.hasKey || !state?.enabled} onChange={e => action('settings', { selectedAccounts: { ...state.selectedAccounts, [app]: e.target.value } })}><option value="" disabled>Select an existing account</option>{state?.connections?.filter(c => c.app === app && c.status === 'ACTIVE').map((c,i) => <option key={c.id} value={c.id}>{app} account {i+1} ({c.id.slice(-6)})</option>)}</select>}
      <button disabled={busy || demo || !state?.hasKey || !state?.enabled || !state?.oauthAvailable} onClick={() => action('connect', { app })}>Connect {app}</button>
    </div>)}
    {!state?.oauthAvailable && <p>After a key is available, enable Composio to connect apps with one-time hosted browser consent.</p>}
    {link && <p><a href={link} target="_blank" rel="noopener noreferrer">Continue authorization</a> · Status refreshes every 15 seconds after returning.</p>}
    {state?.connections?.map(c => <p key={c.id}>{c.app}: {c.status} <button disabled={busy || !state.oauthAvailable} onClick={() => action('disconnect', { id: c.id })}>Disconnect</button></p>)}
    <button disabled={busy || demo} onClick={() => refresh().catch(() => setError('Tools status unavailable.'))}>Refresh status</button>
    {state?.connectionError && <p role="status">{state.connectionError}</p>}
    {error && <p className="h-connections__error" role="alert">{error}</p>}
  </div>;
}
