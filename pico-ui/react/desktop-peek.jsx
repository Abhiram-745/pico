import { useState } from 'react';
import { store } from '../src/store.js';
import { bridge } from '../src/bridge.js';
import { Icon } from './parts.jsx';

export async function setDesktopMode(enabled) {
  const response = await fetch('/desktop-monitor/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || 'Could not switch modes.');
  store.set({ desktopMonitor: state }, { type: 'desktopMonitor' });
  return state;
}

const labels = { working: 'Working', waiting: 'Needs you', completed: 'Finished', failed: 'Check this', open: 'Open', idle: 'Idle', unknown: 'No signal', unavailable: 'Unavailable' };
export function DesktopPeek({ monitor }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = async (patch) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/desktop-monitor/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || 'Could not update monitoring.');
      store.set({ desktopMonitor: state }, { type: 'desktopMonitor' });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const apps = [...(monitor.apps || [])].sort((a, b) => (['waiting', 'failed'].includes(b.state) ? 1 : 0) - (['waiting', 'failed'].includes(a.state) ? 1 : 0));
  return <section className="h-desktop-peek" aria-label="Desktop progress" onClick={e => e.stopPropagation()}>
    <div className="h-desktop-peek__intro"><span>Desktop companion</span><span>{monitor.paused ? 'Paused' : 'Read only'}</span></div>
    <p>{monitor.paused ? 'Monitoring is paused. Resume whenever you’re ready.' : monitor.summary?.text || 'Progress from the apps you choose, together in one place.'}</p>
    <div className="h-desktop-peek__apps">
      {apps.slice(0, 3).map(app => <article key={app.id}>
        <span className="h-desktop-peek__dot" data-state={app.state} />
        <div><b>{app.label}{app.project ? ` · ${app.project}` : ''}</b><small>{app.detail || app.windowTitle || 'No readable progress yet'}</small></div>
        <span>{labels[app.state] || 'Unknown'}</span>
      </article>)}
      {!apps.length && <small>Choose apps in Workspace to start seeing updates.</small>}
    </div>
    {error && <p role="alert">{error}</p>}
    <footer>
      <button type="button" onClick={() => bridge.send('openApp', { section: 'workspace' })}><Icon name="monitor" size={14} /> Open workspace</button>
      <button type="button" disabled={busy} onClick={() => update({ paused: !monitor.paused })}>{monitor.paused ? 'Resume' : 'Pause'}</button>
    </footer>
  </section>;
}
