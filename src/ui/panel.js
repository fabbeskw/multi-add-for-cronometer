/* Multi-Add for Cronometer — Shadow-DOM panel (SPEC §8).
 *
 *   CMA.panel = { mount(), toggle(), open(view), close(), setState(partial), isOpen(), ... }
 *
 * Views: Input | Preview | Results | Diagnostics | Settings, plus views other scripts add with
 * CMA.panel.registerView({id, label, order, render(ctx), onEvent, diagnostics, unmount, css}) — the TDEE view
 * (src/ui/tdee-view.js) is one; see "View registry" below.
 * Mounted by content.js (which also maps Alt+Shift+M → CMA.panel.toggle()).
 *
 * Wiring (all optional at load time, resolved lazily so load order / test stubs do not matter):
 *   CMA.capture.state / CMA.capture.ready()   → readiness banner, groups, diary date, session values
 *   CMA.events.on('state', fn)                → refresh banner / groups / date when the capture changes
 *   CMA.parse.lines(text)                     → items
 *   CMA.plan.build / rechoose / repick / reposition / assignPositions / defaultGroupId
 *   CMA.engineRpc.run / undo / loadLastBatch  (engine 'rpc')
 *   CMA.engineUi.run                          (engine 'ui'; gets opts.waitForRefresh from uiRefreshSignal(),
 *                                              which turns the hook's updateDiary responses into the
 *                                              per-row diary-refresh signal of SPEC §7 step 7)
 *   chrome.storage.local                      → settings (cmaSettings) + last input (cmaLastInput), guarded
 *   CMA.registryStore.status / rebuild        → decoder (registry) banner states in the Input view and the
 *   CMA.events 'registry' / 'registry-progress'  Diagnostics "Rebuild decoder" button (SPEC §3.5)
 *
 * Safety rules (SPEC §0): the session nonce is never persisted and never shown — the diagnostics dump
 * replaces it with 'present'/'missing' and additionally scrubs the literal value from the whole text.
 * No innerHTML with untrusted strings: every node is created with createElement/textContent (food
 * names, measure names and error messages all come from the server).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ---------------------------------------------------------------------------
  // Minimal pub/sub fallback. capture.js owns CMA.events (SPEC §2.3); this guard only exists so the
  // panel can run stand-alone (tests, or a build where capture.js failed to load).
  // ---------------------------------------------------------------------------
  if (!CMA.events) {
    const handlers = {};
    CMA.events = {
      on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => CMA.events.off(name, fn); },
      off(name, fn) { const l = handlers[name]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
      emit(name, data) { (handlers[name] || []).slice().forEach(fn => { try { fn(data); } catch (e) { /* listeners never break the emitter */ } }); }
    };
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const HOST_ID = 'cma-multi-add-host';
  const SETTINGS_KEY = 'cmaSettings';
  const INPUT_KEY = 'cmaLastInput';
  const DEFAULT_SETTINGS = Object.freeze({ engine: 'rpc', delayMs: 250, rememberInput: true });
  // Built-in views. Other scripts add views through CMA.panel.registerView (see "View registry" below); the tab
  // order is by `order` (built-ins 10..50, a registered view defaults to 35 = just before Diagnostics).
  const BUILTIN_VIEWS = ['input', 'preview', 'results', 'diagnostics', 'settings'];
  const VIEW_LABELS = { input: 'Input', preview: 'Preview', results: 'Results', diagnostics: 'Diagnostics', settings: 'Settings' };
  const BUILTIN_ORDER = { input: 10, preview: 20, results: 30, diagnostics: 40, settings: 50 };
  const DEFAULT_VIEW_ORDER = 35;
  const VIEW_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const MAX_LOG = 200;
  const LOG_TAIL = 50;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DEFAULT_GROUP_NAMES = ['Uncategorized', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Group 6', 'Group 7', 'Group 8'];
  // SPEC §7 / recipe §1a: the toolbar FOOD button (authored class + title, stable across deploys).
  const FOOD_BUTTON_SEL = 'button.button-panel-btn[title="Log a serving to your diary"]';
  const MULTI_BUTTON_CLASS = 'cma-multi-btn';
  const PLACEHOLDER = [
    'One food per line, e.g.',
    '200g chicken breast',
    '2 large eggs',
    '1 1/2 cups rice, cooked',
    'banana',
    '3 tbsp olive oil @lunch',
    '## Dinner',
    'salmon 150g',
    '1 cup broccoli'
  ].join('\n');

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    mounted: false,
    open: false,
    view: 'input',
    input: '',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    settingsLoaded: false,
    defaultGroupId: null,
    dateOverride: null,          // {day, month, year} | null (Input view date input)
    degraded: false,             // plan built for the UI engine without an RPC session (unverified rows)
    plan: null,
    building: false,
    buildStatus: '',
    busy: false,                 // a rechoose (getFood) is in flight
    running: false,
    cancel: false,
    runStatus: '',
    rowProgress: new Map(),      // row → {ok, message} while the RPC engine runs
    result: null,                // normalised engine result
    undoing: false,
    undoResult: null,
    storedBatch: null,           // lastBatch loaded from chrome.storage on mount (undo of a previous session)
    storedInput: null,           // {text, userId} from chrome.storage, restored once the account is known to match
    notice: null,                // {text, error}
    registryBusy: false,         // a manual "Rebuild decoder" (Diagnostics) is in flight
    registryOutcome: null,       // {text, cls:'ok'|'err'|null} shown next to that button
    log: []
  };
  let host = null;
  let root = null;
  let els = {};
  let toolbarObserver = null;
  let toolbarTimer = null;
  let inputSaveTimer = null;
  let drag = null;
  let renderedView = null;       // the view whose content els.body holds (a registered view is told 'hidden' when it changes)
  const customViews = new Map(); // id → {id, label, order, seq, def, css, styleEl}: views added by registerView
  let viewSeq = 0;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function el(tag, props) {
    const e = document.createElement(tag);
    let value;
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = String(v);
        else if (k === 'value') value = v;
        else if (k === 'on') for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]);
        else if (k === 'data') for (const d of Object.keys(v)) e.dataset[d] = v[d];
        else if (k === 'style') e.style.cssText = v;
        else if (k === 'disabled' || k === 'checked' || k === 'hidden' || k === 'selected' || k === 'open') e[k] = !!v;
        else e.setAttribute(k, String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(e, arguments[i]);
    if (value !== undefined) e.value = String(value); // after children so <select> can pick an option
    return e;
  }
  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(c => append(parent, c)); return; }
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function btn(label, onClick, opts) {
    const o = opts || {};
    return el('button', {
      type: 'button',
      class: 'cma-btn' + (o.primary ? ' cma-btn-primary' : '') + (o.danger ? ' cma-btn-danger' : '') + (o.small ? ' cma-btn-small' : '') + (o.class ? ' ' + o.class : ''),
      title: o.title, disabled: o.disabled, data: o.data,
      on: { click: (ev) => { ev.preventDefault(); try { const r = onClick(ev); if (r && typeof r.catch === 'function') r.catch(e => notify(errText(e), true)); } catch (e) { notify(errText(e), true); } } }
    }, label);
  }
  function option(value, label, selected) { return el('option', { value: String(value), selected: !!selected }, label); }

  function nowIso() { return new Date().toISOString(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function capState() { return CMA.capture && CMA.capture.state ? CMA.capture.state : {}; }
  function nonceValue() { const n = capState().nonce; return typeof n === 'string' && n.length ? n : null; }
  /** Scrub the literal nonce from any string that is shown or logged (SPEC §0): the current one, and — through
   *  capture.redact — every nonce ever captured, so an older token rotated out by reauthenticate is scrubbed too. */
  function redact(s) {
    let t = s == null ? '' : String(s);
    const n = nonceValue();
    if (n && t.indexOf(n) >= 0) t = t.split(n).join('[nonce]');
    try { if (CMA.capture && typeof CMA.capture.redact === 'function') t = CMA.capture.redact(t); } catch (e) { /* keep t */ }
    return t;
  }
  function errText(e) {
    if (!e) return 'unknown error';
    const m = e && (e.message || e.reason) ? (e.message || e.reason) : String(e);
    return redact(m);
  }
  function log(msg) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + redact(msg);
    state.log.push(line);
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  }
  function notify(text, isError) {
    state.notice = text ? { text: redact(text), error: !!isError } : null;
    if (isError) log('error: ' + text);
    renderNotice();
  }

  function readiness() {
    try {
      if (CMA.capture && typeof CMA.capture.ready === 'function') {
        const r = CMA.capture.ready();
        if (r && typeof r === 'object') return { ok: !!r.ok, missing: Array.isArray(r.missing) ? r.missing : [] };
        return { ok: !!r, missing: r ? [] : ['capture'] };
      }
    } catch (e) { return { ok: false, missing: ['capture error: ' + errText(e)] }; }
    return { ok: false, missing: ['capture (extension not fully loaded)'] };
  }
  function sessionFrom() {
    const c = capState();
    return { moduleBase: c.moduleBase, permutation: c.permutation, policyHash: c.policyHash, nonce: c.nonce, userId: c.userId };
  }
  function groups() {
    const c = capState();
    let gs = Array.isArray(c.groups) && c.groups.length ? c.groups : (CMA.plan && CMA.plan.DEFAULT_GROUPS) || null;
    if (!gs) gs = DEFAULT_GROUP_NAMES.map((name, id) => ({ id, name, enabled: id <= 4 }));
    return gs.map((g, i) => ({ id: g.id != null ? Number(g.id) : i, name: String(g.name || DEFAULT_GROUP_NAMES[i] || ('Group ' + (i + 1))), enabled: g.enabled !== false }));
  }
  function enabledGroups() { const gs = groups().filter(g => g.enabled); return gs.length ? gs : groups(); }
  function groupName(id) { const g = groups().find(x => x.id === Number(id)); return g ? g.name : 'group ' + id; }
  function currentDefaultGroupId() {
    const gs = enabledGroups();
    if (state.defaultGroupId != null && gs.some(g => g.id === Number(state.defaultGroupId))) return Number(state.defaultGroupId);
    let id = null;
    try { if (CMA.plan && typeof CMA.plan.defaultGroupId === 'function') id = CMA.plan.defaultGroupId(groups()); } catch (e) { id = null; }
    if (id == null || !gs.some(g => g.id === Number(id))) id = gs[0] ? gs[0].id : 0;
    state.defaultGroupId = Number(id);
    return state.defaultGroupId;
  }
  function todayDate() { const d = new Date(); return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() }; }
  function diaryDate() {
    if (state.dateOverride) return { source: 'override', date: state.dateOverride };
    const c = capState();
    if (c.diaryDate && c.diaryDate.year) return { source: c.diaryDateSource || 'diary', date: c.diaryDate };
    return { source: 'today', date: todayDate() };
  }
  function formatDate(d) { return d ? d.day + ' ' + (MONTHS[d.month - 1] || d.month) + ' ' + d.year : '?'; }
  function sameDate(a, b) { return !!a && !!b && Number(a.day) === Number(b.day) && Number(a.month) === Number(b.month) && Number(a.year) === Number(b.year); }
  /** The GWT app's hidden <iframe id="cronometer"> (SPEC 2.1): absent on the logged-out landing page, /login/ and the blog. */
  function appElementPresent() { try { return !!document.getElementById('cronometer'); } catch (e) { return false; } }
  function isoDate(d) { return d ? d.year + '-' + pad2(d.month) + '-' + pad2(d.day) : ''; }
  function parseIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return { day: Number(m[3]), month: Number(m[2]), year: Number(m[1]) };
  }
  function formatQty(q) {
    if (CMA.units && typeof CMA.units.formatQuantity === 'function') { try { return CMA.units.formatQuantity(q); } catch (e) { /* fall through */ } }
    if (!isFinite(q)) return '';
    return String(Math.round(q * 1000) / 1000);
  }
  function formatGrams(g) {
    if (g == null || !isFinite(g)) return '';
    const r = Math.round(g * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + ' g';
  }
  function formatBytes(n) {
    if (n == null || !isFinite(n)) return '?';
    if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function formatSeconds(ms) { return ms == null || !isFinite(ms) ? '?' : (Math.round(ms / 100) / 10) + ' s'; }
  /** '3 min ago' / '40 s ago' / '2 h ago' for a Date.now() timestamp. */
  function formatAgo(at) {
    const s = Math.max(0, Math.round((Date.now() - Number(at)) / 1000));
    if (!isFinite(s)) return 'earlier';
    if (s < 90) return s + ' s ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }
  // persistence of the rebuilt decoder can fail with chrome.storage present (quota, an invalidated context)
  const NOT_SAVED_NOTE = 'not saved to chrome.storage (kept for this page)';
  const DECODER_GATE_TITLE = 'The decoder does not match the live Cronometer build: wait for the rebuild (see the Input view), press "Rebuild decoder" in Diagnostics, or switch to the UI automation engine';

  // ---------------------------------------------------------------------------
  // chrome.storage.local (guarded: absent in plain test pages; both callback and promise APIs)
  // ---------------------------------------------------------------------------
  function storage() {
    try { return typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
    catch (e) { return null; }
  }
  function storageGet(keys) {
    return new Promise(resolve => {
      const s = storage();
      if (!s) return resolve(null);
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v || null); } };
      try {
        const r = s.get(keys, v => finish(v));
        if (r && typeof r.then === 'function') r.then(finish, () => finish(null));
      } catch (e) { finish(null); }
    });
  }
  function storageSet(obj) {
    return new Promise(resolve => {
      const s = storage();
      if (!s) return resolve(false);
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(!!v); } };
      try {
        const r = s.set(obj, () => finish(true));
        if (r && typeof r.then === 'function') r.then(() => finish(true), () => finish(false));
      } catch (e) { finish(false); }
    });
  }
  function normSettings(s) {
    const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
    o.engine = o.engine === 'ui' ? 'ui' : 'rpc';
    o.delayMs = Math.max(0, Math.min(60000, Number(o.delayMs) || 0));
    if (!(Number(s && s.delayMs) >= 0)) o.delayMs = DEFAULT_SETTINGS.delayMs;
    o.rememberInput = o.rememberInput !== false;
    return o;
  }
  /**
   * The stored input is {text, userId}: it is a small piece of dietary data that survives logouts and cache
   * clears in chrome.storage.local, so — like the stored batch (canOfferStoredBatch) — it is restored only for
   * the account it was typed for. A legacy plain string (older versions) carries no account and is restored
   * whenever the captured account is unknown or nothing contradicts it.
   */
  function parseStoredInput(v) {
    if (typeof v === 'string') return v ? { text: v, userId: null } : null;
    if (v && typeof v === 'object' && typeof v.text === 'string' && v.text) return { text: v.text, userId: v.userId == null ? null : Number(v.userId) };
    return null;
  }
  /** Restore the stored input when it belongs to the captured account (or neither side knows the account). */
  function applyStoredInput() {
    const s = state.storedInput;
    if (!s || !state.settings.rememberInput) return false;
    const uid = capState().userId;
    if (s.userId != null && uid != null && Number(uid) !== s.userId) {
      // another account is logged in on this profile: never show (or keep) the previous account's food list
      state.storedInput = null;
      if (state.input === s.text) { state.input = ''; if (els.textarea) els.textarea.value = ''; updateFindButton(); }
      storageSet({ [INPUT_KEY]: '' }).catch(() => {});
      log('stored input belonged to another account; cleared');
      return false;
    }
    if (state.input) return false;                   // the user already typed something
    state.input = s.text;
    if (els.textarea) { els.textarea.value = state.input; updateFindButton(); }
    if (uid != null) state.storedInput = null;       // settled for this account
    return true;
  }
  async function loadSettings() {
    const v = await storageGet([SETTINGS_KEY, INPUT_KEY]);
    state.settings = normSettings(v && v[SETTINGS_KEY]);
    state.storedInput = state.settings.rememberInput && v ? parseStoredInput(v[INPUT_KEY]) : null;
    applyStoredInput();
    state.settingsLoaded = true;
    return Object.assign({}, state.settings);
  }
  async function saveSettings(partial) {
    state.settings = normSettings(Object.assign({}, state.settings, partial || {}));
    const ok = await storageSet({ [SETTINGS_KEY]: Object.assign({}, state.settings) });
    if (!state.settings.rememberInput) { state.storedInput = null; await storageSet({ [INPUT_KEY]: '' }); }
    return ok;
  }
  function saveInputSoon() {
    if (inputSaveTimer) clearTimeout(inputSaveTimer);
    inputSaveTimer = setTimeout(() => { inputSaveTimer = null; saveInput(); }, 400);
  }
  async function saveInput() {
    if (!state.settings.rememberInput) return false;
    const uid = capState().userId;
    return storageSet({ [INPUT_KEY]: state.input ? { text: state.input, userId: uid != null ? Number(uid) : null } : '' });
  }

  // ---------------------------------------------------------------------------
  // Mount / open / close
  // ---------------------------------------------------------------------------
  function mount() {
    if (state.mounted && host && host.isConnected) return host;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    host = el('div', { id: HOST_ID });
    // Closed: the panel is created from the ISOLATED world, so this closure holds the only reference to the
    // shadow tree — page scripts (DOM-serialising SDKs, session replay) get null from host.shadowRoot and
    // cannot read the typed food list, the hits or the diagnostics dump. Tests reach it through CMA.panel.root.
    root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CMA.panelCss || '';
    root.appendChild(style);
    const wrap = el('div', { class: 'cma' });
    root.appendChild(wrap);
    // Key events are composed: a keydown in the panel's textarea retargets to the host and would bubble to
    // document.body, where Cronometer's DiaryPanel opens its own Add Food dialog on Ctrl+Enter (recipe §1b:
    // `Prh`: ctrlKey && keyCode 13, registered on RootPanel.get() = body). Stop them inside the shadow tree;
    // the Alt+Shift+M listener (content.js) and the engine's Escape listener are capture-phase on
    // window/document and still fire.
    for (const t of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(t, (e) => e.stopPropagation());
    els = { wrap };
    renderedView = null;
    for (const v of customViews.values()) { v.styleEl = null; injectViewCss(v); }
    els.launcher = el('button', { type: 'button', class: 'cma-launcher', title: 'Multi-Add for Cronometer (Alt+Shift+M)', on: { click: () => toggle() } }, 'Multi-add');
    wrap.appendChild(els.launcher);
    els.panel = buildShell();
    els.panel.hidden = true;
    wrap.appendChild(els.panel);
    (document.body || document.documentElement).appendChild(host);
    state.mounted = true;

    subscribeState();
    subscribeRegistry();
    watchToolbar();
    loadSettings().then(() => {
      if (state.view === 'input') renderView();
      return loadStoredBatch();
    }).catch(e => log('settings load failed: ' + errText(e)));
    log('panel mounted');
    return host;
  }
  function unmount() {
    if (unsubState) { try { unsubState(); } catch (e) { /* ignore */ } unsubState = null; }
    unsubRegistry.splice(0).forEach(off => { try { off(); } catch (e) { /* ignore */ } });
    stopToolbarWatch();
    // registered views stay registered (a remount shows their tabs again) but drop their listeners/timers now
    for (const v of customViews.values()) { callView(v, 'unmount'); v.styleEl = null; }
    renderedView = null;
    document.querySelectorAll('.' + MULTI_BUTTON_CLASS).forEach(b => b.remove());
    if (host) host.remove();
    host = null; root = null; els = {};
    state.mounted = false; state.open = false;
  }
  function isOpen() { return state.mounted && state.open; }
  function open(view) {
    mount();
    if (view && isView(view)) state.view = view;
    state.open = true;
    els.panel.hidden = false;
    renderView();
    if (state.view === 'input' && els.textarea) { try { els.textarea.focus(); } catch (e) { /* ignore */ } }
  }
  function close() {
    if (!state.mounted) return;
    state.open = false;
    els.panel.hidden = true;
    // a registered view stops its live updates while the panel is hidden; open() renders it again
    const cv = customViews.get(renderedView);
    renderedView = null;
    if (cv) callView(cv, 'onEvent', 'hidden', null);
  }
  function toggle() { if (isOpen()) close(); else open(); }
  function setState(partial) {
    if (partial && typeof partial === 'object') {
      for (const k of Object.keys(partial)) {
        if (k === 'settings') state.settings = normSettings(Object.assign({}, state.settings, partial.settings));
        else if (k === 'view') { if (isView(partial.view)) state.view = partial.view; }
        else if (k === 'log' || k === 'mounted') continue;
        else state[k] = partial[k];
      }
    }
    if (state.mounted) renderView();
    return getState();
  }
  function getState() {
    return {
      mounted: state.mounted, open: state.open, view: state.view, input: state.input,
      settings: Object.assign({}, state.settings), defaultGroupId: state.defaultGroupId, dateOverride: state.dateOverride,
      building: state.building, running: state.running, busy: state.busy,
      plan: state.plan, result: state.result, storedBatch: state.storedBatch, log: state.log.slice()
    };
  }

  let unsubState = null;
  function subscribeState() {
    const ev = CMA.events;
    if (!ev || unsubState) return;
    const fn = () => onCaptureState();
    try {
      let off = null;
      if (typeof ev.on === 'function') off = ev.on('state', fn);
      else if (typeof ev.subscribe === 'function') off = ev.subscribe('state', fn);
      else if (typeof ev.addListener === 'function') off = ev.addListener('state', fn);
      // remembered so unmount() can remove it: every mount/unmount cycle would otherwise stack a listener
      unsubState = typeof off === 'function' ? off : (typeof ev.off === 'function' ? () => ev.off('state', fn) : () => {});
    } catch (e) { log('events subscribe failed: ' + errText(e)); }
  }
  function onCaptureState() {
    if (!state.mounted) return;
    if (state.storedInput) applyStoredInput();       // the account became known (or changed) after mount
    if (!state.open) return;
    if (state.view === 'input') refreshInputMeta();
    else if (state.view === 'preview') updateAddButton();
    else if (state.view === 'diagnostics') refreshRegistryStatus();
    else forwardViewEvent('state', capState());
  }
  // 'registry' (another registry installed) and 'registry-progress' (a rebuild step) come from
  // CMA.registryStore (SPEC §3.5); capture re-emits 'state' for the former, the progress events only
  // reach the banner through this subscription.
  const unsubRegistry = [];
  function subscribeRegistry() {
    const ev = CMA.events;
    if (!ev || typeof ev.on !== 'function' || unsubRegistry.length) return;
    for (const name of ['registry', 'registry-progress']) {
      const fn = (payload) => onRegistryEvent(name, payload);
      try {
        const off = ev.on(name, fn);
        unsubRegistry.push(typeof off === 'function' ? off : () => { try { ev.off(name, fn); } catch (e) { /* ignore */ } });
      } catch (e) { log('events subscribe failed (' + name + '): ' + errText(e)); }
    }
  }
  function onRegistryEvent(name, payload) {
    if (!state.mounted || !state.open) return;
    if (state.view === 'input') refreshInputMeta();
    else if (state.view === 'preview') updateAddButton();
    else if (state.view === 'diagnostics') refreshRegistryStatus();
    else forwardViewEvent(name, payload);
  }
  const BATCH_TTL_MS = 24 * 3600 * 1000;
  async function loadStoredBatch() {
    try {
      if (CMA.engineRpc && typeof CMA.engineRpc.loadLastBatch === 'function') {
        const b = await CMA.engineRpc.loadLastBatch();
        if (b && Array.isArray(b.servingIds) && b.servingIds.length) {
          if (typeof b.at === 'number' && Date.now() - b.at > BATCH_TTL_MS) {
            // weeks later the entries may have been edited or deleted by hand: forget the batch
            log('stored batch from ' + new Date(b.at).toISOString() + ' expired; forgotten');
            if (typeof CMA.engineRpc.clearLastBatch === 'function') await CMA.engineRpc.clearLastBatch();
            return;
          }
          state.storedBatch = b;
          if (state.view === 'input') renderView();
        }
      }
    } catch (e) { log('loadLastBatch failed: ' + errText(e)); }
  }
  /** The stored batch is offered only to the account it was added to (a shared profile may switch users). */
  function canOfferStoredBatch() {
    const b = state.storedBatch;
    if (!b || !Array.isArray(b.servingIds) || !b.servingIds.length || state.result || state.settings.engine !== 'rpc') return false;
    if (b.userId == null) return true;                      // batch stored by an older version
    const uid = capState().userId;
    return uid != null && Number(uid) === Number(b.userId);
  }

  // ---------------------------------------------------------------------------
  // Toolbar MULTI button next to FOOD (SPEC §8): light DOM so it inherits the app's button styling.
  // GWT re-renders the diary (and its toolbar) on every getDayInfo / updateDiary and on each dialog, so a
  // MutationObserver on the whole document would allocate records and wake up for every one of those
  // mutations for the page's lifetime. Instead the observer is armed only while the button is MISSING
  // (waiting for the toolbar to appear or re-appear) and disconnected as soon as it is in place; the
  // re-render signals that could have removed it — a diary 'rpc' event, a hash change — plus a cheap
  // 1 s `isConnected` check re-arm it.
  // ---------------------------------------------------------------------------
  let multiButton = null;
  let toolbarPoll = null;
  let unsubToolbarRpc = null;
  const onToolbarHash = () => scheduleToolbarCheck();
  function ensureToolbarButton() {
    if (multiButton && multiButton.isConnected) return true;
    let food;
    try { food = document.querySelector(FOOD_BUTTON_SEL); } catch (e) { food = null; }
    if (!food || !food.parentNode) return false;
    const existing = food.parentNode.querySelector('.' + MULTI_BUTTON_CLASS);
    if (existing) { multiButton = existing; return true; }
    const b = el('button', {
      type: 'button',
      class: 'gwt-Button button-panel-btn ' + MULTI_BUTTON_CLASS,
      title: 'Add many foods to your diary (Multi-add, Alt+Shift+M)',
      data: { cma: 'multi' },
      on: { click: (ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(); } }
    }, el('span', null, 'MULTI'));
    food.parentNode.insertBefore(b, food.nextSibling);
    multiButton = b;
    return true;
  }
  /** Insert the button if possible; observe the document only while it is still missing. */
  function toolbarCheck() {
    let ok = false;
    try { ok = ensureToolbarButton(); } catch (e) { ok = false; }
    if (ok) { if (toolbarObserver) { try { toolbarObserver.disconnect(); } catch (e) { /* ignore */ } toolbarObserver = null; } return true; }
    if (!toolbarObserver && typeof MutationObserver === 'function' && document.documentElement) {
      try {
        toolbarObserver = new MutationObserver(() => scheduleToolbarCheck());
        toolbarObserver.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { toolbarObserver = null; log('toolbar observer failed: ' + errText(e)); }
    }
    return false;
  }
  function scheduleToolbarCheck() {
    if (toolbarTimer) return;
    toolbarTimer = setTimeout(() => { toolbarTimer = null; if (state.mounted) toolbarCheck(); }, 250);
  }
  function watchToolbar() {
    toolbarCheck();
    if (!toolbarPoll) toolbarPoll = setInterval(() => { if (!(multiButton && multiButton.isConnected)) scheduleToolbarCheck(); }, 1000);
    try { window.addEventListener('hashchange', onToolbarHash); } catch (e) { /* ignore */ }
    try {
      if (!unsubToolbarRpc && CMA.events && typeof CMA.events.on === 'function') {
        const fn = (ev) => { if (ev && (ev.method === 'getDayInfo' || ev.method === 'updateDiary')) scheduleToolbarCheck(); };
        const off = CMA.events.on('rpc', fn);
        unsubToolbarRpc = typeof off === 'function' ? off : () => { try { CMA.events.off('rpc', fn); } catch (e) { /* ignore */ } };
      }
    } catch (e) { /* ignore */ }
  }
  function stopToolbarWatch() {
    if (toolbarObserver) { try { toolbarObserver.disconnect(); } catch (e) { /* ignore */ } toolbarObserver = null; }
    if (toolbarTimer) { clearTimeout(toolbarTimer); toolbarTimer = null; }
    if (toolbarPoll) { clearInterval(toolbarPoll); toolbarPoll = null; }
    if (unsubToolbarRpc) { try { unsubToolbarRpc(); } catch (e) { /* ignore */ } unsubToolbarRpc = null; }
    try { window.removeEventListener('hashchange', onToolbarHash); } catch (e) { /* ignore */ }
    multiButton = null;
  }

  // ---------------------------------------------------------------------------
  // Shell: header (draggable) + nav + body + footer
  // ---------------------------------------------------------------------------
  function buildShell() {
    const nav = el('div', { class: 'cma-nav', role: 'tablist' });
    els.nav = nav;
    buildTabs();
    const header = el('div', { class: 'cma-header' },
      el('span', { class: 'cma-title' }, 'Multi-add'),
      nav,
      el('button', { type: 'button', class: 'cma-close', title: 'Close (Alt+Shift+M)', 'aria-label': 'Close', on: { click: () => close() } }, '×'));
    header.addEventListener('mousedown', onDragStart);
    els.notice = el('div', { class: 'cma-notice', hidden: true });
    els.body = el('div', { class: 'cma-body' });
    els.footer = el('div', { class: 'cma-footer' });
    return el('div', { class: 'cma-panel', role: 'dialog', 'aria-label': 'Multi-Add for Cronometer' }, header, els.notice, els.body, els.footer);
  }
  function onDragStart(ev) {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    const r = els.panel.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, w: r.width, h: r.height };
    const move = (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth - drag.w, e.clientX - drag.dx));
      const y = Math.max(0, Math.min(window.innerHeight - drag.h, e.clientY - drag.dy));
      els.panel.style.left = x + 'px'; els.panel.style.top = y + 'px';
      els.panel.style.right = 'auto'; els.panel.style.bottom = 'auto';
    };
    const up = () => { drag = null; window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', up, true); };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    ev.preventDefault();
  }
  function switchView(v) {
    if (!isView(v)) return;
    state.view = v;
    state.notice = null;
    renderView();
  }
  function renderNotice() {
    if (!els.notice) return;
    clear(els.notice);
    if (!state.notice) { els.notice.hidden = true; return; }
    els.notice.hidden = false;
    els.notice.className = 'cma-notice' + (state.notice.error ? ' cma-notice-error' : '');
    els.notice.appendChild(document.createTextNode(state.notice.text));
    els.notice.appendChild(btn('×', () => notify(null), { small: true, title: 'Dismiss', class: 'cma-notice-x' }));
  }
  function renderView() {
    if (!state.mounted) return;
    if (!isView(state.view)) state.view = 'input';
    syncTabs();
    clear(els.body); clear(els.footer);
    els.textarea = null;
    renderNotice();
    const prev = renderedView !== state.view ? customViews.get(renderedView) : null;
    renderedView = state.view;
    if (prev) callView(prev, 'onEvent', 'hidden', null);   // its DOM was just cleared: stop its live updates
    const cv = customViews.get(state.view);
    if (cv) { renderCustomView(cv); return; }
    switch (state.view) {
      case 'input': renderInput(); break;
      case 'preview': renderPreview(); break;
      case 'results': renderResults(); break;
      case 'diagnostics': renderDiagnostics(); break;
      case 'settings': renderSettings(); break;
      default: state.view = 'input'; renderInput();
    }
  }

  // ---------------------------------------------------------------------------
  // View registry. CMA.panel.registerView({id, label, order, render(ctx), onEvent(name, payload), diagnostics(),
  // unmount(), css}) → unregister(). A registered view (src/ui/tdee-view.js is the first) gets
  //   * a tab, sorted by `order` (built-ins 10 input … 50 settings; default 35 = just before Diagnostics);
  //   * its `css` as one extra <style> in the closed shadow root (next to CMA.panelCss);
  //   * render(ctx) with an empty ctx.body / ctx.footer each time the panel renders it (open, tab click, setState);
  //   * onEvent('state' | 'registry' | 'registry-progress', payload) while it is the open view — the same signals
  //     the built-in views follow — and onEvent('hidden') when its content is cleared (another view, close);
  //   * unmount() when the panel unmounts or the view is unregistered (drop listeners and timers there);
  //   * diagnostics() in the dump under views.<id>: the view decides what is safe to show (the dump is pasted
  //     into bug reports, so no health data).
  // ctx carries the panel's helpers (DOM, redaction, capture/readiness, decoder state, storage, formatting), so a
  // view never needs panel internals. Registering after mount rebuilds the tabs; a script that loads before
  // panel.js can queue its definition in CMA.panelViewQueue (drained once below, at load).
  // ---------------------------------------------------------------------------
  function isView(id) { return typeof id === 'string' && (BUILTIN_VIEWS.indexOf(id) >= 0 || customViews.has(id)); }
  function viewIds() {
    const all = BUILTIN_VIEWS.map((id, i) => ({ id, order: BUILTIN_ORDER[id], seq: i - BUILTIN_VIEWS.length }))
      .concat(Array.from(customViews.values(), v => ({ id: v.id, order: v.order, seq: v.seq })));
    all.sort((a, b) => a.order - b.order || a.seq - b.seq);
    return all.map(v => v.id);
  }
  function viewLabel(id) { const v = customViews.get(id); return v ? v.label : (VIEW_LABELS[id] || id); }
  function buildTabs() {
    if (!els.nav) return;
    clear(els.nav);
    els.tabs = {};
    for (const v of viewIds()) {
      els.tabs[v] = el('button', { type: 'button', class: 'cma-tab', role: 'tab', data: { view: v }, on: { click: () => switchView(v) } }, viewLabel(v));
      els.nav.appendChild(els.tabs[v]);
    }
    syncTabs();
  }
  function syncTabs() {
    if (!els.tabs) return;
    for (const v of Object.keys(els.tabs)) els.tabs[v].setAttribute('aria-selected', v === state.view ? 'true' : 'false');
    if (els.tabs.preview) els.tabs.preview.disabled = !state.plan && !state.building;
    if (els.tabs.results) els.tabs.results.disabled = !state.result && !state.running;
  }
  /** Call an optional method of a registered view; a throwing view never breaks the panel (it is logged). */
  function callView(v, method) {
    const fn = v && v.def ? v.def[method] : null;
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(v.def, Array.prototype.slice.call(arguments, 2)); }
    catch (e) { log('view ' + v.id + ' ' + method + ' failed: ' + errText(e)); return undefined; }
  }
  function injectViewCss(v) {
    if (!root || !v.css || (v.styleEl && v.styleEl.isConnected)) return;
    v.styleEl = el('style', { data: { view: v.id } });
    v.styleEl.textContent = v.css;
    root.insertBefore(v.styleEl, els.wrap && els.wrap.parentNode === root ? els.wrap : null);
  }
  function registerView(def) {
    if (!def || typeof def !== 'object') throw new TypeError('registerView: a view definition object is required');
    const id = def.id;
    if (typeof id !== 'string' || !VIEW_ID_RE.test(id)) throw new TypeError('registerView: id must be a short lower-case word, got ' + JSON.stringify(id));
    if (BUILTIN_VIEWS.indexOf(id) >= 0) throw new Error('registerView: "' + id + '" is a built-in view');
    if (typeof def.render !== 'function') throw new TypeError('registerView: render(ctx) is required for "' + id + '"');
    const prev = customViews.get(id);
    const keepSelected = !!prev && state.view === id;
    if (prev) removeView(prev, true);
    const v = {
      id, label: typeof def.label === 'string' && def.label ? def.label : id,
      order: typeof def.order === 'number' && isFinite(def.order) ? def.order : DEFAULT_VIEW_ORDER,
      seq: ++viewSeq, def, css: typeof def.css === 'string' ? def.css : '', styleEl: null
    };
    customViews.set(id, v);
    if (keepSelected) state.view = id;
    if (state.mounted) {
      injectViewCss(v);
      buildTabs();
      if (state.view === id) renderView();
    }
    log('view registered: ' + id);
    return function unregister() { if (customViews.get(id) === v) removeView(v, false); };
  }
  function removeView(v, replacing) {
    customViews.delete(v.id);
    callView(v, 'unmount');
    if (v.styleEl) { v.styleEl.remove(); v.styleEl = null; }
    const wasShown = renderedView === v.id;
    if (wasShown) renderedView = null;
    if (replacing) return;
    if (state.view === v.id) state.view = 'input';
    if (state.mounted) { buildTabs(); if (wasShown) renderView(); }
    log('view removed: ' + v.id);
  }
  /** The helpers a registered view renders with (see the block comment above). */
  function viewCtx(v) {
    return {
      id: v.id, body: els.body, footer: els.footer,
      el, btn, option, clear, append,
      notify, log: (msg) => log(v.id + ': ' + msg), redact, errText,
      capState, sessionFrom, readiness,
      registryMismatch: () => !!capState().registryMismatch, rebuildInProgress, waitForRebuild, registryStatus,
      todayDate, formatDate, formatAgo, isoDate, parseIsoDate,
      copyText, storageGet, storageSet,
      switchView, renderView,
      isActive: () => state.mounted && state.open && state.view === v.id && renderedView === v.id && customViews.get(v.id) === v
    };
  }
  function renderCustomView(v) {
    try { v.def.render(viewCtx(v)); }
    catch (e) {
      log('view ' + v.id + ' render failed: ' + errText(e));
      clear(els.body); clear(els.footer);
      els.body.appendChild(el('div', { class: 'cma-banner' }, 'This view could not be shown: ' + errText(e)));
    }
  }
  function forwardViewEvent(name, payload) {
    const v = customViews.get(state.view);
    if (v && renderedView === v.id) callView(v, 'onEvent', name, payload);
  }
  function viewDiagnostics() {
    const out = {};
    for (const v of customViews.values()) {
      if (typeof v.def.diagnostics !== 'function') { out[v.id] = null; continue; }
      try { const d = v.def.diagnostics(); out[v.id] = d === undefined ? null : d; }
      catch (e) { out[v.id] = { error: errText(e) }; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Input view
  // ---------------------------------------------------------------------------
  function renderInput() {
    els.banner = el('div', { class: 'cma-banner', hidden: true });
    els.body.appendChild(els.banner);
    els.textarea = el('textarea', {
      class: 'cma-input', placeholder: PLACEHOLDER, spellcheck: 'false', rows: '8', 'aria-label': 'Foods to add',
      on: { input: (e) => { state.input = e.target.value; saveInputSoon(); updateFindButton(); } }
    });
    els.textarea.value = state.input || '';
    els.body.appendChild(els.textarea);

    els.groupSel = el('select', { class: 'cma-group', on: { change: (e) => { state.defaultGroupId = Number(e.target.value); } } });
    els.dateText = el('span', { class: 'cma-date' });
    els.dateInput = el('input', { type: 'date', class: 'cma-date-input', title: 'Override the diary date', on: { change: (e) => { state.dateOverride = parseIsoDate(e.target.value); refreshInputMeta(); } } });
    els.engineSel = el('select', { class: 'cma-engine', on: { change: (e) => {
      // Find foods / the date override / the banner all depend on the engine: re-render right away (a capture
      // 'state' event may never come on an idle page) and again once the setting is saved.
      state.settings = normSettings(Object.assign({}, state.settings, { engine: e.target.value }));
      refreshInputMeta();
      saveSettings({ engine: e.target.value }).then(() => refreshInputMeta()).catch(() => {});
    } } }, option('rpc', 'RPC (fast)'), option('ui', 'UI automation (fallback)'));
    els.engineSel.value = state.settings.engine;
    els.body.appendChild(el('div', { class: 'cma-controls' },
      el('label', null, 'Group ', els.groupSel),
      el('label', null, 'Diary date: ', els.dateText, ' ', els.dateInput),
      el('label', null, 'Engine ', els.engineSel)));

    els.status = el('div', { class: 'cma-status' });
    els.body.appendChild(els.status);

    els.body.appendChild(el('details', { class: 'cma-help' },
      el('summary', null, 'Input format cheat-sheet'),
      el('ul', null,
        el('li', null, 'Quantity + unit anywhere: ', el('code', null, '200g chicken breast'), ', ', el('code', null, 'chicken breast, 200 g'), ', ', el('code', null, 'eggs x2'), ', ', el('code', null, '1 1/2 cups rice'), ', ', el('code', null, '½ cup oats')),
        el('li', null, 'Units: g kg mg oz lb ml l cup tbsp tsp slice piece serving large medium small scoop can bottle packet bar each … (unknown words stay in the name)'),
        el('li', null, 'No quantity = 1 of the default measure; a number without a unit uses the default measure'),
        el('li', null, el('code', null, '## Dinner'), ' switches the group for the lines below; ', el('code', null, '@lunch'), ' at the start or end of a line sets that line’s group'),
        el('li', null, el('code', null, '# Lunch'), ' / ', el('code', null, 'Lunch:'), ' also switch the group; longer ', el('code', null, '# …'), ' notes and ', el('code', null, '// …'), ' lines are ignored'),
        el('li', null, 'Two foods on one line: ', el('code', null, 'oats 40 g, milk 200 ml'), '; multipliers: ', el('code', null, '2 x 100g yoghurt'), ', ', el('code', null, 'protein bar 60g x2')))));

    els.findBtn = btn('Find foods', () => findFoods(), { primary: true, title: 'Search every line and build the preview' });
    els.footer.appendChild(els.findBtn);
    els.footer.appendChild(btn('Clear', () => { state.input = ''; if (els.textarea) els.textarea.value = ''; saveInput(); updateFindButton(); }));
    if (state.plan) els.footer.appendChild(btn('Preview →', () => switchView('preview')));
    els.footer.appendChild(el('span', { class: 'cma-spacer' }));
    if (state.storedBatch && Array.isArray(state.storedBatch.servingIds) && state.storedBatch.servingIds.length) {
      const b = state.storedBatch;
      els.undoStoredBtn = btn('Undo last batch (' + b.servingIds.length + ')', () => undo(b), { danger: true, title: 'Remove the ' + b.servingIds.length + ' entries added on ' + formatDate(b.date) });
      els.undoStoredBtn.hidden = !canOfferStoredBatch();     // refreshInputMeta re-evaluates it on capture state events
      els.footer.appendChild(els.undoStoredBtn);
    }
    els.footer.appendChild(el('span', { class: 'cma-muted cma-small' }, 'Alt+Shift+M (or Ctrl+Alt+M) toggles this panel'));
    refreshInputMeta();
  }
  function refreshInputMeta() {
    if (state.view !== 'input' || !els.banner) return;
    const r = readiness();
    const c = capState();
    const uiEngine = state.settings.engine === 'ui';
    clear(els.banner);
    if (r.ok) {
      els.banner.hidden = true;
    } else {
      els.banner.hidden = false;
      const notLoggedIn = c.lastError === 'session';
      const noApp = !c.gwt && !(c.rpcCount > 0) && !(c.restCount > 0) && !appElementPresent();
      if (noApp) {
        els.banner.appendChild(el('strong', null, 'No Cronometer app on this page. '));
        els.banner.appendChild(document.createTextNode('Open https://cronometer.com/#diary, log in, then reload that tab.'));
      } else {
        els.banner.appendChild(el('strong', null, notLoggedIn ? 'Not logged in. ' : 'Reload the Cronometer tab so the extension can see the app start. '));
        els.banner.appendChild(document.createTextNode(notLoggedIn
          ? 'Cronometer reported an expired session: log in again and reload the tab.'
          : 'The extension only learns the session from the app’s own start-up traffic.'));
      }
      if (r.missing.length) els.banner.appendChild(el('div', { class: 'cma-small' }, 'Missing: ' + r.missing.join(', ')));
      if (uiEngine && !noApp) els.banner.appendChild(el('div', { class: 'cma-small' }, 'UI automation engine: Find foods still works — rows are added by driving the Add Food dialog; grams are not previewed.'));
    }
    renderRegistryBanner(c);
    // Group select (enabled groups only; keep the current choice when it still exists).
    const gs = enabledGroups();
    const want = currentDefaultGroupId();
    clear(els.groupSel);
    for (const g of gs) els.groupSel.appendChild(option(g.id, g.name, g.id === want));
    els.groupSel.value = String(want);
    const src = capState().groupsSource;
    els.groupSel.title = src ? 'Groups from: ' + src : '';
    // Date. The UI engine can only add to the day the diary shows (engine-ui never navigates dates).
    if (uiEngine && state.dateOverride) state.dateOverride = null;
    const d = diaryDate();
    els.dateText.textContent = formatDate(d.date) + (d.source === 'override' ? ' (override)' : d.source === 'today' ? ' (today)' : '');
    if (!state.dateOverride) els.dateInput.value = isoDate(d.date);
    els.dateInput.disabled = uiEngine;
    els.dateInput.title = uiEngine ? 'UI automation adds to the day shown in the diary: navigate the diary to another day instead' : 'Override the diary date';
    if (els.engineSel) els.engineSel.value = state.settings.engine;
    if (els.undoStoredBtn) els.undoStoredBtn.hidden = !canOfferStoredBatch();
    updateFindButton();
  }
  // ---------------------------------------------------------------------------
  // Decoder (registry) banner, SPEC §3.5. capture compares the live X-GWT-Permutation with the ACTIVE
  // registry (CMA.registry, swapped per build by CMA.registryStore); while they differ the store rebuilds the
  // decoder from the live bundle. States: (a) mismatch + rebuild running → progress; (b) a runtime-built
  // decoder is active for the live build → green line; (c) mismatch and no rebuild running → the warning,
  // plus the error of the last attempt when one failed, or why the store skipped the automatic attempt
  // (status().lastRefusal) — the bare warning never appears without a reason when the store gave one.
  // ---------------------------------------------------------------------------
  function registryStatus() {
    try { if (CMA.registryStore && typeof CMA.registryStore.status === 'function') return CMA.registryStore.status(); } catch (e) { /* ignore */ }
    return null;
  }
  function registryInfo() {
    try { if (CMA.gwt && typeof CMA.gwt.registryInfo === 'function') return CMA.gwt.registryInfo(); } catch (e) { /* ignore */ }
    const r = CMA.registry;
    if (!r || !r.types) return null;
    return { permutation: r.permutation ? String(r.permutation).toUpperCase() : null, policyHash: r.policyHash || null, generatedAt: r.generatedAt || null, types: Object.keys(r.types).length, source: r.source === 'runtime' ? 'runtime' : 'bundled' };
  }
  /** One line for a 'registry-progress' payload: the store's message (or a phase label) plus any counters. */
  function progressText(p) {
    if (!p || typeof p !== 'object') return '';
    const labels = { fetch: 'downloading the live app bundle', build: 'analysing the bundle', validate: 'checking the known layouts', store: 'saving the decoder', done: 'done', error: 'failed' };
    const out = [redact(typeof p.message === 'string' && p.message ? p.message : (labels[p.phase] || p.phase || ''))];
    if (p.fragment != null) out.push('part ' + p.fragment + (p.fragments != null ? '/' + p.fragments : ''));
    else if (p.done != null && p.total != null) out.push((p.step ? p.step + ' ' : '') + p.done + '/' + p.total);
    else if (p.index != null && p.total != null) out.push((p.step ? p.step + ' ' : '') + p.index + '/' + p.total);
    else if (p.loaded != null && p.total != null) out.push(p.loaded + '/' + p.total);
    else if (p.step) out.push(String(p.step));
    if (p.percent != null && isFinite(p.percent)) out.push(Math.round(Number(p.percent)) + '%');
    if (p.bytes != null && isFinite(p.bytes) && p.phase === 'fetch') out.push(formatBytes(p.bytes));
    return out.filter(Boolean).join(' · ');
  }
  function renderRegistryBanner(c) {
    const st = registryStatus();
    const mismatch = !!c.registryMismatch;
    const rebuilding = !!(st && st.inProgress);
    const info = registryInfo();
    const runtimeActive = !!(c.permutation && ((info && info.source === 'runtime') || (st && st.active === 'runtime')));
    const show = mismatch || rebuilding || runtimeActive;
    if (!show) {
      if (els.registryBanner) { els.registryBanner.remove(); els.registryBanner = null; }
      return;
    }
    if (!els.registryBanner || !els.registryBanner.isConnected) {
      els.registryBanner = el('div', { class: 'cma-banner cma-registry' });
      els.banner.parentNode.insertBefore(els.registryBanner, els.banner.nextSibling);
    }
    const b = els.registryBanner;
    clear(b);
    b.className = 'cma-banner cma-registry';
    if (rebuilding) {
      b.classList.add('cma-registry-busy');
      // "deployed a new build" only when that is what started it: a manual rebuild while the decoder matches
      // (Diagnostics button) must not announce a deploy that did not happen
      if (mismatch) {
        b.appendChild(el('strong', null, 'Cronometer deployed a new build — '));
        b.appendChild(document.createTextNode('rebuilding the decoder from the live app (about 10 s)…'));
      } else {
        b.appendChild(el('strong', null, 'Rebuilding the decoder from the live app (about 10 s)…'));
      }
      b.appendChild(el('div', { class: 'cma-progress' }, progressText(st.progress) || 'starting…'));
    } else if (!mismatch && runtimeActive) {
      b.classList.add('cma-banner-ok');
      const types = info && info.types ? info.types : (st && st.activeTypes) || 0;
      b.appendChild(el('strong', null, 'Decoder rebuilt for build ' + c.permutation + ' (' + types + ' types)'));
      const lr = st && st.lastRebuild;
      if (lr && lr.ok && (!lr.permutation || lr.permutation === c.permutation)) b.appendChild(document.createTextNode(' — ' + formatSeconds(lr.ms) + (lr.persisted === false ? ', ' + NOT_SAVED_NOTE : '') + '. The RPC engine is back.'));
      else if (st && st.storedAt) b.appendChild(document.createTextNode(' — built ' + new Date(st.storedAt).toLocaleString() + '.'));
    } else {
      const reg = info && info.permutation ? info.permutation : '?';
      b.appendChild(el('strong', null, 'Cronometer deployed a new build. '));
      b.appendChild(document.createTextNode('Live ' + (c.permutation || '?') + ', registry built for ' + reg + ': RPC decoding may fail — use the UI automation engine or regenerate the registry (README, Maintenance).'));
      const lr = st && st.lastRebuild;
      // the last attempt of an EARLIER page load (persisted by the store) explains a refused automatic retry
      const la = st && st.lastAttempt && st.lastAttempt.ok === false && st.lastAttempt.permutation === c.permutation ? st.lastAttempt : null;
      // an automatic attempt the store refused on THIS page (a foreign module base, the rate limit, ...)
      const rf = st && st.lastRefusal && st.lastRefusal.permutation === c.permutation && st.lastRefusal.reason !== 'manual' ? st.lastRefusal : null;
      if (lr && !lr.ok && (!lr.permutation || lr.permutation === c.permutation)) {
        b.appendChild(el('div', { class: 'cma-small cma-registry-error' }, (lr.reason === 'manual' ? 'Decoder rebuild failed: ' : 'Automatic decoder rebuild failed: ') + redact(lr.error || 'unknown error') +
          (Array.isArray(lr.problems) && lr.problems.length ? ' (' + lr.problems.slice(0, 3).map(redact).join('; ') + ')' : '') +
          ' — use the UI automation engine, or retry with "Rebuild decoder" in Diagnostics.'));
      } else if (la) {
        b.appendChild(el('div', { class: 'cma-small cma-registry-error' }, 'The ' + (la.reason === 'manual' ? '' : 'automatic ') + 'decoder rebuild failed ' + formatAgo(la.at) + ': ' + redact(la.error || 'unknown error') +
          ' — it is not repeated automatically for 10 minutes; use the UI automation engine, or retry with "Rebuild decoder" in Diagnostics.'));
      } else if (st && !st.builderLoaded) {
        b.appendChild(el('div', { class: 'cma-small' }, 'The decoder cannot be rebuilt here (registry builder not loaded).'));
      } else if (rf) {
        b.appendChild(el('div', { class: 'cma-small cma-registry-error' }, 'The automatic decoder rebuild was skipped: ' + redact(rf.error || 'unknown reason') +
          ' — use the UI automation engine, or retry with "Rebuild decoder" in Diagnostics.'));
      } else if (st && !c.moduleBase) {
        b.appendChild(el('div', { class: 'cma-small' }, 'The decoder is rebuilt automatically once the app’s first request has been seen.'));
      }
    }
  }
  function updateFindButton() {
    if (!els.findBtn || state.view !== 'input') return;
    const r = readiness();
    const hasText = /\S/.test(state.input || '');
    // the UI engine needs no captured session (it drives the dialog by name); the RPC engine does
    els.findBtn.disabled = (state.settings.engine !== 'ui' && !r.ok) || !hasText || state.building;
    if (els.status && !state.building) els.status.textContent = state.buildStatus || '';
  }
  /** True while the RPC engine must not send anything: the decoder does not match the live build (SPEC 3.5). */
  function decoderGated() { return state.settings.engine !== 'ui' && !!capState().registryMismatch; }
  function rebuildInProgress() { const st = registryStatus(); return !!(st && st.inProgress); }
  /**
   * Wait (bounded) for the registry store's running rebuild. A plan built or a batch sent while the decoder is
   * being replaced would read every getFood / updateDiary reply wrong (rows silently fall back to the hit's
   * measure, the batch stops with 'decode' after the first add), so the RPC engine waits the few seconds instead.
   * Resolves true when a rebuild was waited for, false when none was running.
   */
  function waitForRebuild(timeoutMs) {
    if (!rebuildInProgress()) return Promise.resolve(false);
    const s = CMA.registryStore;
    let p = null;
    try { p = s && typeof s.inFlight === 'function' ? s.inFlight() : null; } catch (e) { p = null; }
    if (!p || typeof p.then !== 'function') {
      // a store without inFlight(): the final 'registry-progress' event (done / error) says when it is over
      p = new Promise(resolve => {
        const ev = CMA.events;
        if (!ev || typeof ev.on !== 'function') { resolve(); return; }
        let off = () => {};
        const fn = (x) => { if (x && (x.phase === 'done' || x.phase === 'error')) { off(); resolve(); } };
        const r = ev.on('registry-progress', fn);
        off = typeof r === 'function' ? r : () => { try { ev.off('registry-progress', fn); } catch (e) { /* ignore */ } };
      });
    }
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(true), timeoutMs || 60000);
      p.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(true); });
    });
  }
  /** The Add all button follows the decoder state while the preview is open (no full re-render: the user may be editing a row). */
  function updateAddButton() {
    if (state.view !== 'preview' || !els.addBtn || !state.plan) return;
    const gated = decoderGated();
    els.addBtn.disabled = summarize(state.plan).ready === 0 || state.busy || state.running || gated;
    els.addBtn.title = gated ? DECODER_GATE_TITLE : 'Add every ready row to the diary';
    if (els.gateNote) els.gateNote.hidden = !gated;
  }

  // ---------------------------------------------------------------------------
  // Find foods → CMA.plan.build
  // ---------------------------------------------------------------------------
  function parseItems(text) {
    if (!CMA.parse || typeof CMA.parse.lines !== 'function') throw new Error('CMA.parse is not loaded');
    return CMA.parse.lines(text || '');
  }
  async function findFoods() {
    if (state.building || state.running) return null;
    const engine = state.settings.engine === 'ui' ? 'ui' : 'rpc';
    const r = readiness();
    if (engine === 'rpc' && !r.ok) { notify('Not ready: ' + (r.missing.join(', ') || 'reload the tab'), true); return null; }
    // UI engine without a session: degraded plan (SPEC §7) — the dialog is driven by the typed lines
    const degraded = engine === 'ui' && !r.ok;
    let items;
    try { items = parseItems(state.input); } catch (e) { notify('Could not parse the input: ' + errText(e), true); return null; }
    if (!items.length) { notify('Nothing to add: type one food per line.', true); return null; }
    if (!CMA.plan || typeof CMA.plan.build !== 'function') { notify('CMA.plan is not loaded', true); return null; }
    await saveInput();
    state.building = true; state.cancel = false; state.plan = null; state.result = null; state.undoResult = null; state.rowProgress = new Map();
    state.notice = null;
    state.degraded = degraded;
    if (engine === 'rpc' && rebuildInProgress()) {
      // SPEC 3.5: a plan built with the decoder that is being replaced would read every getFood reply wrong
      state.buildStatus = 'Waiting for the decoder rebuild to finish…';
      log('find foods: waiting for the running decoder rebuild');
      switchView('preview');
      await waitForRebuild(60000);
    }
    state.buildStatus = 'Searching 0/' + items.length + '…';
    log('find foods: ' + items.length + ' line(s), engine ' + engine + (degraded ? ' (no RPC session: unverified rows)' : ''));
    switchView('preview');
    const dd = diaryDate();
    try {
      const plan = await CMA.plan.build(sessionFrom(), items, {
        groups: groups(), defaultGroupId: currentDefaultGroupId(), date: dd.date, isCancelled: () => state.cancel,
        unverified: engine === 'ui', positions: !degraded, sessionProvider: sessionFrom
      }, (p) => onBuildProgress(p, items.length));
      state.plan = plan;
      if (plan && plan.stopped === 'session') notify('Session expired while searching: reload the Cronometer tab and log in again.', true);
      else if (plan && Array.isArray(plan.warnings)) plan.warnings.forEach(w => log('plan warning: ' + w));
      if (engine === 'rpc' && decoderGated()) notify('The decoder does not match the live Cronometer build: measures could only be taken from the search hits, and Add all stays disabled for the RPC engine until the decoder is rebuilt (Input view / Diagnostics) — or switch to the UI automation engine.', true);
      const s = summarize(plan);
      state.buildStatus = s.total + ' row(s): ' + s.ready + ' ready, ' + s.choice + ' need a choice, ' + s.error + ' error(s)';
      log('plan built: ' + state.buildStatus);
    } catch (e) {
      state.buildStatus = '';
      notify('Search failed: ' + errText(e), true);
      if (e && e.kind === 'session') state.buildStatus = 'session expired';
    } finally {
      state.building = false;
      renderView();
    }
    return state.plan;
  }
  function onBuildProgress(p, total) {
    if (!p) return;
    const idx = (p.index != null ? p.index + 1 : 0);
    const name = p.row && p.row.item ? p.row.item.name : '';
    if (p.phase === 'search') state.buildStatus = 'Searching ' + idx + '/' + (p.total || total) + ': ' + (name || '') + (p.message ? ' (' + p.message + ')' : '');
    else if (p.phase === 'food') state.buildStatus = 'Loading food ' + idx + '/' + (p.total || total) + ': ' + (name || '') + (p.message ? ' (' + p.message + ')' : '');
    else if (p.phase === 'positions') state.buildStatus = 'Reading the diary for positions…';
    else if (p.phase === 'done') state.buildStatus = 'Done';
    if (p.message && /retry/i.test(p.message)) log('build: ' + p.message + ' (' + name + ')');
    if (state.view === 'preview' && els.status) els.status.textContent = redact(state.buildStatus);
  }
  function summarize(plan) {
    const rows = plan && Array.isArray(plan.rows) ? plan.rows : [];
    const s = { total: rows.length, ready: 0, choice: 0, error: 0 };
    for (const r of rows) { if (r.status === 'ready') s.ready++; else if (r.status === 'needs-choice') s.choice++; else s.error++; }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Preview view
  // ---------------------------------------------------------------------------
  function rowFoodName(row) {
    if (row.hit && row.hit.name) return String(row.hit.name);
    // Food.f (SPEC 3.3 index 4) is not a display name: the app shows the locale Translation's name (Rjj)
    if (row.food && CMA.plan && typeof CMA.plan.foodDisplayName === 'function') { try { const n = CMA.plan.foodDisplayName(row.food); if (n) return String(n); } catch (e) { /* ignore */ } }
    return row.item && row.item.name ? String(row.item.name) : '';
  }
  function rowQty(row) {
    if (row.pick && row.pick.quantity != null && !row.pick.error) return Number(row.pick.quantity);
    if (row.item && row.item.qty != null) return Number(row.item.qty);
    return 1;
  }
  /** Recipe-type measures and the weightless 'full recipe': their wire amount is a COUNT (SPEC §5.3, `Rqj`). */
  function isRecipeLike(m) {
    if (!m) return false;
    if (CMA.units && typeof CMA.units.isRecipeLike === 'function') { try { return !!CMA.units.isRecipeLike(m); } catch (e) { /* fall through */ } }
    const t = m.type == null ? null : (typeof m.type === 'object' && typeof m.type.ordinal === 'number' ? ['Weight', 'Volume', 'Atomic', 'Recipe'][m.type.ordinal] : String(m.type));
    if (t === 'Recipe' || t === '3') return true;
    return String(m.name || '').trim().toLowerCase() === 'full recipe' && !(Number(m.grams) > 0);
  }
  /** The Grams cell: for a recipe-like measure pick.grams is the count, so show quantity × the measure's grams (or nothing). */
  function rowGramsText(row) {
    const p = row.pick;
    if (!p || p.error || !p.measure) return '';
    if (isRecipeLike(p.measure)) return Number(p.measure.grams) > 0 ? formatGrams(Number(p.quantity) * Number(p.measure.grams)) : '—';
    return p.grams != null ? formatGrams(p.grams) : '';
  }
  function renderPreview() {
    els.status = el('div', { class: 'cma-status' }, redact(state.buildStatus || ''));
    els.body.appendChild(els.status);
    if (state.building) {
      els.body.appendChild(el('div', { class: 'cma-muted' }, 'Searching Cronometer for each line…'));
      els.footer.appendChild(btn('Cancel', () => { state.cancel = true; }));
      return;
    }
    const plan = state.plan;
    if (!plan) { els.body.appendChild(el('div', { class: 'cma-muted' }, 'Nothing previewed yet.')); els.footer.appendChild(btn('← Back', () => switchView('input'))); return; }
    const shown = diaryDate();
    const planDate = plan.date || shown.date;
    const gs = enabledGroups();
    if (state.degraded) els.body.appendChild(el('div', { class: 'cma-banner' }, 'RPC session not available: rows will be added by driving the Add Food dialog; grams are not previewed.'));
    const table = el('table', { class: 'cma-table cma-preview' },
      el('thead', null, el('tr', null,
        el('th', { title: 'Input line' }, '#'), el('th', null, 'Food'), el('th', null, 'Qty'), el('th', null, 'Unit'),
        el('th', { class: 'cma-c-grams' }, 'Grams'), el('th', null, 'Group'), el('th', null, 'Status'), el('th', null, ''))));
    const tbody = el('tbody');
    plan.rows.forEach((row, i) => tbody.appendChild(renderPreviewRow(row, i, gs)));
    table.appendChild(tbody);
    els.body.appendChild(table);
    // The plan is frozen at Find-foods time: show ITS date, and say so when the diary has moved since.
    els.body.appendChild(el('div', { class: 'cma-muted cma-small cma-plan-date', style: 'margin-top:6px' },
      'Diary date ' + formatDate(planDate) + (sameDate(planDate, shown.date) ? '' : ' — differs from the day shown in the diary (' + formatDate(shown.date) + ')') +
      ' · engine ' + (state.settings.engine === 'ui' ? 'UI automation' : 'RPC') +
      (plan.positionsSource === 'fallback' ? ' · positions: fallback (diary could not be read)' : '')));
    const s = summarize(plan);
    const gated = decoderGated();
    els.addBtn = btn('Add all (' + s.ready + ')', () => addAll(), { primary: true, disabled: s.ready === 0 || state.busy || state.running || gated, title: gated ? DECODER_GATE_TITLE : 'Add every ready row to the diary' });
    els.footer.appendChild(els.addBtn);
    els.footer.appendChild(btn('← Back', () => switchView('input')));
    els.footer.appendChild(el('span', { class: 'cma-spacer' }));
    els.gateNote = el('span', { class: 'cma-muted cma-small cma-decoder-gate', hidden: !gated }, 'RPC engine paused: the decoder does not match the live Cronometer build');
    els.footer.appendChild(els.gateNote);
    els.footer.appendChild(el('span', { class: 'cma-muted cma-small' }, s.choice ? s.choice + ' row(s) need a unit choice' : ''));
  }
  function renderPreviewRow(row, i, gs) {
    const item = row.item || {};
    const tr = el('tr', { class: 'cma-row cma-status-' + (row.status || 'error'), data: { index: String(i) } });
    tr.appendChild(el('td', { class: 'cma-c-line', title: item.raw || '' }, String(item.line != null ? item.line : i + 1)));
    // Food: a select over the search hits (SPEC §8) — names come from the server, hence textContent only.
    const foodTd = el('td', { class: 'cma-c-food' });
    if (Array.isArray(row.hits) && row.hits.length) {
      const sel = el('select', { class: 'cma-hit', title: item.raw || '', on: { change: (e) => onHitChange(row, Number(e.target.value)) } });
      row.hits.forEach((h, k) => sel.appendChild(option(k, String(h.name || ('#' + h.id)), k === row.hitIndex)));
      sel.value = String(row.hitIndex >= 0 ? row.hitIndex : 0);
      foodTd.appendChild(sel);
    } else {
      foodTd.appendChild(el('span', { class: 'cma-muted', title: item.raw || '' }, rowFoodName(row) || item.raw || ''));
    }
    tr.appendChild(foodTd);
    const hasMeasures = Array.isArray(row.measures) && row.measures.length > 0;
    const chosenMeasure = row.pick && !row.pick.error ? row.pick.measure : null;
    const countMeasure = !!chosenMeasure && isRecipeLike(chosenMeasure);
    tr.appendChild(el('td', { class: countMeasure ? 'cma-c-count' : null }, el('input', {
      type: 'number', class: 'cma-qty', step: 'any', min: '0', value: formatQty(rowQty(row)), disabled: !hasMeasures, 'aria-label': 'Quantity',
      title: countMeasure ? 'number of "' + chosenMeasure.name + '" (a recipe measure counts servings, not grams)' : null,
      on: { change: (e) => onQtyChange(row, e.target.value) }
    }), countMeasure ? el('span', { class: 'cma-muted cma-small', title: 'count of ' + chosenMeasure.name }, ' ×') : null));
    const unitTd = el('td');
    if (hasMeasures) {
      // A failed pick may carry a SUGGESTION (units.pickVolume/pickMass: {error, measure}); it is not a choice yet.
      // Preselecting it would leave the row on '?' with nothing to change (choosing the already selected option
      // fires no change event), so the placeholder stays selected and names the suggestion.
      const needsChoice = !!(row.pick && row.pick.error) || row.status === 'needs-choice';
      const cur = !needsChoice && row.pick && row.pick.measure ? row.pick.measure.id : null;
      const suggested = needsChoice && row.pick && row.pick.measure ? row.pick.measure : null;
      const sel = el('select', { class: 'cma-measure', 'aria-label': 'Measure', on: { change: (e) => onMeasureChange(row, e.target.value) } });
      if (cur == null) sel.appendChild(option('', 'choose…' + (suggested ? ' (suggested: ' + suggested.name + ')' : ''), true));
      row.measures.forEach(m => sel.appendChild(option(m.id, String(m.name) + (m.grams ? ' (' + formatGrams(m.grams) + ')' : '') + (m.hidden ? ' (hidden)' : ''), cur != null && Number(m.id) === Number(cur))));
      sel.value = cur == null ? '' : String(cur);
      unitTd.appendChild(sel);
      if (suggested && suggested.id != null) {
        unitTd.appendChild(btn('Use ' + suggested.name, () => onMeasureChange(row, suggested.id), { small: true, title: 'Use the suggested measure', class: 'cma-use-suggested' }));
      }
    } else {
      unitTd.appendChild(el('span', { class: 'cma-muted' }, item.unit || ''));
    }
    tr.appendChild(unitTd);
    tr.appendChild(el('td', { class: 'cma-c-grams' }, rowGramsText(row)));
    const groupTd = el('td');
    if (row.status !== 'error' || row.groupId != null) {
      const sel = el('select', { class: 'cma-rowgroup', 'aria-label': 'Group', on: { change: (e) => onGroupChange(row, Number(e.target.value)) } });
      gs.forEach(g => sel.appendChild(option(g.id, g.name, g.id === Number(row.groupId))));
      if (!gs.some(g => g.id === Number(row.groupId)) && row.groupId != null) sel.appendChild(option(row.groupId, groupName(row.groupId), true));
      sel.value = String(row.groupId != null ? row.groupId : (gs[0] ? gs[0].id : 0));
      groupTd.appendChild(sel);
    }
    tr.appendChild(groupTd);
    const icon = row.status === 'ready' ? '✓' : row.status === 'needs-choice' ? '?' : '✗';
    tr.appendChild(el('td', { class: 'cma-c-status', title: redact(row.message || '') }, el('span', { class: 'cma-icon' }, icon), redact(row.message || (row.status === 'ready' ? 'ready' : ''))));
    tr.appendChild(el('td', { class: 'cma-c-x' }, btn('×', () => removeRow(row), { small: true, title: 'Remove this line from the batch' })));
    return tr;
  }
  async function onHitChange(row, idx) {
    if (!CMA.plan || typeof CMA.plan.rechoose !== 'function') return;
    state.busy = true; renderView();
    try {
      await CMA.plan.rechoose(sessionFrom(), row, idx);
      log('rechoose line ' + (row.item && row.item.line) + ' -> ' + rowFoodName(row));
    } catch (e) {
      notify((e && e.kind === 'session' ? 'Session expired: reload the Cronometer tab. ' : 'Could not load that food: ') + errText(e), true);
    } finally { state.busy = false; renderView(); }
  }
  function onQtyChange(row, value) {
    const q = Number(String(value).replace(',', '.'));
    if (!(q > 0) || !isFinite(q)) { notify('Quantity must be a positive number', true); renderView(); return; }
    // An unresolved ('?') row's pick.measure is only a SUGGESTION (units.pickDefault / pickVolume / pickMass):
    // repicking with it would silently accept it ('30 whey isolate' corrected to 35 meaning grams would become
    // 35 scoops). Store the number only; the Use button / Unit dropdown resolves the row with it later (and
    // onMeasureChange's convertQuantity / reset-to-1 guard still applies to a typed unit).
    const unresolved = !!(row.pick && row.pick.error) || row.status === 'needs-choice';
    const measureId = !unresolved && row.pick && row.pick.measure ? row.pick.measure.id : null;
    if (measureId != null && CMA.plan && typeof CMA.plan.repick === 'function') CMA.plan.repick(row, measureId, q);
    else if (row.item) row.item.qty = q;
    else row.item = { qty: q };
    renderView();
  }
  function onMeasureChange(row, value) {
    if (value === '' || value == null) return;
    if (!CMA.plan || typeof CMA.plan.repick !== 'function') return;
    const measure = Array.isArray(row.measures) ? row.measures.find(m => Number(m.id) === Number(value)) : null;
    let qty = rowQty(row);
    let note = null;
    // Resolving a needs-choice row: the typed quantity is in the TYPED unit ('150 g my smoothie'), not in the
    // measure being picked. Convert it when that is safe; a mass/volume amount must never become the COUNT of a
    // recipe measure (150 g would be 150 full recipes, SPEC §5.3), so the count is reset to 1 and the row says so.
    if (row.pick && row.pick.error && measure && row.item && row.item.unit) {
      const conv = CMA.units && typeof CMA.units.convertQuantity === 'function' ? CMA.units.convertQuantity(qty, row.item.unit, measure) : null;
      if (conv && conv.quantity > 0) { qty = conv.quantity; note = conv.note; }
      else { note = 'quantity reset to 1: ' + formatQty(qty) + ' ' + row.item.unit + ' cannot be converted to ' + measure.name; qty = 1; }
    }
    try { CMA.plan.repick(row, Number(value), qty); } catch (e) { notify(errText(e), true); }
    if (note && row.status === 'ready') row.message = (row.message ? row.message + '; ' : '') + note;
    renderView();
  }
  function onGroupChange(row, gid) {
    if (state.plan && CMA.plan && typeof CMA.plan.reposition === 'function') CMA.plan.reposition(state.plan, row, gid);
    else { row.groupId = gid; row.groupName = groupName(gid); }
    renderView();
  }
  function removeRow(row) {
    if (!state.plan) return;
    const i = state.plan.rows.indexOf(row);
    if (i >= 0) state.plan.rows.splice(i, 1);
    renderView();
  }

  // ---------------------------------------------------------------------------
  // Add all → engine run
  // ---------------------------------------------------------------------------
  function normalizeResult(r, engine) {
    const out = {
      engine, added: [], failed: [], skipped: [], stopped: (r && r.stopped) || null,
      cancelled: !!(r && r.cancelled), abortReason: (r && r.abortReason) || null,
      lastBatch: (r && r.lastBatch) || null, refresh: (r && r.refresh) || null, error: null
    };
    if (r) {
      // added rows may carry a message (RPC engine: reply undecodable, no undo id) or warnings (UI engine:
      // group kept, measure converted, meal defaults…) — both are shown next to the tick, never dropped
      (r.added || []).forEach(a => out.added.push({
        row: a.row, servingId: a.servingId != null ? String(a.servingId) : null,
        message: a.message ? redact(a.message) : null,
        warnings: Array.isArray(a.warnings) ? a.warnings.map(w => redact(w)) : []
      }));
      (r.failed || []).forEach(f => out.failed.push({ row: f.row, error: errText(f.error), kind: f.kind || (f.error && f.error.kind) || null }));
      (r.skipped || []).forEach(s => out.skipped.push({ row: s.row, reason: redact(s.reason || '') }));
    }
    return out;
  }
  /** The result-line text for an added row: 'added' plus its id, message and warnings. */
  function addedText(a) {
    let t = 'added' + (a.servingId ? ' (id ' + a.servingId + ')' : '');
    if (a.message) t += ' — ' + a.message;
    if (a.warnings && a.warnings.length) t += ' (' + a.warnings.join('; ') + ')';
    return t;
  }
  async function addAll() {
    const plan = state.plan;
    if (!plan || state.running || state.building) return null;
    const ready = plan.rows.filter(r => r.status === 'ready');
    if (!ready.length) { notify('No ready rows to add', true); return null; }
    const engine = state.settings.engine === 'ui' ? 'ui' : 'rpc';
    if (engine === 'rpc') {
      const r = readiness();
      if (!r.ok) { notify('Not ready: ' + r.missing.join(', '), true); return null; }
      if (ready.some(x => x.unverified)) { notify('Some rows are unverified (built for the UI engine): press Find foods again with the RPC engine selected.', true); return null; }
      if (rebuildInProgress()) {
        // SPEC 3.5: an updateDiary sent while the decoder is being replaced would come back unreadable
        // ('added; the reply could not be read — no undo id', batch stopped): wait the few seconds instead
        state.busy = true;
        notify('Waiting for the decoder rebuild to finish before adding…', false);
        renderView();
        try { await waitForRebuild(60000); } finally { state.busy = false; }
        if (state.running || !state.plan) return null;
      }
      if (decoderGated()) {
        notify('Nothing was sent: the decoder does not match the live Cronometer build. Wait for the rebuild (Input view), press "Rebuild decoder" in Diagnostics, or switch to the UI automation engine.', true);
        renderView();
        return null;
      }
    } else {
      // engine-ui never navigates the diary: it adds to the day the diary shows (SPEC §7 step 1 only sets #diary)
      const shown = capState().diaryDate;
      if (shown && shown.year && plan.date && !sameDate(shown, plan.date)) {
        notify('UI automation adds to the day shown in the diary (' + formatDate(shown) + '): navigate the diary to ' + formatDate(plan.date) + ' first, or use the RPC engine.', true);
        return null;
      }
    }
    state.running = true; state.cancel = false; state.result = null; state.undoResult = null; state.rowProgress = new Map();
    state.runStatus = 'Adding 0/' + ready.length + '…';
    state.notice = null;
    log('add all: ' + ready.length + ' row(s) via ' + engine);
    switchView('results');
    const session = sessionFrom();
    let result = null;
    try {
      if (engine === 'ui') {
        if (!CMA.engineUi || typeof CMA.engineUi.run !== 'function') throw new Error('CMA.engineUi is not loaded');
        // The engine waits for the diary to refresh after every add through this hook-based signal
        // (SPEC §7 step 7); without the hook it falls back to its fixed refreshMs delay.
        const refresh = uiRefreshSignal();
        try {
          result = normalizeResult(await CMA.engineUi.run(plan, {
            groups: plan.groups || groups(),
            delayMs: state.settings.delayMs,
            waitForRefresh: (row) => refresh.waitForRefresh(row)
          }, onUiProgress), 'ui');
        } finally { refresh.dispose(); }
      } else {
        if (!CMA.engineRpc || typeof CMA.engineRpc.run !== 'function') throw new Error('CMA.engineRpc is not loaded');
        // Positions are computed at build time; refresh them right before sending so entries added by hand
        // between Preview and Add all do not collide (plan.js note on positions).
        if (CMA.plan && typeof CMA.plan.assignPositions === 'function') {
          try { await CMA.plan.assignPositions(sessionFrom(), plan); } catch (e) { log('assignPositions before run failed: ' + errText(e)); }
        }
        // sessionProvider: a nonce rotated by the app's reauthenticate during a long batch is used from the next row on
        result = normalizeResult(await CMA.engineRpc.run(session, plan, { delayMs: state.settings.delayMs, isCancelled: () => state.cancel, sessionProvider: sessionFrom }, onRpcProgress), 'rpc');
      }
      state.result = result;
      state.storedBatch = null;
      const n = result.added.length;
      const shownNow = capState().diaryDate;
      const otherDay = !!(plan.date && shownNow && shownNow.year && !sameDate(shownNow, plan.date));
      state.runStatus = n + ' added, ' + result.failed.length + ' failed' + (result.skipped.length ? ', ' + result.skipped.length + ' skipped' : '') +
        (result.stopped === 'session' ? ' — stopped: session expired' : result.stopped === 'cancelled' || result.cancelled ? ' — cancelled' : result.stopped === 'decode' ? ' — stopped: reply unreadable' : '') +
        (result.abortReason ? ' — aborted: ' + result.abortReason : '') +
        (plan.date ? ' — diary date ' + formatDate(plan.date) + (otherDay ? ' (not the day shown in the diary)' : '') : '');
      if (n && otherDay) notify(n + ' entries were added to ' + formatDate(plan.date) + ', not to the day shown in the diary.', false);
      if (result.stopped === 'decode') {
        notify('The server accepted the entry but the extension could not read the reply (the serializer registry is stale): check the diary before re-adding anything; rebuild the decoder from Diagnostics or use the UI automation engine.', true);
      }
      // A refresh that the hook did not confirm with a getDayInfo (hidden nav, non-diary hash, no hook) leaves the
      // diary on screen unchanged even though the entries are on the server: say so, or the user re-adds them.
      if (n && result.refresh && !result.refresh.verified) state.runStatus += ' — the diary did not confirm the refresh: press Reload page to see the new entries';
      log('run done: ' + state.runStatus);
    } catch (e) {
      state.result = normalizeResult(null, engine);
      state.result.error = errText(e);
      state.runStatus = 'Failed: ' + errText(e);
      notify(state.runStatus, true);
    } finally {
      state.running = false;
      renderView();
    }
    return state.result;
  }
  function onRpcProgress(p) {
    if (!p) return;
    const idx = p.index != null ? p.index + 1 : 0;
    const name = p.row ? rowFoodName(p.row) : '';
    if (p.phase === 'row' && p.row) {
      state.rowProgress.set(p.row, { ok: !!p.ok, message: p.ok ? 'added' + (p.message ? ' — ' + redact(p.message) : '') : redact(p.message || 'failed') });
      state.runStatus = 'Adding ' + idx + '/' + (p.total || '?') + ': ' + name;
    } else if (p.phase === 'adding') state.runStatus = 'Adding ' + idx + '/' + (p.total || '?') + ': ' + name;
    else if (p.phase === 'retry') { state.runStatus = 'Retrying ' + name + '…'; log('retry: ' + name + ' ' + (p.message || '')); }
    else if (p.phase === 'throttled') { state.runStatus = 'Throttled by the server, waiting…'; log('throttled: ' + (p.message || '')); }
    else if (p.phase === 'refresh') state.runStatus = 'Refreshing the diary…';
    else if (p.phase === 'done') state.runStatus = 'Done';
    if (state.view === 'results') updateRunStatus();
  }
  function onUiProgress(p) {
    if (!p) return;
    const name = p.row ? rowFoodName(p.row) : '';
    const msg = String(p.message || '');
    if (p.level === 'warn' || p.level === 'error') log('ui[' + p.step + '] ' + name + ': ' + msg);
    // engine-ui reports a row's outcome as step 'row' with 'added' / 'added (fallbacks…)' / 'failed: …' /
    // 'skipped: …' (its 'add' step only means "clicking Add to Diary", before the outcome is known). The
    // fallback text travels into the row status so a kept group / converted measure is never a plain tick.
    if (p.step === 'row' && p.row) {
      if (/^added\b/.test(msg)) state.rowProgress.set(p.row, { ok: true, message: redact(msg) });
      else if (/^(failed|skipped)\b/.test(msg) || p.level === 'error') state.rowProgress.set(p.row, { ok: false, message: redact(msg) });
    }
    state.runStatus = 'Row ' + (p.index != null ? p.index + 1 : '?') + ' ' + (p.step || '') + ': ' + redact(msg);
    if (state.view === 'results') updateRunStatus();
  }

  // ---------------------------------------------------------------------------
  // Diary-refresh signal for the UI engine (SPEC §7 step 7). After "Add to Diary" the dialog hides ~100 ms
  // later while the app's own updateDiary RPC is still in flight, and the app then updates the diary from
  // that response (research/ui-automation-dialog-recipe.md §8, live-app-report.md §7). The MAIN-world hook
  // relays the app's XHRs, so capture emits an 'rpc' event {method:'updateDiary', ok:true} exactly when the
  // add has landed. Each waitForRefresh(row) call consumes one such event seen since the signal was created
  // (the response may already have arrived while the engine waited for the dialog to detach) and then
  // settles briefly. capture decodes the //OK payload: an ErrorEntryChangeResult inside it means the server
  // rejected the add, and the promise rejects with `.rejected` so engine-ui fails the row. Without the hook it
  // rejects with `.noHook` (engine-ui then sleeps its fixed refreshMs); after `timeoutMs` without a response it
  // rejects plainly (engine-ui then inspects the diary and fails the row unless the entry is visible).
  // ---------------------------------------------------------------------------
  function uiRefreshSignal(opts) {
    const o = Object.assign({ timeoutMs: 5000, settleMs: 300, hooked: !!capState().hooked }, opts || {});
    let seen = 0, consumed = 0, listening = false;
    const waiters = [];
    const events = [];
    const onRpc = (ev) => {
      if (!ev || ev.method !== 'updateDiary' || !ev.ok) return;
      events.push(ev.rejected ? { rejected: true, message: ev.rejectMessage || 'entry rejected by the server' } : { rejected: false });
      seen++;
      waiters.splice(0).forEach(fn => { try { fn(); } catch (e) { /* never break the event loop */ } });
    };
    try {
      if (CMA.events && typeof CMA.events.on === 'function' && typeof CMA.events.off === 'function') { CMA.events.on('rpc', onRpc); listening = true; }
    } catch (e) { listening = false; }
    const settle = () => new Promise(resolve => setTimeout(resolve, o.settleMs));
    return {
      get seen() { return seen; },
      waitForRefresh() {
        if (!listening || !o.hooked) { const e = new Error('hook not available; using the fixed delay'); e.noHook = true; return Promise.reject(e); }
        // consume the next updateDiary outcome; a rejected one throws with .rejected
        const take = () => {
          const ev = events[consumed++];
          if (ev && ev.rejected) { const e = new Error('rejected: ' + ev.message); e.rejected = true; throw e; }
        };
        if (seen > consumed) { try { take(); } catch (e) { return Promise.reject(e); } return settle(); }
        return new Promise((resolve, reject) => {
          let timer = null;
          const check = () => {
            if (seen <= consumed) { waiters.push(check); return; }
            clearTimeout(timer);
            try { take(); } catch (e) { reject(e); return; }
            settle().then(resolve);
          };
          timer = setTimeout(() => {
            const i = waiters.indexOf(check);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error('no updateDiary response seen within ' + o.timeoutMs + ' ms'));
          }, o.timeoutMs);
          waiters.push(check);
        });
      },
      dispose() {
        if (!listening) return;
        listening = false;
        try { CMA.events.off('rpc', onRpc); } catch (e) { /* ignore */ }
      }
    };
  }
  function updateRunStatus() {
    if (els.status) els.status.textContent = redact(state.runStatus || '');
    if (!els.resultList || !state.plan) return;
    state.rowProgress.forEach((pr, row) => {
      const li = els.resultList.querySelector('li[data-row="' + state.plan.rows.indexOf(row) + '"]');
      if (!li) return;
      li.className = pr.ok ? 'cma-r-ok' : 'cma-r-fail';
      li.querySelector('.cma-icon').textContent = pr.ok ? '✓' : '✗';
      li.querySelector('.cma-r-msg').textContent = pr.message;
    });
  }

  // ---------------------------------------------------------------------------
  // Results view
  // ---------------------------------------------------------------------------
  function resultFor(row) {
    const res = state.result;
    if (res) {
      const a = res.added.find(x => x.row === row); if (a) return { cls: 'cma-r-ok' + (a.message || (a.warnings && a.warnings.length) ? ' cma-r-warn' : ''), icon: '✓', msg: addedText(a) };
      const f = res.failed.find(x => x.row === row); if (f) return { cls: 'cma-r-fail', icon: '✗', msg: f.error || 'failed' };
      const s = res.skipped.find(x => x.row === row); if (s) return { cls: 'cma-r-skip', icon: '–', msg: 'skipped: ' + (s.reason || row.message || '') };
      if (row.status !== 'ready') return { cls: 'cma-r-skip', icon: '–', msg: 'skipped: ' + redact(row.message || row.status) };
      return { cls: 'cma-r-skip', icon: '–', msg: res.stopped ? 'not sent (' + res.stopped + ')' : 'not sent' };
    }
    const pr = state.rowProgress.get(row);
    if (pr) return { cls: pr.ok ? 'cma-r-ok' : 'cma-r-fail', icon: pr.ok ? '✓' : '✗', msg: pr.message };
    if (row.status !== 'ready') return { cls: 'cma-r-skip', icon: '–', msg: 'skipped: ' + redact(row.message || row.status) };
    return { cls: 'cma-r-pending', icon: '…', msg: 'waiting' };
  }
  /** The batch the Results view can undo: only the shown result's own (an older batch in CMA.engineRpc.lastBatch
   *  belongs to the Input view's "Undo last batch" button, never to a result that added nothing undoable). */
  function batchForUndo() {
    if (state.result && state.result.lastBatch && Array.isArray(state.result.lastBatch.servingIds) && state.result.lastBatch.servingIds.length) return state.result.lastBatch;
    return null;
  }
  function renderResults() {
    els.status = el('div', { class: 'cma-status' }, redact(state.runStatus || ''));
    els.body.appendChild(els.status);
    const plan = state.plan;
    if (!plan) { els.body.appendChild(el('div', { class: 'cma-muted' }, 'No batch yet.')); els.footer.appendChild(btn('Done', () => switchView('input'))); return; }
    els.resultList = el('ul', { class: 'cma-results' });
    plan.rows.forEach((row, i) => {
      const r = resultFor(row);
      els.resultList.appendChild(el('li', { class: r.cls, data: { row: String(i) } },
        el('span', { class: 'cma-icon' }, r.icon),
        el('span', { class: 'cma-r-name' }, formatQty(rowQty(row)) + ' ' + (row.pick && row.pick.measure ? row.pick.measure.name + ' ' : '') + rowFoodName(row) + (row.groupId != null ? ' → ' + groupName(row.groupId) : '')),
        el('span', { class: 'cma-r-msg' }, r.msg)));
    });
    els.body.appendChild(els.resultList);
    if (state.undoResult) {
      const u = state.undoResult;
      els.body.appendChild(el('div', { class: 'cma-notice', style: 'margin-top:8px' },
        'Undo: ' + u.removed.length + ' removed' + (u.failed.length ? ', ' + u.failed.length + ' failed (' + u.failed.map(f => errText(f.error)).join('; ') + ')' : '') + (u.stopped ? ' — stopped: ' + u.stopped : '')));
    }
    if (state.running) {
      if (state.settings.engine !== 'ui') els.footer.appendChild(btn('Cancel', () => { state.cancel = true; state.runStatus = 'Cancelling after the current row…'; updateRunStatus(); }, { danger: true }));
      else els.footer.appendChild(el('span', { class: 'cma-muted cma-small' }, 'Press Escape twice to abort the UI automation'));
      return;
    }
    const batch = batchForUndo();
    if (batch && state.result && state.result.engine === 'rpc') {
      els.undoBtn = btn('Undo this batch (' + batch.servingIds.length + ')', () => undo(batch), { danger: true, disabled: state.undoing, title: 'Remove every entry this batch added' });
      els.footer.appendChild(els.undoBtn);
    }
    els.footer.appendChild(btn('Reload page', () => reloadPage(), { title: 'Reload cronometer.com to see the diary refreshed' }));
    els.footer.appendChild(btn('Done', () => { switchView('input'); }, { primary: true }));
    els.footer.appendChild(el('span', { class: 'cma-spacer' }));
    if (state.result && state.result.failed.length) els.footer.appendChild(btn('Diagnostics', () => switchView('diagnostics'), { small: true }));
  }
  async function undo(batch) {
    const b = batch || batchForUndo() || state.storedBatch;
    if (!b || !Array.isArray(b.servingIds) || !b.servingIds.length) { notify('Nothing to undo', true); return null; }
    if (!CMA.engineRpc || typeof CMA.engineRpc.undo !== 'function') { notify('CMA.engineRpc is not loaded', true); return null; }
    if (state.undoing || state.running) return null;
    const r = readiness();
    if (!r.ok) { notify('Not ready: ' + r.missing.join(', '), true); return null; }
    state.undoing = true; state.runStatus = 'Removing ' + b.servingIds.length + ' entries…';
    log('undo: ' + b.servingIds.length + ' id(s)');
    if (state.view !== 'results' && state.plan) switchView('results'); else renderView();
    try {
      const res = await CMA.engineRpc.undo(sessionFrom(), b, { delayMs: state.settings.delayMs, sessionProvider: sessionFrom }, (p) => {
        if (p && p.index != null) { state.runStatus = 'Removing ' + (p.index + 1) + '/' + (p.total || b.servingIds.length) + '…'; updateRunStatus(); }
      });
      state.undoResult = { removed: (res && res.removed) || [], failed: (res && res.failed) || [], stopped: (res && res.stopped) || null };
      state.runStatus = 'Undo: ' + state.undoResult.removed.length + ' removed, ' + state.undoResult.failed.length + ' failed';
      if (state.undoResult.removed.length && res && res.refresh && !res.refresh.verified) state.runStatus += ' — the diary did not confirm the refresh: press Reload page to see it';
      // engine-rpc keeps only the ids that may still be in the diary (network/session failures) as lastBatch
      const kept = CMA.engineRpc && CMA.engineRpc.lastBatch && Array.isArray(CMA.engineRpc.lastBatch.servingIds) && CMA.engineRpc.lastBatch.servingIds.length ? CMA.engineRpc.lastBatch : null;
      if (state.result && state.result.lastBatch === b) state.result.lastBatch = kept;
      if (state.storedBatch === b) state.storedBatch = kept;
      log(state.runStatus);
      if (state.undoResult.stopped === 'session') notify('Session expired during undo: reload the Cronometer tab.', true);
      else if (state.view !== 'results') {
        // started from the Input view (stored batch, no plan): the Results list is not shown, so report here
        const f = state.undoResult.failed;
        notify(state.runStatus + (f.length ? ': ' + f.map(x => x.id + ' ' + errText(x.error)).join('; ') : ''), f.length > 0);
      }
      return state.undoResult;
    } catch (e) {
      notify('Undo failed: ' + errText(e), true);
      return null;
    } finally {
      state.undoing = false;
      renderView();
    }
  }
  function reloadPage() { try { location.reload(); } catch (e) { notify('Could not reload: ' + errText(e), true); } }

  // ---------------------------------------------------------------------------
  // Diagnostics view (SPEC §8): capture state WITHOUT the nonce + the last 50 log lines
  // ---------------------------------------------------------------------------
  function extensionInfo() {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        const m = chrome.runtime.getManifest();
        return { name: m.name, version: m.version };
      }
    } catch (e) { /* not an extension context */ }
    return { name: 'Multi-Add for Cronometer', version: 'unknown' };
  }
  function diagnosticsObject() {
    const c = capState();
    const cap = {};
    for (const k of Object.keys(c)) {
      if (k === 'nonce') continue;
      if (k === 'log') continue;
      const v = c[k];
      if (typeof v === 'function') continue;
      cap[k] = v;
    }
    cap.nonce = nonceValue() ? 'present' : 'missing';
    cap.nonceUpdatedAt = c.nonceUpdatedAt != null ? c.nonceUpdatedAt : null;
    const capLog = Array.isArray(c.log) ? c.log.slice(-LOG_TAIL).map(x => redact(typeof x === 'string' ? x : safeJson(x))) : [];
    const plan = state.plan ? {
      rows: state.plan.rows.map(r => ({ line: r.item && r.item.line, status: r.status, message: redact(r.message || ''), foodId: r.hit && r.hit.id, measureId: r.pick && r.pick.measure ? r.pick.measure.id : null, quantity: r.pick && r.pick.quantity, grams: r.pick && r.pick.grams, groupId: r.groupId, order: r.order })),
      date: state.plan.date, positionsSource: state.plan.positionsSource, warnings: state.plan.warnings, stopped: state.plan.stopped
    } : null;
    const result = state.result ? {
      engine: state.result.engine, added: state.result.added.length,
      addedWithNotes: state.result.added.filter(a => a.message || (a.warnings && a.warnings.length)).map(a => ({ line: a.row && a.row.item && a.row.item.line, message: a.message, warnings: a.warnings })),
      failed: state.result.failed.map(f => ({ line: f.row && f.row.item && f.row.item.line, error: f.error, kind: f.kind })),
      skipped: state.result.skipped.length, stopped: state.result.stopped, cancelled: state.result.cancelled, abortReason: state.result.abortReason, refresh: state.result.refresh, error: state.result.error
    } : null;
    // the ACTIVE registry (bundled or rebuilt at runtime) plus the store's status; nothing in either is session data
    const info = registryInfo();
    const st = registryStatus();
    const reg = info || st ? Object.assign({ permutation: null, policyHash: null, generatedAt: null, types: 0, source: st ? st.active : null }, info || {}, { store: st }) : null;
    return {
      extension: extensionInfo(),
      at: nowIso(),
      page: { href: safeHref(), userAgent: navigator.userAgent },
      capture: cap,
      captureLog: capLog,
      registry: reg,
      panel: { view: state.view, settings: Object.assign({}, state.settings), defaultGroupId: state.defaultGroupId, dateOverride: state.dateOverride, plan, result, lastBatch: (CMA.engineRpc && CMA.engineRpc.lastBatch) || state.storedBatch || null, lastRefresh: (CMA.engineRpc && CMA.engineRpc.lastRefresh) || null },
      // registered views (registerView): each one's own diagnostics(), which must hold no health data
      views: viewDiagnostics(),
      panelLog: state.log.slice(-LOG_TAIL)
    };
  }
  function safeHref() { try { return location.origin + location.pathname + location.hash; } catch (e) { return ''; } }
  function safeJson(v) {
    try { return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x); }
    catch (e) { return String(v); }
  }
  function diagnosticsText() {
    let text;
    try { text = JSON.stringify(diagnosticsObject(), (k, x) => typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x, 2); }
    catch (e) { text = '{"error":"could not serialise diagnostics: ' + errText(e) + '"}'; }
    // Belt and braces: even if some future field carries the nonce, the literal value never leaves this function.
    return redact(text);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    try {
      const ta = el('textarea', { class: 'cma-copybuf', 'aria-hidden': 'true' });
      ta.value = text;
      els.wrap.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }
  /** Decoder status block + "Rebuild decoder" (SPEC §3.5); re-rendered on 'state' / 'registry' events. */
  function refreshRegistryStatus() {
    if (!els.registryStatus || !els.registryStatus.isConnected) return;
    const box = els.registryStatus;
    clear(box);
    const c = capState();
    const st = registryStatus();
    const info = registryInfo();
    const kv = el('dl', { class: 'cma-kv' });
    const row = (k, v) => { kv.appendChild(el('dt', null, k)); kv.appendChild(el('dd', null, v)); };
    const source = info ? info.source : (st ? st.active : null);
    row('Decoder', source === 'runtime' ? 'rebuilt from the live app (runtime)' : source === 'bundled' ? 'bundled with the extension' : 'not loaded');
    row('Decoder build', info && info.permutation ? info.permutation + ' (' + info.types + ' types' + (info.generatedAt ? ', ' + info.generatedAt : '') + ')' : '?');
    row('Live build', (c.permutation || 'unknown') + (c.registryMismatch ? ' — differs from the decoder' : c.permutation ? ' — matches' : ''));
    if (st) {
      row('Stored decoder', st.storedPermutation ? st.storedPermutation + (st.storedAt ? ' (built ' + new Date(st.storedAt).toLocaleString() + ')' : '') : 'none');
      const lr = st.lastRebuild, la = st.lastAttempt;
      row('Last rebuild', st.inProgress ? 'running… ' + progressText(st.progress) : lr ? (lr.ok ? 'ok' : 'failed') + ' (' + (lr.reason || '?') + ', ' + formatSeconds(lr.ms) + (lr.ok ? ', ' + lr.types + ' types, ' + formatBytes(lr.bytes) : ', ' + redact(lr.error || 'unknown error')) + ')'
        : 'none this page load' + (la && typeof la.at === 'number' ? ' (last attempt ' + formatAgo(la.at) + ' for build ' + la.permutation + ': ' + (la.ok === false ? 'failed, ' + redact(la.error || 'unknown error') : la.ok ? 'ok' : 'unfinished') + ')' : ''));
    }
    box.appendChild(el('div', { class: 'cma-small' }, el('strong', null, 'Decoder (GWT type registry)')));
    box.appendChild(kv);
    const canRebuild = !!(st && typeof CMA.registryStore.rebuild === 'function' && st.builderLoaded && c.permutation && c.moduleBase) && !st.inProgress && !state.registryBusy;
    const why = !st ? 'registry store not loaded' : !st.builderLoaded ? 'registry builder not loaded' : !c.permutation || !c.moduleBase ? 'the live build is not known yet (reload the Cronometer tab)' : st.inProgress || state.registryBusy ? 'a rebuild is running' : 'Download the live app bundle and rebuild the decoder (about 10 s)';
    els.rebuildBtn = btn('Rebuild decoder', () => rebuildRegistry(), { disabled: !canRebuild, title: why, class: 'cma-rebuild-btn' });
    const outcome = el('span', { class: 'cma-registry-outcome' + (state.registryOutcome && state.registryOutcome.cls ? ' cma-' + state.registryOutcome.cls : '') }, state.registryOutcome ? state.registryOutcome.text : '');
    box.appendChild(el('div', { class: 'cma-registry-actions' }, els.rebuildBtn, outcome));
  }
  async function rebuildRegistry() {
    const s = CMA.registryStore;
    const c = capState();
    if (!s || typeof s.rebuild !== 'function') { notify('Registry store not loaded', true); return null; }
    if (!c.permutation || !c.moduleBase) { notify('The live build is not known yet: reload the Cronometer tab and open the diary first.', true); return null; }
    if (state.registryBusy) return null;
    state.registryBusy = true;
    state.registryOutcome = { text: 'Rebuilding the decoder from the live app (about 10 s)…', cls: null };
    log('rebuild decoder requested for build ' + c.permutation);
    refreshRegistryStatus();
    let r = null;
    try {
      r = await s.rebuild({ moduleBase: c.moduleBase, permutation: c.permutation, reason: 'manual', force: true });
      if (r && r.ok) {
        state.registryOutcome = { cls: 'ok', text: 'Decoder rebuilt: ' + r.types + ' types from ' + formatBytes(r.bytes) + (r.fragments != null ? ' (' + r.fragments + ' parts)' : '') + ' in ' + formatSeconds(r.ms) + (r.persisted ? '' : ' — ' + NOT_SAVED_NOTE) + '.' };
      } else {
        const problems = r && Array.isArray(r.problems) && r.problems.length ? ' (' + r.problems.slice(0, 3).map(redact).join('; ') + ')' : '';
        state.registryOutcome = { cls: 'err', text: 'Rebuild failed: ' + redact((r && r.error) || 'unknown error') + problems + ' — use the UI automation engine.' };
      }
    } catch (e) {
      state.registryOutcome = { cls: 'err', text: 'Rebuild failed: ' + errText(e) + ' — use the UI automation engine.' };
    } finally {
      state.registryBusy = false;
      log('rebuild decoder: ' + state.registryOutcome.text);
      if (state.view === 'diagnostics') { refreshRegistryStatus(); if (els.diagPre) els.diagPre.textContent = diagnosticsText(); }
    }
    return r;
  }
  function renderDiagnostics() {
    const text = diagnosticsText();
    els.body.appendChild(el('div', { class: 'cma-muted cma-small', style: 'margin-bottom:6px' }, 'Paste this into a bug report. It contains no session token (nonce shown as present/missing) and no cookies; it does name your account id, your diary group names, the page address and your browser, and the panel log at the end includes the food names you typed and searched — remove what you do not want to share. The TDEE part (views.tdee) holds counts, date ranges and settings flags only: no weight, intake, expenditure or target.'));
    els.registryStatus = el('div', { class: 'cma-registry-status' });
    els.body.appendChild(els.registryStatus);
    refreshRegistryStatus();
    els.diagPre = el('pre', { class: 'cma-pre' }, text);
    els.body.appendChild(els.diagPre);
    els.copyBtn = btn('Copy diagnostics', async () => {
      const ok = await copyText(diagnosticsText());
      notify(ok ? 'Diagnostics copied to the clipboard' : 'Copy failed: select the text above and copy it manually', !ok);
    }, { primary: true });
    els.footer.appendChild(els.copyBtn);
    els.footer.appendChild(btn('Refresh', () => renderView()));
    els.footer.appendChild(btn('Reload page', () => reloadPage()));
  }

  // ---------------------------------------------------------------------------
  // Settings view
  // ---------------------------------------------------------------------------
  function renderSettings() {
    const s = state.settings;
    const engine = el('select', { id: 'cma-s-engine' }, option('rpc', 'RPC (send updateDiary like the app does)', s.engine === 'rpc'), option('ui', 'UI automation (drive the Add Food dialog)', s.engine === 'ui'));
    engine.value = s.engine;
    const delay = el('input', { id: 'cma-s-delay', type: 'number', min: '0', max: '60000', step: '50', value: String(s.delayMs), style: 'width:90px' });
    const remember = el('input', { id: 'cma-s-remember', type: 'checkbox', checked: !!s.rememberInput });
    els.settingsForm = { engine, delay, remember };
    els.body.appendChild(el('div', { class: 'cma-form' },
      el('label', { for: 'cma-s-engine' }, 'Engine'), engine,
      el('label', { for: 'cma-s-delay' }, 'Delay between adds (ms)'), delay,
      el('label', { for: 'cma-s-remember' }, 'Remember last input'), remember,
      el('div', { class: 'cma-full cma-muted cma-small' }, 'RPC is fast and can be undone; switch to UI automation if RPC fails after a Cronometer deploy. Settings are stored in this browser profile only.')));
    els.settingsStatus = el('span', { class: 'cma-muted cma-small' });
    els.footer.appendChild(btn('Save', async () => {
      // saveSettings also clears the stored input when rememberInput is switched off.
      const ok = await saveSettings({ engine: engine.value, delayMs: Number(delay.value), rememberInput: !!remember.checked });
      els.settingsStatus.textContent = ok ? 'Saved' : 'Saved for this page only (chrome.storage unavailable)';
      log('settings saved: ' + JSON.stringify(state.settings));
    }, { primary: true }));
    els.footer.appendChild(btn('Reset', async () => { await saveSettings(Object.assign({}, DEFAULT_SETTINGS)); renderView(); }));
    els.footer.appendChild(btn('Forget saved input', async () => { state.input = ''; state.storedInput = null; await storageSet({ [INPUT_KEY]: '' }); els.settingsStatus.textContent = 'Saved input cleared'; }));
    // The undo record of the last batch (entry ids, diary date, timestamp, account id under cmaLastBatch) is
    // otherwise replaced by the next batch, deleted by a complete undo or dropped 24 h later on the next load;
    // this is the on-demand deletion PRIVACY.md (section 6) names. The diary entries themselves stay.
    els.footer.appendChild(btn('Forget last batch', async () => {
      try { if (CMA.engineRpc && typeof CMA.engineRpc.clearLastBatch === 'function') await CMA.engineRpc.clearLastBatch(); } catch (e) { log('clearLastBatch failed: ' + errText(e)); }
      state.storedBatch = null;
      if (state.result) state.result.lastBatch = null;
      els.settingsStatus.textContent = 'Last batch forgotten (it can no longer be undone from here)';
      log('stored batch forgotten on request');
    }, { title: 'Delete the stored undo information of the last batch (the diary entries stay)' }));
    els.footer.appendChild(el('span', { class: 'cma-spacer' }));
    els.footer.appendChild(els.settingsStatus);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CMA.panel = {
    mount, unmount, toggle, open, close, setState, isOpen, getState,
    findFoods, addAll, undo, uiRefreshSignal, rebuildRegistry,
    diagnosticsText, diagnosticsObject,
    loadSettings, saveSettings, getSettings: () => Object.assign({}, state.settings),
    setInput: (text) => { state.input = String(text == null ? '' : text); if (els.textarea) els.textarea.value = state.input; updateFindButton(); saveInputSoon(); },
    getInput: () => state.input,
    ensureToolbarButton,
    registerView,
    views: () => Array.from(customViews.values(), v => ({ id: v.id, label: v.label, order: v.order })),
    get host() { return host; },
    get root() { return root; },
    get VIEWS() { return viewIds(); },
    DEFAULT_SETTINGS, SETTINGS_KEY, INPUT_KEY, HOST_ID
  };
  // view definitions queued by a script that loaded before panel.js (registerView's fallback, see above)
  if (Array.isArray(CMA.panelViewQueue)) {
    CMA.panelViewQueue.splice(0).forEach(def => { try { registerView(def); } catch (e) { log('queued view rejected: ' + errText(e)); } });
  }
})();
