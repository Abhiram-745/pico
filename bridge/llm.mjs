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
     2. a fast model — Omni Flash is built for low latency.
     3. not paying for reasoning we throw away — planning a few UI steps does
        not need an extended thinking budget.
   ========================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/* --------------------------------------------------------------------------
   The provider: xkiro, and only xkiro.

   Free models behind one shared key, so Halo works for everyone straight
   after install with nothing to paste. The key is deliberately built in: the
   models on it are free, and the owner chose to share it. A key of your own
   in .env (XKIRO_API_KEY) takes its place.

   Every job runs on Qwen3.8-Omni-Flash. It reads screenshots, calls tools and
   answers quickly, so one model covers planning, the step-by-step desktop
   work, chat and writing alike.

   xkiro speaks OpenAI Chat Completions at /v1/chat/completions. Two things
   shape the requests below:
     - Qwen's Omni models only answer streamed requests, and xkiro cuts off
       blocking requests at 95 seconds anyway, so every call streams —
       tool calls included, assembled from their deltas.
     - Omni thinks by default. Most of Halo's calls are small decisions made
       against a screenshot, so the effort is asked for explicitly and
       dropped if the gateway refuses it.
   -------------------------------------------------------------------------- */
export const OMNI = 'qwen/qwen3.8-omni-flash:free';

export const PROVIDERS = {
  xkiro: {
    label: 'xkiro · Qwen3.8 Omni Flash',
    baseUrl: 'https://api.xkiro.com/v1',
    envKey: 'XKIRO_API_KEY',
    defaultKey: 'sk-xt-21c439cc2d0ffd1fbacf575bb15a1e5a1201bc42b2af5728',
    tiers: { fast: OMNI, hard: OMNI, see: OMNI, plan: OMNI },
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
    this.onRetry = null;
    this._noEffort = false;        // the gateway refused reasoning_effort once
    this._toolChoice = 'required'; // falls back to 'auto' if refused
  }

  static async fromEnv() {
    const env = { ...(await loadEnv()), ...process.env };
    const p = PROVIDERS.xkiro;
    const model = env.PICO_MODEL || OMNI;
    return new LLM({
      apiKey: env[p.envKey] || p.defaultKey,
      baseUrl: env.PICO_BASE_URL || p.baseUrl,
      provider: 'xkiro',
      tiers: {
        fast: env.PICO_MODEL_FAST || model,
        hard: env.PICO_MODEL_HARD || model,
        see: env.PICO_MODEL_SEE || model,
        plan: env.PICO_MODEL_PLAN || model,
      },
    });
  }

  /** Strip the key from anything on its way to a log or a client. */
  redact(text) {
    const s = String(text ?? '');
    return this.apiKey ? s.split(this.apiKey).join('sk-***') : s;
  }

  _body(model, messages, { maxTokens, tools, effort }) {
    const body = { model, messages, stream: true, max_tokens: maxTokens, temperature: 0.3 };
    if (tools) {
      body.tools = tools;
      body.tool_choice = this._toolChoice;
      body.parallel_tool_calls = false;   // one action per turn, then look again
    }
    if (effort && !this._noEffort) body.reasoning_effort = effort;
    return body;
  }

  _error(status, body) {
    const msg = body?.error?.message || `HTTP ${status}`;
    if (status === 401 || status === 403) return new Error('The xkiro key was rejected. Check XKIRO_API_KEY in .env.');
    if (status === 402) return new Error('Out of free tokens with xkiro for today.');
    if (status === 429) return new Error('Rate limited. Try again in a moment.');
    if (status === 404) return new Error(`Model not available to this key: ${this.redact(msg)}`);
    return new Error(this.redact(msg));
  }

  /**
   * One streamed request. Text arrives through `onDelta` as it is written;
   * tool calls arrive in pieces and are put back together here.
   *
   * @returns {Promise<{text:string, calls:Array<{name:string, arguments:string}>}>}
   */
  async _request(model, messages, { maxTokens = 400, tools = null, effort = 'none', onDelta, signal } = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(this._body(model, messages, { maxTokens, tools, effort })),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new Error(`Could not reach xkiro: ${this.redact(err.message)}`);
    }

    if (!res.ok) {
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* non-JSON error body */ }
      const message = String(body?.error?.message || '');
      const retry = () => this._request(model, messages, { maxTokens, tools, effort, onDelta, signal });

      if (res.status === 400 && !this._noEffort && effort && /reasoning|effort|thinking/i.test(message)) {
        this._noEffort = true;
        return retry();
      }
      if (res.status === 400 && tools && this._toolChoice === 'required' && /tool_choice|required/i.test(message)) {
        this._toolChoice = 'auto';
        return retry();
      }
      throw this._error(res.status, body);
    }

    // A gateway that ignores `stream` and answers in one piece is read as-is.
    if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not JSON either */ }
      const m = body?.choices?.[0]?.message ?? {};
      const text = String(m.content || '');
      if (text) onDelta?.(text);
      return {
        text: text.trim(),
        calls: (m.tool_calls || []).map((c) => ({ name: c.function?.name, arguments: c.function?.arguments || '' })),
      };
    }

    // Server-sent events: lines of `data: {json}`, terminated by `data: [DONE]`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const calls = [];

    const take = (payload) => {
      let frame;
      try { frame = JSON.parse(payload); } catch { return; }
      if (frame?.error) throw this._error(500, frame);
      const delta = frame?.choices?.[0]?.delta ?? frame?.choices?.[0]?.message;
      if (!delta) return;
      if (delta.content) { text += delta.content; onDelta?.(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        calls[i] ??= { name: '', arguments: '' };
        if (tc.function?.name) calls[i].name = tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    };

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
        if (payload && payload !== '[DONE]') take(payload);
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') take(tail.slice(5).trim());

    return { text: text.trim(), calls: calls.filter((c) => c?.name) };
  }

  /**
   * Stream a completion. Calls `onDelta(chunk)` as tokens arrive and resolves
   * with the full text.
   */
  async stream(messages, { model, maxTokens = 400, onDelta, signal } = {}) {
    const out = await this._request(model || this.model, messages, { maxTokens, onDelta, signal });
    return out.text;
  }

  /** A short reply, when nothing needs to watch it arrive. */
  async chat(messages, { model, maxTokens = 300, signal } = {}) {
    const out = await this._request(model || this.model, messages, { maxTokens, signal });
    return out.text;
  }

  /* ------------------------------------------------------------------------
     Driving the desktop
     ---------------------------------------------------------------------- */

  /**
   * One turn of the desktop loop: a screenshot in, a single tool call out.
   * @returns {Promise<{call:{name,args,raw}|null, text:string, why?:string}>}
   */
  async toolCall(messages, { model, tools, maxTokens = 1400, signal, effort = 'low' } = {}) {
    const out = await this._request(model || this.tiers.see, messages, { maxTokens, tools, effort, signal });
    const call = out.calls[0];
    /* No call, and why, because the caller has to tell the difference.
       `tool_choice: 'required'` asks for an action and nothing else, but a
       model is free to answer with prose anyway — "I'll click the search bar
       next" — and the loop above must not read that as a decision. */
    if (!call) return { call: null, text: out.text, why: 'no_call' };

    let args = {};
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      // Malformed arguments are the model's fault, not the user's. Treat the
      // turn as a no-op rather than crashing a run halfway through.
      return { call: null, text: out.text, why: 'bad_args' };
    }
    return { call: { name: call.name, args, raw: call }, text: out.text };
  }

  /**
   * One turn, and it has to come back usable.
   *
   * Asking for a tool and being handed prose instead is the commonest way a
   * model fails, and it used to cost a whole round trip to find out. So the
   * answer is checked before it is returned, and a failed check is put back
   * to the model with the specific complaint attached — up to three
   * attempts, inside the one turn the caller asked for. Adapted from
   * Agent-S's call_llm_formatted (Apache-2.0, simular-ai/Agent-S).
   *
   * @param {object} req
   * @param {string} req.model
   * @param {string} req.system
   * @param {Array}  req.content  [{type:'text', text} | {type:'image', b64, mime, detail}]
   * @param {Array}  req.history  earlier turns, [{role, content: same shape}]
   * @param {Array}  req.tools    function tools, in the Chat Completions shape
   * @param {string} [req.effort] reasoning effort
   * @param {Array<(out:object) => [boolean, string]>} [req.checks]
   *   each returns [ok, what to say if not]
   */
  async respond({ checks = [], ...req }) {
    const MAX_ATTEMPTS = 3;
    let extra = [];
    let out = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      out = await this._respondOnce({ ...req, content: [...req.content, ...extra] });
      if (!checks.length) return out;

      const problems = [];
      for (const check of checks) {
        let ok = true;
        let says = '';
        try { [ok, says] = check(out); } catch { ok = true; }
        if (!ok && says) problems.push(says);
      }
      if (!problems.length) return { ...out, attempts: attempt + 1 };

      this.onRetry?.(attempt + 1, problems);
      if (attempt === MAX_ATTEMPTS - 1) break;

      const said = String(out?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      extra = [{
        type: 'text',
        text: 'Your previous answer could not be used, and you are answering again to replace '
          + `it. Do not mention this message.${said ? ` You said: "${said}".` : ''} Fix these: `
          + problems.map((p) => `- ${p}`).join(' '),
      }];
    }
    return { ...out, attempts: MAX_ATTEMPTS, exhausted: true };
  }

  async _respondOnce({ model, system, content, history = [], tools, effort = 'low', maxTokens = 3000, signal }) {
    /* `history` is everything said so far, and it is what turns a sequence
       of unrelated questions into one conversation. What the assistant said
       goes back as plain text: a picture only ever comes from the user. */
    const asChat = (blocks, role) => {
      if (role === 'assistant') return blocks.filter((c) => c.type !== 'image').map((c) => c.text).join('\n');
      return blocks.map((c) => (c.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${c.mime};base64,${c.b64}` } }
        : { type: 'text', text: c.text }));
    };
    return this.toolCall([
      { role: 'system', content: system },
      ...history.map((m) => ({ role: m.role, content: asChat(m.content, m.role) })),
      { role: 'user', content: asChat(content, 'user') },
    ], { model: model || this.tiers.see, tools, maxTokens, signal, effort });
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

  /** Liveness probe used at start-up: is xkiro there, and does it list the model. */
  async check() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      let listed = null;
      try {
        const ids = ((await res.json())?.data || []).map((m) => m.id);
        if (ids.length) listed = ids.includes(this.tiers.see);
      } catch { /* answered, but listed nothing readable */ }
      return { ok: true, provider: this.provider, tiers: this.tiers, listed };
    } catch (err) {
      return { ok: false, reason: this.redact(err.message) };
    }
  }
}
