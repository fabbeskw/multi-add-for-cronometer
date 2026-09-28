/* Multi-Add for Cronometer — unit conversions + measure matching (SPEC §5.3).
 *
 * CMA.units.pickMeasure(measures, unit, qty, opts) → {measure, quantity, grams, note}
 *                                                  | {error, measure?}
 *
 * `measures` is what CMA.rpc.measuresOf(food) returns: [{id, name, grams, type, foodId, hidden, ...}]
 * where `type` is the Measure$Type name ('Weight'|'Volume'|'Atomic'|'Recipe'),
 * its ordinal (0..3) or the raw enum value {$t, ordinal} — all accepted
 * (serving-fields-resolved.md §2 row 8: enum Measure$Type ordinals 0 Weight,
 * 1 Volume, 2 Atomic, 3 Recipe).
 *
 * opts: { hitMeasureId, defaultMeasureId } — SPEC §5.3 default-measure rule when NO unit was typed:
 *   hit.measureId if present in the list, else the food's own default (FoodMeasures.f[0]: the dialog's `TCe`
 *   compares `b.p.a==f.e` against every Measure.measureId — `m.isDefault` from rpc.measuresOf, or
 *   opts.defaultMeasureId), else the plain 1 g 'g' measure (`mpj`), else first. When that default is a bare
 *   gram/ml unit the pick does NOT silently log grams (a bare '1 protein bar' meant one bar): see pickDefault.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';

  /** grams per unit (SPEC §5.3: oz 28.3495, lb 453.592; kg/mg for callers bypassing the parser). */
  const MASS_G = { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };
  /** millilitres per unit (SPEC §5.3: cup 240, tbsp 15, tsp 5, fl oz 29.57). */
  const VOLUME_ML = { ml: 1, l: 1000, cup: 240, tbsp: 15, tsp: 5, 'fl oz': 29.57 };
  const TYPE_NAMES = ['Weight', 'Volume', 'Atomic', 'Recipe'];

  /** Minimal fallback synonyms if parse.js is not loaded (it normally is). */
  const FALLBACK_SYN = {
    g: 'g', gram: 'g', grams: 'g', kg: 'kg', mg: 'mg', oz: 'oz', ounce: 'oz', ounces: 'oz',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', ml: 'ml', milliliter: 'ml', millilitre: 'ml',
    l: 'l', liter: 'l', litre: 'l', 'fl oz': 'fl oz', cup: 'cup', cups: 'cup', tbsp: 'tbsp',
    tablespoon: 'tbsp', tsp: 'tsp', teaspoon: 'tsp'
  };

  function normalizeUnit(u) {
    if (u == null) return null;
    const P = window.CMA.parse;
    if (P && typeof P.normalizeUnit === 'function') return P.normalizeUnit(u);
    const t = String(u).toLowerCase().trim().replace(/\s+/g, ' ');
    return FALLBACK_SYN[t] || null;
  }

  function aliasesOf(canon) {
    const P = window.CMA.parse;
    const list = P && P.ALIASES && P.ALIASES[canon] ? P.ALIASES[canon].slice() : [];
    if (list.indexOf(canon) < 0) list.unshift(canon);
    return list;
  }

  /** 'Weight' | 'Volume' | 'Atomic' | 'Recipe' | null for any representation of Measure$Type. */
  function typeName(m) {
    if (!m) return null;
    const t = m.type;
    if (t == null) return null;
    if (typeof t === 'string') {
      const s = t.trim();
      const byName = TYPE_NAMES.find(n => n.toLowerCase() === s.toLowerCase());
      if (byName) return byName;
      if (/^\d+$/.test(s)) return TYPE_NAMES[parseInt(s, 10)] || null;
      return s;
    }
    if (typeof t === 'number') return TYPE_NAMES[t] || null;
    if (typeof t === 'object' && typeof t.ordinal === 'number') return TYPE_NAMES[t.ordinal] || null;
    if (typeof t === 'object' && typeof t.name === 'string') return t.name;
    return null;
  }

  function isRecipeLike(m) {
    // serving-fields-resolved.md §2 row 8 (`Rqj`): amount = quantity × 1 when the
    // measure type is Recipe, or the measure is the 'full recipe' Weight measure with k==0.
    const t = typeName(m);
    if (t === 'Recipe') return true;
    const name = String(m.name || '').trim().toLowerCase();
    return t === 'Weight' && name === 'full recipe' && (!m.grams || m.grams === 0);
  }

  /**
   * grams the Serving must carry for `quantity` of measure `m` (SPEC §5.3 last bullet). The product is NOT
   * rounded: the dialog sends `Nqj(a){return a.a*a.c}` = quantity × Measure.k as a raw double
   * (serving-fields-resolved.md §2 row 8), so 1 × 28.349523125 g goes on the wire as 28.349523125.
   * Rounding, if any, is for display only (panel.formatGrams).
   */
  function gramsFor(m, quantity) {
    if (!m) return 0;
    const q = Number(quantity) || 0;
    if (isRecipeLike(m)) return q;
    return q * (Number(m.grams) || 0);
  }

  function round(x, dp) {
    const p = Math.pow(10, dp);
    return Math.round(x * p) / p;
  }

  /** Lower-case, punctuation-light version of a measure name. */
  function normName(name) {
    return String(name == null ? '' : name).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Words of a measure name, punctuation stripped. */
  function nameWords(name) {
    return normName(name).replace(/[^a-z0-9 .-]/g, ' ').split(/\s+/).filter(Boolean);
  }

  /**
   * The unit a measure name denotes, if its leading part is a known unit:
   * 'cup, chopped' → 'cup'; 'fl oz' → 'fl oz'; 'g' → 'g'; 'large' → 'large'; 'breast' → null.
   */
  function nameUnit(name) {
    const head = normName(name).split(/[,(\[]/)[0].trim().replace(/\s*\d.*$/, '');
    if (!head) return null;
    const words = head.split(' ');
    if (words.length >= 2) {
      const two = normalizeUnit(words[0] + ' ' + words[1]);
      if (two) return two;
    }
    return normalizeUnit(head) || normalizeUnit(words[0]);
  }

  /**
   * The plain gram measure the dialog falls back to (`mpj`: `a.a==1&&a.k==1&&_ko(a.g,'g')` — amount 1, 1 g per
   * unit, named exactly 'g'), or null.
   */
  function gramMeasure(measures) {
    return measures.find(m => m && normName(m.name) === 'g' && Number(m.grams) === 1 && (m.amount == null || Number(m.amount) === 1)) || null;
  }
  /**
   * The measure the Add Food dialog would start on (SPEC §5.3). Bundle evidence (build 0A1C16E148676A90CBB128E4829A562F):
   *  - a fresh add from a search hit passes NO measure into the dialog (`Fke`: `yte(dialog, foodId, translationId,
   *    null, null, ...)` unless an existing serving is being edited), so the hit's measureId is our own convention:
   *    it is the measure the search row described to the user ('1 breast - 172g'), kept when it is in the list;
   *  - `TCe(a,b,c)` then walks the measure list (sorted by `Measure.compareTo` = `epj`: grams per unit descending)
   *    and takes the one whose id equals FoodMeasures.f[0] (`h=f.e!=0; d=b.p.a==f.e; (h&&d||e)&&(j=f)`) — so f[0]
   *    IS the food's default measure id (rpc.measuresOf exposes it as `isDefault`; opts.defaultMeasureId is the
   *    same thing for callers without that flag);
   *  - `Q0i(serving, food)` (`Serving.getMeasure`) is only used for existing servings: measure by the serving's
   *    measureId, else the first `isGrams` measure (`mpj`: amount 1, 1 g per unit, named 'g').
   * Order here: hit → food default (f[0]) → plain 'g' → first in wire order. We deliberately do not copy TCe's
   * heaviest-first tie-break (a food without f[0] would start on 'lb'); a gram default is handled by pickDefault.
   * Hidden measures (Measure.f[3], 'Hidden' in the measure editor) are never a default: the dialog's `VCe` drops
   * them before `TCe` runs, so every id here resolves only over the visible ones. A food whose measures are ALL
   * hidden falls back to the whole list (first in wire order) rather than planning no measure at all.
   */
  function defaultMeasure(measures, opts) {
    const o = opts || {};
    const shown = visibleMeasures(measures);
    const visible = shown.length ? shown : (measures || []).filter(Boolean);
    const byId = id => (id == null ? null : visible.find(m => Number(m.id) === Number(id)) || null);
    const flagged = visible.find(m => m.isDefault === true && Number(m.id) > 0) || null;
    return byId(o.hitMeasureId) || byId(o.defaultMeasureId) || flagged || gramMeasure(visible) || visible[0] || null;
  }

  /** The measures the Add Food dialog lists (`VCe` drops Measure.f[3] === true, exposed as `hidden`). */
  function visibleMeasures(measures) {
    return (measures || []).filter(m => m && m.hidden !== true);
  }

  /**
   * True for a measure that is only a bare gram / millilitre unit: its name denotes 'g' or 'ml' ('g', 'gram',
   * 'grams', 'ml', 'milliliter', 'g (1 g)'). Such a measure is what the dialog shows as '100 g' by default (`MCe`:
   * amount 100 for `b.a==1&&b.k==1&&_ko(b.g,'g')` or a 1 ml Volume 'ml', else 1); it is never what a human means by
   * a bare count ('1 protein bar' is one bar).
   */
  function isGramOrMlUnit(m) {
    if (!m) return false;
    const u = nameUnit(m.name);
    return u === 'g' || u === 'ml';
  }

  /** Words that mark a count-like measure name, preferred as the suggestion for a bare quantity. */
  const COUNT_WORDS = ['serving', 'piece', 'bar', 'medium', 'large', 'small', 'each', 'unit', 'slice', 'scoop', 'whole', 'item', 'portion', 'package', 'container', 'bottle', 'can'];

  /**
   * The measure to offer when no unit was typed and the default is a bare gram/ml unit: the food's own default
   * (f[0]) when it is not gram/ml, else a measure whose name carries a count word, else the first Atomic/Recipe
   * measure, else the first non-gram/ml measure; null when every measure is gram/ml-like. Hidden measures are
   * never suggested (the dialog does not list them).
   */
  function suggestMeasure(measures) {
    const alts = visibleMeasures(measures).filter(m => !isGramOrMlUnit(m));
    if (!alts.length) return null;
    const flagged = alts.find(m => m.isDefault === true);
    if (flagged) return flagged;
    const byWord = alts.find(m => {
      const words = nameWords(m.name);
      return COUNT_WORDS.some(w => words.indexOf(w) >= 0 || words.indexOf(w + 's') >= 0);
    });
    if (byWord) return byWord;
    const countType = alts.find(m => typeName(m) === 'Atomic' || typeName(m) === 'Recipe');
    return countType || alts[0];
  }

  /**
   * No unit typed (SPEC §5.3): `def` is defaultMeasure(); q is the typed quantity or null.
   *  a) the default is a real measure (the hit's, the food's f[0], or the first one) that is not a bare gram/ml
   *     unit → q or 1 of it (this also covers a food whose only measure is such a measure);
   *  b) the default is a bare gram/ml unit and other measures exist → {error, measure: suggestion, suggested}:
   *     needs-choice, so the panel's 'Use <measure>' button offers the suggestion instead of logging N grams;
   *  c) every measure is gram/ml-like (incl. a lone 'g') → 100 g like the dialog (`MCe`) when no quantity was
   *     typed, else q grams (q ml for an ml default), each with a note that says so. The amount is converted
   *     through the measure's own grams (ml: Measure.f, else its amount) per unit, so a 'g'-named measure that is not 1 g per unit
   *     (measuresFromHit('100 g - 100g') gives name 'g', grams 100) still sends what the note says.
   * The live case this exists for (diagnostics 2026-09-28): a bare '1 <food>' whose hit measure was unusable was
   * planned as 1 × the 1 g 'g' measure and ONE GRAM was logged.
   */
  function pickDefault(measures, def, q) {
    if (!def) return { error: 'food has no measures' };
    if (!isGramOrMlUnit(def)) return result(def, q == null ? 1 : q, null);
    const unitWord = nameUnit(def.name) === 'ml' ? 'millilitres' : 'grams';
    const suggested = suggestMeasure(measures);
    if (suggested) {
      return {
        error: 'no unit given and this food\'s default unit is ' + unitWord + ' \u2014 pick a unit',
        measure: suggested,
        suggested: suggested
      };
    }
    // Only gram/ml-like measures: the number is grams (ml), unambiguous but worth saying. It is divided by the
    // measure's grams (ml) per unit so the Serving carries exactly that many grams (ml). An ml measure's ml per
    // unit is Measure.f (`ml`) when known, else its shown amount (a measure named 'ml' is amount × 1 ml) — never
    // its grams, which carry the density (1 ml of milk is 1.03 g: 100 ml must stay 100 ml, i.e. 103 g).
    const isMl = nameUnit(def.name) === 'ml';
    const per = isMl
      ? (Number(def.ml) > 0 ? Number(def.ml) : (Number(def.amount) > 0 ? Number(def.amount) : 1))
      : (Number(def.grams) > 0 ? Number(def.grams) : 1);
    const amount = q == null ? 100 : q;
    const note = q == null ? 'no unit given; using 100 ' + (isMl ? 'ml' : 'g') + ' like the app'
      : 'no unit given; ' + formatQuantity(q) + ' taken as ' + unitWord;
    return result(def, amount / per, note);
  }

  function result(measure, quantity, note) {
    const q = round(Number(quantity), 6);
    return { measure, quantity: q, grams: gramsFor(measure, q), note: note || null };
  }

  /** Find a measure whose name denotes exactly `unit` (or whose name starts with one of its aliases). */
  function findByUnitName(measures, unit) {
    const aliases = aliasesOf(unit);
    // exact name equality first
    let m = measures.find(x => aliases.indexOf(normName(x.name)) >= 0);
    if (m) return m;
    // then name whose leading part normalises to the unit ('cup, chopped', 'cup (240ml)')
    m = measures.find(x => nameUnit(x.name) === unit);
    if (m) return m;
    // then starts with an alias followed by a non-letter
    m = measures.find(x => {
      const n = normName(x.name);
      return aliases.some(a => n.startsWith(a) && !/[a-z]/.test(n.charAt(a.length)));
    });
    return m || null;
  }

  /**
   * CMA.units.pickMeasure(measures, unit, qty, opts) — SPEC §5.3.
   */
  function pickMeasure(measures, unit, qty, opts) {
    if (!Array.isArray(measures) || measures.length === 0) return { error: 'food has no measures' };
    const q = (qty == null || qty === '') ? null : Number(qty);
    if (q != null && (!isFinite(q) || q <= 0)) return { error: 'invalid quantity' };
    const def = defaultMeasure(measures, opts);
    const u = unit == null || unit === '' ? null : normalizeUnit(unit);
    if (unit != null && unit !== '' && !u) {
      // Not a known unit: treat like an "other unit word" so a custom word can still match a measure.
      return pickOther(measures, String(unit).toLowerCase().trim(), q == null ? 1 : q);
    }

    // No unit → the dialog's default measure, unless that is a bare gram/ml unit (pickDefault, SPEC §5.3).
    if (!u) return pickDefault(measures, def, q);

    if (MASS_G[u] != null) return pickMass(measures, u, q == null ? 1 : q, def);
    if (VOLUME_ML[u] != null) return pickVolume(measures, u, q == null ? 1 : q);
    return pickOther(measures, u, q == null ? 1 : q);
  }

  /** Mass units: never fail (SPEC §5.3). */
  function pickMass(measures, u, q, def) {
    const totalG = q * MASS_G[u];
    // Same-named measure ('oz' for oz, 'lb' for lb, 'g' for g): identical grams, nicer display.
    const same = findByUnitName(measures, u);
    if (same && Number(same.grams) > 0 && typeName(same) !== 'Recipe') {
      return result(same, u === 'g' ? totalG / Number(same.grams) : q, null);
    }
    // Prefer a measure named exactly g / gram.
    const g = findByUnitName(measures, 'g');
    if (g && Number(g.grams) > 0) return result(g, totalG / Number(g.grams), u === 'g' ? null : 'shown as g');
    // Else any Weight measure with grams > 0.
    const w = measures.find(m => typeName(m) === 'Weight' && Number(m.grams) > 0);
    if (w) return result(w, totalG / Number(w.grams), 'shown as ' + w.name);
    // Never fail: fall back to the default measure.
    if (def && Number(def.grams) > 0 && !isRecipeLike(def)) {
      return result(def, totalG / Number(def.grams), 'shown as ' + def.name);
    }
    const any = measures.find(m => Number(m.grams) > 0 && !isRecipeLike(m));
    if (any) return result(any, totalG / Number(any.grams), 'shown as ' + any.name);
    // Only recipe-like measures are left. For those the Serving's amount is a COUNT of the measure (the client
    // sends quantity × 1: `Rqj`, serving-fields-resolved.md §2 row 8), so the gram total must never be sent as
    // the quantity (150 g would become 150 recipes). A Recipe measure that knows its grams is converted to a count.
    const rec = measures.find(m => typeName(m) === 'Recipe' && Number(m.grams) > 0);
    if (rec) {
      const q = totalG / Number(rec.grams);
      return result(rec, q, 'converted to ' + formatQuantity(q) + ' × ' + rec.name);
    }
    return { error: 'no weight measure for this recipe', unit: u, measure: def || measures[0] };
  }

  /** Volume units: convert through ml when possible, else ask the user (SPEC §5.3). */
  function pickVolume(measures, u, q) {
    const totalMl = q * VOLUME_ML[u];
    const same = findByUnitName(measures, u);
    if (same) return result(same, q, null);
    // Any measure whose name denotes a known volume unit (any type) → convert via ml.
    const conv = measures.find(m => VOLUME_ML[nameUnit(m.name)] != null);
    if (conv) {
      const mu = nameUnit(conv.name);
      return result(conv, totalMl / VOLUME_ML[mu], 'converted to ' + conv.name);
    }
    // A Volume-type measure whose name is not a known unit: we cannot convert safely.
    const vol = measures.find(m => typeName(m) === 'Volume');
    return { error: 'unit not available', unit: u, measure: vol || null };
  }

  /** Other unit words: equals / startsWith / contains (in that order) over normalised names. */
  function pickOther(measures, u, q) {
    const aliases = aliasesOf(u).map(normName);
    const equal = measures.find(m => aliases.indexOf(normName(m.name)) >= 0);
    if (equal) return result(equal, q, null);
    const starts = measures.find(m => {
      const n = normName(m.name);
      return aliases.some(a => n.startsWith(a));
    });
    if (starts) return result(starts, q, null);
    const containsWord = measures.find(m => {
      const words = nameWords(m.name);
      return aliases.some(a => words.indexOf(a) >= 0 || words.indexOf(a + 's') >= 0);
    });
    if (containsWord) return result(containsWord, q, null);
    const contains = measures.find(m => {
      const n = normName(m.name);
      return aliases.some(a => a.length > 1 && n.indexOf(a) >= 0);
    });
    if (contains) return result(contains, q, null);
    return { error: "no '" + u + "' measure for this food", unit: u };
  }

  /** Convert a quantity of a mass unit to grams (null for non-mass units). */
  function toGrams(qty, unit) {
    const u = normalizeUnit(unit);
    if (!u || MASS_G[u] == null) return null;
    return round(Number(qty) * MASS_G[u], 6);
  }
  /** Convert a quantity of a volume unit to ml (null for non-volume units). */
  function toMl(qty, unit) {
    const u = normalizeUnit(unit);
    if (!u || VOLUME_ML[u] == null) return null;
    return round(Number(qty) * VOLUME_ML[u], 6);
  }

  /**
   * convertQuantity(qty, unit, measure) → {quantity, note} | null: the amount of `measure` that equals `qty`
   * of the typed `unit`, when that is a safe conversion; null when it is not (the caller then asks the user
   * or resets the count). Used by the panel when a needs-choice row ('150 g my smoothie' on a food whose only
   * measure is a Recipe count) gets a measure picked by hand: a typed gram/ml quantity must never be reused
   * as a COUNT of a recipe measure (SPEC §5.3, `Rqj`).
   *  - same unit as the measure's name ('g' → 'g', 'cup' → 'cup, chopped'): qty unchanged;
   *  - mass unit → measure with grams > 0 that is not recipe-like: grams / measure.grams;
   *  - volume unit → measure with an ml value, or whose name is a known volume unit: ml / measure ml;
   *  - a word unit ('large', 'slice') that the measure name contains: qty unchanged; otherwise null.
   */
  function convertQuantity(qty, unit, measure) {
    const q = Number(qty);
    if (!measure || !isFinite(q) || q <= 0) return null;
    const raw = unit == null ? '' : String(unit).trim();
    if (!raw) return null;
    const u = normalizeUnit(raw);
    const mu = nameUnit(measure.name);
    const recipe = isRecipeLike(measure);
    if (u && mu === u) return { quantity: round(q, 6), note: null };
    if (u && MASS_G[u] != null) {
      if (recipe || !(Number(measure.grams) > 0)) return null;
      const quantity = round(q * MASS_G[u] / Number(measure.grams), 6);
      return { quantity, note: formatQuantity(q) + ' ' + u + ' = ' + formatQuantity(quantity) + ' × ' + measure.name };
    }
    if (u && VOLUME_ML[u] != null) {
      const ml = Number(measure.ml) > 0 ? Number(measure.ml) : (mu && VOLUME_ML[mu] != null ? VOLUME_ML[mu] : null);
      if (!ml) return null;
      const quantity = round(q * VOLUME_ML[u] / ml, 6);
      return { quantity, note: formatQuantity(q) + ' ' + u + ' = ' + formatQuantity(quantity) + ' × ' + measure.name };
    }
    // word units: 'large' for 'large', 'slice' for 'slice (1 oz)' / 'thin slice'
    const words = nameWords(measure.name);
    const aliases = aliasesOf(u || raw.toLowerCase()).map(normName);
    if (aliases.some(a => words.indexOf(a) >= 0 || words.indexOf(a + 's') >= 0 || normName(measure.name).startsWith(a))) return { quantity: round(q, 6), note: null };
    return null;
  }

  /**
   * Re-pick with an explicit measure chosen by the user in the panel (unit dropdown).
   * qty is the quantity in that measure. Returns the same shape as pickMeasure.
   */
  function withMeasure(measures, measureId, qty) {
    const m = (measures || []).find(x => Number(x.id) === Number(measureId));
    if (!m) return { error: 'measure not found' };
    const q = qty == null ? 1 : Number(qty);
    if (!isFinite(q) || q <= 0) return { error: 'invalid quantity' };
    return result(m, q, null);
  }

  /** Format a quantity for display / the UI dialog (up to 3 decimals, no trailing zeros). */
  function formatQuantity(q) {
    const n = Number(q);
    if (!isFinite(n)) return '';
    return String(round(n, 3)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  window.CMA.units = {
    pickMeasure,
    withMeasure,
    convertQuantity,
    defaultMeasure,
    gramMeasure,
    visibleMeasures,
    isGramOrMlUnit,
    suggestMeasure,
    gramsFor,
    isRecipeLike,
    typeName,
    nameUnit,
    normalizeUnit,
    toGrams,
    toMl,
    formatQuantity,
    MASS_G,
    VOLUME_ML,
    TYPE_NAMES
  };
})();
