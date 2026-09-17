/* ==========================================================================
   Halo — the app window

   The island is the always-there control. This is the room you go into:
   every conversation, what Halo remembers, the shortcuts you have saved,
   what it has done, and its settings.

   LAYOUT
   Chats down the left, because history is the thing people come here for —
   search at the top of it, new chat above that, and each chat renamed or
   deleted where it sits. The conversation fills the middle, with the plan of
   a running task pinned above the box you type into, so what Halo is doing
   and the way to steer it are in the same place. Everything else is a
   section, reached from the foot of the sidebar.

   THE SAME CHAT AS THE ISLAND
   Not a copy of it. Both windows read one store and one archive (chats.js),
   so a message typed in the island appears here as it is sent, a question
   answered here closes the island's card, and reopening an old chat in
   either window reopens it in both.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { store, isActive, PHASE_COPY } from '../src/store.js';
import { bridge, connect } from '../src/bridge.js';
import { chats } from '../src/chats.js';
import { permissions, LEVELS } from '../src/permissions.js';
import { renderTimeline } from '../src/timeline.js';
import { mountPalette } from '../src/palette.js';
import { installHotkeys } from '../src/hotkeys.js';
import { useStore, useStoreEvent, sel, usePetName, useDebounced, ago } from './hooks.js';
import { Beam, MetalButton, Orb } from './fx.jsx';
import { Onboard } from './onboard.jsx';
import { KEYBINDS } from '../src/keybinds.js';
import {
  Composer, Decision, Icon, IconButton, MascotView, PlanSteps, Presence, RunControls, SaveShortcut, Thread, useDecision,
} from './parts.jsx';

const SECTIONS = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'bolt' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'desktop', label: 'Desktop', icon: 'monitor' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'updates', label: 'Updates', icon: 'update' },
];

const sectionFromHash = () => {
  const id = location.hash.replace(/^#/, '');
  return SECTIONS.some((s) => s.id === id) ? id : 'chat';
};

/* --------------------------------------------------------------------------
   Sidebar: chats
   -------------------------------------------------------------------------- */
function ChatRow({ chat, current, onOpen }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [confirm, setConfirm] = useState(false);
  const input = useRef(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => { if (!editing) setTitle(chat.title); }, [chat.title, editing]);
  useEffect(() => {
    if (!confirm) return undefined;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const save = () => {
    setEditing(false);
    if (title.trim() !== chat.title) chats.rename(chat.id, title.trim());
  };

  return (
    <div className="h-chatrow" data-current={current ? 'true' : 'false'} role="button" tabIndex={0}
      onClick={() => !editing && onOpen(chat.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' && !editing) onOpen(chat.id); }}>
      {editing ? (
        <input ref={input} className="h-chatrow__edit" value={title} maxLength={80}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') { setTitle(chat.title); setEditing(false); } }} />
      ) : (
        <>
          <span className="h-chatrow__main">
            <span className="h-chatrow__title">{chat.title}</span>
            {chat.preview && <span className="h-chatrow__preview">{chat.preview}</span>}
          </span>
          <span className="h-chatrow__when">{ago(chat.updated)}</span>
          <span className="h-chatrow__actions" onClick={(e) => e.stopPropagation()}>
            <IconButton icon="pencil" label="Rename" size={13} onClick={() => setEditing(true)} />
            <IconButton icon="trash" label={confirm ? 'Click again to delete' : 'Delete'} size={13}
              className={confirm ? 'is-confirm' : ''}
              onClick={() => { if (confirm) chats.remove(chat.id); else setConfirm(true); }} />
          </span>
        </>
      )}
    </div>
  );
}

function ChatList({ onOpen }) {
  const chatState = useStore(sel.chats);
  const search = useStore(sel.chatSearch);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 180);
  useEffect(() => { chats.search(query); }, [query]);

  const list = query.trim() && search?.q === query.trim() ? search.results : chatState.list;
  const groups = useMemo(() => {
    const day = 86_400_000;
    const now = Date.now();
    const out = [
      { label: 'Today', items: [] },
      { label: 'This week', items: [] },
      { label: 'Earlier', items: [] },
    ];
    for (const c of list) {
      const age = now - (c.updated || 0);
      out[age < day ? 0 : age < 7 * day ? 1 : 2].items.push(c);
    }
    return out.filter((g) => g.items.length);
  }, [list]);

  return (
    <div className="h-chats">
      <div className="h-search">
        <Icon name="search" size={14} />
        <input value={q} placeholder="Search chats" aria-label="Search chats" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
        {q && <IconButton icon="x" label="Clear search" size={12} onClick={() => setQ('')} />}
      </div>
      <div className="h-chats__scroll">
        {query.trim() && !list.length && <div className="h-chats__none">Nothing matches “{query.trim()}”.</div>}
        {!query.trim() && !list.length && <div className="h-chats__none">Chats you have with Halo, in the island or here, are kept on this computer.</div>}
        {groups.map((g) => (
          <div key={g.label} className="h-chats__group">
            <div className="h-chats__label">{query.trim() ? 'Results' : g.label}</div>
            {g.items.map((c) => <ChatRow key={c.id} chat={c} current={c.id === chatState.current} onOpen={onOpen} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Chat
   -------------------------------------------------------------------------- */
function ChatView({ petName }) {
  const messages = useStore(sel.messages);
  const plan = useStore(sel.plan);
  const phase = useStore(sel.phase);
  const guardian = useStore(sel.guardian);
  const routines = useStore(sel.routines);
  const error = useStore(sel.error);
  const chatState = useStore(sel.chats);
  const decision = useDecision(null);
  const running = isActive(phase);
  const title = chatState.list.find((c) => c.id === chatState.current)?.title;
  const empty = !messages.length && !plan && !decision;

  return (
    <div className="h-chatview">
      <header className="h-chatview__head">
        <div className="h-chatview__title">{empty ? 'New chat' : (title || 'This chat')}</div>
        <div className="h-chatview__state">
          {running ? PHASE_COPY[phase]?.title : guardian.canAct === false ? 'Chat only' : ''}
        </div>
      </header>

      <div className="h-chatview__body">
        {empty ? (
          <div className="h-welcome">
            <div className="h-welcome__face"><Presence px={64} /></div>
            <h1 className="h-welcome__title">What should we<br />get done?</h1>
            <p className="h-welcome__sub">
              {guardian.canAct === false && guardian.reason
                ? guardian.reason
                : `Talk to ${petName}, or give it a job. It reads the screen, clicks and types with your own pointer, and stops to ask before anything it cannot undo.`}
            </p>
            {routines.length > 0 && (
              <div className="h-chips h-welcome__chips">
                {routines.slice(0, 6).map((r) => (
                  <MetalButton key={r.id} className="h-chip h-chip--metal" title={r.task} onClick={() => bridge.send('routineRun', { id: r.id })}>
                    <Icon name="bolt" size={12} />{r.name}
                  </MetalButton>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-chatview__column">
            <Thread className="h-chatview__thread" />
            {error && phase === 'Failed' && (
              <div className="h-notice"><strong>{error.title || 'Something went wrong'}</strong>{error.message}</div>
            )}
          </div>
        )}
      </div>

      <footer className="h-chatview__foot">
        <div className="h-chatview__column">
          {plan && (
            <Beam active={running && !plan.finished} size="line" color="colorful" strength={0.6} className="h-runcard-beam">
              <section className="h-runcard" data-finished={plan.finished ? 'true' : 'false'}>
                <header className="h-runcard__head">
                  {running && !plan.finished ? <Presence px={20} /> : <span className={`h-runcard__done${plan.succeeded ? '' : ' is-bad'}`}><Icon name={plan.succeeded ? 'check' : 'x'} size={11} /></span>}
                  <span className="h-runcard__title">
                    {plan.finished ? (plan.succeeded ? 'Finished' : 'Stopped') : `${PHASE_COPY[phase]?.title ?? 'Working'}`}
                  </span>
                  <span className="h-runcard__count">
                    {plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length} of {plan.steps.length}
                  </span>
                  <RunControls size={14} />
                </header>
                <PlanSteps limit={8} />
                {plan.finished && <div className="h-runcard__after"><SaveShortcut /></div>}
              </section>
            </Beam>
          )}
          {decision && <Decision decision={decision} />}
          {decision?.kind !== 'question' && <Composer petName={petName} big autoFocus={!running} />}
          <div className="h-chatview__hint">
            {running ? 'Esc stops · what you type now steers the task in hand' : 'Halo keeps your chats on this computer'}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Shortcuts
   -------------------------------------------------------------------------- */
function ShortcutsView() {
  const routines = useStore(sel.routines);
  const lastRun = useStore(sel.lastRun);
  const phase = useStore(sel.phase);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');

  const add = () => {
    if (!name.trim() || !task.trim()) return;
    bridge.send('routineSave', { name: name.trim(), task: task.trim() });
    setName(''); setTask('');
  };

  return (
    <div className="h-page">
      <PageHead title="Shortcuts" sub="Tasks you do often, kept under a name. Say the name in the island — or press Run — and Halo plans it fresh against whatever is on screen, so it still works when things have moved." />

      {lastRun?.succeeded && (
        <div className="h-card h-card--soft">
          <div className="h-card__row">
            <div className="h-card__main">
              <div className="h-card__eyebrow">Your last task</div>
              <div className="h-card__title">{lastRun.task}</div>
            </div>
            <SaveShortcut />
          </div>
        </div>
      )}

      <div className="h-list">
        {!routines.length && <Empty icon="bolt" title="No shortcuts yet" sub="Finish a task, then choose Save as shortcut — or write one below." />}
        {routines.map((r) => (
          <div key={r.id} className="h-card">
            <div className="h-card__row">
              <span className="h-card__icon"><Icon name="bolt" size={16} /></span>
              <div className="h-card__main">
                {editing === r.id ? (
                  <input className="h-input" value={draft} autoFocus maxLength={48}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => { if (draft.trim()) bridge.send('routineRename', { id: r.id, name: draft.trim() }); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(null); }} />
                ) : <div className="h-card__title">{r.name}</div>}
                <div className="h-card__sub">{r.task}</div>
                <div className="h-card__meta">{r.runs ? `Run ${r.runs} time${r.runs === 1 ? '' : 's'} · last ${ago(r.lastRun)} ago` : 'Not run yet'}</div>
              </div>
              <div className="h-card__actions">
                <IconButton icon="pencil" label="Rename" size={13} onClick={() => { setEditing(r.id); setDraft(r.name); }} />
                <IconButton icon="trash" label="Delete" size={13} onClick={() => bridge.send('routineRemove', { id: r.id })} />
                <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={isActive(phase)} onClick={() => bridge.send('routineRun', { id: r.id })}>
                  Run
                </MetalButton>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="h-card">
        <div className="h-card__eyebrow">New shortcut</div>
        <div className="h-form">
          <input className="h-input" placeholder="Name — morning setup" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
          <textarea className="h-input h-input--area" placeholder="What it does — open Outlook and my calendar, then put on some focus music" value={task} onChange={(e) => setTask(e.target.value)} />
          <div className="h-form__actions">
            <MetalButton className="h-pill h-pill--primary" disabled={!name.trim() || !task.trim()} onClick={add}>Save shortcut</MetalButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Memory
   -------------------------------------------------------------------------- */
const SOURCE = { told: 'You told Halo', noticed: 'You mentioned it', answered: 'Your answer', added: 'Added here' };

function MemoryView() {
  const facts = useStore(sel.memory);
  const [text, setText] = useState('');
  const [clearing, setClearing] = useState(false);
  const add = () => { if (text.trim()) { bridge.send('memoryAdd', { text: text.trim() }); setText(''); } };

  return (
    <div className="h-page">
      <PageHead title="Memory" sub="Things you have told Halo, so it can use them instead of asking again — which email is yours, the browser you use, who your brother is. Kept only on this computer, sent to the model with each request, and never anything that looks like a password." />

      <div className="h-field h-field--page">
        <input className="h-field__input" value={text} placeholder="Add something — My work email is sam@company.com"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <MetalButton circle aria-label="Remember" disabled={!text.trim()} onClick={add} className="h-send"><Icon name="plus" size={16} /></MetalButton>
      </div>

      <div className="h-list">
        {!facts.length && <Empty icon="brain" title="Nothing remembered yet" sub={'Say "remember that…" to Halo, or tell it something about yourself: "my default browser is Firefox".'} />}
        {facts.map((f) => (
          <div key={f.id} className="h-fact">
            <span className="h-fact__text">{f.text}</span>
            <span className="h-fact__meta">{SOURCE[f.source] ?? 'Kept'} · {ago(f.updated ?? f.created)}</span>
            <IconButton icon="trash" label="Forget this" size={13} onClick={() => bridge.send('memoryRemove', { id: f.id })} />
          </div>
        ))}
      </div>
      {facts.length > 1 && (
        <div className="h-page__foot">
          <button type="button" className="h-pill h-pill--danger h-pill--sm"
            onClick={() => { if (clearing) { bridge.send('memoryClear'); setClearing(false); } else setClearing(true); }}>
            {clearing ? 'Click again to forget everything' : 'Forget everything'}
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Activity — the audit timeline, drawn by the module the phone also uses.
   -------------------------------------------------------------------------- */
function ActivityView() {
  const timeline = useStore(sel.timeline);
  const host = useRef(null);
  useEffect(() => {
    if (!host.current) return;
    host.current.replaceChildren(timeline.length ? renderTimeline(store.state) : '');
  }, [timeline]);
  return (
    <div className="h-page">
      <PageHead title="Activity" sub="Every step Halo takes this session — what it looked at, what it did, and what it asked you. Typed text and screenshots are never recorded here." />
      {!timeline.length && <Empty icon="activity" title="Nothing has run yet" sub="Start a task and each step shows up here as it happens." />}
      <div ref={host} className="h-legacy" />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Desktop
   -------------------------------------------------------------------------- */
function DesktopView({ demo }) {
  const notchOpen = useStore(sel.notchOpen);
  const guardian = useStore(sel.guardian);
  const dot = useRef(null);
  const coords = useRef(null);
  const map = useRef(null);

  // Thirty positions a second, painted straight onto the dot rather than
  // through React: moving one dot is not a reason to render a page.
  useEffect(() => store.subscribe((s, meta) => {
    if (meta.type !== 'cursor' || !s.guardian.screen || !dot.current) return;
    const { x, y, visible } = s.cursor;
    dot.current.style.left = `${(x / s.guardian.screen.width) * 100}%`;
    dot.current.style.top = `${(y / s.guardian.screen.height) * 100}%`;
    map.current.dataset.live = String(visible);
    coords.current.textContent = visible ? `${Math.round(x)}, ${Math.round(y)}` : '—';
  }), []);

  return (
    <div className="h-page">
      <PageHead title="Desktop" sub="The island, and where the pointer is while Halo works." />
      <div className="h-card">
        <div className="h-card__row">
          <div className="h-card__main">
            <div className="h-card__title">The island {notchOpen ? 'is showing' : 'is hidden'}</div>
            <div className="h-card__sub">{demo ? 'The island is a window on your own desktop, so it only exists in the installed app.' : 'Docked to the top centre of your main display. It grows while Halo works and settles back.'}</div>
          </div>
          <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={demo} onClick={() => bridge.send(notchOpen ? 'closeNotch' : 'openNotch')}>
            {notchOpen ? 'Hide it' : 'Show it'}
          </MetalButton>
        </div>
      </div>
      <div className="h-card">
        <div className="h-card__title">Where the pointer is</div>
        <div className="h-card__sub">Windows has one pointer and Halo uses yours, where you can see it — so there is one dot, and you can take the mouse back any time.</div>
        {guardian.screen ? (
          <div ref={map} className="h-screenmap" style={{ aspectRatio: `${guardian.screen.width} / ${guardian.screen.height}` }} data-live="false">
            <i ref={dot} className="h-screenmap__dot" />
            <span ref={coords} className="h-screenmap__coords">—</span>
          </div>
        ) : <div className="h-card__sub">{guardian.reason || 'Halo cannot reach the mouse on this machine.'}</div>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */
function SettingsView({ demo, petName, setPetName }) {
  const settings = useStore(sel.settings);
  const learnt = useStore(sel.runbook);
  const [level, setLevel] = useState(permissions.level);
  const [name, setName] = useState(petName);
  const [startup, setStartup] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => permissions.subscribe(setLevel), []);
  useEffect(() => {
    if (demo) return;
    fetch('/startup/state').then((r) => (r.ok ? r.json() : null)).then(setStartup).catch(() => {});
  }, [demo]);

  const toggleStartup = async () => {
    if (!startup || busy) return;
    setBusy(true);
    try {
      const r = await fetch(startup.enabled ? '/startup/disable' : '/startup/enable', { method: 'POST' });
      setStartup(await r.json());
    } catch (err) {
      setStartup({ ...startup, error: err.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="h-page">
      <PageHead title="Settings" sub="How much Halo may do on its own, what it is called, and how it starts." />

      <div className="h-card">
        <div className="h-card__title">Permissions</div>
        <div className="h-card__sub">How much Halo may do without asking first. Passwords, codes, CAPTCHAs and Windows security prompts always come to you.</div>
        <div className="h-segment">
          {Object.values(LEVELS).map((lv) => (
            <button key={lv.id} type="button" className="h-segment__opt" data-on={level === lv.id ? 'true' : 'false'} onClick={() => permissions.set(lv.id)}>
              <span className="h-segment__label">{lv.label}</span>
              <span className="h-segment__hint">{lv.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="h-card">
        <div className="h-card__title">Name</div>
        <div className="h-form h-form--row">
          <input className="h-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
          <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={!name.trim() || name.trim() === petName}
            onClick={() => { setPetName(name); bridge.send('setName', { name: name.trim() }); }}>Save</MetalButton>
        </div>
      </div>

      <div className="h-card">
        <div className="h-card__row">
          <div className="h-card__main">
            <div className="h-card__title">Start with Windows</div>
            <div className="h-card__sub">
              {demo ? 'Only the installed app can start with Windows.'
                : startup?.error ? startup.error
                : 'Halo comes up when you sign in and does nothing until you ask it to.'}
            </div>
          </div>
          <button type="button" className="h-toggle" role="switch" aria-checked={Boolean(startup?.enabled)}
            disabled={demo || busy || !startup?.supported} onClick={toggleStartup}><i /></button>
        </div>
      </div>

      <div className="h-card">
        <div className="h-card__title">What Halo has worked out</div>
        <div className="h-card__sub">
          When a job works, Halo keeps the route it took — the steps, filed under the app they happened in — and
          uses it as precedent next time rather than working the app out again from a screenshot. It never keeps
          what you typed, and the screen in front of it always decides.
        </div>
        <div className="h-kv">
          <span>Kept</span>
          <span>{learnt.routes
            ? `${learnt.routes} route${learnt.routes === 1 ? '' : 's'} in ${learnt.apps.join(', ')}`
            : 'Nothing yet — it learns by finishing jobs'}</span>
        </div>
        {learnt.routes > 0 && (
          <button type="button" className="h-link" onClick={() => bridge.send('forgetRoutes', {})}>Forget all of it</button>
        )}
      </div>

      <div className="h-card">
        <div className="h-card__title">Keyboard</div>
        <div className="h-card__sub">Every one of these works while you are in something else — Windows hands them to Halo directly.</div>
        {KEYBINDS.map((b) => (
          <div className="h-kv h-kv--keys" key={b.id}>
            <span>{b.label}<i>{b.hint}</i></span>
            <span className="h-keys__chord">{b.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
          </div>
        ))}
      </div>

      <div className="h-card">
        <div className="h-card__title">Model</div>
        <div className="h-card__sub">A task is planned once by the strongest model, then each step is carried out by the one measured to click most accurately. A screenshot of the desktop is sent to the provider on each step.</div>
        <div className="h-kv"><span>In use</span><code>{settings.model || 'not configured'}</code></div>
        <div className="h-kv"><span>Provider</span><span>{settings.hasApiKey ? (settings.provider || 'Connected') : 'Starting…'}</span></div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Updates
   -------------------------------------------------------------------------- */
function UpdatesView({ demo }) {
  const [info, setInfo] = useState(null);
  const [state, setState] = useState({ busy: false, msg: '', error: null, pct: 0, done: false });

  const check = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null, msg: 'Checking…' }));
    try {
      const r = await fetch('/update/check');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setInfo(j);
      setState((s) => ({ ...s, busy: false, msg: j.available ? '' : 'You are on the latest build.' }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, msg: '', error: err.message }));
    }
  }, []);
  useEffect(() => { if (!demo) check(); }, [demo, check]);

  const install = async () => {
    setState((s) => ({ ...s, busy: true, pct: 0, msg: 'Downloading…' }));
    try {
      const res = await fetch('/update/install', { method: 'POST' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(ev.error);
          setState((s) => ({ ...s, pct: ev.pct ?? s.pct, msg: { downloading: 'Downloading…', extracting: 'Unpacking…', installing: 'Installing…', dependencies: 'Installing packages…', done: 'Installed' }[ev.stage] || s.msg }));
        }
      }
      setState((s) => ({ ...s, busy: false, done: true, msg: 'Installed.' }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message, msg: '' }));
    }
  };

  const restart = async () => {
    setState((s) => ({ ...s, busy: true, msg: 'Restarting…' }));
    try { await fetch('/update/restart', { method: 'POST' }); } catch { /* the server goes away mid-request by design */ }
    setTimeout(() => location.reload(), 4000);
  };

  return (
    <div className="h-page">
      <PageHead title="Updates" sub="Every change published to Halo becomes a new build. Your .env, memory, shortcuts and chats are never overwritten." />
      {demo ? <Empty icon="update" title="Updates live in the installed app" sub="There is nothing to update in a preview running in your browser." /> : (
        <div className="h-card">
          <div className="h-card__row">
            <span className="h-card__icon"><Icon name="update" size={16} /></span>
            <div className="h-card__main">
              <div className="h-card__title">
                {state.done ? 'Update installed' : info?.available ? 'A new build is ready' : state.error ? 'Could not check for updates' : 'Halo is up to date'}
              </div>
              <div className="h-card__sub">
                {state.error || state.msg || (info?.available ? `${info.latest.sha} · ${(info.size / 1048576).toFixed(1)} MB` : `Build ${info?.current?.sha ?? '—'}`)}
              </div>
              {state.busy && state.pct > 0 && <div className="h-meter"><i style={{ width: `${state.pct}%` }} /></div>}
            </div>
            {state.done
              ? <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={state.busy} onClick={restart}>Restart now</MetalButton>
              : info?.available
                ? <MetalButton className="h-pill h-pill--primary h-pill--sm" disabled={state.busy} onClick={install}>Install update</MetalButton>
                : <button type="button" className="h-pill h-pill--sm" disabled={state.busy} onClick={check}>{state.busy ? 'Checking…' : 'Check again'}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Small shared bits of a page
   -------------------------------------------------------------------------- */
function PageHead({ title, sub }) {
  return (
    <header className="h-pagehead">
      <h1 className="h-pagehead__title">{title}</h1>
      {sub && <p className="h-pagehead__sub">{sub}</p>}
    </header>
  );
}

function Empty({ icon, title, sub }) {
  return (
    <div className="h-emptycard">
      <span className="h-emptycard__icon"><Icon name={icon} size={18} /></span>
      <div className="h-emptycard__title">{title}</div>
      {sub && <div className="h-emptycard__sub">{sub}</div>}
    </div>
  );
}

/* --------------------------------------------------------------------------
   The island, one click away.

   The island is Halo's main surface, and launching it used to mean finding a
   "Desktop" section at the bottom of the sidebar. So it sits at the top,
   under New chat, saying whether it is on screen and switching it either way.
   -------------------------------------------------------------------------- */
function IslandToggle({ demo }) {
  const open = useStore(sel.notchOpen);
  return (
    <button type="button" className="h-islandtoggle" data-on={open ? 'true' : 'false'} disabled={demo}
      title={demo ? 'The island only exists in the installed app' : open ? 'Hide the island' : 'Show the island at the top of your screen'}
      onClick={() => {
        if (open) { bridge.send('closeNotch'); return; }
        bridge.send('openNotch');
        bridge.send('setShell', { show: true, keys: true });
      }}>
      <span className="h-islandtoggle__pill"><i /></span>
      <span className="h-islandtoggle__text">
        <span className="h-islandtoggle__title">{open ? 'Island is on screen' : 'Show the island'}</span>
        <span className="h-islandtoggle__sub">{demo ? 'Installed app only' : open ? 'Top of your screen · click to hide' : 'Halo at the top of your screen'}</span>
      </span>
      <span className="h-toggle" role="switch" aria-checked={open}><i /></span>
    </button>
  );
}

/* --------------------------------------------------------------------------
   The window
   -------------------------------------------------------------------------- */
function App({ demo, conn }) {
  const [petName, setPetName] = usePetName();
  const [section, setSection] = useState(sectionFromHash);
  const phase = useStore(sel.phase);
  const settings = useStore(sel.settings);
  const memory = useStore(sel.memory);
  const routines = useStore(sel.routines);
  const decision = useDecision(null);

  const go = useCallback((id) => {
    setSection(id);
    history.replaceState(null, '', id === 'chat' ? location.pathname : `#${id}`);
  }, []);
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  // A decision waiting on the person takes them to it, wherever they were.
  useStoreEvent(['approval', 'takeover', 'question'], (s) => {
    if (s.approval || s.takeover || s.question) go('chat');
  });
  useEffect(() => {
    document.title = decision ? `• ${petName} needs you` : 'Halo';
  }, [decision, petName]);

  const counts = { memory: memory.length || null, shortcuts: routines.length || null };

  /* The chords, before anything else.
     Four of them, one press each, and no way past a step but the real key —
     because every one of them is how Halo is reached once this window is
     closed, and an app you can only use while looking at it is not the app
     this is. The bridge remembers that it has been done (shell.json). */
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    if (settings.onboarded === false) setOnboarding(true);
  }, [settings.onboarded]);

  /* Closing this window leaves you with the island, which is the half of
     Halo that is reached by keyboard — so the chords go with you. */
  useEffect(() => {
    const onLeave = () => { if (!demo) bridge.send('setShell', { show: true, keys: true }); };
    addEventListener('pagehide', onLeave);
    return () => removeEventListener('pagehide', onLeave);
  }, [demo]);

  return (
    <div className="h-app" data-phase={phase}>
      {onboarding && <Onboard onDone={() => setOnboarding(false)} />}
      <aside className="h-side">
        <div className="h-side__brand">
          <Presence px={28} />
          <span className="h-side__name">{petName}</span>
          <span className="h-side__conn" data-conn={conn}>{demo ? 'Preview' : conn === 'connected' ? '' : conn}</span>
        </div>

        <MetalButton className="h-newchat" onClick={() => { chats.newChat(); go('chat'); }}>
          <Icon name="plus" size={15} /> New chat
        </MetalButton>

        <IslandToggle demo={demo} />

        <ChatList onOpen={(id) => { chats.open(id); go('chat'); }} />

        <nav className="h-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="h-nav__item" aria-current={section === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
              <Icon name={s.icon} size={15} />
              <span>{s.label}</span>
              {counts[s.id] && <span className="h-nav__count">{counts[s.id]}</span>}
              {s.id === 'chat' && decision && section !== 'chat' && <span className="h-nav__alert" />}
            </button>
          ))}
        </nav>
      </aside>

      <main className="h-main">
        {section === 'chat' && <ChatView petName={petName} />}
        {section === 'shortcuts' && <ShortcutsView />}
        {section === 'memory' && <MemoryView />}
        {section === 'activity' && <ActivityView />}
        {section === 'desktop' && <DesktopView demo={demo} />}
        {section === 'settings' && <SettingsView demo={demo} petName={petName} setPetName={setPetName} />}
        {section === 'updates' && <UpdatesView demo={demo} />}
      </main>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Mounting
   -------------------------------------------------------------------------- */
let setConn = () => {};
function Root({ demo }) {
  const [conn, set] = useState(demo ? 'offline' : 'connecting');
  setConn = set;
  return <App demo={demo} conn={conn} />;
}

const { mode, transport } = connect({ onStatus: (s) => setConn(s) });
chats.attach({ mode });

// First run: nothing else is usable without a provider, so ask once here
// rather than sending people to edit a file.
if (mode !== 'mock') {
  const { needsSetup, mountSetup } = await import('../src/setup.js');
  if (await needsSetup()) mountSetup(document.body, { onDone: () => location.reload() });
}

const host = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
createRoot(host).render(<Root demo={mode === 'mock'} />);

// The palette is a second always-available surface on the desktop. In the
// hosted preview it would only show the same card twice.
const palette = mode === 'mock' ? null : mountPalette(document.body);
if (palette) installHotkeys({ palette });

if (mode === 'mock') {
  const { MockAgent } = await import('../mock/agent.js');
  const agent = new MockAgent(transport);
  agent.start();
  window.halo = { store, agent };
} else {
  window.halo = { store, palette };
}
window.pico = window.halo;
