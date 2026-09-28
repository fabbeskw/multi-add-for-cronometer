/* Multi-Add for Cronometer — input line parser (SPEC §5).
 *
 * CMA.parse.lines(text) → [{raw, line, name, qty, unit, group, groupFallback?, part?, error?}]
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
    ['dozen', ['dozen', 'doz']]
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
   * Tries the two-word candidate first (`fl oz`, `extra large`) then one word.
   */
  function unitAt(rest) {
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

  /** `1,5` → `1.5` when it is the only comma, or when every other comma is a list separator (`rice, 1,5 cups`). */
  function decimalComma(line) {
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
   * current one is not a real group (a `# note` mistaken for a header).
   */
  function lines(text) {
    const out = [];
    if (text == null) return out;
    const src = String(text).replace(/\r\n?/g, '\n').split('\n');
    const headers = [];                                   // header groups seen so far, most recent first
    const pushHeader = (g) => { if (g && headers[0] !== g) headers.unshift(g); };
    for (let i = 0; i < src.length; i++) {
      const raw = src[i];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed[0] === '#') {
        const g = GROUP_LINE_RE.exec(trimmed);
        const gname = g ? g[2].replace(/^@/, '').replace(/:$/, '').trim() : '';
        if (gname && (g[1].length >= 2 || looksLikeGroupName(gname))) pushHeader(gname);   // `## Dinner`, `# Lunch`
        continue;                                          // bare `#`, `# a comment` → ignored
      }
      if (trimmed.startsWith('//')) continue;              // comment convenience

      let body = trimmed;
      let group = headers[0] || null;
      let fallback = headers.slice(1, 4);
      let t = TAG_LEAD_RE.exec(body);
      if (t) { group = t[1]; body = body.slice(t[0].length); fallback = headers.slice(0, 3); }
      t = TAG_TRAIL_RE.exec(body);
      if (t) { group = t[1]; body = body.slice(0, t.index); fallback = headers.slice(0, 3); }

      // `Breakfast:` — a quantity-less line ending in ':' is a group header, not a food.
      if (/:$/.test(body) && !t) {
        const h = parseFoodLine(body.slice(0, -1));
        if (h.qty == null && h.unit == null && h.name) { pushHeader(h.name); continue; }
      }

      const segments = splitSegments(body);
      for (let k = 0; k < segments.length; k++) {
        const item = { raw, line: i + 1, name: '', qty: null, unit: null, group: group || null };
        if (fallback.length) item.groupFallback = fallback.slice();
        if (segments.length > 1) item.part = k;
        try {
          const p = parseFoodLine(segments[k]);
          item.name = p.name;
          item.qty = p.qty;
          item.unit = p.unit;
          if (item.qty != null && (!isFinite(item.qty) || item.qty <= 0)) {
            item.error = 'invalid quantity';
          }
          if (!item.name) item.error = item.error || 'no food name';
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
