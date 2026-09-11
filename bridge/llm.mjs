/* ==========================================================================
   Model provider.

   SECURITY
   The key is read from .env on this machine and never leaves this process.
   It is not sent to the phone, not embedded in any page, and `redact()`
   scrubs it from error text before anything is logged. .env is gitignored;
   .env.example is the committed template.

   Never import this from anything under phone/ or pico-ui/ — those run in a
   browser, where any key is readable.

   SPEED
   Three things matter, in this order:
     1. streaming — steps appear as they are produced instead of after the
        whole response lands. This is most of the perceived speed.
     2. a small model — nano is built for low latency.
     3. not paying for reasoning we throw away — planning a few UI steps does
        not need an extended thinking budget.
   ========================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/* --------------------------------------------------------------------------
   Providers. Both speak the OpenAI Chat Completions shape, so they differ
   only in host, key and model names.
   -------------------------------------------------------------------------- */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    // nano is the low-latency one; mini handles real writing
    tiers: { fast: 'gpt-5.4-nano', hard: 'gpt-5.4-mini' },
  },
  bazaarlink: {
    label: 'BazaarLink',
    baseUrl: 'https://api.bazaarlink.ai/v1',
    envKey: 'BAZAARLINK_API_KEY',
    tiers: { fast: 'auto:free', hard: 'deepseek/deepseek-v4-flash' },
  },
};

/** Minimal .env parser — no dependency for something this small. */
async function loadEnv() {
  const out = {};
  let text;
  try {
    text = await readFile(ENV_PATH, 'utf8');
  } catch {
    return out;   // no .env is a valid state; the bridge falls back to scripted mode
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/* Signals that a task needs the stronger model. Deliberately conservative:
   misrouting down costs quality, misrouting up costs money and latency. */
const HARD_SIGNALS = [
  /\band then\b|\bafter that\b|\bthen\b.*\bthen\b/i,        // chained steps
  /\bfor each\b|\bevery\b|\ball of\b|\beach of\b/i,         // iteration
  /\bcompare\b|\banalys[ei]|\banalyz[ei]|\bsummaris|\bsummariz|\bresearch\b/i,
  /\bacross\b|\bbetween\b.*\band\b/i,                       // several surfaces
  // bare "report" is too broad — "rename the report file" is trivial
  /\bspreadsheet\b|\bexcel\b|\bcsv\b|\binvoices\b/i,
  /\b(?:write|draft|compose|generate|reply to)\b.*\b(?:email|message|reply|post|report|summary)\b/i,
  /\bif\b.*\bthen\b|\botherwise\b|\bunless\b/i,             // conditionals
];

/** @returns {'fast'|'hard'} */
export function classify(task) {
  const t = String(task || '').trim();
  if (!t) return 'fast';
  if (t.length > 180) return 'hard';
  const clauses = t.split(/[,;.]|\band\b/i).filter((c) => c.trim().length > 8);
  if (clauses.length >= 4) return 'hard';
  return HARD_SIGNALS.some((re) => re.test(t)) ? 'hard' : 'fast';
}

export class LLM {
  constructor({ apiKey, baseUrl, provider, tiers }) {
    this.apiKey = apiKey;
    this.provider = provider;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.tiers = tiers;
    this.model = tiers.fast;
    this.onDowngrade = null;
  }

  static async fromEnv() {
    const env = { ...(await loadEnv()), ...process.env };

    // Explicit choice wins; otherwise prefer whichever key is present, with
    // OpenAI first because it is the faster of the two.
    const wanted = (env.PICO_PROVIDER || '').toLowerCase();
    const order = wanted && PROVIDERS[wanted] ? [wanted] : ['openai', 'bazaarlink'];

    for (const name of order) {
      const p = PROVIDERS[name];
      const apiKey = env[p.envKey];
      if (!apiKey) continue;

      return new LLM({
        apiKey,
        baseUrl: env.PICO_BASE_URL || p.baseUrl,
        provider: name,
        tiers: {
          fast: env.PICO_MODEL_FAST || p.tiers.fast,
          hard: env.PICO_MODEL_HARD || p.tiers.hard,
        },
      });
    }
    return null;
  }

  /** Strip the key from anything on its way to a log or a client. */
  redact(text) {
    const s = String(text ?? '');
    return this.apiKey ? s.split(this.apiKey).join('sk-***') : s;
  }

  /** GPT-5 family renamed the token cap and fixes temperature at 1. */
  _body(model, messages, maxTokens, stream) {
    const body = { model, messages, stream };
    if (/^gpt-5/.test(model)) {
      body.max_completion_tokens = maxTokens;
      // Planning a handful of UI steps does not need an extended budget, and
      // asking for one is most of the latency on a reasoning-capable model.
      body.reasoning_effort = 'minimal';
    } else {
      body.max_tokens = maxTokens;
      body.temperature = 0.3;
    }
    return body;
  }

  _post(model, messages, { maxTokens, stream, signal }) {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this._body(model, messages, maxTokens, stream)),
      signal: signal ?? AbortSignal.timeout(90_000),
    });
  }

  _error(status, body) {
    const msg = body?.error?.message || `HTTP ${status}`;
    if (status === 401) return new Error('The API key was rejected. Check your key in .env.');
    if (status === 402) return new Error('Out of credits with this provider.');
    if (status === 429) return new Error('Rate limited. Try again in a moment.');
    if (status === 404) return new Error(`Model not available to this key: ${this.redact(msg)}`);
    return new Error(this.redact(msg));
  }

  /**
   * Stream a completion. Calls `onDelta(chunk)` as tokens arrive and resolves
   * with the full text.
   */
  async stream(messages, { model, maxTokens = 400, onDelta, signal } = {}) {
    const useModel = model || this.model;
    let res;
    try {
      res = await this._post(useModel, messages, { maxTokens, stream: true, signal });
    } catch (err) {
      throw new Error(`Could not reach the model provider: ${this.redact(err.message)}`);
    }

    if (!res.ok) {
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* non-JSON error body */ }

      // Paid tier unreachable — drop to the fast tier once rather than failing.
      if (res.status === 402 && useModel !== this.tiers.fast) {
        this.onDowngrade?.(useModel, this.tiers.fast);
        return this.stream(messages, { model: this.tiers.fast, maxTokens, onDelta, signal });
      }
      throw this._error(res.status, body);
    }

    // Server-sent events: lines of `data: {json}`, terminated by `data: [DONE]`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';          // keep the partial line for next read

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const piece = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (piece) { full += piece; onDelta?.(piece); }
        } catch { /* a partial frame; the next read completes it */ }
      }
    }
    return full.trim();
  }

  /** Non-streaming, for short calls where streaming buys nothing. */
  async chat(messages, { model, maxTokens = 300, signal } = {}) {
    const useModel = model || this.model;
    let res;
    try {
      res = await this._post(useModel, messages, { maxTokens, stream: false, signal });
    } catch (err) {
      throw new Error(`Could not reach the model provider: ${this.redact(err.message)}`);
    }

    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* non-JSON */ }

    if (!res.ok) {
      if (res.status === 402 && useModel !== this.tiers.fast) {
        this.onDowngrade?.(useModel, this.tiers.fast);
        return this.chat(messages, { model: this.tiers.fast, maxTokens, signal });
      }
      throw this._error(res.status, body);
    }
    return (body?.choices?.[0]?.message?.content || '').trim();
  }

  /* ------------------------------------------------------------------------
     Planning
     ---------------------------------------------------------------------- */
  static PLAN_SYSTEM =
    'You plan actions for a Windows desktop agent. Reply with 3 to 6 short ' +
    'imperative steps, one per line, numbered "1." to "6.". Each step is one ' +
    'concrete UI action: opening an app, clicking a control, typing text. ' +
    'No preamble, no commentary, no markdown.';

  static parseSteps(text) {
    return String(text)
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
      .filter((l) => l.length > 2 && l.length < 160)
      .slice(0, 6);
  }

  /**
   * Plan a task, emitting each step through `onStep` the moment its line
   * completes — so the first step lands in a few hundred ms rather than after
   * the whole plan.
   */
  async plan(task, { tier, onStep, signal } = {}) {
    const chosen = tier || classify(task);
    let emitted = 0;
    let acc = '';

    const text = await this.stream(
      [
        { role: 'system', content: LLM.PLAN_SYSTEM },
        { role: 'user', content: String(task) },
      ],
      {
        model: this.tiers[chosen],
        maxTokens: 400,
        signal,
        onDelta: (piece) => {
          if (!onStep) return;
          acc += piece;
          const lines = acc.split('\n');
          acc = lines.pop() ?? '';
          for (const line of lines) {
            const [step] = LLM.parseSteps(line);
            if (step && emitted < 6) { emitted++; onStep(step, emitted); }
          }
        },
      },
    );

    const steps = LLM.parseSteps(text);
    // Anything the streaming pass missed (a final line with no trailing \n).
    if (onStep) for (let i = emitted; i < steps.length; i++) onStep(steps[i], i + 1);
    return steps.length ? steps : [String(task).slice(0, 120)];
  }

  /** One-sentence closing summary. Always on the fast tier. */
  async summarise(task, steps) {
    return this.chat(
      [
        { role: 'system', content: 'Reply with one short factual past-tense sentence describing what was done. No preamble.' },
        { role: 'user', content: `Task: ${task}\nSteps taken:\n${steps.join('\n')}` },
      ],
      { model: this.tiers.fast, maxTokens: 200 },
    );
  }

  /** Cheap liveness probe used at start-up. */
  async check() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true, provider: this.provider, tiers: this.tiers };
    } catch (err) {
      return { ok: false, reason: this.redact(err.message) };
    }
  }
}
