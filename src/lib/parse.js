/* Multi-Add for Cronometer — input line parser (SPEC §5).
 *
 * CMA.parse.lines(text) → [{raw, line, name, qty, unit, group, groupFallback?, part?, customOnly?, error?}]
 *
 * Plain ES2020 classic script; attaches to window.CMA.parse. No DOM, no network.
 * Also owns the unit synonym table (CMA.parse.normalizeUnit) because "is this
 * token a unit?" is a parsing decision; conversions live in units.js (§5.3).
 *
 * Grammar summary (SPEC §5, review round 1):
 *  - `## Dinner` always switches the group; `# Dinner` / `# Group 6` / `# Second breakfast` do too when the
 *    text looks like a group name (one word, or two words with a number / capitalised head); any other
 *    `# …` line and every `// …` line is a comment. `Breakfast:` (a quantity-less line ending in ':') is a
 *    header as well.
 *  - A number is a quantity only at a boundary: `2% milk`, `12%` and a digit glued to a non-unit word
 *    (`7up`, `d3`) stay in the name.
 *  - Multipliers: `2 x 100g yoghurt`, `yoghurt 2 x 100g`, `vitamin c 500mg x2` → 200 g / 200 g / 1000 mg.
 *  - Two foods on one line separated by `,` / `;` and each carrying a quantity+unit (`oats 40 g, milk 200 ml`)
 *    are split into two items with the same `line` and `raw` (and `part` 0, 1, …).
 *  - Search-scope flags (0.3.2): `/custom` (alias `/c`) searches only the user's own custom foods / recipes / meals,
 *    `/all` everything; a whole whitespace-delimited token at the start or end of a line, in any order with an
 *    `@group` tag (`cheese /custom @lunch`). On a header line (`## Dinner /custom`, `Dinner /custom:`, `/custom ## Dinner`)
 *    or a line that is only a flag (`/custom`, `## /all`) it applies to the lines below until the next header; a
 *    line's own flag wins, and so does a split line segment's (`oats 40 g /custom, milk 200 ml`). A flag left inside
 *    a name (`cheese /custom 30g`) fails the line. → item.customOnly true / false (absent without a flag).
 *  - Energy amounts (0.3.2): `300cal almonds`, `almonds 300 kcal`, `1250kJ almonds`, `2 x 150cal bar` are ordinary
 *    quantity+unit pairs whose unit is 'kcal' (cal, Cal, kcal, calorie(s), kilocalorie(s)) or 'kj' (kJ, kilojoule(s));
 *    item.qty stays the typed number. `100 calorie pack almonds` therefore means 100 kcal of "pack almonds". Also
 *    `300 kilo calories`, `300 k cal`, `300-cal`; an energy number's `1,250` is 1250 (a thousands comma, not the
 *    decimal comma `1,5` is elsewhere), and `almonds 1 250 kJ` (a plain space inside the number) is an error.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Unit synonyms (SPEC §5 "Known units (normalise, singular)"). Canonical key →
  // every spelling we accept (lower-case). Multi-word spellings are listed too;
  // the tokenizer tries a two-word candidate before a one-word one.
  // kg/mg/l are recognised here and CONVERTED by the parser (kg→g ×1000,
  // mg→g ×0.001, l→ml ×1000) so that `0.5 kg potatoes` → 500 g exactly as the
  // spec's example table requires; units.js still accepts kg/mg/l for callers
  // that bypass the parser.
  // ---------------------------------------------------------------------------
  const UNIT_TABLE = [
    ['g', ['g', 'gram', 'grams', 'gr', 'grm', 'gm', 'gms', 'gramm']],
    ['kg', ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms']],
    ['mg', ['mg', 'milligram', 'milligrams']],
    ['oz', ['oz', 'ounce', 'ounces']],
    ['lb', ['lb', 'lbs', 'pound', 'pounds']],
    ['ml', ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'mls']],
    ['l', ['l', 'liter', 'liters', 'litre', 'litres', 'ltr']],
    ['fl oz', ['fl oz', 'floz', 'fl. oz', 'fl.oz', 'fluid ounce', 'fluid ounces', 'fl ounce', 'fl ounces']],
    ['cup', ['cup', 'cups']],
    ['tbsp', ['tbsp', 'tbsps', 'tablespoon', 'tablespoons', 'tbs', 'tbl', 'tblsp', 'tb']],
    ['tsp', ['tsp', 'tsps', 'teaspoon', 'teaspoons', 'ts']],
    ['slice', ['slice', 'slices', 'sl']],
    ['piece', ['piece', 'pieces', 'pc', 'pcs', 'pce']],
    ['serving', ['serving', 'servings', 'srv', 'serv', 'svg', 'portion', 'portions']],
    ['large', ['large', 'lg', 'lrg']],
    ['medium', ['medium', 'med', 'md']],
    ['small', ['small', 'sm', 'sml']],
    ['xl', ['xl', 'extra large', 'extra-large', 'x-large', 'x large', 'xlarge', 'jumbo']],
    ['xs', ['xs', 'extra small', 'extra-small', 'x-small', 'x small', 'xsmall']],
    ['scoop', ['scoop', 'scoops']],
    ['can', ['can', 'cans', 'tin', 'tins']],
    ['bottle', ['bottle', 'bottles', 'btl']],
    ['packet', ['packet', 'packets', 'pack', 'packs', 'pkt', 'pkts', 'sachet', 'sachets', 'pouch', 'pouches']],
    ['bar', ['bar', 'bars']],
    ['each', ['each', 'ea']],
    ['unit', ['unit', 'units']],
    ['clove', ['clove', 'cloves']],
    // A few extra container/portion words that Cronometer measures commonly use.
    ['tablet', ['tablet', 'tablets', 'tab', 'tabs']],
    ['capsule', ['capsule', 'capsules', 'cap', 'caps', 'softgel', 'softgels']],
    ['glass', ['glass', 'glasses']],
    ['bowl', ['bowl', 'bowls']],
    ['handful', ['handful', 'handfuls']],
    ['stick', ['stick', 'sticks']],
    ['pinch', ['pinch', 'pinches']],
    ['dash', ['dash', 'dashes']],
    ['drop', ['drop', 'drops']],
    ['fillet', ['fillet', 'fillets', 'filet', 'filets']],
    ['patty', ['patty', 'patties']],
    ['head', ['head', 'heads']],
    ['stalk', ['stalk', 'stalks']],
    ['leaf', ['leaf', 'leaves']],
    ['sprig', ['sprig', 'sprigs']],
    ['wedge', ['wedge', 'wedges']],
    ['square', ['square', 'squares']],
    ['cube', ['cube', 'cubes']],
    ['jar', ['jar', 'jars']],
    ['tub', ['tub', 'tubs']],
    ['carton', ['carton', 'cartons']],
    ['container', ['container', 'containers']],
    ['bag', ['bag', 'bags']],
    ['box', ['box', 'boxes']],
    ['strip', ['strip', 'strips']],
    ['sheet', ['sheet', 'sheets']],
    ['link', ['link', 'links']],
    ['stem', ['stem', 'stems']],
    ['ear', ['ear', 'ears']],
    ['pod', ['pod', 'pods']],
    ['bunch', ['bunch', 'bunches']],
    ['dozen', ['dozen', 'doz']],
    // Energy amounts (0.3.2, SPEC §5 / Appendix N): `300cal almonds` = enough almonds for 300 kcal. `cal` / `Cal` mean
    // kcal, as on food labels. They are not measures: plan.js hands them to units.pickEnergy, which converts the target
    // into the food's default measure. kJ keeps its own unit so the preview can show what was typed (÷ 4.1868 later).
    // The two-word spellings win over `kilo` → kg (`300 kilo calories almonds` is 300 kcal, not 300 kg of "calories").
    ['kcal', ['kcal', 'kcals', 'cal', 'cals', 'calorie', 'calories', 'kilocalorie', 'kilocalories', 'kilo calorie',
      'kilo calories', 'kilo-calorie', 'kilo-calories', 'kilo cal', 'kilo cals', 'k cal', 'k cals', 'k-cal', 'k-cals']],
    ['kj', ['kj', 'kilojoule', 'kilojoules', 'kilo joule', 'kilo joules', 'kilo-joule', 'kilo-joules']]
  ];

  /** synonym → canonical unit (lower-case keys, whitespace collapsed). */
  const SYNONYMS = Object.create(null);
  /** canonical → [synonyms] (used by units.js for measure-name matching). */
  const ALIASES = Object.create(null);
  for (const [canon, names] of UNIT_TABLE) {
    ALIASES[canon] = names.slice();
    for (const n of names) SYNONYMS[n] = canon;
  }

  /** Conversions the parser applies itself (SPEC §5 example `0.5 kg potatoes` → 500 g). */
  const PARSER_CONVERSIONS = { kg: ['g', 1000], mg: ['g', 0.001], l: ['ml', 1000] };

  /** The energy units (0.3.2): the only ones a hyphen may join to the number (`300-cal almonds`). */
  const ENERGY_UNITS = { kcal: true, kj: true };
  // Every energy spelling as a whole word, longest first; a space inside one matches any run of spaces.
  const ENERGY_WORD_SRC = '(?:' + ALIASES.kcal.concat(ALIASES.kj).sort((a, b) => b.length - a.length)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|') + ')(?![A-Za-z])';
  // Digit groups of an energy number (`1,250 kJ`, `2,000 kcal`, `8 700 kJ` with a no-break or thin space): a
  // thousands separator, not the decimal comma it would be anywhere else (`1,250 kJ` is never 1.25 kJ). Never `0,250`.
  const ENERGY_THOUSANDS_RE = new RegExp('(?<![\\p{L}\\d.,])([1-9]\\d{0,2})((?:,\\d{3})+|(?:[\\u00A0\\u2009\\u202F]\\d{3})+)'
    + '(?=(?:\\.\\d+)?\\s*-?' + ENERGY_WORD_SRC + ')', 'giu');
  // The same with a plain space (`almonds 1 250 kJ`, `2 150cal bars`) is refused: 1250 kJ, or 2 × 150 kcal?
  const ENERGY_SPACED_RE = new RegExp('(?<![\\p{L}\\d.,])([1-9]\\d{0,2})((?: \\d{3})+)(?=(?:\\.\\d+)?\\s*-?(' + ENERGY_WORD_SRC + '))', 'iu');

  /**
   * Normalise a unit token. Returns the canonical unit ('g', 'cup', 'fl oz', ...)
   * or null when the token is not a known unit. Case-insensitive; a trailing '.'
   * is ignored (`oz.`, `tbsp.`); internal whitespace is collapsed.
   */
  function normalizeUnit(token) {
    if (token == null) return null;
    let t = String(token).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!t) return null;
    if (SYNONYMS[t]) return SYNONYMS[t];
    t = t.replace(/\.$/, '').replace(/\.\s*/g, '. ').replace(/\s+/g, ' ').trim();
    if (SYNONYMS[t]) return SYNONYMS[t];
    const noDot = t.replace(/\./g, '');
    if (SYNONYMS[noDot]) return SYNONYMS[noDot];
    return null;
  }

  // ---------------------------------------------------------------------------
  // Number grammar (SPEC §5): integer, decimal (1.5, .5, and 1,5 when the line has
  // no other comma), fraction 1/2, mixed 1 1/2, unicode vulgar fractions (also
  // attached: 1½), x2 / 2x / ×2.
  // ---------------------------------------------------------------------------
  const VULGAR = {
    '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
    '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
  };
  const V_CLASS = '[' + Object.keys(VULGAR).join('') + ']';
  // Alternation order matters: longest/most specific first.
  const NUM_SRC = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+ ?' + V_CLASS + '|\\d+(?:\\.\\d+)?|\\.\\d+|' + V_CLASS + ')';
  // A number ends at a boundary: never followed by another digit or a percent sign
  // (`2% milk`, `12%`: fat percentages are names, not quantities).
  const NUM_END = '(?![\\d%])';
  // Word candidate for a unit: letters (hyphen allowed inside: x-large), optional trailing '.'.
  const WORD_SRC = '[A-Za-z][A-Za-z-]*\\.?';
  // Multiplier marks: x, X, ×.
  const X_CLASS = '[xX×]';
  // Characters that may separate a name from a trailing quantity (SPEC: `,` `:` `-` `x` `×`).
  const SEP_CLASS = '[\\s,:;\\-\\u2013\\u2014(]';

  // Leading quantity: optional x before, the number, optional x after (`2x eggs`; not `2xl`).
  const LEAD_RE = new RegExp('^\\s*(' + X_CLASS + '\\s*)?(' + NUM_SRC + ')' + NUM_END + '(\\s*' + X_CLASS + '(?![A-Za-z]))?(.*)$', 'u');
  // A quantity anywhere else: must start at a boundary (start, or after a separator), optionally an x.
  const ANY_RE = new RegExp('(?:^|(?<=' + SEP_CLASS + '))(' + X_CLASS + '\\s*)?(' + NUM_SRC + ')' + NUM_END + '(\\s*' + X_CLASS + '(?![A-Za-z]))?', 'gu');
  const UNIT_AFTER_RE = new RegExp('^\\s*(' + WORD_SRC + ')(?:\\s+(' + WORD_SRC + '))?', 'u');
  // Second `<number><unit>` after a leading `N x` (`2 x 100g yoghurt`).
  const SECOND_RE = new RegExp('^\\s*(' + NUM_SRC + ')' + NUM_END + '(.*)$', 'u');
  // `N x` right before a quantity+unit (`yoghurt 2 x 100g`) …
  const MULT_BEFORE_RE = new RegExp('(?<=^|' + SEP_CLASS + ')(' + NUM_SRC + ')' + NUM_END + '\\s*' + X_CLASS + '\\s*$', 'u');
  // … or `x N` / `N x` right after it (`vitamin c 500mg x2`).
  const MULT_AFTER_RE = new RegExp('^\\s*(?:' + X_CLASS + '\\s*(' + NUM_SRC + ')|(' + NUM_SRC + ')\\s*' + X_CLASS + ')' + NUM_END + '\\s*$', 'u');

  /** Convert a matched number string to a JS number (NaN when malformed). */
  function toNumber(s) {
    s = s.trim();
    if (s.indexOf('/') >= 0) {
      const parts = s.split(/\s+/);
      let whole = 0;
      const frac = parts[parts.length - 1];
      if (parts.length === 2) whole = parseInt(parts[0], 10);
      const [a, b] = frac.split('/');
      const den = parseInt(b, 10);
      if (!den) return NaN;
      return whole + parseInt(a, 10) / den;
    }
    const last = s[s.length - 1];
    if (VULGAR[last] != null) {
      const head = s.slice(0, -1).trim();
      return (head ? parseInt(head, 10) : 0) + VULGAR[last];
    }
    return parseFloat(s);
  }

  /**
   * Given the text right after a number, find a known unit at its start.
   * Returns {unit, consumed} (consumed = number of chars of `rest` used) or null.
   * Tries the two-word candidate first (`fl oz`, `extra large`) then one word. A hyphen glued to the number and
   * the word is taken before an energy unit only (`300-cal almonds`, `100-calorie pack`); `2-3 cups` is unchanged.
   */
  function unitAt(rest) {
    if (/^-(?=[A-Za-z])/.test(rest)) {
      const e = unitAt(rest.slice(1));
      return e && ENERGY_UNITS[e.unit] ? { unit: e.unit, consumed: e.consumed + 1 } : null;
    }
    const m = UNIT_AFTER_RE.exec(rest);
    if (!m) return null;
    if (m[2]) {
      const two = normalizeUnit(m[1].replace(/\.$/, '') + ' ' + m[2]);
      if (two) return { unit: two, consumed: m[0].length };
    }
    const one = normalizeUnit(m[1]);
    if (one) {
      // consumed = leading whitespace + the first word only
      const lead = rest.length - rest.replace(/^\s+/, '').length;
      return { unit: one, consumed: lead + m[1].length };
    }
    return null;
  }

  /** Trim separators/whitespace at both ends of a name and tidy doubled separators. */
  function cleanName(s) {
    return s
      .replace(/\s+/g, ' ')
      .replace(/\s*([,;:\-–—])\s*(?:[,;:\-–—]\s*)+/g, '$1 ')
      .replace(/^[\s,;:\-–—()]+/, '')
      .replace(/[\s,;:\-–—(]+$/, '')
      .trim();
  }

  /** Apply the parser-level conversions (kg→g etc.). Returns [qty, unit]. */
  function convertUnit(qty, unit) {
    const c = PARSER_CONVERSIONS[unit];
    if (!c) return [qty, unit];
    if (qty == null) return [null, c[0]];
    return [Math.round(qty * c[1] * 1e6) / 1e6, c[0]];
  }

  /**
   * `1,5` → `1.5` when it is the only comma, or when every other comma is a list separator (`rice, 1,5 cups`).
   * An energy number's thousands separators go first (`1,250 kJ` → `1250 kJ`; `300,5 kcal` stays a decimal comma).
   */
  function decimalComma(line) {
    line = line.replace(ENERGY_THOUSANDS_RE, (all, head, groups) => head + groups.replace(/\D/g, ''));
    const dc = /(\d),(\d)/.exec(line);
    if (!dc) return line;
    const rest = line.slice(0, dc.index) + line.slice(dc.index + dc[0].length);
    if (!/\d,\d/.test(rest) && /^[^,]*(?:,\s[^,]*)*$/.test(rest)) {
      return line.slice(0, dc.index) + dc[1] + '.' + dc[2] + line.slice(dc.index + dc[0].length);
    }
    return line;
  }

  /**
   * Every quantity candidate of a line, left to right:
   *   {kind:'unit', start, end, num, unit}   number + known unit (`200g`, `1 1/2 cups`)
   *   {kind:'bare'|'mult', start, end, num}   number at the very end of the line (`banana 1`, `eggs x2`)
   * A digit glued to a non-unit word (`7up`, `omega3`) is never a candidate; a bare number in the middle
   * of a line (`omega 3 fatty acids`) is not one either.
   */
  function scanCandidates(line) {
    const out = [];
    ANY_RE.lastIndex = 0;
    let m;
    while ((m = ANY_RE.exec(line)) !== null) {
      if (m[0].length === 0) { ANY_RE.lastIndex++; continue; }
      const start = m.index, end = start + m[0].length;
      const rest = line.slice(end);
      const u = unitAt(rest);
      if (u) out.push({ kind: 'unit', start, end: end + u.consumed, num: m[2], unit: u.unit });
      else if (/^[A-Za-z]/.test(rest)) continue;                 // attached non-unit word: part of the name
      else if (/^\s*$/.test(rest)) out.push({ kind: (m[1] || m[3]) ? 'mult' : 'bare', start, end, num: m[2], unit: null });
    }
    return out;
  }

  /**
   * Parse one food segment (already stripped of group tags). Returns
   * {name, qty, unit} where qty/unit may be null. The name always goes through cleanName().
   */
  function parseFoodLine(text) {
    const line = decimalComma(String(text == null ? '' : text).trim());
    let qty = null, unit = null, name = null;

    // 1. Leading quantity: `200g chicken`, `2 large eggs`, `½ cup oats`, `x2 eggs`, `2x eggs`, `2 x 100g yoghurt`.
    const lead = LEAD_RE.exec(line);
    if (lead) {
      let rest = lead[4];
      const attached = /^[A-Za-z]/.test(rest);          // `200g` (unit) or `7up` (not a quantity)
      let u = unitAt(rest);
      let n = toNumber(lead[2]);
      if (!u && lead[3]) {
        // `2 x 100g yoghurt`: the second <number><unit> is the real quantity, N multiplies it.
        const second = SECOND_RE.exec(rest);
        const u2 = second ? unitAt(second[2]) : null;
        if (second && u2) { n = n * toNumber(second[1]); u = u2; rest = second[2]; }
      }
      if (u || !attached) {
        qty = n;
        if (u) { unit = u.unit; rest = rest.slice(u.consumed); }
        // Unknown token after the number → not a unit, stays in the name (SPEC §5).
        name = cleanName(rest);
      }
    }
    if (name === null) {
      // 2./3. Trailing (`chicken breast 200 g`, `eggs x2`, `banana 1`) or mid-line with a KNOWN unit
      // (`chicken 200g cooked`). A bare number is accepted only at the very end of the line so
      // `omega 3 fatty acids` keeps its name intact.
      const cands = scanCandidates(line);
      const units = cands.filter(c => c.kind === 'unit');
      let best = null;
      if (units.length) {
        best = units[units.length - 1];                         // the LAST unit candidate wins (`omega 3 500mg`)
        let n = toNumber(best.num);
        let start = best.start, end = best.end;
        const mb = MULT_BEFORE_RE.exec(line.slice(0, start));   // `yoghurt 2 x 100g`
        if (mb) { n = n * toNumber(mb[1]); start = mb.index; }
        const ma = MULT_AFTER_RE.exec(line.slice(end));         // `vitamin c 500mg x2`
        if (ma) { n = n * toNumber(ma[1] || ma[2]); end = line.length; }
        qty = n; unit = best.unit;
        name = cleanName(line.slice(0, start) + ' ' + line.slice(end));
      } else if (cands.length) {
        best = cands[cands.length - 1];
        qty = toNumber(best.num);
        name = cleanName(line.slice(0, best.start) + ' ' + line.slice(best.end));
      } else {
        name = cleanName(line);
      }
    }

    if (qty != null) {
      [qty, unit] = convertUnit(qty, unit);
    } else if (unit) {
      [qty, unit] = convertUnit(null, unit);
    }
    return { name, qty, unit };
  }

  /**
   * Split `oats 40 g, milk 200 ml` into ['oats 40 g', 'milk 200 ml']: a `,`/`;` is a split point when the
   * text before it (since the previous split) and the text after it both carry a quantity+unit. Lines with
   * a single quantity (`rice, 1,5 cups`, `1 1/2 cups rice, cooked`) are returned whole.
   */
  function splitSegments(text) {
    const line = decimalComma(String(text == null ? '' : text).trim());
    const units = scanCandidates(line).filter(c => c.kind === 'unit');
    if (units.length < 2) return [line];
    const out = [];
    let from = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch !== ',' && ch !== ';') continue;
      const before = units.some(c => c.start >= from && c.end <= i);
      const after = units.some(c => c.start > i);
      if (before && after) { out.push(line.slice(from, i)); from = i + 1; }
    }
    out.push(line.slice(from));
    return out.map(s => s.trim()).filter(Boolean);
  }

  const TAG_LEAD_RE = /^@([\p{L}\p{N}_-]+)\s*/u;
  const TAG_TRAIL_RE = /\s*@([\p{L}\p{N}_-]+)\s*$/u;
  const GROUP_LINE_RE = /^(#+)\s*(.*?)\s*$/u;
  // Search-scope flags: a whole token only, so `1/2`, `salt/pepper`, `w/o`, `cheese/custom` and `//` never match.
  // A trailing flag may sit right before a header's final ':' (`Dinner /custom:`); the ':' stays on the text.
  const FLAG_LEAD_RE = /^\/(custom|c|all)(?:\s+|$)/i;
  const FLAG_TRAIL_RE = /(?:^|\s)\/(custom|c|all)(:?)$/i;
  // A flag token left inside a food name (`cheese /custom 30g`): the line is rejected instead of searching it.
  const FLAG_INNER_RE = /(?:^|\s)(\/(?:custom|c|all))(?=\s|$)/i;

  /**
   * Strip the search-scope flags (and, with `tags`, one `@group` tag per end) from both ends of `text`, in any
   * order: `cheese /custom @lunch`, `cheese @lunch /custom`, `/custom @lunch cheese`. A trailing tag wins over a
   * leading one (as before the flags existed); of several flags the last one in reading order wins.
   * Returns {text, customOnly (true | false | undefined), leadTag, trailTag (null when absent)}.
   */
  function stripMarks(text, tags) {
    let body = String(text == null ? '' : text).trim();
    let leadTag = null, trailTag = null, leadFlag, trailFlag, m;
    for (;;) {
      if (tags && leadTag === null && (m = TAG_LEAD_RE.exec(body))) { leadTag = m[1]; body = body.slice(m[0].length); continue; }
      if ((m = FLAG_LEAD_RE.exec(body))) { leadFlag = m[1].toLowerCase() !== 'all'; body = body.slice(m[0].length); continue; }
      break;
    }
    for (;;) {
      if (tags && trailTag === null && (m = TAG_TRAIL_RE.exec(body))) { trailTag = m[1]; body = body.slice(0, m.index).trimEnd(); continue; }
      if ((m = FLAG_TRAIL_RE.exec(body))) {
        if (trailFlag === undefined) trailFlag = m[1].toLowerCase() !== 'all';    // the rightmost flag is stripped first
        body = body.slice(0, m.index).trimEnd() + m[2];
        continue;
      }
      break;
    }
    return { text: body, customOnly: trailFlag !== undefined ? trailFlag : leadFlag, leadTag, trailTag };
  }

  /**
   * A single-`#` line switches the group only when its text looks like a group name: one word
   * (`# Lunch`, `# snacks`) or two words with a number or a capitalised head (`# Group 6`,
   * `# Second breakfast`); `# a comment` and `# leftovers from yesterday` are comments.
   */
  function looksLikeGroupName(s) {
    if (!s || /[.,;!?()"“”]/.test(s)) return false;
    const words = s.split(/\s+/);
    if (words.length === 1) return true;
    if (words.length === 2) return /^\d+$/.test(words[1]) || /^\p{Lu}/u.test(words[0]);
    return false;
  }

  /**
   * CMA.parse.lines(text) — SPEC §5.
   * Blank lines and comments are ignored. `## Dinner`, `# Dinner` (group-name-like) and `Dinner:` switch
   * the current group for the following lines (no item emitted). `@lunch` at the start or end of a line
   * sets that line's group only. `line` is the 1-based line number. `groupFallback` lists the earlier
   * header groups (most recent first) so plan.js can fall back to the last *resolvable* header when the
   * current one is not a real group (a `# note` mistaken for a header). `/custom` (`/c`) / `/all` set
   * `customOnly` true / false on every item of the line (a split line's segment may carry its own); on a header
   * line, or on a line that is only a flag (`/custom`, `## /all`), they apply until the next header.
   */
  function lines(text) {
    const out = [];
    if (text == null) return out;
    const src = String(text).replace(/\r\n?/g, '\n').split('\n');
    const headers = [];                                   // header groups seen so far, most recent first
    let headerFlag;                                       // the current header's scope flag (undefined = none)
    const pushHeader = (g, flag) => { if (g && headers[0] !== g) headers.unshift(g); headerFlag = flag; };
    for (let i = 0; i < src.length; i++) {
      const raw = src[i];
      let trimmed = raw.trim();
      if (!trimmed) continue;
      // `/custom ## Dinner`, `/c // note`: a flag in front of a header or a comment belongs to that line.
      let leadFlag;
      if (/^\/(?!\/)/.test(trimmed)) {
        const pre = stripMarks(trimmed, false);
        if (/^(?:#|\/\/)/.test(pre.text)) { trimmed = pre.text; leadFlag = pre.customOnly; }
      }
      if (trimmed[0] === '#') {
        const g = GROUP_LINE_RE.exec(trimmed);
        const hs = stripMarks(g ? g[2] : '', false);      // `## Dinner /custom`, `## Dinner /custom:`: not part of the name
        const flag = hs.customOnly !== undefined ? hs.customOnly : leadFlag;
        const gname = g ? hs.text.replace(/^@/, '').replace(/:$/, '').trim() : '';
        if (gname && (g[1].length >= 2 || looksLikeGroupName(gname))) pushHeader(gname, flag);   // `## Dinner`, `# Lunch`
        else if (!gname && flag !== undefined) headerFlag = flag;   // `## /custom`, `## /all`: the scope changes, the group stays
        continue;                                          // bare `#`, `# a comment` → ignored
      }
      if (trimmed.startsWith('//')) continue;              // comment convenience

      // Tags and flags come off before the header check, splitSegments and parseFoodLine, so `banana 1 /custom`
      // keeps its quantity and no name ever contains a flag.
      const marks = stripMarks(trimmed, true);
      const body = marks.text;
      let group = headers[0] || null;
      let fallback = headers.slice(1, 4);
      const tag = marks.trailTag !== null ? marks.trailTag : marks.leadTag;
      if (tag !== null) { group = tag; fallback = headers.slice(0, 3); }

      // A line that is only a flag (`/custom`, `/all`) sets the scope of the lines below it, like `## /custom`.
      if (marks.customOnly !== undefined && tag === null && /^:?$/.test(body)) { headerFlag = marks.customOnly; continue; }

      // `Breakfast:` — a quantity-less line ending in ':' is a group header, not a food.
      if (/:$/.test(body) && marks.trailTag === null) {
        const h = parseFoodLine(body.slice(0, -1));
        if (h.qty == null && h.unit == null && h.name) { pushHeader(h.name, marks.customOnly); continue; }
      }

      const lineFlag = marks.customOnly !== undefined ? marks.customOnly : headerFlag;
      const segments = splitSegments(body);
      for (let k = 0; k < segments.length; k++) {
        const item = { raw, line: i + 1, name: '', qty: null, unit: null, group: group || null };
        if (fallback.length) item.groupFallback = fallback.slice();
        if (segments.length > 1) item.part = k;
        // `mozzarella 30g /custom, banana 1`: a segment's own flag wins for that segment
        const seg = stripMarks(segments[k], false);
        const customOnly = seg.customOnly !== undefined ? seg.customOnly : lineFlag;
        if (customOnly !== undefined) item.customOnly = customOnly;
        try {
          const p = parseFoodLine(seg.text);
          item.name = p.name;
          item.qty = p.qty;
          item.unit = p.unit;
          if (item.qty != null && (!isFinite(item.qty) || item.qty <= 0)) {
            item.error = 'invalid quantity';
          }
          if (!item.name) item.error = item.error || 'no food name';
          // `cheese /custom 30g`: a flag inside the name would be searched as text, with the other scope
          const inner = FLAG_INNER_RE.exec(item.name || '');
          if (inner) item.error = item.error || "move '" + inner[1] + "' to the start or end of the line";
          // `almonds 1 250 kJ`, `2 150cal bars`: a plain space inside a calorie number is refused, never guessed
          const sp = ENERGY_SPACED_RE.exec(seg.text);
          if (sp) {
            const word = sp[3].replace(/\s+/g, ' ');
            item.error = item.error || '"' + sp[1] + sp[2] + ' ' + word + '" is ambiguous: write ' + sp[1] + sp[2].replace(/ /g, '')
              + ' ' + word + ' (no space inside the number), or ' + sp[1] + ' x ' + sp[2].trim() + ' ' + word + ' for a count';
          }
        } catch (e) {
          item.error = 'parse error: ' + (e && e.message ? e.message : String(e));
        }
        out.push(item);
      }
    }
    return out;
  }

  window.CMA.parse = {
    lines,
    parseFoodLine,
    splitSegments,
    stripMarks,
    looksLikeGroupName,
    normalizeUnit,
    toNumber,
    cleanName,
    ALIASES,
    SYNONYMS,
    VULGAR,
    PARSER_CONVERSIONS
  };
})();
