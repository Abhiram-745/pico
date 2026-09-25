/* ==========================================================================
   Halo — host bridge

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
  'question',    // { id, text } | null — Halo needs one detail before starting
  'chatCleared', // {} — the thread was started over, here or on another device
  'plan',        // { steps: [{ do, kind, status }], index, doneWhen, finished?, succeeded? } | null
  'runFinished', // { task, steps, succeeded } — what "save as shortcut" would keep
  'memory',      // { facts } — everything Halo has been told to keep
  'routines',    // { items } — saved shortcuts
  'chats',       // { list, current } — every conversation, newest first
  'chatOpened',  // { id, messages } — an earlier chat, reopened in every window
  'chatSearch',  // { q, results } — only to the window that searched
  'shell',       // { mode: 'island'|'card', hidden, guide } — the shape Halo is in
  'focusChat',   // { at } — a chord asked for the box, focused and ready
  'chord',       // { id, at } — a global chord was pressed, whatever it was for
  'runbook',     // { routes, apps } — what Halo has worked out by doing jobs here
  'voiceSession',// { active, phase, level, message, transcript, owner }
  'voiceShortcut',// { available } — native registration succeeded
  'voiceToggle', // { at } — global shortcut toggled the notch microphone
  'voiceRelease', // { at, ms } — and was let go after ms: a hold means push-to-talk
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
  'setShell',     // { mode?, hidden?, guide?, toggle? } — island, card, hidden, guiding
  'moveCard',     // { x, y } — the floating card was dragged there
  'onboarded',    // {} — the chords have been practised; do not ask again
  'forgetRoutes', // {} — throw away what it learnt about doing things here
  'openNotch',    // {} — raise the notch window on the real desktop
  'closeNotch',   // {}
  'newChat',      // {} — forget the thread, here and in the host
  'skipStep',     // { index } — leave the step in hand and move on
  'steer',        // { text } — "no, the other one": a correction while it works
  'memoryAdd',    // { text }
  'memoryRemove', // { id }
  'memoryClear',  // {}
  'routineSave',  // { name, task? } — the last run, unless a task is given
  'routineRun',   // { id }
  'routineRename',// { id, name }
  'routineRemove',// { id }
  'openChat',     // { id }
  'chatRename',   // { id, title }
  'chatDelete',   // { id }
  'chatSearch',   // { q }
  'chatsImport',  // { chats } — history a window kept for itself before
  'openApp',      // { section? } — the full window, from the island
  'voiceSession', // { action: 'claim'|'update'|'end', owner, state? }
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
        store.setSummary(payload.text, payload.id);
        break;

      case 'plan':
        store.setPlan(payload);
        break;

      case 'voiceSession': {
        const previousVoice = store.state.voice;
        store.set({ voice: payload }, { type: 'voice', remote: true, previousVoice });
        break;
      }
      case 'voiceShortcut':
        store.set({ voiceShortcut: Boolean(payload.available) }, { type: 'voiceShortcut' });
        break;
      case 'voiceToggle':
        store.set({ voiceToggleAt: Number(payload.at) || Date.now() }, { type: 'voiceToggle' });
        break;
      case 'voiceRelease':
        store.set({ voiceHeldMs: Number(payload.ms) || 0 }, { type: 'voiceRelease' });
        break;

      case 'runFinished':
        store.setLastRun(payload);
        break;

      case 'memory':
        store.setMemory(payload.facts);
        break;

      case 'routines':
        store.setRoutines(payload.items);
        break;

      case 'chats':
        store.setChats(payload);
        break;

      case 'chatOpened':
        store.setQuestion(null);
        store.setApproval(null);
        store.setTakeover(null);
        store.setPlan(null);
        store.loadMessages(payload.messages);
        store.set({ chats: { ...store.state.chats, current: payload.id } }, { type: 'chats' });
        break;

      case 'chatSearch':
        store.setChatSearch(payload);
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

      // The shape Halo is in: island, card, hidden, guiding. One owner (the
      // bridge), so the island, the app and the phone never disagree.
      case 'shell':
        store.set({ shell: { mode: 'island', hidden: false, guide: false, ...payload } }, { type: 'shell' });
        break;

      case 'focusChat':
        store.set({ focusChatAt: Number(payload.at) || Date.now() }, { type: 'focusChat' });
        break;

      // Every chord, whatever it did — onboarding waits for these rather than
      // for keys in its own window, so what it teaches is what really works.
      case 'chord':
        store.set({ chord: { id: payload.id, at: Number(payload.at) || Date.now() } }, { type: 'chord' });
        break;

      case 'runbook':
        store.set({ runbook: { routes: Number(payload.routes) || 0, apps: payload.apps ?? [] } }, { type: 'runbook' });
        break;

      // Halo was quit from Settings: the bridge is about to go, on purpose.
      case 'quitting':
        store.set({ quitting: true }, { type: 'quitting' });
        break;

      case 'question':
        store.setQuestion(payload);
        break;

      // Someone started a new chat — this window, the app window, or the
      // phone. They all show the same thread, so they all start over.
      case 'chatCleared':
        store.clearMessages();
        store.setPlan(null);
        store.setLastRun(null);
        store.setQuestion(null);
        store.setApproval(null);
        store.setTakeover(null);
        break;

      default:
        console.warn('[halo] unknown host event:', type);
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
    /* Backoff, but a short one, and it never decides how long a window sits
       there looking broken. Twenty seconds of waiting after a bridge restart
       is a window that shows yesterday's screen and answers nothing, which
       reads as the app being stuck rather than as it reconnecting. */
    this._retry = Math.min(this._retry + 1, 6);
    const delay = Math.min(400 * 2 ** (this._retry - 1), 4000);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), delay);
    this._watchWake();
  }

  /* Looking at the window is as good a reason to try again as a timer. A
     laptop that slept wakes with a dead socket and a full backoff still to
     run; the moment its window is in front, reconnect. */
  _watchWake() {
    if (this._wake) return;
    this._wake = () => {
      if (this._closed || this.paired) return;
      if (document.visibilityState === 'hidden') return;
      this._retry = 0;
      clearTimeout(this._timer);
      this.connect();
    };
    document.addEventListener('visibilitychange', this._wake);
    addEventListener('focus', this._wake);
    addEventListener('online', this._wake);
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
    if (this._wake) {
      document.removeEventListener('visibilitychange', this._wake);
      removeEventListener('focus', this._wake);
      removeEventListener('online', this._wake);
      this._wake = null;
    }
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
 *   webview2 — hosted inside Halo.Desktop
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
      // machine can drive Halo directly anyway.
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
