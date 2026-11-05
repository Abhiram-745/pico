/* Desktop watching — the tick list in Settings, and the live step line the
   cards share. Ticking a row saves straight to the bridge's monitor
   (/desktop-monitor/settings), and the row answers from what the monitor
   actually found, so a tick is never a promise the bridge cannot keep:
   "4 sessions · 1 working" or "Nothing found at ~/.claude/projects". */

import { useState } from 'react';
import { useStore } from './hooks.js';
import { Bot, useMascotState } from './bot.jsx';
import { desktopRequest } from './desktop-results.jsx';

const SOURCES = [
  { id: 'gemini', label: 'Watch Gemini', hint: 'Detect your Google Gemini app or gemini.google.com window; no API key, no chat history scrape. Open until progress controls are visible' },
  { id: 'whatsapp', label: 'WhatsApp', hint: 'Opt-in Desktop/Web window-title unread badge; no message content' },
  { id: 'claude', label: 'Claude', hint: 'Claude Code and Claude Desktop sessions' },
  { id: 'codex', label: 'Codex', hint: 'Codex CLI and app threads' },
  { id: 'chrome', label: 'Chrome', hint: 'Browser windows — chats like Lovable or Grok show up by title' },
  { id: 'lovable', label: 'Lovable', hint: 'Window title only' },
  { id: 'grok', label: 'Grok', hint: 'Window title only' },
  { id: 'cursor', label: 'Cursor', hint: 'Editor window' },
  { id: 'vscode', label: 'VS Code', hint: 'Editor window' },
  { id: 'chatgpt', label: 'ChatGPT', hint: 'Desktop app window' },
];

const monitorOf = (s) => s.desktopMonitor;

/** The Watching switch: a knob that springs across, a clear On/Off word, and a soft glow while on. */
export function WatchSwitch({ on, busy = false, disabled = false, onChange, label = 'Watching' }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="h-switch"
      data-on={on} data-busy={busy} disabled={disabled || busy} onClick={() => onChange?.(!on)}>
      <span className="h-switch__track" aria-hidden="true"><span className="h-switch__knob" /></span>
      <span className="h-switch__word">{busy ? '…' : on ? 'On' : 'Off'}</span>
    </button>
  );
}

/** One short line for the live step, with a thin bar when the agent keeps a plan. */
export function StepLine({ app }) {
  if (!app || (!app.step && !app.progress)) return null;
  const p = app.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div className="h-step" data-live={app.state === 'working'}>
      {app.step && <span className="h-step__text"><i aria-hidden="true" />{app.step}</span>}
      {p?.total > 0 && (
        <span className="h-step__plan" title={p.current || undefined}>
          <span className="h-step__bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}><b style={{ width: `${pct}%` }} /></span>
          <small>{p.done}/{p.total}{p.current ? ` · ${p.current}` : ''}</small>
        </span>
      )}
    </div>
  );
}

/** Which session a card is linked to: the app it came from and the session's own name and id. */
export function LinkLabel({ app }) {
  if (!app || app.source !== 'transcript' || !app.origin) return null;
  return (
    <div className="h-link" title={`${app.origin} session ${app.ref || ''}`.trim()}>
      <span className="h-link__kind" data-linked={app.linked}>{app.linked ? 'Linked' : 'Local transcript'}</span>
      <span className="h-link__text">{app.origin}{app.project ? ` · ${app.project}` : ''}{app.ref ? <code>#{app.ref}</code> : null}</span>
    </div>
  );
}

function describe(source, monitor) {
  const mine = (monitor?.apps ?? []).filter((a) => a.appId === source.id);
  const sessions = mine.filter((a) => a.source === 'transcript');
  const working = mine.filter((a) => a.state === 'working').length;
  const waiting = mine.filter((a) => a.state === 'waiting').length;
  const info = monitor?.sources?.[source.id];
  const bits = [];
  if (info) {
    if (!info.available) return { tone: 'none', text: `Nothing found at ${info.path} yet` };
    bits.push(`${sessions.length} recent ${sessions.length === 1 ? 'session' : 'sessions'}`);
    if (info.linked) bits.push(`linked to the ${info.linkedLabel}`);
  } else if (mine.length) {
    bits.push(`${mine.length} open ${mine.length === 1 ? 'window' : 'windows'}`);
  } else {
    bits.push('Not seen yet');
  }
  if (working) bits.push(`${working} working`);
  if (waiting) bits.push(`${waiting} need you`);
  return { tone: waiting ? 'waiting' : working ? 'working' : mine.length ? 'idle' : 'none', text: bits.join(' · ') };
}

export function WatchSources({ demo = false }) {
  const monitor = useStore(monitorOf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = monitor?.settings?.selectedApps ?? ['claude', 'codex', 'chrome', 'lovable', 'grok'];
  const enabled = Boolean(monitor?.enabled);
  const anyWorking = (monitor?.apps ?? []).some((a) => a.state === 'working');
  const face = useMascotState(anyWorking ? 'working' : enabled ? 'idle' : 'idle');

  const save = async (patch) => {
    if (demo || busy) return;
    setBusy(true); setError('');
    try { await desktopRequest('/settings', patch); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const toggle = (id) => save({ selectedApps: selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id] });

  return (
    <div className="h-card h-watch">
      <div className="h-card__row">
        <div className="h-card__main">
          <div className="h-card__title">Desktop watching</div>
          <div className="h-card__sub">
            Tick the chats and apps Halo should keep an eye on. It observes local agent sessions and visible window signals. WhatsApp uses only its title badge, never message content. Each row tells you what it found.
          </div>
        </div>
        <Bot size={40} state={face} paused={!enabled} />
      </div>

      <div className="h-watch__list" role="group" aria-label="Apps to watch">
        {SOURCES.map((s) => {
          const on = selected.includes(s.id);
          const d = on ? describe(s, monitor) : null;
          return (
            <label key={s.id} className="h-watch__row" data-src={s.id} data-on={on} data-tone={d?.tone ?? 'off'}>
              <input type="checkbox" checked={on} disabled={busy || demo} onChange={() => toggle(s.id)} />
              <span className="h-watch__tick" aria-hidden="true" />
              <span className="h-watch__icon" aria-hidden="true" />
              <span className="h-watch__body">
                <strong>{s.label}</strong>
                <small>{on ? d.text : s.hint}</small>
              </span>
              <span className="h-watch__dot" aria-hidden="true" />
            </label>
          );
        })}
      </div>

      <div className="h-watch__foot">
        <span>{enabled ? (monitor?.paused ? 'Watching is paused.' : 'Watching now — ticks apply immediately.') : 'Watching is off. Ticks are saved; start Desktop mode to see them live.'}</span>
        <WatchSwitch on={enabled && !monitor?.paused} busy={busy} disabled={demo}
          onChange={(next) => save(next ? { enabled: true, paused: false } : { paused: true })} />
      </div>
      {error && <div className="h-card__sub" role="alert">{error}</div>}
    </div>
  );
}
