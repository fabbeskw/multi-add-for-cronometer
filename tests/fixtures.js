/* tests/fixtures.js - captured GWT-RPC strings (SPEC section 9) and synthetic value-graph builders.
 * Exposes window.CMA.fixtures. The builders return value graphs in the shape gwt-stream.js reads and
 * writes ({$t, f:[...]}, {$t, ordinal}, arrays, Maps) so other test pages can fabricate authenticate /
 * DayInfo / Food / updateDiary responses with CMA.gwt.encodeResponse(...).
 * Load order: lib.js, ../src/lib/gwt-registry.js, ../src/lib/gwt-stream.js, fixtures.js.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // Full type signatures of build 0A1C16E148676A90CBB128E4829A562F (SPEC 3.3). CMA.gwt.sig(base) resolves
  // the same names from whatever registry is loaded; these literals are what the captured strings contain.
  const SIG = {
    STRING: 'java.lang.String/2004016611',
    INTEGER: 'java.lang.Integer/3438268394',
    ARRAYLIST: 'java.util.ArrayList/4159755760',
    HASHMAP: 'java.util.HashMap/1797211028',
    SINGLETON: 'java.util.Collections$SingletonList/1586180994',
    DAY: 'com.cronometer.shared.entries.models.Day/782579793',
    TIME: 'com.cronometer.shared.entries.models.Time/1552252503',
    SERVING: 'com.cronometer.shared.entries.models.Serving/2553599101',
    DAYINFO: 'com.cronometer.shared.entries.models.DayInfo/416556043',
    AEC: 'com.cronometer.shared.entries.changes.AddEntryChange/3949104564',
    AECR: 'com.cronometer.shared.entries.changes.AddEntryChangeResult/2006663169',
    EECR: 'com.cronometer.shared.entries.changes.ErrorEntryChangeResult/4150648168',
    MEASURE: 'com.cronometer.shared.foods.models.Measure/1979099908',
    MEASURE_TYPE: 'com.cronometer.shared.foods.models.Measure$Type/2365167904',
    FOOD_MEASURES: 'com.cronometer.shared.foods.models.FoodMeasures/2106205728',
    FOOD: 'com.cronometer.shared.foods.models.Food/2097636843',
    FOOD_SOURCE: 'com.cronometer.shared.foods.FoodSource/4236433762',
    FOOD_TYPE: 'com.cronometer.shared.foods.FoodType/2323555378',
    NUTRIENT_MAP: 'com.cronometer.shared.foods.models.NutrientMap/168231382',
    NUTRIENT_FILTER: 'com.cronometer.shared.foods.models.NutrientMap$NutrientFilter/1990310964',
    NUTRIENT: 'com.cronometer.shared.foods.models.Nutrient/331784102',
    NUTRIENT_TYPE: 'com.cronometer.shared.foods.models.Nutrient$Type/4187872513',
    TRANSLATION: 'com.cronometer.shared.foods.models.Translation/4034452093',
    SEARCH_HIT: 'com.cronometer.shared.foods.models.SearchHit/1904627920',
    USER: 'com.cronometer.shared.user.models.User/91151502',
    USER_PREFS: 'com.cronometer.shared.user.models.UserPreferences/1003470664',
    NOT_LOGGED_IN: 'com.cronometer.shared.user.exceptions.NotLoggedInException/844385496',
    RUNTIME_EXCEPTION: 'java.lang.RuntimeException/515124647',
    STRING_ARRAY: '[Ljava.lang.String;/2600011424',
  };

  const moduleBase = 'https://cronometer.com/cronometer/';
  const SERVICE = 'com.cronometer.shared.rpc.CronometerService';
  const HEAD = moduleBase + '|POLICY|' + SERVICE + '|';

  // ---- captured strings (SPEC 9) -------------------------------------------------------------------
  const updateDiaryResponse = '//OK[0,0,1072101,"D80lp$",464674,50.0,1234567,0,65541,0,1,1,2026,3,4,4,3,2,1,1,'
    + '["java.util.ArrayList/4159755760","com.cronometer.shared.entries.changes.AddEntryChangeResult/2006663169",'
    + '"com.cronometer.shared.entries.models.Serving/2553599101","com.cronometer.shared.entries.models.Day/782579793"],0,7]';
  const editDiaryEntriesResponse = '//OK[409412,0,1055762,"D9zN$G",461776,28.0,1234567,0,65540,0,1,1,2026,3,8,3,2,1,1,'
    + '["java.util.ArrayList/4159755760","com.cronometer.shared.entries.models.Serving/2553599101",'
    + '"com.cronometer.shared.entries.models.Day/782579793"],0,7]';
  const notLoggedInResponse = '//EX[2,1,["com.cronometer.shared.user.exceptions.NotLoggedInException/844385496","authentication failed"],0,7]';
  const voidResponse = '//OK[[],0,7]';
  // a pre-version-8 style payload (JS literal, not JSON): single quotes, \x and \0 escapes
  const v7LiteralResponse = "//OK[1,['caf\\xe9\\0|'],0,7]";

  // ---- request templates (SPEC 4) for the fixed inputs of SPEC 9: day 4/3/2026, order 65537, grams 50,
  //      foodId 464674, measureId 1072101, userId 1234567, translation 0, nonce NONCE, policy POLICY ----
  const updateDiaryTemplate = '7|0|12|' + HEAD + 'updateDiary|java.lang.String/2004016611|I|java.util.List|NONCE|'
    + 'java.util.Collections$SingletonList/1586180994|com.cronometer.shared.entries.changes.AddEntryChange/3949104564|'
    + 'com.cronometer.shared.entries.models.Serving/2553599101|com.cronometer.shared.entries.models.Day/782579793|'
    + '1|2|3|4|3|5|6|7|8|1234567|9|10|1|1|11|12|4|3|2026|1|1|0|65537|0|0|50|464674|A|1072101|0|0|';
  const getDayInfoTemplate = '7|0|8|' + HEAD + 'getDayInfo|java.lang.String/2004016611|'
    + 'com.cronometer.shared.entries.models.Day/782579793|I|NONCE|1|2|3|4|3|5|6|7|8|6|4|3|2026|1234567|';
  const getFoodTemplate = '7|0|7|' + HEAD + 'getFood|java.lang.String/2004016611|I|NONCE|1|2|3|4|2|5|6|7|464674|';
  const removeServingTemplate = '7|0|8|' + HEAD + 'removeServing|java.lang.String/2004016611|J|I|NONCE|1|2|3|4|3|5|6|7|8|D80lp$|1234567|';
  // authenticate(Integer utcOffsetMinutes) as the unofficial python client sends it (client.py GWT_AUTHENTICATE)
  const authenticateTemplate = '7|0|5|' + HEAD + 'authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|';

  // ---- value-graph builders ------------------------------------------------------------------------
  function day(d, m, y) { return { $t: SIG.DAY, f: [d, m, y] }; }              // Day: [b day, b month(1-12), h year]
  function time(h, m, s) { return { $t: SIG.TIME, f: [h, m, s || 0] }; }       // Time: [b h, b m, b s]
  /** Serving (SPEC 3.3): {day, b, c, offset, order, time, userId, grams, foodId, id, measureId, o, translationId} */
  function serving(o) {
    o = o || {};
    return { $t: SIG.SERVING, f: [
      o.day || day(4, 3, 2026),
      o.b === undefined ? true : o.b,
      o.c === undefined ? true : o.c,
      o.offset === undefined ? null : o.offset,
      o.order || 0,
      o.time || null,
      o.userId || 0,
      o.grams || 0,
      o.foodId || 0,
      o.id === undefined ? 'A' : o.id,         // long: number, BigInt or a base64 string such as 'D80lp$' ('A' = 0)
      o.measureId || 0,
      o.o || 0,
      o.translationId || 0,
    ] };
  }
  function addEntryChange(entry) { return { $t: SIG.AEC, f: [true, true, entry] }; }
  function addEntryChangeResult(entry) { return { $t: SIG.AECR, f: [entry] }; }
  function errorEntryChangeResult(message, entry) {
    return { $t: SIG.EECR, f: [{ $t: SIG.RUNTIME_EXCEPTION, f: [message] }, entry === undefined ? null : entry] };
  }
  /** Measure (SPEC 3.3): {a, b, foodId, d (hidden; `hidden` is an alias), id, f, name, i, type (0 Weight, 1 Volume, 2 Atomic, 3 Recipe), grams} */
  function measure(o) {
    o = o || {};
    return { $t: SIG.MEASURE, f: [
      o.a || 0, !!o.b, o.foodId || 0, !!(o.d || o.hidden), o.id || 0,
      o.f === undefined ? null : o.f,
      o.name === undefined ? null : o.name,
      o.i === undefined ? null : o.i,
      o.type === null ? null : { $t: SIG.MEASURE_TYPE, ordinal: o.type || 0 },
      o.grams || 0,
    ] };
  }
  function foodMeasures(defaultMeasureId, measures) {
    return { $t: SIG.FOOD_MEASURES, f: [defaultMeasureId || 0, measures || []] };
  }
  function translation(name, id) { return { $t: SIG.TRANSLATION, f: [null, name, id || 0] }; }
  /** Nutrient (SPEC 3.3 / Appendix N): [d amount, i id, o type (Nutrient$Type: 0 PRIMARY, 1 ALTERNATIVE, 2 CALCULATED, 3 MANUAL_ENTRY, 4 FORMULATION)] */
  function nutrient(amount, id, type) {
    return { $t: SIG.NUTRIENT, f: [amount, id, type === null ? null : { $t: SIG.NUTRIENT_TYPE, ordinal: type || 0 }] };
  }
  /** NutrientMap: [o filter (0 ALL, 1 PRIMARY) | null, o HashMap<Integer, Nutrient>]. nutrients = {id: amount | {amount, type}}
   *  (type defaults to PRIMARY); the keys are {i: id} so the Encoder writes java.lang.Integer boxes, as the server does. */
  function nutrientMap(nutrients, filter) {
    const m = new Map();
    Object.keys(nutrients || {}).forEach(function (k) {
      const v = nutrients[k];
      m.set({ i: Number(k) }, typeof v === 'number' ? nutrient(v, Number(k), 0) : nutrient(v.amount, Number(k), v.type));
    });
    return { $t: SIG.NUTRIENT_MAP, f: [filter === undefined || filter === null ? null : { $t: SIG.NUTRIENT_FILTER, ordinal: filter }, m] };
  }
  /** Food (20 fields): {id, name, category, defaultMeasureId, measures:[measure], translations, type, source,
   *  nutrients: {208: kcal, …} (field 12, absent → null), nutrientFilter: 0 ALL | 1 PRIMARY | null} */
  function food(o) {
    o = o || {};
    return { $t: SIG.FOOD, f: [
      0, false, null, o.category || 0, o.name === undefined ? null : o.name, 0, 0, o.id || 0, null, null, 'A',
      foodMeasures(o.defaultMeasureId, o.measures), o.nutrients ? nutrientMap(o.nutrients, o.nutrientFilter) : null, null, false, o.source === undefined ? null : o.source,
      null, o.translations || [], o.type === undefined || o.type === null ? null : { $t: SIG.FOOD_TYPE, ordinal: o.type }, 0,
    ] };
  }
  /** SearchHit: {category, globalPopularity, id, language, measureDisplayName, measureId, name, retired, score, source, stemName, translationId, type, userPopularity} */
  function searchHit(o) {
    o = o || {};
    return { $t: SIG.SEARCH_HIT, f: [
      o.category || 0, o.globalPopularity || 0, o.id || 0, o.language === undefined ? null : o.language,
      o.measureDisplayName === undefined ? null : o.measureDisplayName, o.measureId || 0, o.name === undefined ? null : o.name,
      !!o.retired, o.score || 0, o.source === undefined ? null : { $t: SIG.FOOD_SOURCE, ordinal: o.source },
      o.stemName === undefined ? null : o.stemName, o.translationId || 0,
      o.type === undefined ? null : { $t: SIG.FOOD_TYPE, ordinal: o.type }, o.userPopularity || 0,
    ] };
  }
  /** DayInfo: [z, o Day, o list, o list, z, s] */
  function dayInfo(o) {
    o = o || {};
    return { $t: SIG.DAYINFO, f: [!!o.a, o.day || day(4, 3, 2026), o.list1 || [], o.list2 || [], !!o.e, o.f === undefined ? null : o.f] };
  }

  const DEFAULT_GROUPS = ['Uncategorized', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Group 6', 'Group 7', 'Group 8'];
  /** groups: [{id:0..7, name, enabled}] -> the user preference Map: DG0<id+1> = name, DG0<id+1>ON = 'true'/'false',
   *  DG_ON = 'true' (the diary reads `DG0<f>ON` for f = 2..8 as group f-1, see research/serving-fields-resolved.md, Lrd). */
  function prefsMap(groups) {
    groups = groups || [0, 1, 2, 3, 4].map(function (id) { return { id: id, name: DEFAULT_GROUPS[id], enabled: true }; });
    const m = new Map();
    m.set('DG_ON', 'true');
    groups.forEach(function (g) {
      m.set('DG0' + (g.id + 1), g.name);
      m.set('DG0' + (g.id + 1) + 'ON', g.enabled === false ? 'false' : 'true');
    });
    m.set('time.24hr', 'false');
    return m;
  }
  const USER_KINDS = 'losoooooossosoooszsizlloooozooozlsosooooso';   // 42 fields, see gwt-registry.js
  /** User (42 fields): {userId, session, email, groups | prefs (Map)}; userId at index 19, session key at 33,
   *  UserPreferences (a HashMap subclass) at 28. */
  function user(o) {
    o = o || {};
    const f = USER_KINDS.split('').map(function (k) { return k === 'z' ? false : (k === 'o' || k === 's') ? null : k === 'l' ? 'A' : 0; });
    f[2] = o.email || 'user@example.com';
    f[3] = day(1, 1, 2020);
    f[5] = [];
    f[19] = o.userId === undefined ? 1234567 : o.userId;
    f[28] = { $t: SIG.USER_PREFS, m: o.prefs instanceof Map ? o.prefs : prefsMap(o.groups) };
    f[33] = o.session === undefined ? 'SESSIONKEY' : o.session;
    return { $t: SIG.USER, f: f };
  }

  // ---- response fabrication (needs CMA.gwt) ----------------------------------------------------------
  function enc(value, opts) {
    if (!CMA.gwt) throw new Error('fixtures: CMA.gwt is not loaded');
    return CMA.gwt.encodeResponse(value, opts);
  }
  function authenticateResponse(o) { return enc(user(o)); }
  function dayInfoResponse(o) { return enc(dayInfo(o)); }
  function foodResponse(o) { return enc(food(o)); }
  function updateDiaryOkResponse(servings) { return enc(servings.map(addEntryChangeResult)); }
  function updateDiaryErrorResponse(message, entry) { return enc([errorEntryChangeResult(message, entry)]); }
  function notLoggedInEx(message) { return CMA.gwt.encodeException(SIG.NOT_LOGGED_IN, message || 'authentication failed'); }

  CMA.fixtures = {
    SIG, moduleBase, SERVICE, DEFAULT_GROUPS, USER_KINDS,
    nonce: 'NONCE', policy: 'POLICY', userId: 1234567,
    updateDiaryResponse, editDiaryEntriesResponse, notLoggedInResponse, voidResponse, v7LiteralResponse,
    updateDiaryTemplate, getDayInfoTemplate, getFoodTemplate, removeServingTemplate, authenticateTemplate,
    day, time, serving, addEntryChange, addEntryChangeResult, errorEntryChangeResult,
    measure, foodMeasures, translation, nutrient, nutrientMap, food, searchHit, dayInfo, prefsMap, user,
    authenticateResponse, dayInfoResponse, foodResponse, updateDiaryOkResponse, updateDiaryErrorResponse, notLoggedInEx,
  };
})();
