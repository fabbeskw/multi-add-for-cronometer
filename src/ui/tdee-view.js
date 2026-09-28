/* Multi-Add for Cronometer — Adaptive TDEE view (vendor/adaptive-tdee/ADAPTIVE_TDEE_SPEC.md §4 and §6, SPEC §8).
 *
 * Registers {id:'tdee', label:'TDEE'} with CMA.panel.registerView (panel.js, "View registry"): the view lives in
 * the panel's closed shadow root, builds every node with createElement / createElementNS + textContent (never
 * innerHTML) and follows the panel's compact 13px look in light and dark.
 *
 *   data   CMA.tdeeData (src/tdee/tdee-data.js): stored per-day records, sync, per-day overrides, settings,
 *          check-ins and the probe of the most recent full day. It emits CMA.events 'tdee-data'
 *          {type:'status'|'data'|'error'} after every change.
 *   maths  CMA.tdee (src/tdee/adaptive-tdee.js, the upstream engine with its maths unchanged): runExpenditureModel,
 *          weeklyCheckIn, activityAwareDailyTarget, RESPONSIVENESS, DEFAULT_CONFIG, addDays.
 *
 * Screens: a consent card until the user enables the feature, then Overview (expenditure card, this-week card,
 * charts, data-quality nudges, "Check the numbers"), History (per-day list with exclude toggles) and Settings; the
 * weekly check-in is a dialog inside the view.
 *
 * Rules
 *   * Neutral colours only (spec §6). The css below never names the panel's green accent or red error tokens and
 *     the view never uses the panel's primary/danger buttons or its error notice: over/under target, weights and
 *     changes are information, not judgement. Errors are shown in the view's own neutral message box.
 *   * The model is recomputed from the full history (about 5 ms per year) when the data or the settings change:
 *     debounced on 'tdee-data' events, never inside the capture 'state' handler (that one only refreshes the sync
 *     line and, through a timer, may start an overdue refresh).
 *   * The target changes only at an accepted check-in, never day to day; a skipped check-in is recorded too; a goal
 *     change allows an immediate check-in without the weekly cap. The target is display only (spec §4.5): the user
 *     copies it into Cronometer, nothing is written back.
 *   * diagnostics() holds counts, date ranges and setting flags only: never weights, intakes, expenditure or
 *     targets (the dump is pasted into bug reports), and nothing the view logs carries those numbers either.
 *   * Display units follow settings.units ('auto' = Cronometer's own preferences as reported by the data layer).
 *     Everything is computed in kcal and kg; kJ = kcal x 4.1868 (the web app's own factor, so the numbers match
 *     the diary), lb = kg / 0.45359237, st = kg / 6.35029318.
 *   * Today is the LOCAL calendar date from CMA.tdeeData.today(), never the diary's viewed day; check-in
 *     weekdays are computed from calendar dates (UTC arithmetic on YYYY-MM-DD, like the engine).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const VIEW_ID = 'tdee';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DAY_MS = 86400000;
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const KJ_PER_KCAL = 4.1868;              // PXp in the compiled client: kcal -> kJ for display
  const KG_PER_LB = 0.45359237;
  const KG_PER_ST = 6.35029318;
  const KCAL_PER_KG = 7700;                // DEFAULT_CONFIG.kcalPerKg (engine): the "if you hit it" line
  const FIRST_CHECKIN_DAYS = 7;            // spec §4.1: the first check-in is offered after 7 days of data
  // At most one check-in every 6 days: moving the check-in weekday right after a check-in must not bring the next one
  // within days (the ±250 kcal cap is weekly). A check-in done a day or two late keeps the weekly rhythm; a real goal
  // change re-opens it at once.
  const MIN_CHECKIN_GAP_DAYS = 6;
  const WEIGHT_UNIT_NAMES = ['Kilograms', 'Pounds', 'Stone'];
  const HISTORY_PAGE = 60;
  const AUTO_SYNC_MIN_MS = 10 * 60 * 1000; // an automatic refresh when the view is shown, at most every 10 min
  const FULL_SYNC_MS = 7 * DAY_MS;         // ... and a full one when the last full refresh is a week old
  const RERENDER_MS = 120;                 // debounce for bursts of 'tdee-data' events during a sync
  const MAX_CSV_BYTES = 20 * 1024 * 1024;
  const PRIVACY_URL = 'https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md';
  const DISCLAIMER = 'Estimates only, not medical advice. Not suitable during pregnancy or with medical conditions that affect weight or fluid balance.';
  const HOLDING_TEXT = 'Paused — log food on 4+ of 7 days and weigh in at least weekly';
  const ACTIVITY_AWARE_LABEL = "Experimental — follows Cronometer's activity estimate";
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // spec §4.2 goal presets, in % of body weight per week (negative = lose)
  const GOALS = [
    { rate: -0.25, label: 'Lose 0.25% per week' }, { rate: -0.5, label: 'Lose 0.5% per week' },
    { rate: -0.75, label: 'Lose 0.75% per week' }, { rate: -1, label: 'Lose 1.0% per week' },
    { rate: 0, label: 'Maintain' },
    { rate: 0.1, label: 'Gain 0.1% per week' }, { rate: 0.25, label: 'Gain 0.25% per week' }, { rate: 0.5, label: 'Gain 0.5% per week' }
  ];
  const RESPONSIVENESS_OPTIONS = [['stable', 'Stable — steadier estimate'], ['balanced', 'Balanced (default)'], ['responsive', 'Responsive — follows changes faster']];
  const PROTEIN_LEVELS = [[1.6, '1.6 g per kg'], [1.8, '1.8 g per kg (default)'], [2.2, '2.2 g per kg']];
  const FAT_SPLITS = [[0.25, 'Carb-leaning (25% of the rest from fat)'], [0.35, 'Balanced (35%, default)'], [0.5, 'Fat-leaning (50%)']];
  const SEXES = [['female', 'Female'], ['male', 'Male'], ['other', 'Other / not specified']];
  const RANGES = [[90, '90 d'], [180, '180 d'], [365, '1 y'], [0, 'All']];

  // ---------------------------------------------------------------------------
  // View state (one per page: the panel may mount and unmount around it)
  // ---------------------------------------------------------------------------
  const vs = {
    ctx: null,              // the panel's ctx of the last render (body/footer + helpers)
    shown: false,           // false after 'hidden': the next render counts as "the view was opened"
    syncOnShow: false,      // an automatic refresh check is due once the enabled view renders
    sub: 'overview',        // 'overview' | 'history' | 'settings'
    range: 180,             // chart window in days, 0 = all
    historyPage: 0,         // History: 0 = the newest HISTORY_PAGE days
    draft: null,            // Settings fields changed but not saved yet ({field: input value}); cleared by Save / a sub-view switch
    dialog: null,           // the open check-in dialog (frozen numbers) or null
    msg: null,              // {kind:'info'|'problem', text} shown at the top of the view
    confirmDelete: false,
    settingsNote: '',
    initState: 'idle',      // 'idle' | 'loading' | 'done'
    initUserId: null,
    initSeq: 0,
    dataVersion: 0,         // bumped on every data change: the model cache key
    model: null,
    modelKey: null,
    timer: null,
    unsub: null,
    statusBox: null,
    renderedEnabled: null,
    renderedSyncing: false,
    renderedReady: true,
    lastAutoSyncAt: 0,
    dismissed: {}           // nudge dismissals of this page (also saved in settings.nudges)
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function D() { return CMA.tdeeData || null; }
  function T() { return CMA.tdee || null; }
  function el() { return vs.ctx.el.apply(null, arguments); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function redactText(s) {
    const t = s == null ? '' : String(s);
    try { return vs.ctx && typeof vs.ctx.redact === 'function' ? vs.ctx.redact(t) : t; } catch (e) { return t; }
  }
  function errMsg(e) { return redactText(e && e.message ? e.message : e); }
  /** Panel log line. Never pass a weight, an intake, an expenditure or a target here: the log is in the dump. */
  function log(msg) { try { if (vs.ctx) vs.ctx.log(msg); } catch (e) { /* ignore */ } }
  function note(kind, text) { vs.msg = text ? { kind: kind === 'problem' ? 'problem' : 'info', text: redactText(text) } : null; }
  function num(v) { const n = Number(v); return v != null && isFinite(n) ? n : 0; }
  function finite(v) { return v != null && v !== '' && isFinite(Number(v)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function minMax(arr) {
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) { if (v == null || !isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    return lo === Infinity ? null : [lo, hi];
  }
  /** Call a synchronous CMA.tdeeData method; a throwing data layer shows a neutral message, never breaks the view. */
  function dcall(name, args, fallback) {
    const d = D();
    if (!d || typeof d[name] !== 'function') return fallback;
    try { const v = d[name].apply(d, args || []); return v == null ? fallback : v; }
    catch (e) { note('problem', 'TDEE data (' + name + '): ' + errMsg(e)); return fallback; }
  }
  function dcallAsync(name, args) {
    const d = D();
    if (!d || typeof d[name] !== 'function') return Promise.reject(new Error('the TDEE data layer has no ' + name + '()'));
    try { return Promise.resolve(d[name].apply(d, args || [])); } catch (e) { return Promise.reject(e); }
  }
  function bump() { vs.dataVersion++; }

  // ---- calendar dates (YYYY-MM-DD, pure calendar arithmetic like the engine's addDays/daysBetween) ----
  function isoParts(iso) { const m = ISO_RE.exec(String(iso || '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
  function isoUtc(iso) { const p = isoParts(iso); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
  function addDays(iso, n) {
    const t = T();
    if (t && typeof t.addDays === 'function') return t.addDays(iso, n);
    return new Date(isoUtc(iso) + n * DAY_MS).toISOString().slice(0, 10);   // UTC midnight of a calendar date
  }
  function weekdayOf(iso) { return new Date(isoUtc(iso)).getUTCDay(); }
  function fmtDay(iso) { const p = isoParts(iso); return p ? WD[weekdayOf(iso)] + ' ' + p.d + ' ' + MONTHS[p.m - 1] : String(iso || '?'); }
  function fmtDate(iso) { const p = isoParts(iso); return p ? p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y : String(iso || '?'); }
  function fmtDayLong(iso) { const p = isoParts(iso); return p ? fmtDay(iso) + ' ' + p.y : String(iso || '?'); }
  function localToday() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { const t = dcall('today', [], null); return typeof t === 'string' && ISO_RE.test(t) ? t : localToday(); }

  // ---- numbers and units ----
  function groupDigits(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** '2,480' / '−40' (U+2212 minus); '—' for a missing value. */
  function fmtInt(n) {
    if (!finite(n)) return '—';
    const r = Math.round(Number(n));
    return (r < 0 ? '−' : '') + groupDigits(String(Math.abs(r)));
  }
  /** At most dp decimals, trailing zeros dropped: fmtDec(-0.40, 2) = '−0.4'. */
  function fmtDec(n, dp) {
    if (!finite(n)) return '—';
    const f = Math.pow(10, dp);
    const r = Math.round(Math.abs(Number(n)) * f) / f;
    let s = r.toFixed(dp);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    const parts = s.split('.');
    return (Number(n) < 0 && r !== 0 ? '−' : '') + groupDigits(parts[0]) + (parts.length > 1 ? '.' + parts[1] : '');
  }
  function plus(s, n) { return (Number(n) > 0 ? '+' : '') + s; }
  /** Which of Cronometer's two display preferences the data layer actually READ: null = not read (never synced, or the
   *  read was refused) - then 'auto' shows kcal and kg, never Cronometer's own defaults (kcal, Pounds) as if they were
   *  the account's settings. The data layer reports a value it read and found absent as the app's default. */
  function prefsKnown(st) {
    const p = st && st.prefs && typeof st.prefs === 'object' ? st.prefs : null;
    const uc = p ? p.unitsCalories : null;
    return {
      prefs: p,
      energy: typeof uc === 'boolean' || uc === 'true' || uc === 'false',
      weight: !!p && WEIGHT_UNIT_NAMES.indexOf(p.weightUnit) >= 0
    };
  }
  /** Resolve the display units: settings.units, 'auto' = Cronometer's preferences from the data layer's status. */
  function unitsFor(s, st) {
    const k = prefsKnown(st);
    let energy = s.units.energy;
    if (energy !== 'kcal' && energy !== 'kJ') {
      // units.calories: 'true' = kcal (bpk reads WBk(prefs, 'units.calories', 'true')); 'false' = a kJ account
      const uc = k.prefs ? k.prefs.unitsCalories : null;
      energy = k.energy && (uc === false || uc === 'false') ? 'kJ' : 'kcal';
    }
    let weight = s.units.weight;
    if (weight !== 'kg' && weight !== 'lb') {
      // weightUnit holds the WeightUnit enum name
      const w = k.weight ? k.prefs.weightUnit : null;
      weight = w === 'Pounds' ? 'lb' : w === 'Stone' ? 'st' : 'kg';
    }
    return { energy, weight };
  }
  function eVal(kcal, u) { return u.energy === 'kJ' ? Number(kcal) * KJ_PER_KCAL : Number(kcal); }
  function fmtE(kcal, u) { return finite(kcal) ? fmtInt(eVal(kcal, u)) : '—'; }
  function fmtEU(kcal, u) { return fmtE(kcal, u) + ' ' + u.energy; }
  function wVal(kg, u) { return u.weight === 'lb' ? Number(kg) / KG_PER_LB : u.weight === 'st' ? Number(kg) / KG_PER_ST : Number(kg); }
  function fmtW(kg, u) {
    if (!finite(kg)) return '—';
    if (u.weight === 'st') {
      const totalLb = Number(kg) / KG_PER_LB;
      let st = Math.floor(totalLb / 14);
      let lb = Math.round((totalLb - st * 14) * 10) / 10;
      if (lb >= 14) { st += 1; lb = 0; }
      return st + ' st ' + fmtDec(lb, 1) + ' lb';
    }
    return fmtDec(wVal(kg, u), 1) + ' ' + u.weight;
  }
  /** A weight CHANGE: kg with up to 2 decimals, otherwise lb (stone users think of small changes in pounds). */
  function fmtWDelta(kg, u, signed) {
    if (!finite(kg)) return '—';
    const s = u.weight === 'kg' ? fmtDec(kg, 2) + ' kg' : fmtDec(Number(kg) / KG_PER_LB, 1) + ' lb';
    return signed ? plus(s, kg) : s;
  }
  function weightUnitName(u) { return u.weight === 'st' ? 'st' : u.weight; }

  // ---------------------------------------------------------------------------
  // Settings (owned by CMA.tdeeData; normalised here so a partial object never breaks the view)
  // ---------------------------------------------------------------------------
  function normSettings(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const g = o.goal && typeof o.goal === 'object' ? o.goal : {};
    const units = o.units && typeof o.units === 'object' ? o.units : {};
    const wd = Number(o.checkInWeekday);
    return {
      goal: { ratePctPerWeek: finite(g.ratePctPerWeek) ? Number(g.ratePctPerWeek) : 0 },
      sex: o.sex === 'female' || o.sex === 'male' ? o.sex : 'other',
      checkInWeekday: o.checkInWeekday != null && Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 1,
      responsiveness: o.responsiveness === 'stable' || o.responsiveness === 'responsive' ? o.responsiveness : 'balanced',
      manualInitialKcal: finite(o.manualInitialKcal) && Number(o.manualInitialKcal) > 0 ? Number(o.manualInitialKcal) : null,
      proteinGPerKg: [1.6, 1.8, 2.2].indexOf(Number(o.proteinGPerKg)) >= 0 ? Number(o.proteinGPerKg) : 1.8,
      fatShare: [0.25, 0.35, 0.5].indexOf(Number(o.fatShare)) >= 0 ? Number(o.fatShare) : 0.35,
      activityAware: o.activityAware === true,
      units: { weight: units.weight === 'kg' || units.weight === 'lb' ? units.weight : 'auto', energy: units.energy === 'kcal' || units.energy === 'kJ' ? units.energy : 'auto' },
      modelStartDate: ISO_RE.test(String(o.modelStartDate || '')) ? String(o.modelStartDate) : null,
      trustCompleteOnly: o.trustCompleteOnly === true,
      goalChangedAt: finite(o.goalChangedAt) && Number(o.goalChangedAt) > 0 ? Number(o.goalChangedAt) : null,
      nudges: o.nudges && typeof o.nudges === 'object' ? o.nudges : {}
    };
  }
  function settingsNow() { return normSettings(dcall('getSettings', [], null)); }
  function statusNow() { const s = dcall('status', [], null); return s && typeof s === 'object' ? s : null; }
  function daysNow() { const l = dcall('dayList', [], []); return Array.isArray(l) ? l.filter(d => d && ISO_RE.test(String(d.date))) : []; }
  /** Check-ins oldest first (by date, then by the time they were recorded). */
  function checkinsNow() {
    const l = dcall('checkins', [], []);
    return (Array.isArray(l) ? l : []).filter(c => c && ISO_RE.test(String(c.date))).slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : num(a.at) - num(b.at)));
  }

  // ---------------------------------------------------------------------------
  // Model (engine) and check-in maths
  // ---------------------------------------------------------------------------
  function computeModel(s, today) {
    const t = T(), d = D();
    if (!t || typeof t.runExpenditureModel !== 'function') return { error: 'NO_ENGINE', days: [], current: null };
    if (!d || typeof d.records !== 'function') return { error: 'NO_DATA_LAYER', days: [], current: null };
    let recs = d.records({ modelStartDate: s.modelStartDate || null });
    recs = Array.isArray(recs) ? recs : [];
    // belt and braces for spec §2.3 / §5: the data layer already does all three, the view never relies on it. Today's
    // burned is partial too (TEF follows the food logged so far, exercise and tracker syncs come later): in the engine
    // it would enter the warm-up prior and the 14-day Cronometer average (the activity-aware line reads it from dayList)
    recs = recs.filter(r => r && ISO_RE.test(String(r.date)) && (!s.modelStartDate || r.date >= s.modelStartDate))
      .map(r => (r.date === today && (r.intakeKcal != null || r.burnedKcal != null) ? Object.assign({}, r, { intakeKcal: null, burnedKcal: null }) : r));
    const opts = {};
    if (s.manualInitialKcal != null) opts.initialExpenditureKcal = s.manualInitialKcal;
    const drift = t.RESPONSIVENESS ? t.RESPONSIVENESS[s.responsiveness] : undefined;
    if (finite(drift)) opts.config = { expenditureDriftKcal: Number(drift) };   // an undefined override would be NaN maths
    const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const m = t.runExpenditureModel(recs, opts) || { days: [], current: null, error: 'NO_RESULT' };
    const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    m.computeMs = Math.round((t1 - t0) * 10) / 10;
    m.recordCount = recs.length;
    if (!Array.isArray(m.days)) m.days = [];
    return m;
  }
  function currentModel(s, today) {
    const key = [vs.dataVersion, s.modelStartDate || '', s.responsiveness, s.manualInitialKcal || '', today, !!T(), !!D()].join('|');
    if (vs.model && vs.modelKey === key) return vs.model;
    let m;
    try { m = computeModel(s, today); } catch (e) { m = { error: 'ENGINE_ERROR', message: errMsg(e), days: [], current: null }; }
    vs.model = m; vs.modelKey = key;
    return m;
  }
  function modelOk(m) { return !!(m && !m.error && m.current && m.days && m.days.length); }
  function warmupDays() { const t = T(); const w = t && t.DEFAULT_CONFIG ? Number(t.DEFAULT_CONFIG.warmupDays) : NaN; return isFinite(w) && w > 0 ? w : 7; }
  /** Spec §6.1 status chip. `days` = days since the first weigh-in (model.days.length). */
  function chipText(cur, days) {
    if (!cur) return '';
    const w = warmupDays();
    if (cur.status === 'warmup') return 'Getting to know you · day ' + Math.max(1, Math.min(w, days || 1)) + ' of ' + w;
    if (cur.status === 'holding') return HOLDING_TEXT;
    return cur.calibrated ? 'Up to date' : 'Calibrating';
  }
  /** "Cronometer estimates 2,650 — your data says you burn about 6% less" (spec §6.1). During the warm-up the estimate
   *  is still the starting estimate, so nothing is said about "your data" yet. */
  function comparisonText(cur, u) {
    if (!cur) return null;
    const b = cur.cronometerBurned14Kcal, r = cur.cronometerCalibrationRatio;
    if (!finite(b) || Number(b) <= 0 || !finite(r) || Number(r) <= 0) return null;
    const pct = Math.round(Math.abs(1 - Number(r)) * 100);
    const head = 'Cronometer estimates ' + fmtE(b, u);
    const later = 'the comparison with your own data starts after the first week';
    if (cur.status === 'warmup') {
      if (cur.priorSource !== 'manual') return head + ' — ' + later;
      return head + ' — ' + (pct === 0 ? 'the same as your starting estimate' : 'your starting estimate is ' + pct + '% ' + (Number(r) < 1 ? 'lower' : 'higher')) + '; ' + later;
    }
    if (pct === 0) return head + ' — your data agrees with it';
    return head + ' — your data says you burn about ' + pct + '% ' + (Number(r) < 1 ? 'less' : 'more');
  }
  function priorText(cur, u) {
    if (!cur || !finite(cur.priorKcal)) return '';
    const v = fmtEU(cur.priorKcal, u) + '/day';
    if (cur.priorSource === 'manual') return 'Started from your own estimate (' + v + ').';
    if (cur.priorSource === 'cronometer') return 'Started from Cronometer’s burned average over your first week (' + v + ').';
    if (cur.priorSource === 'intake') return 'Started from your average intake over your first two weeks (' + v + ').';
    return '';
  }
  /** The goal rate the user had chosen at a check-in (goalRatePctPerWeek; older records: the applied rate). */
  function goalRateOf(c) {
    if (c && finite(c.goalRatePctPerWeek)) return Number(c.goalRatePctPerWeek);
    return c && finite(c.ratePctPerWeek) ? Number(c.ratePctPerWeek) : null;
  }
  /**
   * Where the weekly check-in stands (spec §4.1). The slot is the most recent check-in weekday on or before today
   * (local calendar); a check-in (accepted OR skipped) dated on/after the slot closes it, and the next one opens no
   * sooner than MIN_CHECKIN_GAP_DAYS after the last one. A goal change after the latest check-in re-opens it at once
   * and one after the last ACCEPTED check-in lifts the weekly cap - but only when the goal now differs from the goal of
   * that check-in (a goal changed and changed back is no change).
   */
  function checkInInfo(m, s, cis, today) {
    const back = (weekdayOf(today) - s.checkInWeekday + 7) % 7;
    const slot = addDays(today, -back);
    const last = cis.length ? cis[cis.length - 1] : null;
    let lastAccepted = null;
    for (let i = cis.length - 1; i >= 0; i--) if (cis[i].accepted === true && finite(cis[i].targetKcal)) { lastAccepted = cis[i]; break; }
    const when = (c) => (finite(c.at) && Number(c.at) > 0 ? Number(c.at) : isoUtc(c.date));
    const dataDays = m && Array.isArray(m.days) ? m.days.length : 0;
    const enoughData = modelOk(m) && dataDays >= FIRST_CHECKIN_DAYS;
    const gc = s.goalChangedAt, rate = Number(s.goal.ratePctPerWeek);
    const differs = (c) => { const r = goalRateOf(c); return r === null || Math.abs(r - rate) > 1e-9; };
    const goalChanged = gc != null && (!lastAccepted || (when(lastAccepted) < gc && differs(lastAccepted)));
    const reopened = gc != null && !!last && when(last) < gc && differs(last);
    const doneThisSlot = !!last && last.date >= slot;
    const earliest = last ? addDays(last.date, MIN_CHECKIN_GAP_DAYS) : null;
    const open = !doneThisSlot && (!earliest || today >= earliest);
    const due = enoughData && (open || reopened);
    let next = today;
    if (!due) {
      next = doneThisSlot ? addDays(slot, 7) : today;
      if (earliest && earliest > next) next = earliest;
    }
    return {
      slot, today, due, byGoal: due && !open && reopened, goalChanged, last, lastAccepted, enoughData, dataDays, next,
      daysToGo: Math.max(0, FIRST_CHECKIN_DAYS - dataDays)
    };
  }
  function runCheckIn(m, s, info) {
    const t = T();
    if (!t || typeof t.weeklyCheckIn !== 'function' || !modelOk(m)) return null;
    return t.weeklyCheckIn({
      model: m.current,
      goal: { ratePctPerWeek: s.goal.ratePctPerWeek },
      sex: s.sex,
      previousTargetKcal: info.lastAccepted ? Number(info.lastAccepted.targetKcal) : null,
      goalChanged: !!info.goalChanged,
      settings: { proteinGPerKg: s.proteinGPerKg, fatShareOfRemaining: s.fatShare }
    });
  }
  function goalText(rate) {
    const g = GOALS.find(x => x.rate === rate);
    if (g) return g.rate === 0 ? 'maintain your weight' : g.label.replace(/^Lose/, 'lose').replace(/^Gain/, 'gain');
    return (rate < 0 ? 'lose ' : 'gain ') + fmtDec(Math.abs(rate), 2) + '% per week';
  }
  function macrosText(mc) {
    if (!mc || !finite(mc.proteinG)) return '';
    return 'Protein ' + fmtInt(mc.proteinG) + ' g · Fat ' + fmtInt(mc.fatG) + ' g · Carbs ' + fmtInt(mc.carbsG) + ' g';
  }
  function weighInNudgeText(days, today) {
    const from = addDays(today, -6);
    const n = days.filter(d => d.date >= from && d.date <= today && finite(d.weightKg)).length;
    if (n >= 3) return null;
    if (n === 0) return "You haven't weighed in this week — 3+ weigh-ins make this more accurate";
    return "You've weighed in " + (n === 1 ? 'once' : 'twice') + ' this week — 3+ weigh-ins make this more accurate';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: render / onEvent / unmount (called by panel.js)
  // ---------------------------------------------------------------------------
  function subscribe() {
    const ev = CMA.events;
    if (vs.unsub || !ev || typeof ev.on !== 'function') return;
    const fn = (p) => onData(p);
    const off = ev.on('tdee-data', fn);
    vs.unsub = typeof off === 'function' ? off : () => { try { ev.off('tdee-data', fn); } catch (e) { /* ignore */ } };
  }
  function isActive() { const c = vs.ctx; try { return !!(c && c.isActive() && c.body && c.body.isConnected); } catch (e) { return false; } }
  function schedule(ms) {
    if (vs.timer) clearTimeout(vs.timer);
    vs.timer = setTimeout(() => { vs.timer = null; rerender(false); }, ms == null ? RERENDER_MS : ms);
  }
  /** Where the keyboard focus is, as something the next render can find again (an id, or a view class plus the day /
   *  sub-view / range it belongs to); null when the focus is not in this view. */
  function focusKey(c) {
    try {
      const root = c.body.getRootNode();
      const a = root && root.activeElement;
      if (!a || !(c.body.contains(a) || c.footer.contains(a))) return null;
      if (a.id) return { id: a.id };
      // the most specific view class (the last one): 'cma-tdee-p-keep' of a button, 'cma-tdee-chart-weight' of a chart
      const cls = String(a.getAttribute('class') || '').split(/\s+/).filter(x => /^cma-tdee-/.test(x) && x !== 'cma-tdee-btn' && x !== 'cma-tdee-primary' && x !== 'cma-tdee-seg-small').pop();
      if (!cls) return null;
      const row = a.closest ? a.closest('[data-date]') : null;
      return { cls, date: row ? row.getAttribute('data-date') : null, sub: a.getAttribute('data-sub'), range: a.getAttribute('data-range') };
    } catch (e) { return null; }
  }
  function restoreFocus(c, k) {
    if (!k) return;
    try {
      const all = Array.from(c.body.querySelectorAll(k.id ? '[id]' : '.' + k.cls)).concat(Array.from(c.footer.querySelectorAll(k.id ? '[id]' : '.' + k.cls)));
      const hit = all.find(n => (k.id ? n.id === k.id : ((n.closest && n.closest('[data-date]') ? n.closest('[data-date]').getAttribute('data-date') : null) === k.date
        && n.getAttribute('data-sub') === k.sub && n.getAttribute('data-range') === k.range)));
      if (hit && !hit.disabled && typeof hit.focus === 'function') hit.focus();
    } catch (e) { /* ignore */ }
  }
  /** Re-render in place (keeps the body's scroll position unless asked to reset it, and the keyboard focus). */
  function rerender(resetScroll) {
    if (!isActive()) return;
    // this render shows the current state: a re-render still scheduled from before (a data event on another sub-view)
    // must not fire later and rebuild what is on screen now (a Settings form being edited)
    if (vs.timer) { clearTimeout(vs.timer); vs.timer = null; }
    const c = vs.ctx;
    const top = resetScroll ? 0 : c.body.scrollTop;
    const fk = focusKey(c);
    clear(c.body); clear(c.footer);
    render(c);
    c.body.scrollTop = top;
    restoreFocus(c, fk);
  }
  /** The Settings form is on screen: an async result (a sync, data or an error arriving) never rebuilds it, so what
   *  the user typed and has not saved stays; the switch to another sub-view re-renders anyway. */
  function onSettingsForm() { return vs.sub === 'settings' && !vs.dialog && vs.renderedEnabled === true; }
  function screenChanged() {
    const st = statusNow();
    return !!(st && st.enabled) !== vs.renderedEnabled || !(st && st.ready === false) !== vs.renderedReady;
  }
  /** Every re-render caused by an async result goes through here (sync / enable done or failed). */
  function afterAsync() {
    if (onSettingsForm() && !screenChanged()) { refreshStatusLine(); return; }
    schedule(0);
  }
  function onData(p) {
    const type = p && p.type;
    if (type !== 'status') bump();
    if (!isActive()) return;
    if (screenChanged()) { schedule(); return; }   // consent / waiting / enabled: another screen
    if (type === 'status' || type === 'error') {
      const st = statusNow();
      if ((vs.renderedSyncing && !(st && st.syncing)) || type === 'error') { if (onSettingsForm()) refreshStatusLine(); else schedule(); return; }
      refreshStatusLine();
      return;
    }
    if (onSettingsForm() || vs.dialog) { refreshStatusLine(); return; }   // never wipe a form or a frozen check-in
    schedule();
  }
  function onEvent(name, payload) {
    if (name === 'hidden') {
      vs.shown = false;
      if (vs.timer) { clearTimeout(vs.timer); vs.timer = null; }
      return;
    }
    if (name === 'state') {
      // capture state: refresh the sync line only (no recompute here); a new account re-initialises on the next render
      const uid = payload && payload.userId != null ? payload.userId : null;
      if (vs.initState !== 'idle' && uid !== vs.initUserId) { schedule(0); return; }
      refreshStatusLine();
      setTimeout(maybeAutoSync, 0);
      return;
    }
    if (name === 'registry' || name === 'registry-progress') {
      refreshStatusLine();
      if (!payload || payload.phase === 'done' || payload.phase === 'error') setTimeout(maybeAutoSync, 0);
    }
  }
  function unmount() {
    if (vs.unsub) { try { vs.unsub(); } catch (e) { /* ignore */ } vs.unsub = null; }
    if (vs.timer) { clearTimeout(vs.timer); vs.timer = null; }
    vs.ctx = null; vs.shown = false; vs.statusBox = null;
  }
  function maybeInit(ctx) {
    let uid = null;
    try { const c = ctx.capState(); uid = c && c.userId != null ? c.userId : null; } catch (e) { uid = null; }
    if (vs.initState !== 'idle' && vs.initUserId === uid) return;
    const d = D();
    vs.initUserId = uid;
    if (!d || typeof d.init !== 'function') { vs.initState = 'done'; return; }
    vs.initState = 'loading';
    const seq = ++vs.initSeq;
    dcallAsync('init', []).then(() => {
      if (seq !== vs.initSeq) return;
      vs.initState = 'done'; bump(); schedule(0);
    }, (e) => {
      if (seq !== vs.initSeq) return;
      vs.initState = 'done'; note('problem', 'The stored TDEE data could not be loaded: ' + errMsg(e)); schedule(0);
    });
  }

  function render(ctx) {
    vs.ctx = ctx;
    subscribe();
    if (!vs.shown) vs.syncOnShow = true;   // opened (again): consumed once the enabled view is on screen
    vs.shown = true;
    vs.statusBox = null;
    const root = el('div', { class: 'cma-tdee' });
    ctx.body.appendChild(root);
    if (!D()) {
      root.appendChild(msgEl('The TDEE data layer (src/tdee/tdee-data.js) is not loaded, so there is nothing to show.', 'problem'));
      return;
    }
    maybeInit(ctx);
    if (vs.initState !== 'done') {
      root.appendChild(el('div', { class: 'cma-muted cma-tdee-loading' }, 'Loading stored TDEE data…'));
      return;
    }
    const st = statusNow();
    vs.renderedEnabled = !!(st && st.enabled);
    vs.renderedSyncing = !!(st && st.syncing);
    vs.renderedReady = !(st && st.ready === false);
    if (st && st.ready === false) { renderWaiting(root); return; }
    if (!st || !st.enabled) { renderConsent(root, st); return; }
    if (vs.syncOnShow) { vs.syncOnShow = false; setTimeout(maybeAutoSync, 0); }
    const s = settingsNow();
    const u = unitsFor(s, st);
    const today = todayIso();
    renderMsg(root);
    if (vs.dialog) renderDialog(root, u);
    else {
      renderSubNav(root);
      if (vs.sub === 'history') renderHistory(root, s, u, today);
      else if (vs.sub === 'settings') renderSettings(root, s, u, st, today);
      else renderOverview(root, s, u, st, today);
    }
    // spec §6.7: the disclaimer stays in view (Settings carries it in its body, next to its Save button)
    if (!ctx.footer.firstChild) ctx.footer.appendChild(el('span', { class: 'cma-muted cma-small' }, DISCLAIMER));
  }

  // ---------------------------------------------------------------------------
  // Pieces shared by the screens
  // ---------------------------------------------------------------------------
  /** A button in the view's neutral style (never the panel's green primary / red danger classes). Errors thrown
   *  by the handler land in the view's own message box, not in the panel's red notice. */
  function btn(label, fn, opts) {
    const o = Object.assign({}, opts || {});
    const cls = 'cma-tdee-btn' + (o.strong ? ' cma-tdee-primary' : '') + (o.class ? ' ' + o.class : '');
    return vs.ctx.btn(label, (ev) => guard(fn, ev), { small: !!o.small, title: o.title, disabled: o.disabled, data: o.data, class: cls });
  }
  function guard(fn, ev) {
    const fail = (e) => { note('problem', errMsg(e)); rerender(false); };
    try {
      const r = fn(ev);
      if (r && typeof r.then === 'function') return r.then(null, fail);
    } catch (e) { fail(e); }
    return undefined;
  }
  function msgEl(text, kind) {
    return el('div', { class: 'cma-tdee-msg' + (kind === 'problem' ? ' cma-tdee-msg-problem' : ''), role: 'status' }, el('span', { class: 'cma-tdee-msg-text' }, text));
  }
  function renderMsg(root) {
    if (!vs.msg) return;
    const box = msgEl(vs.msg.text, vs.msg.kind);
    const x = btn('×', () => { vs.msg = null; rerender(false); }, { small: true, title: 'Dismiss', class: 'cma-tdee-msg-x' });
    x.setAttribute('aria-label', 'Dismiss message');
    box.appendChild(x);
    root.appendChild(box);
  }
  function card(cls, title) {
    const c = el('div', { class: 'cma-tdee-card' + (cls ? ' ' + cls : '') });
    if (title) c.appendChild(el('div', { class: 'cma-tdee-card-h' }, title));
    return c;
  }
  function renderSubNav(root) {
    const nav = el('div', { class: 'cma-tdee-subnav', role: 'group', 'aria-label': 'TDEE sections' });
    for (const [id, label] of [['overview', 'Overview'], ['history', 'History'], ['settings', 'Settings']]) {
      nav.appendChild(el('button', {
        type: 'button', class: 'cma-tdee-seg', 'aria-pressed': vs.sub === id ? 'true' : 'false', data: { sub: id },
        on: { click: (ev) => { ev.preventDefault(); if (vs.sub !== id) { vs.sub = id; vs.confirmDelete = false; vs.settingsNote = ''; vs.msg = null; vs.draft = null; rerender(true); } } }
      }, label));
    }
    root.appendChild(nav);
  }
  /** Why the view cannot refresh right now (the same gates the data layer applies), or null. */
  function gateText() {
    const c = vs.ctx;
    if (!c) return null;
    let rebuilding = false, mismatch = false, ready = true;
    try { rebuilding = !!c.rebuildInProgress(); } catch (e) { rebuilding = false; }
    if (rebuilding) return 'Decoder rebuilding — refreshing waits until it is done (stored data is shown).';
    try { mismatch = !!c.registryMismatch(); } catch (e) { mismatch = false; }
    if (mismatch) return 'Cronometer deployed a new build — refreshing is paused until the decoder is rebuilt (see the Input view). Stored data is shown.';
    try { ready = !!c.readiness().ok; } catch (e) { ready = false; }
    if (!ready) return 'The Cronometer session is not captured — reload the Cronometer tab to refresh (stored data is shown).';
    return null;
  }
  function syncLine(st) {
    if (st.syncing) {
      const p = st.progress && typeof st.progress === 'object' ? st.progress : null;
      const prog = p && finite(p.total) && Number(p.total) > 0 ? ' ' + num(p.done) + '/' + num(p.total) : '';
      return 'Reading from Cronometer' + (st.phase ? ' (' + redactText(st.phase) + prog + ')' : prog) + '…';
    }
    const at = Math.max(num(st.lastDeltaAt), num(st.lastFullAt));
    return at > 0 ? 'Last refreshed ' + (vs.ctx && vs.ctx.formatAgo ? vs.ctx.formatAgo(at) : new Date(at).toLocaleString()) : 'Not refreshed yet';
  }
  function fillStatus(box) {
    clear(box);
    const st = statusNow() || {};
    const gate = gateText();
    box.appendChild(el('div', { class: 'cma-tdee-sync-line' }, syncLine(st)));
    if (gate) box.appendChild(el('div', { class: 'cma-tdee-gate' }, gate));
    else if (st.blockedReason) box.appendChild(el('div', { class: 'cma-tdee-gate' }, 'Refreshing is paused: ' + redactText(st.blockedReason)));
    if (st.lastError) box.appendChild(el('div', { class: 'cma-tdee-sync-err' }, 'Last refresh failed: ' + redactText(st.lastError)));
    else if (st.notes) box.appendChild(el('div', { class: 'cma-tdee-sync-note' }, 'Last refresh: some data was unavailable — ' + redactText(st.notes)));
    const c = st.counts && typeof st.counts === 'object' ? st.counts : null;
    if (c && finite(c.days)) {
      const r = st.range && st.range.from && st.range.to ? ' (' + fmtDate(st.range.from) + ' – ' + fmtDate(st.range.to) + ')' : '';
      box.appendChild(el('div', { class: 'cma-tdee-counts' }, 'Stored: ' + fmtInt(c.days) + ' days, ' + fmtInt(c.weighIns) + ' weigh-ins' + r));
    }
    const off = !!st.syncing || !!gate;
    box.appendChild(el('div', { class: 'cma-tdee-actions' },
      btn('Refresh', () => runSync(false, false), { small: true, disabled: off, title: 'Read the last 14 days again from Cronometer', class: 'cma-tdee-refresh' }),
      btn('Refresh all', () => runSync(true, false), { small: true, disabled: off, title: 'Read the whole history again from Cronometer', class: 'cma-tdee-refresh-all' })));
  }
  function refreshStatusLine() { if (vs.statusBox && vs.statusBox.isConnected) fillStatus(vs.statusBox); }
  /** A button press forces the delta (the data layer otherwise refreshes at most every 10 min); the automatic
   *  refresh on open leaves that throttle to the data layer. */
  function runSync(full, auto) {
    if (!D() || typeof D().sync !== 'function') return Promise.resolve(null);
    log((auto ? 'automatic ' : '') + (full ? 'full refresh' : 'refresh') + ' requested');
    const opts = full ? { full: true } : auto ? { full: false } : { full: false, force: true };
    const p = dcallAsync('sync', [opts]).then((r) => { bump(); afterAsync(); return r; }, (e) => {
      note('problem', 'Refresh failed: ' + errMsg(e)); afterAsync(); return null;
    });
    setTimeout(refreshStatusLine, 0);
    return p;
  }
  /** Refresh on open (recipe §8): delta when older than 10 min, full when the last full one is a week old. */
  function maybeAutoSync() {
    if (!isActive()) return;
    const d = D();
    if (!d || typeof d.sync !== 'function') return;
    const st = statusNow();
    if (!st || !st.enabled || st.syncing || gateText()) return;
    const now = Date.now();
    if (now - vs.lastAutoSyncAt < AUTO_SYNC_MIN_MS) return;
    const lastFull = num(st.lastFullAt);
    const last = Math.max(lastFull, num(st.lastDeltaAt));
    const full = !(lastFull > 0) || now - lastFull > FULL_SYNC_MS;
    if (!full && now - last < AUTO_SYNC_MIN_MS) return;
    vs.lastAutoSyncAt = now;
    runSync(full, true);
  }

  // ---------------------------------------------------------------------------
  // Consent (spec §2.2: the history is read only after the user enables the feature)
  // ---------------------------------------------------------------------------
  function renderConsent(root, st) {
    renderMsg(root);
    const c = card('cma-tdee-consent', 'Adaptive TDEE');
    c.appendChild(el('div', { class: 'cma-tdee-consent-h' }, 'Your real energy expenditure, learned from your own log'));
    c.appendChild(el('p', null, 'Estimates how much energy you actually burn from the food you log and how your weight trends (the approach MacroFactor uses), shows how that compares with Cronometer’s estimate, and suggests a calorie and macro target once a week.'));
    c.appendChild(el('p', null, 'When you enable it, the extension reads from Cronometer, through the session of this tab (the same requests the app itself makes): your daily energy intake, Cronometer’s energy-burned figures (BMR, activity, exercise, thermic effect of food) and your weight history, plus which days have food logged or are marked complete, the first day with data and three of your Cronometer settings (TEF, kcal or kJ, weight unit). It reads up to five years at first, then recent days when you open this tab and after you edit the diary in this tab (also while the panel is closed). The copy is stored only in this browser (chrome.storage.local, for one Cronometer account at a time: enabling it for another account replaces the stored copy) and is sent nowhere else. “Delete TDEE data” in the TDEE settings removes it.'));
    c.appendChild(el('p', { class: 'cma-small' }, 'Privacy policy: ',
      el('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener noreferrer', class: 'cma-tdee-link' }, 'PRIVACY.md'),
      ' (what is stored and how to delete it).'));
    c.appendChild(el('p', { class: 'cma-tdee-disclaimer' }, DISCLAIMER));
    const enableBtn = btn('Enable', () => enableFeature(), { strong: true, class: 'cma-tdee-enable', title: 'Read your intake, burned and weight history from Cronometer and start the estimate' });
    c.appendChild(el('div', { class: 'cma-tdee-actions' }, enableBtn, el('span', { class: 'cma-muted cma-small' }, 'Nothing is read until you press Enable.')));
    root.appendChild(c);
    if (st && st.lastError) root.appendChild(msgEl('Last error: ' + redactText(st.lastError), 'problem'));
    vs.draft = null;
  }
  function enableFeature() {
    log('TDEE enabled by the user');
    note(null, null);
    const p = dcallAsync('enable', []).then(() => {
      const st = statusNow();
      // the data layer refuses (quietly) while the account of this tab is unknown
      if (!(st && st.enabled)) note('problem', 'The Cronometer account of this tab is not known yet: reload the Cronometer tab, then press Enable again.');
      bump(); afterAsync();
    }, (e) => { note('problem', 'Enabling failed: ' + errMsg(e)); afterAsync(); });
    schedule(30);   // enable() sets `enabled` and then runs the first backfill: show the progress meanwhile
    return p;
  }
  /** The data layer does not know the account of this tab yet (status().ready === false): show nothing stored. */
  function renderWaiting(root) {
    vs.draft = null;
    renderMsg(root);
    const c = card('cma-tdee-waiting', 'Adaptive TDEE');
    c.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'Waiting for the Cronometer account of this tab'));
    c.appendChild(el('div', { class: 'cma-tdee-note' }, 'Stored TDEE data is shown only to the account it belongs to. Open the diary, or reload the Cronometer tab if this stays.'));
    const gate = gateText();
    if (gate) c.appendChild(el('div', { class: 'cma-tdee-note' }, gate));
    root.appendChild(c);
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------
  function renderOverview(root, s, u, st, today) {
    const m = currentModel(s, today);
    const days = daysNow();
    renderTrustNotice(root, s, days, today);
    renderNudges(root, s, u, today, days, m);
    const grid = el('div', { class: 'cma-tdee-grid2' });
    grid.appendChild(expenditureCard(m, s, u, st));
    grid.appendChild(weekCard(m, s, u, today, days));
    root.appendChild(grid);
    if (modelOk(m)) root.appendChild(chartsCard(m, u, days, today));
    root.appendChild(numbersCard(u, st));
  }
  function expenditureCard(m, s, u, st) {
    const c = card('cma-tdee-exp', 'Expenditure');
    if (!modelOk(m)) {
      c.appendChild(emptyState(m, s, st));
    } else {
      const cur = m.current;
      c.appendChild(el('div', { class: 'cma-tdee-chip', data: { status: String(cur.status || '') } }, chipText(cur, m.days.length)));
      c.appendChild(el('div', { class: 'cma-tdee-big' },
        el('span', { class: 'cma-tdee-num' }, fmtE(cur.expenditureKcal, u)), ' ' + u.energy + '/day ',
        el('span', { class: 'cma-tdee-pm' }, '± ' + fmtE(cur.expenditureSdKcal, u))));
      const cmp = comparisonText(cur, u);
      c.appendChild(el('div', { class: 'cma-tdee-cmp' }, cmp || 'No Cronometer burned figures for the last 14 days to compare with.'));
      const facts = [];
      if (finite(cur.trendWeightKg)) facts.push('Trend weight ' + fmtW(cur.trendWeightKg, u) + (finite(cur.weeklyTrendChangeKg) ? ' (' + fmtWDelta(cur.weeklyTrendChangeKg, u, true) + ' this week)' : ''));
      // the engine averages the last 7 days, and today's intake is never counted: 6 days at most, logged ones only
      if (finite(cur.avgIntake7Kcal)) facts.push('Average logged intake, last 6 days ' + fmtEU(cur.avgIntake7Kcal, u));
      if (facts.length) c.appendChild(el('div', { class: 'cma-tdee-note' }, facts.join(' · ')));
      const pt = priorText(cur, u);
      if (pt) c.appendChild(el('div', { class: 'cma-tdee-note' }, pt));
    }
    vs.statusBox = el('div', { class: 'cma-tdee-sync' });
    fillStatus(vs.statusBox);
    c.appendChild(vs.statusBox);
    return c;
  }
  function emptyState(m, s, st) {
    const box = el('div', { class: 'cma-tdee-empty' });
    const counts = st && st.counts ? st.counts : {};
    const err = m ? m.error : null;
    if (st && st.syncing && !(num(counts.days) > 0)) {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'Reading your Cronometer history…'));
      box.appendChild(el('div', { class: 'cma-tdee-note' }, 'This takes a few seconds the first time; the estimate appears when it is done.'));
    } else if (err === 'NO_WEIGHT_DATA') {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'Log a weigh-in in Cronometer to start'));
      box.appendChild(el('div', { class: 'cma-tdee-note' }, 'The estimate starts on the day of your first weigh-in' + (s.modelStartDate ? ' on or after the model start date (' + fmtDate(s.modelStartDate) + ')' : '') + '; weighing in 3 or more times a week makes it more accurate.'));
    } else if (err === 'NO_PRIOR' && s.modelStartDate && s.modelStartDate >= todayIso() && s.manualInitialKcal == null) {
      // started again today: today's figures are partial, so the first estimate comes from tomorrow's complete day
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'The estimate starts again from today'));
      box.appendChild(el('div', { class: 'cma-tdee-note' }, 'The first estimate appears tomorrow, from today’s complete Cronometer figures — or set a starting estimate in the TDEE settings to see one now.'));
    } else if (err === 'NO_PRIOR' && !(num(counts.intakeDays) > 0) && st && (st.blockedReason || gateText() || !st.lastFullAt)) {
      // the first sync paused (or has not finished) before the food log was read: not a user who logs nothing
      const why = gateText() || (st.blockedReason ? 'Reading is paused: ' + redactText(st.blockedReason) : 'It is read with the first complete refresh.');
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'Your food log has not been read yet'));
      box.appendChild(el('div', { class: 'cma-tdee-note' }, why));
    } else if (err === 'NO_PRIOR') {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'Log your food for a few days to start'));
      box.appendChild(el('div', { class: 'cma-tdee-note' }, 'The first estimate comes from Cronometer’s burned figures or your logged intake; you can also set a starting estimate in the TDEE settings.'));
    } else if (err === 'NO_ENGINE') {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'The TDEE engine (src/tdee/adaptive-tdee.js) is not loaded.'));
    } else if (err === 'NO_DATA_LAYER') {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'The TDEE data layer cannot provide records.'));
    } else {
      box.appendChild(el('div', { class: 'cma-tdee-empty-h' }, 'No estimate yet'));
      if (m && m.message) box.appendChild(el('div', { class: 'cma-tdee-note' }, 'The estimate could not be computed: ' + m.message));
    }
    return box;
  }
  function weekCard(m, s, u, today, days) {
    const c = card('cma-tdee-week', 'This week');
    const cis = checkinsNow();
    const info = checkInInfo(m, s, cis, today);
    const acc = info.lastAccepted;
    let target = null, macros = null, preview = false;
    if (acc) { target = Number(acc.targetKcal); macros = acc.macros; }
    else if (modelOk(m)) {
      let p = null;
      try { p = runCheckIn(m, s, info); } catch (e) { p = null; }
      if (p && finite(p.targetKcal)) { target = p.targetKcal; macros = p.macros; preview = true; }
    }
    if (target != null) {
      c.appendChild(el('div', { class: 'cma-tdee-target' },
        el('span', { class: 'cma-tdee-num' }, fmtE(target, u)), ' ' + u.energy + '/day',
        preview ? el('span', { class: 'cma-tdee-tag' }, 'preview') : null));
      c.appendChild(el('div', { class: 'cma-tdee-note' }, preview ? 'Suggested target — check in to set it.' : 'Target since the check-in on ' + fmtDay(acc.date) + '; it changes only at a check-in.'));
      const mt = macrosText(macros);
      if (mt) c.appendChild(el('div', { class: 'cma-tdee-macros' }, mt));
      if (modelOk(m)) {
        const perWeek = ((target - Number(m.current.expenditureKcal)) * 7) / KCAL_PER_KG;
        c.appendChild(el('div', { class: 'cma-tdee-expect' }, '≈ ' + fmtWDelta(perWeek, u, true) + '/week if you hit it'));
        if (s.activityAware) {
          const line = activityAwareLine(m, target, u, today, days, s);
          if (line) c.appendChild(el('div', { class: 'cma-tdee-aa' }, line, el('div', { class: 'cma-tdee-note' }, ACTIVITY_AWARE_LABEL)));
        }
      }
      if (!preview) {
        c.appendChild(el('div', { class: 'cma-tdee-actions' },
          btn('Copy target', () => copyTarget(target, u), { small: true, class: 'cma-tdee-copy', title: 'Copy the number to paste it into Cronometer → Targets' }),
          el('span', { class: 'cma-muted cma-small' }, 'Set it in Cronometer → Targets.')));
      }
    } else {
      c.appendChild(el('div', { class: 'cma-tdee-note' }, 'No target yet: the first check-in sets one.'));
    }
    let when;
    if (info.due) when = info.byGoal ? 'Your goal changed — you can check in now.' : 'Check-in due today.';
    else if (!info.enoughData) when = modelOk(m) ? 'First check-in after ' + FIRST_CHECKIN_DAYS + ' days of data (' + info.daysToGo + ' to go).' : 'The first check-in needs an estimate first.';
    else when = 'Next check-in: ' + fmtDay(info.next) + ' (' + WEEKDAYS[s.checkInWeekday] + 's).';
    c.appendChild(el('div', { class: 'cma-tdee-next' }, when));
    c.appendChild(el('div', { class: 'cma-tdee-actions' },
      btn('Check in', () => openCheckIn(), { strong: info.due, disabled: !info.due, class: 'cma-tdee-checkin', title: info.due ? 'Review the new target' : 'Not due yet' }),
      btn('Skip this week', () => skipFromCard(), { disabled: !info.due, class: 'cma-tdee-skip', title: 'Keep the current target this week (recorded as skipped)' })));
    return c;
  }
  /** The sex-specific calorie floor weeklyCheckIn applies (DEFAULT_CHECKIN.minKcal), in kcal. */
  function floorKcal(sex) {
    const t = T();
    const f = (t && t.DEFAULT_CHECKIN && t.DEFAULT_CHECKIN.minKcal) || { female: 1200, male: 1500, other: 1350 };
    return finite(f[sex]) ? Number(f[sex]) : Number(f.other);
  }
  /**
   * The experimental activity-aware line (spec §4.4): the engine's activityAwareDailyTarget, unchanged, then two view
   * rules. Today's Cronometer burned is PARTIAL while the day runs (TEF follows the food logged so far, exercise and
   * tracker syncs come later), so a below-average figure never lowers the target: the line only adds food for
   * activity above the 14-day average. And it never goes under the calorie floor the weekly check-in enforces. The
   * note comes from the inputs, not from the result.
   */
  function activityAwareLine(m, target, u, today, days, s) {
    const t = T();
    if (!t || typeof t.activityAwareDailyTarget !== 'function') return null;
    const cur = m.current;
    const last = m.days[m.days.length - 1];
    let burned = last && last.date === today ? last.cronometerBurnedKcal : null;
    if (burned == null) { const d = days.find(x => x.date === today); burned = d && finite(d.burnedKcal) ? Number(d.burnedKcal) : null; }
    const ratio = cur.cronometerCalibrationRatio, avg = cur.cronometerBurned14Kcal;
    const raw = t.activityAwareDailyTarget({ weeklyTargetKcal: target, calibrationRatio: ratio, cronometerBurnedAvgKcal: avg, cronometerBurnedTodayKcal: burned });
    let v = finite(raw) ? Number(raw) : Number(target), note = '';
    if (burned == null) note = ' (no Cronometer figure for today yet)';
    else if (!(Number(ratio) > 0) || !(Number(avg) > 0)) note = ' (no Cronometer burned average to compare with)';
    else if (v < target) { v = Number(target); note = ' (activity so far is below your average: not lowered while the day runs)'; }
    const floor = floorKcal(s ? s.sex : 'other');
    if (v < floor) { v = floor; note = ' (kept at the ' + fmtEU(floor, u) + ' minimum)'; }
    return 'Today: ' + fmtEU(v, u) + note;
  }
  function copyTarget(targetKcal, u) {
    const text = String(Math.round(eVal(targetKcal, u)));
    const c = vs.ctx;
    const p = c && typeof c.copyText === 'function' ? c.copyText(text) : Promise.resolve(false);
    return Promise.resolve(p).then((ok) => { note('info', ok ? 'Target copied: paste it into Cronometer → Targets.' : 'Copy failed — the target is ' + fmtEU(targetKcal, u) + '.'); rerender(false); });
  }
  /** 'Only trust completed days' ignores the food of every day not marked complete. Most people never mark days, so
   *  when it is on, say how many recent logged days it is ignoring (live 2026-09-28: switched on with 52 logged days
   *  and nothing on the overview told the user what it cost). Shown whether or not the model has an estimate. */
  function renderTrustNotice(root, s, days, today) {
    if (!s || !s.trustCompleteOnly) return;
    const from = addDays(today, -28);                                  // the engine's, or the view's own calendar maths
    const recent = (days || []).filter(d => d && d.date < today && d.date >= from && (!s.modelStartDate || d.date >= s.modelStartDate));
    const logged = recent.filter(d => d.intakeKcal != null);
    const ignored = logged.filter(d => d.excludedReason === 'incomplete');
    if (!ignored.length) return;
    root.appendChild(el('div', { class: 'cma-tdee-nudges' }, el('div', { class: 'cma-tdee-nudge cma-tdee-trust' },
      el('span', null, 'Only completed days are trusted: ' + ignored.length + ' of the ' + logged.length
        + ' days you logged in the last 4 weeks are ignored because they are not marked complete in Cronometer.'),
      btn('Change in settings', () => { vs.sub = 'settings'; vs.confirmDelete = false; vs.settingsNote = ''; vs.msg = null; vs.draft = null; rerender(true); },
        { small: true, class: 'cma-tdee-trust-settings', title: 'Open the TDEE settings ("Only trust completed days")' }))));
  }
  function renderNudges(root, s, u, today, days, m) {
    if (!modelOk(m)) return;
    const slot = checkInInfo(m, s, [], today).slot;
    const dismissed = (key) => vs.dismissed[key] === slot || s.nudges[key] === slot;
    const items = [];
    if (!dismissed('partial')) {
      const partial = days.filter(d => d.partialSuspect && d.excludedReason === 'partial' && d.date < today).slice(-3).reverse();
      for (const d of partial) {
        items.push(el('div', { class: 'cma-tdee-nudge cma-tdee-partial', data: { date: d.date } },
          el('span', null, fmtDay(d.date) + ': ' + fmtEU(d.intakeKcal, u) + ' logged — Fully logged?'),
          btn('Exclude', () => setOverride(d.date, true), { small: true, class: 'cma-tdee-p-exclude', title: 'Treat this day as not fully logged (it is skipped)' }),
          btn('Yes, I ate little', () => setOverride(d.date, false), { small: true, class: 'cma-tdee-p-keep', title: 'Keep this day as logged' })));
      }
      if (partial.length) items.push(el('div', { class: 'cma-tdee-note' }, 'Days that look partly logged are skipped until you answer.', ' ', btn('Not now', () => dismissNudge('partial', slot, s), { small: true, class: 'cma-tdee-dismiss-partial' })));
    }
    const wt = dismissed('weighIn') ? null : weighInNudgeText(days, today);
    if (wt) {
      items.push(el('div', { class: 'cma-tdee-nudge cma-tdee-weighin' }, el('span', null, wt),
        btn('Dismiss', () => dismissNudge('weighIn', slot, s), { small: true, class: 'cma-tdee-dismiss-weighin', title: 'Hide this until next week' })));
    }
    if (items.length) root.appendChild(el('div', { class: 'cma-tdee-nudges' }, items));
  }
  function dismissNudge(key, slot, s) {
    vs.dismissed[key] = slot;
    const nudges = Object.assign({}, s.nudges, { [key]: slot });
    rerender(false);
    return dcallAsync('saveSettings', [{ nudges }]).then(() => { bump(); }, () => { /* kept for this page */ });
  }
  function setOverride(date, value) {
    log('day override set (' + (value === true ? 'exclude' : value === false ? 'fully logged' : 'cleared') + ')');
    return dcallAsync('setOverride', [date, value]).then(() => { bump(); schedule(0); });
  }

  // ---- charts: plain SVG, one path per series, a few labels ----
  const CW = 680, CH = 176, PL = 50, PR = 10, PT = 8, PB = 22;
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) { const v = attrs[k]; if (v != null && v !== false) e.setAttribute(k, String(v)); }
    if (text != null) e.textContent = String(text);
    return e;
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function niceScale(lo, hi, want) {
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { const pad = Math.abs(lo) * 0.02 || 1; lo -= pad; hi += pad; }
    const raw = (hi - lo) / Math.max(1, want);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(x => x >= raw * (1 - 1e-9));
    const start = Math.floor(lo / step + 1e-9) * step;
    const end = Math.ceil(hi / step - 1e-9) * step;
    const ticks = [];
    for (let k = Math.round(start / step); k <= Math.round(end / step); k++) ticks.push(k * step);
    return { lo: start, hi: end > start ? end : start + step, ticks, step };
  }
  function tickDecimals(step) { return step >= 1 ? 0 : step >= 0.1 ? 1 : 2; }
  function xTickIdx(n, k) {
    if (n <= 1) return [0];
    const out = [];
    for (let j = 0; j < k; j++) { const i = Math.round((j * (n - 1)) / (k - 1)); if (out.indexOf(i) < 0) out.push(i); }
    return out;
  }
  function fmtTickDate(iso, long) { const p = isoParts(iso); return !p ? '' : long ? MONTHS[p.m - 1] + ' ' + p.y : p.d + ' ' + MONTHS[p.m - 1]; }
  function linePath(vals, X, Y) {
    let d = '', pen = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + r1(X(i)) + ' ' + r1(Y(v));
      pen = true;
    }
    return d;
  }
  function bandPath(hiVals, loVals, X, Y) {
    const n = hiVals.length;
    if (!n) return '';
    let d = '';
    for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + r1(X(i)) + ' ' + r1(Y(hiVals[i]));
    for (let i = n - 1; i >= 0; i--) d += 'L' + r1(X(i)) + ' ' + r1(Y(loVals[i]));
    return d + 'Z';
  }
  /** Many dots in ONE path node: each dot is a closed pair of arcs. */
  function dotsPath(points, r) {
    let d = '';
    for (const p of points) d += 'M' + r1(p[0] - r) + ' ' + r1(p[1]) + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0';
    return d;
  }
  function chartFrame(o) {
    const n = o.dates.length;
    const sc = niceScale(o.lo, o.hi, 4);
    const plotW = CW - PL - PR, plotH = CH - PT - PB;
    const X = (i) => PL + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const Y = (v) => PT + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
    const Yc = (v) => Math.max(PT, Math.min(PT + plotH, Y(v)));
    const svg = svgEl('svg', { class: 'cma-tdee-svg ' + o.cls, viewBox: '0 0 ' + CW + ' ' + CH, role: 'img', 'aria-label': o.title + ' (Left / Right arrow keys read one day at a time)' });
    let grid = '';
    for (const t of sc.ticks) grid += 'M' + PL + ' ' + r1(Y(t)) + 'H' + (CW - PR);
    svg.appendChild(svgEl('path', { class: 'cma-tdee-l-grid', d: grid }));
    const dec = tickDecimals(sc.step);
    for (const t of sc.ticks) svg.appendChild(svgEl('text', { x: PL - 6, y: r1(Y(t) + 3.5), 'text-anchor': 'end' }, o.tickFmt(t, dec)));
    for (const i of xTickIdx(n, 5)) {
      const anchor = n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';
      svg.appendChild(svgEl('text', { x: r1(X(i)), y: CH - 6, 'text-anchor': anchor }, fmtTickDate(o.dates[i], o.long)));
    }
    return { svg, X, Y, Yc, sc, n, plotW, plotH };
  }
  /** Hover readout; the chart is also focusable: Left / Right move a day, Home / End jump (a readout for keyboards). */
  function attachHover(f, readoutEl, readout) {
    const cursor = svgEl('path', { class: 'cma-tdee-l-cursor', d: '' });
    f.svg.appendChild(cursor);
    let at = f.n - 1;
    const show = (i) => { readoutEl.textContent = f.n ? readout(i) : ''; };
    const moveTo = (i) => { at = i; cursor.setAttribute('d', 'M' + r1(f.X(i)) + ' ' + PT + 'V' + (PT + f.plotH)); show(i); };
    f.svg.setAttribute('tabindex', '0');
    f.svg.addEventListener('mousemove', (ev) => {
      const r = f.svg.getBoundingClientRect();
      if (!r.width || f.n < 1) return;
      const vx = ((ev.clientX - r.left) * CW) / r.width;
      moveTo(f.n <= 1 ? 0 : Math.max(0, Math.min(f.n - 1, Math.round(((vx - PL) * (f.n - 1)) / f.plotW))));
    });
    f.svg.addEventListener('mouseleave', () => { cursor.setAttribute('d', ''); at = f.n - 1; show(f.n - 1); });
    f.svg.addEventListener('keydown', (ev) => {
      if (f.n < 1) return;
      const k = ev.key;
      const i = k === 'ArrowLeft' ? Math.max(0, at - 1) : k === 'ArrowRight' ? Math.min(f.n - 1, at + 1) : k === 'Home' ? 0 : k === 'End' ? f.n - 1 : null;
      if (i === null) return;
      ev.preventDefault();
      moveTo(i);
    });
    f.svg.addEventListener('blur', () => { cursor.setAttribute('d', ''); });
    show(f.n - 1);
  }
  /** Cronometer's burned, trailing 7-day mean of the days that have it (today's partial figure left out). */
  function burned7(days, today) {
    const out = new Array(days.length).fill(null);
    const ok = (d) => d && d.date !== today && finite(d.cronometerBurnedKcal);
    let sum = 0, cnt = 0;
    for (let i = 0; i < days.length; i++) {
      if (ok(days[i])) { sum += Number(days[i].cronometerBurnedKcal); cnt++; }
      if (i >= 7 && ok(days[i - 7])) { sum -= Number(days[i - 7].cronometerBurnedKcal); cnt--; }
      out[i] = cnt > 0 ? sum / cnt : null;
    }
    return out;
  }
  function legend(items) {
    return el('div', { class: 'cma-tdee-legend' }, items.map(([cls, label]) => el('span', null, el('span', { class: 'cma-tdee-sw ' + cls }), label)));
  }
  function chartsCard(m, u, days, today) {
    const c = card('cma-tdee-charts');
    const head = el('div', { class: 'cma-tdee-charts-h' }, el('span', { class: 'cma-tdee-card-h' }, 'Trends'));
    const ranges = el('span', { class: 'cma-tdee-range', role: 'group', 'aria-label': 'Chart range' });
    for (const [d, label] of RANGES) {
      ranges.appendChild(el('button', {
        type: 'button', class: 'cma-tdee-seg cma-tdee-seg-small', 'aria-pressed': vs.range === d ? 'true' : 'false', data: { range: String(d) },
        on: { click: (ev) => { ev.preventDefault(); if (vs.range !== d) { vs.range = d; rerender(false); } } }
      }, label));
    }
    head.appendChild(ranges);
    c.appendChild(head);
    const all = m.days;
    const n = vs.range > 0 ? Math.min(vs.range, all.length) : all.length;
    const start = all.length - n;
    const win = all.slice(start);
    const avg = burned7(all, today).slice(start);
    const long = n > 400;
    const dates = win.map(d => d.date);
    const span = win.length ? fmtDate(win[0].date) + ' – ' + fmtDate(win[win.length - 1].date) : '';

    // expenditure: ±1 SD band, the estimate, Cronometer's 7-day average burned (faint)
    const E = win.map(d => eVal(d.expenditureKcal, u));
    const up = win.map(d => eVal(Number(d.expenditureKcal) + Number(d.expenditureSdKcal || 0), u));
    const dn = win.map(d => eVal(Number(d.expenditureKcal) - Number(d.expenditureSdKcal || 0), u));
    const c7 = avg.map(v => (v == null ? null : eVal(v, u)));
    const er = minMax(up.concat(dn, c7)) || [0, 1];
    const f1 = chartFrame({ cls: 'cma-tdee-chart-exp', title: 'Expenditure, ' + span, dates, lo: er[0], hi: er[1], tickFmt: (v) => fmtInt(v), long });
    f1.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-band', d: bandPath(up, dn, f1.X, f1.Y) }));
    f1.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-faint', d: linePath(c7, f1.X, f1.Y) }));
    f1.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-main', d: linePath(E, f1.X, f1.Y) }));
    const ro1 = el('div', { class: 'cma-tdee-readout', 'aria-live': 'polite' });
    attachHover(f1, ro1, (i) => {
      const d = win[i];
      return fmtDay(d.date) + ' · expenditure ' + fmtEU(d.expenditureKcal, u) + ' ± ' + fmtE(d.expenditureSdKcal, u) +
        (avg[i] != null ? ' · Cronometer 7-day average ' + fmtEU(avg[i], u) : '') + ' · ' + (d.status === 'holding' ? 'paused' : d.status === 'warmup' ? 'warm-up' : 'updating');
    });
    c.appendChild(el('div', { class: 'cma-tdee-chart-h' }, 'Expenditure (' + u.energy + '/day)'));
    c.appendChild(f1.svg);
    c.appendChild(legend([['cma-tdee-sw-line', 'Your expenditure'], ['cma-tdee-sw-band', '±1 SD'], ['cma-tdee-sw-faint', 'Cronometer burned, 7-day average']]));
    c.appendChild(ro1);

    // weight: scale weigh-ins as dots, the trend as a line, outliers and excluded days marked subtly
    const excluded = new Set(days.filter(d => d.excluded).map(d => d.date));
    const trend = win.map(d => (finite(d.trendWeightKg) ? wVal(d.trendWeightKg, u) : null));
    const pts = [], outs = [];
    const vals = trend.slice();
    win.forEach((d, i) => {
      if (!finite(d.scaleWeightKg)) return;
      const v = wVal(d.scaleWeightKg, u);
      if (d.weightOutlier) outs.push([i, v]); else { pts.push([i, v]); vals.push(v); }
    });
    const wr = minMax(vals) || [0, 1];
    const f2 = chartFrame({ cls: 'cma-tdee-chart-weight', title: 'Weight, ' + span, dates, lo: wr[0], hi: wr[1], tickFmt: (v, dec) => fmtDec(v, dec), long });
    f2.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-dots', d: dotsPath(pts.map(p => [f2.X(p[0]), f2.Y(p[1])]), 1.8) }));
    if (outs.length) f2.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-out', d: dotsPath(outs.map(p => [f2.X(p[0]), f2.Yc(p[1])]), 2.6) }));
    let ticks = '';
    win.forEach((d, i) => { if (excluded.has(d.date)) ticks += 'M' + r1(f2.X(i)) + ' ' + (PT + f2.plotH) + 'v-6'; });
    if (ticks) f2.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-excl', d: ticks }));
    f2.svg.appendChild(svgEl('path', { class: 'cma-tdee-l-main', d: linePath(trend, f2.X, f2.Y) }));
    const ro2 = el('div', { class: 'cma-tdee-readout', 'aria-live': 'polite' });
    attachHover(f2, ro2, (i) => {
      const d = win[i];
      return fmtDay(d.date) + ' · trend ' + fmtW(d.trendWeightKg, u) +
        (finite(d.scaleWeightKg) ? ' · scale ' + fmtW(d.scaleWeightKg, u) + (d.weightOutlier ? ' (ignored as an outlier)' : '') : ' · no weigh-in') +
        (excluded.has(d.date) ? ' · food log excluded' : '');
    });
    c.appendChild(el('div', { class: 'cma-tdee-chart-h' }, 'Weight (' + weightUnitName(u) + ')'));
    c.appendChild(f2.svg);
    const items = [['cma-tdee-sw-dot', 'Weigh-ins'], ['cma-tdee-sw-line', 'Trend weight']];
    if (outs.length) items.push(['cma-tdee-sw-ring', 'Ignored weigh-in (outlier)']);
    if (ticks) items.push(['cma-tdee-sw-tick', 'Excluded day']);
    c.appendChild(legend(items));
    c.appendChild(ro2);
    return c;
  }
  function numbersCard(u, st) {
    const c = card('cma-tdee-probe', 'Check the numbers');
    const p = dcall('probe', [], null);
    const wi = p && p.weighIn && typeof p.weighIn === 'object' && finite(p.weighIn.kg) ? p.weighIn : null;
    const weighInLine = () => el('div', null, wi ? 'Latest weigh-in: ' + fmtW(wi.kg, u) + (ISO_RE.test(String(wi.date)) ? ' (' + fmtDay(wi.date) + ')' : '') : 'No weigh-in read yet.');
    if (!p || typeof p !== 'object' || !ISO_RE.test(String(p.date))) {
      c.appendChild(el('div', { class: 'cma-tdee-note' }, 'No complete day has been read yet.'));
      if (wi) c.appendChild(weighInLine());
      return c;
    }
    const parts = p.parts && typeof p.parts === 'object' ? p.parts : {};
    // whether Cronometer adds TEF for this account: the probe says so, else the preferences in the status; when the
    // preference could not be read (prefs.assumed) the extension leaves TEF out and says so, it does not claim "off"
    const tefOff = p.tefIncluded === false || (p.tefIncluded == null && st && st.prefs && st.prefs.tef === false);
    const tefUnread = tefOff && !!(st && st.prefs && st.prefs.assumed);
    const tefText = tefUnread ? ' + TEF not counted (Cronometer’s TEF setting could not be read)' : tefOff ? ' + TEF off in Cronometer' : ' + TEF ' + fmtE(parts.tef, u);
    const line = 'Consumed ' + fmtEU(p.consumed, u) + ' · Burned ' + fmtEU(p.burned, u) +
      (p.parts ? ' (BMR ' + fmtE(parts.bmr, u) + ' + activity ' + fmtE(parts.activity, u) + ' + exercise ' + fmtE(parts.exercise, u) + tefText + ')' : '');
    const raw = Array.isArray(p.row) && p.row.length ? p.row.map(v => (finite(v) ? String(Math.round(Number(v) * 100) / 100) : 'null')).join(', ') : null;
    c.appendChild(el('div', null, 'Most recent full day: ' + fmtDayLong(p.date)));
    c.appendChild(el('div', { class: 'cma-tdee-probe-line' }, line));
    c.appendChild(weighInLine());
    c.appendChild(el('div', { class: 'cma-tdee-note cma-tdee-probe-hint' },
      "These should match the diary's Energy Summary for " + fmtDate(p.date) + ". If they don't, press “Copy these numbers”, add the diary's Consumed and Burned values and paste both into an issue (they are your own data: share only what you want). The Diagnostics dump does not contain them."));
    if (raw) {
      c.appendChild(el('details', { class: 'cma-tdee-raw' }, el('summary', null, 'Raw values from Cronometer (kcal, as sent)'), el('code', null, raw)));
    }
    // user-initiated only: the numbers go to the clipboard, never into a log line or the diagnostics dump
    const report = ['Adaptive TDEE check (Multi-Add for Cronometer), ' + p.date, line.replace(/ · /g, '\n'),
      raw ? 'Raw row (kcal, as sent): ' + raw : 'Raw row: not read in this page (press Refresh, then copy again)',
      'Cronometer TEF setting: ' + (tefUnread ? 'could not be read' : tefOff ? 'off' : 'on'),
      "Diary Energy Summary for that day: Consumed ____  Burned ____"].join('\n');
    c.appendChild(el('div', { class: 'cma-tdee-actions' },
      btn('Copy these numbers', () => copyNumbers(report), { small: true, class: 'cma-tdee-copy-numbers', title: 'Copy this day’s numbers to paste them into a report' }),
      btn('Diagnostics', () => vs.ctx.switchView('diagnostics'), { small: true, title: 'Open the Diagnostics view (counts and versions, no health values)' })));
    return c;
  }
  function copyNumbers(text) {
    const c = vs.ctx;
    const p = c && typeof c.copyText === 'function' ? c.copyText(text) : Promise.resolve(false);
    return Promise.resolve(p).then((ok) => { log('check-the-numbers copied'); note('info', ok ? 'Copied: add the diary’s Consumed and Burned values before you paste it into a report.' : 'Copy failed: select the numbers above instead.'); rerender(false); });
  }

  // ---------------------------------------------------------------------------
  // Check-in dialog (spec §4, §6.4)
  // ---------------------------------------------------------------------------
  function prepareCheckIn() {
    const s = settingsNow();
    const today = todayIso();
    const m = currentModel(s, today);
    if (!modelOk(m)) throw new Error('No estimate yet: a check-in needs at least one weigh-in and some logged food.');
    const info = checkInInfo(m, s, checkinsNow(), today);
    if (!info.due) throw new Error('No check-in is due right now.');
    const res = runCheckIn(m, s, info);
    if (!res || !finite(res.targetKcal)) throw new Error('The check-in could not be computed.');
    const cur = m.current;
    const weekAgo = m.days.length >= 8 ? m.days[m.days.length - 8] : null;
    const prevE = info.last && finite(info.last.expenditureKcal) ? Number(info.last.expenditureKcal) : weekAgo ? weekAgo.expenditureKcal : null;
    return {
      phase: 'review', today, res, rate: s.goal.ratePctPerWeek, goalChanged: !!info.goalChanged, byGoal: info.byGoal,
      prevTarget: info.lastAccepted ? Number(info.lastAccepted.targetKcal) : null,
      prevExpenditure: prevE, prevLabel: info.last ? 'the last check-in' : 'a week ago',
      cur: {
        expenditureKcal: cur.expenditureKcal, expenditureSdKcal: cur.expenditureSdKcal, trendWeightKg: cur.trendWeightKg,
        weeklyTrendChangeKg: cur.weeklyTrendChangeKg, avgIntake7Kcal: cur.avgIntake7Kcal, status: cur.status, calibrated: !!cur.calibrated
      }
    };
  }
  function openCheckIn() {
    vs.dialog = prepareCheckIn();
    vs.msg = null;
    rerender(true);
  }
  function skipFromCard() {
    const dg = prepareCheckIn();
    vs.dialog = null;
    return record(dg, false);
  }
  function record(dg, accepted) {
    if (dg.busy) return Promise.resolve();
    dg.busy = true;
    const c = {
      date: dg.today, accepted: !!accepted, targetKcal: dg.res.targetKcal, expenditureKcal: dg.cur.expenditureKcal,
      sdKcal: dg.cur.expenditureSdKcal, trendWeightKg: dg.cur.trendWeightKg, ratePctPerWeek: dg.res.ratePctPerWeek,
      macros: dg.res.macros, notes: Array.isArray(dg.res.notes) ? dg.res.notes.slice() : [],
      // beyond the contract: when (for goal-change ordering), the target it replaced, whether the cap was lifted, and the
      // goal the user had chosen (ratePctPerWeek is the engine's capped rate; a goal changed and back is no change)
      at: Date.now(), previousTargetKcal: dg.prevTarget, goalChanged: dg.goalChanged, goalRatePctPerWeek: dg.rate
    };
    return dcallAsync('recordCheckin', [c]).then(() => {
      dg.busy = false;
      log(accepted ? 'check-in accepted' : 'check-in skipped');
      bump();
      if (accepted) { dg.phase = 'accepted'; vs.dialog = dg; }
      else {
        vs.dialog = null;
        const u = unitsFor(settingsNow(), statusNow());
        note('info', 'Check-in skipped — ' + (dg.prevTarget != null ? 'your target stays ' + fmtEU(dg.prevTarget, u) + '/day.' : 'no target is set yet.'));
      }
      rerender(true);
    }, (e) => {
      dg.busy = false;
      note('problem', 'The check-in could not be saved: ' + errMsg(e));
      rerender(false);
    });
  }
  /** The engine's guardrail notes name kcal ('±250 kcal', 'the 1200 kcal minimum'); a kJ account reads kJ. */
  function noteText(n, u) {
    const s = String(n);
    if (u.energy !== 'kJ') return s;
    return s.replace(/(\d[\d,]*(?:\.\d+)?) kcal\b/g, (m0, x) => fmtInt(Number(x.replace(/,/g, '')) * KJ_PER_KCAL) + ' kJ');
  }
  function renderDialog(root, u) {
    const dg = vs.dialog;
    const box = el('div', { class: 'cma-tdee-dialog', role: 'dialog', 'aria-label': 'Weekly check-in' });
    box.appendChild(el('div', { class: 'cma-tdee-card-h' }, 'Weekly check-in · ' + fmtDay(dg.today)));
    const res = dg.res;
    if (dg.phase === 'accepted') {
      box.appendChild(el('div', { class: 'cma-tdee-newtarget' }, 'Your new target: ' + fmtEU(res.targetKcal, u)));
      const mt = macrosText(res.macros);
      if (mt) box.appendChild(el('div', { class: 'cma-tdee-macros' }, mt));
      box.appendChild(el('p', { class: 'cma-tdee-note' }, 'Set it in Cronometer → Targets (Energy). The extension only shows the target; it never changes your Cronometer targets.'));
      box.appendChild(el('div', { class: 'cma-tdee-actions' },
        btn('Copy', () => copyTarget(res.targetKcal, u), { class: 'cma-tdee-copy', title: 'Copy the number to paste it into Cronometer' }),
        btn('Done', () => { vs.dialog = null; rerender(true); }, { strong: true, class: 'cma-tdee-done' })));
      root.appendChild(box);
      return;
    }
    const change = dg.prevTarget != null ? res.targetKcal - dg.prevTarget : null;
    box.appendChild(el('div', { class: 'cma-tdee-change' }, dg.prevTarget != null
      ? fmtE(dg.prevTarget, u) + ' → ' + fmtE(res.targetKcal, u) + ' ' + u.energy + '/day (' + (change === 0 ? 'no change' : plus(fmtE(change, u), change)) + ')'
      : 'New target: ' + fmtEU(res.targetKcal, u) + '/day'));
    const mt = macrosText(res.macros);
    if (mt) box.appendChild(el('div', { class: 'cma-tdee-macros' }, mt));
    const why = el('ul', { class: 'cma-tdee-why' });
    const E = dg.cur.expenditureKcal;
    if (finite(dg.prevExpenditure)) {
      why.appendChild(el('li', null, Math.round(dg.prevExpenditure) === Math.round(E)
        ? 'Expenditure stayed at ' + fmtEU(E, u) + '/day.'
        : 'Expenditure moved from ' + fmtE(dg.prevExpenditure, u) + ' to ' + fmtEU(E, u) + '/day (since ' + dg.prevLabel + ').'));
    } else {
      why.appendChild(el('li', null, 'Expenditure is ' + fmtEU(E, u) + '/day (± ' + fmtE(dg.cur.expenditureSdKcal, u) + ').'));
    }
    if (finite(dg.cur.weeklyTrendChangeKg)) {
      why.appendChild(el('li', null, 'Your trend weight changed by ' + fmtWDelta(dg.cur.weeklyTrendChangeKg, u, true) + ' over the week' +
        (finite(dg.cur.avgIntake7Kcal) ? ' while your logged intake averaged ' + fmtEU(dg.cur.avgIntake7Kcal, u) + '/day (the 6 days before today).' : ' (no food logged this week).')));
    }
    why.appendChild(el('li', null, 'Goal: ' + goalText(res.ratePctPerWeek) + (res.ratePctPerWeek ? ' (≈ ' + fmtWDelta(res.expectedWeeklyChangeKg, u, true) + '/week)' : '') + '.'));
    if (dg.goalChanged && dg.prevTarget != null) why.appendChild(el('li', null, 'Your goal changed, so the weekly limit on target changes does not apply this time.'));
    for (const n of Array.isArray(res.notes) ? res.notes : []) why.appendChild(el('li', null, noteText(n, u)));
    box.appendChild(why);
    const accept = btn('Accept new target', () => record(dg, true), { strong: true, class: 'cma-tdee-accept' });
    setTimeout(() => { try { if (accept.isConnected) accept.focus(); } catch (e) { /* ignore */ } }, 0);   // keyboard users land in the dialog
    box.appendChild(el('div', { class: 'cma-tdee-actions' },
      accept,
      btn('Skip this week', () => record(dg, false), { class: 'cma-tdee-skip', title: 'Keep the current target (recorded as skipped)' }),
      btn('Cancel', () => { vs.dialog = null; rerender(true); }, { class: 'cma-tdee-cancel', title: 'Close without recording anything' })));
    box.appendChild(el('div', { class: 'cma-tdee-note' }, 'Skip when something unusual moved your weight this week (a new supplement, travel, illness).'));
    root.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // History (spec §6.6): per-day list with exclude toggles and the partial-day prompt
  // ---------------------------------------------------------------------------
  const REASONS = { user: 'excluded by you', partial: 'looks partly logged', incomplete: 'not marked complete' };
  function renderHistory(root, s, u, today) {
    const days = daysNow();
    const list = days.slice().reverse();
    const pages = Math.max(1, Math.ceil(list.length / HISTORY_PAGE));
    vs.historyPage = Math.max(0, Math.min(vs.historyPage, pages - 1));
    const start = vs.historyPage * HISTORY_PAGE;
    const shown = list.slice(start, start + HISTORY_PAGE);   // one page at a time: 60 rows at most, however long the history
    const weighIns = days.filter(d => finite(d.weightKg)).length;
    root.appendChild(el('div', { class: 'cma-tdee-note' }, fmtInt(days.length) + ' days stored, ' + fmtInt(weighIns) + ' with a weigh-in. ' +
      'An excluded day counts as not logged (its food is ignored, its weigh-in still counts)' + (s.modelStartDate ? '; days before ' + fmtDate(s.modelStartDate) + ' are not used (model start date).' : '.')));
    if (!list.length) { root.appendChild(el('div', { class: 'cma-tdee-note' }, 'Nothing stored yet.')); return; }
    const tbody = el('tbody');
    for (const d of shown) tbody.appendChild(historyRow(d, s, u, today));
    root.appendChild(el('table', { class: 'cma-table cma-tdee-hist' },
      el('thead', null, el('tr', null, el('th', null, 'Day'), el('th', { class: 'cma-tdee-r' }, 'Intake (' + u.energy + ')'),
        el('th', { class: 'cma-tdee-r' }, 'Weight'), el('th', { class: 'cma-tdee-r' }, 'Burned (' + u.energy + ')'), el('th', null, 'Excluded'))),
      tbody));
    if (pages > 1) {
      root.appendChild(el('div', { class: 'cma-tdee-actions cma-tdee-pager' },
        btn('Newer', () => { vs.historyPage--; rerender(true); }, { small: true, disabled: vs.historyPage === 0, class: 'cma-tdee-newer', title: 'The more recent ' + HISTORY_PAGE + ' days' }),
        btn('Older', () => { vs.historyPage++; rerender(true); }, { small: true, disabled: vs.historyPage >= pages - 1, class: 'cma-tdee-older', title: 'The ' + HISTORY_PAGE + ' days before these' }),
        el('span', { class: 'cma-muted cma-small cma-tdee-page' }, 'Days ' + fmtInt(start + 1) + '–' + fmtInt(start + shown.length) + ' of ' + fmtInt(list.length) + ' (newest first)')));
    }
  }
  function historyRow(d, s, u, today) {
    const before = !!s.modelStartDate && d.date < s.modelStartDate;
    const tr = el('tr', { class: 'cma-tdee-hrow' + (d.excluded ? ' cma-tdee-hrow-excl' : '') + (before ? ' cma-tdee-hrow-before' : ''), data: { date: d.date } });
    tr.appendChild(el('td', { class: 'cma-tdee-c-day' }, fmtDay(d.date) + (d.date === today ? ' (today)' : '')));
    tr.appendChild(el('td', { class: 'cma-tdee-r cma-tdee-c-in', title: d.date === today ? 'Today is not counted until it is over' : d.source === 'csv' ? 'From a CSV file' : null }, finite(d.intakeKcal) ? fmtE(d.intakeKcal, u) : '—'));
    tr.appendChild(el('td', { class: 'cma-tdee-r cma-tdee-c-w' }, fmtW(d.weightKg, u)));
    const bp = d.burnedParts && typeof d.burnedParts === 'object' ? d.burnedParts : null;
    const bt = bp ? 'BMR ' + fmtE(bp.bmr, u) + ' · activity ' + fmtE(bp.activity, u) + ' · exercise ' + fmtE(bp.exercise, u) + ' · TEF ' + fmtE(bp.tef, u) : null;
    tr.appendChild(el('td', { class: 'cma-tdee-r cma-tdee-c-b', title: bt }, fmtE(d.burnedKcal, u)));
    const cell = el('td', { class: 'cma-tdee-c-x' });
    cell.appendChild(el('label', { class: 'cma-tdee-excl-l' },
      el('input', { type: 'checkbox', class: 'cma-tdee-excl', checked: !!d.excluded, 'aria-label': 'Exclude ' + fmtDay(d.date), on: { change: (e) => onExcludeToggle(d, e.target.checked) } }),
      d.excluded && REASONS[d.excludedReason] ? ' ' + REASONS[d.excludedReason] : ''));
    if (d.partialSuspect && d.excludedReason === 'partial') {
      cell.appendChild(el('span', { class: 'cma-tdee-partial-q' }, ' Fully logged? '));
      cell.appendChild(btn('Exclude', () => setOverride(d.date, true), { small: true, class: 'cma-tdee-p-exclude' }));
      cell.appendChild(btn('Yes, I ate little', () => setOverride(d.date, false), { small: true, class: 'cma-tdee-p-keep' }));
    }
    tr.appendChild(cell);
    return tr;
  }
  function onExcludeToggle(d, checked) {
    // unticking a day the heuristics excluded must SAY it was fully logged (false), otherwise they would exclude it again
    const heuristic = d.partialSuspect || d.excludedReason === 'partial' || d.excludedReason === 'incomplete';
    guard(() => setOverride(d.date, checked ? true : heuristic ? false : null));
  }

  // ---------------------------------------------------------------------------
  // Settings (spec §6.5)
  // ---------------------------------------------------------------------------
  function select(id, opts, value) {
    const sel = el('select', { id });
    for (const [v, label] of opts) sel.appendChild(vs.ctx.option(String(v), label, String(v) === String(value)));
    sel.value = String(value);
    return sel;
  }
  function renderSettings(root, s, u, st, today) {
    const m = currentModel(s, today);
    const trendKg = modelOk(m) && finite(m.current.trendWeightKg) ? Number(m.current.trendWeightKg) : null;
    const goalOpts = GOALS.map(g => [g.rate, g.label + (g.rate && trendKg ? ' (≈ ' + fmtWDelta(Math.abs(g.rate) / 100 * trendKg, u, false) + '/week)' : '')]);
    if (!GOALS.some(g => g.rate === s.goal.ratePctPerWeek)) goalOpts.push([s.goal.ratePctPerWeek, 'Custom: ' + goalText(s.goal.ratePctPerWeek)]);
    const known = prefsKnown(st);
    const autoW = unitsFor(normSettings({}), st).weight, autoE = unitsFor(normSettings({}), st).energy;
    const autoLabel = (unit, isKnown) => 'Automatic (' + (!known.prefs ? unit : isKnown ? 'Cronometer: ' + unit : unit + ' — Cronometer’s setting could not be read') + ')';
    // a field the user changed and has not saved keeps its value through any re-render (a sync finishing, a CSV file,
    // the start-date buttons); Save or another sub-view drops the draft
    const dv = (key, stored) => (vs.draft && Object.prototype.hasOwnProperty.call(vs.draft, key) ? vs.draft[key] : stored);
    const f = {
      goal: select('cma-tdee-s-goal', goalOpts, dv('goal', s.goal.ratePctPerWeek)),
      weekday: select('cma-tdee-s-weekday', WEEKDAYS.map((w, i) => [i, w]), dv('weekday', s.checkInWeekday)),
      resp: select('cma-tdee-s-resp', RESPONSIVENESS_OPTIONS, dv('resp', s.responsiveness)),
      manual: el('input', { id: 'cma-tdee-s-manual', type: 'number', min: '0', step: '10', placeholder: 'automatic', style: 'width:110px',
        value: dv('manual', s.manualInitialKcal != null ? String(Math.round(eVal(s.manualInitialKcal, u))) : '') }),
      protein: select('cma-tdee-s-protein', PROTEIN_LEVELS, dv('protein', s.proteinGPerKg)),
      fat: select('cma-tdee-s-fat', FAT_SPLITS, dv('fat', s.fatShare)),
      sex: select('cma-tdee-s-sex', SEXES, dv('sex', s.sex)),
      wunit: select('cma-tdee-s-wunit', [['auto', autoLabel(autoW, known.weight)], ['kg', 'kg'], ['lb', 'lb']], dv('wunit', s.units.weight)),
      eunit: select('cma-tdee-s-eunit', [['auto', autoLabel(autoE, known.energy)], ['kcal', 'kcal'], ['kJ', 'kJ']], dv('eunit', s.units.energy)),
      aa: el('input', { id: 'cma-tdee-s-aa', type: 'checkbox', checked: dv('aa', s.activityAware) }),
      trust: el('input', { id: 'cma-tdee-s-trust', type: 'checkbox', checked: dv('trust', s.trustCompleteOnly) }),
      start: el('input', { id: 'cma-tdee-s-start', type: 'date', value: dv('start', s.modelStartDate || ''), max: today })
    };
    for (const key of Object.keys(f)) {
      const node = f[key];
      const keep = () => { vs.draft = Object.assign({}, vs.draft, { [key]: node.type === 'checkbox' ? !!node.checked : node.value }); };
      node.addEventListener('input', keep);
      node.addEventListener('change', keep);
    }
    const floor = { female: floorKcal('female'), male: floorKcal('male'), other: floorKcal('other') };
    const row = (id, label, control, hint) => [el('label', { for: id }, label), el('div', null, control, hint ? el('div', { class: 'cma-tdee-hint' }, hint) : null)];
    root.appendChild(el('div', { class: 'cma-form cma-tdee-form' },
      row('cma-tdee-s-goal', 'Goal', f.goal, trendKg ? 'Per week, as a share of your trend weight (' + fmtW(trendKg, u) + ').' : 'Per week, as a share of your body weight.'),
      row('cma-tdee-s-weekday', 'Check-in day', f.weekday),
      row('cma-tdee-s-resp', 'Responsiveness', f.resp, 'How quickly the estimate follows real changes (stable ignores more noise).'),
      row('cma-tdee-s-manual', 'Starting estimate (' + u.energy + '/day)', f.manual, 'Leave empty to start from Cronometer’s burned figures (or your intake).'),
      row('cma-tdee-s-protein', 'Protein', f.protein),
      row('cma-tdee-s-fat', 'Fat / carb split', f.fat),
      row('cma-tdee-s-sex', 'Sex', f.sex, 'Only used for the calorie floor (' + fmtE(floor.female, u) + ' / ' + fmtE(floor.male, u) + ' / ' + fmtE(floor.other, u) + ' ' + u.energy + ').'),
      row('cma-tdee-s-wunit', 'Weight unit', f.wunit),
      row('cma-tdee-s-eunit', 'Energy unit', f.eunit),
      row('cma-tdee-s-aa', 'Activity-aware daily target', f.aa, ACTIVITY_AWARE_LABEL + ': more food on days Cronometer says you burned more. Off by default.'),
      row('cma-tdee-s-trust', 'Only trust completed days', f.trust, 'Ignore the food of days not marked complete in Cronometer (most people never mark days).'),
      row('cma-tdee-s-start', 'Model start date', el('span', { class: 'cma-tdee-inline' }, f.start, ' ',
        btn('Reset (start today)', () => saveStart(today), { small: true, class: 'cma-tdee-reset', title: 'Start the estimate again from today, e.g. after illness or a big change' }), ' ',
        btn('Use all history', () => saveStart(null), { small: true, class: 'cma-tdee-allhistory' })),
        'Only days on or after this date are used.')));

    // CSV (the manual fallback, spec §2.2.3)
    const csv = card('cma-tdee-csv', 'CSV files from Cronometer');
    csv.appendChild(el('div', { class: 'cma-tdee-note' }, 'Cronometer → Settings → Account → Export Data. RPC data read later replaces CSV data for the same days.'));
    csv.appendChild(el('div', { class: 'cma-tdee-file-row' }, el('label', { for: 'cma-tdee-csv-nutrition' }, 'Daily Nutrition (dailysummary.csv) '),
      el('input', { id: 'cma-tdee-csv-nutrition', type: 'file', accept: '.csv,text/csv', class: 'cma-tdee-file', on: { change: (e) => onCsvChosen('nutrition', e.target) } })));
    csv.appendChild(el('div', { class: 'cma-tdee-file-row' }, el('label', { for: 'cma-tdee-csv-biometrics' }, 'Biometrics (biometrics.csv) '),
      el('input', { id: 'cma-tdee-csv-biometrics', type: 'file', accept: '.csv,text/csv', class: 'cma-tdee-file', on: { change: (e) => onCsvChosen('biometrics', e.target) } })));
    root.appendChild(csv);

    // delete (two-step, inside the panel: no native confirm dialog)
    const del = card('cma-tdee-delete', 'Stored TDEE data');
    if (!vs.confirmDelete) {
      del.appendChild(el('div', { class: 'cma-tdee-actions' },
        btn('Delete TDEE data', () => { vs.confirmDelete = true; rerender(false); }, { class: 'cma-tdee-del', title: 'Delete every stored day, setting and check-in of the TDEE view from this browser' }),
        el('span', { class: 'cma-muted cma-small' }, 'Removes the stored history, settings and check-ins from this browser and stops reading.')));
    } else {
      del.appendChild(el('div', { class: 'cma-tdee-actions' }, el('strong', null, 'Delete all stored TDEE data?'),
        btn('Yes, delete', () => deleteData(), { class: 'cma-tdee-del-yes' }),
        btn('Cancel', () => { vs.confirmDelete = false; rerender(false); }, { class: 'cma-tdee-del-no' })));
    }
    root.appendChild(del);
    root.appendChild(el('p', { class: 'cma-tdee-disclaimer' }, DISCLAIMER));

    const statusEl = el('span', { class: 'cma-muted cma-small cma-tdee-settings-status' }, vs.settingsNote || '');
    vs.ctx.footer.appendChild(btn('Save', () => saveForm(f, s, u, statusEl), { strong: true, class: 'cma-tdee-save' }));
    vs.ctx.footer.appendChild(el('span', { class: 'cma-spacer' }));
    vs.ctx.footer.appendChild(statusEl);
  }
  function saveForm(f, s, u, statusEl) {
    const rate = Number(f.goal.value);
    const raw = String(f.manual.value || '').trim();
    let manual = null;
    if (raw !== '') {
      const n = Number(raw);
      manual = isFinite(n) ? Math.round(u.energy === 'kJ' ? n / KJ_PER_KCAL : n) : NaN;
      if (!(manual >= 800 && manual <= 8000)) {
        statusEl.textContent = 'The starting estimate must be between ' + fmtEU(800, u) + ' and ' + fmtEU(8000, u) + ' (or empty).';
        return Promise.resolve(false);
      }
    }
    const partial = {
      goal: { ratePctPerWeek: isFinite(rate) ? rate : s.goal.ratePctPerWeek },
      checkInWeekday: Number(f.weekday.value),
      responsiveness: f.resp.value,
      manualInitialKcal: manual,
      proteinGPerKg: Number(f.protein.value),
      fatShare: Number(f.fat.value),
      sex: f.sex.value,
      units: { weight: f.wunit.value, energy: f.eunit.value },
      activityAware: !!f.aa.checked,
      trustCompleteOnly: !!f.trust.checked,
      modelStartDate: ISO_RE.test(String(f.start.value || '')) ? f.start.value : null
    };
    if (partial.goal.ratePctPerWeek !== s.goal.ratePctPerWeek) partial.goalChangedAt = Date.now();   // spec §4.1: allows an immediate check-in
    return dcallAsync('saveSettings', [partial]).then(() => {
      bump();
      vs.draft = null;
      vs.settingsNote = 'Saved' + (partial.goalChangedAt ? ' — your goal changed, so you can check in right away (Overview).' : '.');
      log('TDEE settings saved');
      rerender(false);
      return true;
    });
  }
  function saveStart(iso) {
    return dcallAsync('saveSettings', [{ modelStartDate: iso }]).then(() => {
      bump();
      if (vs.draft) { vs.draft = Object.assign({}, vs.draft); delete vs.draft.start; }   // the saved date shows; other edits stay
      vs.settingsNote = iso ? 'The estimate starts again from ' + fmtDate(iso) + '.' : 'The estimate uses all stored history.';
      log('model start date ' + (iso ? 'set' : 'cleared'));
      rerender(false);
    });
  }
  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('the file could not be read'));
      fr.readAsText(file);
    });
  }
  function onCsvChosen(kind, input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const label = kind === 'nutrition' ? 'Daily Nutrition' : 'Biometrics';
    if (file.size > MAX_CSV_BYTES) { note('problem', label + ': the file is larger than 20 MB — is it the right export?'); rerender(false); return; }
    guard(() => readFileText(file).then(text => dcallAsync('importCsv', [kind, text])).then((r) => {
      const got = r && typeof r === 'object' ? r : {};
      const odd = num(got.unknownUnits);
      note('info', label + ' CSV: ' + fmtInt(num(got.imported)) + ' days read, ' + fmtInt(num(got.skipped)) + ' skipped' +
        (odd ? ' (' + fmtInt(odd) + (odd === 1 ? ' row' : ' rows') + ' in a unit other than kg, lb or st)' : '') + '.');
      log('CSV read (' + kind + '): ' + num(got.imported) + ' days, ' + num(got.skipped) + ' skipped');
      try { input.value = ''; } catch (e) { /* ignore */ }
      bump();
      rerender(false);
    }));
  }
  function deleteData() {
    return dcallAsync('disable', [{ forget: true }]).then(() => {
      log('TDEE data deleted on request');
      vs.dialog = null; vs.sub = 'overview'; vs.confirmDelete = false; vs.settingsNote = ''; vs.model = null; vs.dismissed = {}; vs.draft = null; vs.historyPage = 0;
      bump();
      note('info', 'The TDEE data was deleted from this browser.');
      rerender(true);
    });
  }

  // ---------------------------------------------------------------------------
  // Diagnostics: counts, date ranges and setting flags only (never weights, intakes, expenditure or targets)
  // ---------------------------------------------------------------------------
  function diagnostics() {
    const st = statusNow();
    const s = settingsNow();
    const cis = checkinsNow();
    const m = vs.model;
    const t = T();
    const counts = st && st.counts && typeof st.counts === 'object' ? st.counts : null;
    const n = (v) => (finite(v) ? Number(v) : null);
    // the data layer's own summary (counts, date ranges, flags, storage state: CMA.tdeeData.diagnostics() holds no
    // weight or intake); never probe(), dayList() or records()
    let data = null;
    try { const d = D(); data = d && typeof d.diagnostics === 'function' ? d.diagnostics() : null; }
    catch (e) { data = { error: errMsg(e) }; }
    return {
      engine: t ? { loaded: true, upstreamSha256: typeof t.UPSTREAM_SHA256 === 'string' ? t.UPSTREAM_SHA256.slice(0, 16) : null } : { loaded: false },
      dataLayer: !!D(),
      data: data || null,
      status: st ? {
        enabled: !!st.enabled, syncing: !!st.syncing, phase: st.phase ? redactText(st.phase) : null, ready: st.ready == null ? null : !!st.ready,
        blockedReason: st.blockedReason ? redactText(st.blockedReason) : null, lastError: st.lastError ? redactText(st.lastError) : null,
        lastFullAt: n(st.lastFullAt), lastDeltaAt: n(st.lastDeltaAt), firstDay: ISO_RE.test(String(st.firstDay)) ? st.firstDay : null,
        range: st.range && ISO_RE.test(String(st.range.from)) && ISO_RE.test(String(st.range.to)) ? { from: st.range.from, to: st.range.to } : null,
        counts: counts ? { days: n(counts.days), weighIns: n(counts.weighIns), intakeDays: n(counts.intakeDays), burnedDays: n(counts.burnedDays) } : null,
        flagsSource: st.flagsSource ? String(st.flagsSource) : null, energyChunk: n(st.energyChunk),
        prefsRead: !!st.prefs, tefCounted: st.prefs ? !!st.prefs.tef : null
      } : null,
      settings: {
        checkInWeekday: s.checkInWeekday, responsiveness: s.responsiveness, activityAware: s.activityAware, trustCompleteOnly: s.trustCompleteOnly,
        units: { weight: s.units.weight, energy: s.units.energy }, manualStart: s.manualInitialKcal != null,
        modelStartDate: s.modelStartDate, goalChangedAt: s.goalChangedAt
      },
      checkins: { total: cis.length, accepted: cis.filter(c => c.accepted === true).length, skipped: cis.filter(c => c.accepted === false).length, lastDate: cis.length ? cis[cis.length - 1].date : null },
      model: m ? { error: m.error || null, status: m.current ? m.current.status : null, calibrated: m.current ? !!m.current.calibrated : null, days: Array.isArray(m.days) ? m.days.length : 0, records: n(m.recordCount), priorSource: m.current ? m.current.priorSource : null, computeMs: n(m.computeMs) } : null,
      view: { sub: vs.sub, range: vs.range, dialogOpen: !!vs.dialog, init: vs.initState }
    };
  }

  // ---------------------------------------------------------------------------
  // Styles: neutral tokens only (spec §6: no red/green judgement colours). The tokens sit on .cma so the panel
  // footer (outside .cma-tdee) sees them too.
  // ---------------------------------------------------------------------------
  const CSS = [
    '.cma {',
    '  --tdee-line: #3f5f86; --tdee-band: rgba(63, 95, 134, 0.16); --tdee-faint: #8a8f98; --tdee-dot: #5f6670;',
    '  --tdee-grid: rgba(120, 124, 132, 0.22); --tdee-strong: #3b4252; --tdee-strong-fg: #ffffff;',
    '  --tdee-chip-bg: #eceef2; --tdee-chip-fg: #3b4252; --tdee-hover: #eef0f3; --tdee-soft: #f5f6f8;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  .cma {',
    '    --tdee-line: #a3badb; --tdee-band: rgba(163, 186, 219, 0.18); --tdee-faint: #8d929b; --tdee-dot: #b8bdc6;',
    '    --tdee-grid: rgba(255, 255, 255, 0.10); --tdee-strong: #d3d8e0; --tdee-strong-fg: #1f2023;',
    '    --tdee-chip-bg: #2f3137; --tdee-chip-fg: #d3d8e0; --tdee-hover: #2c2e33; --tdee-soft: #25272b;',
    '  }',
    '}',
    '.cma-tdee { display: flex; flex-direction: column; gap: 10px; }',
    '.cma-tdee p { margin: 6px 0; }',
    '.cma-tdee-card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg); min-width: 0; }',
    '.cma-tdee-card-h { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }',
    '.cma-tdee-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }',
    '@media (max-width: 640px) { .cma-tdee-grid2 { grid-template-columns: minmax(0, 1fr); } }',
    '.cma-tdee-subnav, .cma-tdee-range { display: inline-flex; align-self: flex-start; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }',
    '.cma-tdee-seg { border: 0; background: var(--bg); color: var(--muted); font: inherit; padding: 3px 10px; cursor: pointer; }',
    '.cma-tdee-seg + .cma-tdee-seg { border-left: 1px solid var(--border); }',
    '.cma-tdee-seg:hover { color: var(--fg); background: var(--tdee-hover); }',
    '.cma-tdee-seg[aria-pressed="true"] { background: var(--tdee-chip-bg); color: var(--fg); font-weight: 600; }',
    '.cma-tdee-seg-small { padding: 1px 7px; font-size: 12px; }',
    '.cma .cma-tdee-btn:hover:not(:disabled) { background: var(--tdee-hover); }',
    '.cma .cma-tdee-primary { background: var(--tdee-strong); color: var(--tdee-strong-fg); border-color: var(--tdee-strong); font-weight: 600; }',
    '.cma .cma-tdee-primary:hover:not(:disabled) { background: var(--tdee-strong); filter: brightness(1.15); }',
    '.cma .cma-tdee input:focus, .cma .cma-tdee select:focus { outline: 2px solid var(--tdee-line); outline-offset: -1px; }',
    '.cma-tdee-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }',
    '.cma-tdee-chip { display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--tdee-chip-bg); color: var(--tdee-chip-fg); font-size: 12px; }',
    '.cma-tdee-big, .cma-tdee-target { margin: 4px 0 2px; }',
    '.cma-tdee-num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }',
    '.cma-tdee-pm { color: var(--muted); }',
    '.cma-tdee-tag { margin-left: 6px; padding: 0 6px; border: 1px solid var(--border); border-radius: 8px; font-size: 11px; color: var(--muted); }',
    '.cma-tdee-cmp { font-size: 12px; margin: 2px 0; }',
    '.cma-tdee-note, .cma-tdee-hint { font-size: 12px; color: var(--muted); }',
    '.cma-tdee-macros, .cma-tdee-expect, .cma-tdee-next { margin-top: 3px; }',
    '.cma-tdee-aa { margin-top: 4px; padding: 4px 6px; border: 1px dashed var(--border); border-radius: 6px; }',
    '.cma-tdee-sync { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }',
    '.cma-tdee-gate, .cma-tdee-sync-err, .cma-tdee-sync-note { color: var(--fg); }',
    '.cma-tdee-svg:focus { outline: 2px solid var(--tdee-line); outline-offset: 2px; }',
    '.cma-tdee-msg { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--tdee-soft); }',
    '.cma-tdee-msg-problem { border-color: var(--muted); font-weight: 500; }',
    '.cma-tdee-msg-text { flex: 1 1 auto; }',
    '.cma-tdee-nudges { display: flex; flex-direction: column; gap: 4px; }',
    '.cma-tdee-nudge { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--tdee-soft); }',
    '.cma-tdee-nudge > span { flex: 1 1 auto; }',
    '.cma-tdee-empty-h { font-weight: 600; margin: 4px 0; }',
    '.cma-tdee-charts-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.cma-tdee-chart-h { font-size: 12px; margin: 8px 0 2px; }',
    '.cma-tdee-svg { display: block; width: 100%; height: auto; }',
    '.cma-tdee-svg text { font: 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--muted); }',
    '.cma-tdee-l-grid { fill: none; stroke: var(--tdee-grid); stroke-width: 1; }',
    '.cma-tdee-l-main { fill: none; stroke: var(--tdee-line); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }',
    '.cma-tdee-l-band { fill: var(--tdee-band); stroke: none; }',
    '.cma-tdee-l-faint { fill: none; stroke: var(--tdee-faint); stroke-width: 1.2; stroke-dasharray: 4 3; }',
    '.cma-tdee-l-dots { fill: var(--tdee-dot); stroke: none; opacity: 0.75; }',
    '.cma-tdee-l-out { fill: none; stroke: var(--tdee-faint); stroke-width: 1; }',
    '.cma-tdee-l-excl { fill: none; stroke: var(--tdee-faint); stroke-width: 1.5; }',
    '.cma-tdee-l-cursor { fill: none; stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }',
    '.cma-tdee-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); margin-top: 2px; }',
    '.cma-tdee-sw { display: inline-block; vertical-align: middle; width: 16px; height: 0; margin-right: 4px; border-top: 2px solid var(--tdee-line); }',
    '.cma-tdee-sw-band { height: 8px; border: 0; background: var(--tdee-band); }',
    '.cma-tdee-sw-faint { border-top: 2px dashed var(--tdee-faint); }',
    '.cma-tdee-sw-dot { width: 6px; height: 6px; border: 0; border-radius: 50%; background: var(--tdee-dot); }',
    '.cma-tdee-sw-ring { width: 7px; height: 7px; border: 1px solid var(--tdee-faint); border-radius: 50%; }',
    '.cma-tdee-sw-tick { width: 2px; height: 8px; border: 0; background: var(--tdee-faint); }',
    '.cma-tdee-readout { font-size: 11px; color: var(--muted); min-height: 1.4em; }',
    '.cma-tdee-probe-line { margin: 2px 0; }',
    '.cma-tdee-raw code { font: 11px ui-monospace, Consolas, Menlo, monospace; word-break: break-all; }',
    '.cma-tdee-raw summary { cursor: pointer; color: var(--muted); font-size: 12px; }',
    '.cma-tdee-dialog { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--bg); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); }',
    '.cma-tdee-change, .cma-tdee-newtarget { font-size: 16px; font-weight: 600; margin: 4px 0; }',
    '.cma-tdee-why { margin: 6px 0 4px 18px; padding: 0; }',
    '.cma-tdee-why li { margin: 2px 0; }',
    '.cma-tdee-hist td, .cma-tdee-hist th { padding: 2px 6px; }',
    '.cma-tdee-r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }',
    '.cma-tdee-c-day { white-space: nowrap; }',
    '.cma-tdee-hrow-excl .cma-tdee-c-in { text-decoration: line-through; color: var(--muted); }',
    '.cma-tdee-hrow-before td { color: var(--muted); }',
    '.cma-tdee-c-x { font-size: 12px; color: var(--muted); }',
    '.cma-tdee-excl-l { display: inline-flex; gap: 4px; align-items: center; }',
    '.cma-tdee-partial-q { color: var(--fg); }',
    '.cma-tdee-form { max-width: none; grid-template-columns: max-content minmax(0, 1fr); }',
    '.cma-tdee-inline { display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }',
    '.cma-tdee-file-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; font-size: 12px; }',
    '.cma-tdee-disclaimer { font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 6px; }',
    '.cma-tdee-consent-h { font-weight: 600; font-size: 14px; }',
    '.cma-tdee-link { color: var(--tdee-line); }',
    '.cma-tdee-loading { padding: 12px 0; }'
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Registration (panel.js "View registry"); the public handle is for tests and diagnostics
  // ---------------------------------------------------------------------------
  const def = { id: VIEW_ID, label: 'TDEE', order: 35, render, onEvent, diagnostics, unmount, css: CSS };
  let unregister = null;
  if (CMA.panel && typeof CMA.panel.registerView === 'function') {
    try { unregister = CMA.panel.registerView(def); } catch (e) { /* a panel without the hook: nothing to show */ }
  } else {
    (CMA.panelViewQueue = CMA.panelViewQueue || []).push(def);   // panel.js drains it when it loads
  }
  CMA.tdeeView = {
    def,
    css: CSS,
    unregister: () => { if (unregister) { unregister(); unregister = null; } },
    state: () => ({ sub: vs.sub, range: vs.range, dialog: vs.dialog ? vs.dialog.phase : null, initState: vs.initState, dataVersion: vs.dataVersion }),
    model: () => vs.model,
    /** Test hooks (pure helpers and a reset of the page-level guards). */
    test: {
      chipText, comparisonText, priorText, checkInInfo, unitsFor, normSettings, fmtInt, fmtDec, fmtW, fmtWDelta, fmtE,
      niceScale, weighInNudgeText, burned7, activityAwareLine, noteText, floorKcal,
      setSub(sub) { vs.sub = sub; }, setRange(d) { vs.range = d; }, draft: () => vs.draft,
      reset() { vs.dialog = null; vs.msg = null; vs.sub = 'overview'; vs.range = 180; vs.historyPage = 0; vs.draft = null; vs.confirmDelete = false; vs.settingsNote = ''; vs.lastAutoSyncAt = 0; vs.dismissed = {}; bump(); },
      resetAutoSync() { vs.lastAutoSyncAt = 0; },
      reinit() { vs.initState = 'idle'; }
    }
  };
})();
