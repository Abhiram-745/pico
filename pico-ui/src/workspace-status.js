// Both island sizes use the same evidence, including dismissal and freshness.
function workspaceEvidence(monitor, now) {
  if (!monitor?.enabled) return { mode: 'off' };
  if (monitor.paused) return { mode: 'paused' };
  if (monitor.updatedAt == null || now - monitor.updatedAt > 180_000) return { mode: 'stale' };
  const apps = (monitor.apps || []).filter(a => !a.dismissed && ['waiting', 'failed', 'completed', 'working', 'unavailable'].includes(a.state));
  apps.sort((a,b) => (b.changedAt ?? b.lastActivity ?? b.updatedAt ?? 0) - (a.changedAt ?? a.lastActivity ?? a.updatedAt ?? 0) || String(a.id || `${a.appId}:${a.project}:${a.state}:${a.detail}`).localeCompare(String(b.id || `${b.appId}:${b.project}:${b.state}:${b.detail}`)));
  return { mode: 'live', latest: apps[0] || (monitor.apps || []).find(a => !a.dismissed && a.appId === 'gemini' && a.state === 'open'), error: monitor.error };
}

export function workspaceStatus(monitor, now = Date.now()) {
  const { mode, latest, error } = workspaceEvidence(monitor, now);
  if (mode === 'off') return 'Watching is off';
  if (mode === 'paused') return 'Monitoring paused';
  if (mode === 'stale') return 'Watch data is stale · refresh Workspace';
  if (latest && now - (latest.observedAt ?? latest.updatedAt ?? monitor.updatedAt) > 330_000) return `${latest.label} · last observation is stale`;
  if (latest) return `${latest.label}${latest.project ? ` · ${latest.project}` : ''}: ${latest.latest || latest.step || latest.detail || latest.state}`;
  return error || 'Watching for activity';
}

export function workspaceCompactStatus(monitor, now = Date.now()) {
  const { mode, latest, error } = workspaceEvidence(monitor, now);
  if (mode === 'off') return 'Watching off';
  if (mode === 'paused') return 'Watching paused';
  if (mode === 'stale') return 'Watch stale · refresh';
  if (!latest) return error ? 'Watch unavailable' : 'Watching';
  const name = latest.label || 'App';
  if (now - (latest.observedAt ?? latest.updatedAt ?? monitor.updatedAt) > 330_000) return `${name} stale`;
  if (latest.state === 'open') return `${name} open`;
  if (latest.state === 'unavailable') return `${name} unavailable`;
  if (latest.state === 'working') return `${name} working`;
  if (latest.state === 'failed') return `${name} needs review`;
  if (latest.state === 'completed') return `${name} ready to review`;
  if (latest.appId === 'whatsapp' && latest.source === 'window-title') {
    const count = /^\d+$/.test(String(latest.contentKey)) ? Number(latest.contentKey) : null;
    return `${name}${count ? ` ${count}` : ''} unread`;
  }
  if (['gmail', 'outlook'].includes(latest.appId) && latest.source === 'composio') return `${name} unread`;
  if (latest.appId === 'googlecalendar' && latest.source === 'composio') return `${name} event soon`;
  return `${name} needs you`;
}

// Only current evidence can interrupt; historical event cards remain reviewable.
export function workspaceNotice(monitor, seen, now = Date.now(), foreground = false) {
  if (!seen || !monitor?.enabled || monitor.paused || monitor.settings?.quiet || foreground) return null;
  const priority = { failed: 3, waiting: 2, completed: 1 };
  return [...(monitor.events || [])].sort((a,b) => (priority[b.state] || 0) - (priority[a.state] || 0) || b.at - a.at || String(a.id).localeCompare(String(b.id))).find(event =>
    !seen.has(event.id) && now - event.at >= 0 && now - event.at <= 60000 &&
    ['waiting', 'completed', 'failed'].includes(event.state) &&
    monitor.apps?.some(app => app.resultId === event.id && !app.dismissed)) || null;
}

// A retained flash holds geometry under hover, but stops owning the words.
export function islandFlashActive(flash, beatOver) {
  return Boolean(flash && (!beatOver || flash.kind === 'fail'));
}
