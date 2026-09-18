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
   only in host, key and model names — except that desktop turns go through
   the Responses API where the provider has one (see respond()).
   -------------------------------------------------------------------------- */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    // Tool calls go through the Responses API. Chat Completions refuses a
    // reasoning effort alongside function tools for these models, and the
    // old code quietly retried without one — so every step, every aim and
    // every plan ran with no reasoning at all.
    responses: true,
    // fast  chat, classification
    // see   operating the desktop: reading the screen, choosing and aiming
    // plan  deciding what the task actually requires, once per task
    // hard  writing
    tiers: {
      fast: 'gpt-5.4-nano',
      hard: 'gpt-5.4-mini',
      see: 'gpt-5.4-mini',
      plan: 'gpt-5.4',
    },
    // Best first, and the first one the key can use wins. Measured on a page
    // of 51 labelled targets, from a screenshot of a 2560x1440 display sent
    // 1600 wide at full detail:
    //
    //   gpt-5.4-mini   80% of clicks inside the target, median 11.6px out
    //   gpt-5.6-luna   94-98% inside, median 2px out, about as fast
    //   gpt-5.6-terra  96% inside, 1.4px out, ten times the price
    //
    // For comparison, what Halo did before — mini, a 1024-wide picture, no
    // reasoning — landed 36% of clicks on the thing it meant, 47px out.
    prefer: {
      see: ['gpt-5.6-luna', 'gpt-5.4-mini'],
      plan: ['gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4'],
    },
  },
  /* xkiro — free models behind one shared key, so Halo works for everyone
     straight after install with nothing to paste. The key is deliberately
     built in: the models on it are free, and the owner chose to share it.
     A key of your own in .env (XKIRO_API_KEY) takes its place.

     Only models marked free are used, picked per job:
       see   the step-by-step desktop work: must read a screenshot and call a
             tool, and must land clicks — Qwen's Plus line is the strongest
             visual grounding on offer, and quick enough per step.
       plan  once per task, judgement over speed, and it also reads the
             screen — the largest Qwen with vision.
       fast  chat and routing: no picture, lowest latency — MiniMax's
             highspeed build.
       hard  longer writing, no picture — the largest text model.
     Each list is best first; check() takes the first this key can use. */
  xkiro: {
    label: 'xkiro (free models)',
    baseUrl: 'https://api.xkiro.com/v1',
    envKey: 'XKIRO_API_KEY',
    defaultKey: 'sk-xt-e9d6403a000bc72438205fdfbc991fad628bc3471f58096f',
    // Documented as Chat Completions; tool calls go that way.
    responses: false,
    tiers: {
      fast: 'minimax/minimax-m2.7-highspeed:free',
      hard: 'qwen/qwen3.7-max:free',
      see: 'qwen/qwen3.7-plus:free',
      plan: 'qwen/qwen3.8-max:free',
    },
    prefer: {
      see: ['qwen/qwen3.7-plus:free', 'qwen/qwen3-vl-plus:free', 'qwen/qwen3.7-flash:free', 'minimax/minimax-m3:free'],
      plan: ['qwen/qwen3.8-max:free', 'qwen/qwen3.7-plus:free', 'minimax/minimax-m3:free'],
      fast: ['minimax/minimax-m2.7-highspeed:free', 'minimax/minimax-m2.5-highspeed:free', 'qwen/qwen3.7-flash:free'],
      hard: ['qwen/qwen3.7-max:free', 'qwen/qwen3.8-max:free', 'minimax/minimax-m2.7:free'],
    },
  },
  bazaarlink: {
    label: 'BazaarLink',
    baseUrl: 'https://api.bazaarlink.ai/v1',
    envKey: 'BAZAARLINK_API_KEY',
    responses: false,
    tiers: {
      fast: 'auto:free',
      hard: 'deepseek/deepseek-v4-flash',
      see: 'deepseek/deepseek-v4-flash',
      plan: 'deepseek/deepseek-v4-flash',
    },
    prefer: {},
  },
};

/** Chat Completions' tool shape, flattened for the Responses API. */
const responsesTool = (t) => ({
  type: 'function',
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
  strict: false,
});

/** A lower effort to try when a model refuses the one asked for. */
const EFFORT_FALLBACK = { max: 'high', xhigh: 'high', high: 'medium', medium: 'low', low: 'minimal', minimal: 'none', none: null };

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
  constructor({ apiKey, baseUrl, provider, tiers, pinned = {} }) {
    this.apiKey = apiKey;
    this.provider = provider;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.tiers = tiers;
    this.pinned = pinned;          // tiers set explicitly in .env, never replaced
    this.model = tiers.fast;
    this.onDowngrade = null;
    this._noReasoningEffort = false;
    this._responses = PROVIDERS[provider]?.responses !== false;
    this._effort = new Map();      // model -> the effort it last accepted
    this._noOriginal = new Set();  // models that refuse full-detail pictures
  }

  static async fromEnv() {
    const env = { ...(await loadEnv()), ...process.env };

    // Explicit choice wins. Otherwise the shared free models: they need no
    // key from anyone, so every install works on its first start.
    const wanted = (env.PICO_PROVIDER || '').toLowerCase();
    const order = wanted && PROVIDERS[wanted] ? [wanted] : ['xkiro', 'openai', 'bazaarlink'];

    for (const name of order) {
      const p = PROVIDERS[name];
      const apiKey = env[p.envKey] || p.defaultKey;
      if (!apiKey) continue;

      return new LLM({
        apiKey,
        baseUrl: env.PICO_BASE_URL || p.baseUrl,
        provider: name,
        tiers: {
          fast: env.PICO_MODEL_FAST || p.tiers.fast,
          hard: env.PICO_MODEL_HARD || p.tiers.hard,
          see: env.PICO_MODEL_SEE || p.tiers.see,
          plan: env.PICO_MODEL_PLAN || p.tiers.plan,
        },
        pinned: {
          fast: Boolean(env.PICO_MODEL_FAST),
          hard: Boolean(env.PICO_MODEL_HARD),
          see: Boolean(env.PICO_MODEL_SEE),
          plan: Boolean(env.PICO_MODEL_PLAN),
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
    /* No call, and why, because the caller has to tell the difference.
       `tool_choice: 'required'` asks for an action and nothing else, but a
       model is free to answer with prose anyway — "I'll click the search bar
       next" — and the smaller and cheaper it is, the more often it does. That
       is not a decision, and the loop above must not read it as one. */
    if (!call) return { call: null, text: (message.content || '').trim(), why: 'no_call' };

    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      // Malformed arguments are the model's fault, not the user's. Treat the
      // turn as a no-op rather than crashing a run halfway through.
      return { call: null, text: '', why: 'bad_args' };
    }

    return {
      call: { name: call.function?.name, args, raw: call },
      text: (message.content || '').trim(),
    };
  }

  /**
   * One turn of the desktop loop, with reasoning: text and pictures in, a
   * single tool call out.
   *
   * Through the Responses API, which is the only way these models take a
   * reasoning effort and function tools in the same request. Falls back to
   * Chat Completions (without the effort) for a provider that has no
   * Responses API, so nothing that worked before stops working.
   *
   * @param {object} req
   * @param {string} req.model
   * @param {string} req.system
   * @param {Array}  req.content  [{type:'text', text} | {type:'image', b64, mime, detail}]
   * @param {Array}  req.tools    function tools, in the Chat Completions shape
   * @param {string} [req.effort] reasoning effort
   * @returns {Promise<{call:{name,args}|null, text:string, usage:object|null}>}
   */
  async respond({ model, system, content, tools, effort = 'low', maxTokens = 3000, signal }) {
    const useModel = model || this.tiers.see;

    if (!this._responses) {
      return this.toolCall([
        { role: 'system', content: system },
        {
          role: 'user',
          content: content.map((c) => (c.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${c.mime};base64,${c.b64}`, detail: c.detail === 'original' ? 'high' : (c.detail || 'high') } }
            : { type: 'text', text: c.text })),
        },
      ], { model: useModel, tools, maxTokens, signal, effort: 'none' });
    }

    // A model that turned an effort down before is asked for what it took.
    const asked = this._effort.has(useModel) ? this._effort.get(useModel) : effort;
    // Full-detail pictures are what make clicks land, but only newer models
    // take them; an older one is sent the most it will accept instead.
    const detailFor = (d) => (d === 'original' && this._noOriginal.has(useModel) ? 'high' : (d || 'high'));

    const body = {
      model: useModel,
      instructions: system,
      input: [{
        role: 'user',
        content: content.map((c) => (c.type === 'image'
          ? { type: 'input_image', image_url: `data:${c.mime};base64,${c.b64}`, detail: detailFor(c.detail) }
          : { type: 'input_text', text: c.text })),
      }],
      tools: tools.map(responsesTool),
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_output_tokens: maxTokens,
      store: false,
    };
    if (asked) body.reasoning = { effort: asked };

    let res;
    try {
      res = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new Error(`Could not reach the model provider: ${this.redact(err.message)}`);
    }

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON */ }

    if (!res.ok) {
      const message = json?.error?.message || '';
      // No Responses API behind this address: use the other one from now on.
      if (res.status === 404 && !/model/i.test(message)) {
        this._responses = false;
        return this.respond({ model: useModel, system, content, tools, effort, maxTokens, signal });
      }
      // The effort was refused: step it down and remember what worked.
      if (res.status === 400 && asked && /reasoning|effort/i.test(message)) {
        this._effort.set(useModel, EFFORT_FALLBACK[asked] ?? null);
        return this.respond({ model: useModel, system, content, tools, effort, maxTokens, signal });
      }
      // Full detail refused: this model gets high detail from now on.
      if (res.status === 400 && /detail/i.test(message) && !this._noOriginal.has(useModel)
        && content.some((c) => c.type === 'image' && c.detail === 'original')) {
        this._noOriginal.add(useModel);
        return this.respond({ model: useModel, system, content, tools, effort, maxTokens, signal });
      }
      throw this._error(res.status, json);
    }

    // Reasoning can use the whole budget and leave nothing for the answer.
    // Once, with more room, rather than failing a step over it.
    if (json?.status === 'incomplete' && json?.incomplete_details?.reason === 'max_output_tokens' && maxTokens < 12000) {
      return this.respond({ model: useModel, system, content, tools, effort, maxTokens: maxTokens * 2, signal });
    }

    const output = Array.isArray(json?.output) ? json.output : [];
    const text = output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .map((c) => c.text || '')
      .join('')
      .trim();
    const usage = json?.usage ?? null;
    const call = output.find((o) => o.type === 'function_call');
    if (!call) return { call: null, text, usage, why: 'no_call' };

    let args = {};
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return { call: null, text, usage, why: 'bad_args' };
    }
    return { call: { name: call.name, args, raw: call }, text, usage };
  }

  /* ------------------------------------------------------------------------
     Talking
     ---------------------------------------------------------------------- */

  static CHAT_SYSTEM =
    'You are Halo, a small agent that lives on the user\'s Windows desktop ' +
    'and operates it for them: opening apps and sites, clicking, typing, ' +
    'messaging, finding things.\n\n' +
    'Be brief and plain — two or three sentences unless more is genuinely ' +
    'needed. No lists unless asked. Never claim to have done something on ' +
    'their computer.\n\n' +
    'IF THEY WANT SOMETHING DONE ON THEIR COMPUTER — including a yes, "do it", ' +
    '"go ahead" or impatience after something you offered, or a request with ' +
    'typos — do not describe it, do not offer, do not ask them to switch modes. ' +
    'Reply with exactly one line and nothing else:\n' +
    'TASK: <the job as one imperative sentence, with every detail from the ' +
    'conversation, e.g. "Open Discord in the browser and go to the group chat called claude">\n' +
    'Halo then does it. Only talk when they are talking, asking a question, ' +
    'or want something written back to them.';

  /**
   * A conversational reply, streamed so it appears as it is written.
   * @param {Array} history  prior turns as { role, content }
   */
  async converse(history, { onDelta, signal, name = 'Halo', facts = '' } = {}) {
    // What the person has told Halo to keep (memory.mjs) goes in with every
    // reply, so "what's my brother called?" is answered rather than asked.
    const system = [
      LLM.CHAT_SYSTEM,
      name && name !== 'Halo' ? `The user has named you ${name}. Answer to it.` : '',
      facts,
    ].filter(Boolean).join('\n\n');

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

  /**
   * Liveness probe used at start-up, which also picks the best model this
   * key can use for each job. The list of models comes back with the probe
   * anyway, and a key that can use a model measured to click more accurately
   * should not be left on one that clicks less accurately.
   */
  async check() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      try {
        const body = await res.json();
        this.adopt((body?.data || []).map((m) => m.id));
      } catch { /* a probe that answers but lists nothing keeps the defaults */ }
      return { ok: true, provider: this.provider, tiers: this.tiers };
    } catch (err) {
      return { ok: false, reason: this.redact(err.message) };
    }
  }

  /** Move each unpinned tier to the first preferred model on offer. */
  adopt(available = []) {
    const have = new Set(available);
    if (!have.size) return;
    const prefer = PROVIDERS[this.provider]?.prefer ?? {};
    for (const [tier, list] of Object.entries(prefer)) {
      if (this.pinned[tier]) continue;
      const pick = list.find((m) => have.has(m));
      if (pick) this.tiers[tier] = pick;
    }
  }
}
