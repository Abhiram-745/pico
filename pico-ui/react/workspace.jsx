import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './parts.jsx';
import { useStore } from './hooks.js';
import { store } from '../src/store.js';
import { DesktopResultActions } from './desktop-results.jsx';
import { SignalOrbit } from './signal-orbit.jsx';

const selectMonitor = (s) => s.desktopMonitor;
const DEFAULT_APPS = [
  { id: 'claude', label: 'Claude', mark: 'C', note: 'Desktop + Code' },
  { id: 'codex', label: 'Codex', mark: '↗', note: 'Local agent sessions' },
  { id: 'chrome', label: 'Chrome', mark: '◉', note: 'Visible browser titles' },
  { id: 'lovable', label: 'Lovable', mark: 'L', note: 'Browser workspace' },
  { id: 'grok', label: 'Grok', mark: 'G', note: 'App or browser' },
];
const DEFAULT_SETTINGS = { selectedApps: DEFAULT_APPS.map((a) => a.id), customApps: [], intervalSeconds: 15, aiSummaries: false, quiet: true };
const STATUS = {
  working: { label: 'Working', tone: 'working' }, running: { label: 'Working', tone: 'working' }, busy: { label: 'Working', tone: 'working' },
  waiting: { label: 'Your turn', tone: 'attention' }, attention: { label: 'Needs you', tone: 'attention' }, needs_attention: { label: 'Needs you', tone: 'attention' },
  completed: { label: 'Finished', tone: 'complete' }, complete: { label: 'Finished', tone: 'complete' },
  failed: { label: 'Check this', tone: 'error' }, error: { label: 'Check this', tone: 'error' },
  idle: { label: 'Idle', tone: 'idle' }, open: { label: 'Open', tone: 'idle' },
  unknown: { label: 'Status unknown', tone: 'unknown' }, unavailable: { label: 'Not detected', tone: 'unknown' },
  offline: { label: 'Not detected', tone: 'unknown' }, closed: { label: 'Not detected', tone: 'unknown' }, not_running: { label: 'Not detected', tone: 'unknown' },
  stale: { label: 'Last known', tone: 'unknown' },
};
const stateOf = (app) => STATUS[String(app.state || '').toLowerCase()] || STATUS.unknown;
// Session snippets are prose here, not a second Markdown renderer. Keep the
// useful link label and leave machine paths and truncated link targets out.
const readableExcerpt = (value) => String(value || '')
  .replace(/!?\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
  .replace(/!?\[([^\]]*)\]\([^)]*$/g, '$1')
  .replace(/https?:\/\/[^\s<>]+/g, '')
  .replace(/`+/g, '')
  .replace(/(^|\s)[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?=\s|$|[.,:;!?])/g, '$1')
  .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
  .replace(/\s+/g, ' ').trim();
const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value) || 0;
const age = (value, now) => {
  const at = timestamp(value);
  if (!at) return 'Not yet observed';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};
const sourceName = (value) => {
  const source = String(value || '').toLowerCase();
  if (/transcript|session|log/.test(source)) return 'Local session';
  if (/accessibility|uia/.test(source)) return 'On-screen text';
  if (/title|window|process/.test(source)) return 'Window signal';
  if (/openai|model|ai/.test(source)) return 'OpenAI summary';
  return value ? String(value).replace(/[_-]/g, ' ') : 'No signal yet';
};
function previewSnapshot() {
  const now = Date.now();
  return {
    enabled: true, paused: false, updatedAt: now, settings: DEFAULT_SETTINGS,
    summary: { text: 'Claude is working on the settings screen. Codex has finished its test run and is ready for your review.', at: now, source: 'Preview' },
    apps: [
      { id: 'claude', label: 'Claude', title: 'Settings screen', project: 'Product workspace', state: 'working', detail: 'Editing the preferences view and checking the empty states.', source: 'transcript', confidence: 'high', updatedAt: now - 8000 },
      { id: 'codex', label: 'Codex', title: 'Navigation fixes', project: 'Desktop companion', state: 'waiting', detail: 'Tests passed. The changes are ready for you to review.', source: 'transcript', confidence: 'high', updatedAt: now - 45000 },
      { id: 'chrome', label: 'Chrome', title: 'Research — Google Chrome', state: 'open', detail: 'A browser window is open. Task progress is not exposed by its title.', source: 'window-title', confidence: 'low', updatedAt: now - 12000 },
    ],
    events: [
      { id: 'preview-1', appId: 'codex', label: 'Codex', title: 'Ready for your review', detail: 'Finished checking the navigation changes.', state: 'waiting', source: 'transcript', at: now - 45000 },
      { id: 'preview-2', appId: 'claude', label: 'Claude', title: 'Working on preferences', detail: 'The local session recorded a new editing step.', state: 'working', source: 'transcript', at: now - 95000 },
    ],
  };
}

export function ModeSwitch({ mode = 'agent', onChange, disabled = false }) {
  return <div className="w-mode" role="group" aria-label="Workspace mode">
    <button type="button" aria-pressed={mode === 'agent'} disabled={disabled} onClick={() => onChange('agent')}>
      <Icon name="bolt" size={14} /><span>Agent</span>
    </button>
    <button type="button" aria-pressed={mode === 'desktop'} disabled={disabled} onClick={() => onChange('desktop')}>
      <Icon name="monitor" size={14} /><span>Desktop</span>
    </button>
  </div>;
}

function StateBadge({ app, paused, stale }) {
  const state = stateOf(app);
  return <span className="w-state" data-tone={paused || stale ? 'unknown' : state.tone}>
    <i aria-hidden="true" />{paused ? 'Paused' : stale ? 'Last known' : state.label}
  </span>;
}
function AppMark({ app, small = false }) {
  const id = String(app.id || '').split(':')[0];
  const known = DEFAULT_APPS.find((a) => id.startsWith(a.id));
  return <span className={`w-appmark${small ? ' w-appmark--small' : ''}`} data-app={known?.id || 'custom'} aria-hidden="true">
    {known?.mark || String(app.label || '?').slice(0, 1).toUpperCase()}
  </span>;
}
function Toggle({ checked, disabled, onChange, title, description }) {
  return <label className="w-setting">
    <span><strong>{title}</strong><small>{description}</small></span>
    <span className="w-toggle"><input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span aria-hidden="true" /></span>
  </label>;
}

export function WorkspaceView({ demo = false }) {
  const shared = useStore(selectMonitor);
  const [data, setData] = useState(() => demo ? previewSnapshot() : shared || null);
  const [loading, setLoading] = useState(!demo && !shared);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [now, setNow] = useState(Date.now());
  const settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };

  const request = useCallback(async (path, body, signal) => {
    const response = await fetch(path, {
      signal: signal || AbortSignal.timeout(30000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let message;
      try { message = (await response.json()).error; } catch { /* status below is safe to display */ }
      throw new Error(message || `Could not update the desktop companion (${response.status}).`);
    }
    const next = await response.json();
    if (!next || typeof next !== 'object' || !Array.isArray(next.apps)) throw new Error('The desktop companion returned an incomplete update.');
    store.set({ desktopMonitor: next }, { type: 'desktopMonitor' });
    return next;
  }, []);

  useEffect(() => { if (!demo && shared) { setData(shared); setLoading(false); } }, [demo, shared]);
  useEffect(() => {
    if (demo) return undefined;
    const controller = new AbortController();
    let active = true;
    const read = async () => {
      try {
        const next = await request('/desktop-monitor', undefined, controller.signal);
        if (active) { setData(next); setError(''); }
      } catch (e) { if (active && e.name !== 'AbortError') setError(e.message); }
      finally { if (active) setLoading(false); }
    };
    read();
    const timer = setInterval(() => { if (!document.hidden) read(); }, 15000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [demo, request]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);

  const mutate = async (path, body, label = 'save') => {
    if (busy) return;
    setBusy(label); setError('');
    try {
      if (demo) setData((previous) => ({ ...previous, ...body, settings: { ...previous.settings, ...body }, updatedAt: Date.now() }));
      else setData(await request(path, body));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  const save = (patch) => mutate('/desktop-monitor/settings', patch);
  const apps = Array.isArray(data?.apps) ? data.apps : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const enabled = Boolean(data?.enabled);
  const paused = Boolean(data?.paused);
  const stopped = !enabled || paused;
  const updatedAt = timestamp(data?.updatedAt);
  const stale = Boolean(enabled && !paused && updatedAt && now - updatedAt > Math.max(90000, settings.intervalSeconds * 4000));
  const attention = apps.filter((app) => ['attention', 'error'].includes(stateOf(app).tone));
  const working = apps.filter((app) => stateOf(app).tone === 'working');
  const detected = apps.filter((app) => !['offline', 'closed', 'unavailable', 'not_running'].includes(app.state));
  const visibleEvents = useMemo(() => events.filter((event) => filter === 'all' || (filter === 'attention'
    ? ['attention', 'error'].includes(stateOf(event).tone) : stateOf(event).tone === 'complete')).slice(0, 30), [events, filter]);
  const summary = typeof data?.summary === 'string' ? data.summary : data?.summary?.text;
  const summarySource = data?.summary?.source;

  const addCustom = (e) => {
    e.preventDefault();
    const name = customName.trim().slice(0, 60);
    if (!name) return;
    if ((settings.customApps || []).some((value) => value.toLowerCase() === name.toLowerCase())) { setCustomName(''); return; }
    save({ customApps: [...(settings.customApps || []), name] }); setCustomName('');
  };
  const toggleApp = (id) => {
    const selected = settings.selectedApps || [];
    save({ selectedApps: selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] });
  };

  return <section className="w-workspace" aria-label="Desktop companion">
    <header className="w-head">
      <div><div className="w-eyebrow">Your desktop, together</div><h1>At a glance<span>.</span></h1>
        <p>A little awareness. Fewer trips between windows.</p>
      </div>
      <div className="w-head__actions">
        {demo && <span className="w-preview">Preview · sample activity</span>}
        <button className="w-button w-button--icon" type="button" aria-label="Desktop preferences" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="gear" size={17} /></button>
        <button className="w-button" type="button" disabled={Boolean(busy) || loading} onClick={() => save(enabled ? { paused: !paused } : { enabled: true, paused: false })}>
          <Icon name={!enabled || paused ? 'play' : 'pause'} size={13} />{!enabled ? 'Start watching' : paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </header>

    {(error || data?.error || data?.summaryError) && <div className="w-error" role="alert"><Icon name="alert" size={16} /><span>{error || data.error || data.summaryError}</span><button type="button" onClick={() => mutate('/desktop-monitor/refresh', {}, 'refresh')} disabled={Boolean(busy)}>Try again</button></div>}

    {settingsOpen && <section className="w-preferences" aria-label="Desktop preferences">
      <div className="w-sectionhead"><div><h2>Make this your workspace</h2><p>Choose what to watch. Change it whenever you like.</p></div><button className="w-button w-button--icon" type="button" aria-label="Close desktop preferences" onClick={() => setSettingsOpen(false)}><Icon name="x" size={16} /></button></div>
      <div className="w-appchoices">{DEFAULT_APPS.map((app) => <label key={app.id} className="w-appchoice" data-selected={(settings.selectedApps || []).includes(app.id)}>
        <input type="checkbox" checked={(settings.selectedApps || []).includes(app.id)} disabled={Boolean(busy)} onChange={() => toggleApp(app.id)} />
        <AppMark app={app} small /><span><strong>{app.label}</strong><small>{app.note}</small></span><Icon name="check" size={14} />
      </label>)}</div>
      <form className="w-addapp" onSubmit={addCustom}><label htmlFor="workspace-custom-app">Another app</label><div><input id="workspace-custom-app" value={customName} maxLength={60} placeholder="App or window name, e.g. Cursor" onChange={(e) => setCustomName(e.target.value)} /><button className="w-button" type="submit" disabled={!customName.trim() || Boolean(busy)}><Icon name="plus" size={14} />Add</button></div></form>
      {(settings.customApps || []).length > 0 && <div className="w-customapps">{settings.customApps.map((name) => <span key={name}>{name}<button type="button" aria-label={`Stop watching ${name}`} disabled={Boolean(busy)} onClick={() => save({ customApps: settings.customApps.filter((value) => value !== name) })}><Icon name="x" size={12} /></button></span>)}</div>}
      <div className="w-settinggrid">
        <Toggle title="OpenAI summaries" description="Send short app statuses and reply excerpts to OpenAI for a briefing. Off keeps them local." checked={settings.aiSummaries} disabled={Boolean(busy)} onChange={(aiSummaries) => save({ aiSummaries })} />
        <Toggle title="Quiet updates" description="Keep updates in this view without interrupting your work." checked={settings.quiet} disabled={Boolean(busy)} onChange={(quiet) => save({ quiet })} />
        <label className="w-setting"><span><strong>Check for changes</strong><small>Only meaningful changes enter your feed.</small></span><select value={settings.intervalSeconds} disabled={Boolean(busy)} onChange={(e) => save({ intervalSeconds: Number(e.target.value) })}><option value={10}>Every 10s</option><option value={15}>Every 15s</option><option value={30}>Every 30s</option><option value={60}>Every minute</option></select></label>
        <Toggle title="Desktop watching" description="Read selected local sessions and window signals. No clicking or typing." checked={enabled} disabled={Boolean(busy)} onChange={(value) => save({ enabled: value, paused: false })} />
      </div>
    </section>}

    <section className="w-brief" data-paused={stopped || stale} aria-label="Workspace briefing">
      <div className="w-brief__top"><span className="w-live"><i aria-hidden="true" />{loading ? 'Connecting' : !enabled ? 'Watching is off' : paused ? 'Watching paused' : stale ? 'Waiting for a fresh signal' : 'Desktop companion'}</span><span className="w-brief__time">{demo ? 'Sample briefing' : age(data?.updatedAt, now)}</span></div>
      <div className="w-brief__content"><div><h2>{loading ? 'Finding your workspace…' : !enabled ? 'Your work. A wider view.' : paused ? 'A little quiet, on purpose.' : attention.length ? `${attention.length === 1 ? 'One thing needs' : `${attention.length} things need`} a moment of your time.` : working.length ? 'Things are moving along.' : 'Room to focus.'}</h2>
        <p>{loading ? 'Connecting to the local desktop companion.' : !enabled ? 'Start watching to bring progress from your selected apps into one place.' : paused ? 'No new app observations are being collected. Your last updates stay here until you resume.' : stale ? 'The last observation is older than expected. Refresh to check the connection.' : summary || 'Keep your attention here. Useful changes from the apps you choose will appear below.'}</p>
        <span className="w-brief__source">{settings.aiSummaries && summary ? sourceName(summarySource || 'openai') : 'Local signals'}<span aria-hidden="true"> · </span>Read-only</span>
      </div><SignalOrbit state={loading || stopped || stale ? 'paused' : attention.length ? 'attention' : working.length ? 'working' : 'idle'} /></div>
    </section>

    <div className="w-statline" aria-label="Workspace counts">
      <div><strong>{loading || stopped || stale ? '—' : working.length}</strong><span>working</span></div>
      <div data-attention={!stopped && !stale && attention.length > 0}><strong>{loading || stopped || stale ? '—' : attention.length}</strong><span>need you</span></div>
      <div><strong>{loading || stale ? '—' : detected.length}</strong><span>{stopped || stale ? 'last seen' : 'detected'}</span></div>
      <button className="w-refresh" type="button" disabled={Boolean(busy) || loading || !enabled || paused} onClick={() => mutate('/desktop-monitor/refresh', {}, 'refresh')}><Icon name="update" size={14} className={busy === 'refresh' ? 'w-refreshing' : ''} />{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
    </div>

    <div className="w-columns">
      <section className="w-apps" aria-label="Watched apps"><div className="w-sectionhead"><div><h2>Your apps</h2><p>Progress, with a source behind it.</p></div><button type="button" className="w-textbutton" onClick={() => setSettingsOpen(!settingsOpen)}>Manage<Icon name="plus" size={12} /></button></div>
        {loading ? <div className="w-skeleton" role="status" aria-label="Loading apps">{[1, 2, 3].map((n) => <span key={n} />)}</div> : apps.length ? <div className="w-applist">{apps.map((app, index) => <article className="w-approw" key={app.id || index} data-tone={stateOf(app).tone}>
          <AppMark app={app} /><div className="w-approw__body"><div className="w-approw__top"><h3>{app.label || 'App'}</h3><StateBadge app={app} paused={stopped} stale={stale} /></div>
            {(app.project || app.windowTitle || app.title) && <div className="w-approw__title" title={app.windowTitle || app.title || app.project}>{app.project || app.windowTitle || app.title}</div>}
            <p title={app.detail || undefined}>{readableExcerpt(app.latest) ? <><span className="w-reported">Latest · </span>{readableExcerpt(app.latest)}</> : app.detail || (stateOf(app).tone === 'unknown' ? 'No readable progress signal is available for this app yet.' : 'Waiting for a new progress signal.')}</p>
            <div className="w-evidence"><span title={app.source || ''}>{sourceName(app.source)}</span>{app.confidence && <span title="Confidence in the observed status">{typeof app.confidence === 'number' ? (app.confidence >= .8 ? 'Direct signal' : 'Limited signal') : /high|exact|direct/.test(String(app.confidence)) ? 'Direct signal' : app.confidence === 'inferred' ? 'Inferred activity' : 'Limited signal'}</span>}<time>{age(app.lastActivity || app.updatedAt, now)}</time></div>
          </div>
        </article>)}</div> : <div className="w-empty"><span className="w-empty__icon"><Icon name="monitor" size={22} /></span><h3>{enabled ? 'No app signals yet' : 'Bring your work into view'}</h3><p>{enabled ? 'Open a selected app or add a window name in preferences. Background browser tabs may not expose their progress.' : 'Choose the apps you care about, then start watching. Halo will keep track without taking over.'}</p><button className="w-button" type="button" onClick={() => setSettingsOpen(true)}>Choose apps<Icon name="plus" size={13} /></button></div>}
      </section>

      <section className="w-feed" aria-label="Progress updates"><div className="w-sectionhead"><div><h2>The latest</h2><p>Changes worth coming back for.</p></div><span className="w-feed__count">{events.length}</span></div>
        <div className="w-filters" role="group" aria-label="Filter updates">{[['all', 'All updates'], ['attention', 'Needs you'], ['finished', 'Finished']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
        {visibleEvents.length ? <ol className="w-events">{visibleEvents.map((event, index) => <li key={event.id || `${event.appId}-${index}`} className="w-event" data-tone={stateOf(event).tone}>
          <span className="w-event__node" aria-hidden="true"><Icon name={stateOf(event).tone === 'attention' ? 'hand' : stateOf(event).tone === 'complete' ? 'check' : stateOf(event).tone === 'error' ? 'alert' : 'activity'} size={13} /></span>
          <div><div className="w-event__meta"><strong>{event.label || event.appId || 'Desktop'}{event.project ? ` · ${event.project}` : ''}</strong><time>{age(event.at, now)}</time></div><h3>{event.title || stateOf(event).label}</h3>{event.asked && <p>Task · {readableExcerpt(event.asked)}</p>}{event.detail && <p>{event.detail}</p>}<span className="w-event__source">{sourceName(event.source)}</span>{!demo && ['completed', 'waiting', 'failed'].includes(event.state) && <DesktopResultActions id={event.id} />}</div>
        </li>)}</ol> : <div className="w-feedempty"><Icon name={filter === 'attention' ? 'check' : 'activity'} size={22} /><h3>{filter === 'attention' ? 'Nothing needs you here.' : filter === 'finished' ? 'Finished work will land here.' : 'The next useful change goes here.'}</h3><p>{filter === 'attention' ? 'You can stay with what you are doing.' : 'Updates appear when a selected app reports a meaningful change.'}</p></div>}
      </section>
    </div>
    <footer className="w-foot"><Icon name="shield" size={13} /><span>Local sessions and readable windows. Hidden tabs and apps without a signal may show an unknown status.</span></footer>
  </section>;
}
