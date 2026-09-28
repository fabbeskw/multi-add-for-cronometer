/* tdee-data.js - Adaptive TDEE data layer: per-day intake, weight and Cronometer "burned" read through the web app's
 * own read RPCs, cached per account in chrome.storage.local, assembled into the engine's input (CMA.tdee).
 *
 * Evidence: research tdee-recipe-digest.md (DATA-LAYER RECIPE 0-10), tdee-critic.md (row layout, preferences, range
 * ends, write RPCs), tdee-weight-history.md, tdee-intake-burned.md; vendor/adaptive-tdee/ADAPTIVE_TDEE_SPEC.md 2, 5.
 *
 * CMA.tdeeData = {
 *   init() -> Promise<status>     loads the CURRENT account's records (capture userId); another account's are ignored
 *   status(), diagnostics()       diagnostics = counts and date ranges only (never a weight or an intake)
 *   enable() -> Promise<status>   consent: nothing is fetched before it; runs the first full sync (backfill)
 *   disable({forget}) -> Promise  stops syncing; forget:true removes every cmaTdee* key
 *   sync({full, force}) -> Promise<status>   full = whole span, else the 14-day delta (at most every 10 min unless
 *                                 force; a full sync instead when the last one is older than 7 days); single-flight
 *   dayList(), records({modelStartDate}), setOverride(date, true|false|null), getSettings(), saveSettings(partial),
 *   checkins(), recordCheckin(entry), importCsv('nutrition'|'biometrics', text), probe(), today()
 * }
 * Settings = the shared contract's fields plus nudges {weighIn?, partial?: 'YYYY-MM-DD'} (the view's dismissed
 * nudges); a stored check-in also keeps the view's previousTargetKcal and goalChanged.
 * CMA.events 'tdee-data' {type:'status'|'data'|'error', status} follows every change. Listens to 'rpc' (the app's
 * writes, setUserPreference), 'diary-write' {method, ok, days} (the extension's own writes), 'state', 'registry', and
 * to chrome.storage.onChanged: every open Cronometer tab runs its own copy of this layer over ONE storage, so a Disable
 * or "Delete TDEE data" in another tab stops this one at once, and another tab's check-ins, settings, day decisions
 * and days are adopted instead of being overwritten from this tab's memory.
 *
 * Rules: no request before enable() and none while CMA.capture.ready() fails, the decoder mismatches the live build,
 * a decoder rebuild runs or the registry lacks the TDEE types (registry-builder checkOptional 'tdee'). Calls are
 * sequential, >= 250 ms apart; Throttled backs off once, Session aborts. Dates are diary-local: today =
 * CMA.capture.today() (never capture.state.diaryDate, the VIEWED day) and ISO text is built from Day parts. The
 * nonce is never stored or logged; logs carry counts and date ranges only.
 * Storage (each value {userId, ...}): cmaTdeeDays {days: {iso: {i, w, b, bp:[bmr, activity, exercise, tef], c, lf,
 * s, cs?, f}}} (i = row[0] consumed kcal, w = first weigh-in kg, b = burned at fetch time, c = complete, lf =
 * loggedFood, s = 'rpc'|'csv', cs = the fields a CSV file supplied, f = fetchedAt), cmaTdeeSync, cmaTdeeOverrides
 * {days: {iso: true|false}}, cmaTdeeSettings, cmaTdeeCheckins {checkins: [...]} (<= 260).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ------------------------------------------------------------------------------------------------
  // constants
  // ------------------------------------------------------------------------------------------------
  const KEYS = { DAYS: 'cmaTdeeDays', SYNC: 'cmaTdeeSync', OVERRIDES: 'cmaTdeeOverrides', SETTINGS: 'cmaTdeeSettings', CHECKINS: 'cmaTdeeCheckins' };
  const ALL_KEYS = [KEYS.DAYS, KEYS.SYNC, KEYS.OVERRIDES, KEYS.SETTINGS, KEYS.CHECKINS];
  // Bump when the meaning of a stored energy row changes (a live-verified correction of research/tdee-critic.md 1):
  // stored days fetched with another version are refetched by the next (then forced) full sync.
  const ROW_LAYOUT_VERSION = 1;
  const ENERGY_CHUNK_START = 92;       // the app never asks for more than 56 days; larger windows are probed
  const ENERGY_CHUNK_MIN = 28;         // halve on //EX or a row count != span, never below this
  const CALENDAR_CHUNK = 42;           // the diary calendar asks for its ~6-week grid
  const DELTA_DAYS = 14;               // backdated edits and device syncs (no client RPC) land in recent days
  const DELTA_MIN_INTERVAL_MS = 10 * 60 * 1000;
  const FULL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const HISTORY_MAX_DAYS = 1826;       // 5 years: storage and latency bound for every window
  const FIRST_DAY_FALLBACK_DAYS = 548; // 18 months when getFirstDayWithData gives nothing
  const PRE_WEIGH_IN_DAYS = 14;        // energy history before the first weigh-in (partial-day heuristic)
  const NO_WEIGH_IN_DAYS = 28;         // energy history kept while there is no weigh-in yet
  const SPACING_MS = 250;
  // A meal logged item by item is one refetch, not one per item: every app write re-arms this timer. Today's own food
  // never reaches the model (today's intake is null), so nothing waits on it.
  const DIRTY_DEBOUNCE_MS = 30000;
  const STORAGE_TIMEOUT_MS = 5000;
  const MAX_CHECKINS = 260;
  const MAX_UNAVAILABLE_STREAK = 3;    // consecutive energy chunks refused at the minimum size end the phase
  const MAX_PROBE_ROWS_DAYS = 21;      // raw rows kept in memory (probe) for this many recent days
  // spec 2.3 partial-day rule: a logged day under 50 % of the median of the previous 14 logged days, excluded "until
  // the user confirms". Needs 7 of them within 60 calendar days (a median from a long gap is stale). Only days that
  // count as fully logged feed later medians: a flagged day stays out until the user confirms it ('Yes, I ate little'
  // = override false), so a run of under-logged days never lowers the median by itself and is never passed to the
  // engine unconfirmed; a deliberate new cut is flagged until about a week of it is confirmed. User-excluded days
  // never count.
  const PARTIAL = { WINDOW: 14, MIN_HISTORY: 7, LOOKBACK_DAYS: 60, FRACTION: 0.5 };
  // The app's own writes that change a day's intake / weight / burned / complete flag (research/tdee-critic.md 4).
  const WRITE_METHODS = {
    updateDiary: 1, editDiaryEntries: 1, editServing: 1, removeServing: 1, clearDay: 1, copyDay: 1, logRepeatItemsForDay: 1,
    addBiometric: 1, editBiometric: 1, removeMeasurement: 1, addExercise: 1, editExercise: 1, removeExercise: 1, setDayComplete: 1,
  };
  const PREF_KEYS = { tef: 'use.thermic.effect.food', unitsCalories: 'units.calories', weightUnit: 'weightUnit' };
  // Preferences the server's BMR / activity rows depend on (the dashboard card re-renders on them): full energy resync.
  const PROFILE_PREF_KEYS = { bmr: 1, 'calories.activity': 1, 'calories.activity.custom': 1, weightInKG: 1, heightInCM: 1 };
  const WEIGHT_UNITS = ['Kilograms', 'Pounds', 'Stone'];   // WeightUnit enum names; the app's default is Pounds
  const TRANSIENT_BLOCKS = { 'no-account': 1, loading: 1, 'capture-not-ready': 1, 'decoder-mismatch': 1, 'decoder-rebuilding': 1 };
  const DAY_PREFIX = 'com.cronometer.shared.entries.models.Day/';
  const DEFAULT_SETTINGS = Object.freeze({
    goal: Object.freeze({ ratePctPerWeek: 0 }), sex: 'other', checkInWeekday: 1, responsiveness: 'balanced',
    manualInitialKcal: null, proteinGPerKg: 1.8, fatShare: 0.35, activityAware: false,
    units: Object.freeze({ weight: 'auto', energy: 'auto' }), modelStartDate: null, trustCompleteOnly: false, goalChangedAt: null,
    // the view's dismissed data-quality nudges: {weighIn?, partial?: 'YYYY-MM-DD'} = hidden until that check-in week
    nudges: Object.freeze({}),
  });

  // ------------------------------------------------------------------------------------------------
  // injectable environment (tests replace it through _test.configure)
  // ------------------------------------------------------------------------------------------------
  const DEFAULT_DEPS = {
    now: function () { return Date.now(); },
    today: function () { return localTodayIso(); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    setTimer: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimer: function (t) { clearTimeout(t); },
    spacingMs: SPACING_MS,
    debounceMs: DIRTY_DEBOUNCE_MS,
  };
  let deps = Object.assign({}, DEFAULT_DEPS);

  // ------------------------------------------------------------------------------------------------
  // dates: ISO 'YYYY-MM-DD' built from Day parts; arithmetic through the engine's addDays/daysBetween (pure UTC
  // calendar maths on ISO strings), with an identical local fallback when the engine is not loaded
  // ------------------------------------------------------------------------------------------------
  const DAY_MS = 86400000;
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoOfParts(d) {
    if (!d || typeof d !== 'object') return null;
    const day = Number(d.day), month = Number(d.month), year = Number(d.year);
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) || day < 1 || day > 31 || month < 1 || month > 12 || year < 1) return null;
    return String(year).padStart(4, '0') + '-' + pad2(month) + '-' + pad2(day);
  }
  function utcOf(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  function isoOfUtc(ms) { const x = new Date(ms); return String(x.getUTCFullYear()).padStart(4, '0') + '-' + pad2(x.getUTCMonth() + 1) + '-' + pad2(x.getUTCDate()); }
  function addDays(iso, n) {
    const t = CMA.tdee;
    return t && typeof t.addDays === 'function' ? t.addDays(iso, n) : isoOfUtc(utcOf(iso) + n * DAY_MS);
  }
  function daysBetween(a, b) {
    const t = CMA.tdee;
    return t && typeof t.daysBetween === 'function' ? t.daysBetween(a, b) : Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
  }
  function isIso(s) { return typeof s === 'string' && ISO_RE.test(s) && isoOfUtc(utcOf(s)) === s; }
  function minIso(a, b) { return a <= b ? a : b; }
  function maxIso(a, b) { return a >= b ? a : b; }
  function localTodayIso() {
    let d = null;
    try { if (CMA.capture && typeof CMA.capture.today === 'function') d = CMA.capture.today(); } catch (e) { d = null; }
    if (!d) { const x = new Date(); d = { day: x.getDate(), month: x.getMonth() + 1, year: x.getFullYear() }; }
    return isoOfParts(d);
  }
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ------------------------------------------------------------------------------------------------
  // memory: ONE account at a time
  // ------------------------------------------------------------------------------------------------
  // lastError = a sync that failed (or storage that could not be read); notes = what the last SUCCESSFUL sync could not
  // read (a refused preference, calendar or energy window): information, not a failure
  function freshSync() {
    return { enabled: false, enabledAt: null, firstDay: null, lastFullAt: null, lastDeltaAt: null, energyChunk: null,
      flagsSource: null, prefs: null, rowLayoutVersion: null, lastError: null, notes: null, energyUnavailable: [] };
  }
  // unsaved: day windows changed in memory and not written to cmaTdeeDays yet (kept over another tab's write)
  const mem = { userId: null, loaded: false, loading: null, days: {}, sync: freshSync(), overrides: {}, settings: null, checkins: [], storage: null, ignored: 0, unsaved: [] };
  const run = {
    gen: 0, running: null, runningJob: null, runningGen: -1, pending: null, pendingPromise: null, phase: 'idle', progress: { done: 0, total: 0 },
    lastCallEnd: 0, dirty: new Set(), dirtyTimer: null, energySpanPending: false, prefsPending: false, blockedRetry: null,
    lastRows: new Map(), layoutCache: { registry: null, result: null }, lastBlocked: null, foreignWhileLoading: null,
  };
  function resetMemory(userId) {
    mem.userId = userId; mem.loaded = false; mem.loading = null; mem.days = {}; mem.sync = freshSync(); mem.overrides = {};
    mem.settings = null; mem.checkins = []; mem.storage = null; mem.ignored = 0; mem.unsaved = [];
    run.lastRows.clear(); run.foreignWhileLoading = null;
  }
  /** Drop everything scheduled or running for the previous account / consent state. */
  function cancelWork() {
    run.gen++;
    if (run.dirtyTimer) { try { deps.clearTimer(run.dirtyTimer); } catch (e) { /* ignore */ } }
    run.dirtyTimer = null; run.dirty.clear(); run.energySpanPending = false; run.prefsPending = false;
    run.pending = null; run.blockedRetry = null;
    run.phase = 'idle'; run.progress = { done: 0, total: 0 };
  }
  function currentUserId() {
    const c = CMA.capture;
    const uid = c && c.state ? c.state.userId : null;
    return Number.isInteger(uid) && uid > 0 ? uid : null;
  }

  // ------------------------------------------------------------------------------------------------
  // chrome.storage.local (guarded like registry-store.js; every write bounded by STORAGE_TIMEOUT_MS)
  // ------------------------------------------------------------------------------------------------
  function storage() {
    try { return typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
    catch (e) { return null; }
  }
  function lastError() {
    try { const e = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError; return e ? String(e.message || e) : null; }
    catch (e) { return null; }
  }
  function bounded(start) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(function () { finish({ ok: false, value: {}, error: 'timed out' }); }, STORAGE_TIMEOUT_MS);
      try { start(finish); } catch (e) { finish({ ok: false, value: {}, error: String(e && e.message || e) }); }
    });
  }
  function storageGet(keys) {
    const s = storage();
    if (!s) return Promise.resolve({ ok: false, value: {}, error: 'no chrome.storage', none: true });
    return bounded(function (finish) {
      const r = s.get(keys, function (v) { const err = lastError(); finish(err ? { ok: false, value: {}, error: err } : { ok: true, value: v && typeof v === 'object' ? v : {} }); });
      if (r && typeof r.then === 'function') r.then(function (v) { finish({ ok: true, value: v && typeof v === 'object' ? v : {} }); }, function (e) { finish({ ok: false, value: {}, error: String(e && e.message || e) }); });
    });
  }
  function storageSet(obj) {
    const s = storage();
    if (!s) return Promise.resolve(false);
    return bounded(function (finish) {
      const r = s.set(obj, function () { finish(!lastError()); });
      if (r && typeof r.then === 'function') r.then(function () { finish(true); }, function () { finish(false); });
    }).then(function (v) { return v === true; });
  }
  function storageRemove(keys) {
    const s = storage();
    if (!s || typeof s.remove !== 'function') return Promise.resolve(false);
    return bounded(function (finish) {
      const r = s.remove(keys, function () { finish(!lastError()); });
      if (r && typeof r.then === 'function') r.then(function () { finish(true); }, function () { finish(false); });
    }).then(function (v) { return v === true; });
  }

  // ------------------------------------------------------------------------------------------------
  // stored shapes
  // ------------------------------------------------------------------------------------------------
  function csvHas(rec, field) { return typeof rec.cs === 'string' && rec.cs.indexOf(field) >= 0; }
  function addCsv(rec, field) { if (!csvHas(rec, field)) rec.cs = (rec.cs || '') + field; rec.s = 'csv'; }
  function dropCsv(rec, field) {
    if (!csvHas(rec, field)) return;
    rec.cs = rec.cs.split(field).join('');
    if (!rec.cs) { delete rec.cs; rec.s = 'rpc'; }
  }
  function ensureDay(iso) {
    let rec = mem.days[iso];
    if (!rec) { rec = { i: null, w: null, b: null, bp: null, c: null, lf: null, s: 'rpc', f: null }; mem.days[iso] = rec; }
    return rec;
  }
  function isEmptyDay(rec) { return !isNum(rec.i) && !isNum(rec.w) && !Array.isArray(rec.bp) && typeof rec.c !== 'boolean' && typeof rec.lf !== 'boolean' && !rec.cs; }
  function unpackDay(o) {
    if (!o || typeof o !== 'object') return null;
    const rec = {
      i: isNum(o.i) ? o.i : null, w: isNum(o.w) && o.w > 0 ? o.w : null, b: isNum(o.b) ? o.b : null,
      bp: Array.isArray(o.bp) && o.bp.length >= 4 && o.bp.slice(0, 4).every(isNum) ? o.bp.slice(0, 4) : null,
      c: typeof o.c === 'boolean' ? o.c : null, lf: typeof o.lf === 'boolean' ? o.lf : null, s: 'rpc', f: isNum(o.f) ? o.f : null,
    };
    if (typeof o.cs === 'string' && /^[iw]{1,2}$/.test(o.cs)) { rec.cs = o.cs; rec.s = 'csv'; }
    return rec;
  }
  function packDays() {
    const out = {};
    Object.keys(mem.days).forEach(function (d) {
      const r = mem.days[d];
      const o = { s: r.cs ? 'csv' : 'rpc' };
      if (isNum(r.i)) o.i = r.i;
      if (isNum(r.w)) o.w = r.w;
      if (isNum(r.b)) o.b = r.b;
      if (Array.isArray(r.bp)) o.bp = r.bp;
      if (typeof r.c === 'boolean') o.c = r.c;
      if (typeof r.lf === 'boolean') o.lf = r.lf;
      if (r.cs) o.cs = r.cs;
      if (isNum(r.f)) o.f = r.f;
      out[d] = o;
    });
    return out;
  }
  /** prefs: tef (false unless read as 'true'); unitsCalories / weightUnit = null while NOT READ (the view then shows kcal
   *  and kg rather than presenting Cronometer's own defaults - kcal, Pounds - as the account's settings); assumed = the
   *  TEF preference has never been read, so TEF is assumed off. */
  function normPrefs(p) {
    if (!p || typeof p !== 'object') return null;
    return { tef: p.tef === true, unitsCalories: typeof p.unitsCalories === 'boolean' ? p.unitsCalories : null,
      weightUnit: WEIGHT_UNITS.indexOf(p.weightUnit) >= 0 ? p.weightUnit : null, at: isNum(p.at) ? p.at : null, assumed: p.assumed === true };
  }
  function unpackSync(o) {
    const s = freshSync();
    s.enabled = o.enabled === true;
    s.enabledAt = isNum(o.enabledAt) ? o.enabledAt : null;
    s.firstDay = isIso(o.firstDay) ? o.firstDay : null;
    s.lastFullAt = isNum(o.lastFullAt) ? o.lastFullAt : null;
    s.lastDeltaAt = isNum(o.lastDeltaAt) ? o.lastDeltaAt : null;
    s.energyChunk = Number.isInteger(o.energyChunk) && o.energyChunk >= ENERGY_CHUNK_MIN && o.energyChunk <= ENERGY_CHUNK_START ? o.energyChunk : null;
    s.flagsSource = o.flagsSource === 'calendar' || o.flagsSource === 'none' ? o.flagsSource : null;
    s.prefs = normPrefs(o.prefs);
    s.rowLayoutVersion = Number.isInteger(o.rowLayoutVersion) ? o.rowLayoutVersion : null;
    s.lastError = typeof o.lastError === 'string' ? o.lastError.slice(0, 300) : null;
    s.notes = typeof o.notes === 'string' ? o.notes.slice(0, 300) : null;
    s.energyUnavailable = Array.isArray(o.energyUnavailable) ? o.energyUnavailable.filter(function (x) { return x && isIso(x.from) && isIso(x.to); }).slice(0, 20) : [];
    return s;
  }
  function packSync() {
    const s = mem.sync;
    return { userId: mem.userId, enabled: s.enabled, enabledAt: s.enabledAt, firstDay: s.firstDay, lastFullAt: s.lastFullAt,
      lastDeltaAt: s.lastDeltaAt, energyChunk: s.energyChunk, flagsSource: s.flagsSource, prefs: s.prefs,
      rowLayoutVersion: s.rowLayoutVersion, lastError: s.lastError, notes: s.notes, energyUnavailable: s.energyUnavailable };
  }
  function normSettings(o) {
    o = o && typeof o === 'object' ? o : {};
    const d = DEFAULT_SETTINGS;
    const goal = o.goal && typeof o.goal === 'object' ? o.goal : {};
    const units = o.units && typeof o.units === 'object' ? o.units : {};
    const pick = function (v, allowed, dflt) { return allowed.indexOf(v) >= 0 ? v : dflt; };
    return {
      goal: { ratePctPerWeek: isNum(goal.ratePctPerWeek) ? goal.ratePctPerWeek : d.goal.ratePctPerWeek },
      sex: pick(o.sex, ['female', 'male', 'other'], d.sex),
      checkInWeekday: Number.isInteger(o.checkInWeekday) && o.checkInWeekday >= 0 && o.checkInWeekday <= 6 ? o.checkInWeekday : d.checkInWeekday,
      responsiveness: pick(o.responsiveness, ['stable', 'balanced', 'responsive'], d.responsiveness),
      manualInitialKcal: isNum(o.manualInitialKcal) && o.manualInitialKcal >= 500 && o.manualInitialKcal <= 10000 ? o.manualInitialKcal : null,
      proteinGPerKg: pick(o.proteinGPerKg, [1.6, 1.8, 2.2], d.proteinGPerKg),
      fatShare: pick(o.fatShare, [0.25, 0.35, 0.5], d.fatShare),
      activityAware: o.activityAware === true,
      units: { weight: pick(units.weight, ['auto', 'kg', 'lb'], 'auto'), energy: pick(units.energy, ['auto', 'kcal', 'kJ'], 'auto') },
      modelStartDate: isIso(o.modelStartDate) ? o.modelStartDate : null,
      trustCompleteOnly: o.trustCompleteOnly === true,
      goalChangedAt: isNum(o.goalChangedAt) ? o.goalChangedAt : null,
      nudges: normNudges(o.nudges),
    };
  }
  /** Dismissed nudges (src/ui/tdee-view.js): a small {name: 'YYYY-MM-DD'} map, at most 8 short names, dates only. */
  function normNudges(n) {
    const out = {};
    if (!n || typeof n !== 'object' || Array.isArray(n)) return out;
    Object.keys(n).slice(0, 8).forEach(function (k) { if (/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(k) && isIso(n[k])) out[k] = n[k]; });
    return out;
  }
  function normCheckin(c, now) {
    c = c && typeof c === 'object' ? c : {};
    const num = function (v) { return isNum(v) ? v : null; };
    const m = c.macros && typeof c.macros === 'object' ? c.macros : null;
    return {
      date: isIso(c.date) ? c.date : null, accepted: c.accepted === true, targetKcal: num(c.targetKcal), expenditureKcal: num(c.expenditureKcal),
      sdKcal: num(c.sdKcal), trendWeightKg: num(c.trendWeightKg), ratePctPerWeek: num(c.ratePctPerWeek),
      macros: m ? { proteinG: num(m.proteinG), fatG: num(m.fatG), carbsG: num(m.carbsG) } : null,
      notes: Array.isArray(c.notes) ? c.notes.filter(function (n) { return typeof n === 'string'; }).slice(0, 10).map(function (n) { return n.slice(0, 300); }) : [],
      at: isNum(c.at) ? c.at : now,
      // recorded by the view beyond the contract: the target this check-in replaced, whether the weekly cap was lifted
      // by a goal change, and the goal rate the user had chosen (ratePctPerWeek is the engine's capped rate): a goal
      // changed and changed back is no goal change
      previousTargetKcal: num(c.previousTargetKcal), goalChanged: c.goalChanged === true, goalRatePctPerWeek: num(c.goalRatePctPerWeek),
    };
  }

  /** Adopt one stored key of the loaded account, REPLACING the memory copy (the load, and another tab's write; a null
   *  value = the key was removed). cmaTdeeDays keeps the windows this tab merged but has not written yet, so a sync
   *  running here never loses what it fetched to another tab's write. */
  function adoptKey(k, v) {
    switch (k) {
      case KEYS.DAYS: {
        const days = {};
        if (v && v.days && typeof v.days === 'object') {
          Object.keys(v.days).forEach(function (d) { if (isIso(d)) { const rec = unpackDay(v.days[d]); if (rec) days[d] = rec; } });
        }
        mem.unsaved.forEach(function (w) {
          eachDay(w.from, w.to, function (d) { if (own(mem.days, d)) days[d] = mem.days[d]; else delete days[d]; });
        });
        mem.days = days;
        break;
      }
      case KEYS.SYNC: mem.sync = v ? unpackSync(v) : freshSync(); break;
      case KEYS.OVERRIDES: {
        const ov = {};
        if (v && v.days && typeof v.days === 'object') {
          Object.keys(v.days).forEach(function (d) { if (isIso(d) && typeof v.days[d] === 'boolean') ov[d] = v.days[d]; });
        }
        mem.overrides = ov;
        break;
      }
      case KEYS.SETTINGS: mem.settings = v ? normSettings(v) : null; break;
      case KEYS.CHECKINS:
        mem.checkins = v && Array.isArray(v.checkins) ? v.checkins.map(function (c) { return normCheckin(c, null); }).filter(function (c) { return c.date; }).slice(-MAX_CHECKINS) : [];
        break;
      default: break;
    }
  }
  /** Adopt what storage holds for `uid`; records of another account (or without one) are ignored and never shown. */
  function adopt(values, uid) {
    const v = values || {};
    ALL_KEYS.forEach(function (k) {
      const rec = v[k];
      if (!rec || typeof rec !== 'object') return;
      if (rec.userId !== uid) { mem.ignored++; return; }
      adoptKey(k, rec);
    });
  }
  function valueFor(key) {
    switch (key) {
      case KEYS.DAYS: return { userId: mem.userId, days: packDays() };
      case KEYS.SYNC: return packSync();
      case KEYS.OVERRIDES: return { userId: mem.userId, days: Object.assign({}, mem.overrides) };
      case KEYS.SETTINGS: return Object.assign({ userId: mem.userId }, getSettings());
      case KEYS.CHECKINS: return { userId: mem.userId, checkins: mem.checkins.slice(-MAX_CHECKINS) };
      default: throw new Error('unknown key ' + key);
    }
  }
  // ---- this tab's own writes, as chrome.storage.onChanged reports them back (see "other tabs" below) ----
  /** Canonical JSON (object keys sorted, recursively): Chrome keeps stored values as base::Value dictionaries and
   *  reports them back with their keys sorted, so plain JSON.stringify would not recognise this tab's own writes. */
  function canon(v) {
    if (v === undefined || v === null) return 'null';
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
        .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  const ECHO_MAX = 16, ECHO_TTL_MS = 30000;   // writes are bounded to 5 s: an echo older than this never comes
  const echoes = {};   // key -> [{ser, at}]: this tab's writes whose onChanged has not arrived yet, oldest first
  const known = {};    // key -> canonical text of what the key holds (or will hold once this tab's writes land)
  // Only while the storage watcher runs: without chrome.storage.onChanged no echo ever comes back, and what the keys
  // hold is simply not known (every write is sent, and the stored consent is checked before each job).
  function expectEcho(k, ser) {
    if (!watching) return;
    const list = echoes[k] || (echoes[k] = []);
    list.push({ ser: ser, at: Date.now() });
    if (list.length > ECHO_MAX) list.shift();
    known[k] = ser;
  }
  function dropEcho(k, ser) {
    const list = echoes[k] || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].ser === ser) { list.splice(i, 1); break; }
    delete known[k];   // the write failed: what the key holds is not known any more
  }
  /** How many of this tab's writes to `k` are still on their way (events arrive in write order). */
  function pendingEchoes(k) {
    const list = echoes[k];
    if (!list) return 0;
    const now = Date.now();
    while (list.length && now - list[0].at > ECHO_TTL_MS) list.shift();
    return list.length;
  }
  /** true = this change is this tab's own write coming back; it and every older pending write of `k` are settled. */
  function isEcho(k, ser) {
    if (!pendingEchoes(k)) return false;
    const list = echoes[k];
    for (let i = 0; i < list.length; i++) if (list[i].ser === ser) { list.splice(0, i + 1); return true; }
    return false;
  }
  /** A window this tab changed in memory and has not written yet (bounded: many windows collapse into one). */
  function markUnsaved(from, to) {
    if (from > to) return;
    mem.unsaved.push({ from: from, to: to });
    if (mem.unsaved.length > 64) {
      const all = mem.unsaved;
      mem.unsaved = [{ from: all.reduce(function (m, w) { return minIso(m, w.from); }, all[0].from), to: all.reduce(function (m, w) { return maxIso(m, w.to); }, all[0].to) }];
    }
  }
  /** Write `keys` for the loaded account. `gen` (optional): skipped when the work it belongs to was cancelled. The
   *  payload is built and handed to chrome.storage synchronously, so a disable()/account switch that starts later
   *  (its removal is queued after this write) always wins. A key that already holds exactly this value is not
   *  written again (so every write this tab makes changes the value and comes back as exactly one storage event). */
  function persist(keys, gen) {
    if (!mem.loaded || !mem.userId) return Promise.resolve(false);
    if (typeof mem.storage === 'string' && mem.storage.indexOf('read failed') === 0) return Promise.resolve(false);   // never overwrite what could not be read
    if (gen !== undefined && gen !== run.gen) return Promise.resolve(false);
    if (keys.indexOf(KEYS.DAYS) >= 0) mem.unsaved = [];   // the payload below carries them
    if (!storage()) return Promise.resolve(false);
    const obj = {}, sers = {};
    keys.forEach(function (k) {
      const v = valueFor(k), ser = watching ? canon(v) : null;
      if (watching && ser === known[k]) return;
      obj[k] = v; sers[k] = ser;
    });
    const ks = Object.keys(obj);
    if (!ks.length) return Promise.resolve(true);
    ks.forEach(function (k) { expectEcho(k, sers[k]); });
    return storageSet(obj).then(function (okv) {
      if (!okv) {
        ks.forEach(function (k) { dropEcho(k, sers[k]); });
        if (!mem.storage) mem.storage = 'write failed';
      }
      return okv;
    });
  }

  // ------------------------------------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------------------------------------
  function emit(type, extra) {
    try {
      const ev = CMA.events;
      if (!ev || (typeof ev.count === 'function' && ev.count('tdee-data') === 0)) return;
      ev.emit('tdee-data', Object.assign({ type: type, status: status() }, extra || {}));
    } catch (e) { /* ignore */ }
  }
  function log(note) {
    try { if (CMA.capture && typeof CMA.capture.log === 'function') CMA.capture.log('tdee', { note: note }); } catch (e) { /* ignore */ }
  }
  function redact(s) {
    try { if (CMA.capture && typeof CMA.capture.redact === 'function') return CMA.capture.redact(s); } catch (e) { /* ignore */ }
    return s;
  }
  function shortName(sig) { const base = String(sig || '').split('/')[0]; return base.slice(base.lastIndexOf('.') + 1); }
  /** A user-facing error text that can never carry a value from a reply (no body snippets, no decimals). */
  function errorText(e) {
    if (!e) return 'unknown error';
    let t;
    switch (e.kind) {
      case 'session': t = 'not logged in any more: reload the Cronometer tab and log in'; break;
      case 'throttled': t = 'Cronometer asked for fewer requests (throttled): try again in a few minutes'; break;
      case 'network': t = 'network error' + (e.timeout ? ' (timed out)' : ''); break;
      case 'incompatible': t = 'the decoder does not match this Cronometer build (rebuild it from Diagnostics)'; break;
      case 'decode': t = 'a reply could not be read'; break;
      case 'http': t = 'HTTP ' + (isNum(e.status) ? e.status : '?'); break;
      case 'rpc': t = 'server exception ' + (shortName(e.exceptionType) || 'unknown'); break;
      case 'cancelled': t = 'cancelled'; break;
      default: t = String((e && e.message) || e).replace(/-?\d+\.\d+/g, '#').slice(0, 160);
    }
    if (e.method) t += ' (' + String(e.method).slice(0, 60) + ')';
    return redact(t);
  }

  // ------------------------------------------------------------------------------------------------
  // gating
  // ------------------------------------------------------------------------------------------------
  function layoutCheck() {
    const RB = CMA.registryBuilder, reg = CMA.registry;
    if (!RB || typeof RB.checkOptional !== 'function' || !reg) return { ok: true, skipped: true, problems: [] };
    if (run.layoutCache.registry === reg && run.layoutCache.result) return run.layoutCache.result;
    let res;
    try { res = RB.checkOptional(reg, 'tdee'); } catch (e) { res = { ok: false, problems: [String(e && e.message || e)] }; }
    run.layoutCache = { registry: reg, result: res };
    return res;
  }
  /** null when a sync may run now, else {code, text}. Never has side effects. */
  function gate() {
    const uid = currentUserId();
    if (!uid) return { code: 'no-account', text: 'The Cronometer account is not known yet: reload the Cronometer tab so the extension can see the app start.' };
    if (mem.userId !== uid || !mem.loaded) return { code: 'loading', text: 'Loading the stored TDEE data...' };
    if (!mem.sync.enabled) return { code: 'not-enabled', text: 'Reading your Cronometer history is off: turn it on to start.' };
    const cap = CMA.capture;
    let r = null;
    try { r = cap && typeof cap.ready === 'function' ? cap.ready() : null; } catch (e) { r = null; }
    if (!r || !r.ok) return { code: 'capture-not-ready', text: 'Reload the Cronometer tab so the extension can see the app start' + (r && r.missing && r.missing.length ? ' (missing: ' + r.missing.join(', ') + ')' : '') + '.' };
    if (cap.state && cap.state.registryMismatch) return { code: 'decoder-mismatch', text: 'Cronometer deployed a new build: TDEE data is unavailable until the decoder is rebuilt (see Diagnostics).' };
    const rs = CMA.registryStore;
    try { if (rs && typeof rs.inFlight === 'function' && rs.inFlight()) return { code: 'decoder-rebuilding', text: 'Waiting for the decoder rebuild...' }; } catch (e) { /* ignore */ }
    const R = CMA.rpc;
    if (!R || typeof R.getCaloriesConsumedAndBurned !== 'function' || typeof R.getBiometrics !== 'function' || typeof R.getCalendarInfo !== 'function'
      || typeof R.getFirstDayWithData !== 'function' || typeof R.getPreference !== 'function') {
      return { code: 'rpc-missing', text: 'TDEE sync unavailable: the RPC client of this extension version lacks the TDEE reads.' };
    }
    const lay = layoutCheck();
    if (!lay.ok) return { code: 'layouts', text: 'TDEE sync unavailable: this Cronometer build changed the data the TDEE view reads (' + String(lay.problems[0] || 'unknown') + ').' };
    return null;
  }

  // ------------------------------------------------------------------------------------------------
  // jobs: {kind, prefs, firstDay, bio: null | {all} | {from}, energy / calendar: null | {span, from}}
  // ------------------------------------------------------------------------------------------------
  function jobFull() { return { kind: 'full', prefs: true, firstDay: true, bio: { all: true }, energy: { span: true, from: null }, calendar: { span: true, from: null } }; }
  function jobWindow(kind, from) { return { kind: kind, delta: kind === 'delta', prefs: false, firstDay: false, bio: { from: from }, energy: { span: false, from: from }, calendar: { span: false, from: from } }; }
  function mergeRange(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    if (a.all || b.all) return { all: true };
    const from = a.from && b.from ? minIso(a.from, b.from) : (a.from || b.from || null);
    const out = { from: from };
    if (own(a, 'span') || own(b, 'span')) out.span = !!(a.span || b.span);
    return out;
  }
  function mergeJobs(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.kind === 'full' || b.kind === 'full') return jobFull();
    return { kind: a.kind === b.kind ? a.kind : 'mixed', delta: !!(a.delta || b.delta), prefs: !!(a.prefs || b.prefs), firstDay: false,
      bio: mergeRange(a.bio, b.bio), energy: mergeRange(a.energy, b.energy), calendar: mergeRange(a.calendar, b.calendar) };
  }
  /** A running job that makes `job` redundant: a delta (view open) while a full sync or another delta runs. Edits
   *  (dirty windows) are never dropped: the running job may have read that day before the edit. */
  function covers(running, job) {
    return !!running && job.kind === 'delta' && (running.kind === 'full' || running.kind === 'delta');
  }
  /** The running job, unless it was cancelled (account switch, disable): a cancelled job makes no further call or
   *  merge after its current await, so new work never waits for it or is served by it. */
  function liveRunning() { return run.running && run.runningGen === run.gen ? run.running : null; }
  function enqueue(job) {
    if (!liveRunning()) return start(job);
    if (covers(run.runningJob, job)) return run.running;
    run.pending = mergeJobs(run.pending, job);
    if (!run.pendingPromise) {
      run.pendingPromise = run.running.then(function () {
        const next = run.pending;
        run.pending = null;
        run.pendingPromise = null;
        if (!next) return status();
        const g = gate();
        if (g) {
          if (TRANSIENT_BLOCKS[g.code] && mem.sync.enabled) run.blockedRetry = mergeJobs(run.blockedRetry, next);
          return status();
        }
        return liveRunning() ? enqueue(next) : start(next);
      });
    }
    return run.pendingPromise;
  }
  function start(job) {
    const gen = run.gen;
    run.runningJob = job;
    run.runningGen = gen;
    const p = (async function () {
      try { await execute(job, gen); } finally {
        if (run.running === p) { run.running = null; run.runningJob = null; }
      }
      return status();
    })();
    run.running = p;
    return p;
  }
  function maybeRetryBlocked() {
    if (!run.blockedRetry || liveRunning()) return;
    const g = gate();
    if (!g) { const job = run.blockedRetry; run.blockedRetry = null; enqueue(job).catch(function () { /* reported through status */ }); }
    else if (!TRANSIENT_BLOCKS[g.code]) run.blockedRetry = null;
  }

  // ------------------------------------------------------------------------------------------------
  // one RPC under the sync policy
  // ------------------------------------------------------------------------------------------------
  function Abort(kind, cause) {
    const e = new Error(kind === 'cancelled' || kind === 'blocked' ? kind : errorText(cause || { kind: kind }));
    e.abort = true; e.kind = kind; e.cause = cause || null;
    return e;
  }
  function alive(ctx) { if (ctx.gen !== run.gen) throw Abort('cancelled'); }
  function backoffMs() { const t = CMA.rpc && CMA.rpc.throttle; return t && isNum(t.backoffMs) ? t.backoffMs : 5000; }
  /** -> {ok:true, value} | {ok:false, kind, error} for a refusal the phase handles (//EX 'rpc', 'http', 'decode');
   *  throws Abort for session / incompatible / a repeated throttle or network failure / cancellation. fn(session)
   *  gets a fresh CMA.capture.session() per attempt: the app may rotate the nonce (reauthenticate) mid-sync. */
  async function rpcCall(ctx, fn) {
    let retried = false;
    for (;;) {
      alive(ctx);
      const wait = run.lastCallEnd + deps.spacingMs - deps.now();
      if (wait > 0) await deps.sleep(wait);
      alive(ctx);
      // the gate again before EVERY call: a deploy noticed mid-sync (decoder mismatch) must not have its replies
      // decoded with the stale registry, and a lost session stops the job (it resumes when the block clears)
      const g = gate();
      if (g) { const b = Abort('blocked'); b.block = g; throw b; }
      const session = CMA.capture.session();
      if (!session || session.userId !== ctx.uid) throw Abort('cancelled');   // another account: nothing of it is merged
      let value, err = null;
      try { value = await fn(session); } catch (e) { err = e || new Error('failed'); }
      run.lastCallEnd = deps.now();
      run.progress.done++;
      alive(ctx);
      const g2 = gate();                               // a reply that arrived after a block appeared is not used
      if (g2) { const b = Abort('blocked'); b.block = g2; throw b; }
      emit('status');
      if (!err) return { ok: true, value: value };
      const kind = err.kind;
      if (kind === 'session') throw Abort('session', err);
      if (kind === 'incompatible') throw Abort('incompatible', err);
      const network = kind === 'network' || (!kind && CMA.errors && typeof CMA.errors.isNetwork === 'function' && CMA.errors.isNetwork(err));
      if (kind === 'throttled' || network) {
        if (!retried) {
          retried = true;
          run.progress.total++;
          if (kind === 'throttled') await deps.sleep(backoffMs());
          continue;
        }
        throw Abort(kind === 'throttled' ? 'throttled' : 'network', err);
      }
      return { ok: false, kind: kind || 'error', error: err };
    }
  }

  // ------------------------------------------------------------------------------------------------
  // merges (a fetched window REPLACES every day inside it; CSV values survive only where the RPC returned nothing)
  // ------------------------------------------------------------------------------------------------
  /** burned = BMR + activity (row[9] + row[10]) + |exercise (row[1], negative on the wire)| + TEF (row[4]) only when
   *  the account's use.thermic.effect.food is 'true' - exactly the dashboard's 'Burned' stack (tdee-critic.md 1).
   *  Never row[1] alone. null when not a positive finite number. */
  function burnedFromParts(bp, tef) {
    if (!Array.isArray(bp) || bp.length < 4) return null;
    const b = bp[0] + bp[1] + bp[2] + (tef ? bp[3] : 0);
    return Number.isFinite(b) && b > 0 ? b : null;
  }
  function partsFromRow(row) {
    const R = (CMA.rpc && CMA.rpc.TDEE_FIELDS && CMA.rpc.TDEE_FIELDS.ENERGY_ROW) || { EXERCISE: 1, BMR: 3, TEF: 4, ACTIVITY_A: 9, ACTIVITY_B: 10 };
    return [row[R.BMR], row[R.ACTIVITY_A] + row[R.ACTIVITY_B], Math.abs(row[R.EXERCISE]), row[R.TEF]];
  }
  function burnedFromRow(row, tef) { return Array.isArray(row) ? burnedFromParts(partsFromRow(row), tef) : null; }
  function prefTef() { return !!(mem.sync.prefs && mem.sync.prefs.tef); }
  function eachDay(from, to, fn) { for (let d = from, i = 0; d <= to; d = addDays(d, 1), i++) fn(d, i); }

  function mergeEnergy(from, to, rows, now) {
    const tef = prefTef();
    const keepFrom = addDays(deps.today(), -MAX_PROBE_ROWS_DAYS);
    markUnsaved(from, to);
    eachDay(from, to, function (d, i) {
      const row = rows[i];
      const rec = ensureDay(d);
      const consumed = row[0];
      if (!(csvHas(rec, 'i') && !(consumed > 0))) { rec.i = consumed; dropCsv(rec, 'i'); }
      rec.bp = partsFromRow(row);
      rec.b = burnedFromParts(rec.bp, tef);
      rec.f = now;
      if (d >= keepFrom) run.lastRows.set(d, row.slice(0, 12));
    });
    run.lastRows.forEach(function (_, d) { if (d < keepFrom) run.lastRows.delete(d); });
  }
  function mergeCalendar(from, to, items) {
    markUnsaved(from, to);
    const byDate = new Map();
    items.forEach(function (x) { byDate.set(x.date, x); });
    eachDay(from, to, function (d) {
      const it = byDate.get(d) || null;
      const rec = mem.days[d] || (it && (it.loggedFood || it.complete) ? ensureDay(d) : null);
      if (!rec) return;
      rec.c = it ? it.complete === true : false;       // absent from the list = nothing logged (the diary calendar's reading)
      rec.lf = it ? it.loggedFood === true : false;
    });
  }
  function clearFlags(from, to) {
    markUnsaved(from, to);
    eachDay(from, to, function (d) { const rec = mem.days[d]; if (rec) { rec.c = null; rec.lf = null; } });
  }
  /** First weigh-in of each day: the smallest Time; untimed points rank after timed ones, stable in wire order. */
  function firstWeighIns(points) {
    const byDay = new Map();
    (points || []).forEach(function (p, idx) {
      if (!p || !isIso(p.date) || !isNum(p.value) || p.value <= 0) return;
      const list = byDay.get(p.date) || [];
      list.push({ p: p, idx: idx });
      byDay.set(p.date, list);
    });
    const key = function (t) { return t ? (Number(t.h) || 0) * 3600 + (Number(t.m) || 0) * 60 + (Number(t.s) || 0) : Infinity; };
    const out = new Map();
    byDay.forEach(function (list, date) {
      list.sort(function (a, b) { const ka = key(a.p.time), kb = key(b.p.time); return ka === kb ? a.idx - b.idx : (ka < kb ? -1 : 1); });
      out.set(date, list[0].p.value);
    });
    return out;
  }
  function mergeWeighIns(from, to, perDay, now) {
    markUnsaved(from, to);
    Object.keys(mem.days).forEach(function (d) {
      if (d < from || d > to || perDay.has(d)) return;
      const rec = mem.days[d];
      if (isNum(rec.w) && !csvHas(rec, 'w')) { rec.w = null; if (isEmptyDay(rec)) delete mem.days[d]; }
    });
    perDay.forEach(function (kg, d) {
      if (d < from || d > to) return;
      const rec = ensureDay(d);
      rec.w = kg; dropCsv(rec, 'w');
      if (!isNum(rec.f)) rec.f = now;
    });
  }
  function firstWeighInDate(floor) {
    let first = null;
    Object.keys(mem.days).forEach(function (d) { if (d >= floor && isNum(mem.days[d].w) && (first === null || d < first)) first = d; });
    return first;
  }
  function energyStart(today) {
    const floor = addDays(today, -HISTORY_MAX_DAYS);
    const firstDay = mem.sync.firstDay ? maxIso(mem.sync.firstDay, floor) : maxIso(addDays(today, -FIRST_DAY_FALLBACK_DAYS), floor);
    const fw = firstWeighInDate(floor);
    const want = fw ? addDays(fw, -PRE_WEIGH_IN_DAYS) : addDays(today, -(NO_WEIGH_IN_DAYS - 1));
    return minIso(maxIso(firstDay, want), today);
  }
  function rangeStart(spec, today) {
    const floor = addDays(today, -HISTORY_MAX_DAYS);
    let from = null;
    if (spec.span) from = energyStart(today);
    if (spec.from) from = from ? minIso(from, spec.from) : spec.from;
    if (!from) from = energyStart(today);
    if (!spec.span && mem.sync.firstDay) from = maxIso(from, mem.sync.firstDay);   // a window never reaches before the account
    return minIso(maxIso(from, floor), today);
  }

  /** Days older than the 5-year window are never read again: a full sync drops the ones that came from Cronometer, so
   *  storage, every whole-key write and each recompute stay bounded (a CSV import is the user's own file and stays). */
  function pruneOld(today) {
    const floor = addDays(today, -HISTORY_MAX_DAYS);
    let n = 0;
    Object.keys(mem.days).forEach(function (d) { if (d < floor && !mem.days[d].cs) { delete mem.days[d]; n++; } });
    return n;
  }

  // ------------------------------------------------------------------------------------------------
  // phases
  // ------------------------------------------------------------------------------------------------
  function setPhase(p) { run.phase = p; emit('status'); }
  async function phaseFirstDay(ctx) {
    setPhase('first-day');
    const r = await rpcCall(ctx, function (session) { return CMA.rpc.getFirstDayWithData(session); });
    const floor = addDays(ctx.today, -HISTORY_MAX_DAYS);
    let first = r.ok && isIso(r.value) ? r.value : null;
    if (!r.ok) {
      ctx.notes.push('first day unavailable (' + errorText(r.error) + ')');
      if (mem.sync.firstDay) first = mem.sync.firstDay;   // a refused call keeps what an earlier sync learned
    }
    if (!first) first = addDays(ctx.today, -FIRST_DAY_FALLBACK_DAYS);   // the server has no first day, or none is known yet
    mem.sync.firstDay = minIso(maxIso(first, floor), ctx.today);
  }
  /** The app reads these two with alo('true', value), which ignores case (the diary's zDk, and bpk for units.calories). */
  function prefIsTrue(raw) { return raw != null && String(raw).toLowerCase() === 'true'; }
  /** A value READ from the account (null = the preference is absent: the app's default applies). */
  function applyPrefValue(prefs, name, raw) {
    if (name === 'tef') { prefs.tef = prefIsTrue(raw); prefs.assumed = false; }                     // app default 'false'
    else if (name === 'unitsCalories') prefs.unitsCalories = raw == null ? true : prefIsTrue(raw);    // app default 'true' = kcal
    else if (name === 'weightUnit') prefs.weightUnit = WEIGHT_UNITS.indexOf(raw) >= 0 ? raw : 'Pounds';   // app default Pounds
  }
  /** Before anything is read: TEF assumed off, both display units unknown (never Cronometer's defaults presented as
   *  the account's settings). */
  function unknownPrefs() { return { tef: false, unitsCalories: null, weightUnit: null, at: null, assumed: true }; }
  async function phasePrefs(ctx) {
    setPhase('prefs');
    const prefs = Object.assign(unknownPrefs(), mem.sync.prefs || {});   // what is not read keeps its last known value
    let refused = null;
    const names = ['tef', 'unitsCalories', 'weightUnit'];
    for (let i = 0; i < names.length; i++) {
      const r = await rpcCall(ctx, function (session) { return CMA.rpc.getPreference(session, PREF_KEYS[names[i]]); });
      if (!r.ok) { refused = r; break; }                     // one refusal: the others would be refused too
      applyPrefValue(prefs, names[i], r.value);
    }
    if (refused) ctx.notes.push('preferences unavailable' + (prefs.assumed ? ', TEF assumed off' : '') + ' (' + errorText(refused.error) + ')');
    if (prefs.assumed) prefs.tef = false;
    prefs.at = deps.now();
    mem.sync.prefs = normPrefs(prefs);
  }
  async function phaseBiometrics(ctx, spec) {
    setPhase('biometrics');
    const floor = addDays(ctx.today, -HISTORY_MAX_DAYS);
    const all = !!spec.all;
    const from = all ? floor : maxIso(minIso(spec.from, ctx.today), floor);
    const r = await rpcCall(ctx, function (session) {
      return CMA.rpc.getBiometrics(session, all ? { metricId: 1, unitId: 1 } : { metricId: 1, unitId: 1, from: from, to: ctx.today });
    });
    if (!r.ok) { ctx.notes.push('weigh-ins unavailable (' + errorText(r.error) + ')'); return; }
    const perDay = firstWeighIns(r.value);
    mergeWeighIns(from, ctx.today, perDay, deps.now());
    ctx.counts.weighIns = perDay.size;
    if (ctx.full) await persist([KEYS.DAYS], ctx.gen);   // a long backfill keeps its progress; a short job writes once at its end
    emit('data');
  }
  async function phaseEnergy(ctx, from, to) {
    setPhase('energy');
    let size = mem.sync.energyChunk || ENERGY_CHUNK_START;
    let a = from, streak = 0, transient = false;
    const unavailable = [];
    run.progress.total += Math.ceil((daysBetween(from, to) + 1) / size);
    while (a <= to) {
      const b = minIso(addDays(a, size - 1), to);
      const span = daysBetween(a, b) + 1;
      const r = await rpcCall(ctx, function (session) { return CMA.rpc.getCaloriesConsumedAndBurned(session, a, addDays(b, 1)); });
      if (r.ok && Array.isArray(r.value) && r.value.length === span) {
        mergeEnergy(a, b, r.value, deps.now());
        // the largest window proven to return exactly span rows - not after an HTTP error in this phase: a transient
        // 500 must not shrink the windows of every later sync for good
        if (span === size && !transient) mem.sync.energyChunk = size;
        ctx.counts.energyDays += span;
        streak = 0;
        a = addDays(b, 1);
        continue;
      }
      // a row count != span (a server that clamps the range) or an //EX: retry the same start with half the window
      // actually sent (a short last window too), so the same request is never sent twice; an HTTP error is retried
      // the same way but is not taken as the server's range limit
      if (!r.ok && r.kind === 'http') transient = true;
      const shrink = r.ok || r.kind === 'rpc' || r.kind === 'http';
      if (shrink && span > ENERGY_CHUNK_MIN) {
        size = Math.max(ENERGY_CHUNK_MIN, Math.floor(Math.min(size, span) / 2));
        run.progress.total++;
        continue;
      }
      unavailable.push({ from: a, to: b });
      ctx.notes.push('energy rows unavailable ' + a + '..' + b + ' (' + (r.ok ? r.value.length + ' rows for ' + span + ' days' : errorText(r.error)) + ')');
      streak++;
      a = addDays(b, 1);
      if (streak >= MAX_UNAVAILABLE_STREAK && a <= to) { unavailable.push({ from: a, to: to }); break; }
    }
    ctx.energyUnavailable = unavailable;
    if (ctx.full) await persist([KEYS.DAYS], ctx.gen);
    emit('data');
  }
  async function phaseCalendar(ctx, from, to) {
    setPhase('calendar');
    run.progress.total += Math.ceil((daysBetween(from, to) + 1) / CALENDAR_CHUNK);
    let a = from, refused = null;
    while (a <= to) {
      const b = minIso(addDays(a, CALENDAR_CHUNK - 1), to);
      const end = addDays(b, 1);   // likely inclusive on the server: a harmless superset, mapped by the returned Day
      const r = await rpcCall(ctx, function (session) { return CMA.rpc.getCalendarInfo(session, a, end); });
      if (!r.ok) { refused = r; break; }
      mergeCalendar(a, b, r.value);
      a = addDays(b, 1);
    }
    if (refused) {
      clearFlags(a, to);            // no stale "nothing logged" flag may hide an intake the energy rows now carry
      mem.sync.flagsSource = 'none';
      ctx.notes.push('logged / complete flags unavailable (' + errorText(refused.error) + ')');
    } else {
      mem.sync.flagsSource = 'calendar';
    }
    if (ctx.full) await persist([KEYS.DAYS], ctx.gen);
    emit('data');
  }

  async function execute(job, gen) {
    const g = gate();
    if (g) {
      run.lastBlocked = g;
      if (TRANSIENT_BLOCKS[g.code] && mem.sync.enabled) run.blockedRetry = mergeJobs(run.blockedRetry, job);
      emit('status');
      return;
    }
    const uid = currentUserId();
    // A second check before the first request: the consent STORED for this account. Another tab's Disable or Delete
    // TDEE data normally reaches this tab through chrome.storage.onChanged; if that event has not arrived (or the
    // listener could not be added), nothing is sent and nothing is written back.
    const withdrawn = await storedConsentWithdrawn(uid);
    if (withdrawn) {
      if (gen === run.gen && mem.userId === uid) applyForeign(withdrawn);
      emit('status');
      return;
    }
    if (gen !== run.gen || mem.userId !== uid) { emit('status'); return; }   // cancelled while reading
    const ctx = { gen: gen, uid: uid, full: job.kind === 'full', today: deps.today(), notes: [], counts: { weighIns: null, energyDays: 0 }, energyUnavailable: null };
    run.progress = { done: 0, total: (job.firstDay ? 1 : 0) + (job.prefs ? 3 : 0) + (job.bio ? 1 : 0) };
    const t0 = deps.now();
    try {
      if (job.firstDay) await phaseFirstDay(ctx);
      if (job.prefs) await phasePrefs(ctx);
      if (job.bio) await phaseBiometrics(ctx, job.bio);
      alive(ctx);
      if (job.energy) await phaseEnergy(ctx, rangeStart(job.energy, ctx.today), ctx.today);
      if (job.calendar) await phaseCalendar(ctx, rangeStart(job.calendar, ctx.today), ctx.today);
      alive(ctx);
      if (mem.userId !== uid) throw Abort('cancelled');
      const now = deps.now();
      if (job.kind === 'full') {
        mem.sync.lastFullAt = now;
        mem.sync.lastDeltaAt = now;
        mem.sync.rowLayoutVersion = ROW_LAYOUT_VERSION;
        mem.sync.energyUnavailable = (ctx.energyUnavailable || []).slice(0, 20);
        pruneOld(ctx.today);
      } else if (job.delta) {
        mem.sync.lastDeltaAt = now;
      }
      // a completed sync clears the failure; what it could not read is a note (shown as such), not an error
      mem.sync.lastError = null;
      mem.sync.notes = ctx.notes.length ? redact(ctx.notes.join('; ')).slice(0, 300) : null;
      run.phase = 'done';
      await persist([KEYS.DAYS, KEYS.SYNC], ctx.gen);
      const c = counts();
      log(job.kind + ' sync: ' + c.days + ' days' + (c.range ? ' (' + c.range.from + '..' + c.range.to + ')' : '') + ', ' + c.weighIns
        + ' weigh-ins, ' + c.intakeDays + ' logged days, ' + run.progress.done + ' calls, ' + (now - t0) + ' ms' + (ctx.notes.length ? ', ' + ctx.notes.length + ' notes' : ''));
      emit('data');
    } catch (e) {
      if (e && e.abort && e.kind === 'cancelled') { if (gen === run.gen) run.phase = 'idle'; emit('status'); return; }
      if (e && e.abort && e.kind === 'blocked') {
        if (gen === run.gen && mem.userId === uid) {
          run.phase = 'idle';
          run.lastBlocked = e.block;
          if (TRANSIENT_BLOCKS[e.block.code] && mem.sync.enabled) run.blockedRetry = mergeJobs(run.blockedRetry, job);
          persist([KEYS.DAYS], gen);                 // the chunks merged before the block are good data
          log(job.kind + ' sync paused: ' + e.block.code);
        }
        emit('status');
        return;
      }
      const text = e && e.abort ? e.message : errorText(e);
      if (gen === run.gen && mem.userId === uid) {
        mem.sync.lastError = String(text).slice(0, 300);
        run.phase = 'error';
        persist([KEYS.DAYS, KEYS.SYNC], gen);
      }
      log(job.kind + ' sync stopped: ' + text);
      emit('error', { error: text });
    }
  }

  // ------------------------------------------------------------------------------------------------
  // capture events: the app's own writes (dirty days), preference changes, account / readiness changes
  // ------------------------------------------------------------------------------------------------
  function isDayValue(v) { return !!v && typeof v === 'object' && typeof v.$t === 'string' && v.$t.indexOf(DAY_PREFIX) === 0 && Array.isArray(v.f); }
  /** Days a write touched: every Day value inside its parameters (Serving.day of updateDiary / editServing, the Day
   *  params of setDayComplete / clearDay / copyDay, a Biometric's or Exercise's day) or the `extra` days, and today;
   *  the day the diary shows only for a write that names no day itself (removeServing, removeMeasurement,
   *  removeExercise, logRepeatItemsForDay and the other id-only writes edit the viewed day). A write that carries its
   *  own Day never adds the viewed day: after browsing back that day may be long ago and would widen the refetch. */
  function affectedDays(ev, extra) {
    const out = new Set();
    (Array.isArray(extra) ? extra : []).forEach(function (d) { if (isIso(d)) out.add(d); });
    try {
      const params = ev && ev.parsed && Array.isArray(ev.parsed.params) ? ev.parsed.params.slice(1) : [];   // param 0 is the nonce
      if (CMA.gwt && typeof CMA.gwt.walk === 'function') {
        CMA.gwt.walk(params, function (node) {
          if (isDayValue(node)) { const iso = isoOfParts({ day: node.f[0], month: node.f[1], year: node.f[2] }); if (iso) out.add(iso); return false; }
          return true;
        });
      }
    } catch (e) { /* ignore */ }
    if (!out.size) {
      try {
        const vd = CMA.capture && CMA.capture.state ? isoOfParts(CMA.capture.state.diaryDate) : null;
        if (vd) out.add(vd);
      } catch (e) { /* ignore */ }
    }
    out.add(deps.today());
    return out;
  }
  function scheduleDirty() {
    if (run.dirtyTimer) { try { deps.clearTimer(run.dirtyTimer); } catch (e) { /* ignore */ } }
    run.dirtyTimer = deps.setTimer(fireDirty, deps.debounceMs);
  }
  function fireDirty() {
    run.dirtyTimer = null;
    if (!mem.loaded || !mem.sync.enabled) { run.dirty.clear(); run.energySpanPending = false; run.prefsPending = false; return; }
    const today = deps.today();
    let job = null;
    if (run.dirty.size) {
      const min = Array.from(run.dirty).sort()[0];
      run.dirty.clear();
      job = jobWindow('dirty', minIso(addDays(min, -1), today));
    }
    if (run.energySpanPending) { run.energySpanPending = false; job = mergeJobs(job, { kind: 'energy', prefs: false, firstDay: false, bio: null, energy: { span: true, from: null }, calendar: null }); }
    if (run.prefsPending) { run.prefsPending = false; job = mergeJobs(job, { kind: 'prefs', prefs: true, firstDay: false, bio: null, energy: null, calendar: null }); }
    if (!job) return;
    const g = gate();
    if (g) { if (TRANSIENT_BLOCKS[g.code]) run.blockedRetry = mergeJobs(run.blockedRetry, job); return; }
    enqueue(job).catch(function () { /* reported through status */ });
  }
  function onPref(ev) {
    const p = ev.pref || null;
    if (!p || typeof p.key !== 'string') return;
    let name = null;
    Object.keys(PREF_KEYS).forEach(function (n) { if (PREF_KEYS[n] === p.key) name = n; });
    if (name) {
      if (typeof p.value === 'string' || p.value === null) {
        const prefs = Object.assign(unknownPrefs(), mem.sync.prefs || {});
        applyPrefValue(prefs, name, p.value);
        prefs.at = deps.now();
        mem.sync.prefs = normPrefs(prefs);
        persist([KEYS.SYNC]);
        emit('data');
      } else {
        run.prefsPending = true;
        scheduleDirty();
      }
    }
    if (PROFILE_PREF_KEYS[p.key]) { run.energySpanPending = true; scheduleDirty(); }
  }
  function onRpc(ev) {
    try {
      if (!ev || typeof ev.method !== 'string' || ev.ok !== true) return;
      if (!mem.loaded || !mem.sync.enabled || mem.userId !== currentUserId()) return;   // consent, and this account only
      if (ev.method === 'setUserPreference') { onPref(ev); return; }
      if (!WRITE_METHODS[ev.method]) return;
      const today = deps.today();
      affectedDays(ev).forEach(function (d) { if (d <= today) run.dirty.add(d); });
      scheduleDirty();
    } catch (e) { /* never throw into capture */ }
  }
  /** CMA.events 'diary-write' {method, ok, days: ['YYYY-MM-DD', ...]}: a write the EXTENSION made (engine-rpc sends
   *  updateDiary / removeServing with fetch, which the hook never relays as an 'rpc' event). Same dirty rule. */
  function onDiaryWrite(ev) {
    try {
      if (!ev || ev.ok !== true || !WRITE_METHODS[ev.method]) return;
      if (!mem.loaded || !mem.sync.enabled || mem.userId !== currentUserId()) return;
      const today = deps.today();
      affectedDays(null, ev.days).forEach(function (d) { if (d <= today) run.dirty.add(d); });
      scheduleDirty();
    } catch (e) { /* ignore */ }
  }
  function onState() {
    try {
      const uid = currentUserId();
      if (uid && uid !== mem.userId) { load(uid); return; }
      maybeRetryBlocked();
    } catch (e) { /* ignore */ }
  }
  function onRegistry() { try { run.layoutCache = { registry: null, result: null }; maybeRetryBlocked(); } catch (e) { /* ignore */ } }
  let subscribed = false;
  function subscribe() {
    watchStorage();
    if (subscribed || !CMA.events || typeof CMA.events.on !== 'function') return;
    subscribed = true;
    CMA.events.on('rpc', onRpc);
    CMA.events.on('diary-write', onDiaryWrite);
    CMA.events.on('state', onState);
    CMA.events.on('registry', onRegistry);
    CMA.events.on('registry-progress', onRegistry);
  }

  // ------------------------------------------------------------------------------------------------
  // other tabs: every open Cronometer tab runs its own copy of this layer over ONE chrome.storage.local
  // ------------------------------------------------------------------------------------------------
  // chrome.storage.onChanged fires in every extension context, this tab's own writes included (recognised by
  // isEcho). What another tab wrote is adopted at once:
  //  * cmaTdeeSync removed (Delete TDEE data), or any cmaTdee* key taken over by another account: this account's
  //    stored copy is gone - stop, drop the memory copy (as disable({forget}) does here), and remove again any key
  //    this tab was still writing (its write lands after the deletion and would bring the data back);
  //  * cmaTdeeSync with enabled false (Disable): stop now; re-assert it if this tab's own write is still on its way;
  //  * any other key of this account: adopt it (a whole-key write from this tab's stale memory would otherwise drop
  //    the other tab's check-ins, settings, day decisions or CSV days), unless this tab's own newer write to that key
  //    is still on its way (events arrive in write order: that write lands after the other one).
  /** changes: {key: {value (null = removed), superseded}} -> memory (and, for a withdrawn consent, storage). */
  function applyForeign(changes) {
    const uid = mem.userId;
    if (!uid) return;
    const keys = Object.keys(changes).filter(function (k) { return ALL_KEYS.indexOf(k) >= 0; });
    if (!keys.length) return;
    const obj = function (v) { return !!v && typeof v === 'object'; };
    const otherAccount = keys.some(function (k) { const v = changes[k].value; return obj(v) && v.userId !== uid; });
    const deleted = keys.indexOf(KEYS.SYNC) >= 0 && !obj(changes[KEYS.SYNC].value);
    if (otherAccount || deleted) {
      const had = mem.sync.enabled || Object.keys(mem.days).length > 0 || mem.checkins.length > 0;
      const again = deleted && !otherAccount ? ALL_KEYS.filter(function (k) { return pendingEchoes(k) > 0; }) : [];
      cancelWork();
      resetMemory(uid);
      mem.loaded = true;
      if (again.length) {
        again.forEach(function (k) { expectEcho(k, 'null'); });
        storageRemove(again).then(function (ok) { if (!ok) again.forEach(function (k) { dropEcho(k, 'null'); }); });
      }
      if (had) log(otherAccount ? 'the stored TDEE data now belongs to another account (enabled in another tab): this account\'s copy is not kept'
        : 'the TDEE data was deleted in another tab: reading stopped');
      emit('status');
      emit('data');
      return;
    }
    keys.forEach(function (k) {
      const c = changes[k];
      if (k === KEYS.SYNC) {
        if (c.value.enabled !== true && mem.sync.enabled) {          // Disable in another tab: stop now
          cancelWork();
          run.phase = 'idle';
          if (c.superseded) { mem.sync.enabled = false; persist([KEYS.SYNC]); }   // lands after this tab's own write
          else adoptKey(k, c.value);
          log('TDEE history reading turned off in another tab');
          return;
        }
        if (!c.superseded) {
          const was = mem.sync.enabled;
          adoptKey(k, c.value);
          if (!was && mem.sync.enabled) log('TDEE history reading turned on in another tab');
        }
        return;
      }
      if (!c.superseded) adoptKey(k, c.value);
    });
    emit('status');
    emit('data');
  }
  function onStorageChanged(changes, area) {
    try {
      if (area && area !== 'local') return;
      if (!changes || typeof changes !== 'object') return;
      const foreign = {};
      let any = false;
      ALL_KEYS.forEach(function (k) {
        if (!own(changes, k)) return;
        const nv = changes[k] && typeof changes[k] === 'object' ? changes[k].newValue : undefined;
        const ser = canon(nv);
        if (isEcho(k, ser)) return;
        const superseded = pendingEchoes(k) > 0;
        if (!superseded) known[k] = ser;
        foreign[k] = { value: nv === undefined ? null : nv, superseded: superseded };
        any = true;
      });
      if (!any || !mem.userId) return;                  // no account yet: its load reads the current storage
      if (!mem.loaded) { run.foreignWhileLoading = Object.assign(run.foreignWhileLoading || {}, foreign); return; }
      applyForeign(foreign);
    } catch (e) { /* never throw into the storage event */ }
  }
  let watching = false;
  function watchStorage() {
    if (watching) return true;
    try {
      const ev = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged;
      if (!ev || typeof ev.addListener !== 'function') return false;
      ev.addListener(onStorageChanged);
      watching = true;
      return true;
    } catch (e) { return false; }
  }
  /** null while the consent stored for `uid` stands (or storage cannot tell: none, or unreadable / unwritable here, so
   *  the memory copy is all there is); else the change to apply ({cmaTdeeSync: {value, superseded}}). */
  async function storedConsentWithdrawn(uid) {
    if (mem.storage || !storage()) return null;
    const r = await storageGet([KEYS.SYNC]);
    if (!r.ok) return null;
    const v = r.value[KEYS.SYNC];
    if (v && typeof v === 'object' && v.userId === uid && v.enabled === true) return null;
    if (pendingEchoes(KEYS.SYNC)) return null;          // this tab's own write is still on its way
    if (watching) known[KEYS.SYNC] = canon(v);
    const out = {};
    out[KEYS.SYNC] = { value: v && typeof v === 'object' ? v : null, superseded: false };
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------------------------------------
  function load(uid) {
    const switching = mem.userId !== null && mem.userId !== uid;
    const retry = switching ? null : run.blockedRetry;   // a request made before the account was known survives
    cancelWork();
    run.blockedRetry = retry;
    if (switching) log('account changed: stored TDEE data of the previous account is not shown');
    resetMemory(uid);
    const p = storageGet(ALL_KEYS).then(function (r) {
      if (mem.userId !== uid || mem.loading !== p) return status();   // superseded by another account
      if (r.ok) {
        if (watching) ALL_KEYS.forEach(function (k) { if (!pendingEchoes(k)) known[k] = canon(r.value[k]); });
        adopt(r.value, uid);
      } else {
        mem.storage = r.none ? 'none' : 'read failed: ' + r.error;
        if (!r.none) { mem.sync.lastError = 'the stored TDEE data could not be read (' + r.error + '): changes are kept for this page only'; log(mem.sync.lastError); }
      }
      mem.loaded = true;
      mem.loading = null;
      const queued = run.foreignWhileLoading;
      run.foreignWhileLoading = null;
      if (queued) applyForeign(queued);   // another tab wrote while this page was reading
      if (mem.ignored) log('ignored ' + mem.ignored + ' stored TDEE record(s) of another account');
      emit('status');
      emit('data');
      maybeRetryBlocked();
      return status();
    });
    mem.loading = p;
    return p;
  }
  /** init() -> Promise<status>: loads the stored records of the current account (no network). */
  function init() {
    subscribe();
    const uid = currentUserId();
    if (!uid) return Promise.resolve(status());
    if (mem.userId === uid && mem.loaded) return Promise.resolve(status());
    if (mem.userId === uid && mem.loading) return mem.loading;
    return load(uid);
  }
  async function requireAccount() {
    await init();
    const uid = currentUserId();
    if (!uid || mem.userId !== uid || !mem.loaded) {
      const e = new Error('The Cronometer account is not known yet: reload the Cronometer tab.');
      e.kind = 'no-account';
      throw e;
    }
    return uid;
  }
  function counts() {
    const out = { days: 0, weighIns: 0, intakeDays: 0, burnedDays: 0, range: null };
    const today = deps.today();
    const tef = prefTef();
    let from = null, to = null;
    Object.keys(mem.days).forEach(function (d) {
      const rec = mem.days[d];
      out.days++;
      if (isNum(rec.w)) out.weighIns++;
      if (d !== today && loggedIntake(rec) !== null) out.intakeDays++;
      if (burnedOf(rec, d, tef) !== null) out.burnedDays++;
      if (from === null || d < from) from = d;
      if (to === null || d > to) to = d;
    });
    if (from) out.range = { from: from, to: to };
    return out;
  }
  function status() {
    const c = counts();
    const g = gate();
    return {
      enabled: !!mem.sync.enabled, syncing: !!liveRunning(), phase: run.phase,
      progress: { done: run.progress.done, total: Math.max(run.progress.total, run.progress.done) },
      lastFullAt: mem.sync.lastFullAt, lastDeltaAt: mem.sync.lastDeltaAt, firstDay: mem.sync.firstDay,
      lastError: mem.sync.lastError, notes: mem.sync.notes, flagsSource: mem.sync.flagsSource || 'none', energyChunk: mem.sync.energyChunk,
      prefs: mem.sync.prefs ? Object.assign({}, mem.sync.prefs) : null,
      counts: { days: c.days, weighIns: c.weighIns, intakeDays: c.intakeDays, burnedDays: c.burnedDays },
      range: c.range, ready: !!(mem.loaded && mem.userId && mem.userId === currentUserId()),
      blockedReason: g ? g.text : null, blockedCode: g ? g.code : null,
    };
  }
  /** diagnostics(): what the Diagnostics dump may carry - counts, date ranges, flags. Never a weight or an intake. */
  function diagnostics() {
    const s = status();
    let csvDays = 0;
    Object.keys(mem.days).forEach(function (d) { if (mem.days[d].cs) csvDays++; });
    const iso = function (ms) { return isNum(ms) ? new Date(ms).toISOString() : null; };
    return {
      enabled: s.enabled, ready: s.ready, syncing: s.syncing, phase: s.phase, blocked: s.blockedCode,
      lastFullAt: iso(s.lastFullAt), lastDeltaAt: iso(s.lastDeltaAt), firstDay: s.firstDay, flagsSource: s.flagsSource,
      energyChunk: s.energyChunk, rowLayoutVersion: mem.sync.rowLayoutVersion, counts: s.counts, range: s.range,
      csvDays: csvDays, overrides: Object.keys(mem.overrides).length, checkins: mem.checkins.length,
      energyUnavailable: (mem.sync.energyUnavailable || []).map(function (x) { return x.from + '..' + x.to; }),
      prefs: s.prefs ? { tef: s.prefs.tef, unitsCalories: s.prefs.unitsCalories, weightUnit: s.prefs.weightUnit, assumed: s.prefs.assumed } : null,
      storage: mem.storage, ignoredOtherAccount: mem.ignored, lastError: s.lastError, notes: s.notes, crossTab: watching,
    };
  }
  /** enable(): the user's consent to read the diary history of THIS account; runs the first full sync. */
  async function enable() {
    await init();
    const uid = currentUserId();
    if (!uid || mem.userId !== uid || !mem.loaded) return status();
    if (!mem.sync.enabled) {
      mem.sync.enabled = true;
      mem.sync.enabledAt = deps.now();
      log('TDEE history reading turned on');
      await persist([KEYS.SYNC]);
      emit('status');
    }
    return sync({ full: true });
  }
  /** disable({forget}): stop syncing; forget:true deletes every cmaTdee* key (and the memory copy). */
  async function disable(opts) {
    const forget = !!(opts && opts.forget);
    cancelWork();
    run.phase = 'idle';
    mem.sync.enabled = false;
    if (forget) {
      // the removal comes back as this tab's own change - for the keys that exist (Chrome reports no change for a key
      // that was not there, and a stale expectation would hide another tab's next write to it)
      const present = ALL_KEYS.filter(function (k) { return known[k] !== 'null'; });
      present.forEach(function (k) { expectEcho(k, 'null'); });
      let removed = await storageRemove(ALL_KEYS);
      if (!removed) {
        present.forEach(function (k) { dropEcho(k, 'null'); });
        if (storage()) {
          const blank = {};
          ALL_KEYS.forEach(function (k) { blank[k] = null; expectEcho(k, 'null'); });
          removed = await storageSet(blank);
          if (!removed) ALL_KEYS.forEach(function (k) { dropEcho(k, 'null'); });
        }
      }
      const uid = mem.userId;
      const wasLoaded = mem.loaded;
      resetMemory(uid);
      mem.loaded = wasLoaded || !!uid;
      log('TDEE data deleted');
    } else {
      await persist([KEYS.SYNC]);
      log('TDEE history reading turned off');
    }
    emit('status');
    emit('data');
    return status();
  }
  function needsFull(now) {
    const t = mem.sync.lastFullAt;
    return !isNum(t) || now - t > FULL_MAX_AGE_MS || t - now > DELTA_MIN_INTERVAL_MS || mem.sync.rowLayoutVersion !== ROW_LAYOUT_VERSION;
  }
  /** sync({full, force}) -> Promise<status>. Single-flight; blocked (with status.blockedReason) until enabled, capture
   *  ready, decoder matching and no rebuild running - a transient block runs the request once it clears. */
  function sync(opts) {
    opts = opts || {};
    return init().then(function () {
      const g = gate();
      const now = deps.now();
      if (g) {
        run.lastBlocked = g;
        if (TRANSIENT_BLOCKS[g.code] && (mem.sync.enabled || g.code === 'no-account' || g.code === 'loading')) {
          run.blockedRetry = mergeJobs(run.blockedRetry, opts.full ? jobFull() : jobWindow('delta', addDays(deps.today(), -DELTA_DAYS)));
        }
        emit('status');
        return status();
      }
      if (liveRunning() && run.runningJob && run.runningJob.kind === 'full') return run.running;   // it covers any request
      if (opts.full || needsFull(now)) return enqueue(jobFull());
      const recent = function (t) { return isNum(t) && now >= t && now - t < DELTA_MIN_INTERVAL_MS; };   // a future stamp (clock set back) is stale
      if (!opts.force && (recent(mem.sync.lastDeltaAt) || recent(mem.sync.lastFullAt))) return status();
      return enqueue(jobWindow('delta', addDays(deps.today(), -DELTA_DAYS)));
    });
  }

  // ---- record assembly ----
  function loggedIntake(rec) {
    if (!isNum(rec.i)) return null;
    if (csvHas(rec, 'i')) return rec.i;              // an imported value is a logged value
    // energy consumed > 0 means food was logged, whatever the calendar says: a day missing from an incomplete (or
    // silently capped) calendar reply must not drop a real intake; the flag only tells a logged 0-kcal day (fasting:
    // 0) from a day with nothing logged (null, never 0) - without flags (refused) a zero row is nothing logged
    if (rec.i > 0) return rec.i;
    return rec.lf === true ? rec.i : null;
  }
  function burnedOf(rec, date, tef) {
    if (mem.sync.firstDay && date < mem.sync.firstDay) return null;   // days before the account's data: never 0-rows
    const b = Array.isArray(rec.bp) ? burnedFromParts(rec.bp, tef) : rec.b;
    return isNum(b) && b > 0 ? b : null;
  }
  function median(values) {
    const v = values.slice().sort(function (a, b) { return a - b; });
    const n = v.length;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }
  /**
   * dayList() -> one entry per calendar day from the first stored day to today (ascending):
   * {date, intakeKcal (null today and when nothing was logged), weightKg, burnedKcal, burnedParts {bmr, activity,
   *  exercise, tef}, complete, loggedFood, excluded, excludedReason 'user'|'partial'|'incomplete'|null, partialSuspect
   *  (the spec 2.3 prompt: flagged and not yet decided), override true|false|null, source 'rpc'|'csv'|null}.
   * excluded: user override true > override false (confirmed, wins over every rule) > trustCompleteOnly with
   * complete === false > the partial-day heuristic. `complete` alone never excludes (most users never mark days).
   */
  function dayList() {
    if (!mem.loaded || !mem.userId) return [];
    const today = deps.today();
    const dates = Object.keys(mem.days).filter(function (d) { return d <= today; }).sort();
    if (!dates.length) return [];
    const settings = getSettings();
    const tef = prefTef();
    const hist = [];
    const out = [];
    for (let d = dates[0]; d <= today; d = addDays(d, 1)) {
      const rec = own(mem.days, d) ? mem.days[d] : null;
      const intake = rec && d !== today ? loggedIntake(rec) : null;   // today's diary is incomplete (spec 2.3)
      const ov = own(mem.overrides, d) ? mem.overrides[d] : null;
      let suspect = false;
      if (intake !== null) {
        const lo = addDays(d, -PARTIAL.LOOKBACK_DAYS);
        while (hist.length && hist[0].date < lo) hist.shift();
        const recent = hist.slice(-PARTIAL.WINDOW);
        if (recent.length >= PARTIAL.MIN_HISTORY) {
          const med = median(recent.map(function (x) { return x.v; }));
          if (med > 0 && intake < PARTIAL.FRACTION * med) suspect = true;
        }
      }
      let excluded = false, reason = null;
      if (ov === true) { excluded = true; reason = 'user'; }
      else if (ov === false) { /* confirmed fully logged */ }
      else if (settings.trustCompleteOnly && intake !== null && rec && rec.c === false) { excluded = true; reason = 'incomplete'; }
      else if (suspect) { excluded = true; reason = 'partial'; }
      // only days that count as fully logged feed later medians: a flagged day waits for the user's answer
      if (intake !== null && (ov === false || (ov === null && !suspect && reason !== 'incomplete'))) hist.push({ date: d, v: intake });
      const bp = rec && Array.isArray(rec.bp) ? rec.bp : null;
      out.push({
        date: d,
        intakeKcal: intake,
        weightKg: rec && isNum(rec.w) ? rec.w : null,
        burnedKcal: rec ? burnedOf(rec, d, tef) : null,
        burnedParts: bp ? { bmr: bp[0], activity: bp[1], exercise: bp[2], tef: bp[3] } : null,
        complete: rec && typeof rec.c === 'boolean' ? rec.c : null,
        loggedFood: rec && typeof rec.lf === 'boolean' ? rec.lf : null,
        excluded: excluded,
        excludedReason: reason,
        partialSuspect: suspect && ov === null,
        override: ov,
        source: rec ? (rec.cs ? 'csv' : 'rpc') : null,
      });
    }
    return out;
  }
  /** records({modelStartDate}) -> engine input [{date, intakeKcal, weightKg, burnedKcal, excluded}] from
   *  modelStartDate (default: the setting) to today; today is always present (the model runs through today), with its
   *  intake AND its burned null: today's burned is partial (TEF follows the food logged so far, exercise and tracker
   *  syncs arrive later), and the engine would average it into its warm-up prior (the first 7 burned values from the
   *  first weigh-in) and into cronometerBurned14Kcal / the calibration ratio. dayList() keeps it for display. */
  function records(opts) {
    const msd = opts && own(opts, 'modelStartDate') ? opts.modelStartDate : getSettings().modelStartDate;
    const today = deps.today();
    return dayList().filter(function (d) { return !isIso(msd) || d.date >= msd; }).map(function (d) {
      return { date: d.date, intakeKcal: d.intakeKcal, weightKg: d.weightKg, burnedKcal: d.date === today ? null : d.burnedKcal, excluded: d.excluded };
    });
  }
  /** setOverride(date, true = exclude | false = confirmed fully logged | null = clear) -> Promise<status>. */
  async function setOverride(date, value) {
    await requireAccount();
    if (!isIso(date)) throw new Error('setOverride: date must be YYYY-MM-DD');
    if (value !== true && value !== false && value !== null) throw new Error('setOverride: value must be true, false or null');
    if (value === null) delete mem.overrides[date]; else mem.overrides[date] = value;
    await persist([KEYS.OVERRIDES]);
    emit('data');
    return status();
  }
  function getSettings() { return normSettings(mem.settings || DEFAULT_SETTINGS); }
  async function saveSettings(partial) {
    await requireAccount();
    const cur = getSettings();
    const p = partial && typeof partial === 'object' ? partial : {};
    const next = Object.assign({}, cur, p);
    next.goal = Object.assign({}, cur.goal, p.goal && typeof p.goal === 'object' ? p.goal : {});
    next.units = Object.assign({}, cur.units, p.units && typeof p.units === 'object' ? p.units : {});
    const norm = normSettings(next);
    if (norm.goal.ratePctPerWeek !== cur.goal.ratePctPerWeek && !own(p, 'goalChangedAt')) norm.goalChangedAt = deps.now();
    mem.settings = norm;
    await persist([KEYS.SETTINGS]);
    emit('data');
    return getSettings();
  }
  function checkins() { return mem.checkins.map(function (c) { return JSON.parse(JSON.stringify(c)); }); }
  async function recordCheckin(entry) {
    await requireAccount();
    const c = normCheckin(entry, deps.now());
    if (!c.date) throw new Error('recordCheckin: date must be YYYY-MM-DD');
    mem.checkins.push(c);
    while (mem.checkins.length > MAX_CHECKINS) mem.checkins.shift();
    await persist([KEYS.CHECKINS]);
    emit('data');
    return JSON.parse(JSON.stringify(c));
  }
  // ---- CSV import helpers ----
  // biometrics.csv Unit column (research/tdee-weight-history.md: the WeightUnit abbreviations kg / lbs / st)
  const KG_PER_CSV_UNIT = { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237,
    pounds: 0.45359237, st: 6.35029318, stone: 6.35029318, stones: 6.35029318 };
  /** A biometrics.csv Time: Cronometer writes 'h:mm AM' ('7:32 AM', research/tdee-weight-history.md); 24-hour 'H:mm'
   *  and seconds are read too. -> {h, m, s}, or null (empty or unreadable: untimed, ranks after timed weigh-ins). */
  function csvTime(t) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(String(t == null ? '' : t).trim());
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2], s = m[3] ? +m[3] : 0;
    if (mi > 59 || s > 59) return null;
    if (m[4]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);   // 12:xx AM = 0:xx, 12:xx PM = 12:xx
    } else if (h > 23) return null;
    return { h: h, m: mi, s: s };
  }
  function csvError(text) { const e = new Error(text); e.kind = 'csv'; return e; }
  /**
   * importCsv('nutrition' | 'biometrics', text) -> Promise<{imported, skipped, unknownUnits}> (DAYS, not rows):
   * Cronometer's own export files. Days are marked source 'csv'; a day whose value the RPC already returned keeps it
   * (skipped), and a later refetch replaces a CSV value only where the RPC returns one. Dates must be YYYY-MM-DD and
   * not in the future. A file that is not the expected export is refused (rejects, nothing stored). No network.
   *  nutrition: dailysummary.csv through the engine's parseDailyNutritionCsv; ONE row per day - a date that repeats
   *    means the Food & Recipe Entries export (servings.csv), whose per-serving rows would store each day's last
   *    serving as its intake.
   *  biometrics: biometrics.csv read with the engine's parseCsv, NOT its parseBiometricsCsv, which converts only 'lb*'
   *    units (a stone amount would be stored as that many kg) and orders a day's rows by the TEXT of the time ('10:15
   *    AM' before '7:02 AM'): here each Amount is converted by its own Unit (kg, lb / lbs, st / stone; any other unit
   *    is skipped and counted in unknownUnits) and each day keeps its EARLIEST weigh-in by the parsed 12- or 24-hour
   *    Time (untimed rows after timed ones, then file order), the rule of the RPC weigh-ins (firstWeighIns).
   */
  async function importCsv(kind, text) {
    await requireAccount();
    if (typeof text !== 'string') throw new Error('importCsv: text must be a string');
    if (kind !== 'nutrition' && kind !== 'biometrics') throw new Error("importCsv: kind must be 'nutrition' or 'biometrics'");
    const T = CMA.tdee;
    if (!T || typeof T.parseCsv !== 'function' || typeof T.parseDailyNutritionCsv !== 'function') throw new Error('importCsv: the TDEE engine (src/tdee/adaptive-tdee.js) is not loaded');
    const today = deps.today(), now = deps.now();
    const rows = T.parseCsv(text);                     // header names lower-cased by the engine
    const head = rows.length ? rows[0] : null;
    let imported = 0, skipped = 0, unknownUnits = 0;
    if (kind === 'nutrition') {
      if (head && !own(head, 'date') && !own(head, 'day')) throw csvError('Daily Nutrition: the file has no Date column - choose dailysummary.csv (the Daily Nutrition export).');
      if (head && !own(head, 'energy (kcal)') && !own(head, 'energy (kj)')) throw csvError('Daily Nutrition: the file has no Energy (kcal) or Energy (kJ) column - choose dailysummary.csv (the Daily Nutrition export).');
      const list = T.parseDailyNutritionCsv(text);
      const dates = new Set();
      list.forEach(function (r) {
        const d = typeof r.date === 'string' ? r.date.trim() : '';
        if (dates.has(d)) throw csvError('Daily Nutrition: ' + d.slice(0, 20) + ' appears more than once - this looks like the Food & Recipe Entries export (servings.csv); choose dailysummary.csv (the Daily Nutrition export).');
        dates.add(d);
      });
      list.forEach(function (r) {
        const d = typeof r.date === 'string' ? r.date.trim() : '';
        if (!isIso(d) || d > today || !isNum(r.intakeKcal) || r.intakeKcal <= 0) { skipped++; return; }   // 0 kcal: a day the export lists empty
        const rec = mem.days[d];
        if (rec && !csvHas(rec, 'i') && loggedIntake(rec) !== null) { skipped++; return; }   // the RPC's value wins
        const x = ensureDay(d);
        x.i = r.intakeKcal;
        addCsv(x, 'i');
        if (r.excluded && x.c === null) x.c = false;   // a Completed=false column: stored as the complete flag only
        if (!isNum(x.f)) x.f = now;
        markUnsaved(d, d);
        imported++;
      });
    } else {
      if (head && !(own(head, 'metric') && own(head, 'amount'))) throw csvError('Biometrics: the file has no Metric and Amount columns - choose biometrics.csv (the Biometrics export).');
      const points = [], days = new Set();
      rows.forEach(function (r) {
        if (String(r.metric || '').trim().toLowerCase() !== 'weight') return;   // body fat, blood pressure ...: not used
        const d = String(r.day || r.date || '').trim();
        days.add(d);
        const unit = String(r.unit || '').trim().toLowerCase();
        if (!own(KG_PER_CSV_UNIT, unit)) { unknownUnits++; return; }
        const amount = parseFloat(r.amount);
        if (!isNum(amount) || amount <= 0) return;
        points.push({ date: d, time: csvTime(r.time), value: Math.round(amount * KG_PER_CSV_UNIT[unit] * 100) / 100 });
      });
      firstWeighIns(points).forEach(function (kg, d) {
        if (d > today) return;
        const rec = mem.days[d];
        if (rec && isNum(rec.w) && !csvHas(rec, 'w')) return;   // the RPC's weigh-in wins
        const x = ensureDay(d);
        x.w = kg;
        addCsv(x, 'w');
        if (!isNum(x.f)) x.f = now;
        markUnsaved(d, d);
        imported++;
      });
      skipped = days.size - imported;
    }
    await persist([KEYS.DAYS]);
    log('CSV import (' + kind + '): ' + imported + ' days imported, ' + skipped + ' skipped' + (unknownUnits ? ', ' + unknownUnits + ' rows in an unknown unit' : ''));
    emit('data');
    return { imported: imported, skipped: skipped, unknownUnits: unknownUnits };
  }
  /**
   * probe() -> {date, consumed, burned, parts {bmr, activity, exercise, tef}, row (the 12 raw numbers, when fetched in
   * this page), tefIncluded, weighIn {date, kg}|null} for the most recent full day (before today), so the user can
   * compare it with the diary's Energy Summary; null before any data. Memory only - not part of diagnostics().
   */
  function probe() {
    if (!mem.loaded || !mem.userId) return null;
    const today = deps.today();
    const tef = prefTef();
    let date = null;
    const dates = Object.keys(mem.days).filter(function (d) { return d < today; }).sort();
    for (let i = dates.length - 1; i >= 0; i--) { if (run.lastRows.has(dates[i]) || Array.isArray(mem.days[dates[i]].bp)) { date = dates[i]; break; } }
    let weighIn = null;
    const all = Object.keys(mem.days).filter(function (d) { return d <= today; }).sort();
    for (let i = all.length - 1; i >= 0; i--) { if (isNum(mem.days[all[i]].w)) { weighIn = { date: all[i], kg: mem.days[all[i]].w }; break; } }
    if (!date && !weighIn) return null;
    const rec = date ? mem.days[date] : null;
    const row = date && run.lastRows.has(date) ? run.lastRows.get(date).slice() : null;
    const bp = rec && Array.isArray(rec.bp) ? rec.bp : null;
    return {
      date: date,
      consumed: row ? row[0] : (rec && isNum(rec.i) ? rec.i : null),
      burned: rec ? burnedOf(rec, date, tef) : null,
      parts: bp ? { bmr: bp[0], activity: bp[1], exercise: bp[2], tef: bp[3] } : null,
      row: row,
      tefIncluded: tef,
      weighIn: weighIn,
    };
  }
  function today() { return deps.today(); }

  CMA.tdeeData = {
    init, status, enable, disable, sync, dayList, records, setOverride, getSettings, saveSettings, checkins, recordCheckin,
    importCsv, probe, today, diagnostics,
    burnedFromRow, firstWeighIns,
    KEYS, ROW_LAYOUT_VERSION, DEFAULT_SETTINGS, WRITE_METHODS, PREF_KEYS, PROFILE_PREF_KEYS,
    CONFIG: Object.freeze({ ENERGY_CHUNK_START, ENERGY_CHUNK_MIN, CALENDAR_CHUNK, DELTA_DAYS, DELTA_MIN_INTERVAL_MS, FULL_MAX_AGE_MS,
      HISTORY_MAX_DAYS, FIRST_DAY_FALLBACK_DAYS, PRE_WEIGH_IN_DAYS, NO_WEIGH_IN_DAYS, SPACING_MS, DIRTY_DEBOUNCE_MS, MAX_CHECKINS, PARTIAL }),
    /** Tests only: replace the clock / today / sleep / timers / spacing, and drop every state (memory, jobs, timers). */
    _test: {
      configure: function (d) { deps = Object.assign({}, DEFAULT_DEPS, d || {}); },
      reset: function () {
        cancelWork(); resetMemory(null); run.running = null; run.runningJob = null; run.pendingPromise = null; run.phase = 'idle'; run.progress = { done: 0, total: 0 };
        run.lastCallEnd = 0; run.layoutCache = { registry: null, result: null };
        Object.keys(echoes).forEach(function (k) { delete echoes[k]; }); Object.keys(known).forEach(function (k) { delete known[k]; });
      },
      mem: mem, run: run, gate: gate, canon: canon, csvTime: csvTime, onStorageChanged: onStorageChanged,
    },
  };
  subscribe();
})();
