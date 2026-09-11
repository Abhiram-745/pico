/* ==========================================================================
   BazaarLink client — an OpenAI-compatible LLM gateway.

   SECURITY
   The API key is read from .env on the laptop and never leaves this process.
   It is not sent to the phone, not embedded in any page, and not written to
   any log — `redact()` below scrubs it from error text before anything is
   printed. .env is gitignored; .env.example is the committed template.

   Never import this from anything under phone/ or pico-ui/. Those run in a
   browser, where any key is readable by whoever opens devtools.

   SCOPE
   BazaarLink does not support the Responses API `computer_use_preview` tool
   (verified: 400 "The model service rejected the request parameters"), so it
   cannot drive Pico's desktop loop — that needs a model with the computer
   tool. It is used here for the things it does well: turning a task into a
   plan, and writing the closing summary.
   ========================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

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

export class LLM {
  constructor({ apiKey, baseUrl, model }) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || 'https://api.bazaarlink.ai/v1').replace(/\/+$/, '');
    this.model = model || 'auto:free';

    // Free tier is 20 requests/minute. Stay well under it rather than
    // discovering the limit with a 429 mid-task.
    this.minIntervalMs = 3500;
    this._lastCall = 0;
  }

  static async fromEnv() {
    const env = { ...(await loadEnv()), ...process.env };
    const apiKey = env.BAZAARLINK_API_KEY;
    if (!apiKey) return null;
    return new LLM({
      apiKey,
      baseUrl: env.BAZAARLINK_BASE_URL,
      model: env.PICO_MODEL,
    });
  }

  /** Strip the key from anything on its way to a log or a client. */
  redact(text) {
    const s = String(text ?? '');
    return this.apiKey ? s.split(this.apiKey).join('sk-bl-***') : s;
  }

  async _throttle() {
    const wait = this.minIntervalMs - (Date.now() - this._lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCall = Date.now();
  }

  /**
   * One chat completion. Returns the assistant text.
   * Throws an Error whose message is safe to show a user.
   */
  async chat(messages, { maxTokens = 1200, temperature = 0.3, signal, _retried = false } = {}) {
    await this._throttle();

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`Could not reach the model provider: ${this.redact(err.message)}`);
    }

    const raw = await res.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }

    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      // Map the errors this key will realistically hit to plain language.
      if (res.status === 401) throw new Error('The API key was rejected. Check BAZAARLINK_API_KEY in .env.');
      if (res.status === 402) throw new Error('This BazaarLink key is out of credits. Free routing needs a ":free" model.');
      if (res.status === 429) throw new Error('Rate limited by BazaarLink (free tier is 20 requests a minute). Try again shortly.');
      throw new Error(this.redact(msg));
    }

    const choice = body?.choices?.[0]?.message;
    const text = (choice?.content || '').trim();
    if (text) return text;

    // Free routing lands on reasoning models (qwen3.7-flash), which spend the
    // token budget thinking before they answer — a 400-token cap produced 505
    // reasoning tokens and an empty `content`. Retry once with room to finish
    // rather than surfacing a blank reply. `reasoning` is the model's
    // scratchpad, never the answer, so it is deliberately not used as a value.
    if (!_retried && choice?.reasoning) {
      return this.chat(messages, {
        maxTokens: Math.min(maxTokens * 2, 4000),
        temperature,
        signal,
        _retried: true,
      });
    }

    throw new Error('The model returned an empty response.');
  }

  /**
   * Turn a task into a short ordered plan.
   * Returns string[] — always, even if the model rambles.
   */
  async plan(task) {
    const text = await this.chat([
      {
        role: 'system',
        content:
          'You plan actions for a Windows desktop agent. Given a task, reply with 3 to 6 ' +
          'short imperative steps, one per line, numbered "1." to "6.". Each step is a single ' +
          'concrete UI action such as opening an app, clicking a control, or typing text. ' +
          'No preamble, no commentary, no markdown.',
      },
      { role: 'user', content: task },
    ], { maxTokens: 1400 });

    const steps = text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
      .filter((l) => l.length > 2 && l.length < 160)
      .slice(0, 6);

    return steps.length ? steps : [String(task).slice(0, 120)];
  }

  /** One-sentence closing summary for a finished run. */
  async summarise(task, steps) {
    return this.chat([
      {
        role: 'system',
        content: 'Reply with one short factual past-tense sentence describing what was done. No preamble.',
      },
      { role: 'user', content: `Task: ${task}\nSteps taken:\n${steps.join('\n')}` },
    ], { maxTokens: 900 });
  }

  /** Cheap liveness probe used at bridge start-up. */
  async check() {
    try {
      const res = await fetch(`${this.baseUrl}/key`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const { data } = await res.json();
      return {
        ok: true,
        label: data?.label,
        freeTier: data?.is_free_tier,
        rateLimit: data?.rate_limit,
      };
    } catch (err) {
      return { ok: false, reason: this.redact(err.message) };
    }
  }
}
