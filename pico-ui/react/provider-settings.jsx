import { useEffect, useState } from 'react';

export function ProviderSettings({ demo = false }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    fetch('/model-provider', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error('Provider settings are available on this computer only.');
      const next = await response.json();
      if (!controller.signal.aborted) setState(next);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [demo]);
  const save = async patch => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/model-provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: state.provider, model: state.model, ...patch }), signal: AbortSignal.timeout(15000) });
      const next = await response.json();
      if (!response.ok) throw Error(next.error || 'Could not change provider.');
      setState(next);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const saveKey = async event => {
    event.preventDefault();
    const value = key; setKey(''); setBusy(true); setError('');
    try {
      const response = await fetch('/model-provider/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: value }), signal: AbortSignal.timeout(15000) });
      const next = await response.json();
      if (!response.ok) throw Error(next.error || 'Could not save key securely.');
      setState(next);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="h-card">
    <div className="h-card__title">Optional: use Gemini API for Halo’s own replies</div>
    <div className="h-card__sub">To watch your Google Gemini app or gemini.google.com window, use Settings → Watching — no API key. No chat history access. Halo reply/action provider settings below are optional. Keep the existing environment or configure Gemini API for Halo’s own replies. Optional desktop AI briefings remain direct OpenAI-only.</div>
    <label className="h-kv"><span>Halo provider</span><select aria-label="Halo provider" disabled={demo || busy || !state} value={state?.provider || 'default'} onChange={event => save({ provider: event.target.value })}>
      <option value="default">Existing environment (OpenAI / configured)</option><option value="gemini">Google Gemini API</option>
    </select></label>
    <label className="h-kv"><span>Gemini model</span><select aria-label="Gemini model" disabled={demo || busy || !state || state.provider !== 'gemini'} value={state?.model || 'gemini-3.5-flash-lite'} onChange={event => save({ model: event.target.value })}>
      <option value="gemini-3.5-flash-lite">Flash-Lite · cheapest / fast default</option><option value="gemini-3.8-flash">Flash · optional higher quality</option>
    </select></label>
    <div className="h-card__sub">{state ? `${state.geminiKeyAvailable ? 'Gemini API key available; access not verified.' : 'Optional Gemini API key missing; Watching needs no API key. For API replies only, save a key securely below or set process environment GEMINI_API_KEY before starting Halo.'} ${state.geminiSelected ? 'Gemini selected; no automatic fallback to another provider.' : 'Gemini is optional and not selected.'}` : demo ? 'Provider changes are available in the installed bridge.' : 'Loading local provider configuration…'}</div>
    <form className="h-connections__key" onSubmit={saveKey}>
      <input className="h-input" type="password" autoComplete="off" aria-label="Gemini API key" placeholder="Gemini API key" value={key} onChange={event => setKey(event.target.value)} disabled={demo || busy || !state}/>
      <button disabled={demo || busy || !state || !key.trim()}>Save key securely</button>
    </form>
    <p className="h-card__sub">Secure saving requires Windows Credential Manager: Generic Credential Halo/Gemini. For non-Windows or development, set process environment GEMINI_API_KEY. Keys are never saved in Halo settings or .env files. An available key is not verified; saving makes no API call.</p>
    {state?.geminiSelected && <div className="h-kv"><span>Selected Gemini model</span><code>{state.geminiModel}</code></div>}
    {state?.effectiveModels && <div className="h-kv"><span>Configured models</span><code>{[...new Set(Object.values(state.effectiveModels))].join(" / ")}</code></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
