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
    // nano is the low-latency one; mini handles real writing.
    // `see` drives the desktop and has to read a screenshot accurately, which
    // nano does not do well enough to click with — it answers plausibly and
    // misses the control.
    tiers: { fast: 'gpt-5.4-nano', hard: 'gpt-5.4-mini', see: 'gpt-5.4-mini' },
  },
  bazaarlink: {
    label: 'BazaarLink',
    baseUrl: 'https://api.bazaarlink.ai/v1',
    envKey: 'BAZAARLINK_API_KEY',
    tiers: { fast: 'auto:free', hard: 'deepseek/deepseek-v4-flash', see: 'deepseek/deepseek-v4-flash' },
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
    this._noReasoningEffort = false;
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
          see: env.PICO_MODEL_SEE || p.tiers.see,
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
  _body(model, messages, { maxTokens, stream, tools, effort = 'none' }) {
    const body = { model, messages, stream };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'required';
      body.parallel_tool_calls = false;   // one action per turn, then look again
    }
    if (/^gpt-5/.test(model)) {
      body.max_completion_tokens = maxTokens;
      // Chatting and planning need no thinking budget, and asking for one is
      // most of the latency on a reasoning-capable model. Driving the desktop
      // is the exception: deciding whether a task is finished is a judgement,
      // and with no budget at all the model just repeats its last action.
      // The accepted values differ by model, so `_noReasoningEffort` drops
      // the parameter entirely if one rejects it.
      if (!this._noReasoningEffort) body.reasoning_effort = effort;
    } else {
      body.max_tokens = maxTokens;
      body.temperature = 0.3;
    }
    return body;
  }

  _post(model, messages, opts) {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this._body(model, messages, opts)),
      signal: opts.signal ?? AbortSignal.timeout(90_000),
    });
  }

  /** Models disagree on which reasoning_effort values they accept. */
  _rejectsReasoningEffort(status, body) {
    return status === 400
      && !this._noReasoningEffort
      && /reasoning_effort/i.test(body?.error?.message || '');
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
      if (this._rejectsReasoningEffort(res.status, body)) {
        this._noReasoningEffort = true;
        return this.stream(messages, { model: useModel, maxTokens, onDelta, signal });
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
      if (this._rejectsReasoningEffort(res.status, body)) {
        this._noReasoningEffort = true;
        return this.chat(messages, { model: useModel, maxTokens, signal });
      }
      throw this._error(res.status, body);
    }
    return (body?.choices?.[0]?.message?.content || '').trim();
  }

  /* ------------------------------------------------------------------------
     Driving the desktop
     ---------------------------------------------------------------------- */

  /**
   * One turn of the desktop loop: a screenshot in, a single tool call out.
   *
   * Not streamed on purpose. A tool call is only useful once its arguments
   * are complete, so streaming it would buy nothing but complexity — the
   * perceived speed here comes from acting between turns, not from watching
   * JSON arrive.
   *
   * @returns {Promise<{call:{name,args,raw}|null, text:string}>}
   */
  async toolCall(messages, { model, tools, maxTokens = 1400, signal, effort = 'low' } = {}) {
    const useModel = model || this.tiers.see || this.model;
    let res;
    try {
      res = await this._post(useModel, messages, { maxTokens, stream: false, signal, tools, effort });
    } catch (err) {
      throw new Error(`Could not reach the model provider: ${this.redact(err.message)}`);
    }

    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* non-JSON error body */ }

    if (!res.ok) {
      if (this._rejectsReasoningEffort(res.status, body)) {
        this._noReasoningEffort = true;
        return this.toolCall(messages, { model: useModel, tools, maxTokens, signal, effort });
      }
      throw this._error(res.status, body);
    }

    const message = body?.choices?.[0]?.message ?? {};
    const call = message.tool_calls?.[0];
    if (!call) return { call: null, text: (message.content || '').trim() };

    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      // Malformed arguments are the model's fault, not the user's. Treat the
      // turn as a no-op rather than crashing a run halfway through.
      return { call: null, text: '' };
    }

    return {
      call: { name: call.function?.name, args, raw: call },
      text: (message.content || '').trim(),
    };
  }

  /* ------------------------------------------------------------------------
     Talking
     ---------------------------------------------------------------------- */

  static CHAT_SYSTEM =
    'You are Pico, a small agent that lives on the user\'s Windows desktop ' +
    'and can operate it for them. Right now you are talking, not working.\n\n' +
    'Be brief and plain — two or three sentences unless more is genuinely ' +
    'needed. No lists unless asked. Never claim to have done something on ' +
    'their computer; in this mode you have not touched it.\n\n' +
    'If they seem to want something done, say what you would do and that they ' +
    'can send it again as a task.';

  /**
   * A conversational reply, streamed so it appears as it is written.
   * @param {Array} history  prior turns as { role, content }
   */
  async converse(history, { onDelta, signal, name = 'Pico' } = {}) {
    const system = name && name !== 'Pico'
      ? `${LLM.CHAT_SYSTEM}\n\nThe user has named you ${name}. Answer to it.`
      : LLM.CHAT_SYSTEM;

    return this.stream(
      [{ role: 'system', content: system }, ...history],
      { model: this.tiers.fast, maxTokens: 500, onDelta, signal },
    );
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
