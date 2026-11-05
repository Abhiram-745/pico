import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { store } from '../pico-ui/src/store.js';
import { bridge, WebSocketTransport } from '../pico-ui/src/bridge.js';
import { monitorRequest, acceptMonitorSnapshot } from '../pico-ui/src/monitor-client.js';

const snapshot = (instanceId, revision, patch = {}) => ({ instanceId, revision, updatedAt: 1, enabled: true, paused: false, apps: [{ resultId: 'mail', dismissed: false }], settings: { quiet: false }, ...patch });
const stream = state => bridge.receive({ type: 'desktopMonitor', payload: state });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = state => ({ ok: true, status: 200, json: async () => state });

// Load the real exported JSX ingress functions. Unused UI imports are marked
// side-effect-free so no DOM, effect library or application data is required.
async function jsxIngress() {
  const dir = await mkdtemp(join(tmpdir(), 'halo-monitor-ingress-'));
  const result = await build({
    stdin: { contents: "export { desktopRequest } from './pico-ui/react/desktop-results.jsx'; export { workspaceRequest } from './pico-ui/react/workspace.jsx';", resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'transform', treeShaking: true,
    plugins: [{ name: 'offline-ui-ingress', setup(builder) {
      builder.onResolve({ filter: /monitor-client\.js$/ }, args => ({ path: resolve(args.resolveDir, args.path), external: true }));
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === './pico-ui/react/desktop-results.jsx' || args.path === './pico-ui/react/workspace.jsx') return;
        // These imports serve the unrendered components only. Their exports are
        // left external and removed by tree shaking of the ingress-only entry.
        if (args.kind === 'import-statement') return { path: args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : args.path, external: true, sideEffects: false };
      });
    } }],
  });
  const path = join(dir, 'ingress.mjs'); await writeFile(path, result.outputFiles[0].text);
  let module;
  try { module = await import(pathToFileURL(path)); } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { ...module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('real desktop and Workspace HTTP ingress cannot overwrite newer stream dismiss/pause/settings at identical collection time', async () => {
  const ingress = await jsxIngress(); const original = globalThis.fetch;
  try {
    for (const [kind, request] of [['desktop', () => ingress.desktopRequest('/refresh')], ['workspace', () => ingress.workspaceRequest('/desktop-monitor')]]) {
      for (const [change, patch] of [['dismiss', { apps: [{ resultId: 'mail', dismissed: true }] }], ['pause', { paused: true }], ['settings', { settings: { quiet: true, intervalSeconds: 120 } }]]) {
        const instance = `${kind}-${change}`; stream(snapshot(instance, 10));
        const old = snapshot(instance, 10); const pending = deferred(); globalThis.fetch = () => pending.promise;
        const http = request(); stream(snapshot(instance, 11, patch));
        pending.resolve(response(old));
        const returned = await http;
        assert.equal(returned, store.state.desktopMonitor); assert.equal(returned.revision, 11);
        for (const [key,value] of Object.entries(patch)) assert.deepEqual(returned[key], value);
      }
    }
  } finally { globalThis.fetch = original; await ingress.cleanup(); }
});
test('previous-instance responses cannot win after reconnect; new bridge accepts lower revisions and collection time', async () => {
  const ingress = await jsxIngress(); const original = globalThis.fetch;
  try {
    stream(snapshot('restart-old', 900)); const pending = deferred(); globalThis.fetch = () => pending.promise;
    const http = ingress.workspaceRequest('/desktop-monitor');
    stream(snapshot('restart-new', 0, { updatedAt: null, apps: [], paused: true }));
    pending.resolve(response(snapshot('restart-old', 901)));
    const result = await http; assert.equal(result.instanceId, 'restart-new'); assert.equal(result.revision, 0);
    stream(snapshot('restart-old', 902)); assert.equal(store.state.desktopMonitor.instanceId, 'restart-new');
    globalThis.fetch = async () => response(snapshot('restart-old', 903)); await ingress.desktopRequest('/refresh');
    assert.equal(store.state.desktopMonitor.instanceId, 'restart-new');
    globalThis.fetch = async () => response(snapshot('restart-new', 1, { paused: true }));
    assert.equal((await ingress.workspaceRequest('/desktop-monitor')).revision, 1);
  } finally { globalThis.fetch = original; await ingress.cleanup(); }
});
test('aborted HTTP results, including abort during JSON decoding, never enter the store or a caller return', async () => {
  const ingress = await jsxIngress(); const original = globalThis.fetch;
  try {
    for (const request of [signal => ingress.desktopRequest('/refresh', {}, signal), signal => ingress.workspaceRequest('/desktop-monitor', undefined, signal)]) {
      stream(snapshot('abort-ingress', store.state.desktopMonitor.instanceId === 'abort-ingress' ? 20 : 10));
      const before = store.state.desktopMonitor, decoded = deferred(), controller = new AbortController();
      globalThis.fetch = async () => ({ ok: true, json: () => decoded.promise });
      const http = request(controller.signal); await Promise.resolve(); controller.abort();
      decoded.resolve(snapshot('abort-ingress', 30)); await assert.rejects(http, { name: 'AbortError' });
      assert.equal(store.state.desktopMonitor, before);
    }
  } finally { globalThis.fetch = original; await ingress.cleanup(); }
});
test('equal/older revisions do not emit or erase dismissal; an HTTP revision newer than stream is accepted', async () => {
  stream(snapshot('revision-order', 10)); let updates = 0;
  const unsubscribe = store.subscribe((_state, meta) => { if (meta.type === 'desktopMonitor') updates++; });
  const original = globalThis.fetch;
  try {
    stream(snapshot('revision-order', 10, { paused: true })); stream(snapshot('revision-order', 9));
    assert.equal(updates, 0);
    globalThis.fetch = async () => response(snapshot('revision-order', 11, { paused: true }));
    await monitorRequest('/desktop-monitor'); assert.equal(updates, 1); assert.equal(store.state.desktopMonitor.paused, true);
    acceptMonitorSnapshot({ apps: [] }, { source: 'stream' }); assert.equal(updates, 1);
  } finally { unsubscribe(); globalThis.fetch = original; }
});
test('all UI monitor ingress uses the centralized path; Workspace renders shared state without a second HTTP snapshot copy', async () => {
  const files = ['app.jsx','workspace.jsx','desktop-results.jsx'];
  for (const file of files) {
    const source = await readFile(new URL(`../pico-ui/react/${file}`, import.meta.url), 'utf8');
    assert.match(source, /monitorRequest/); assert.doesNotMatch(source, /store\.set\(\{\s*desktopMonitor/);
    assert.doesNotMatch(source, /fetch\([^\n]*desktop-monitor/);
    if (file === 'workspace.jsx') {
      assert.match(source, /useCallback\(workspaceRequest/);
      assert.match(source, /const data = demo \? demoData : shared/);
      assert.doesNotMatch(source, /setData\((?:next|shared|await request)/);
    }
  }
  const source = await readFile(new URL('../pico-ui/src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /case 'desktopMonitor':\s*acceptMonitorSnapshot\(payload, \{ source: 'stream' \}\)/);
});
test('reconnected transport ignores messages and close events from an obsolete socket', () => {
  const original = globalThis.WebSocket, sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor() { this.listeners = {}; sockets.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send() {}
    fire(type, payload) { this.listeners[type]?.({ data: JSON.stringify(payload) }); }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const statuses = [], transport = new WebSocketTransport('ws://offline', { onStatus: value => statuses.push(value) });
    transport.onMessage(message => bridge.receive(message));
    transport.connect(); const old = sockets[0]; old.fire('message', { type: 'paired', payload: { ok: true } });
    old.fire('message', { type: 'desktopMonitor', payload: snapshot('socket-old', 100) });
    transport.connect(); const current = sockets[1]; current.fire('message', { type: 'paired', payload: { ok: true } });
    current.fire('message', { type: 'desktopMonitor', payload: snapshot('socket-new', 0) });
    old.fire('message', { type: 'desktopMonitor', payload: snapshot('socket-old', 101) }); old.fire('close');
    assert.equal(store.state.desktopMonitor.instanceId, 'socket-new'); assert.equal(transport.paired, true); assert.equal(statuses.at(-1), 'connected');
  } finally { globalThis.WebSocket = original; }
});
