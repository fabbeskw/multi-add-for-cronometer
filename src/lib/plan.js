/* Multi-Add for Cronometer — add-plan builder (SPEC §6).
 *
 * CMA.plan.build(session, items, opts, progressCb) → plan
 *   plan = { rows:[row], date:{day,month,year}, groups:[...], defaultGroupId,
 *            positionsSource:'getDayInfo'|'fallback', warnings:[...], stopped:null|'session' }
 *   opts.sessionProvider (optional function) is re-read before every request so a nonce rotated by the app's
 *   reauthenticate (SPEC 2.1) is picked up mid-build; `session` is the fallback snapshot.
 *   row  = { index, item, hits:[...], hitIndex, hit, food|null, measures:[...],
 *            pick:{measure, quantity, grams, note} | {error}, translationId, customOnly,
 *            groupId, groupName, position, order, status:'ready'|'needs-choice'|'error', message }
 *   opts.customOnly (0.3.2): search only the user's custom foods / recipes / meals; a line's own /custom or /all
 *   (item.customOnly) wins; row.customOnly is the scope the row was searched with.
 *   Calorie amounts (0.3.2): an item whose unit is 'kcal' / 'kj' (`300cal almonds`) is picked by units.pickEnergy from
 *   the loaded Food's nutrient 208 (rpc.energyKcalOf); without the Food (getFood failed, unverified row) or for a meal
 *   the row is an error. pick.kcal / pick.kcalPerUnit carry the numbers.
 * CMA.plan.rechoose(session, row, hitIndex) → row      (user picked another hit in the panel)
 * CMA.plan.repick(row, measureId, qty) → row            (user picked another measure / qty; on an energy row qty is the
 *                                                        calorie target and the measure only carries it)
 * CMA.plan.servingFor(row, date) → Serving value (§4)   (used by engine-rpc)
 * CMA.plan.defaultGroupId(groups, now) → id             (time-of-day rule)
 * CMA.plan.resolveGroup(name, groups) → group|null      (case-insensitive prefix)
 * CMA.plan.assignPositions(session, plan) → plan        (getDayInfo → maxPos+1 per group)
 *
 * Depends at call time on CMA.rpc (searchFoods/getFood/measuresOf/getDayInfo/servingsOf)
 * and CMA.units. Also defines CMA.errors (guarded; rpc.js defines the same block).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ---------------------------------------------------------------------------
  // Error classes (SPEC §4/§6.4). Guarded so that rpc.js and plan.js can both
  // define them regardless of load order.
  // ---------------------------------------------------------------------------
  if (!CMA.errors) {
    class CmaError extends Error {
      constructor(message, kind, extra) {
        super(message || kind);
        this.name = 'CMA' + kind.charAt(0).toUpperCase() + kind.slice(1) + 'Error';
        this.kind = kind;
        if (extra && typeof extra === 'object') Object.assign(this, extra);
      }
    }
    class Session extends CmaError { constructor(message, extra) { super(message || 'session expired', 'session', extra); } }
    class Throttled extends CmaError { constructor(message, extra) { super(message || 'throttled', 'throttled', extra); } }
    class Network extends CmaError { constructor(message, extra) { super(message || 'network error', 'network', extra); } }
    CMA.errors = { Session, Throttled, Network, CmaError };
  }
  if (!CMA.errors.isNetwork) {
    /** True for errors that are safe to retry once (request never reached / no response). */
    CMA.errors.isNetwork = function isNetwork(e) {
      if (!e) return false;
      if (e.kind === 'network') return true;
      if (e.kind === 'session' || e.kind === 'throttled') return false;
      if (CMA.errors.Network && e instanceof CMA.errors.Network) return true;
      // fetch() rejects with a TypeError ("Failed to fetch") on DNS/connection failures.
      if (e instanceof TypeError && /fetch|network/i.test(String(e.message))) return true;
      if (e.name === 'AbortError') return true;
      return /failed to fetch|networkerror|network error|timed? ?out/i.test(String(e.message || ''));
    };
  }

  // ---------------------------------------------------------------------------
  // Constants (SPEC §3.3 / §4)
  // ---------------------------------------------------------------------------
  // Type signatures as compiled in build 0A1C16E148676A90CBB128E4829A562F (SPEC §3.3). They are only the
  // FALLBACK for pages that do not load gwt-stream.js (tests/unit.html): sigOf() prefers CMA.gwt.SIG, which
  // resolves the CURRENT CRC from the generated registry, so a regenerated registry after a Cronometer deploy
  // (new Serving/Day CRC) can never leave the Serving value built here stale while rpc.js/gwt-stream move on.
  const SIG = {
    SERVING: 'com.cronometer.shared.entries.models.Serving/2553599101',
    DAY: 'com.cronometer.shared.entries.models.Day/782579793'
  };
  function sigOf(key) {
    try {
      const s = CMA.gwt && CMA.gwt.SIG ? CMA.gwt.SIG[key] : null;
      if (typeof s === 'string' && s) return s;
    } catch (e) { /* registry not loaded: use the literal */ }
    return SIG[key];
  }
  const SERVING_PREFIX = 'com.cronometer.shared.entries.models.Serving/';
  function isServing(v) { return !!v && typeof v === 'object' && typeof v.$t === 'string' && v.$t.indexOf(SERVING_PREFIX) === 0 && Array.isArray(v.f); }
  const DEFAULT_GROUP_NAMES = ['Uncategorized', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Group 6', 'Group 7', 'Group 8'];
  const DEFAULT_GROUPS = DEFAULT_GROUP_NAMES.map((name, id) => ({ id, name, enabled: id <= 4 }));

  function F() {
    const f = CMA.gwt && CMA.gwt.F;
    return {
      SERVING_ORDER: f && f.SERVING && f.SERVING.ORDER != null ? f.SERVING.ORDER : 4,
      FOOD_NAME: f && f.FOOD && f.FOOD.NAME != null ? f.FOOD.NAME : 4,
      FOOD_ID: f && f.FOOD && f.FOOD.ID != null ? f.FOOD.ID : 7,
      FOOD_MEASURES: f && f.FOOD && f.FOOD.MEASURES != null ? f.FOOD.MEASURES : 11,
      FOOD_TRANSLATIONS: f && f.FOOD && f.FOOD.TRANSLATIONS != null ? f.FOOD.TRANSLATIONS : 17,
      DAYINFO_LIST1: f && f.DAYINFO && f.DAYINFO.LIST1 != null ? f.DAYINFO.LIST1 : 2,
      DAYINFO_LIST2: f && f.DAYINFO && f.DAYINFO.LIST2 != null ? f.DAYINFO.LIST2 : 3
    };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms | 0))); }
  function now() { return Date.now(); }

  function safeCb(cb, evt) {
    if (typeof cb !== 'function') return;
    try { cb(evt); } catch (e) { /* progress callbacks must never break the plan */ }
  }

  function errMessage(e) {
    if (!e) return 'unknown error';
    const m = e.message || String(e);
    // Never let a session nonce leak through an error string (SPEC §0).
    return String(m).replace(/[A-Za-z0-9+\/=_-]{32,}/g, '[redacted]');
  }

  function todayDate(d) {
    const x = d instanceof Date ? d : new Date();
    return { day: x.getDate(), month: x.getMonth() + 1, year: x.getFullYear() };
  }

  // ---------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------
  function normGroups(groups) {
    const src = Array.isArray(groups) && groups.length ? groups : DEFAULT_GROUPS;
    return src.map((g, i) => ({
      id: g.id != null ? Number(g.id) : i,
      name: String(g.name != null ? g.name : DEFAULT_GROUP_NAMES[i] || ('Group ' + (i + 1))),
      enabled: g.enabled !== false
    }));
  }

  /** SPEC §6: item.group name → enabled group by case-insensitive prefix (exact name first). */
  function resolveGroup(name, groups) {
    if (name == null || name === '') return null;
    const gs = normGroups(groups).filter(g => g.enabled);
    const n = String(name).trim().toLowerCase();
    if (!n) return null;
    let g = gs.find(x => x.name.toLowerCase() === n);
    if (g) return g;
    g = gs.find(x => x.name.toLowerCase().startsWith(n));
    if (g) return g;
    // numeric tag (`@3`) → group id
    if (/^\d+$/.test(n)) {
      g = gs.find(x => x.id === parseInt(n, 10));
      if (g) return g;
    }
    return null;
  }

  /**
   * SPEC §6 default-group rule when the panel first opens: hour 4–10 Breakfast(1),
   * 10–14 Lunch(2), 14–21 Dinner(3), else Snacks(4) — mapped to the first enabled
   * group with that id, else the first enabled group.
   */
  function defaultGroupId(groups, nowDate) {
    const gs = normGroups(groups);
    const h = (nowDate instanceof Date ? nowDate : new Date()).getHours();
    let want;
    if (h >= 4 && h < 10) want = 1;
    else if (h >= 10 && h < 14) want = 2;
    else if (h >= 14 && h < 21) want = 3;
    else want = 4;
    const enabled = gs.filter(g => g.enabled);
    const hit = enabled.find(g => g.id === want);
    if (hit) return hit.id;
    return enabled.length ? enabled[0].id : 0;
  }

  // ---------------------------------------------------------------------------
  // Food value helpers (Food/2097636843 layout, SPEC §3.3)
  // ---------------------------------------------------------------------------
  function foodName(food) {
    const f = F();
    return food && Array.isArray(food.f) && typeof food.f[f.FOOD_NAME] === 'string' ? food.f[f.FOOD_NAME] : null;
  }
  function foodDefaultMeasureId(food) {
    const f = F();
    const fm = food && Array.isArray(food.f) ? food.f[f.FOOD_MEASURES] : null;
    // FoodMeasures/2106205728: [i, o list<Measure>] — f[0] is the food's default measure id: the Add Food dialog's
    // `TCe` selects the measure whose id equals it (`d=b.p.a==f.e` with `f.e` = Measure.measureId, bundle
    // 0A1C16E148676A90CBB128E4829A562F). Passed to units.pickMeasure as opts.defaultMeasureId (SPEC §5.3).
    return fm && Array.isArray(fm.f) && typeof fm.f[0] === 'number' && fm.f[0] > 0 ? fm.f[0] : null;
  }
  function measuresOf(food) {
    if (CMA.rpc && typeof CMA.rpc.measuresOf === 'function') return CMA.rpc.measuresOf(food) || [];
    // Local fallback mirroring SPEC §3.3 Measure layout.
    const f = F();
    const fm = food && Array.isArray(food.f) ? food.f[f.FOOD_MEASURES] : null;
    const list = fm && Array.isArray(fm.f) && Array.isArray(fm.f[1]) ? fm.f[1] : [];
    return list.filter(m => m && Array.isArray(m.f)).map(m => ({
      id: m.f[4], name: m.f[6], grams: m.f[9], foodId: m.f[2],
      type: m.f[8] && typeof m.f[8].ordinal === 'number' ? ['Weight', 'Volume', 'Atomic', 'Recipe'][m.f[8].ordinal] : m.f[8]
    }));
  }
  function servingsOf(dayInfo) {
    if (CMA.rpc && typeof CMA.rpc.servingsOf === 'function') return CMA.rpc.servingsOf(dayInfo) || [];
    const f = F();
    const out = [];
    if (!dayInfo || !Array.isArray(dayInfo.f)) return out;
    for (const idx of [f.DAYINFO_LIST1, f.DAYINFO_LIST2]) {
      const list = dayInfo.f[idx];
      if (!Array.isArray(list)) continue;
      for (const e of list) if (isServing(e)) out.push(e);
    }
    return out;
  }

  // The app's locale for Translation lookups. `lYb()` picks the Language whose code prefixes `(N3k(),'en')`,
  // i.e. this permutation is compiled for 'en' — it does not read navigator.language.
  // Translation/4034452093 = [o Language, s name, i id]; Language/1257207975 = [s code, s, s, s].
  const APP_LOCALE = 'en';
  function foodTranslations(food) {
    const f = F();
    const list = food && Array.isArray(food.f) ? food.f[f.FOOD_TRANSLATIONS] : null;
    return Array.isArray(list) ? list.filter(t => t && Array.isArray(t.f)) : [];
  }
  /**
   * `Rjj(food, lYb())`: the name of the Translation whose Language code equals the app locale, else the first
   * Translation's name, else null. This — not Food.f (SPEC 3.3 index 4, an empty-string prototype default the
   * app never reads as a name) — is what the app displays (`Food.toString` = id + ':' + Rjj(...), o1i).
   */
  function foodDisplayName(food) {
    const trs = foodTranslations(food);
    if (!trs.length) return null;
    const own = trs.find(t => t.f[0] && Array.isArray(t.f[0].f) && String(t.f[0].f[0]).toLowerCase() === APP_LOCALE) || trs[0];
    return own && typeof own.f[1] === 'string' ? own.f[1] : null;
  }
  /**
   * SPEC §4: the Serving's translationId. Mirrors `zte`: `a.U=c; l=$jj(b,c); if(!!l&&_ko(l.b,Rjj(b,lYb()))){l=null;a.U=0}`
   * — the picked hit's translationId is looked up in the Food's Translation list and zeroed only when that
   * Translation's name equals the food's own name in the app locale; an id that is not in the list is kept.
   */
  function translationIdFor(hit, food) {
    const t = hit && Number(hit.translationId) > 0 ? Number(hit.translationId) : 0;
    if (!t) return 0;
    const tr = foodTranslations(food).find(x => Number(x.f[2]) === t);
    if (!tr) return t;
    const own = foodDisplayName(food);
    return own != null && tr.f[1] === own ? 0 : t;
  }

  // ---------------------------------------------------------------------------
  // Hit choice (SPEC §6): exact case-insensitive name match, else first (server order).
  // ---------------------------------------------------------------------------
  function chooseHitIndex(hits, name) {
    if (!Array.isArray(hits) || !hits.length) return -1;
    const n = String(name || '').trim().toLowerCase();
    const exact = hits.findIndex(h => h && String(h.name || '').trim().toLowerCase() === n);
    return exact >= 0 ? exact : 0;
  }
  /**
   * A custom-only search keeps the user's own items: source 'Custom' (type FOOD / RECIPE / MEAL), or no source at all
   * (the app styles a null source like a custom one). rpc.searchFoods already filters; this repeats it for any other
   * searchFoods and runs before the maxHits slice, so a custom hit far down a mixed answer is not cut off.
   */
  function isCustomHit(hit) {
    return !!hit && (hit.source == null || hit.source === 'Custom');
  }

  // ---------------------------------------------------------------------------
  // Retry helper: one retry after `retryMs` on network errors only.
  // ---------------------------------------------------------------------------
  async function withOneRetry(fn, retryMs, onRetry) {
    try {
      return await fn();
    } catch (e) {
      if (!CMA.errors.isNetwork(e)) throw e;
      safeCb(onRetry, e);
      await sleep(retryMs);
      return await fn();
    }
  }

  // ---------------------------------------------------------------------------
  // Per-row resolution: search → hit → getFood → measures → pick
  // ---------------------------------------------------------------------------
  function newRow(item, index) {
    return {
      index, item, hits: [], hitIndex: -1, hit: null, food: null, measures: [],
      pick: null, translationId: 0, customOnly: false, groupId: null, groupName: null, groupNote: null,
      position: null, order: null, status: 'error', message: ''
    };
  }

  // ---------------------------------------------------------------------------
  // Calorie amounts (0.3.2, SPEC §6 / Appendix N): `300cal almonds` → units.pickEnergy over the Food's nutrient 208.
  // ---------------------------------------------------------------------------
  /** item.unit 'kcal' / 'kj' (parse.js): the typed number is an energy target, never a count of a measure. */
  function isEnergyItem(item) {
    return !!item && !!CMA.units && typeof CMA.units.isEnergyUnit === 'function' && CMA.units.isEnergyUnit(item.unit);
  }
  /** A meal cannot be scaled in the Add dialog (the measure selector is hidden): the hit's type, else the Food's FoodType. */
  function isMealRow(row) {
    if (row.hit && String(row.hit.type || '').toUpperCase() === 'MEAL') return true;
    try { return !!row.food && !!CMA.rpc && typeof CMA.rpc.foodTypeOf === 'function' && CMA.rpc.foodTypeOf(row.food) === 'MEAL'; } catch (e) { return false; }
  }
  function energyValueOf(food) {
    try { return CMA.rpc && typeof CMA.rpc.energyKcalOf === 'function' ? CMA.rpc.energyKcalOf(food) : null; } catch (e) { return null; }
  }
  /**
   * The pick for an energy row. `measureId` (the panel's Unit dropdown) keeps the target and changes only the measure;
   * null picks the default (units.pickEnergy). The Food itself is required: search hits carry no energy, so a row whose
   * getFood failed (measuresFromHit fallback) or an unverified UI-engine row is an error rather than a guess.
   */
  function applyEnergy(row, measureId) {
    const item = row.item || {};
    if (!row.food) {
      const why = row.unverified ? row.unverifiedWhy : row.foodError ? 'getFood failed: ' + row.foodError : 'the food was not loaded';
      row.pick = { error: "calories need the food's details, which could not be read (" + (why || 'unknown') + '); type an amount such as 50 g instead' };
    } else {
      row.pick = CMA.units.pickEnergy(row.measures, energyValueOf(row.food), CMA.units.energyToKcal(item.qty, item.unit), {
        hitMeasureId: row.hit ? row.hit.measureId : null,
        defaultMeasureId: foodDefaultMeasureId(row.food),
        measureId: measureId == null ? null : measureId,
        meal: isMealRow(row),
        kj: String(item.unit).toLowerCase() === 'kj' ? Number(item.qty) : null
      });
    }
    if (row.pick.error) {
      // a picked measure that cannot carry calories asks for another one; everything else cannot be added
      row.status = row.pick.refused ? 'needs-choice' : 'error';
      row.message = row.pick.error;
    } else {
      row.status = 'ready';
      row.message = row.pick.note || '';
    }
    if (row.groupNote) row.message = (row.message ? row.message + '; ' : '') + row.groupNote;
    return row;
  }

  function applyPick(row) {
    const item = row.item || {};
    if (isEnergyItem(item)) return applyEnergy(row, null);
    if (!row.measures.length) {
      row.pick = { error: 'food has no measures' };
      row.status = 'error';
      row.message = row.pick.error;
      return row;
    }
    // Default measure when no unit was typed (SPEC §5.3, CMA.units.defaultMeasure): the search hit's measure when it
    // is in the list, else the food's own default (FoodMeasures.f[0], what the dialog's `TCe` starts on), else the
    // plain 1 g 'g'. A bare gram/ml default with other measures available becomes needs-choice with a suggested
    // measure instead of logging N grams (units.pickDefault; the 1 g live case of 2026-09-28).
    row.pick = CMA.units.pickMeasure(row.measures, item.unit, item.qty, {
      hitMeasureId: row.hit ? row.hit.measureId : null,
      defaultMeasureId: row.food ? foodDefaultMeasureId(row.food) : null
    });
    if (row.pick.error) {
      row.status = 'needs-choice';
      row.message = row.pick.error;
    } else {
      row.status = 'ready';
      row.message = row.pick.note || '';
    }
    if (row.groupNote) row.message = (row.message ? row.message + '; ' : '') + row.groupNote;
    return row;
  }

  // '1 breast - 172g' / '1 large - 50g': the hit's default measure as the food search describes it
  // (client.py measure_desc; serving-fields-resolved.md §1: the dialog's picker starts from `Sqe(this.a, c.i, c.u, c.o)`).
  const HIT_MEASURE_RE = /^(\d+(?:\.\d+)?|\d+\/\d+)\s+(.+?)\s*-\s*(\d+(?:\.\d+)?)\s*g$/i;
  function measuresFromHit(hit) {
    if (!hit || !(Number(hit.measureId) > 0)) return [];
    const m = HIT_MEASURE_RE.exec(String(hit.measureDisplayName || '').trim());
    if (!m) return [];
    const fr = /^(\d+)\/(\d+)$/.exec(m[1]);
    const amount = fr ? Number(fr[1]) / Number(fr[2]) : Number(m[1]);
    const grams = Number(m[3]);
    if (!(amount > 0) || !(grams > 0)) return [];
    return [{ id: Number(hit.measureId), name: m[2].trim(), grams: grams, type: null, foodId: Number(hit.id), isDefault: true, amount: amount, ml: null, fromHit: true }];
  }
  function noteCaptureLog(kind, fields) {
    try { if (CMA.capture && typeof CMA.capture.log === 'function') CMA.capture.log(kind, fields); } catch (e) { /* diagnostics only */ }
  }

  async function loadFood(session, row, opts, progressCb) {
    const hit = row.hit;
    let food;
    try {
      food = await withOneRetry(
        () => CMA.rpc.getFood(session, hit.id),
        opts.retryMs,
        () => safeCb(progressCb, { phase: 'food', index: row.index, row, message: 'retrying getFood' })
      );
    } catch (e) {
      // The server answered but the Food could not be used (a decode error after a Cronometer deploy that
      // changed a class in the 20-field Food graph, an //EX, an unexpected value): fall back to the measure the
      // search hit already carries so 'N × default measure' and 'N g' lines can still be added. Session,
      // network and throttle errors keep their meaning.
      if (e && (e.kind === 'session' || e.kind === 'network' || e.kind === 'throttled')) throw e;
      const fallback = measuresFromHit(hit);
      if (!fallback.length) throw e;
      noteCaptureLog('warn', { note: 'getFood failed (' + (e && e.kind ? e.kind : 'error') + '): ' + errMessage(e) + '; using the search hit measure', foodId: hit.id });
      row.food = null;
      row.measures = fallback;
      row.translationId = Number(hit.translationId) > 0 ? Number(hit.translationId) : 0;
      row.foodError = errMessage(e);
      applyPick(row);
      if (row.status === 'ready') row.message = (row.message ? row.message + '; ' : '') + 'measures from the search hit only (getFood failed: ' + errMessage(e) + ')';
      return row;
    }
    row.food = food || null;
    row.measures = measuresOf(food);
    row.translationId = translationIdFor(hit, food);
    return applyPick(row);
  }

  function setHit(row, hitIndex) {
    row.hitIndex = hitIndex;
    row.hit = row.hits[hitIndex] || null;
    row.food = null;
    row.measures = [];
    row.translationId = 0;
    row.pick = null;
    row.unverified = false;
    row.unverifiedWhy = null;
    row.foodError = null;
  }

  function opt(opts, key, dflt) {
    return opts && opts[key] != null ? opts[key] : dflt;
  }

  function normOpts(opts) {
    const cap = CMA.capture && CMA.capture.state ? CMA.capture.state : null;
    const groups = normGroups(opt(opts, 'groups', cap && cap.groups));
    const o = {
      groups,
      defaultGroupId: opt(opts, 'defaultGroupId', null),
      date: opt(opts, 'date', cap && cap.diaryDate) || todayDate(),
      searchDelayMs: opt(opts, 'searchDelayMs', 300),
      retryMs: opt(opts, 'retryMs', 2000),
      maxHits: opt(opts, 'maxHits', 10),
      maxResults: opt(opts, 'maxResults', 50),
      positions: opt(opts, 'positions', true),
      // UI-engine mode: rows whose search/getFood fails (or every row when no session was captured) stay
      // 'ready' with an unverified pick built from the typed line; engine-ui drives the dialog by name (SPEC §7).
      unverified: !!(opts && opts.unverified),
      // Settings → "Search only my custom foods": the default scope of every row (a line's /custom or /all wins).
      customOnly: !!opts && opts.customOnly === true,
      // The session nonce rotates when the app reauthenticates (SPEC 2.1): a provider re-reads it per request.
      sessionProvider: typeof (opts && opts.sessionProvider) === 'function' ? opts.sessionProvider : null,
      isCancelled: typeof (opts && opts.isCancelled) === 'function' ? opts.isCancelled : () => false
    };
    if (o.defaultGroupId == null) o.defaultGroupId = defaultGroupId(groups, opt(opts, 'now', null));
    return o;
  }

  function assignGroup(row, o) {
    const item = row.item || {};
    let g = resolveGroup(item.group, o.groups);
    let via = null;
    if (!g && Array.isArray(item.groupFallback)) {
      // `## Dinner` then `# leftovers from yesterday`: the parser records the earlier headers, so a header that
      // is not a real group falls back to the last resolvable one instead of the default group.
      for (const name of item.groupFallback) { g = resolveGroup(name, o.groups); if (g) { via = name; break; } }
    }
    if (g) {
      row.groupId = g.id; row.groupName = g.name;
      row.groupNote = via && item.group ? "group '" + item.group + "' not found, using " + g.name + " (previous header)" : null;
    } else {
      const d = o.groups.find(x => x.id === Number(o.defaultGroupId)) || o.groups.find(x => x.enabled) || o.groups[0];
      row.groupId = d ? d.id : 0;
      row.groupName = d ? d.name : DEFAULT_GROUP_NAMES[0];
      row.groupNote = item.group ? "group '" + item.group + "' not found, using " + row.groupName : null;
    }
  }

  /** A bare line equal to a group name (`Lunch`) is a header the user forgot to mark, not a food. */
  function headerGroupFor(name, groups) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return normGroups(groups).find(g => g.name.toLowerCase() === n) || null;
  }
  /** searchFoods needs only the userId (cookie-authenticated REST); getFood needs the full session. */
  function canSearch(session) {
    return !!(CMA.rpc && typeof CMA.rpc.searchFoods === 'function' && session && typeof session === 'object' && Number(session.userId) > 0);
  }
  /** UI-engine fallback row: the dialog is driven by the typed name/unit/quantity; grams are not previewed. */
  function markUnverified(row, why) {
    const item = row.item || {};
    row.unverified = true;
    row.food = null;
    row.measures = [];
    // a calorie amount needs the Food's energy, which only getFood has: an error, never 300 of the typed unit
    if (isEnergyItem(item)) { row.unverifiedWhy = 'UI engine: ' + why; return applyEnergy(row, null); }
    row.pick = {
      measure: item.unit ? { id: null, name: item.unit, grams: null, type: null } : null,
      quantity: item.qty != null ? Number(item.qty) : 1,
      grams: null,
      note: 'unverified (UI engine): ' + why
    };
    row.status = 'ready';
    row.message = row.pick.note + (row.groupNote ? '; ' + row.groupNote : '');
    return row;
  }

  /**
   * CMA.plan.build — SPEC §6.
   */
  async function build(session, items, opts, progressCb) {
    if (!CMA.rpc) throw new Error('CMA.rpc is not loaded');
    if (!CMA.units) throw new Error('CMA.units is not loaded');
    const o = normOpts(opts);
    const list = Array.isArray(items) ? items : [];
    const plan = {
      rows: [], date: o.date, groups: o.groups, defaultGroupId: o.defaultGroupId,
      positionsSource: null, nextPos: {}, warnings: [], stopped: null, builtAt: now()
    };
    let lastSearchAt = 0;
    let stopped = false;
    /** The session to use right now: the provider's (a rotated nonce is picked up mid-build) else the snapshot. */
    const sessionNow = () => {
      if (o.sessionProvider) { try { const s = o.sessionProvider(); if (s && typeof s === 'object') return s; } catch (e) { /* keep the snapshot */ } }
      return session;
    };

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const row = newRow(item, i);
      plan.rows.push(row);
      assignGroup(row, o);
      // the line's own /custom or /all, else the setting; engine-ui reads row.customOnly for the dialog's result rows
      const customOnly = item.customOnly != null ? item.customOnly === true : o.customOnly;
      row.customOnly = customOnly;

      if (stopped || o.isCancelled()) {
        row.status = 'error';
        row.message = stopped ? 'not searched (session expired)' : 'cancelled';
        continue;
      }
      if (item.error) {
        row.status = 'error';
        row.message = item.error;
        safeCb(progressCb, { phase: 'search', index: i, total: list.length, row, message: item.error });
        continue;
      }
      if (!item.name) {
        row.status = 'error';
        row.message = 'no food name';
        continue;
      }
      const header = item.qty == null && item.unit == null ? headerGroupFor(item.name, o.groups) : null;
      if (header) {
        // 'Breakfast' / 'Lunch' typed as a bare line: searching it would log a "Breakfast Sandwich".
        row.status = 'error';
        row.message = "looks like a group header — write '## " + header.name + "' to switch groups";
        continue;
      }
      if (o.unverified && !canSearch(sessionNow())) {
        markUnverified(row, 'no session captured');
        continue;
      }

      // Sequential search, 300 ms apart, one retry after 2 s on network error (SPEC §6).
      const wait = lastSearchAt ? o.searchDelayMs - (now() - lastSearchAt) : 0;
      if (wait > 0) await sleep(wait);
      safeCb(progressCb, { phase: 'search', index: i, total: list.length, row, message: 'searching ' + item.name });
      lastSearchAt = now();
      let hits;
      try {
        hits = await withOneRetry(
          () => CMA.rpc.searchFoods(sessionNow(), item.name, { maxResults: o.maxResults, customOnly }),
          o.retryMs,
          () => safeCb(progressCb, { phase: 'search', index: i, total: list.length, row, message: 'retrying search' })
        );
      } catch (e) {
        if (o.unverified) { markUnverified(row, 'search failed: ' + errMessage(e)); continue; }
        row.status = 'error';
        row.message = 'search failed: ' + errMessage(e);
        if (e && e.kind === 'session') { stopped = true; plan.stopped = 'session'; row.message = 'session expired'; }
        continue;
      }
      let found = Array.isArray(hits) ? hits : [];
      if (customOnly) found = found.filter(isCustomHit);
      row.hits = found.slice(0, o.maxHits);
      const idx = chooseHitIndex(row.hits, item.name);
      if (idx < 0) {
        if (o.unverified) { markUnverified(row, customOnly ? 'no custom food matches' : 'no search results'); continue; }
        row.status = 'error';
        row.message = customOnly ? 'no custom food matches' : 'no results';
        continue;
      }
      setHit(row, idx);

      safeCb(progressCb, { phase: 'food', index: i, total: list.length, row, message: 'loading ' + row.hit.name });
      try {
        await loadFood(sessionNow(), row, o, progressCb);
      } catch (e) {
        if (o.unverified) { markUnverified(row, 'getFood failed: ' + errMessage(e)); continue; }
        row.status = 'error';
        row.message = 'getFood failed: ' + errMessage(e);
        if (e && e.kind === 'session') { stopped = true; plan.stopped = 'session'; row.message = 'session expired'; }
      }
    }

    if (o.positions && !stopped) {
      safeCb(progressCb, { phase: 'positions', index: list.length, total: list.length, message: 'reading diary positions' });
      await assignPositions(sessionNow(), plan);
    } else if (o.positions) {
      fallbackPositions(plan, 'session expired before getDayInfo');
    }
    safeCb(progressCb, { phase: 'done', index: list.length, total: list.length, plan });
    return plan;
  }

  // ---------------------------------------------------------------------------
  // Positions (SPEC §6): maxPos per group from getDayInfo servings; fallback 1000+rowIndex.
  // Known divergence from the dialog (serving-fields-resolved.md §3, `qvd`): the UI walks EVERY DiaryEntry of
  // the day (servings, exercises, biometrics and notes share the packed group<<16|position) and returns a
  // same-group TIMED entry's own position unchanged; we take the maximum over Servings only, so a position may
  // collide with a non-food or timed entry. The client only sorts by it (m1i/UYi): a fidelity gap, not a
  // failure. The order slot of the other entry classes is not resolved in the registry.
  // ---------------------------------------------------------------------------
  function maxPositions(servings) {
    const ORDER = F().SERVING_ORDER;
    const max = {};
    for (const s of servings) {
      if (!s || !Array.isArray(s.f)) continue;
      const order = Number(s.f[ORDER]);
      if (!isFinite(order)) continue;
      // serving-fields-resolved.md §3: packed order = group<<16 | position (Y_i / qvd)
      const g = order >> 16, p = order & 0xFFFF;
      if (max[g] == null || p > max[g]) max[g] = p;
    }
    return max;
  }

  function fallbackPositions(plan, why) {
    plan.positionsSource = 'fallback';
    plan.warnings.push('positions: ' + why + '; using 1000+rowIndex');
    try { console.warn('[CMA] getDayInfo failed; positions fall back to 1000+rowIndex:', why); } catch (e) { /* ignore */ }
    for (const row of plan.rows) {
      if (row.groupId == null || row.status === 'error') continue;
      row.position = 1000 + row.index;
      row.order = ((row.groupId << 16) | (row.position & 0xFFFF)) >>> 0;
    }
    return plan;
  }

  async function assignPositions(session, plan) {
    let servings;
    try {
      const dayInfo = await withOneRetry(() => CMA.rpc.getDayInfo(session, plan.date), 2000);
      servings = servingsOf(dayInfo);
    } catch (e) {
      return fallbackPositions(plan, errMessage(e));
    }
    const max = maxPositions(servings);
    const next = {};
    for (const row of plan.rows) {
      // 'error' rows (no hits / parse error) can never be added; do not reserve a slot for them.
      if (row.groupId == null || row.status === 'error') continue;
      const g = row.groupId;
      if (next[g] == null) next[g] = (max[g] || 0) + 1;
      row.position = next[g]++;
      row.order = ((g << 16) | (row.position & 0xFFFF)) >>> 0;
    }
    plan.nextPos = next;
    plan.positionsSource = 'getDayInfo';
    return plan;
  }

  /** Give a row (whose group changed in the panel) the next free position of its new group. */
  function reposition(plan, row, groupId) {
    const g = plan.groups.find(x => x.id === Number(groupId));
    if (!g) return row;
    row.groupId = g.id;
    row.groupName = g.name;
    row.groupNote = null;
    if (!plan.nextPos) plan.nextPos = {};
    if (plan.nextPos[g.id] == null) {
      const used = plan.rows.filter(r => r !== row && r.groupId === g.id && r.position != null).map(r => r.position);
      plan.nextPos[g.id] = (used.length ? Math.max.apply(null, used) : 0) + 1;
    }
    row.position = plan.nextPos[g.id]++;
    row.order = ((g.id << 16) | (row.position & 0xFFFF)) >>> 0;
    return row;
  }

  // ---------------------------------------------------------------------------
  // Panel interactions
  // ---------------------------------------------------------------------------
  /** User chose a different hit: refetch the food and re-pick (SPEC §6). */
  async function rechoose(session, row, hitIndex, opts) {
    if (!row || !Array.isArray(row.hits) || !row.hits[hitIndex]) throw new Error('invalid hit index');
    setHit(row, hitIndex);
    try {
      await loadFood(session, row, { retryMs: opt(opts, 'retryMs', 2000) }, null);
    } catch (e) {
      row.status = 'error';
      row.message = 'getFood failed: ' + errMessage(e);
      if (e && e.kind === 'session') throw e;
    }
    return row;
  }

  /**
   * User chose a measure (and optionally a quantity) in the panel. On an energy row (`300cal almonds`) `qty` is the new
   * calorie target in the typed unit (kcal / kJ) and `measureId` the measure to express it in (null: the default), so
   * neither the Unit dropdown nor a 'Use' button can ever turn the kcal number into a count of a measure.
   */
  function repick(row, measureId, qty) {
    if (!row) throw new Error('row required');
    if (isEnergyItem(row.item)) {
      if (qty != null) row.item.qty = Number(qty);
      return applyEnergy(row, measureId == null || measureId === '' ? null : measureId);
    }
    const q = qty == null ? (row.pick && row.pick.quantity != null ? row.pick.quantity : (row.item && row.item.qty) || 1) : qty;
    const pick = CMA.units.withMeasure(row.measures, measureId, q);
    row.pick = pick;
    if (pick.error) { row.status = 'needs-choice'; row.message = pick.error; }
    else { row.status = 'ready'; row.message = ''; }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Serving value (SPEC §4): mirrors what the Add Food dialog sends.
  // ---------------------------------------------------------------------------
  function servingFor(row, date) {
    if (!row || !row.pick || row.pick.error || !row.pick.measure) throw new Error('row is not ready');
    if (row.unverified || row.pick.measure.id == null) throw new Error('row is unverified (UI engine only): it has no measure id');
    const d = date || todayDate();
    const m = row.pick.measure;
    const foodId = m.foodId != null ? Number(m.foodId) : (row.hit ? Number(row.hit.id) : 0);
    if (row.order == null) throw new Error('row has no position (assignPositions not run)');
    return {
      $t: sigOf('SERVING'),
      f: [
        { $t: sigOf('DAY'), f: [Number(d.day), Number(d.month), Number(d.year)] }, // day (viewed diary date)
        true,                       // b (prototype default)
        true,                       // c (prototype default)
        null,                       // offset (java.lang.Short) = null
        Number(row.order),          // order = group<<16 | position
        null,                       // time = null (Gold time-of-day not set)
        0,                          // userId: the dialog path sends 0 (serving-fields-resolved.md §0)
        Number(row.pick.grams),     // grams = quantity × measure.grams (quantity for Recipe)
        foodId,                     // foodId = Measure.c of the selected measure
        0,                          // id = 0 for a new entry (long → 'A')
        Number(m.id),               // measureId
        0,                          // o: always 0
        Number(row.translationId || 0) // translationId (hit's, or 0 when it names the food itself)
      ]
    };
  }

  CMA.plan = {
    build,
    rechoose,
    repick,
    reposition,
    assignPositions,
    servingFor,
    defaultGroupId,
    resolveGroup,
    chooseHitIndex,
    isCustomHit,
    isEnergyItem,
    isMealRow,
    translationIdFor,
    foodDisplayName,
    foodTranslations,
    measuresFromHit,
    markUnverified,
    headerGroupFor,
    maxPositions,
    measuresOf,
    servingsOf,
    foodName,
    foodDefaultMeasureId,
    todayDate,
    SIG,
    DEFAULT_GROUPS,
    _sleep: sleep
  };
})();
