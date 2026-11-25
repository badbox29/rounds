/* Rounds — app logic
 *
 * Data lives in one JSON "profile" per account, mirrored in localStorage and
 * synced to the Worker at /storage/{token}/profile. Every push pulls and
 * merges first, so a device that fell behind can never write old data over
 * newer data. Merging is per task (newer edit wins for title/status), notes
 * are unioned by id, and deletions travel as tombstones.
 */
'use strict';

const APP_VERSION         = '2.0.1';
// The Worker URL is never built in. Each browser stores its own (entered in
// the setup wizard or Settings) in localStorage, so anyone can run this page
// from the same GitHub repo against their own private Worker. It is never
// uploaded to the Worker either.

// Every key starts with "rounds_": several apps share one github.io origin,
// and auth.js's guest reset clears keys by this prefix.
const STORAGE_KEY         = 'rounds_data';
const STORAGE_AUTH_KEY    = 'rounds_google_id_token';
const STORAGE_DISMISS_KEY = 'rounds_token_upgrade_dismissed';
const STORAGE_WRITE_KEY   = 'rounds_write_key';
const DIRTY_KEY           = 'rounds_dirty';
const HMAC_SALT           = 'rounds-hmac-v1';   // must match worker.js

const SYNC_INTERVAL_MS    = 60_000;
const PUSH_DEBOUNCE_MS    = 1500;
const FOREGROUND_PULL_MS  = 60_000;
const TOMBSTONE_DAYS      = 180;
const LOCAL_FIELDS        = ['authMethod', 'userToken', 'workerUrl', 'linkedGoogle'];

// ── Small helpers ─────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = o => JSON.parse(JSON.stringify(o));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysBetween = (a, b) => Math.round((new Date(dayKey(b) + 'T00:00') - new Date(dayKey(a) + 'T00:00')) / 864e5);
const fmt     = t => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay  = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const ls = {
  get(k)    { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
};

// ── State ─────────────────────────────────────────────────────────
const App = {
  data: null,
  syncState: null,          // null | 'busy' | 'ok' | 'push-failed' | 'session-expired' | 'offline'
  syncing: null,            // in-flight sync promise
  again: false,             // another sync requested while one was running
  failures: 0,
  lastSyncAt: 0,
  lastSyncMsg: '',
  syncTimer: null,
  debounce: null,
  authPromptOpen: false,
  storageBlocked: false,
  renderedDay: dayKey(Date.now()),
};
const View = {
  tab: location.hash === '#archive' ? 'archive' : 'rounds',
  open: new Set(), drafts: {}, renaming: null, q: '',
};

// ── Data shape ────────────────────────────────────────────────────
// items: { [id]: { id, title, createdAt, updatedAt, status: 'active'|'done',
//                  doneAt?, notes: [{ id, at, text }], deletedNotes: [noteId] } }
// tombstones: { [id]: deletedAt }
function defaultData() {
  return {
    authMethod: null,
    userToken: Auth.generateToken(),
    workerUrl: '',
    items: {},
    tombstones: {},
    lastModified: Date.now(),
  };
}

function mergeData(raw) {
  const d = defaultData();
  if (!isObj(raw)) return d;
  return {
    ...d, ...raw,
    items:      isObj(raw.items) ? raw.items : {},
    tombstones: isObj(raw.tombstones) ? raw.tombstones : {},
  };
}

// ── Merging ───────────────────────────────────────────────────────
function mergeTask(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer   = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
  const deleted = new Set([...(a.deletedNotes || []), ...(b.deletedNotes || [])]);
  const notes   = new Map();
  for (const n of [...(a.notes || []), ...(b.notes || [])]) {
    if (n && n.id && !deleted.has(n.id)) notes.set(n.id, n);
  }
  return { ...newer, notes: [...notes.values()].sort((x, y) => x.at - y.at), deletedNotes: [...deleted] };
}

// Items + tombstones from both sides. A task survives a tombstone only if it
// was edited after the deletion (which is how Undo brings one back).
function mergeCollections(a, b) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  const tombstones = {};
  for (const src of [a.tombstones || {}, b.tombstones || {}]) {
    for (const [id, t] of Object.entries(src)) {
      if (t > cutoff && t > (tombstones[id] || 0)) tombstones[id] = t;
    }
  }
  const items = {};
  const ids = new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})]);
  for (const id of ids) {
    const m = mergeTask(a.items?.[id], b.items?.[id]);
    if (!m) continue;
    if (tombstones[id] && tombstones[id] >= (m.updatedAt || 0)) continue;
    delete tombstones[id];
    items[id] = m;
  }
  return { items, tombstones };
}

// Remote copy into this device. Account/device fields always stay local.
function mergeProfiles(local, remote) {
  const out = { ...mergeData(remote) };
  for (const k of LOCAL_FIELDS) if (k in local) out[k] = local[k];
  Object.assign(out, mergeCollections(local, out));
  out.lastModified = Math.max(local.lastModified || 0, remote?.lastModified || 0);
  return out;
}

const signature = d => JSON.stringify([d.items, Object.keys(d.tombstones || {}).sort()]);

// ── Local persistence ─────────────────────────────────────────────
function saveLocal() {
  try {
    const json = JSON.stringify(App.data);
    localStorage.setItem(STORAGE_KEY, json);
    if (localStorage.getItem(STORAGE_KEY)?.length !== json.length) throw new Error('write did not persist');
    if (App.storageBlocked) { App.storageBlocked = false; renderBanner(); }
    return true;
  } catch (e) {
    console.error('[Rounds] saveLocal failed:', e);
    App.storageBlocked = true;
    renderBanner();
    return false;
  }
}

// Durable "this device has work the Worker hasn't got" flag. `seq` lets a push
// clear it only if nothing changed while the push was in flight.
function markDirty() {
  const cur = ls.get(DIRTY_KEY);
  ls.set(DIRTY_KEY, { dirty: true, seq: (cur?.seq || 0) + 1 });
}
const dirtySeq = () => ls.get(DIRTY_KEY)?.seq || 0;
const isDirty  = () => !!ls.get(DIRTY_KEY)?.dirty;
function clearDirty(ifSeq) {
  const cur = ls.get(DIRTY_KEY);
  if (ifSeq !== undefined && cur?.dirty && (cur.seq || 0) !== ifSeq) return false;
  ls.remove(DIRTY_KEY);
  return true;
}

// Every user edit funnels through here.
function changed() {
  App.data.lastModified = Date.now();
  markDirty();
  saveLocal();
  render();
  scheduleSync();
}
function saveTask(id, t) {
  t.id = id;
  t.updatedAt = Date.now();
  App.data.items[id] = t;
  delete App.data.tombstones[id];
  changed();
}
function removeTask(id) {
  delete App.data.items[id];
  App.data.tombstones[id] = Date.now();
  changed();
}

// ── Worker sync ───────────────────────────────────────────────────
const getWorkerUrl = () => (App.data?.workerUrl || '').replace(/\/+$/, '');
// Read the account type straight from the data so these work before Auth.init().
const isGuest  = () => !App.data?.authMethod || App.data.authMethod === 'guest';
const isGoogle = () => App.data?.authMethod === 'google';
const canSync  = () => !!App.data && !isGuest() && !!getWorkerUrl() && !!App.data.userToken;

async function pushToWorker() {
  const base = getWorkerUrl(), token = App.data?.userToken;
  if (!base || !token) return { ok: false, status: 0 };
  const { workerUrl: _deviceOnly, ...payload } = App.data;   // this browser's setting, not account data
  const body    = JSON.stringify(payload);
  const headers = await Auth._authHeaders('PUT', token, body);
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body,
    });
    if (res.status === 401 || res.status === 403) handleAuthFailure();
    if (res.status === 410) handleMigrated();
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function pullFromWorker() {
  const base = getWorkerUrl(), token = App.data?.userToken;
  if (!base || !token) return { ok: false, status: 0 };
  const headers = await Auth._authHeaders('GET', token, '');
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, { headers });
    if (res.status === 410) { handleMigrated(); return { ok: false, status: 410 }; }
    if (res.status === 401 || res.status === 403) handleAuthFailure();
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json();
    return { ok: true, status: res.status, value: j.value ?? j };
  } catch {
    return { ok: false, status: 0 };
  }
}

function applyRemote(remote) {
  const before = signature(App.data);
  App.data = mergeProfiles(App.data, remote);
  saveLocal();
  if (signature(App.data) !== before) render();
}

// Pull → merge → push (only if this device holds unsynced work, or the
// Worker has nothing yet). One sync at a time; requests during a sync queue
// exactly one more.
function syncNow(force = false) {
  if (!canSync()) return Promise.resolve(false);
  if (App.syncing) { App.again = true; return App.syncing; }
  App.syncing = (async () => {
    if (App.syncState !== 'session-expired') setSyncState('busy');
    const seq    = dirtySeq();
    const pulled = await pullFromWorker();
    if (pulled.ok) applyRemote(pulled.value);
    else if (pulled.status !== 404) return syncFailed(pulled.status);

    if (pulled.ok && !isDirty() && !force) return syncSucceeded();

    const pushed = await pushToWorker();
    if (!pushed.ok) return syncFailed(pushed.status);
    if (!clearDirty(seq)) App.again = true;
    return syncSucceeded();
  })();
  return App.syncing.finally(() => {
    App.syncing = null;
    if (App.again) { App.again = false; scheduleSync(); }
  });
}

function syncSucceeded() {
  App.failures = 0;
  App.lastSyncAt = Date.now();
  App.lastSyncMsg = 'ok';
  if (App.syncState !== 'session-expired') setSyncState('ok');
  return true;
}
function syncFailed(status) {
  App.failures++;
  App.lastSyncMsg = status ? `HTTP ${status}` : 'network error';
  if (App.syncState === 'session-expired' || status === 410) return false;
  setSyncState(status === 0 ? 'offline' : (App.failures >= 2 ? 'push-failed' : 'offline'));
  return false;
}

function scheduleSync() {
  if (!canSync()) return;
  clearTimeout(App.debounce);
  App.debounce = setTimeout(() => syncNow(), PUSH_DEBOUNCE_MS);
}

function startSyncPing() {
  clearInterval(App.syncTimer);
  App.syncTimer = setInterval(() => { if (!document.hidden) syncNow(); }, SYNC_INTERVAL_MS);
}
function stopSyncPing() { clearInterval(App.syncTimer); App.syncTimer = null; }

// Google sessions: offer a non-destructive re-sign-in overlay. Token
// accounts never expire, so a 401 there is a real problem — just report it.
function handleAuthFailure() {
  if (!isGoogle()) { setSyncState('push-failed'); return; }
  if (App.authPromptOpen) return;
  App.authPromptOpen = true;
  setSyncState('session-expired');
  Auth.showSessionRefresh({
    reason: 'Your Google sign-in has expired.',
    onDone: async ok => {
      App.authPromptOpen = false;
      if (!ok) return;
      await Auth.ensureWriteKey();
      setSyncState(null);
      if (await syncNow(true)) toast('Signed in — synced ✓');
    },
  });
}

// This token was upgraded to Google on another device.
function handleMigrated() {
  if (App.data.authMethod === 'google') return;
  App.data.authMethod = 'google';
  saveLocal();
  stopSyncPing();
  setSyncState('session-expired');
  Auth.showGoogleReauth();
}

function setSyncState(s) { App.syncState = s; renderSyncPill(); renderBanner(); }

function renderSyncPill() {
  const pill = $('syncPill');
  if (!pill) return;
  let text, cls = '';
  if (!App.data || isGuest())                     { text = 'On this device'; }
  else if (!getWorkerUrl())                       { text = 'Sync not set up'; cls = 'bad'; }
  else if (App.syncState === 'busy')              { text = 'Syncing…'; cls = 'busy'; }
  else if (App.syncState === 'session-expired')   { text = 'Sign in to sync'; cls = 'bad'; }
  else if (App.syncState === 'push-failed')       { text = 'Not synced'; cls = 'bad'; }
  else if (App.syncState === 'offline')           { text = 'Offline'; cls = 'bad'; }
  else if (App.lastSyncAt)                        { text = 'Synced'; cls = 'ok'; }
  else                                            { text = 'Sync'; }
  pill.textContent = text;
  pill.className = `sync-pill ${cls}`;
  pill.title = App.lastSyncAt ? `Last synced ${fmt(App.lastSyncAt)}` : 'Sync status';
}

function renderBanner() {
  const el = $('banner');
  if (!el) return;
  let html = '';
  if (App.storageBlocked) {
    html = 'This browser refused to save. Changes may be lost when you close the page — copy a backup from Settings.';
  } else if (App.syncState === 'push-failed') {
    html = 'Changes aren’t reaching the sync server. They’re safe on this device. <button class="btn btn-sm btn-outline" data-act="retry-sync">Retry</button>';
  } else if (App.syncState === 'session-expired' && isGoogle()) {
    html = 'Your Google sign-in expired. Changes are saved on this device. <button class="btn btn-sm btn-outline" data-act="reauth">Sign in</button>';
  }
  el.innerHTML = html;
  el.hidden = !html;
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer, undoFn;
function toast(msg, onUndo) {
  $('toastMsg').textContent = msg;
  undoFn = onUndo || null;
  $('toastUndo').hidden = !onUndo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoFn = null; }, onUndo ? 6000 : 3000);
}

// ── Modals ────────────────────────────────────────────────────────
function openModal(id)  { $(id)?.classList.add('open'); }
function closeModal(id) { $(id)?.classList.remove('open'); }

function appConfirm({ title, message, confirmLabel = 'OK', danger = false, copyValue = '' }) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = message;
    $('confirm-copy').style.display = copyValue ? '' : 'none';
    $('confirm-copy-value').textContent = copyValue;
    const ok = $('confirm-ok');
    ok.textContent = confirmLabel;
    ok.style.background = ok.style.borderColor = danger ? 'var(--red)' : '';
    const done = v => {
      closeModal('modal-confirm');
      ok.onclick = $('confirm-cancel').onclick = null;
      resolve(v);
    };
    ok.onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
    openModal('modal-confirm');
  });
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast('Couldn’t copy — select the text and copy it manually.'); }
}

// ── Board rendering ───────────────────────────────────────────────
const tasks = () => Object.entries(App.data?.items || {});
const lastNote = it => (it.notes && it.notes.length) ? it.notes[it.notes.length - 1] : null;
const seenToday = it => { const n = lastNote(it); return !!n && dayKey(n.at) === dayKey(Date.now()); };

function lastLabel(it) {
  const n = lastNote(it);
  if (!n) return '<span class="late">Not seen yet</span>';
  const d = daysBetween(n.at, Date.now());
  if (d === 0) return 'Seen today at ' + esc(fmtTime(n.at));
  if (d === 1) return '<span class="late">Last seen yesterday</span>';
  return `<span class="late">Last seen ${d} days ago</span>`;
}

function card(id, it, archived) {
  const isOpen = View.open.has(id), seen = !archived && seenToday(it), n = lastNote(it);
  const days   = daysBetween(it.createdAt, archived ? (it.doneAt || Date.now()) : Date.now()) + 1;
  const notes  = (it.notes || []).slice().reverse();
  const meta   = archived
    ? `Done ${esc(fmtDay(it.doneAt))} · ${days} day${days > 1 ? 's' : ''} on rounds · ${notes.length} note${notes.length === 1 ? '' : 's'}`
    : `Day ${days} · ${lastLabel(it)}`;
  const sid = esc(id);

  let body = '';
  if (isOpen) {
    const log = notes.length
      ? `<ol class="log">${notes.map(x => `<li><button class="x" type="button" data-act="delnote" data-n="${esc(x.id)}" aria-label="Remove note">Remove</button><time>${esc(fmt(x.at))}</time><p class="${x.text ? '' : 'empty'}">${x.text ? esc(x.text) : 'Checked in, no notes'}</p></li>`).join('')}</ol>`
      : '<p class="meta" style="margin:0">No notes yet.</p>';
    const rename = View.renaming === id
      ? `<form class="note-row" data-act="rename-save"><input id="r-${sid}" value="${esc(it.title)}" aria-label="New name" maxlength="200"><button class="btn pri">Save</button><button type="button" class="btn btn-ghost" data-act="rename-cancel">Cancel</button></form>`
      : '';
    body = archived
      ? `<div class="body">${log}<div class="actions"><button class="btn pri" type="button" data-act="reopen">Put back on rounds</button><button class="btn red btn-ghost" type="button" data-act="delete">Delete</button></div></div>`
      : `<div class="body">${rename}<form data-act="note"><textarea id="n-${sid}" placeholder="What’s the status today?" aria-label="Today’s note">${esc(View.drafts[id] || '')}</textarea><div class="note-row"><button class="btn pri">Log note</button><button type="button" class="btn" data-act="touch">Seen, no notes</button></div></form>${log}<div class="actions"><button class="btn" type="button" data-act="done">Mark done &amp; archive</button><button class="btn btn-ghost" type="button" data-act="rename">Rename</button><button class="btn red btn-ghost" type="button" data-act="delete">Delete</button></div></div>`;
  }
  return `<li class="card${seen ? ' seen' : ''}${isOpen ? ' open' : ''}" data-id="${sid}"><button class="head" type="button" data-act="toggle" aria-expanded="${isOpen}"><span class="tick">${seen ? '✓' : ''}</span><span class="t">${esc(it.title)}</span><span class="meta">${meta}</span>${!isOpen && n && n.text ? `<span class="peek">${esc(n.text)}</span>` : ''}</button>${body}</li>`;
}

function render() {
  if (!App.data) return;
  const a = document.activeElement, fid = a && a.id;
  const sel = a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  const now = Date.now();
  App.renderedDay = dayKey(now);

  $('date').textContent = new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const active = tasks().filter(([, it]) => it.status !== 'done');
  const done   = tasks().filter(([, it]) => it.status === 'done');
  const seenN  = active.filter(([, it]) => seenToday(it)).length;

  $('count').innerHTML = active.length ? `<b>${seenN}</b> of ${active.length}<br>seen today` : '';
  $('strip').innerHTML = active.map(([, it]) => seenToday(it)).sort((x, y) => y - x)
    .map(on => `<i class="${on ? 'on' : ''}"></i>`).join('');
  $('tabR').setAttribute('aria-current', View.tab === 'rounds');
  $('tabA').setAttribute('aria-current', View.tab === 'archive');
  $('tabA').textContent = done.length ? `Archive (${done.length})` : 'Archive';

  let h = '';
  if (View.tab === 'rounds') {
    active.sort(([, x], [, y]) =>
      (seenToday(x) - seenToday(y)) || ((lastNote(x)?.at || 0) - (lastNote(y)?.at || 0)) || (x.createdAt - y.createdAt));
    h = `<form class="add" data-act="add"><input id="newTitle" placeholder="Add something to check on daily" aria-label="New item" maxlength="200" autocomplete="off" value="${esc(View.drafts.__new || '')}"><button class="btn pri">Add</button></form>`;
    if (active.length) {
      if (seenN === active.length) h += '<p class="done-line">Rounds complete for today.</p>';
      h += `<ol class="list">${active.map(([id, it]) => card(id, it, false)).join('')}</ol>`;
    } else {
      h += `<div class="empty-state"><strong>${done.length ? 'All clear' : 'No one on the ward'}</strong>Add a task above. Visit it each day, log a note, and archive it when it’s done.</div>`;
    }
  } else {
    const q = View.q.toLowerCase();
    const list = done
      .filter(([, it]) => !q || it.title.toLowerCase().includes(q) || (it.notes || []).some(n => (n.text || '').toLowerCase().includes(q)))
      .sort(([, x], [, y]) => (y.doneAt || 0) - (x.doneAt || 0));
    h = `<form class="add" data-act="noop"><input id="search" type="search" placeholder="Search archived items and notes" aria-label="Search archive" value="${esc(View.q)}"></form>`;
    h += list.length
      ? `<ol class="list">${list.map(([id, it]) => card(id, it, true)).join('')}</ol>`
      : `<div class="empty-state"><strong>${q ? 'No matches' : 'Nothing archived yet'}</strong>${q ? 'Try another word.' : 'Items you mark done land here with their full history.'}</div>`;
  }
  $('main').innerHTML = h;
  if (fid) {
    const el = $(fid);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
  }
  renderSyncPill();
}

// ── Board actions ─────────────────────────────────────────────────
function logNote(id, text) {
  const it = App.data.items[id];
  if (!it) return;
  const before = clone(it);
  const t = clone(it);
  const note = { id: newId(), at: Date.now(), text: text.trim() };
  t.notes = [...(t.notes || []), note];
  delete View.drafts[id];
  View.open.delete(id);
  saveTask(id, t);
  // Undo removes the note the same way a manual removal does, so it holds
  // even if the note already synced.
  toast(note.text ? 'Note logged' : 'Marked seen', () => {
    const cur = clone(App.data.items[id] || before);
    cur.notes = (cur.notes || []).filter(n => n.id !== note.id);
    cur.deletedNotes = [...(cur.deletedNotes || []), note.id];
    saveTask(id, cur);
  });
}

function onMainClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'FORM') return;
  const li = b.closest('.card'), id = li?.dataset.id, act = b.dataset.act;
  const it = id ? App.data.items[id] : null;

  if (act === 'toggle') {
    View.open.has(id) ? View.open.delete(id) : View.open.add(id);
    if (View.renaming === id && !View.open.has(id)) View.renaming = null;
    render();
    if (View.open.has(id) && matchMedia('(hover: hover)').matches) $('n-' + id)?.focus();
    return;
  }
  if (!it) return;
  const before = clone(it);
  const restore = () => saveTask(id, clone(before));

  if (act === 'touch') logNote(id, '');
  else if (act === 'done') {
    const t = clone(it); t.status = 'done'; t.doneAt = Date.now();
    View.open.delete(id); saveTask(id, t);
    toast(`Archived “${it.title}”`, restore);
  } else if (act === 'reopen') {
    const t = clone(it); t.status = 'active'; delete t.doneAt;
    View.open.delete(id); saveTask(id, t);
    toast('Back on rounds', restore);
  } else if (act === 'delete') {
    View.open.delete(id); removeTask(id);
    toast(`Deleted “${it.title}”`, restore);
  } else if (act === 'delnote') {
    const nid = b.dataset.n;
    const gone = (it.notes || []).find(n => n.id === nid);
    const t = clone(it);
    t.notes = (t.notes || []).filter(n => n.id !== nid);
    t.deletedNotes = [...(t.deletedNotes || []), nid];
    saveTask(id, t);
    // A removed note id stays removed on every device, so Undo brings the
    // note back under a fresh id.
    toast('Note removed', () => {
      if (!gone) return;
      const cur = clone(App.data.items[id] || before);
      cur.notes = [...(cur.notes || []), { ...gone, id: newId() }].sort((x, y) => x.at - y.at);
      saveTask(id, cur);
    });
  } else if (act === 'rename') {
    View.renaming = id; render();
    const r = $('r-' + id); if (r) { r.focus(); r.select(); }
  } else if (act === 'rename-cancel') {
    View.renaming = null; render();
  }
}

function onMainSubmit(e) {
  e.preventDefault();
  const f = e.target, act = f.dataset.act;
  if (act === 'add') {
    const v = $('newTitle').value.trim();
    if (!v) return;
    const id = newId(), now = Date.now();
    delete View.drafts.__new;
    saveTask(id, { title: v, createdAt: now, status: 'active', notes: [], deletedNotes: [] });
    $('newTitle')?.focus();
    return;
  }
  const id = f.closest('.card')?.dataset.id, it = id && App.data.items[id];
  if (!it) return;
  if (act === 'note') {
    const v = $('n-' + id).value;
    if (v.trim()) logNote(id, v);
  } else if (act === 'rename-save') {
    const v = $('r-' + id).value.trim();
    View.renaming = null;
    if (v && v !== it.title) { const t = clone(it); t.title = v; saveTask(id, t); }
    else render();
  }
}

function onMainInput(e) {
  const t = e.target;
  if (t.id === 'newTitle') View.drafts.__new = t.value;
  else if (t.id === 'search') { View.q = t.value; render(); }
  else if (t.id.startsWith('n-')) View.drafts[t.id.slice(2)] = t.value;
}

function setTab(tab) {
  View.tab = tab; View.open.clear(); View.renaming = null;
  try { history.replaceState(null, '', tab === 'archive' ? '#archive' : location.pathname + location.search); } catch {}
  render();
}

// ── Settings ──────────────────────────────────────────────────────
// auth.js hides the Worker URL field for guests; Rounds always shows it so
// the address can be set (or changed) on any browser.
function renderAccountSection() {
  Auth.renderSettingsSection();
  $('settings-worker-group').style.display = '';
}

function openSettings() {
  renderAccountSection();
  $('settings-worker-url').value = App.data.workerUrl || '';
  $('settings-signout-all').style.display = Auth.isGoogleAccount() ? '' : 'none';
  $('settings-sync-info').textContent = App.lastSyncAt
    ? `Last synced ${fmt(App.lastSyncAt)}${App.syncState === 'push-failed' ? ' — last attempt failed' : ''}`
    : (App.lastSyncMsg ? `Last attempt: ${App.lastSyncMsg}` : 'Not synced yet on this device.');
  $('app-version').textContent = `Rounds v${APP_VERSION}`;
  openModal('modal-settings');
}

async function switchAccount() {
  closeModal('modal-settings');
  if (isGuest()) { Auth.showSetupFresh(); return; }
  const token   = App.data.userToken;
  const isToken = Auth.isTokenAccount() && token;
  const unsynced = isDirty() ? '\n\nThis device has changes that haven’t synced yet — they’ll be lost.' : '';
  const go = await appConfirm({
    title: 'Switch or create account',
    message: (isToken
      ? 'Switching clears this device. Save this account’s token first — it’s the only way back to its data.'
      : 'Switching clears this device. Your data stays in sync and comes back when you sign in again.') + unsynced,
    copyValue: isToken ? token : '',
    confirmLabel: 'Switch account',
    danger: true,
  });
  if (!go) { openSettings(); return; }
  stopSyncPing();
  Auth.stopSessionWatch();
  ls.remove(STORAGE_AUTH_KEY);
  ls.remove(STORAGE_WRITE_KEY);
  clearDirty();
  const workerUrl = App.data.workerUrl;
  App.data = defaultData();
  App.data.workerUrl = workerUrl || '';
  App.lastSyncAt = 0; App.syncState = null;
  saveLocal();
  render();
  Auth.showAccountSetup();
}

// ── Auth callbacks ────────────────────────────────────────────────
function onSignedIn(data, isNew) {
  const incoming = mergeData(data);
  // Keep anything made on this device before signing in (e.g. as a guest).
  App.data = { ...incoming, ...mergeCollections(incoming, App.data || {}) };
  App.data.lastModified = Date.now();
  markDirty();
  saveLocal();
  render();
  setSyncState(null);
  toast(isNew ? 'Welcome to Rounds' : 'Account loaded — syncing…');
  // Deferred: auth.js stores the fresh Google ID token right after this
  // callback returns, and the write key can only be minted once it has.
  setTimeout(async () => {
    await Auth.ensureWriteKey();
    startSyncPing();
    Auth.startSessionWatch(() => handleAuthFailure());
    syncNow(true);
  }, 0);
}

function onGuestReady(data) {
  App.data = { ...mergeData(data), items: App.data.items, tombstones: App.data.tombstones };
  saveLocal();
  render();
}

async function fetchGoogleClientId() {
  const base = getWorkerUrl();
  if (!base) return '';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${base}/auth/config`, { signal: ctl.signal });
    if (!res.ok) return '';
    return (await res.json()).googleClientId || '';
  } catch { return ''; }
  finally { clearTimeout(t); }
}

// ── Boot ──────────────────────────────────────────────────────────
// Kept so a Worker URL saved later can update the Google client ID in place.
let authConfig = null;
async function boot() {
  const stored = ls.get(STORAGE_KEY);
  App.data = stored ? mergeData(stored) : defaultData();
  render();

  authConfig = {
    googleClientId: await fetchGoogleClientId(),
    hmacSalt:          HMAC_SALT,
    storageKey:        STORAGE_KEY,
    storageAuthKey:    STORAGE_AUTH_KEY,
    storageDismissKey: STORAGE_DISMISS_KEY,
    storageWriteKey:   STORAGE_WRITE_KEY,
    workerBase:        getWorkerUrl,
    getData:           () => App.data,
    setData:           d => { App.data = d; saveLocal(); renderSyncPill(); },
    mergeData,
    onSignedIn,
    onGuestReady,
    onSessionExpired:  () => {},
    pushToWorker,
    startSyncPing,
    openModal,
    closeModal,
    toast,
    appName:           'Rounds',
    appEmoji:          '✓',
  };
  Auth.init(authConfig);
  render();

  if (!stored) { Auth.showAccountSetup(); return; }
  if (isGuest()) return;

  const ok = await Auth.bootCheck(App.data.userToken);
  if (!ok) { setSyncState('session-expired'); return; }
  await Auth.ensureWriteKey();
  startSyncPing();
  Auth.startSessionWatch(() => handleAuthFailure());
  syncNow(isDirty());
}

// ── Wiring ────────────────────────────────────────────────────────
$('main').addEventListener('click', onMainClick);
$('main').addEventListener('submit', onMainSubmit);
$('main').addEventListener('input', onMainInput);
$('main').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.tagName === 'TEXTAREA') {
    e.preventDefault(); e.target.form.requestSubmit();
  }
});
document.querySelector('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) setTab(b.dataset.view);
});
window.addEventListener('hashchange', () => { View.tab = location.hash === '#archive' ? 'archive' : 'rounds'; render(); });
$('toastUndo').addEventListener('click', () => { const f = undoFn; undoFn = null; $('toast').hidden = true; f?.(); });

$('btnSettings').addEventListener('click', openSettings);
$('syncPill').addEventListener('click', () => {
  if (canSync() && App.syncState !== 'session-expired') {
    syncNow(true).then(ok => toast(ok ? 'Synced ✓' : 'Couldn’t sync — your work is safe on this device.'));
  } else openSettings();
});
$('banner').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'retry-sync') syncNow(true);
  if (act === 'reauth') { App.authPromptOpen = false; handleAuthFailure(); }
});
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
$('modal-settings').addEventListener('click', e => { if (e.target.id === 'modal-settings') closeModal('modal-settings'); });

$('settings-token-copy').addEventListener('click', () => copyText(App.data.userToken || '', 'Token copied ✓'));
$('confirm-copy-btn').addEventListener('click', () => copyText($('confirm-copy-value').textContent, 'Token copied ✓'));
$('settings-worker-save').addEventListener('click', async () => {
  const v = $('settings-worker-url').value.trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//.test(v)) { toast('The Worker URL should start with https://'); return; }
  App.data.workerUrl = v;
  $('settings-worker-url').value = v;
  saveLocal();
  renderSyncPill();
  if (!v) { toast('Worker URL cleared — sync is off on this browser'); return; }
  // Pick up this Worker's Google client ID so Google options work right away.
  authConfig.googleClientId = await fetchGoogleClientId();
  renderAccountSection();
  toast('Worker URL saved on this browser');
  syncNow(true);
});
$('settings-sync-now').addEventListener('click', async () => {
  const ok = await syncNow(true);
  toast(ok ? 'Synced ✓' : 'Couldn’t sync — your work is safe on this device.');
  openSettings();
});
$('settings-upgrade-btn').addEventListener('click', () => {
  if (!window.google?.accounts?.id || !Auth.isGoogleAuthAvailable()) {
    toast('Google sign-in isn’t available yet — check the Worker’s GOOGLE_CLIENT_ID, then reload.');
    return;
  }
  closeModal('modal-settings');
  Auth.showGoogleUpgradeFlow();
});
$('settings-account-btn').addEventListener('click', switchAccount);
$('settings-signout-all').addEventListener('click', async () => {
  const go = await appConfirm({
    title: 'Sign out on all devices?',
    message: 'Every device, this one included, will need to sign in with Google again before it can sync.',
    confirmLabel: 'Sign out everywhere', danger: true,
  });
  if (!go) return;
  const ok = await Auth.revokeWriteKeys();
  toast(ok ? 'Signed out on all devices' : 'Couldn’t reach the sync server — try again.');
  if (ok) { closeModal('modal-settings'); handleAuthFailure(); }
});
$('settings-export').addEventListener('click', () => {
  const { items, tombstones } = App.data;
  copyText(JSON.stringify({ app: 'Rounds', exportedAt: new Date().toISOString(), items, tombstones }, null, 2), 'Backup copied ✓');
});

// Save and push when the page is hidden; catch up when it comes back.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (!App.data) return;
  if (document.hidden) {
    hiddenAt = Date.now();
    saveLocal();
    if (isDirty()) syncNow(true);
    return;
  }
  if (dayKey(Date.now()) !== App.renderedDay) render();
  if (hiddenAt && Date.now() - hiddenAt >= FOREGROUND_PULL_MS) syncNow();
  hiddenAt = 0;
});
window.addEventListener('pagehide', () => { if (App.data) saveLocal(); });
// Roll the board over at midnight if the page is left open.
setInterval(() => { if (App.data && dayKey(Date.now()) !== App.renderedDay) render(); }, 60_000);

boot();
