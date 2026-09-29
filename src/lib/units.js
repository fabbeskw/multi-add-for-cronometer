/* Multi-Add for Cronometer — unit conversions + measure matching (SPEC §5.3).
 *
 * CMA.units.pickMeasure(measures, unit, qty, opts) → {measure, quantity, grams, note}
 *                                                  | {error, measure?}
 * CMA.units.pickEnergy(measures, energyValue, targetKcal, opts) → the same shape for a calorie amount (`300cal
 *                                                  almonds`, 0.3.2): see pickEnergy below.
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
    tablespoon: 'tbsp', tsp: 'tsp', teaspoon: 'tsp', kcal: 'kcal', cal: 'kcal', kj: 'kj'
  };
  /** kJ per kcal (SPEC §5.3, Appendix N): Cronometer stores energy only as kcal (nutrient 208) and shows kJ = kcal × 4.1868. */
  const KJ_PER_KCAL = 4.1868;
  /** A calorie amount that comes out above this many grams is still ready, with a check-the-number note (`3000cal oil`). */
  const ENERGY_SANITY_G = 1000;
  /** … and so is a target below this many kcal (`1.250 kJ` meant as 1250, `2 cal` meant as 2 servings). */
  const ENERGY_SANITY_MIN_KCAL = 5;
  /**
   * The Add Food dialog's amount box takes 3 decimals and 6 characters (engine-ui.formatQuantity): a calorie amount is
   * put on a measure only when its quantity survives that within this share (0.0014 × a 5,000 kcal 'full recipe' would
   * be typed as 0.001, and 0.0004 as 0).
   */
  const ENERGY_TYPABLE_SHARE = 0.05;

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
    // A calorie amount is never a count of a measure whose name happens to contain 'cal': plan.js sends it to pickEnergy.
    if (u === 'kcal' || u === 'kj') return { error: "a calorie amount needs the food's calorie data" };
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

  // ---------------------------------------------------------------------------
  // Calorie amounts (0.3.2, SPEC §5.3 / Appendix N): `300cal almonds` = enough almonds for 300 kcal.
  // ---------------------------------------------------------------------------
  /** True for the parser's energy units: 'kcal' (cal, Cal, calories, …) and 'kj' (kJ, kilojoules). */
  function isEnergyUnit(u) {
    if (u == null || u === '') return false;
    const t = String(u).trim().toLowerCase();
    const n = t === 'kcal' || t === 'kj' ? t : normalizeUnit(t);
    return n === 'kcal' || n === 'kj';
  }
  /** An energy amount in kcal (kJ ÷ 4.1868), or null when it is not a positive finite amount of an energy unit. */
  function energyToKcal(qty, unit) {
    const q = qty == null || qty === '' ? NaN : Number(qty);
    if (!isFinite(q) || q <= 0 || !isEnergyUnit(unit)) return null;
    return String(unit).trim().toLowerCase() === 'kj' || normalizeUnit(unit) === 'kj' ? q / KJ_PER_KCAL : q;
  }

  /**
   * kcal in ONE of measure `m` for a food whose nutrient 208 amount is `value` — the Add Food dialog's `Rrj` (build
   * FB395E8B; names are build-specific): a Recipe-type measure → value / k (a serving-based recipe's value is the whole
   * recipe, k its servings; 0 when k is 0); a weightless Weight measure (k 0, the 'full recipe') → value; anything else
   * value × k / 100 (value per 100 g). k = Measure.k = measuresOf().grams; Measure.a (the label's amount) plays no part.
   * Returns 0, never NaN, when the combination yields nothing usable.
   */
  function kcalPerUnit(m, value) {
    const v = Number(value);
    if (!m || value == null || !isFinite(v)) return 0;
    const k = Number(m.grams) || 0;
    const t = typeName(m);
    const per = t === 'Recipe' ? (k === 0 ? 0 : v / k) : (t === 'Weight' && k === 0 ? v : v * k / 100);
    return isFinite(per) && per > 0 ? per : 0;
  }
  /** A measure a calorie amount can be expressed in: energy per unit > 0, and a weight (or a recipe count) to send. */
  function carriesEnergy(m, value) {
    return !!m && kcalPerUnit(m, value) > 0 && (isRecipeLike(m) || Number(m.grams) > 0);
  }
  /** A quantity the dialog's amount box can take (ENERGY_TYPABLE_SHARE): > 0 at 3 decimals, below 1,000,000, close enough. */
  function typable(q) {
    const t = round(q, 3);
    return isFinite(q) && t > 0 && round(q, 0) < 1e6 && Math.abs(t - q) <= q * ENERGY_TYPABLE_SHARE;
  }
  /** 1.8277 → '1.83', 51.81 → '51.8', 0.0042 → '0.004': the preview's energy note, never the wire value. */
  function shortNumber(x) {
    const n = Number(x);
    if (!isFinite(n)) return '';
    let r = round(n, Math.abs(n) >= 10 ? 1 : 2);
    if (r === 0 && n !== 0) r = round(n, 3);
    return String(r);
  }

  /**
   * CMA.units.pickEnergy(measures, energyValue, targetKcal, opts) → {measure, quantity, grams, note, kcal, kcalPerUnit,
   * warn} | {error}. energyValue = CMA.rpc.energyKcalOf(food) (per the Food's basis). The quantity is what Cronometer's
   * own diary Calories-cell edit computes (`j2i`: quantity = target / perUnit, nothing when perUnit is 0), so the diary
   * shows the target for the entry; grams = gramsFor(measure, quantity) like any pick (`bsj`: × 1 for a recipe count).
   * opts:
   *  - hitMeasureId / defaultMeasureId: the measure is the SAME default a unit-less line starts on (defaultMeasure); a
   *    bare gram default is fine here (the amount is exact whichever measure carries it, so no needs-choice). When that
   *    measure carries no energy per unit (a weightless Volume / Atomic / Recipe measure, a weightless Weight measure
   *    that is not the 'full recipe') the plain 'g', then any Weight measure with grams, else {error};
   *  - measureId: the measure the user picked in the panel, kept with the same target; {error, refused: measure} when
   *    it carries no energy (the row asks for another unit);
   *  - meal: {error} — the Add dialog hides the measure selector for a meal and adds it whole, so it cannot be scaled;
   *  - kj: the typed kJ number, for the note ('1250 kJ (298.6 kcal) → …').
   * A measure is used only when the quantity is typable (the dialog's 3 decimals, ENERGY_TYPABLE_SHARE): the default
   * path moves on to the next candidate (`2cal <recipe>` whose 'full recipe' has 5,000 kcal → its g), and when none
   * is typable, or the picked measure is not, the row asks for another unit ({error, refused}).
   * The note reads '300 kcal → 1.83 oz (51.8 g)'; above 1000 g or under 5 kcal it adds a check-the-number warning
   * (`warn: true`, the row stays ready). Every division is guarded: a non-finite result is an error, never a quantity.
   */
  function pickEnergy(measures, energyValue, targetKcal, opts) {
    const o = opts || {};
    if (o.meal) return { error: 'calorie amounts are not supported for meals (Cronometer adds a meal whole)' };
    if (!Array.isArray(measures) || measures.length === 0) return { error: 'food has no measures' };
    const kcal = targetKcal == null || targetKcal === '' ? NaN : Number(targetKcal);
    if (!isFinite(kcal) || kcal <= 0) return { error: 'invalid quantity' };
    const value = energyValue == null ? NaN : Number(energyValue);
    if (!isFinite(value) || value <= 0) return { error: 'no calorie data for this food' };
    const typed = o.kj != null && isFinite(Number(o.kj)) ? shortNumber(o.kj) + ' kJ (' + shortNumber(kcal) + ' kcal)' : shortNumber(kcal) + ' kcal';
    // 0.0004 × a 'full recipe' would reach the dialog as 0, 2,000,000 g as a cut-off number: ask for another unit
    const untypable = (x) => ({
      error: typed + ' is too ' + (kcal / kcalPerUnit(x, value) < 1 ? 'small' : 'large') + " an amount of '" + x.name + "' to add — pick another unit",
      refused: x
    });
    let m;
    if (o.measureId != null) {
      m = measures.find(x => x && Number(x.id) === Number(o.measureId)) || null;
      if (!m) return { error: 'measure not found' };
      if (!carriesEnergy(m, value)) return { error: "'" + m.name + "' has no weight to put calories on — pick another unit", refused: m };
      if (!typable(kcal / kcalPerUnit(m, value))) return untypable(m);
    } else {
      const shown = visibleMeasures(measures);
      const pool = shown.length ? shown : measures.filter(Boolean);
      const byName = findByUnitName(pool, 'g');
      const candidates = [
        defaultMeasure(measures, o),
        gramMeasure(pool),
        byName && typeName(byName) === 'Weight' ? byName : null,
        pool.find(x => typeName(x) === 'Weight' && Number(x.grams) > 0)
      ];
      const carrying = candidates.filter(x => carriesEnergy(x, value));
      if (!carrying.length) return { error: 'no measure with a weight to put calories on' };
      m = carrying.find(x => typable(kcal / kcalPerUnit(x, value))) || null;
      if (!m) return untypable(carrying[0]);
    }
    const per = kcalPerUnit(m, value);
    const q = kcal / per;
    if (!isFinite(q) || q <= 0) return { error: 'no calorie data for this food' };
    const r = result(m, q, null);
    if (!(r.quantity > 0) || !isFinite(r.grams)) return { error: 'the calorie amount is too small for ' + m.name };
    const recipe = isRecipeLike(m);
    const label = (Number(m.amount) > 0 && Number(m.amount) !== 1 ? formatQuantity(m.amount) + ' ' : '') + m.name;
    // '51.8 g' on the plain gram measure, '1.83 oz (51.8 g)', '0.5 × serving' for a recipe count (its grams are the count)
    let amount = shortNumber(r.quantity) + (recipe || label !== m.name ? ' × ' : ' ') + label;
    if (label === 'g' && Number(m.grams) === 1) amount = shortNumber(r.grams) + ' g';
    else if (!recipe) amount += ' (' + shortNumber(r.grams) + ' g)';
    r.note = typed + ' → ' + amount;
    r.kcal = kcal;
    r.kcalPerUnit = per;
    const heavy = !recipe && r.grams > ENERGY_SANITY_G;
    const tiny = kcal < ENERGY_SANITY_MIN_KCAL;
    r.warn = heavy || tiny;
    if (heavy) r.note += ' — over 1 kg: check the food and the number';
    if (tiny) r.note += ' — under ' + ENERGY_SANITY_MIN_KCAL + ' kcal: check the number';
    return r;
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
    if (u === 'kcal' || u === 'kj') return null;     // a calorie target is not an amount of any measure (pickEnergy)
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
    pickEnergy,
    kcalPerUnit,
    isEnergyUnit,
    energyToKcal,
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
    TYPE_NAMES,
    KJ_PER_KCAL,
    ENERGY_SANITY_G,
    ENERGY_SANITY_MIN_KCAL
  };
})();
