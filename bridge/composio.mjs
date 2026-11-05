import { monitorText } from './desktop-monitor.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { loadComposioKey, saveComposioKey } from './composio-secret.mjs';
export const WATCH_SLUGS = Object.freeze(['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'OUTLOOK_QUERY_EMAILS', 'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES', 'OUTLOOK_GET_CALENDAR_VIEW', 'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS']);
export const DRAFT_SLUGS = Object.freeze(['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_UPDATE_DRAFT', 'GMAIL_GET_DRAFT']);
export const SEND_SLUGS = Object.freeze(['GMAIL_SEND_DRAFT', 'GMAIL_REPLY_TO_THREAD']);
export const APPS = Object.freeze(['gmail', 'outlook', 'googlecalendar', 'slack']);
const appOf = slug => slug.split('_')[0].toLowerCase();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class HaloComposio {
  #client; #key; #session; #approvals = new Map(); #schemas = new Map(); #signals = []; #lastPoll = null; #nextPoll = 0; #pollBusy = null; #providers = new Map(); #faults = 0; #watchCalls = new Map(); #watchJobs = new Map(); #watchEpoch = 0; #revoked = new Set();
  constructor({ now = Date.now, config = {}, client = null, key = process.env.COMPOSIO_API_KEY, loadKey = loadComposioKey, saveKey = saveComposioKey, guardian = async () => false, scheduler = { setTimeout, clearTimeout } } = {}) {
    this.now = now; this.scheduler = scheduler;
    this.config = { enabled: false, watchApps: [], userId: 'halo-local', selectedAccounts: {}, ...config };
    this.#client = client; this.#key = key; this.loadKey = loadKey; this.saveKey = saveKey; this.guardian = guardian;
  }
  state() { return { enabled: this.config.enabled, hasKey: Boolean(this.#key || this.#client), watchApps: this.config.watchApps, oauthAvailable: this.config.enabled, userId: this.config.userId, selectedAccounts: this.config.selectedAccounts, cadence: this.watchCadence() }; }
  configure(patch) {
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw new Error('Invalid feature toggle.');
    if ('watchApps' in patch && (!Array.isArray(patch.watchApps) || patch.watchApps.some(x => !APPS.includes(x) || x === 'slack'))) throw new Error('Invalid watch app.');
    if ('userId' in patch && (typeof patch.userId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(patch.userId))) throw new Error('Invalid local user ID.');
    if ('selectedAccounts' in patch && (!patch.selectedAccounts || typeof patch.selectedAccounts !== 'object' || Array.isArray(patch.selectedAccounts) || Object.entries(patch.selectedAccounts).some(([app,id]) => !APPS.includes(app) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) throw new Error('Invalid account selection.');
    this.#watchEpoch++;
    this.#session = null;
    this.config = { ...this.config, ...('userId' in patch ? { userId: patch.userId, selectedAccounts: {} } : {}), ...('selectedAccounts' in patch ? { selectedAccounts: { ...patch.selectedAccounts } } : {}), ...('enabled' in patch ? { enabled: patch.enabled } : {}), ...('watchApps' in patch ? { watchApps: [...new Set(patch.watchApps)] } : {}) };
    this.#signals = []; this.#nextPoll = this.#lastPoll == null ? 0 : Math.max(this.now(), this.#lastPoll + 15000); this.#providers.clear(); this.#faults = 0; this.#approvals.clear(); return this.state();
  }
  async client() {
    if (!this.config.enabled) return null;
    if (!this.#key && !this.#client) this.#key = await this.loadKey();
    if (!this.config.enabled || (!this.#key && !this.#client)) return null;
    if (!this.#client) { const { Composio } = await import('@composio/core'); this.#client = new Composio({ apiKey: this.#key }); }
    return this.#client;
  }
  async setKey(key) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(key)) throw new Error('Enter a valid Composio API key.');
    await this.saveKey(key); this.config = { ...this.config }; this.#key = key; this.#client = null; this.#session = null; this.#schemas.clear(); this.#approvals.clear();
  }
  async connections() {
    const client = await this.client(); if (!client) return [];
    const result = await client.connectedAccounts.list({ userIds: [this.config.userId], toolkitSlugs: APPS, accountType: 'PRIVATE', limit: 100 });
    return result.items.map(x => ({ id: x.id, app: x.toolkit?.slug, status: x.status })).filter(x => APPS.includes(x.app));
  }
  async session() {
    const client = await this.client(); if (!client) throw new Error('Composio is disabled or has no key.');
    const owned = await this.connections();
    if (Object.entries(this.config.selectedAccounts).some(([app, id]) => !owned.some(x => x.app === app && x.id === id && x.status === 'ACTIVE'))) throw new Error('Selected account is unavailable for this user.');
    if (!this.#session) this.#session = await client.sessions.create(this.config.userId, {
      toolkits: APPS, manageConnections: true,
      tools: Object.fromEntries(APPS.map(app => [app, { enable: [...WATCH_SLUGS, ...DRAFT_SLUGS].filter(slug => appOf(slug) === app) }])),
      connectedAccounts: Object.fromEntries(Object.entries(this.config.selectedAccounts).map(([app, id]) => [app, [id]])),
      sandbox: { enable: false },
    });
    return this.#session;
  }
  async connect(app) {
    if (!APPS.includes(app)) throw new Error('Unsupported toolkit.');
    const accounts = (await this.connections()).filter(x => x.app === app && x.status === 'ACTIVE');
    if (accounts.length) return { reused: true, selectAccount: true };
    const result = await (await this.session()).authorize(app);
    const url = new URL(result.redirectUrl); if (url.protocol !== 'https:') throw new Error('Invalid authorization URL.');
    return { redirectUrl: url.href };
  }
  async disconnect(id) {
    this.#watchEpoch++;
    this.#revoked.add(id);
    this.#providers.delete(id);
    this.#signals = this.#signals.filter(signal => !signal.id.startsWith(`composio:${id}:`));
    if (!(await this.connections()).some(x => x.id === id)) throw new Error('Unknown connection.');
    await (await this.client()).connectedAccounts.disable(id);
    this.#session = null; this.#signals = []; this.#nextPoll = this.#lastPoll == null ? 0 : Math.max(this.now(), this.#lastPoll + 15000);
  }
  // Only a trusted local Halo approval handler may mint this receipt. Never expose to model tools.
  approveSend(slug, args, accountId) {
    if (!SEND_SLUGS.includes(slug)) throw new Error('Not a send action.');
    const id = randomUUID(); this.#approvals.set(id, { hash: digest([slug, args, accountId]), expires: Date.now() + 60000 }); return id;
  }
  async execute(slug, args, { accountId, watch = false, approvalId, watchDeadline = Infinity } = {}) {
    const configuration = this.config;
    accountId ||= this.config.selectedAccounts[appOf(slug)];
    if (![...WATCH_SLUGS, ...DRAFT_SLUGS, ...SEND_SLUGS].includes(slug)) throw new Error('Tool is not allowlisted.');
    if (watch && (!WATCH_SLUGS.includes(slug) || !this.config.watchApps.includes(appOf(slug)))) throw new Error('Watch app or tool is not allowed.');
    if (SEND_SLUGS.includes(slug)) {
      const receipt = this.#approvals.get(approvalId); this.#approvals.delete(approvalId);
      if (!receipt || receipt.expires < Date.now() || receipt.hash !== digest([slug, args, accountId])) throw new Error('Explicit Halo send approval required.');
    }
    const client = await this.client(); if (!client) throw new Error('Composio is disabled or has no key.');
    if (!(await this.connections()).some(x => x.id === accountId && x.app === appOf(slug) && x.status === 'ACTIVE')) throw new Error('No active matching connection.');
    let schema = this.#schemas.get(slug);
    if (!schema) { schema = await client.tools.getRawComposioToolBySlug(slug); this.#schemas.set(slug, schema); }
    if (!schema.version || schema.version === 'latest') throw new Error('A pinned tool version is required.');
    if (configuration !== this.config || !this.config.enabled || (watch && this.now() >= watchDeadline)) throw new Error('Composio configuration changed or watch expired; action cancelled.');
    if (watch && this.#watchCalls.has(accountId)) throw new Error('Previous provider request is still pending.');
    const request = Promise.resolve().then(() => client.tools.execute(slug, { userId: this.config.userId, connectedAccountId: accountId, version: schema.version, arguments: args }));
    if (!watch) return request;
    this.#watchCalls.set(accountId, request);
    try { return await request; } finally { if (this.#watchCalls.get(accountId) === request) this.#watchCalls.delete(accountId); }
  }
  async agentTool(name, args, accountId) {
    const configuration = this.config;
    args = structuredClone(args);
    accountId ||= this.config.selectedAccounts.gmail;
    const slug = { search_mail: 'GMAIL_FETCH_EMAILS', list_unread: 'GMAIL_FETCH_EMAILS', draft_reply_do_not_send: 'GMAIL_CREATE_EMAIL_DRAFT' }[name];
    if (name === 'list_unread') args = { query: 'is:unread', max_results: 10 };
    if (!slug || !await this.guardian({ name, slug, args, accountId, sends: false })) throw new Error('Halo policy/guardian approval required.');
    if (configuration !== this.config) throw new Error('Configuration changed during approval.');
    return this.execute(slug, args, { accountId });
  }
  _watchRead(key, read) {
    if (this.#watchJobs.has(key)) return Promise.reject(new Error('Previous watch request is pending.'));
    const pending = Promise.resolve().then(read);
    this.#watchJobs.set(key, pending);
    pending.finally(() => { if (this.#watchJobs.get(key) === pending) this.#watchJobs.delete(key); }).catch(() => {});
    return boundedWatch(() => pending, this.scheduler);
  }
  watchCadence() {
    return { active: this.config.enabled && this.config.watchApps.length > 0, lastPollAt: this.#lastPoll, nextPollAt: this.#nextPoll, minIntervalMs: 15000, maxIntervalMs: 300000, inFlight: Boolean(this.#pollBusy), connectionFaults: this.#faults, startFloorAt: this.#lastPoll == null ? 0 : this.#lastPoll + 15000, providers: [...this.#providers.values()].map(value => ({ ...value })) };
  }
  async pollSignals() {
    if (!this.config.enabled || !this.config.watchApps.length) return [];
    if (this.#pollBusy) { await this.#pollBusy; return structuredClone(this.#signals); }
    if (this.now() < this.#nextPoll) return structuredClone(this.#signals);
    const pending = this._pollSignals();
    this.#pollBusy = pending;
    try { return await pending; } finally { if (this.#pollBusy === pending) this.#pollBusy = null; }
  }
  async _pollSignals() {
    if (!this.config.enabled || !this.config.watchApps.length) return [];
    const epoch = this.config, watchEpoch = this.#watchEpoch;
    this.#lastPoll = this.now(); this.#nextPoll = this.now() + 15000; const signals = [];
    const attempted = new Map(); let globalFault = false;
    try {
      const connections = await this._watchRead('connections', () => this.connections());
      const targets = epoch.watchApps.map(app => ({ app, id: epoch.selectedAccounts[app] })).filter(c => c.id && !this.#revoked.has(c.id));
      await Promise.all(targets.map(async target => {
        const cadence = this.#providers.get(target.id);
        if (cadence && this.now() < cadence.nextPollAt) {
          signals.push(...this.#signals.filter(row => row.id.startsWith(`composio:${target.id}:`)));
          return;
        }
        attempted.set(target.id, { app: target.app, accountId: target.id, lastPollAt: this.now() });
        const connection = connections.find(c => c.id === target.id && c.app === target.app) || { ...target, status: 'UNAVAILABLE' };
        if (this.config.selectedAccounts[connection.app] !== connection.id) return;
        if (!this.config.watchApps.includes(connection.app)) return;
        try {
        if (connection.status !== 'ACTIVE') throw new Error('Connection unavailable');
        const deadline = this.now() + 6000;
        const current = () => { if (epoch !== this.config || watchEpoch !== this.#watchEpoch || this.now() >= deadline) throw new Error('Watch collection cancelled.'); };
        const providerSignals = await this._watchRead(connection.id, async () => {
        current();
        const signals = [];
        if (connection.app === 'outlook') {
          const schema = await (await this.client()).tools.getRawComposioToolBySlug('OUTLOOK_QUERY_EMAILS');
          const args = { filter: 'isRead eq false', folder: 'inbox', top: 10, select: ['id', 'subject', 'isRead', 'receivedDateTime', 'lastModifiedDateTime'], orderby: 'receivedDateTime desc', user_id: 'me' };
          const props = schema.inputParameters?.properties || {};
          const types = { filter: 'string', folder: 'string', top: 'integer', select: 'array', orderby: 'string', user_id: 'string' };
          if (Object.entries(types).some(([key, type]) => props[key]?.type !== type)) throw new Error('Incompatible Outlook schema');
          this.#schemas.set('OUTLOOK_QUERY_EMAILS', schema);
          current();
          const result = await this.execute('OUTLOOK_QUERY_EMAILS', args, { accountId: connection.id, watch: true, watchDeadline: deadline });
          if (result.successful === false) throw new Error('Watch unavailable');
          const messages = result.data?.value || result.data?.messages || result.data?.emails;
          if (!Array.isArray(messages)) throw new Error('Unsupported mail response');
          if (messages.length) signals.push(watchCard(connection, 'unread', `${messages.length} unread messages in the latest sample. Open Outlook to review.`, messages, this.now()));
        } else if (connection.app === 'gmail') {
          current();
          const result = await this.execute('GMAIL_FETCH_EMAILS', { query: 'is:unread', max_results: 10 }, { accountId: connection.id, watch: true, watchDeadline: deadline });
          if (result.successful === false || !Array.isArray(result.data?.messages)) throw new Error('Watch unavailable');
          const messages = result.data.messages;
          if (Array.isArray(messages) && messages.length) {
            signals.push(watchCard(connection, 'unread', `${messages.length} unread messages in the latest sample. Open Gmail to review.`, messages, this.now()));
            // An unread inbox message is a review candidate, never proof a reply is required.
            if (messages.some(m => (m.labelIds || m.label_ids || []).includes('INBOX'))) signals.push(watchCard(connection, 'needs-reply', 'Unread inbox mail may need a reply. Review in Gmail; Halo has not inferred intent.', messages, this.now()));
          }
        } else if (connection.app === 'googlecalendar') {
          const client = await this.client();
          const schema = await client.tools.getRawComposioToolBySlug('GOOGLECALENDAR_EVENTS_LIST');
          this.#schemas.set('GOOGLECALENDAR_EVENTS_LIST', schema);
          const props = schema.inputParameters?.properties || {};
          // Only use fields advertised by the current official tool schema.
          const args = {};
          const put = (names, value) => { const key = names.find(n => n in props); if (key) args[key] = value; return Boolean(key); };
          if (!put(['calendar_id', 'calendarId'], 'primary') || !put(['timeMin', 'time_min', 'timemin'], new Date(this.now()).toISOString()) || !put(['timeMax', 'time_max', 'timemax'], new Date(this.now()+30*60000).toISOString())) return signals;
          put(['max_results', 'maxResults'], 20); put(['single_events', 'singleEvents'], true);
          current();
          const result = await this.execute('GOOGLECALENDAR_EVENTS_LIST', args, { accountId: connection.id, watch: true, watchDeadline: deadline });
          const events = result.successful !== false && (result.data?.items || result.data?.events);
          const soon = Array.isArray(events) && events.filter(e => { const at = Date.parse(e.start?.dateTime); return e.status !== 'cancelled' && at >= this.now() && at <= this.now()+30*60000; });
          if (soon?.length) signals.push(watchCard(connection, 'calendar-soon', `${soon.length} calendar event(s) start within 30 minutes. Open Calendar to review.`, soon, this.now()));
        }
        return signals;
        });
        signals.push(...providerSignals);
        } catch { signals.push({ ...watchCard(connection, 'fault', 'Watch unavailable. Check this provider; other sources are still watching.', [], this.now()), state: 'unavailable' }); }
        attempted.get(target.id).completedAt = this.now();
      }));
    } catch {
      globalFault = true;
      for (const app of epoch.watchApps) {
        const id = epoch.selectedAccounts[app];
        if (id && !this.#revoked.has(id)) signals.push({ ...watchCard({ app, id }, 'fault', 'Connections unavailable. Check Tools settings; other desktop sources are still watching.', [], this.now()), state: 'unavailable' });
      }
    }
    if (epoch !== this.config || watchEpoch !== this.#watchEpoch) return [];
    for (const signal of signals) {
      const previous = this.#signals.find(old => old.id === signal.id && old.contentKey === signal.contentKey && old.state === signal.state);
      signal.observedAt = signal.updatedAt;
      signal.changedAt = previous?.changedAt ?? Math.max(signal.lastActivity, this.#signals.find(old => old.id === signal.id)?.changedAt ?? 0);
      signal.lastActivity = signal.changedAt;
    }
    const identity = rows => digest(rows.map(row => [row.id, row.state, row.contentKey]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (globalFault) {
      this.#faults++;
      this.#nextPoll = this.now() + Math.min(300000, 30000 * 2 ** Math.min(4, this.#faults - 1));
    } else {
      this.#faults = 0;
      for (const [id, attempt] of attempted) {
        const prior = this.#providers.get(id) || { burst: 0, quietPolls: 0, faults: 0 };
        const rows = signals.filter(row => row.id.startsWith(`composio:${id}:`));
        const old = this.#signals.filter(row => row.id.startsWith(`composio:${id}:`));
        const state = { ...prior, ...attempt };
        let delay;
        if (rows.some(row => row.state === 'unavailable')) {
          state.faults++; state.burst = 0;
          delay = Math.min(300000, 30000 * 2 ** Math.min(4, state.faults - 1));
        } else {
          state.faults = 0;
          if (identity(rows) !== identity(old)) { state.burst = 2; state.quietPolls = 0; }
          if (state.burst > 0) { state.burst--; delay = 15000; }
          else { state.quietPolls++; delay = state.quietPolls >= 3 ? 120000 : 60000; }
        }
        state.nextPollAt = (attempt.completedAt ?? this.now()) + delay;
        this.#providers.set(id, state);
      }
      this.#nextPoll = Math.max(this.#lastPoll + 15000, (this.#providers.size ? Math.min(...[...this.#providers.values()].map(value => value.nextPollAt)) : this.now() + 120000));
    }
    this.#signals = signals; return structuredClone(signals);
  }
}

const WATCH_URLS = Object.freeze({ gmail: 'https://mail.google.com/', outlook: 'https://outlook.office.com/mail/', googlecalendar: 'https://calendar.google.com/' });
export const watchOpenUrl = app => WATCH_URLS[app] || null;
function watchCard(connection, kind, detail, items = [], at = Date.now()) {
  const contentKey = digest(items.map(m => [m.id || m.messageId || m.message_id || '', m.subject || '', [...(m.labelIds || m.label_ids || [])].sort(), m.isRead, m.summary || '', m.start || null, m.end || null, m.status || '', m.receivedDateTime || '', m.lastModifiedDateTime || '']).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const subject = monitorText([...items].sort((a,b) => String(a.id || a.messageId || a.message_id || '').localeCompare(String(b.id || b.messageId || b.message_id || ''))).find(item => item.subject)?.subject, 100);
  if (subject) detail += ` Sampled subject: ${subject}`;
  return { id: `composio:${connection.id}:${kind}`, appId: connection.app, contentKey, lastActivity: at, label: connection.app === 'gmail' ? 'Gmail' : connection.app === 'outlook' ? 'Outlook' : 'Google Calendar', project: kind === 'fault' ? 'Watch unavailable' : kind === 'calendar-soon' ? 'Calendar soon' : kind === 'needs-reply' ? 'May need reply' : 'Unread', state: 'waiting', detail, source: 'composio', confidence: 'observed', updatedAt: at };
}

function boundedWatch(read, scheduler = { setTimeout, clearTimeout }) {
  let timer;
  return Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    timer = scheduler.setTimeout(() => reject(new Error('Provider timed out')), 6000); timer.unref?.();
  })]).finally(() => scheduler.clearTimeout(timer));
}
