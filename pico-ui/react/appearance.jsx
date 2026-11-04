import { useEffect, useId, useState } from 'react';
import { Icon } from './parts.jsx';

const KEY = 'halo.theme.v1';
const OPTIONS = new Set(['system', 'light', 'dark']);
const subscribers = new Set();
let preference = 'system';
let initialized = false;
let systemTheme = null;
let revision = 0;
let saveQueue = Promise.resolve();

const validPreference = value => OPTIONS.has(value) ? value : 'system';
const hasBridge = () => document.documentElement.dataset.picoBridge === 'true';
function receiveAppearance(next) {
  if (!OPTIONS.has(next)) return;
  revision++;
  preference = next;
  try { localStorage.setItem(KEY, preference); } catch { /* Keep this window usable without storage. */ }
  applyAppearance();
}
function applyAppearance() {
  if (typeof document === 'undefined') return;
  const resolved = preference === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  for (const notify of subscribers) notify(preference);
}

/** Idempotent: importing on either app surface also updates future OS changes. */
export function initializeAppearance() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try { preference = validPreference(localStorage.getItem(KEY)); } catch { /* Private browsing keeps this session's choice. */ }
  try {
    systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    if (systemTheme.addEventListener) systemTheme.addEventListener('change', applyAppearance);
    else systemTheme.addListener?.(applyAppearance);
  } catch { /* A browser without matchMedia uses light for System. */ }
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== null) return;
    revision++;
    preference = validPreference(event.newValue);
    applyAppearance();
  });
  // The floating island has a separate browser profile. Bridge events sync
  // its preference with the app without depending on shared localStorage.
  window.addEventListener('halo:appearance', event => receiveAppearance(event.detail?.preference));
  applyAppearance();
  if (hasBridge()) {
    const startedAt = revision;
    fetch('/appearance', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(saved => {
        // A user choice or live replay arriving during the GET wins.
        if (revision === startedAt && saved) receiveAppearance(saved.preference);
      }).catch(() => { /* Offline: the saved local preference remains active. */ });
  }
}

export function setAppearance(next) {
  initializeAppearance();
  const chosen = validPreference(next);
  receiveAppearance(chosen);
  if (hasBridge()) {
    // Serialize rapid selections so the server persists the final choice.
    saveQueue = saveQueue.catch(() => {}).then(() => fetch('/appearance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preference: chosen }),
    })).catch(() => { /* The local choice still works if the bridge is gone. */ });
  }
}

initializeAppearance();

export function AppearanceControl() {
  const id = useId();
  const [selected, setSelected] = useState(preference);
  useEffect(() => {
    initializeAppearance();
    subscribers.add(setSelected);
    setSelected(preference);
    return () => subscribers.delete(setSelected);
  }, []);
  return <div className="h-appearance">
    <label htmlFor={id}><Icon name="monitor" size={14} /><span>Appearance</span></label>
    <select id={id} value={selected} onChange={event => setAppearance(event.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </div>;
}
