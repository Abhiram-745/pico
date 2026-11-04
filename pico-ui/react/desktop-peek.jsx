import { useEffect, useState } from 'react';
import { bridge } from '../src/bridge.js';
import { desktopExcerpt, desktopRequest, DesktopResultActions } from './desktop-results.jsx';

export const setDesktopMode = enabled => desktopRequest('/settings', { enabled });
const labels = { working: 'Working', waiting: 'Needs you', completed: 'Finished', failed: 'Check this', open: 'No signal yet', idle: 'Idle', unknown: 'Unknown', unavailable: 'Not detected' };
const choices = [['claude', 'Claude'], ['codex', 'Codex'], ['chrome', 'Chrome'], ['lovable', 'Lovable'], ['grok', 'Grok'], ['cursor', 'Cursor'], ['vscode', 'VS Code'], ['chatgpt', 'ChatGPT']];

export function DesktopPeek({ monitor }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(!monitor.paused);
  const [custom, setCustom] = useState('');
  // Mounts when the island expands, including hover. Abort on collapse; the
  // monitor's shared read continues independently without stale UI callbacks.
  useEffect(() => {
    if (monitor.paused) { setRefreshing(false); return; }
    const controller = new AbortController();
    setRefreshing(true);
    const reveal = new Promise(resolve => setTimeout(resolve, 260));
    Promise.all([desktopRequest('/refresh', {}, controller.signal), reveal]).catch(err => {
      if (!controller.signal.aborted) setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [monitor.paused]);
  const update = async patch => {
    setBusy(true); setError('');
    try { await desktopRequest('/settings', patch); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const apps = monitor.apps || [];
  const selected = monitor.settings?.selectedApps || [];
  const results = apps.filter(app => ['completed', 'waiting', 'failed'].includes(app.state) && !app.dismissed)
    .sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || (b.lastActivity || 0) - (a.lastActivity || 0));
  const missing = choices.filter(([id]) => selected.includes(id) && !apps.some(app => app.appId === id))
    .map(([appId, label]) => ({ id: appId, label, state: 'unavailable' }));
  const customMissing = (monitor.settings?.customApps || []).filter(label => !apps.some(app => app.label === label))
    .map(label => ({ id: `missing:${label}`, label, state: 'unavailable' }));
  const priority = ['waiting', 'failed', 'working', 'completed', 'unknown', 'open', 'idle', 'unavailable'];
  const overview = [...apps, ...missing, ...customMissing]
    .sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state))
    .filter((app, index, all) => all.findIndex(other => other.label === app.label) === index);
  return <section className="h-desktop-peek" aria-label="Desktop progress" aria-busy={refreshing} onClick={e => e.stopPropagation()}>
    <div className="h-desktop-peek__intro"><span>{refreshing ? 'Sensing your desktop…' : monitor.paused ? 'Watching paused' : 'Watching your apps'}</span><span>{monitor.settings?.aiSummaries ? 'AI + local' : 'Local only'}</span></div>
    <div className="h-desktop-sensing" data-active={refreshing} aria-hidden="true"><i /><i /><i /></div>
    <div className="h-desktop-overview" aria-label="Watched app states">{overview.map(app => <span key={app.label} data-state={monitor.paused ? 'idle' : app.state}>
      <i aria-hidden="true" />{app.label} · {monitor.paused ? 'Paused' : labels[app.state] || 'Unknown'}
    </span>)}</div>
    <p role="status">{monitor.paused ? 'Monitoring is paused. Your last observations are below.' : monitor.summary?.source !== 'openai' && results.length ? `${results.length} ${results.length === 1 ? 'update' : 'updates'} ready to review.` : monitor.summary?.text || 'Waiting for the next local signal.'}</p>
    {monitor.summary?.source === 'openai' && <small>OpenAI briefing · based on local observations</small>}
    {monitor.error && <small role="status">{monitor.error}</small>}
    {monitor.summaryError && <small role="status">{monitor.summaryError}</small>}
    <div className="h-desktop-results" data-refreshing={refreshing} aria-label="Results and requests">
      {results.map(app => <article className="h-desktop-result" key={app.resultId}>
        <div className="h-desktop-result__heading"><b>{app.label}{app.project ? ` · ${app.project}` : ''}</b><span>{monitor.paused ? 'Last known' : labels[app.state]}</span></div>
        {app.asked && <div className="h-desktop-result__task">{desktopExcerpt(app.asked)}</div>}
        <p>{desktopExcerpt(app.latest) || app.detail || 'Reply finished. No result excerpt was exposed; review it in the app.'}</p>
        <small>{app.source === 'transcript' ? 'Local session' : 'On-screen signal'} · {app.state === 'completed' ? 'Reply ended · review the result' : app.confidence === 'high' ? 'Direct signal' : 'Inferred signal'}</small>
        <DesktopResultActions id={app.resultId} />
      </article>)}
    </div>
    <details className="h-desktop-apps" open>
      <summary>Watched apps · {selected.length + (monitor.settings?.customApps?.length || 0)}</summary>
      <div className="h-desktop-peek__apps">
        {[...apps, ...missing, ...customMissing].map(app => <article key={app.id}>
          <span className="h-desktop-peek__dot" data-state={monitor.paused ? 'idle' : app.state} />
          <div><b>{app.label}{app.project ? ` · ${app.project}` : ''}</b><small>{desktopExcerpt(app.latest) || (app.state === 'open' ? 'Waiting for a progress signal' : app.detail) || 'Open the app to watch for signals'}</small></div>
          <span>{monitor.paused ? 'Paused' : labels[app.state] || 'Unknown'}</span>
        </article>)}
      </div>
    </details>
    <details className="h-desktop-preferences">
      <summary>Watching preferences</summary>
      <div className="h-desktop-choices">{choices.map(([id, label]) => <label key={id}><input type="checkbox" disabled={busy} checked={selected.includes(id)} onChange={() => update({ selectedApps: selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id] })} />{label}</label>)}</div>
      <form onSubmit={e => { e.preventDefault(); if (custom.trim()) { update({ customApps: [...(monitor.settings?.customApps || []), custom.trim()] }); setCustom(''); } }}>
        <input aria-label="Another app to watch" placeholder="Another app name" maxLength={60} value={custom} onChange={e => setCustom(e.target.value)} /><button disabled={busy || !custom.trim()}>Add</button>
      </form>
      {(monitor.settings?.customApps || []).map(name => <button key={name} disabled={busy} onClick={() => update({ customApps: monitor.settings.customApps.filter(value => value !== name) })}>Remove {name}</button>)}
      <label><input type="checkbox" disabled={busy} checked={Boolean(monitor.settings?.quiet)} onChange={e => update({ quiet: e.target.checked })} />Quiet updates</label>
      <label><input type="checkbox" disabled={busy} checked={Boolean(monitor.settings?.aiSummaries)} onChange={e => update({ aiSummaries: e.target.checked })} />OpenAI briefings (sends selected app metadata and reply excerpts)</label>
    </details>
    {error && <p role="alert">{error}</p>}
    <footer>
      <button type="button" onClick={() => bridge.send('openApp', { section: 'workspace' })}>More detail ↗</button>
      <button type="button" disabled={busy} onClick={() => update({ paused: !monitor.paused })}>{monitor.paused ? 'Resume watching' : 'Pause'}</button>
    </footer>
  </section>;
}
