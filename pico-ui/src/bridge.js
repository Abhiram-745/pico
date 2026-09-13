/* ==========================================================================
   Pico — host bridge

   One transport-agnostic contract between the UI and whatever is driving it.

     production : WebView2   (window.chrome.webview)
     development: MockAgent  (mock/agent.js, in-process)

   Nothing above this file knows which one is attached. See INTEGRATION.md
   for the C# side.
   ========================================================================== */

import { store } from './store.js';

/** Messages the host pushes down to the UI. */
export const HOST_EVENTS = [
  'phase',       // { phase }
  'action',      // { type, detail }
  'approval',    // { id, summary, target, risk: { level, decision, categories, reason } }
  'takeover',    // { id, reason, appName }
  'pauseState',  // { paused, source, blockedReason?, heldModifiers? }
  'guardian',    // { ready }
  'settings',    // { model, pauseOnPhysicalInput, maximumComputerTurns, hasApiKey }
  'summary',     // { text } — written after a run completes
  'auditEvent',  // raw audit.jsonl record
  'error',       // { title, message, recoverable }
  'routed',      // { mode: 'chat'|'agent', why, source } — which fork was taken
  'message',     // { id, text, done } — a chat reply, streamed
  'cursor',      // { x, y, done } — where the pointer actually is, live
  'notch',       // { open } — whether the notch window is up
  'question',    // { id, text } | null — Pico needs one detail before starting
];

/** Commands the UI sends up to the host. */
export const UI_COMMANDS = [
  'submitTask',   // { text, mode?: 'auto'|'chat'|'agent' }
  'pause',        // {}
  'resume',       // {}
  'stop',         // {}
  'approve',      // { id }
  'deny',         // { id }
  'takeoverDone', // { id }
  'saveSettings', // { model?, pauseOnPhysicalInput?, maximumComputerTurns?, apiKey? }
  'setName',      // { name } — so replies answer to what you called it
  'answerQuestion', // { id, text } — the answer to the question it asked
  'tuckAway',     // {}
  'openPalette',  // {}
  'closePalette', // {}
  'movePalette',  // { x, y }
  'openNotch',    // {} — raise the notch window on the real desktop
  'closeNotch',   // {}
];

class Bridge {
  constructor() {
    this.transport = null;
    this._outbound = new Set();
  }

  attach(transport) {
    this.transport = transport;
    transport.onMessage((msg) => this.receive(msg));
    return this;
  }

  /** Host -> UI. Applies the message to the store. */
  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { type, payload = {} } = msg;

    switch (type) {
      case 'phase':
        store.setPhase(payload.phase, payload);
        break;

      case 'step':
        store.setStep(payload);
        break;

      case 'action':
        store.setAction(payload);
        break;

      case 'approval':
        store.setApproval(payload);
        store.setPhase('AwaitingApproval');
        break;

      case 'takeover':
        store.setTakeover(payload);
        store.setPhase('AwaitingTakeover');
        break;

      case 'pauseState':
        store.setPause(payload);
        if (payload.paused) store.setPhase('Paused');
        break;

      case 'guardian':
        store.setGuardian(payload);
        break;

      case 'settings':
        store.setSettings(payload);
        break;

      case 'summary':
        store.setSummary(payload.text);
        break;

      case 'auditEvent':
        store.pushEvent(payload);
        break;

      case 'error':
        store.setError(payload);
        store.setPhase('Failed');
        break;

      case 'routed':
        store.setRouted(payload);
        break;

      case 'message':
        store.setMessage(payload);
        break;

      case 'cursor':
        store.setCursor(payload);
        break;

      case 'notch':
        store.set({ notchOpen: Boolean(payload.open) }, { type: 'notch' });
        break;

      // Whether the pointer is on the island, answered by the bridge because
      // the island cannot answer it about itself. See watchHover.
      case 'notchHover':
        store.set({ notchHover: Boolean(payload.over) }, { type: 'notchHover' });
        break;

      case 'question':
        store.setQuestion(payload);
        break;

      default:
        console.warn('[pico] unknown host event:', type);
    }
  }

  /** UI -> host. */
  send(command, payload = {}) {
    if (!UI_COMMANDS.includes(command)) {
      throw new Error(`Unknown UI command: ${command}`);
    }
    for (const fn of this._outbound) fn(command, payload);
    this.transport?.post({ command, payload });
  }

  /** Observe outbound traffic (used by the dev harness's message log). */
  onSend(fn) {
    this._outbound.add(fn);
    return () => this._outbound.delete(fn);
  }
}

/* --------------------------------------------------------------------------
   WebView2 transport
   C# side:  webView.CoreWebView2.PostWebMessageAsJson(json)
             webView.CoreWebView2.WebMessageReceived += ...
   -------------------------------------------------------------------------- */
export class WebView2Transport {
  static isAvailable() {
    return typeof window !== 'undefined' && !!window.chrome?.webview;
  }

  onMessage(handler) {
    window.chrome.webview.addEventListener('message', (e) => {
      // e.data arrives already parsed when the host uses PostWebMessageAsJson
      handler(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    });
  }

  post(msg) {
    window.chrome.webview.postMessage(msg);
  }
}

/* --------------------------------------------------------------------------
   WebSocket transport — used by the phone companion over the LAN.

   Pairing is part of the transport: the socket carries nothing but the
   handshake until the bridge has issued a token. Once paired, the token is
   reused so the code is only ever typed once.
   -------------------------------------------------------------------------- */
export class WebSocketTransport {
  /**
   * @param {string} url  ws:// endpoint
   * @param {object} opts { code, token, onStatus, onPaired, onPairError }
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.opts = opts;
    this.ws = null;
    this.paired = false;
    this._handler = null;
    this._queue = [];
    this._retry = 0;
    this._closed = false;
  }

  onMessage(handler) { this._handler = handler; }

  connect() {
    this._closed = false;
    this._status('connecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this._retry = 0;
      // Prefer a stored token; fall back to the code the user just entered.
      const token = this.opts.token?.();
      const code = this.opts.code?.();
      ws.send(JSON.stringify(token ? { command: 'pair', token } : { command: 'pair', code }));
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'paired') {
        if (msg.payload?.ok) {
          this.paired = true;
          this._status('connected');
          this.opts.onPaired?.(msg.payload.token, msg.payload.name);
          for (const m of this._queue.splice(0)) this._raw(m);
        } else {
          this.paired = false;
          this._status('unpaired');
          this.opts.onPairError?.(msg.payload?.reason || 'Pairing failed.');
        }
        return;
      }

      if (this.paired) this._handler?.(msg);
    });

    ws.addEventListener('close', () => {
      this.paired = false;
      if (!this._closed) { this._status('reconnecting'); this._scheduleReconnect(); }
    });

    ws.addEventListener('error', () => { /* close fires next; handled there */ });
  }

  _scheduleReconnect() {
    // capped exponential backoff, so a sleeping laptop doesn't spin the phone
    this._retry = Math.min(this._retry + 1, 6);
    const delay = Math.min(1000 * 2 ** (this._retry - 1), 20_000);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), delay);
  }

  _status(s) { this.opts.onStatus?.(s); }

  _raw(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  post(msg) {
    if (!this.paired) { this._queue.push(msg); return; }
    this._raw(msg);
  }

  disconnect() {
    this._closed = true;
    clearTimeout(this._timer);
    this.ws?.close();
    this._status('offline');
  }
}

/* --------------------------------------------------------------------------
   In-process transport for the dev harness and the mock agent
   -------------------------------------------------------------------------- */
export class LocalTransport {
  constructor() {
    this._down = null;   // host -> ui
    this._up = null;     // ui -> host
  }

  onMessage(handler) { this._down = handler; }
  post(msg) { this._up?.(msg); }

  /** Called by the mock agent to push an event down to the UI. */
  emit(type, payload) { this._down?.({ type, payload }); }

  /** Called by the mock agent to listen for UI commands. */
  onCommand(handler) { this._up = handler; }
}

export const bridge = new Bridge();

/**
 * Attach the right transport for wherever this page is running.
 *
 *   webview2 — hosted inside Pico.Desktop
 *   bridge   — served by bridge/server.mjs, so the laptop's own UI shares
 *              live state with any paired phone
 *   mock     — opened from the standalone dev server
 */
export function connect({ onStatus } = {}) {
  if (WebView2Transport.isAvailable()) {
    bridge.attach(new WebView2Transport());
    return { mode: 'webview2', transport: bridge.transport };
  }

  // The bridge serves this page itself, and marks it so.
  if (typeof document !== 'undefined' && document.documentElement.dataset.picoBridge === 'true') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocketTransport(`${proto}//${location.host}/ws`, {
      // Loopback clients are auto-paired by the bridge: anyone already on the
      // machine can drive Pico directly anyway.
      token: () => null,
      code: () => null,
      onStatus,
    });
    bridge.attach(ws);
    ws.connect();
    return { mode: 'bridge', transport: ws };
  }

  const local = new LocalTransport();
  bridge.attach(local);
  return { mode: 'mock', transport: local };
}
