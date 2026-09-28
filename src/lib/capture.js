/* capture.js - turns the traffic relayed by src/hook-main.js into session state (SPEC section 2.3).
 *
 * ISOLATED world. Exposes:
 *   CMA.events  = { on(name, fn) -> unsubscribe, off(name, fn), once(name, fn), emit(name, payload) }
 *   CMA.capture = {
 *     state,                       see STATE below (the nonce lives here in memory only, never persisted)
 *     handleMessage(data),         feed one hook message ({type:'xhr'|'gwt'|'pong', ...}); never throws
 *     ready() -> {ok, missing},    hooked + nonce + userId + permutation + policyHash + moduleBase
 *     session() -> {moduleBase, permutation, policyHash, nonce, userId}   what CMA.rpc calls take
 *     probeDom(doc?) -> {...},     DOM fallbacks: permutation/moduleBase from the <script ...cache.js> tag,
 *                                  groups from .diary-group-title texts (SPEC 2.1 / 2.3)
 *     waitFor(pred, {timeout}) -> Promise<event>   resolves on the next 'rpc'/'rest' event pred() accepts
 *     log(kind, fields), redact(str), snapshot(), reset(), decodeGroups(map), groupsFromTitles(titles),
 *     userIdFromUrl(url), extractUserId(parsed), DEFAULT_GROUP_NAMES, defaultGroups()
 *   }
 * Runtime registry (SPEC 3.5): whenever the live permutation is learned (header, gwt message, DOM probe)
 * CMA.registryStore.activate(perm) runs synchronously BEFORE the carrying message is decoded, so a decoder
 * rebuilt for that build is used from the replayed authenticate exchange on; registryMismatch is then
 * computed against the active CMA.registry, a mismatch starts one automatic rebuild per permutation per
 * page load (once the module base is known), and the 'registry' event re-evaluates the mismatch.
 * Facts relied on (research/live-app-report.md, research/serving-fields-resolved.md, SPEC 2.1):
 *   - the first java.lang.String parameter of every user RPC is the session nonce ($c.Q); it rotates on
 *     authenticate (User field 33) and on reauthenticate (a STRING result the app stores as the new key);
 *   - authenticate(Integer) returns User/91151502: field 19 = userId, field 33 = session key, and the
 *     UserPreferences HashMap (a HashMap subclass, decoded to a Map) holds DG01..DG08 / DG01ON..DG08ON /
 *     DG_ON; the diary code (Lrd) reads `DG0<f>ON` for f = 2..8 as group id f-1, so key DG0<n> <-> id n-1;
 *   - getDayInfo(String, Day, int userId) carries the viewed diary date; userId is also in every
 *     /api/v3/user/{id}/... URL; permutation = X-GWT-Permutation request header; policy hash = 2nd string
 *     of a request body; module base = 1st string; X-Cronometer-Throttle-Version is a response header.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ------------------------------------------------------------------------------------------------
  // CMA.events - tiny synchronous pub/sub (guarded so any file may define it first)
  // ------------------------------------------------------------------------------------------------
  if (!CMA.events) {
    const listeners = new Map();
    function on(name, fn) {
      if (typeof fn !== 'function') throw new Error('CMA.events.on: listener must be a function');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return function off() { const s = listeners.get(name); if (s) s.delete(fn); };
    }
    function off(name, fn) { const s = listeners.get(name); if (s) s.delete(fn); }
    function once(name, fn) {
      const un = on(name, function (payload) { un(); fn(payload); });
      return un;
    }
    function emit(name, payload) {
      const s = listeners.get(name);
      if (!s || s.size === 0) return 0;
      let n = 0;
      Array.from(s).forEach(function (fn) {
        try { fn(payload); n++; } catch (e) { try { console.warn('[CMA] event listener for ' + name + ' failed:', e); } catch (e2) { /* ignore */ } }
      });
      return n;
    }
    CMA.events = { on, off, once, emit, count: function (name) { const s = listeners.get(name); return s ? s.size : 0; } };
  }

  // ------------------------------------------------------------------------------------------------
  // constants
  // ------------------------------------------------------------------------------------------------
  const STRING_SIG = 'java.lang.String/2004016611';
  const RPC_RE = /\/cronometer\/(app|pro)(\?|$)/;
  const V3_RE = /\/api\/v3\//;
  const V3_USER_RE = /\/api\/v3\/user\/(\d+)(\/|\?|$)/;
  const HEX32_RE = /^[0-9A-Fa-f]{32}$/;
  const CACHE_JS_RE = /^(.*\/)([0-9A-Fa-f]{32})\.cache\.js(?:[?#].*)?$/;
  const LOG_MAX = 200;
  // J_i in the bundle: ['Uncategorized','Breakfast','Lunch','Dinner','Snacks','Group 6','Group 7','Group 8'] (index = group id)
  const DEFAULT_GROUP_NAMES = ['Uncategorized', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Group 6', 'Group 7', 'Group 8'];
  const SERVING_PREFIX = 'com.cronometer.shared.entries.models.Serving/';
  const USER_PREFIX = 'com.cronometer.shared.user.models.User/';
  const EECR_PREFIX = 'com.cronometer.shared.entries.changes.ErrorEntryChangeResult/';
  // //OK responses of these methods are decoded: updateDiary to spot a rejected add (an ErrorEntryChangeResult
  // travels INSIDE a //OK list, SPEC 3.3/4), getDayInfo/getFood so a registry that no longer matches the live
  // build shows up in the log as a 'decode' entry instead of failing silently later.
  const DECODED_METHODS = { updateDiary: true, getDayInfo: true, getFood: true };
  // SPEC 0: only same-origin traffic feeds the state. On https://cronometer.com that is location.origin; on a
  // file: test page (opaque origin) it is the origin SPEC 0 names, unless a test calls setPageOrigin().
  const DEFAULT_ORIGIN = 'https://cronometer.com';
  const PAGE_IS_HTTP = typeof location !== 'undefined' && /^https?:\/\//.test(String(location.origin || ''));
  let pageOrigin = PAGE_IS_HTTP ? location.origin : DEFAULT_ORIGIN;

  // Methods whose userId parameter index is known from the proxy stubs (research/live-app-report.md
  // section 3 and research/rpc-methods-compact.txt). Used before the generic "first int preceded only
  // by simple params" rule, because e.g. getFood(String, I) carries a foodId, not the userId.
  const USER_ID_PARAM = {
    updateDiary: 1, editDiaryEntries: 2, editServing: 2, removeServing: 2, getDayInfo: 2, getServings: 1,
    copyDay: 1, logRepeatItemsForDay: 1, setFavourite: 1, addFood: 1, findMyFoods: 1, explodeRecipe: 1,
    getAllMacroSchedules: 1, getMacroTargetTemplates: 1, getDailyMacroTargetTemplate: 1, getRecentBiometrics: 1,
    getUserFasts: 1, getUserFastsForRange: 1, getFastingStats: 1, getRepeatedItems: 1, addRepeatItem: 1,
    deleteRepeatItem: 1, setDayComplete: 1, addBiometric: 2, removeMeasurement: 2, reauthenticate: 1,
    generateAuthorizationToken: 1, areThereRepeatItemsToBeLoggedForDay: 1,
  };
  // Methods whose leading int is definitely NOT the userId.
  const NOT_USER_ID = { getFood: true, getAllFood: true, getDiaryEntries: true, authenticate: true };
  // Confidence ranking of userId sources: a lower-ranked source never overrides a higher-ranked value.
  const USER_ID_RANK = { authenticate: 4, 'v3-url': 3, method: 3, generic: 1 };

  // ------------------------------------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------------------------------------
  function today(d) {
    const x = d instanceof Date ? d : new Date();
    return { day: x.getDate(), month: x.getMonth() + 1, year: x.getFullYear() };
  }
  function defaultGroups() {
    return DEFAULT_GROUP_NAMES.map(function (name, id) { return { id: id, name: name, enabled: id <= 4 }; });
  }
  function freshState() {
    return {
      hooked: false,
      moduleBase: null, permutation: null, permutationSource: null,
      policyHash: null, policyHashSource: null,
      nonce: null, nonceUpdatedAt: null, nonceSource: null,
      userId: null, userIdSource: null,
      groups: defaultGroups(), groupsSource: 'default', groupsOn: null,
      diaryDate: today(), diaryDateSource: 'today',
      lastRpcAt: null, rpcCount: 0, lastMethod: null,
      lastRestAt: null, restCount: 0,
      lastGetDayInfo: null,
      lastError: null, lastException: null,
      throttleVersion: null, throttleVersionChangedAt: null,
      gwt: null,
      registryMismatch: false,   // live permutation != the permutation of the ACTIVE registry (CMA.registry)
      registrySource: null,      // 'bundled' | 'runtime' once CMA.registryStore.activate() ran for the live permutation
      ignoredForeign: 0,         // xhr messages from other origins (third-party SDKs) that were dropped
      log: [],
    };
  }
  const state = freshState();
  const seenNonces = new Set();   // every nonce value ever captured, so old ones are redacted too
  const rebuildTriggered = new Set();   // permutations an automatic registry rebuild was started for (once per page load)
  // {text, t} of the most recent authenticate //OK reply. Memory only - never logged, stored or part of
  // snapshot() - so a decoder installed later (storage answering after the first ping, a finished rebuild)
  // can read it again: authenticate is the only source of the diary groups (replayAuthenticate).
  let lastAuthenticate = null;

  // ------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------
  function isPosInt(n) { return typeof n === 'number' && Number.isInteger(n) && n > 0; }
  function headerOf(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    const want = String(name).toLowerCase();
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === want) return headers[keys[i]];
    return null;
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function responseHeaderOf(all, name) {
    if (typeof all !== 'string' || !all) return null;
    const m = new RegExp('^' + escapeRe(name) + ':[ \\t]*([^\\r\\n]*)', 'im').exec(all);
    return m ? m[1].trim() : null;
  }
  function pathOf(url) {
    // pathname only: the search string of /food-search/string carries the food name the user typed
    try { const u = new URL(String(url), pageOrigin + '/'); return u.pathname; } catch (e) { return String(url).split('?')[0]; }
  }
  function originOfUrl(url) { try { return new URL(String(url)).origin; } catch (e) { return null; } }
  /** Relative URLs and absolute URLs on the page origin are ours; any other http(s) host is foreign. */
  function sameOriginUrl(url) {
    const s = String(url == null ? '' : url);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;             // relative: resolved against the page
    if (!/^https?:\/\//i.test(s)) return !PAGE_IS_HTTP;             // file: etc. only on opaque test pages
    return originOfUrl(s) === pageOrigin;
  }
  function redact(s) {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    seenNonces.forEach(function (n) { if (n && out.indexOf(n) >= 0) out = out.split(n).join('<NONCE>'); });
    return out;
  }
  function redactValue(v) {
    if (typeof v === 'string') return redact(v).slice(0, 300);
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) return v.map(redactValue);
      const o = {};
      Object.keys(v).forEach(function (k) { o[k] = redactValue(v[k]); });
      return o;
    }
    return v;
  }
  /** log(kind, fields): append a redacted entry to the ring buffer (max 200). Never stores request bodies. */
  function log(kind, fields) {
    const entry = { t: Date.now(), kind: String(kind) };
    if (fields && typeof fields === 'object') {
      Object.keys(fields).forEach(function (k) {
        if (k === 'requestBody' || k === 'responseText' || k === 'nonce' || k === 'body') return;   // never
        entry[k] = redactValue(fields[k]);
      });
    }
    state.log.push(entry);
    while (state.log.length > LOG_MAX) state.log.shift();
    return entry;
  }
  function emitState() {
    try { CMA.events.emit('state', state); } catch (e) { /* ignore */ }
  }
  function gwt() { return CMA.gwt && typeof CMA.gwt.parseRequest === 'function' ? CMA.gwt : null; }

  function setNonce(value, source, t) {
    if (typeof value !== 'string' || value.length === 0) return false;
    seenNonces.add(value);
    if (state.nonce === value) return false;
    const had = !!state.nonce;
    state.nonce = value;
    state.nonceUpdatedAt = t || Date.now();
    state.nonceSource = source;
    log('nonce', { source: source, note: 'session nonce ' + (had ? 'rotated' : 'captured') + ' (' + value.length + ' chars)' });
    return true;
  }
  function applyUserId(id, source) {
    if (!isPosInt(id)) return false;
    const rank = USER_ID_RANK[source] || 0;
    const cur = state.userId != null ? (USER_ID_RANK[state.userIdSource] || 0) : -1;
    if (state.userId === id) { if (rank > cur) state.userIdSource = source; return false; }
    if (rank < cur) return false;               // keep the higher-confidence value
    state.userId = id;
    state.userIdSource = source;
    log('userId', { source: source, userId: id });
    return true;
  }
  function applyPermutation(value, source) {
    if (typeof value !== 'string' || !HEX32_RE.test(value)) return false;
    const v = value.toUpperCase();
    if (state.permutation === v) return false;
    state.permutation = v;
    state.permutationSource = source;
    // SPEC 3.5: install the runtime-built registry for this build (when one is stored) BEFORE anything of
    // this message is decoded - the replayed authenticate response arrives with the header that names the
    // permutation, and handleRpc decodes it right after this call. Synchronous: the store keeps its record in
    // memory (content.js awaits CMA.registryStore.init() before it pings the hook).
    activateRegistry(v);
    state.registryMismatch = registryMismatchFor(v);
    if (state.registryMismatch) log('warn', { note: 'live permutation ' + v + ' differs from the registry build ' + String(CMA.registry && CMA.registry.permutation).toUpperCase() + ': Cronometer deployed a new build; RPC decoding may fail until the decoder is rebuilt (automatic, see Diagnostics) - the UI engine keeps working' });
    inferPolicyFromRegistry();
    return true;
  }
  /** True when the live permutation is not the one the ACTIVE registry was built from (SPEC 3.2 / 3.5). */
  function registryMismatchFor(perm) {
    const reg = CMA.registry;
    if (!reg || !reg.permutation || !perm) return false;
    return String(reg.permutation).toUpperCase() !== String(perm).toUpperCase();
  }

  // ------------------------------------------------------------------------------------------------
  // runtime registry (SPEC 3.5): CMA.registryStore swaps CMA.registry per live build and rebuilds it
  // ------------------------------------------------------------------------------------------------
  function registryStore() {
    const s = CMA.registryStore;
    return s && typeof s.activate === 'function' ? s : null;
  }
  /** activate(perm) on the store (guarded); records which registry is now active. */
  function activateRegistry(perm) {
    const s = registryStore();
    if (!s) return null;
    try {
      const r = s.activate(perm);
      if (r && (r.source === 'runtime' || r.source === 'bundled')) state.registrySource = r.source;
      return r;
    } catch (e) {
      log('warn', { note: 'registry activation failed: ' + (e && e.message ? e.message : String(e)) });
      return null;
    }
  }
  /**
   * Start ONE automatic rebuild per permutation per page load when the live build has no matching registry
   * (registryMismatch) and the module base (the bundle's URL prefix) is known. Called after every handled
   * message and DOM probe, because the permutation (header) and the module base (request body) usually
   * arrive in different steps. The trigger waits for the store's init() so a registry stored by an earlier
   * session is never rebuilt again just because storage answered after the first message; the store
   * itself rate-limits and single-flights. Fire-and-forget: outcomes are logged, never thrown.
   */
  function maybeRebuildRegistry() {
    const s = registryStore();
    if (!s || typeof s.rebuild !== 'function') return false;
    const perm = state.permutation;
    if (!perm || !state.registryMismatch || !state.moduleBase) return false;
    if (rebuildTriggered.has(perm)) return false;
    rebuildTriggered.add(perm);
    const run = function () {
      if (!state.registryMismatch || state.permutation !== perm) return;     // a stored registry arrived meanwhile
      log('registry', { note: 'live build ' + perm + ' has no matching decoder: rebuilding it from the live app' });
      let p = null;
      try { p = s.rebuild({ moduleBase: state.moduleBase, permutation: perm, reason: 'mismatch' }); } catch (e) { log('registry', { note: 'automatic rebuild could not start: ' + (e && e.message ? e.message : String(e)) }); return; }
      if (p && typeof p.then === 'function') {
        p.then(function (r) { if (r && !r.ok) log('registry', { note: 'automatic rebuild failed: ' + (r.error || 'unknown error') }); },
          function (e) { log('registry', { note: 'automatic rebuild failed: ' + (e && e.message ? e.message : String(e)) }); });
      }
    };
    let init = null;
    try { init = typeof s.init === 'function' ? s.init() : null; } catch (e) { init = null; }
    if (init && typeof init.then === 'function') init.then(run, run); else run();
    return true;
  }
  /** Re-evaluate the mismatch whenever the store installs another registry (a rebuild finished, a stored record
   *  arrived late, the user forgot the stored one); the panel's banner follows the 'state' event. */
  function onRegistryChanged(info) {
    if (info && (info.source === 'runtime' || info.source === 'bundled')) state.registrySource = info.source;
    if (state.permutation) {
      const before = state.registryMismatch;
      state.registryMismatch = registryMismatchFor(state.permutation);
      if (before && !state.registryMismatch) log('registry', { note: 'decoder now matches live build ' + state.permutation });
      else if (!before && state.registryMismatch) log('warn', { note: 'decoder no longer matches live build ' + state.permutation });
      inferPolicyFromRegistry();
      replayAuthenticate();
    }
    emitState();
  }
  try { CMA.events.on('registry', onRegistryChanged); } catch (e) { /* ignore */ }
  /**
   * SPEC 3.5: the hook replays the app's authenticate exchange on the first ping; when the decoder for that
   * build is installed only afterwards (chrome.storage answered after content.js's bound, or the automatic
   * rebuild finished), the reply was undecodable at the time and the groups (and the account id it names)
   * would be lost for the session. Read the retained reply again with the decoder that now matches. Only the
   * groups and the id are taken from it; the session key only when none is known yet - a nonce captured
   * meanwhile is newer in wire order (handleAuthenticate's replay mode).
   */
  function replayAuthenticate() {
    if (!lastAuthenticate || state.registryMismatch || state.groupsSource === 'authenticate') return false;
    log('registry', { note: 'authenticate reply re-read with the decoder for build ' + state.permutation });
    handleAuthenticate(lastAuthenticate.text, lastAuthenticate.t, true);
    return true;
  }
  /** Same permutation as the analysed bundle => same cache.js => same 'app' policy hash (SPEC 3.2 records both). */
  function inferPolicyFromRegistry() {
    const reg = CMA.registry;
    if (state.policyHash || !reg || !reg.permutation || !reg.policyHash) return false;
    if (String(reg.permutation).toUpperCase() !== state.permutation) return false;
    state.policyHash = String(reg.policyHash);
    state.policyHashSource = 'registry';
    log('policy', { source: 'registry', note: 'policy hash taken from the registry (permutation matches the analysed bundle)' });
    return true;
  }
  function userIdFromUrl(url) {
    if (!sameOriginUrl(url)) return null;                          // a foreign /api/v3/user/<n>/ is not our user
    const m = V3_USER_RE.exec(String(url || ''));
    return m ? Number(m[1]) : null;
  }

  // ------------------------------------------------------------------------------------------------
  // userId extraction from a parsed request (SPEC 2.3)
  // ------------------------------------------------------------------------------------------------
  /**
   * extractUserId(parsed) -> {userId, source:'method'|'generic'} | null. parsed = CMA.gwt.parseRequest(body).
   * Known methods use their stub's userId index; otherwise the first int parameter preceded only by
   * strings / primitives / Day / Time (CMA.gwt.simpleParams) is taken with low confidence.
   */
  function extractUserId(parsed) {
    const g = gwt();
    if (!g || !parsed || !Array.isArray(parsed.paramSigs)) return null;
    let sp;
    try { sp = g.simpleParams(parsed); } catch (e) { return null; }
    const known = USER_ID_PARAM[parsed.method];
    if (known !== undefined) {
      const p = sp[known];
      if (p && p.kind === 'int' && isPosInt(p.value)) return { userId: p.value, source: 'method' };
      return null;
    }
    if (NOT_USER_ID[parsed.method]) return null;
    for (let i = 0; i < sp.length; i++) {
      if (!sp[i].simple) return null;           // an object parameter comes first: stop
      if (sp[i].kind === 'int') return isPosInt(sp[i].value) ? { userId: sp[i].value, source: 'generic' } : null;
    }
    return null;
  }
  function dayParamOf(parsed) {
    const g = gwt();
    if (!g) return null;
    let sp;
    try { sp = g.simpleParams(parsed); } catch (e) { return null; }
    for (let i = 0; i < sp.length; i++) {
      const p = sp[i];
      if (p.kind === 'day' && p.value && isPosInt(p.value.year) && isPosInt(p.value.month) && isPosInt(p.value.day)) {
        return { day: p.value.day, month: p.value.month, year: p.value.year };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------
  // groups
  // ------------------------------------------------------------------------------------------------
  /** True for a Map that carries any diary-group preference key (DG01..DG08, DG0nON, DG_ON). */
  function isPrefMap(m) {
    if (!(m instanceof Map)) return false;
    let hit = false;
    m.forEach(function (v, k) { if (/^DG0[1-8](ON)?$/.test(String(k)) || k === 'DG_ON') hit = true; });
    return hit;
  }
  /**
   * decodeGroups(map) -> always 8 groups [{id, name, enabled}], id = n-1 for key DG0<n>, exactly like the
   * app's own dropdown builder `cNh`: `for(c=1;c<9;c++){ alo('true', WBk(a,'DG0'+c+'ON', ''+(c<6))) &&
   * Yze(b, ''+(c-1), WBk(a,'DG0'+c, J_i[c-1])) }` — a missing name means the default name, a missing ON flag
   * means enabled for ids 0..4 and disabled for 5..7. Returns null when the map carries no DG key at all.
   */
  function decodeGroups(map) {
    if (!isPrefMap(map)) return null;
    const out = [];
    for (let id = 0; id < 8; id++) {
      const key = 'DG0' + (id + 1);
      const rawName = map.get(key);
      const name = rawName == null || String(rawName).trim() === '' ? DEFAULT_GROUP_NAMES[id] : String(rawName).trim();
      const on = map.get(key + 'ON');
      const enabled = on == null || on === '' ? id <= 4 : (on === 'true' || on === true);
      out.push({ id: id, name: name, enabled: enabled });
    }
    return out;
  }
  /**
   * groupsFromTitles(titles) -> 8 groups. Titles matching a default name keep that id; other titles take
   * the next free id from 1 upwards (DG02 = id 1 is the first real group in Lrd), all displayed = enabled.
   * Low confidence: ids of renamed groups are guessed from display order (SPEC 2.3).
   */
  function groupsFromTitles(titles) {
    const groups = defaultGroups().map(function (g) { return { id: g.id, name: g.name, enabled: false }; });
    const used = new Set();
    const pending = [];
    const seen = new Set();
    (titles || []).forEach(function (raw) {
      const t = String(raw == null ? '' : raw).split('\n')[0].trim();
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      const id = DEFAULT_GROUP_NAMES.findIndex(function (n) { return n.toLowerCase() === t.toLowerCase(); });
      if (id >= 0 && !used.has(id)) { groups[id].name = t; groups[id].enabled = true; used.add(id); } else pending.push(t);
    });
    let next = 1;
    pending.forEach(function (t) {
      while (next <= 7 && used.has(next)) next++;
      if (next > 7) return;
      groups[next].name = t; groups[next].enabled = true; used.add(next);
    });
    return groups;
  }

  // ------------------------------------------------------------------------------------------------
  // authenticate response (SPEC 2.1 / 2.3)
  // ------------------------------------------------------------------------------------------------
  /** replay = true when re-reading a retained reply later (replayAuthenticate): the session key is then taken
   *  only when none is known, because anything captured since is newer in wire order. */
  function handleAuthenticate(text, t, replay) {
    const g = gwt();
    if (!g) return;
    let r;
    try { r = g.readResponse(text); } catch (e) {
      log('warn', { note: 'authenticate response could not be decoded' + (replay ? ' (re-read)' : '') + ': ' + e.message + (replay ? '' : ' - kept in memory: it is read again once a matching decoder is installed') });
      return;
    }
    if (!r.ok) return;
    const u = r.value;
    const F = g.F && g.F.USER ? g.F.USER : { ID: 19, SESSION: 33 };
    if (u && typeof u === 'object' && typeof u.$t === 'string' && u.$t.indexOf(USER_PREFIX) === 0 && Array.isArray(u.f)) {
      applyUserId(u.f[F.ID], 'authenticate');
      const key = u.f[F.SESSION];
      // authenticate rotates the session nonce and its response carries the new value; the message is
      // processed in wire order, so the key is at least as fresh as anything captured before it.
      if (typeof key === 'string' && key.length > 0 && !(replay && state.nonce)) setNonce(key, 'authenticate', t);
    } else {
      log('warn', { note: 'authenticate payload is not a User object', type: u && u.$t });
    }
    let maps = [];
    try { maps = g.findMaps(u, isPrefMap); } catch (e) { maps = []; }
    if (maps.length) {
      const groups = decodeGroups(maps[0]);
      if (groups) {
        state.groups = groups;
        state.groupsSource = 'authenticate';
        const on = maps[0].get('DG_ON');
        state.groupsOn = on == null ? null : (on === 'true' || on === true);
        log('groups', { source: 'authenticate', groups: groups.map(function (x) { return x.id + ':' + x.name + (x.enabled ? '' : ' (off)'); }) });
      }
    } else {
      log('warn', { note: 'authenticate response has no DG0n preference map; keeping ' + state.groupsSource + ' groups' });
    }
  }

  /**
   * Decode a //OK response of a known method (DECODED_METHODS). {error} when the registry cannot read it
   * (the message names the offending type signature), {rejected, message} for updateDiary whose result list
   * carries an ErrorEntryChangeResult, {} otherwise.
   */
  function decodeKnownResponse(method, text) {
    const g = gwt();
    let r;
    try { r = g.readResponse(text); } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
    if (!r.ok || method !== 'updateDiary') return {};
    const list = Array.isArray(r.value) ? r.value : (r.value ? [r.value] : []);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v && typeof v === 'object' && typeof v.$t === 'string' && v.$t.indexOf(EECR_PREFIX) === 0) {
        return { rejected: true, message: exceptionMessageOf(Array.isArray(v.f) ? v.f[0] : null) };
      }
    }
    return { rejected: false };
  }
  function exceptionMessageOf(ex) {
    try { if (CMA.rpc && typeof CMA.rpc.exceptionMessage === 'function') return CMA.rpc.exceptionMessage(ex); } catch (e) { /* fall through */ }
    if (ex && Array.isArray(ex.f)) for (let i = 0; i < ex.f.length; i++) if (typeof ex.f[i] === 'string') return ex.f[i];
    return null;
  }

  // ------------------------------------------------------------------------------------------------
  // xhr messages
  // ------------------------------------------------------------------------------------------------
  function handleRpc(d, service, t) {
    state.rpcCount++;
    state.lastRpcAt = t;
    const status = typeof d.status === 'number' ? d.status : Number(d.status) || 0;
    const text = typeof d.responseText === 'string' ? d.responseText : null;
    const perm = headerOf(d.requestHeaders, 'X-GWT-Permutation');
    if (perm) applyPermutation(perm, 'header');
    const g = gwt();
    let parsed = null;
    let method = null;
    if (service === 'app' && g && typeof d.requestBody === 'string' && /^\d+\|\d+\|\d+\|/.test(d.requestBody)) {
      try { parsed = g.parseRequest(d.requestBody); } catch (e) { parsed = null; log('warn', { note: 'request body could not be parsed: ' + e.message }); }
    }
    let date = null;
    if (parsed) {
      method = parsed.method || null;
      state.lastMethod = method;
      if (typeof parsed.moduleBase === 'string' && parsed.moduleBase) {
        // SPEC 0: rpc.js POSTs the nonce to moduleBase + 'app', so a module base on another origin (a forged
        // message, a dev-mode hook redirect) is never adopted.
        if (sameOriginUrl(parsed.moduleBase)) state.moduleBase = parsed.moduleBase;
        else log('warn', { note: 'module base on a foreign origin ignored: ' + originOfUrl(parsed.moduleBase) });
      }
      if (typeof parsed.policyHash === 'string' && parsed.policyHash) { state.policyHash = parsed.policyHash; state.policyHashSource = 'traffic'; }
      // A reauthenticate REQUEST carries the key the server just rejected ($c.Q at the time of the
      // NotLoggedInException): never adopt it; its //OK response carries the fresh key (below).
      if (parsed.paramSigs[0] === STRING_SIG && typeof parsed.nonce === 'string' && method !== 'reauthenticate') setNonce(parsed.nonce, 'request', t);
      if (parsed.paramError) log('warn', { method: method, note: 'request parameter undecodable (registry stale?): ' + parsed.paramError });
      const uid = extractUserId(parsed);
      if (uid) applyUserId(uid.userId, uid.source);
      if (method === 'getDayInfo') {
        date = dayParamOf(parsed);
        if (date) {
          state.diaryDate = date;
          state.diaryDateSource = 'getDayInfo';
          state.lastGetDayInfo = { date: date, t: t, status: status };
        }
      }
    }
    const ok = text !== null && text.indexOf('//OK') === 0;
    const ex = text !== null && text.indexOf('//EX') === 0;
    let exType = null;
    let rejected = false;
    let rejectMessage = null;
    if (ok) {
      if (method === 'authenticate') { lastAuthenticate = { text: text, t: t }; handleAuthenticate(text, t, false); }
      else if (method === 'reauthenticate' && g) {
        // The app calls reauthenticate(oldNonce, userId) whenever one of its RPCs answers NotLoggedInException
        // (`if($8k(a.a,813)){zSf(Zc.c.d,$c.Q,$c.B,...)}`) and stores the STRING result as the new session key
        // (`P1b(a){pYb(X8k(a))}` -> `iDk($c, a)`). The request side carries the OLD key, so without this the
        // captured nonce would stay stale until the app happened to send another RPC (SPEC 2.1).
        try {
          const r = g.readResponse(text, 's');
          if (r.ok && typeof r.value === 'string' && r.value) setNonce(r.value, 'reauthenticate', t);
          else if (r.ok) log('warn', { note: 'reauthenticate returned no session key' });
        } catch (e) { log('warn', { note: 'reauthenticate response could not be decoded: ' + (e && e.message ? e.message : String(e)) }); }
      } else if (method && DECODED_METHODS[method] && g) {
        const dec = decodeKnownResponse(method, text);
        if (dec.error) log('decode', { method: method, note: 'response could not be decoded (registry stale?): ' + dec.error });
        else if (dec.rejected) {
          rejected = true;
          rejectMessage = dec.message;
          log('warn', { method: method, note: 'updateDiary rejected the entry: ' + (dec.message || 'unknown error') });
        }
      }
      if (state.lastError === 'session' && service === 'app') state.lastError = null;   // the session works again
    } else if (ex) {
      let info = null;
      if (g) { try { const r = g.readResponse(text); info = r.ok ? null : r.exception; } catch (e) { info = null; } }
      exType = (info && info.type) || (/NotLoggedInException/.test(text) ? 'NotLoggedInException' : 'exception');
      state.lastException = { type: exType, message: info ? info.message : null, method: method, t: t };
      if (/NotLoggedInException/.test(text)) state.lastError = 'session';
    }
    const tv = responseHeaderOf(d.responseHeaders, 'X-Cronometer-Throttle-Version');
    if (tv !== null && tv !== '') {
      if (state.throttleVersion !== null && state.throttleVersion !== tv) state.throttleVersionChangedAt = t;
      state.throttleVersion = tv;
    }
    log('rpc', { service: service, method: method, status: status, ok: ok, ex: exType, date: date, throttle: tv, rejected: rejected || undefined });
    const ev = { type: 'rpc', service: service, method: method, status: status, ok: ok, ex: exType, date: date, t: t, parsed: parsed, rejected: rejected, rejectMessage: rejectMessage };
    try { CMA.events.emit('rpc', ev); } catch (e) { /* ignore */ }
  }
  function handleRest(d, t) {
    state.restCount++;
    state.lastRestAt = t;
    const status = typeof d.status === 'number' ? d.status : Number(d.status) || 0;
    const uid = userIdFromUrl(d.url);
    if (uid) applyUserId(uid, 'v3-url');
    const tv = responseHeaderOf(d.responseHeaders, 'X-Cronometer-Throttle-Version');
    if (tv !== null && tv !== '') {
      if (state.throttleVersion !== null && state.throttleVersion !== tv) state.throttleVersionChangedAt = t;
      state.throttleVersion = tv;
    }
    const path = pathOf(d.url);
    log('rest', { method: d.method, path: path, status: status });
    try { CMA.events.emit('rest', { type: 'rest', method: d.method, path: path, status: status, t: t }); } catch (e) { /* ignore */ }
  }

  /** handleMessage(data): one message from the MAIN-world hook. Never throws. */
  function handleMessage(d) {
    try {
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') return false;
      if (d.source !== undefined && d.source !== 'cma-hook') return false;
      const t = typeof d.t === 'number' && d.t > 0 ? d.t : Date.now();
      let handled = true;
      if (d.type === 'pong') {
        state.hooked = true;
        log('hook', { note: 'hook answered ping' });
      } else if (d.type === 'gwt') {
        state.gwt = { strongName: d.strongName || null, moduleBase: d.moduleBase || null };
        if (!state.permutation) applyPermutation(d.strongName, 'gwt');
        if (!state.moduleBase && typeof d.moduleBase === 'string' && d.moduleBase && sameOriginUrl(d.moduleBase)) state.moduleBase = d.moduleBase;
        log('gwt', { strongName: d.strongName, moduleBase: d.moduleBase });
      } else if (d.type === 'xhr') {
        const url = typeof d.url === 'string' ? d.url : '';
        const m = RPC_RE.exec(url);
        if (!sameOriginUrl(url)) { state.ignoredForeign++; handled = false; }   // SPEC 0: another host's traffic is not ours
        else if (m) handleRpc(d, m[1], t);
        else if (V3_RE.test(url)) handleRest(d, t);
        else handled = false;
      } else {
        handled = false;
      }
      if (handled) {
        maybeRebuildRegistry();     // permutation + module base may only now both be known (SPEC 3.5)
        emitState();
      }
      return handled;
    } catch (e) {
      try { log('error', { note: 'capture error: ' + (e && e.message ? e.message : String(e)) }); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // DOM fallbacks (SPEC 2.1 / 2.3)
  // ------------------------------------------------------------------------------------------------
  function probeDom(doc) {
    const out = { permutation: null, moduleBase: null, groups: null, changed: false };
    const D = doc || (typeof document !== 'undefined' ? document : null);
    if (!D || typeof D.querySelectorAll !== 'function') return out;
    try {
      const scripts = D.querySelectorAll('script[src*=".cache.js"]');
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].getAttribute('src') || scripts[i].src || '';
        let abs = src;
        try { abs = new URL(src, D.baseURI || (D.location && D.location.href) || 'https://cronometer.com/').href; } catch (e) { abs = src; }
        const m = CACHE_JS_RE.exec(abs);
        if (!m) continue;
        out.permutation = m[2].toUpperCase();
        out.moduleBase = m[1];
        if (!state.permutation) { applyPermutation(out.permutation, 'dom'); out.changed = true; }
        if (!state.moduleBase && /^https?:\/\//.test(out.moduleBase) && sameOriginUrl(out.moduleBase)) { state.moduleBase = out.moduleBase; out.changed = true; }
        break;
      }
    } catch (e) { log('warn', { note: 'script probe failed: ' + e.message }); }
    try {
      if (state.groupsSource !== 'authenticate') {
        const els = D.querySelectorAll('.diary-group-title');
        const titles = [];
        for (let i = 0; i < els.length; i++) {
          const t = String(els[i].textContent || '').split('\n')[0].trim();
          if (t) titles.push(t);
        }
        if (titles.length) {
          const groups = groupsFromTitles(titles);
          out.groups = groups;
          const before = JSON.stringify(state.groups);
          if (before !== JSON.stringify(groups) || state.groupsSource !== 'dom') {
            state.groups = groups;
            state.groupsSource = 'dom';
            out.changed = true;
            log('groups', { source: 'dom', titles: titles });
          }
        }
      }
    } catch (e) { log('warn', { note: 'group probe failed: ' + e.message }); }
    if (out.changed) maybeRebuildRegistry();   // the probe may be the first source of the permutation / module base
    if (out.changed) emitState();
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // readiness / session / diagnostics
  // ------------------------------------------------------------------------------------------------
  function ready() {
    const missing = [];
    if (!state.hooked) missing.push('hooked');
    if (!state.nonce) missing.push('nonce');
    if (!isPosInt(state.userId)) missing.push('userId');
    if (!state.permutation) missing.push('permutation');
    if (!state.policyHash) missing.push('policyHash');
    if (!state.moduleBase) missing.push('moduleBase');
    return { ok: missing.length === 0, missing: missing };
  }
  function session() {
    return { moduleBase: state.moduleBase, permutation: state.permutation, policyHash: state.policyHash, nonce: state.nonce, userId: state.userId };
  }
  /** snapshot() -> a JSON-safe copy of the state WITHOUT the nonce (for the diagnostics view / clipboard). */
  function snapshot() {
    const s = {};
    Object.keys(state).forEach(function (k) {
      if (k === 'nonce') { s.nonce = state.nonce ? '<redacted ' + state.nonce.length + ' chars>' : null; return; }
      if (k === 'log') { s.log = state.log.slice(); return; }
      s[k] = redactValue(state[k]);
    });
    s.ready = ready();
    return JSON.parse(JSON.stringify(s));
  }
  /** waitFor(pred, {timeout=5000}) -> Promise resolving with the first 'rpc' or 'rest' event pred(ev) accepts. */
  function waitFor(pred, opts) {
    const timeout = opts && typeof opts.timeout === 'number' ? opts.timeout : 5000;
    const label = (opts && opts.label) || 'a matching request';
    return new Promise(function (resolve, reject) {
      let done = false;
      const offs = [];
      function finish(err, ev) {
        if (done) return;
        done = true;
        offs.forEach(function (f) { f(); });
        clearTimeout(timer);
        if (err) reject(err); else resolve(ev);
      }
      function check(ev) {
        let hit = false;
        try { hit = !!pred(ev); } catch (e) { finish(e); return; }
        if (hit) finish(null, ev);
      }
      offs.push(CMA.events.on('rpc', check));
      offs.push(CMA.events.on('rest', check));
      const timer = setTimeout(function () {
        const e = new Error('Timed out after ' + timeout + ' ms waiting for ' + label);
        e.timeout = true;
        finish(e);
      }, timeout);
    });
  }
  function reset() {
    const fresh = freshState();
    Object.keys(state).forEach(function (k) { delete state[k]; });
    Object.keys(fresh).forEach(function (k) { state[k] = fresh[k]; });
    seenNonces.clear();
    rebuildTriggered.clear();
    lastAuthenticate = null;
    emitState();
    return state;
  }

  CMA.capture = {
    state, handleMessage, ready, session, probeDom, waitFor, log, redact, snapshot, reset,
    decodeGroups, groupsFromTitles, userIdFromUrl, extractUserId, defaultGroups, today,
    sameOriginUrl, pageOrigin: function () { return pageOrigin; },
    /** Tests only (opaque file: pages): the origin same-origin checks compare against. */
    setPageOrigin: function (o) { pageOrigin = String(o); },
    DEFAULT_GROUP_NAMES, USER_ID_PARAM, LOG_MAX,
  };
})();
