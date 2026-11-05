import { store } from './store.js';

// The bridge owns revisions, including dismiss/config/briefing changes which
// do not advance collection updatedAt. Only the event stream can replace an
// established bridge instance; an old HTTP response must never switch it back.
let generation = 0;
const retired = new Set();
export function beginMonitorRequest() { return generation; }
export function acceptMonitorSnapshot(next, { source = 'http', signal, requestGeneration = generation } = {}) {
  if (signal?.aborted || !next || !Array.isArray(next.apps)) return store.state.desktopMonitor;
  const current = store.state.desktopMonitor;
  const versioned = typeof next.instanceId === 'string' && Number.isSafeInteger(next.revision) && next.revision >= 0;
  if (requestGeneration !== generation && source === 'http') return current;
  if (current?.instanceId) {
    if (!versioned || retired.has(next.instanceId)) return current;
    if (next.instanceId === current.instanceId) {
      if (next.revision <= current.revision) return current;
    } else {
      if (source !== 'stream') return current;
      retired.add(current.instanceId);
      generation++;
    }
  } else if (versioned) {
    if (retired.has(next.instanceId)) return current;
    generation++;
  }
  store.set({ desktopMonitor: next }, { type: 'desktopMonitor' });
  return store.state.desktopMonitor;
}

// Every HTTP monitor ingress shares cancellation and monotonic acceptance.
export async function monitorRequest(path, { body, signal, method, timeoutMs = 30000 } = {}) {
  const requestGeneration = beginMonitorRequest();
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  requestSignal.throwIfAborted();
  const response = await fetch(path, {
    signal: requestSignal, method: method || (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const next = await response.json();
  requestSignal.throwIfAborted();
  if (!response.ok) throw new Error(next?.error || `Could not update desktop progress (${response.status}).`);
  if (Array.isArray(next?.apps)) return acceptMonitorSnapshot(next, { requestGeneration, signal: requestSignal });
  if (next?.opened === true) return next;
  throw new Error('The desktop companion returned an incomplete update.');
}
