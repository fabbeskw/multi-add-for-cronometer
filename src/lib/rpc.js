/* rpc.js - Cronometer GWT-RPC + REST client (SPEC section 4).
 *
 * All calls take session = {moduleBase, permutation, policyHash, nonce, userId} (CMA.capture.session()).
 *   CMA.rpc.call(session, method, paramSigs, values[, {kind, timeoutMs}]) -> CMA.gwt.readResponse result
 *   CMA.rpc.getDayInfo(session, day)        -> DayInfo value; CMA.rpc.servingsOf(dayInfo) -> [Serving values]
 *   CMA.rpc.getFood(session, foodId)        -> Food value;    CMA.rpc.measuresOf(food) -> [{id, name, grams, type, foodId, hidden, ...}]
 *   CMA.rpc.updateDiaryAdd(session, serving) -> {servingId (GWT base64 long string), serving, results}
 *   CMA.rpc.removeServing(session, servingIdStr) -> true
 *   CMA.rpc.searchFoods(session, query, {maxResults=50, includeRetired=false}) -> hits
 *   CMA.errors = {Session, Throttled, Network, CmaError, isNetwork}   (guarded; plan.js defines the same block)
 *
 * Wire facts (research/live-app-report.md sections 2-5, research/serving-fields-resolved.md):
 *   POST moduleBase+'app', headers Content-Type: text/x-gwt-rpc; charset=utf-8, X-GWT-Permutation,
 *   X-GWT-Module-Base; //OK or //EX bodies with HTTP 200; updateDiary(String nonce, int userId, List) with
 *   one Collections$SingletonList(AddEntryChange(true, true, Serving)); removeServing(String, long, int) is
 *   VOID; getDayInfo(String, Day, int); getFood(String, int); food search is REST:
 *   GET /api/v3/user/{id}/food-search/string?query=UPPER&maxResults=..&sources=All&categoryId=0&selectedTab=ALL&type=All
 *   (cookie auth, no extra headers; spaces in the query are `+` like the app's `o2k` encoder).
 *   X-Cronometer-Throttle-Version is a response header.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ------------------------------------------------------------------------------------------------
  // Error classes (identical to the guarded block in plan.js, so load order does not matter)
  // ------------------------------------------------------------------------------------------------
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
      if (e instanceof TypeError && /fetch|network/i.test(String(e.message))) return true;
      if (e.name === 'AbortError') return true;
      return /failed to fetch|networkerror|network error|timed? ?out/i.test(String(e.message || ''));
    };
  }
  const E = CMA.errors;

  // ------------------------------------------------------------------------------------------------
  // constants / helpers
  // ------------------------------------------------------------------------------------------------
  const STRING_SIG = 'java.lang.String/2004016611';
  const LIST_SIG = 'java.util.List';
  const THROTTLE_HEADER = 'X-Cronometer-Throttle-Version';
  // GWT's RPC.decodeRequest rejects a request whose type CRCs no longer match its serialization policy with
  // IncompatibleRemoteServiceException / SerializationException ("Invalid type signature for ..."): the
  // generated registry is stale after a Cronometer deploy (SPEC 3.2).
  const INCOMPATIBLE_RE = /IncompatibleRemoteService|SerializationException|Invalid type signature/;
  const BASE = {
    SERVING: 'com.cronometer.shared.entries.models.Serving/',
    DAYINFO: 'com.cronometer.shared.entries.models.DayInfo/',
    FOOD: 'com.cronometer.shared.foods.models.Food/',
    MEASURE: 'com.cronometer.shared.foods.models.Measure/',
    AECR: 'com.cronometer.shared.entries.changes.AddEntryChangeResult/',
    EECR: 'com.cronometer.shared.entries.changes.ErrorEntryChangeResult/',
  };
  // Measure$Type ordinals ($pj in the bundle: Weight 0, Volume 1, Atomic 2, Recipe 3)
  const MEASURE_TYPE_NAMES = ['Weight', 'Volume', 'Atomic', 'Recipe'];

  const rpc = {
    defaults: { timeoutMs: 30000, searchTimeoutMs: 20000, maxResults: 50 },
    stats: { calls: 0, restCalls: 0, lastAt: null, lastMethod: null, lastStatus: null },
    // X-Cronometer-Throttle-Version tracking: a change means the server tightened its rate limits
    // (the app's ThrottleVersionMonitor re-fetches its throttle config). We back off once before the
    // NEXT request instead of failing the call that carried the header, because that call may have
    // been a successful, non-idempotent updateDiary.
    throttle: { version: null, changedAt: null, pending: false, backoffMs: 5000, backoffs: 0 },
  };

  function gwt() {
    if (!CMA.gwt || typeof CMA.gwt.readResponse !== 'function') throw new Error('CMA.rpc: CMA.gwt is not loaded (src/lib/gwt-stream.js must precede rpc.js)');
    return CMA.gwt;
  }
  function isType(v, prefix) { return !!v && typeof v === 'object' && typeof v.$t === 'string' && v.$t.indexOf(prefix) === 0 && Array.isArray(v.f); }
  function shortName(sig) { const base = String(sig || '').split('/')[0]; return base.slice(base.lastIndexOf('.') + 1); }
  function snippet(s, n) { return String(s == null ? '' : s).slice(0, n || 200); }
  function isPosInt(n) { return typeof n === 'number' && Number.isInteger(n) && n > 0; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function noteLog(kind, fields) {
    try { if (CMA.capture && typeof CMA.capture.log === 'function') CMA.capture.log(kind, fields); } catch (e) { /* ignore */ }
  }
  function emit(name, payload) { try { if (CMA.events) CMA.events.emit(name, payload); } catch (e) { /* ignore */ } }

  /** Throws when the session lacks what the call needs. A missing nonce is a Session error (not logged in / not captured). */
  function checkSession(session, needUserId) {
    if (!session || typeof session !== 'object') throw new Error('CMA.rpc: session is required ({moduleBase, permutation, policyHash, nonce, userId})');
    if (typeof session.moduleBase !== 'string' || !/^https?:\/\/.+\/$/.test(session.moduleBase)) throw new Error('CMA.rpc: session.moduleBase must be an absolute URL ending in / (got ' + snippet(session.moduleBase, 80) + ')');
    // SPEC 0: never contact another host. On the real (https) page the module base must be this origin.
    if (typeof location !== 'undefined' && location.protocol === 'https:' && originOf(session.moduleBase) !== location.origin) throw new Error('CMA.rpc: session.moduleBase origin ' + originOf(session.moduleBase) + ' differs from the page origin ' + location.origin);
    if (typeof session.policyHash !== 'string' || !session.policyHash) throw new Error('CMA.rpc: session.policyHash is missing (no GWT-RPC request captured yet)');
    if (typeof session.permutation !== 'string' || !session.permutation) throw new Error('CMA.rpc: session.permutation is missing (X-GWT-Permutation not captured yet)');
    if (typeof session.nonce !== 'string' || !session.nonce) throw new E.Session('no session nonce captured: reload the Cronometer tab and log in', { missing: 'nonce' });
    if (needUserId && !isPosInt(session.userId)) throw new Error('CMA.rpc: session.userId is missing');
  }
  function originOf(moduleBase) {
    try { return new URL(moduleBase).origin; } catch (e) { return (typeof location !== 'undefined' && location.origin) || 'https://cronometer.com'; }
  }

  /** Throttle-version bookkeeping. Returns true when the version changed against the last known one. */
  function noteThrottle(version) {
    if (version === null || version === undefined || version === '') return false;
    let prev = rpc.throttle.version;
    if (prev === null && CMA.capture && CMA.capture.state && CMA.capture.state.throttleVersion != null) prev = CMA.capture.state.throttleVersion;
    rpc.throttle.version = version;
    if (prev !== null && prev !== version) {
      rpc.throttle.changedAt = Date.now();
      rpc.throttle.pending = true;
      noteLog('throttle', { note: THROTTLE_HEADER + ' changed ' + prev + ' -> ' + version + '; backing off before the next request' });
      emit('throttle', { version: version, previous: prev, at: rpc.throttle.changedAt });
      return true;
    }
    return false;
  }
  async function backoffIfPending(opts) {
    if (!rpc.throttle.pending) return false;
    rpc.throttle.pending = false;
    if (opts && opts.throttleMode === 'throw') {
      throw new E.Throttled(THROTTLE_HEADER + ' changed; back off before sending more requests', { retryable: true, status: 0 });
    }
    rpc.throttle.backoffs++;
    const ms = opts && typeof opts.backoffMs === 'number' ? opts.backoffMs : rpc.throttle.backoffMs;
    emit('backoff', { ms: ms, reason: 'throttle-version' });
    await sleep(ms);
    return true;
  }

  /**
   * fetchText(url, init, timeoutMs) -> {status, ok, text, headers (lower-cased names), url}.
   * Transport failures and timeouts become CMA.errors.Network. Uses window.fetch at call time (tests stub it).
   */
  async function fetchText(url, init, timeoutMs) {
    const f = typeof window !== 'undefined' && window.fetch ? window.fetch : (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new E.Network('fetch is not available');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctrl && timeoutMs > 0) { init.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, timeoutMs); }
    let res;
    try {
      res = await f.call(window, url, init);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new E.Network('request timed out after ' + timeoutMs + ' ms (' + snippet(url, 120) + ')', { timeout: true, url: url });
      throw new E.Network((e && e.message) || 'fetch failed', { cause: e, url: url });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let text = '';
    try { text = await res.text(); } catch (e) { throw new E.Network('could not read the response body: ' + (e && e.message), { status: res.status, url: url }); }
    const headers = {};
    try { res.headers.forEach(function (v, k) { headers[String(k).toLowerCase()] = v; }); } catch (e) { /* ignore */ }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text: text, headers: headers, url: url };
  }

  // ------------------------------------------------------------------------------------------------
  // CMA.rpc.call
  // ------------------------------------------------------------------------------------------------
  /**
   * call(session, method, paramSigs, values[, opts]) -> {ok:true, value, ...} (CMA.gwt.readResponse result).
   * opts.kind = response reader kind ('o' default, 'v' for VOID methods, 's', 'i', ...), opts.timeoutMs.
   * Throws CMA.errors.Session (NotLoggedInException, HTTP 401/403, login page), CMA.errors.Throttled
   * (HTTP 429, .status=429, .retryable=true), CMA.errors.Network (transport/timeout, HTTP 502/503 with an
   * empty body) or a plain Error for //EX (e.kind='rpc', e.exception) and other HTTP errors (e.status).
   */
  async function call(session, method, paramSigs, values, opts) {
    opts = opts || {};
    checkSession(session, false);
    const g = gwt();
    if (typeof method !== 'string' || !method) throw new Error('CMA.rpc.call: method name is required');
    const body = new g.Writer(session.moduleBase, session.policyHash).call(method, paramSigs, values);
    await backoffIfPending(opts);
    const url = session.moduleBase + 'app';
    const init = {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'text/x-gwt-rpc; charset=utf-8',
        'X-GWT-Permutation': session.permutation,
        'X-GWT-Module-Base': session.moduleBase,
      },
      body: body,
    };
    const t0 = Date.now();
    rpc.stats.calls++;
    rpc.stats.lastMethod = method;
    let res;
    try {
      res = await fetchText(url, init, typeof opts.timeoutMs === 'number' ? opts.timeoutMs : rpc.defaults.timeoutMs);
    } catch (e) {
      noteLog('rpc-out', { method: method, error: e.message, ms: Date.now() - t0 });
      throw e;
    }
    rpc.stats.lastAt = Date.now();
    rpc.stats.lastStatus = res.status;
    const text = res.text || '';
    const okText = text.indexOf('//OK') === 0;
    const exText = text.indexOf('//EX') === 0;
    noteLog('rpc-out', { method: method, status: res.status, ok: okText, ex: exText, ms: Date.now() - t0, throttle: res.headers[THROTTLE_HEADER.toLowerCase()] || null });
    noteThrottle(res.headers[THROTTLE_HEADER.toLowerCase()]);

    if (res.status === 429) throw new E.Throttled('HTTP 429 (too many requests) from ' + method, { status: 429, retryable: true, method: method });
    if (res.status === 401 || res.status === 403) throw new E.Session('HTTP ' + res.status + ' from ' + method + ': not logged in', { status: res.status, method: method });
    if ((res.status === 502 || res.status === 503) && text.trim() === '') {
      throw new E.Network('HTTP ' + res.status + ' with an empty body from ' + method + ' (the request did not reach the app)', { status: res.status, method: method });
    }
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status + ' from ' + method + (text ? ': ' + snippet(text) : ''));
      e.status = res.status; e.method = method; e.body = snippet(text, 500); e.kind = 'http';
      throw e;
    }
    if (!okText && !exText) {
      if (/<html|<!doctype|login/i.test(text.slice(0, 600))) throw new E.Session('the server answered with a page instead of a GWT-RPC response (logged out?)', { status: res.status, method: method });
      const e = new Error('unexpected response from ' + method + ': ' + snippet(text, 120));
      e.status = res.status; e.method = method; e.kind = 'http';
      throw e;
    }
    let r;
    try {
      r = g.readResponse(text, opts.kind || 'o');
    } catch (e) {
      // An //EX whose payload the registry cannot read (a deploy changed an exception class's CRC) still names
      // its type in the raw string table: classify it from the text so a session loss stops the batch and a
      // stale registry keeps its hint instead of both degrading to a bare 'decode'.
      if (exText) {
        if (/NotLoggedInException/.test(text)) throw new E.Session('not logged in (undecodable NotLoggedInException from ' + method + ')', { method: method, raw: snippet(text, 300) });
        if (INCOMPATIBLE_RE.test(text)) {
          const inc = new Error('the server rejected the ' + method + ' request as incompatible (undecodable //EX) — the serializer registry is out of date for this Cronometer build: run tools/fetch_bundle.py + tools/gen_registry.py, or switch to the UI automation engine');
          inc.kind = 'incompatible'; inc.method = method; inc.raw = snippet(text, 300);
          throw inc;
        }
      }
      const err = new Error('cannot decode the ' + method + ' response: ' + (e && e.message));
      err.method = method; err.raw = snippet(text, 300); err.kind = 'decode';
      // An //OK means the server already executed the call (for updateDiary: the entry IS in the diary);
      // only the reply is unreadable. Callers must not treat this as "not done" and re-send (SPEC 6.4).
      err.applied = okText;
      throw err;
    }
    if (!r.ok) {
      const type = (r.exception && r.exception.type) || 'exception';
      const message = r.exception && r.exception.message;
      if (/NotLoggedInException/.test(type)) throw new E.Session(message || 'not logged in', { method: method, exception: r.exception });
      if (INCOMPATIBLE_RE.test(type) || INCOMPATIBLE_RE.test(String(message || ''))) {
        const inc = new Error(shortName(type) + (message ? ': ' + message : '') + ' (from ' + method + ') — the serializer registry is out of date for this Cronometer build: run tools/fetch_bundle.py + tools/gen_registry.py, or switch to the UI automation engine');
        inc.kind = 'incompatible'; inc.method = method; inc.exception = r.exception; inc.exceptionType = type;
        throw inc;
      }
      const e = new Error(shortName(type) + (message ? ': ' + message : '') + ' (from ' + method + ')');
      e.kind = 'rpc'; e.method = method; e.exception = r.exception; e.exceptionType = type; e.message2 = message;
      throw e;
    }
    return r;
  }

  // ------------------------------------------------------------------------------------------------
  // value helpers
  // ------------------------------------------------------------------------------------------------
  function dayValue(day) {
    const g = gwt();
    if (day && typeof day === 'object' && typeof day.$t === 'string' && Array.isArray(day.f)) return day;
    let d, m, y;
    if (day instanceof Date) { d = day.getDate(); m = day.getMonth() + 1; y = day.getFullYear(); }
    else if (day && typeof day === 'object') { d = Number(day.day); m = Number(day.month); y = Number(day.year); }
    if (!isPosInt(d) || !isPosInt(m) || !isPosInt(y) || m > 12 || d > 31) throw new Error('CMA.rpc: day must be {day, month (1-12), year} (got ' + snippet(JSON.stringify(day), 80) + ')');
    return { $t: g.SIG.DAY, f: [d, m, y] };   // Day/782579793 = [b day, b month, h year] (SPEC 3.3)
  }
  /** Measure$Type -> 'Weight' | 'Volume' | 'Atomic' | 'Recipe' | null (accepts the enum value, an ordinal or a name). */
  function measureTypeName(t) {
    if (t === null || t === undefined) return null;
    if (typeof t === 'string') return t;
    if (typeof t === 'number') return MEASURE_TYPE_NAMES[t] || String(t);
    if (typeof t === 'object' && Number.isInteger(t.ordinal)) return MEASURE_TYPE_NAMES[t.ordinal] || String(t.ordinal);
    return null;
  }
  /** The detail message of a decoded Throwable ({$t, f}): the string slot the registry marks 's', else the first string field. */
  function exceptionMessage(ex) {
    if (!ex || typeof ex !== 'object') return null;
    if (typeof ex.message === 'string') return ex.message;
    if (!Array.isArray(ex.f)) return null;
    try {
      const entry = CMA.registry && CMA.registry.types && CMA.registry.types[ex.$t];
      if (entry && entry.k === 'class' && Array.isArray(entry.f)) {
        const i = entry.f.indexOf('s');
        if (i >= 0 && typeof ex.f[i] === 'string') return ex.f[i];
      }
    } catch (e) { /* fall through */ }
    for (let i = 0; i < ex.f.length; i++) if (typeof ex.f[i] === 'string') return ex.f[i];
    return null;
  }

  // ------------------------------------------------------------------------------------------------
  // getDayInfo / servingsOf
  // ------------------------------------------------------------------------------------------------
  /** getDayInfo(session, day[, opts]) -> DayInfo value ([z, o Day, o list, o list, z, s]); day = {day, month, year} | Day value | Date. */
  async function getDayInfo(session, day, opts) {
    checkSession(session, true);
    const g = gwt();
    const r = await call(session, 'getDayInfo', [STRING_SIG, g.SIG.DAY, 'I'], [session.nonce, dayValue(day), session.userId], opts);
    const v = r.value;
    if (v !== null && !isType(v, BASE.DAYINFO)) throw new Error('getDayInfo returned an unexpected value (' + (v && v.$t) + ')');
    return v;
  }
  /** servingsOf(dayInfo) -> every Serving value found (at any depth) in the DayInfo's two entry lists, in order. */
  function servingsOf(dayInfo) {
    if (!dayInfo || !Array.isArray(dayInfo.f)) return [];
    const g = gwt();
    const F = g.F.DAYINFO;
    const lists = [dayInfo.f[F.LIST1], dayInfo.f[F.LIST2]].filter(function (x) { return x !== null && x !== undefined; });
    const out = [];
    const seen = new Set();
    g.walk(lists, function (node) {
      if (isType(node, BASE.SERVING) && !seen.has(node)) { seen.add(node); out.push(node); return false; }
      return true;
    });
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // getFood / measuresOf
  // ------------------------------------------------------------------------------------------------
  /** getFood(session, foodId[, opts]) -> Food value (20 fields, SPEC 3.3). */
  async function getFood(session, foodId, opts) {
    checkSession(session, false);
    const id = Number(foodId);
    if (!isPosInt(id)) throw new Error('CMA.rpc.getFood: foodId must be a positive integer (got ' + snippet(foodId, 40) + ')');
    const r = await call(session, 'getFood', [STRING_SIG, 'I'], [session.nonce, id], opts);
    const v = r.value;
    if (v === null || v === undefined) { const e = new Error('getFood(' + id + ') returned no food'); e.kind = 'notfound'; throw e; }
    if (!isType(v, BASE.FOOD)) throw new Error('getFood returned an unexpected value (' + (v && v.$t) + ')');
    return v;
  }
  function foodMeasuresOf(food) {
    const g = gwt();
    const fm = food && Array.isArray(food.f) ? food.f[g.F.FOOD.MEASURES] : null;
    return fm && Array.isArray(fm.f) ? fm : null;     // FoodMeasures/2106205728 = [i (unverified), o list<Measure>]
  }
  /**
   * FoodMeasures.f[0] as a positive int, or null: the food's DEFAULT measure id (SPEC 3.3 / 5.3). The Add Food
   * dialog's `TCe` (build 0A1C16E148676A90CBB128E4829A562F) walks the measure list and selects the entry whose
   * id equals it: `h=f.e!=0; d=b.p.a==f.e; (h&&d||e)&&(j=f)` with `b.p` = the food's FoodMeasures (`b.p.b` is
   * the list `VCe` sorts) and `f.e` = Measure.measureId. An earlier comment here said the app never reads
   * FoodMeasures.a (only the deserializer `Qmj` assigns it); that missed the read in `TCe`. `Q0i`/`mpj` (measure by
   * a serving's measureId, else the first plain 1 g 'g') serve only an EXISTING serving being edited, and the
   * last-used-serving cache (`hte` -> `mze`) sits on top of both. 0 (custom foods) is null: no default. Consumed
   * through measuresOf().isDefault and CMA.plan.foodDefaultMeasureId by CMA.units.defaultMeasure / suggestMeasure.
   */
  function defaultMeasureIdOf(food) {
    const fm = foodMeasuresOf(food);
    return fm && isPosInt(fm.f[0]) ? fm.f[0] : null;
  }
  /** measuresOf(food) -> [{id, name, grams, type, typeOrdinal, foodId, isDefault, amount, ml, hidden}] (Measure fields via
   *  CMA.gwt.F.MEASURE). `isDefault` marks the measure FoodMeasures.f[0] names: the one the Add Food dialog starts
   *  on (`TCe`, see defaultMeasureIdOf); CMA.units.defaultMeasure / suggestMeasure consume it for a line typed
   *  without a unit (SPEC 5.3). `hidden` is Measure.f[3] ('Hidden' in the measure editor): the dialog's `VCe` drops
   *  such measures, so units.defaultMeasure / suggestMeasure never fall back to one. */
  function measuresOf(food) {
    const g = gwt();
    const M = g.F.MEASURE;
    const fm = foodMeasuresOf(food);
    if (!fm) return [];
    const defaultId = isPosInt(fm.f[0]) ? fm.f[0] : null;
    const list = Array.isArray(fm.f[1]) ? fm.f[1] : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!isType(m, BASE.MEASURE)) continue;
      const type = m.f[M.TYPE];
      out.push({
        id: m.f[M.ID],
        name: m.f[M.NAME] == null ? '' : String(m.f[M.NAME]),
        grams: Number(m.f[M.GRAMS]) || 0,
        type: measureTypeName(type),
        typeOrdinal: type && typeof type === 'object' && Number.isInteger(type.ordinal) ? type.ordinal : (typeof type === 'number' ? type : null),
        foodId: m.f[M.FOOD],
        isDefault: defaultId !== null && m.f[M.ID] === defaultId,
        // Measure.a: the amount the dialog shows before the name when != 1 ('1/2 cup'); Measure.f: the ml value
        // behind the ' — N ml' suffix of Volume measures (qqj/pqj). Both drive the UI engine's label matching.
        amount: typeof m.f[M.AMOUNT] === 'number' && m.f[M.AMOUNT] > 0 ? m.f[M.AMOUNT] : 1,
        ml: typeof m.f[M.ML] === 'number' ? m.f[M.ML] : null,
        hidden: m.f[M.HIDDEN] === true,
      });
    }
    return out;
  }
  function foodName(food) { const g = gwt(); return food && Array.isArray(food.f) ? food.f[g.F.FOOD.NAME] : null; }
  function foodId(food) { const g = gwt(); return food && Array.isArray(food.f) ? food.f[g.F.FOOD.ID] : null; }

  // ------------------------------------------------------------------------------------------------
  // updateDiaryAdd / removeServing
  // ------------------------------------------------------------------------------------------------
  /** Accepts a Serving value ({$t, f:[13]}) or a plain {day, order, grams, foodId, measureId, translationId?, userId?, time?}. */
  function servingValue(serving) {
    const g = gwt();
    if (isType(serving, BASE.SERVING)) {
      if (serving.f.length !== 13) throw new Error('CMA.rpc: Serving needs 13 fields (SPEC 3.3), got ' + serving.f.length);
      // The wire layer is the last line of defence against a malformed updateDiary: Encoder.double would put
      // NaN/Infinity on the wire and the ints are validated only when tokenised, after the day was written.
      const f = serving.f, S = g.F.SERVING;
      if (!isType(f[S.DAY], 'com.cronometer.shared.entries.models.Day/')) throw new Error('CMA.rpc: Serving day must be a Day value');
      if (!Number.isInteger(f[S.ORDER])) throw new Error('CMA.rpc: Serving order must be an integer (got ' + snippet(f[S.ORDER], 40) + ')');
      if (!(Number.isFinite(f[S.GRAMS]) && f[S.GRAMS] >= 0)) throw new Error('CMA.rpc: Serving grams must be a finite number >= 0 (got ' + snippet(f[S.GRAMS], 40) + ')');
      if (!isPosInt(f[S.FOOD])) throw new Error('CMA.rpc: Serving foodId must be a positive integer (got ' + snippet(f[S.FOOD], 40) + ')');
      if (!isPosInt(f[S.MEASURE])) throw new Error('CMA.rpc: Serving measureId must be a positive integer (got ' + snippet(f[S.MEASURE], 40) + ')');
      if (!Number.isInteger(f[S.TRANSLATION]) || f[S.TRANSLATION] < 0) throw new Error('CMA.rpc: Serving translationId must be an integer >= 0');
      return serving;
    }
    if (!serving || typeof serving !== 'object') throw new Error('CMA.rpc.updateDiaryAdd: a Serving value is required');
    const grams = Number(serving.grams);
    if (!isPosInt(Number(serving.foodId)) || !isPosInt(Number(serving.measureId)) || !(grams >= 0)) throw new Error('CMA.rpc.updateDiaryAdd: foodId, measureId and grams are required');
    // Serving/2553599101 wire order (serving-fields-resolved.md section 2): day, b, c, offset, order, time,
    // userId, grams, foodId, id, measureId, o, translationId; a new entry sends b=c=true, id=0 ('A'), o=0.
    return { $t: g.SIG.SERVING, f: [
      dayValue(serving.day), true, true, null, Number(serving.order) || 0, serving.time || null,
      Number(serving.userId) || 0, grams, Number(serving.foodId), 0, Number(serving.measureId), 0, Number(serving.translationId) || 0,
    ] };
  }
  /**
   * updateDiaryAdd(session, serving) -> {servingId, serving, results}. Sends updateDiary(nonce, userId,
   * SingletonList(AddEntryChange(true, true, serving))) - byte-equal to the UI's body for the same values -
   * and reads the AddEntryChangeResult; an ErrorEntryChangeResult becomes an Error carrying the server message.
   */
  async function updateDiaryAdd(session, serving, opts) {
    checkSession(session, true);
    const g = gwt();
    const sv = servingValue(serving);
    const change = { $t: g.SIG.ADD_ENTRY_CHANGE, f: [true, true, sv] };            // KZi: a=true, b=true, c=entry
    const list = { $t: g.SIG.SINGLETON, f: [change] };                            // lso: SingletonList, element only
    const r = await call(session, 'updateDiary', [STRING_SIG, 'I', LIST_SIG], [session.nonce, session.userId, list], opts);
    const results = Array.isArray(r.value) ? r.value : (r.value === null || r.value === undefined ? [] : [r.value]);
    if (!results.length) { const e = new Error('updateDiary returned no result'); e.kind = 'rpc'; throw e; }
    const first = results[0];
    if (isType(first, BASE.AECR)) {
      const s = first.f[0];
      if (!isType(s, BASE.SERVING)) throw new Error('updateDiary result carries no Serving (' + (s && s.$t) + ')');
      const id = s.f[g.F.SERVING.ID];
      return { servingId: id === null || id === undefined ? null : String(id), serving: s, results: results };
    }
    if (isType(first, BASE.EECR)) {
      const ex = first.f[0];
      const message = exceptionMessage(ex);
      const e = new Error('updateDiary rejected the entry: ' + (message || shortName(ex && ex.$t) || 'unknown error'));
      e.kind = 'rejected'; e.method = 'updateDiary'; e.exception = ex; e.entry = first.f[1]; e.serverMessage = message;
      throw e;
    }
    const e = new Error('updateDiary returned an unexpected result type (' + (first && first.$t) + ')');
    e.kind = 'rpc'; e.results = results;
    throw e;
  }
  /** removeServing(session, servingId[, opts]) -> true. servingId = GWT base64 string from updateDiaryAdd (passed verbatim) or a number. */
  async function removeServing(session, servingId, opts) {
    checkSession(session, true);
    const g = gwt();
    let id = servingId;
    if (typeof id === 'string') {
      id = id.trim();
      if (!g.isLongToken(id)) throw new Error('CMA.rpc.removeServing: servingId must be a GWT base64 long (got ' + snippet(servingId, 40) + ')');
    } else if (typeof id !== 'number' && typeof id !== 'bigint') {
      throw new Error('CMA.rpc.removeServing: servingId is required');
    }
    // removeServing(String, long, int) has a VOID response reader (live-app-report.md section 3)
    await call(session, 'removeServing', [STRING_SIG, 'J', 'I'], [session.nonce, { l: id }, session.userId], Object.assign({}, opts || {}, { kind: 'v' }));
    return true;
  }

  // ------------------------------------------------------------------------------------------------
  // searchFoods (REST)
  // ------------------------------------------------------------------------------------------------
  /** The app's query-string encoder (`o2k`): encodeURIComponent with `%20` turned into `+` (GWT URL.encodeQueryString). */
  function encodeQueryValue(s) { return encodeURIComponent(String(s)).replace(/%20/g, '+'); }
  function searchUrl(session, query, maxResults) {
    // Byte-identical to the UI's request (`fBe` param order, `zJf`/`PIf` join): query, maxResults, sources,
    // categoryId, selectedTab, type.
    return originOf(session.moduleBase) + '/api/v3/user/' + session.userId + '/food-search/string'
      + '?query=' + encodeQueryValue(String(query).toUpperCase())
      + '&maxResults=' + maxResults + '&sources=All&categoryId=0&selectedTab=ALL&type=All';
  }
  /** One REST hit -> the SPEC 4 shape. JSON names verified in the bundle's JSON->SearchHit converter (VEe). */
  function mapHit(h) {
    if (!h || typeof h !== 'object') return null;
    const id = Number(h.id);
    if (!isPosInt(id)) return null;
    return {
      id: id,
      name: h.name == null ? '' : String(h.name),
      measureId: Number(h.measureId) || 0,
      measureDisplayName: h.measureDisplayName == null ? '' : String(h.measureDisplayName),
      score: Number(h.score) || 0,
      source: h.source == null ? null : String(h.source),
      type: h.type == null ? null : String(h.type),
      translationId: Number(h.translationId) || 0,
      retired: h.retired === true || h.retired === 'true',
      displayString: h.displayString == null ? null : String(h.displayString),
    };
  }
  /**
   * searchFoods(session, query, {maxResults=50, includeRetired=false, timeoutMs}) -> hits
   * [{id, name, measureId, measureDisplayName, score, source, type, translationId, retired}] in server order.
   */
  async function searchFoods(session, query, opts) {
    opts = opts || {};
    if (!session || typeof session !== 'object') throw new Error('CMA.rpc.searchFoods: session is required');
    if (!isPosInt(session.userId)) throw new Error('CMA.rpc.searchFoods: session.userId is missing');
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    const maxResults = isPosInt(opts.maxResults) ? opts.maxResults : rpc.defaults.maxResults;
    await backoffIfPending(opts);
    const url = searchUrl(session, q, maxResults);
    const t0 = Date.now();
    rpc.stats.restCalls++;
    let res;
    try {
      // No Accept header: the app's REST client (`SIf`) sets only Content-Type, and only when a body is sent.
      res = await fetchText(url, { method: 'GET', credentials: 'same-origin' },
        typeof opts.timeoutMs === 'number' ? opts.timeoutMs : rpc.defaults.searchTimeoutMs);
    } catch (e) {
      noteLog('rest-out', { path: '/food-search/string', error: e.message, ms: Date.now() - t0 });
      throw e;
    }
    // The query is the food name the user typed: keep it out of the capture log (it ends up in the diagnostics dump).
    noteLog('rest-out', { path: '/food-search/string', status: res.status, ms: Date.now() - t0, queryLength: q.length });
    noteThrottle(res.headers[THROTTLE_HEADER.toLowerCase()]);
    let json = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { json = null; }
    if (res.status === 401) throw new E.Session('HTTP 401 from the food search: not logged in', { status: 401 });
    if (res.status === 429) throw new E.Throttled('HTTP 429 (too many requests) from the food search', { status: 429, retryable: true });
    if ((res.status === 502 || res.status === 503) && res.text.trim() === '') throw new E.Network('HTTP ' + res.status + ' with an empty body from the food search', { status: res.status });
    if (!res.ok) {
      const msg = json && typeof json === 'object' && json.message ? String(json.message) : snippet(res.text, 160);
      const e = new Error('food search failed: HTTP ' + res.status + (msg ? ': ' + msg : ''));
      e.status = res.status; e.kind = 'http'; e.body = snippet(res.text, 500);
      throw e;
    }
    if (json === null) {
      if (/<html|<!doctype|login/i.test(res.text.slice(0, 600))) throw new E.Session('the food search answered with a page instead of JSON (logged out?)', { status: res.status });
      const e = new Error('food search returned invalid JSON: ' + snippet(res.text, 120));
      e.kind = 'decode';
      throw e;
    }
    let raw = Array.isArray(json) ? json : (json && typeof json === 'object' ? (json.foods || json.hits || json.results || json.items || json.data || []) : []);
    if (!Array.isArray(raw)) raw = [];
    const hits = [];
    for (let i = 0; i < raw.length; i++) {
      const h = mapHit(raw[i]);
      if (!h) continue;
      if (h.retired && !opts.includeRetired) continue;
      hits.push(h);
    }
    return hits;
  }

  // ------------------------------------------------------------------------------------------------
  // exports
  // ------------------------------------------------------------------------------------------------
  rpc.call = call;
  rpc.getDayInfo = getDayInfo;
  rpc.servingsOf = servingsOf;
  rpc.getFood = getFood;
  rpc.measuresOf = measuresOf;
  rpc.defaultMeasureIdOf = defaultMeasureIdOf;
  rpc.foodName = foodName;
  rpc.foodId = foodId;
  rpc.updateDiaryAdd = updateDiaryAdd;
  rpc.removeServing = removeServing;
  rpc.searchFoods = searchFoods;
  rpc.searchUrl = searchUrl;
  rpc.encodeQueryValue = encodeQueryValue;
  rpc.mapHit = mapHit;
  rpc.servingValue = servingValue;
  rpc.dayValue = dayValue;
  rpc.measureTypeName = measureTypeName;
  rpc.exceptionMessage = exceptionMessage;
  rpc.checkSession = checkSession;
  rpc.fetchText = fetchText;
  rpc.STRING_SIG = STRING_SIG;
  rpc.THROTTLE_HEADER = THROTTLE_HEADER;
  rpc.MEASURE_TYPE_NAMES = MEASURE_TYPE_NAMES;
  CMA.rpc = rpc;
})();
