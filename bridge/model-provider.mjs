import { LLM, GEMINI_MODELS, geminiAllowed } from './llm.mjs';
import { desktopRequestAllowed } from './desktop-routes.mjs';

// Non-secret preferences only. Environment loading and persistence are injected
// so offline tests never read real keys, files or credential stores.
export class ModelProviderSettings {
  constructor({ loadEnvironment = async () => ({}), loadGeminiKey = async () => '', saveGeminiKey = async () => { throw new Error('Key saving requires Windows Credential Manager.'); }, preferences = {}, persist = () => {}, onChange = () => {}, canChange = () => true } = {}) {
    this.loadGeminiKey = loadGeminiKey; this.saveGeminiKey = saveGeminiKey; this.loadEnvironment = loadEnvironment; this.persist = persist; this.onChange = onChange; this.canChange = canChange;
    this.preferences = { provider: preferences.provider === 'gemini' ? 'gemini' : 'default', model: geminiAllowed(preferences.model) ? preferences.model : GEMINI_MODELS[0] };
    this.environment = null; this.busy = false;
  }
  invalidateEnvironment() { this.environment = null; }
  async env() {
    if (this.environment) return this.environment;
    const env = { ...await this.loadEnvironment() };
    if (!env.GEMINI_API_KEY) env.GEMINI_API_KEY = await this.loadGeminiKey().catch(() => '');
    return this.environment = env;
  }
  async saveKey(patch) {
    if (!patch || typeof patch.key !== 'string' || Object.keys(patch).some(k => k !== 'key') || !patch.key.trim() || patch.key.length > 1024) throw new Error('Invalid key.');
    if (this.busy || !this.canChange()) throw Object.assign(new Error('Wait for Halo to finish or stop the current reply/task before saving a key.'), { status: 409 });
    this.busy = true;
    try {
      await this.saveGeminiKey(patch.key.trim());
      this.invalidateEnvironment();
      const state = await this.state();
      if (state.geminiSelected) {
        const llm = await this.createLLM();
        if (!this.canChange()) throw Object.assign(new Error('Key saved; stop the current task, then select Gemini to apply it.'), { status: 409 });
        this.onChange(llm, { provider: 'gemini', model: state.geminiModel });
      }
      return state;
    } finally { this.busy = false; }
  }
  async createLLM(preferences = this.preferences) {
    const env = { ...await this.env() };
    if (preferences.provider === 'gemini') {
      env.PICO_PROVIDER = 'gemini'; env.GEMINI_MODEL = preferences.model;
      // A saved explicit Gemini model owns every tier; unrelated OpenAI
      // PICO_MODEL_* preferences must not redirect an individual Gemini tier.
      for (const tier of ['FAST', 'TEXT', 'HARD', 'SEE', 'PLAN']) delete env[`PICO_MODEL_${tier}`];
    }
    return LLM.fromEnv({ env });
  }
  async state() {
    const env = await this.env();
    const llm = await this.createLLM();
    const geminiSelected = this.preferences.provider === 'gemini' || (this.preferences.provider === 'default' && String(env.PICO_PROVIDER).toLowerCase() === 'gemini');
    const geminiModel = this.preferences.provider === 'gemini' ? this.preferences.model : [env.GEMINI_MODEL, env.PICO_MODEL].find(geminiAllowed) || GEMINI_MODELS[0];
    return { ...this.preferences, geminiModel, geminiSelected, geminiKeyAvailable: Boolean(env.GEMINI_API_KEY), models: GEMINI_MODELS, configuredOnly: true, effectiveProvider: llm?.provider || (geminiSelected ? 'gemini' : null), effectiveModels: llm?.tiers || null };
  }
  async select(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['provider','model'].includes(key)) || !['default','gemini'].includes(patch.provider) || (patch.model !== undefined && !geminiAllowed(patch.model))) throw Object.assign(new Error('Choose Gemini Flash-Lite, Flash, or the existing provider configuration.'), { status: 400 });
    if (this.busy || !this.canChange()) throw Object.assign(new Error('Wait for Halo to finish or stop the current reply/task before switching provider.'), { status: 409 });
    this.busy = true;
    try {
      const next = { provider: patch.provider, model: patch.model || this.preferences.model };
      const llm = await this.createLLM(next); // Constructs only; no models probe or completion.
      if (!this.canChange()) throw Object.assign(new Error('Halo started working; stop the current task before switching provider.'), { status: 409 });
      this.persist(next); // Existing local JSON persistence is synchronous; contains no key.
      this.preferences = next;
      this.onChange(llm, next);
      return this.state();
    } finally { this.busy = false; }
  }
}
export async function handleModelProviderRoutes(req, res, path, settings) {
  if (!['/model-provider', '/model-provider/key'].includes(path)) return false;
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!desktopRequestAllowed(req)) { reply(403, { error: 'Model provider settings are local-only.' }); return true; }
  try {
    if (req.method === 'GET' && path === '/model-provider') reply(200, await settings.state());
    else if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2048) { reply(413, { error: 'Request too large.' }); return true; } }
      let patch; try { patch = JSON.parse(raw); } catch { reply(400, { error: 'Invalid JSON.' }); return true; }
      reply(200, await (path === '/model-provider/key' ? settings.saveKey(patch) : settings.select(patch)));
    } else reply(405, { error: 'Unsupported request.' });
  } catch (error) {
    reply(error.status === 409 ? 409 : 400, { error: error.status === 409 ? 'Wait for Halo to finish or stop the current reply/task, then retry. If the key was saved, select Gemini to apply it.' : (path === '/model-provider/key' ? 'Could not save key. Secure saving requires Windows Credential Manager; process environment GEMINI_API_KEY is also supported.' : 'Could not change provider. Choose a supported option and check local configuration.') });
  }
  return true;
}
