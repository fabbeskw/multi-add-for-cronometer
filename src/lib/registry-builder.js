/* registry-builder.js - build the GWT type registry at RUNTIME from the live Cronometer bundle.
 *
 * A line-for-line port of tools/gen_registry.py (the reference generator, SPEC 3.2 / 3.5): same first-wins
 * constant map, serializer-table regex, reader/writer method derivation (nothing obfuscated is hard-coded),
 * statement splitting, superclass inlining, classification order and warnings. For the same bundle text it
 * returns an object deep-equal to what the Python writes into src/lib/gwt-registry.js (asserted by
 * tests/registry-builder.html), so a registry rebuilt on cronometer.com has the shape every module expects.
 *
 *   build(allJsText, {permutation, generatedAt, bundle, onProgress, onWarning, yieldEvery, quiet})
 *       -> Promise<registry>  window.CMA.registry-shaped (sorted keys, exactly like the generated file).
 *       Async: yields every `yieldEvery` types (default 300; 0 = never, the body then runs synchronously)
 *       through scheduler.yield() / a MessageChannel hop - never a setTimeout, which Chrome clamps and
 *       throttles in hidden tabs. Warnings (the Python's stderr) go to onWarning(message), else console.warn;
 *       they are never part of the registry. The permutation is read from the bundle's `$strongName`
 *       (opts.permutation is the fallback, cross-checked); generatedAt defaults to now (whole seconds).
 *   validate(registry[, {maxUnknown, truncated, fragments}]) -> {ok, problems, checked}
 *       The bar tests/gwt.html holds the generated registry to (SPEC 3.3 layouts resolved by BASE name like
 *       CMA.gwt.sig(), 42-field User with idx 19 int / 33 string, reader/writer kinds, service methods,
 *       hashes), stats.unknown <= MAX_UNKNOWN (0 in the shipped build), and no truncated download. A
 *       registry that fails must never be activated.
 *   fetchBundle(moduleBase, permutation, {fetchImpl, maxFragments=200, timeoutMs=60000, retries=3,
 *       retryDelayMs=1500, onProgress}) -> Promise<{text, fragments, bytes (= chars), permutation, truncated}>
 *       GET <moduleBase><perm>.cache.js (must be 200 and non-empty) then deferredjs/<perm>/N.cache.js for
 *       N = 1.. until a 403/404/410 ends the list (tools/fetch_bundle.py's rule); any other failure (5xx,
 *       other status, transport error, per-file timeout) is retried with a growing pause and then THROWN,
 *       never taken for the end of the list. Parts are joined with fetch_bundle.py's separator rule.
 *       credentials 'same-origin'; on an https page the module base must be the page's own origin (SPEC 0).
 *
 * Performance: every whole-bundle regex is anchored (the constants pass by a lookbehind at the start of each
 * identifier run - unanchored, `NAME='...'` was quadratic in the longest run, e.g. a 100 KB inlined base64
 * asset: 4.4 s), one pass indexes every `function NAME(`, class blocks are found with indexOf, derived regexes
 * are cached. ~60 ms for the 5.7 MB bundle in headless Chrome. Keep this header short: tools/check_manifest.py
 * wants the namespace guard within the first 4000 chars.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  // ------------------------------------------------------------------------------------------------
  // Constants that are stable across Cronometer deploys (Java class names, not obfuscated names).
  // Identical to tools/gen_registry.py.
  // ------------------------------------------------------------------------------------------------
  const BOX_TYPES = {
    'java.lang.Boolean': 'z', 'java.lang.Byte': 'b', 'java.lang.Character': 'c', 'java.lang.Double': 'd',
    'java.lang.Float': 'f', 'java.lang.Integer': 'i', 'java.lang.Long': 'l', 'java.lang.Short': 'h',
    'java.lang.String': 's',
  };
  const SET_TYPES = new Set(['java.util.TreeSet']);                       // SPEC: {k:'set', pre:['o']}
  const ARRAYS_TYPES = new Set(['java.util.Arrays$ArrayList']);           // SPEC: {k:'arrays'}
  const SINGLETON_TYPES = new Set(['java.util.Collections$SingletonList']);
  const EMPTY_TYPES = { 'java.util.Collections$EmptyList': 'list', 'java.util.Collections$EmptySet': 'set',
    'java.util.Collections$EmptyMap': 'map' };
  const DATE_TYPES = new Set(['java.util.Date', 'java.sql.Date', 'java.sql.Time', 'java.sql.Timestamp']);
  // java.util collections whose wire shape must be recognised (anything else, e.g. java.util exceptions,
  // is an ordinary class)
  const KNOWN_COLLECTIONS = new Set(['java.util.ArrayList', 'java.util.LinkedList', 'java.util.Vector', 'java.util.Stack',
    'java.util.HashSet', 'java.util.LinkedHashSet', 'java.util.TreeSet', 'java.util.Arrays$ArrayList',
    'java.util.HashMap', 'java.util.IdentityHashMap', 'java.util.EnumMap', 'java.util.LinkedHashMap',
    'java.util.TreeMap', 'java.util.WeakHashMap', 'java.util.Hashtable']);
  // element kind of primitive arrays by signature letter (JVM descriptors)
  const PRIM_ARRAY_ELEM = { I: 'i', D: 'd', Z: 'z', J: 'l', B: 'b', S: 'h', C: 'c', F: 'f' };
  // GWT obfuscated identifier alphabet; the FIRST character cycles fastest (Xs, Ys, Zs, $s, _s, at, bt ...)
  const GWT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';
  const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
  const RAW_READER_KINDS = { 1: ['i'], 2: ['b', 'i'], 3: ['b', 'i', 'h'], 4: ['b', 'c', 'i', 'h'] };

  // ------------------------------------------------------------------------------------------------
  // Small helpers (Python stdlib equivalents)
  // ------------------------------------------------------------------------------------------------
  /** re.escape for the identifiers we interpolate into patterns. */
  function reEscape(s) { return String(s).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }

  /** Byte-wise string order (Python's sorted() on ASCII keys; JS default sort compares code units too). */
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  /** A read structure item: kinds are 1-char strings, a loop is {loop:[kinds per iteration]} (Python: ('*', [...])). */
  function loop(kinds) { return { loop: kinds }; }
  function isLoop(x) { return x !== null && typeof x === 'object' && Array.isArray(x.loop); }
  /** Loop-free kinds list, or null when the structure contains a loop (Python flat()). */
  function flat(items) {
    if (items == null) return null;
    for (let i = 0; i < items.length; i++) if (typeof items[i] !== 'string') return null;
    return items.slice();
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function nonEmpty(list) { return list != null && list.length > 0; }   // Python truthiness of a list

  /** Python repr() of the read structures / strings / None, so 'why' texts match the generator's. */
  function pyRepr(v) {
    if (v == null) return 'None';
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (isLoop(v)) return "('*', " + pyRepr(v.loop) + ')';
    if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
    return String(v);
  }
  /** repr() of a {kind: count} dict (Python: {'i': 3, 'd': 1}, insertion order). */
  function pyReprCounter(map) {
    const parts = [];
    map.forEach((n, k) => parts.push(pyRepr(k) + ': ' + n));
    return '{' + parts.join(', ') + '}';
  }

  /** Minimal unescape for the single-quoted JS literals GWT emits for type signatures (Python js_unescape). */
  function jsUnescape(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[^\n])/g, function (m, e) {
      if ((e[0] === 'u' || e[0] === 'x') && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
      switch (e) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case '0': return '\0';
        default: return e;
      }
    });
  }

  /** Sort key of gen_registry.gwt_order_key: (length, alphabet index of each char, last char first). */
  function gwtCompare(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = a.length - 1; i >= 0; i--) {
      let ia = GWT_ALPHABET.indexOf(a[i]), ib = GWT_ALPHABET.indexOf(b[i]);
      if (ia < 0) ia = 99;
      if (ib < 0) ib = 99;
      if (ia !== ib) return ia - ib;
    }
    return 0;
  }

  /** Split a function body into top-level statements: on ';' at bracket depth 0 and after a '}' that
   *  returns to depth 0 (so `for(...){...}return x` gives two statements). */
  function splitStatements(body) {
    const out = [];
    let depth = 0, start = 0;
    const push = (s) => { s = s.trim(); if (s) out.push(s); };
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c === 40 || c === 91 || c === 123) depth++;            // ( [ {
      else if (c === 41 || c === 93 || c === 125) depth--;       // ) ] }
      if (c === 59 && depth === 0) { push(body.slice(start, i)); start = i + 1; continue; }   // ;
      if (c === 125 && depth === 0) { push(body.slice(start, i + 1)); start = i + 1; }
    }
    push(body.slice(start));
    return out;
  }

  /** 'for(header){body}' -> [header, body] with balanced parentheses. */
  function splitFor(stmt) {
    let depth = 0, i = 3;
    while (i < stmt.length) {
      const ch = stmt[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      i++;
    }
    const header = stmt.slice(4, i);
    const rest = stmt.slice(i + 1).trim();
    if (rest.startsWith('{') && rest.endsWith('}')) return [header, rest.slice(1, -1)];
    return [header, rest];
  }

  /** True when a blanked statement (scan() marks each read as ' _READ_ ') has a read to the RIGHT of a
   *  `?`, `&&`, `||` or a nested `function`: that read happens only for some values, so the layout is not
   *  fixed and the type must be unknown rather than a class with a guessed field list. A read on the LEFT
   *  of the operator (`return Vho(),a.Xs()?true:false`, java.lang.Boolean's instantiate) is unconditional.
   *  Same rule as gen_registry.py has_conditional_read(). */
  const COND_RE = /\?|&&|\|\||\bfunction\b/;
  function hasConditionalRead(blanked) {
    const m = COND_RE.exec(blanked);
    return !!m && blanked.indexOf('_READ_', m.index) >= 0;
  }

  // character classes used by the indexOf-based class-block search (JS \w is ASCII; identifiers add $)
  function isDigit(c) { return c >= 48 && c <= 57; }
  function isWordChar(c) { return isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
  function isIdentStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36; }
  function isIdentChar(c) { return isIdentStart(c) || isDigit(c); }
  /** Where the regex `\bIDENT` would start for the identifier run that ends right before `end`
   *  (js[end] is not an identifier char): the leftmost identifier-start position of the run at a
   *  word boundary; -1 when the run is empty or has no such position. */
  function identStartBefore(js, end) {
    let q = end;
    while (q > 0 && isIdentChar(js.charCodeAt(q - 1))) q--;
    for (let s = q; s < end; s++) {
      const c = js.charCodeAt(s);
      if (!isIdentStart(c)) continue;
      const prevWord = s > 0 && isWordChar(js.charCodeAt(s - 1));
      if (isWordChar(c) !== prevWord) return s;
    }
    return -1;
  }

  // ------------------------------------------------------------------------------------------------
  // Bundle: constants, function index, class blocks
  // ------------------------------------------------------------------------------------------------
  class Bundle {
    constructor(js, warn) {
      this.js = js;
      this.warn = warn;
      this._fnCache = new Map();
      this._useCache = new Map();
      this._callCache = new Map();
      // 1. constants: `NAME='...'` first wins; 1-letter locals are skipped (gen_registry CONST_RE). The name is
      // anchored at the START of its identifier run (lookbehind, plus the leading digits the unanchored
      // pattern's leftmost match skipped anyway), so a run that no constant consumes - a base64 data URI in
      // x('data:image/png;base64,...'), any double-quoted string - is tried once and scanned in O(length)
      // instead of once per character (O(length^2): 4.4 s for a single 100 K-char run, 0.3 ms anchored).
      this.constants = new Map();
      const CONST_RE = /(?<![A-Za-z0-9_$])[0-9]*([A-Za-z_$][A-Za-z0-9_$]*)='((?:[^'\\]|\\[^\n])*)'/g;
      let m;
      while ((m = CONST_RE.exec(js)) !== null) {
        const name = m[1];
        if (name.length >= 2 && !this.constants.has(name)) this.constants.set(name, jsUnescape(m[2]));
      }
      // 2. one pass indexing the first `function NAME(` of every name (the Python does str.find per lookup).
      this.fnIndex = new Map();
      const FN_RE = /function ([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
      while ((m = FN_RE.exec(js)) !== null) if (!this.fnIndex.has(m[1])) this.fnIndex.set(m[1], m.index);
    }

    /** A quoted literal or a constant name -> string (null when unknown). */
    resolve(token) {
      if (token == null) return null;
      if (token.startsWith("'") && token.endsWith("'")) return jsUnescape(token.slice(1, -1));
      return this.constants.has(token) ? this.constants.get(token) : null;
    }

    /** Full text `function NAME(params){...}` (brace matched from the first occurrence) or null. */
    fn(name) {
      if (this._fnCache.has(name)) return this._fnCache.get(name);
      let text = null;
      if (this.fnIndex.has(name)) {
        const js = this.js, i = this.fnIndex.get(name), j = js.indexOf('{', i);
        if (j >= 0) {
          let depth = 0, k = j;
          const n = js.length;
          while (k < n) {
            const c = js.charCodeAt(k);
            if (c === 123) depth++;
            else if (c === 125) { depth--; if (depth === 0) break; }
            k++;
          }
          text = js.slice(i, k + 1);
        }
      }
      this._fnCache.set(name, text);
      return text;
    }

    /** [params list, inner body] of a function, or [null, null]. */
    fnParts(name) {
      const text = this.fn(name);
      if (text == null) return [null, null];
      const headEnd = text.indexOf('{');
      const params = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').map((p) => p.trim()).filter((p) => p);
      return [params, text.slice(headEnd + 1, -1)];
    }

    /** Regex matching the variable `name` but not a property `.name` / identifier containing it (var_use). */
    varUse(name) {
      let re = this._useCache.get(name);
      if (!re) { re = new RegExp('(?<![\\w$.])' + reEscape(name) + '(?![\\w$])'); this._useCache.set(name, re); }
      return re;
    }

    /** Anchored regex for a bare superclass call `NAME(a,b)` with exactly these two argument names. */
    callOf(a, b) {
      const key = a + ',' + b;
      let re = this._callCache.get(key);
      if (!re) { re = new RegExp('^(' + IDENT + ')\\(' + reEscape(a) + ',' + reEscape(b) + '\\)$'); this._callCache.set(key, re); }
      return re;
    }

    /** Prototype block of the class whose class literal is `classLiteral`: the text between
     *  `<defineClass>(<id>,...` and `<makeClassLiteral>(<pkg>,'<literal>',<id>)`. Same result as the
     *  Python's two regex searches (`\bIDENT\(IDENT,'LIT',(\d+)\)` then the last `\b(IDENT)\(<id>,\d+,`
     *  before it), located with indexOf instead of scanning 5.7 MB with a backtracking pattern. */
    classBlock(classLiteral) {
      const js = this.js, needle = ",'" + classLiteral + "',";
      let pos = 0, mStart = -1, cid = null;
      for (;;) {
        const p = js.indexOf(needle, pos);
        if (p < 0) return null;
        pos = p + 1;
        let k = p + needle.length;
        const d0 = k;
        while (k < js.length && isDigit(js.charCodeAt(k))) k++;
        if (k === d0 || js.charCodeAt(k) !== 41) continue;                       // (\d+)\)
        let q = p;
        while (q > 0 && isIdentChar(js.charCodeAt(q - 1))) q--;                  // second IDENT: js[q..p)
        if (q === p || q === 0 || !isIdentStart(js.charCodeAt(q)) || js.charCodeAt(q - 1) !== 40) continue;
        const s = identStartBefore(js, q - 1);                                    // \bIDENT before the '('
        if (s < 0) continue;
        mStart = s;
        cid = js.slice(d0, k);
        break;
      }
      const needle2 = '(' + cid + ',';
      let p2 = js.lastIndexOf(needle2, mStart);
      while (p2 >= 0) {
        let k = p2 + needle2.length;
        const d0 = k;
        while (k < js.length && isDigit(js.charCodeAt(k))) k++;
        if (k > d0 && js.charCodeAt(k) === 44 && k + 1 <= mStart) {                // \d+, ending before m
          const s = identStartBefore(js, p2);
          if (s >= 0) return js.slice(s, mStart);
        }
        if (p2 === 0) break;
        p2 = js.lastIndexOf(needle2, p2 - 1);
      }
      return null;
    }
  }

  /** [[method, inner body]] for `_.X=function Y(...){...}` in a prototype block (ReaderInfo.proto_methods). */
  function protoMethods(block) {
    const out = [];
    const re = new RegExp('_\\.(' + IDENT + ')=function (?:' + IDENT + ')?\\(([^)]*)\\)\\{', 'g');
    let m;
    while ((m = re.exec(block)) !== null) {
      const i = m.index + m[0].length - 1;
      let depth = 0, k = i;
      while (k < block.length) {
        const c = block.charCodeAt(k);
        if (c === 123) depth++;
        else if (c === 125) { depth--; if (depth === 0) break; }
        k++;
      }
      out.push([m[1], block.slice(i + 1, k).trim()]);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // 1. Reader side: derive reader-method -> kind and the inlined helper names.
  // ------------------------------------------------------------------------------------------------
  class ReaderInfo {
    constructor(bundle) {
      this.b = bundle;
      this.methods = new Map();   // prototype method name -> kind ('z','b','h','i','d','l','s','o')
      this.objImpl = null;        // e.g. 'U0n' : readObject implementation
      this.boolHelper = null;     // e.g. 'i1n'
      this.dblHelper = null;      // e.g. 'j1n'
      this.longHelper = null;     // e.g. 'k1n'
      this.longDecoder = null;    // e.g. 'S0n'
      this.strHelper = null;      // e.g. 'g1n'
      this.arr = 'b';             // token array field (this.b)
      this.idx = 'a';             // index field (this.a)
      this._pat = new Map();
      this.derive();
    }

    derive() {
      const b = this.b, warn = b.warn;
      const client = b.classBlock('ClientSerializationStreamReader');
      const abstract = b.classBlock('AbstractSerializationStreamReader');
      if (client == null || abstract == null) throw new Error('cannot locate the serialization stream reader classes in the bundle');
      const raw = [], numbers = [];
      const RAW_RE = /^return this\.([a-z])\[--this\.([a-z])\]$/;
      const HELPER_RE = new RegExp('^return (' + IDENT + ')\\(this\\)$');
      const BOOL_BODY = new RegExp('^return !!' + IDENT + '\\.' + IDENT + '\\[--' + IDENT + '\\.' + IDENT + '\\]$');
      const NUM_BODY = new RegExp('^return Number\\(' + IDENT + '\\.' + IDENT + '\\[--' + IDENT + '\\.' + IDENT + '\\]\\)$');
      const RET_CALL = new RegExp('return (' + IDENT + ')\\(');
      const STR_RE = new RegExp('^return (' + IDENT + ')\\(this,this\\.([a-z])\\[--this\\.([a-z])\\]\\)$');
      const STR_BODY = new RegExp('return ' + IDENT + '>0\\?' + IDENT + '\\.' + IDENT + '\\[' + IDENT + '-1\\]:null');
      const all = protoMethods(client).concat(protoMethods(abstract));
      for (let n = 0; n < all.length; n++) {
        const meth = all[n][0], inner = all[n][1];
        let m = RAW_RE.exec(inner);
        if (m) { this.arr = m[1]; this.idx = m[2]; raw.push(meth); continue; }
        m = HELPER_RE.exec(inner);
        if (m) {
          const helper = m[1];
          let hb = b.fnParts(helper)[1];
          if (hb == null) { warn('reader helper ' + helper + ' not found'); continue; }
          hb = hb.trim();
          if (BOOL_BODY.test(hb)) { this.methods.set(meth, 'z'); this.boolHelper = helper; }
          else if (NUM_BODY.test(hb)) { numbers.push(meth); this.dblHelper = this.dblHelper || helper; }
          else if (hb.indexOf('.push(null)') >= 0) { this.methods.set(meth, 'o'); this.objImpl = helper; }
          else if (/\[--/.test(hb) && RET_CALL.test(hb)) {
            this.methods.set(meth, 'l');
            this.longHelper = helper;
            this.longDecoder = RET_CALL.exec(hb)[1];
          } else warn('unclassified reader helper ' + helper + ': ' + hb.slice(0, 80));
          continue;
        }
        m = STR_RE.exec(inner);
        if (m) {
          const helper = m[1], hb = b.fnParts(helper)[1];
          if (hb && STR_BODY.test(hb)) { this.methods.set(meth, 's'); this.strHelper = helper; }
          else warn('unclassified string-like reader ' + meth);
        }
        // anything else in these blocks is not a read method (fields, misc) -> ignore
      }
      // Raw readers: the Java names sort readByte < readChar < readInt < readShort and GWT hands out
      // obfuscated names in that order (cross-checked below against the writer side).
      raw.sort(gwtCompare);
      const rawKinds = RAW_READER_KINDS[raw.length];
      if (!rawKinds) throw new Error('unexpected number of raw reader methods: ' + pyRepr(raw));
      raw.forEach((meth, i) => this.methods.set(meth, rawKinds[i]));
      numbers.sort(gwtCompare);
      numbers.forEach((meth, i) => { if (i < 2) this.methods.set(meth, ['d', 'f'][i]); });
      const found = new Set(this.methods.values());
      const missing = ['z', 'i', 'd', 'l', 's', 'o'].filter((k) => !found.has(k));
      if (missing.length) throw new Error('reader derivation incomplete, missing kinds ' + pyRepr(missing) + ' (found ' + pyReprCounter(this.methods) + ')');
    }

    /** Compiled regex matching every token-consuming expression where `r` is the reader variable. */
    readPattern(r) {
      let re = this._pat.get(r);
      if (re) return re;
      const R = reEscape(r), alts = [];
      // Every inlined helper call is anchored with the same lookbehind as the `m` / `raw` alternatives (and the
      // writer's `h`), NOT a word boundary: `\b` before a `$`-initial name (GWT hands them out in sequence:
      // ... Z0n $0n _0n a1n ...) needs a word char BEFORE the `$`, but call sites are preceded by `(` `,`
      // `=` or a space, so such a helper would never match and every class using it would become unknown.
      if (this.strHelper) alts.push('(?<s>(?<![\\w$.])' + reEscape(this.strHelper) + '\\(' + R + ',' + R + '\\.' + this.arr + '\\[--' + R + '\\.' + this.idx + '\\]\\))');
      alts.push('(?<m>(?<![\\w$.])' + R + '\\.(?<mm>' + Array.from(this.methods.keys()).map(reEscape).join('|') + ')\\(\\))');
      if (this.objImpl) alts.push('(?<o>(?<![\\w$.])' + reEscape(this.objImpl) + '\\(' + R + '\\))');
      if (this.boolHelper) alts.push('(?<z>(?<![\\w$.])' + reEscape(this.boolHelper) + '\\(' + R + '\\))');
      if (this.dblHelper) alts.push('(?<d>(?<![\\w$.])' + reEscape(this.dblHelper) + '\\(' + R + '\\))');
      if (this.longHelper) alts.push('(?<l>(?<![\\w$.])' + reEscape(this.longHelper) + '\\(' + R + '\\))');
      // The double / bool helper BODIES, should a future compile inline them (`Number(a.b[--a.a])`,
      // `!!a.b[--a.a]`), are typed like the helpers - before the bare `raw` token read inside them would
      // count as an int (gen_registry.py read_pattern has the same two alternatives).
      const RAW = R + '\\.' + this.arr + '\\[--' + R + '\\.' + this.idx + '\\]';
      alts.push('(?<nd>(?<![\\w$.])Number\\(' + RAW + '\\))');
      alts.push('(?<nz>(?<![\\w$.])!!' + RAW + ')');
      alts.push('(?<raw>(?<![\\w$.])' + RAW + ')');
      re = new RegExp(alts.join('|'), 'g');
      this._pat.set(r, re);
      return re;
    }

    /** -> [kinds in evaluation order, statement with the reads blanked out]. */
    scan(r, stmt) {
      const pat = this.readPattern(r), kinds = [], methods = this.methods;
      const blanked = stmt.replace(pat, function () {
        const g = arguments[arguments.length - 1];
        if (g.m !== undefined) kinds.push(methods.get(g.mm));
        else if (g.raw !== undefined) kinds.push('i');   // inlined raw token read: int-like (byte/short/int share the wire form)
        else if (g.s !== undefined) kinds.push('s');
        else if (g.o !== undefined) kinds.push('o');
        else if (g.z !== undefined) kinds.push('z');
        else if (g.d !== undefined || g.nd !== undefined) kinds.push('d');
        else if (g.nz !== undefined) kinds.push('z');
        else kinds.push('l');
        return ' _READ_ ';
      });
      return [kinds, blanked];
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 2. Writer side: writer-method -> kind by correlating classes that have both ser and deser.
  // ------------------------------------------------------------------------------------------------
  class WriterInfo {
    constructor(bundle) {
      this.b = bundle;
      this.methods = new Map();          // prototype method name -> kind
      this.candidates = [];
      this.helperToMethod = new Map();   // inlined helper name (Y0n, Z0n, $0n, X0n) -> prototype method (Ts, Us, Ws, Ss)
      this.rawWriter = null;             // e.g. 'v1n': appends one raw token (used inlined for byte/short/bool/long)
      this.longEncoder = null;           // e.g. 'T0n'
      this.boolMethod = null;
      this.longMethod = null;
      this.intMethod = null;             // prototype method whose helper appends ''+value (writeInt)
      this._pat = new Map();
      const block = (bundle.classBlock('AbstractSerializationStreamWriter') || '') +
                    (bundle.classBlock('ClientSerializationStreamWriter') || '');
      const METH_RE = new RegExp('_\\.(' + IDENT + ')=function (?:' + IDENT + ')?\\((\\w)\\)\\{([^}]*)\\}', 'g');
      let m;
      while ((m = METH_RE.exec(block)) !== null) {
        const meth = m[1], P = reEscape(m[2]), body = m[3];
        this.candidates.push(meth);
        if (body.indexOf("?'1':'0'") >= 0 || body.indexOf('?"1":"0"') >= 0) {
          this.methods.set(meth, 'z');   // writeBoolean is the only one with the '1'/'0' literal
          this.boolMethod = meth;
          continue;
        }
        let mm = new RegExp('^(' + IDENT + ')\\(this,\\(?(?:' + IDENT + '\\(\\),)?\'\'\\+' + P + '\\)?\\)$').exec(body);
        if (mm) { this.rawWriter = mm[1]; continue; }                       // writeByte/writeShort: RAW(this,''+a)
        mm = new RegExp('^(' + IDENT + ')\\(this,(' + IDENT + ')\\(' + P + '\\)\\)$').exec(body);
        if (mm) {                                                          // writeLong: RAW(this,ENCODER(a))
          this.rawWriter = this.rawWriter || mm[1];
          this.longEncoder = mm[2];
          this.longMethod = meth;
          continue;
        }
        mm = new RegExp('^(' + IDENT + ')\\(this,' + P + '\\)$').exec(body);
        if (mm) {                                                          // writeInt/Double/Object/String: HELPER(this,a)
          this.helperToMethod.set(mm[1], meth);
          const hb = bundle.fnParts(mm[1])[1];
          if (hb && this.rawWriter &&
              new RegExp('^' + reEscape(this.rawWriter) + '\\(' + IDENT + ',\\(?(?:' + IDENT + '\\(\\),)?\'\'\\+' + IDENT + '\\)?\\)$').test(hb.trim())) {
            this.intMethod = this.intMethod || meth;
          }
        }
      }
      if (!this.candidates.length) throw new Error('cannot locate the serialization stream writer class');
      this.methods.set('#raw', 'i');
    }

    /** Matches prototype writes `w.Ts(` and the inlined helper forms; group 'm' = method, 'h' = helper
     *  name, 'l' = inlined long, 'z' = inlined bool, 'r' = inlined raw int-like (alternation order matters). */
    writePattern(w) {
      let re = this._pat.get(w);
      if (re) return re;
      const W = reEscape(w);
      const alts = ['(?<m>(?<![\\w$.])' + W + '\\.(?<mm>' + this.candidates.map(reEscape).join('|') + ')\\()'];
      if (this.helperToMethod.size) alts.push('(?<h>(?<![\\w$.])(?<hh>' + Array.from(this.helperToMethod.keys()).map(reEscape).join('|') + ')\\(' + W + ',)');
      if (this.rawWriter) {
        const RW = reEscape(this.rawWriter);
        if (this.longEncoder) alts.push('(?<l>(?<![\\w$.])' + RW + '\\(' + W + ',' + reEscape(this.longEncoder) + '\\()');
        alts.push("(?<z>(?<![\\w$.])" + RW + '\\(' + W + ",[^;]*?\\?'1':'0'\\))");
        alts.push('(?<r>(?<![\\w$.])' + RW + '\\(' + W + ',)');
      }
      re = new RegExp(alts.join('|'), 'g');
      this._pat.set(w, re);
      return re;
    }

    methodOf(groups) {
      if (groups.m !== undefined) return groups.mm;
      if (groups.h !== undefined) return this.helperToMethod.has(groups.hh) ? this.helperToMethod.get(groups.hh) : null;
      if (groups.l !== undefined) return this.longMethod;
      if (groups.z !== undefined) return this.boolMethod;
      return '#raw';   // inlined raw ''+x: byte/short/int share the wire form (kind 'i')
    }

    /** [[writer method, written expression]] of a serializer (superclass calls inlined), or null. */
    scanSer(name, depth) {
      depth = depth || 0;
      const parts = this.b.fnParts(name), params = parts[0], inner = parts[1];
      if (inner == null || params.length !== 2 || depth > 8) return null;
      const w = params[0], o = params[1];
      const seq = [], pat = this.writePattern(w), use = this.b.varUse(w), call = this.b.callOf(w, o);
      const stmts = splitStatements(inner);
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i], found = [];
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(stmt)) !== null) {
          const meth = this.methodOf(m.groups);
          if (meth == null) return null;
          found.push([meth, stmt.slice(m.index + m[0].length).split(')')[0]]);
        }
        const rest = stmt.replace(pat, ' _W_ ');
        if (found.length) {
          for (let j = 0; j < found.length; j++) seq.push(found[j]);
          if (use.test(rest)) return null;
          continue;
        }
        const cm = call.exec(stmt);
        if (cm) {
          const sub = this.scanSer(cm[1], depth + 1);
          if (sub == null) return null;
          for (let j = 0; j < sub.length; j++) seq.push(sub[j]);
          continue;
        }
        if (use.test(stmt)) return null;
      }
      return seq;
    }

    /** pairs: [[writer method sequence, reader kind sequence]] -> vote writer method -> kind. */
    correlate(pairs) {
      const warn = this.b.warn, votes = new Map();
      for (let p = 0; p < pairs.length; p++) {
        const wseq = pairs[p][0], kinds = pairs[p][1];
        if (wseq.length !== kinds.length) continue;
        for (let i = 0; i < wseq.length; i++) {
          let c = votes.get(wseq[i]);
          if (!c) { c = new Map(); votes.set(wseq[i], c); }
          c.set(kinds[i], (c.get(kinds[i]) || 0) + 1);
        }
      }
      votes.forEach((c, wm) => {
        if (wm.startsWith('#')) return;   // pseudo method for inlined raw writes (byte/short/int are all decimal)
        let kind = null, best = -1;
        c.forEach((n, k) => { if (n > best) { best = n; kind = k; } });   // first-inserted wins a tie, like Counter.most_common
        if (this.methods.has(wm) && this.methods.get(wm) !== kind) {
          warn('writer method ' + wm + ': literal says ' + this.methods.get(wm) + ' but correlation says ' + kind);
          return;
        }
        if (c.size > 1) warn('writer method ' + wm + ' has mixed votes ' + pyReprCounter(c));
        this.methods.set(wm, kind);
      });
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 3. Classification of every serializer-table row.
  // ------------------------------------------------------------------------------------------------
  class Classifier {
    constructor(bundle, reader, writer) {
      this.b = bundle;
      this.r = reader;
      this.w = writer;
      this._readsCache = new Map();
    }

    /** [items, error]: items = kinds in evaluation order; a loop is {loop:[kinds per iteration]}. */
    readsOf(name, depth) {
      depth = depth || 0;
      if (this._readsCache.has(name)) return this._readsCache.get(name);
      const parts = this.b.fnParts(name), params = parts[0], inner = parts[1];
      let res;
      if (inner == null) res = [null, 'function ' + name + ' not found'];
      else if (!params.length) res = [[], null];
      else res = this.readsIn(inner, params[0], params.length > 1 ? params[1] : null, name, depth);
      this._readsCache.set(name, res);
      return res;
    }

    readsIn(code, r, o, name, depth) {
      const items = [], use = this.b.varUse(r), call = this.b.callOf(r, o == null ? '__none__' : o);
      const stmts = splitStatements(code);
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (stmt.startsWith('for(')) {
          const hb = splitFor(stmt), header = hb[0], body = hb[1];
          const hs = this.r.scan(r, header);
          if (hs[0].length || use.test(hs[1])) return [null, 'reads in for-header of ' + name + ': ' + stmt.slice(0, 80)];
          const se = this.readsIn(body, r, o, name, depth), sub = se[0], err = se[1];
          if (err) return [null, err];
          if (flat(sub) == null) return [null, 'nested loop in ' + name];
          items.push(loop(sub));
          continue;
        }
        // splitStatements() cuts after every `}` that returns to depth 0, so `if(..){..}else{..}` and
        // `try{..}catch(e){..}finally{..}` arrive as separate statements: an else / catch / finally part is
        // as conditional as the head it belongs to (gen_registry.py reads_in has the same list).
        if (/^(while|do|if|switch|try|else|catch|finally)\b/.test(stmt)) {
          const ks = this.r.scan(r, stmt);
          if (ks[0].length || use.test(ks[1])) return [null, 'conditional reads in ' + name + ': ' + stmt.slice(0, 80)];
          continue;
        }
        const fr = this.r.scan(r, stmt), found = fr[0], rest = fr[1];
        if (found.length && hasConditionalRead(rest)) return [null, 'conditional reads in ' + name + ': ' + stmt.slice(0, 80)];
        for (let j = 0; j < found.length; j++) items.push(found[j]);
        if (!use.test(rest)) continue;
        const m = call.exec(stmt);
        if (m && !found.length) {   // superclass deserializer / shared collection helper
          if (depth > 8) return [null, 'recursion too deep at ' + name];
          const se = this.readsOf(m[1], depth + 1), sub = se[0], err = se[1];
          if (err) return [null, err];
          for (let j = 0; j < sub.length; j++) items.push(sub[j]);
          continue;
        }
        return [null, 'unrecognised use of reader in ' + name + ': ' + stmt.slice(0, 80)];
      }
      return [items, null];
    }

    static base(sig) { return sig.split('/')[0]; }

    /** Recognise list/map/arrays shapes from read structures. -> [kind, pre] or null. */
    static collectionShape(preItems, fItems) {
      const fp = flat(preItems);
      if (same(fItems, ['i', loop(['o'])]) && fp != null) return ['list', fp];
      if (same(fItems, ['i', loop(['o', 'o'])]) && fp != null) return ['map', fp];
      if (same(preItems, ['i', loop(['o'])]) && same(fItems, [])) return ['arrays', []];
      return null;
    }

    classify(sig, row) {
      const inst = row.inst, deser = row.deser, ser = row.ser, warn = this.b.warn;
      const base = Classifier.base(sig);
      if (sig.startsWith('[')) return this.classifyArray(sig, row);
      if (Object.prototype.hasOwnProperty.call(BOX_TYPES, base)) {
        let t = BOX_TYPES[base];
        if (inst) {
          const kinds = flat(this.readsOf(inst)[0]);
          if (kinds && kinds.length === 1 && kinds[0] !== t && !(t === 'c' && kinds[0] === 'i')) {
            warn(sig + ': instantiate reads ' + kinds[0] + ', expected ' + t);
            t = kinds[0];
          }
        }
        return { k: 'box', t: t };
      }
      if (!inst && !deser) return this.classifySerOnly(sig, row);

      const pr = inst ? this.readsOf(inst) : [[], null], preItems = pr[0];
      if (pr[1]) return { k: 'unknown', why: pr[1] };
      const fr = deser ? this.readsOf(deser) : [[], null], fItems = fr[0];
      if (fr[1]) return { k: 'unknown', why: fr[1] };
      const pre = flat(preItems), fields = flat(fItems);

      // ---- java.util special shapes (SPEC 3.2) ----
      if (Object.prototype.hasOwnProperty.call(EMPTY_TYPES, base)) {
        if (nonEmpty(pre) || nonEmpty(fields)) return { k: 'unknown', why: 'empty collection with reads' };
        return { k: 'empty', t: EMPTY_TYPES[base] };
      }
      if (SINGLETON_TYPES.has(base)) {
        if (!same(pre, ['o']) || nonEmpty(fields)) return { k: 'unknown', why: 'singleton with unexpected reads pre=' + pyRepr(preItems) + ' f=' + pyRepr(fItems) };
        return { k: 'singleton' };
      }
      if (DATE_TYPES.has(base)) {
        if (!same(pre, ['l']) || fields == null) return { k: 'unknown', why: 'date type with unexpected reads pre=' + pyRepr(preItems) + ' f=' + pyRepr(fItems) };
        const entry = { k: 'date' };
        if (fields.length) entry.f = fields;          // java.sql.Timestamp reads nanos after the long
        return entry;
      }
      const shape = Classifier.collectionShape(preItems, fItems);
      if (shape) {
        let kind = shape[0];
        const spre = shape[1];
        if (ARRAYS_TYPES.has(base) && kind !== 'arrays') return { k: 'unknown', why: 'Arrays$ArrayList with unexpected shape' };
        if (SET_TYPES.has(base)) kind = 'set';
        const entry = { k: kind };
        if (spre.length) entry.pre = spre;
        if (!base.startsWith('java.util.')) entry.sub = true;   // application subclass of a java.util collection
        return entry;
      }
      if (KNOWN_COLLECTIONS.has(base)) return { k: 'unknown', why: 'java.util collection with unrecognised shape pre=' + pyRepr(preItems) + ' f=' + pyRepr(fItems) };

      // ---- enum ----
      // Enum.values()[ordinal]: the instantiate ends with an index expression - `return c[b]` today, and a
      // future compile may hoist differently (`return ($pj(),c)[b]`, `return Xyz[b]`, `return c[b]|0`); a
      // class instantiate never ends with `[x]`. The read shape (one int, no deserializer reads) is checked too.
      if (inst) {
        const inner = this.b.fnParts(inst)[1];
        if (inner != null && /return [^;]*\[[a-z]\](\|0)?$/.test(inner.trim())) {
          if (same(pre, ['i']) && !nonEmpty(fields)) return { k: 'enum' };
          return { k: 'unknown', why: 'enum-like instantiate with reads ' + pyRepr(preItems) };
        }
      }

      // ---- ordinary class ----
      if (pre == null || fields == null) return { k: 'unknown', why: 'loop in class reads pre=' + pyRepr(preItems) + ' f=' + pyRepr(fItems) };
      const entry = { k: 'class', f: pre.concat(fields) };
      if (pre.length) entry.ipre = pre.length;      // how many leading fields are read by instantiate (documentation)
      if (ser) {
        const wseq = this.w.scanSer(ser);
        if (wseq != null) {
          const wk = wseq.map((x) => (this.w.methods.has(x[0]) ? this.w.methods.get(x[0]) : '?'));
          if (!same(wk, entry.f)) warn(sig + ': serializer layout ' + pyRepr(wk.join('')) + ' differs from deserializer layout ' + pyRepr(entry.f.join('')));
        }
      }
      return entry;
    }

    /** client -> server only types (AddEntryChange...): layout from the serializer. */
    classifySerOnly(sig, row) {
      const wseq = this.w.scanSer(row.ser);
      if (wseq == null) return { k: 'unknown', why: 'unparseable serializer ' + row.ser };
      const kinds = wseq.map((x) => (this.w.methods.has(x[0]) ? this.w.methods.get(x[0]) : null));
      if (kinds.indexOf(null) >= 0) return { k: 'unknown', why: 'serializer ' + row.ser + ' uses unmapped writer methods ' + pyRepr(wseq.map((x) => x[0])) };
      return { k: 'class', f: kinds, from: 'ser', _w: wseq };
    }

    classifyArray(sig, row) {
      const elemSig = sig.slice(1).split('/')[0];
      let e;
      if (elemSig.startsWith('[')) e = 'o';
      else if (elemSig.startsWith('L')) e = elemSig === 'Ljava.lang.String;' ? 's' : 'o';
      else e = Object.prototype.hasOwnProperty.call(PRIM_ARRAY_ELEM, elemSig[0]) ? PRIM_ARRAY_ELEM[elemSig[0]] : 'o';
      const entry = { k: 'array', e: e };
      const inst = row.inst, deser = row.deser;
      if (inst) {
        const ie = this.readsOf(inst), items = ie[0], err = ie[1];
        if (err || !same(items, ['i'])) return { k: 'unknown', why: 'array instantiate ' + inst + ': ' + (err == null ? 'None' : err) + ' / reads ' + pyRepr(items) };
      }
      if (deser) {
        const ie = this.readsOf(deser), items = ie[0], err = ie[1];
        if (err) return { k: 'unknown', why: err };
        if (items.length === 1 && isLoop(items[0]) && items[0].loop.length === 1) entry.e = items[0].loop[0];
        else if (items.length) return { k: 'unknown', why: 'array deserializer ' + deser + ' reads ' + pyRepr(items) };
      } else if (!inst) {
        entry.from = 'ser';   // client->server only: element kind from the signature
      }
      return entry;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 4. Table, policies, service methods.
  // ------------------------------------------------------------------------------------------------
  function countMatches(re, text) {
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
  }

  /** Serializer-table rows merged across the (7) per-service tables: sig -> {inst, deser, ser}. */
  function loadTable(bundle) {
    const js = bundle.js, warn = bundle.warn, rows = new Map();
    let nRows = 0, unresolved = 0;
    const nTables = countMatches(new RegExp('function ' + IDENT + '\\(\\)\\{var a=\\{\\};a\\[', 'g'), js);
    const ROW_RE = new RegExp('a\\[(' + IDENT + ')\\]=\\[(' + IDENT + '|undefined),(' + IDENT + '|undefined)(?:,(' + IDENT + '))?\\]', 'g');
    let m;
    while ((m = ROW_RE.exec(js)) !== null) {
      const sig = bundle.constants.get(m[1]);
      if (!sig) { unresolved++; continue; }
      nRows++;
      const vals = [m[2], m[3], m[4]].map((g) => (g == null || g === 'undefined' ? null : g));
      let row = rows.get(sig);
      if (!row) { row = { inst: null, deser: null, ser: null }; rows.set(sig, row); }
      ['inst', 'deser', 'ser'].forEach((key, i) => {
        const val = vals[i];
        if (val && row[key] && row[key] !== val) warn(sig + ': conflicting ' + key + ' functions ' + row[key] + ' / ' + val + ' across tables');
        row[key] = row[key] || val;
      });
    }
    return { rows, nRows, nTables, unresolved };
  }

  /** service path -> policy hash from the RemoteServiceProxy constructors:
   *  X.call(this,<getModuleBase>(),'app'|<const>,'<32 hex>',<typeSerializer>) */
  function findPolicies(bundle) {
    const js = bundle.js, policies = new Map();
    const re = new RegExp("\\.call\\(this," + IDENT + "\\(\\),('[^']*'|" + IDENT + "),'([A-F0-9]{32})'," + IDENT + '\\)', 'g');
    let m;
    while ((m = re.exec(js)) !== null) {
      const path = bundle.resolve(m[1]);
      if (path && !policies.has(path)) policies.set(path, m[2]);
    }
    if (!policies.has('app')) {   // fallback per SPEC 3.2
      const f = /'app','([A-F0-9]{32})'/.exec(js);
      if (f) policies.set('app', f[1]);
    }
    return policies;
  }

  /** proxy class name -> sorted method names, via the RemoteServiceProxy.ServiceHelper ctor
   *  `function H(a,b,c){this.e=a;this.a=b+'.'+c;this.b=c;...}` and its `new H(this,<proxy>,<method>)` sites. */
  function findServiceMethods(bundle) {
    const js = bundle.js, out = new Map();
    const hm = new RegExp('function (' + IDENT + ")\\(a,b,c\\)\\{this\\.e=a;this\\.a=b\\+'\\.'\\+c;this\\.b=c;").exec(js);
    if (!hm) return out;
    const re = new RegExp('new ' + reEscape(hm[1]) + "\\(this,('[^']*'|" + IDENT + "),('[^']*'|" + IDENT + ')\\)', 'g');
    let m;
    while ((m = re.exec(js)) !== null) {
      const proxy = bundle.resolve(m[1]), meth = bundle.resolve(m[2]);
      if (proxy && meth) {
        let set = out.get(proxy);
        if (!set) { set = new Set(); out.set(proxy, set); }
        set.add(meth);
      }
    }
    const sorted = new Map();
    out.forEach((set, proxy) => sorted.set(proxy, Array.from(set).sort(cmpStr)));
    return sorted;
  }

  // ------------------------------------------------------------------------------------------------
  // 5. build()
  // ------------------------------------------------------------------------------------------------
  /**
   * One hop through the event loop between two chunks of work. scheduler.yield() (Chrome 129+) or a fresh
   * MessageChannel message: both are ordinary tasks. setTimeout(0) is not: Chrome clamps it to >= 4 ms after
   * five nested timers and, in a hidden tab, aligns timers to once per second (once per minute after five
   * minutes), so a rebuild in a background tab would take seconds or minutes instead of ~60 ms.
   */
  function yieldToEventLoop() {
    try {
      if (typeof scheduler !== 'undefined' && scheduler && typeof scheduler.yield === 'function') return scheduler.yield();
    } catch (e) { /* fall through */ }
    if (typeof MessageChannel === 'function') {
      return new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { try { ch.port1.close(); } catch (e) { /* ignore */ } resolve(); };
        ch.port2.postMessage(0);
      });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  const DEFAULT_YIELD_EVERY = 300;

  /** Python's '%Y-%m-%dT%H:%M:%SZ' of a Date (whole seconds). */
  function formatGeneratedAt(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  /** Object with the same keys in sorted order (json.dumps(sort_keys=True)); keys starting with '_' dropped. */
  function sortedEntry(e) {
    const out = {};
    Object.keys(e).filter((k) => k.charAt(0) !== '_').sort(cmpStr).forEach((k) => { out[k] = e[k]; });
    return out;
  }
  function sortedMap(map) {
    const out = {};
    Array.from(map.keys()).sort(cmpStr).forEach((k) => { out[k] = map.get(k); });
    return out;
  }

  /**
   * build(text, opts) -> Promise<registry>. See the header for opts. Throws when the text is not a GWT
   * bundle this generator understands (reader/writer classes missing, no serializer table).
   */
  async function build(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string' || !text.length) throw new Error('registry-builder: build() needs the bundle text');
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : null;
    const report = (phase, done, total) => { if (onProgress) { try { onProgress({ phase, done, total }); } catch (e) { /* never let a UI callback break the build */ } } };
    const warn = (msg) => {
      if (onWarning) onWarning(msg);
      else if (!opts.quiet && typeof console !== 'undefined') console.warn('registry-builder: WARNING: ' + msg);
    };
    const js = text;
    let generatedAt = opts.generatedAt;
    if (generatedAt instanceof Date) generatedAt = formatGeneratedAt(generatedAt);
    if (typeof generatedAt !== 'string' || !generatedAt) generatedAt = formatGeneratedAt(new Date());
    // yieldEvery: types between two yields to the event loop (default 300: a few hops for the ~55 ms the
    // whole build takes); 0 never yields, so the whole build runs synchronously inside the caller's task
    // (used for timing it under a frozen virtual clock).
    const yieldEvery = typeof opts.yieldEvery === 'number' && opts.yieldEvery >= 0 ? Math.floor(opts.yieldEvery) : DEFAULT_YIELD_EVERY;
    const step = yieldEvery > 0 ? yieldEvery : DEFAULT_YIELD_EVERY;

    report('constants', 0, 1);
    if (yieldEvery > 0) await yieldToEventLoop();
    const bundle = new Bundle(js, warn);
    report('constants', 1, 1);

    // permutation: the bundle's own $strongName wins; the caller's is the fallback and is cross-checked
    const pm = /\$strongName\s*=\s*'([0-9A-F]{32})'/.exec(js);
    let perm = pm ? pm[1] : null;
    const wanted = opts.permutation ? String(opts.permutation).toUpperCase() : null;
    if (perm && wanted && perm !== wanted) warn('bundle declares $strongName ' + perm + ' but the caller expected ' + wanted);
    if (!perm) perm = wanted;

    report('reader', 0, 1);
    if (yieldEvery > 0) await yieldToEventLoop();
    const policies = findPolicies(bundle);
    const reader = new ReaderInfo(bundle);
    const writer = new WriterInfo(bundle);
    report('reader', 1, 1);
    report('table', 0, 1);
    if (yieldEvery > 0) await yieldToEventLoop();
    const table = loadTable(bundle), rows = table.rows;
    if (!rows.size) throw new Error('registry-builder: no serializer table rows found');
    report('table', 1, 1);
    const classifier = new Classifier(bundle, reader, writer);

    // pass 1: derive the writer map from every row that has both a deserializer and a serializer
    const pairs = [];
    let i = 0;
    const sigsInOrder = Array.from(rows.keys());
    for (i = 0; i < sigsInOrder.length; i++) {
      const sig = sigsInOrder[i], row = rows.get(sig);
      if (row.deser && row.ser && !sig.startsWith('[')) {
        const kinds = flat(classifier.readsOf(row.deser)[0]);
        const wseq = writer.scanSer(row.ser);
        if (kinds != null && wseq != null && kinds.length === wseq.length) pairs.push([wseq.map((x) => x[0]), kinds]);
      }
      if ((i + 1) % step === 0) { report('correlate', i + 1, sigsInOrder.length); if (yieldEvery > 0) await yieldToEventLoop(); }
    }
    writer.correlate(pairs);
    report('correlate', sigsInOrder.length, sigsInOrder.length);

    // pass 2: classify everything (sorted, so the result is deterministic like the generated file)
    const types = new Map();
    const sigs = sigsInOrder.slice().sort(cmpStr);
    for (i = 0; i < sigs.length; i++) {
      const sig = sigs[i];
      let entry;
      try {
        entry = classifier.classify(sig, rows.get(sig));
      } catch (e) {   // never let one row break the build
        entry = { k: 'unknown', why: 'exception: ' + ((e && e.message) || String(e)) };
      }
      types.set(sig, entry);
      if ((i + 1) % step === 0) { report('classify', i + 1, sigs.length); if (yieldEvery > 0) await yieldToEventLoop(); }
    }
    report('classify', sigs.length, sigs.length);

    // pass 3: serializer-only enums. Enum serializers write the ordinal field of java.lang.Enum
    // (`a.Ts(b.g)` in this build); derive that field name from the enums that have an instantiate.
    const ordinalVotes = new Map();
    sigsInOrder.forEach((sig) => {
      const row = rows.get(sig);
      if (types.get(sig).k === 'enum' && row.ser) {
        const wseq = writer.scanSer(row.ser);
        if (wseq && wseq.length === 1) ordinalVotes.set(wseq[0][1], (ordinalVotes.get(wseq[0][1]) || 0) + 1);
      }
    });
    let ordinalField = null, bestVotes = -1;
    ordinalVotes.forEach((n, field) => { if (n > bestVotes) { bestVotes = n; ordinalField = field; } });
    types.forEach((e, sig) => {
      if (e.from === 'ser' && e.k === 'class' && same(e.f, ['i']) && ordinalField && e._w && e._w[0][1] === ordinalField) {
        types.set(sig, { k: 'enum', from: 'ser' });
      }
    });

    // ---- emit (key order = the generated file's) ----
    const kindsCount = new Map();
    let unknown = 0;
    types.forEach((e) => {
      kindsCount.set(e.k, (kindsCount.get(e.k) || 0) + 1);
      if (e.k === 'unknown') unknown++;
    });
    const serviceMethods = findServiceMethods(bundle);
    let crono = [];
    for (const [proxy, methods] of serviceMethods) { if (proxy.startsWith('CronometerService')) { crono = methods; break; } }

    const registry = {
      generatedAt: generatedAt,
      bundle: typeof opts.bundle === 'string' && opts.bundle ? opts.bundle : 'all.js',
      permutation: perm,
      policyHash: policies.has('app') ? policies.get('app') : null,
      proPolicyHash: policies.has('pro') ? policies.get('pro') : null,
      policies: sortedMap(policies),
      readerMethods: sortedMap(reader.methods),
      readerHelpers: {
        readObject: reader.objImpl, bool: reader.boolHelper, double: reader.dblHelper,
        long: reader.longHelper, longDecoder: reader.longDecoder, string: reader.strHelper,
      },
      writerMethods: sortedMap(writer.methods),
      enumOrdinalField: ordinalField,
      serviceMethods: crono,
      stats: { tables: table.nTables, rows: table.nRows, types: types.size, kinds: sortedMap(kindsCount), unknown: unknown },
      types: {},
    };
    sigs.forEach((sig) => { registry.types[sig] = sortedEntry(types.get(sig)); });
    report('done', 1, 1);
    return registry;
  }

  // ------------------------------------------------------------------------------------------------
  // 6. validate()
  // ------------------------------------------------------------------------------------------------
  const MAX_UNKNOWN = 5;                       // the shipped build has 0; a handful of exotic exception types is tolerable
  const REQUIRED_KINDS = ['i', 'z', 's', 'o', 'd', 'l', 'b', 'h'];
  const REQUIRED_METHODS = ['updateDiary', 'getDayInfo', 'getFood', 'removeServing', 'authenticate', 'editDiaryEntries', 'reauthenticate'];
  const HEX32 = /^[0-9A-F]{32}$/;
  /**
   * SPEC 3.3 layouts, by BASE name (resolved like CMA.gwt.sig(): the first key `base/CRC`, so a deploy that
   * only changes a CRC still validates) in gen_registry.py's layout_str() notation: class -> field kinds,
   * array -> 'array:<e>', collections -> kind[:pre], box -> 'box:<t>'. 'USER' = 42 fields, idx 19 int,
   * idx 33 string (SPEC 2.1). `required:false` entries must match only when the type exists.
   */
  const EXPECTED_LAYOUTS = [
    { base: 'com.cronometer.shared.entries.models.Serving', layout: 'ozzoioidiliii' },
    { base: 'com.cronometer.shared.entries.models.Day', layout: 'bbh' },
    { base: 'com.cronometer.shared.entries.models.Time', layout: 'bbb' },
    { base: 'com.cronometer.shared.entries.changes.AddEntryChange', layout: 'zzo' },
    { base: 'com.cronometer.shared.entries.changes.AddEntryChangeResult', layout: 'o' },
    { base: 'com.cronometer.shared.entries.changes.ErrorEntryChangeResult', layout: 'oo' },
    { base: 'com.cronometer.shared.entries.models.DayInfo', layout: 'zooozs' },
    { base: 'com.cronometer.shared.foods.models.Measure', layout: 'dziziosood' },
    { base: 'com.cronometer.shared.foods.models.FoodMeasures', layout: 'io' },
    { base: 'com.cronometer.shared.foods.models.Food', layout: 'izoisiiioolooozsoooi' },
    { base: 'com.cronometer.shared.foods.models.Translation', layout: 'osi' },
    { base: 'com.cronometer.shared.user.models.Language', layout: 'ssss' },
    { base: 'com.cronometer.shared.foods.models.SearchHit', layout: 'iiissisziosioi', required: false },
    { base: 'com.cronometer.shared.user.models.User', layout: 'USER' },
    { base: 'com.cronometer.shared.user.models.UserPreferences', layout: 'map' },
    { base: 'java.util.HashMap', layout: 'map' },
    { base: 'java.util.ArrayList', layout: 'list' },
    { base: 'java.util.Collections$SingletonList', layout: 'singleton' },
    { base: 'java.util.Date', layout: 'date', required: false },
    { base: 'java.lang.String', layout: 'box:s' },
    { base: 'java.lang.Integer', layout: 'box:i' },
    { base: '[Ljava.lang.String;', layout: 'array:s' },
    { base: 'com.cronometer.shared.foods.models.Measure$Type', layout: 'enum' },
    { base: 'com.cronometer.shared.foods.FoodSource', layout: 'enum' },
    { base: 'com.cronometer.shared.user.exceptions.NotLoggedInException', layout: 's' },
  ];

  /** gen_registry.layout_str() plus 'box:<t>'. */
  function layoutStr(e) {
    if (e == null) return 'MISSING';
    if (e.k === 'class') return Array.isArray(e.f) ? e.f.join('') : 'MISSING';
    if (e.k === 'array') return 'array:' + e.e;
    if (e.k === 'box') return 'box:' + e.t;
    return e.k + (e.pre && e.pre.length ? ':' + e.pre.join('') : '');
  }

  function validate(registry, opts) {
    opts = opts || {};
    const maxUnknown = typeof opts.maxUnknown === 'number' ? opts.maxUnknown : MAX_UNKNOWN;
    const problems = [];
    let checked = 0;
    const check = (cond, msg) => { checked++; if (!cond) problems.push(msg); return !!cond; };
    if (!registry || typeof registry !== 'object') return { ok: false, problems: ['registry is not an object'], checked: 1 };
    // fetchBundle stopped at maxFragments: the serializer tables of the missing fragments are absent, and the
    // SPEC 3.3 layouts below cannot notice (they all live in early fragments) - never activate such a registry.
    check(!opts.truncated, 'bundle download was truncated at ' + (opts.fragments != null ? opts.fragments : '?') + ' fragments: the registry misses deferred types');
    const types = registry.types, stats = registry.stats || {};
    if (!check(types && typeof types === 'object' && !Array.isArray(types), 'types is not an object')) return { ok: false, problems, checked };
    const keys = Object.keys(types);
    check(keys.length > 500, 'only ' + keys.length + ' types (expected > 500)');
    check(HEX32.test(String(registry.permutation)), 'permutation is not a 32-hex strong name: ' + registry.permutation);
    check(HEX32.test(String(registry.policyHash)), 'policyHash is not a 32-hex policy hash: ' + registry.policyHash);
    check(registry.proPolicyHash == null || HEX32.test(String(registry.proPolicyHash)), 'proPolicyHash is malformed: ' + registry.proPolicyHash);
    check(/^\d{4}-\d{2}-\d{2}T/.test(String(registry.generatedAt)), 'generatedAt is not an ISO timestamp: ' + registry.generatedAt);
    // stats.unknown and the entries agree, and the count is small
    let unknownCount = 0, malformed = 0;
    keys.forEach((k) => {
      const e = types[k];
      if (!e || typeof e !== 'object' || typeof e.k !== 'string') malformed++;
      else if (e.k === 'unknown') unknownCount++;
    });
    check(malformed === 0, malformed + ' malformed type entries');
    check(typeof stats.unknown === 'number' && stats.unknown === unknownCount, 'stats.unknown (' + stats.unknown + ') does not match the ' + unknownCount + ' unknown entries');
    check(unknownCount <= maxUnknown, unknownCount + ' unknown types (max ' + maxUnknown + '): ' + keys.filter((k) => types[k] && types[k].k === 'unknown').slice(0, 5).join(', '));
    check(typeof stats.types === 'number' && stats.types === keys.length, 'stats.types (' + stats.types + ') does not match ' + keys.length + ' entries');
    // SPEC 3.3 layouts, resolved by base name like CMA.gwt.sig(). Checked BEFORE the reader / writer kinds:
    // problems[0] is what the store shows the user, and the short writer kind 'h' rests on a single ser/deser
    // pair (Day's; java.lang.Short's is length-mismatched), so a changed Day would otherwise surface as the
    // symptom 'no writer method for kind h' instead of the cause 'Day layout ... (expected bbh)'.
    EXPECTED_LAYOUTS.forEach((x) => {
      const prefix = x.base + '/';
      const matches = keys.filter((k) => k.startsWith(prefix));
      if (!matches.length) { check(x.required === false, x.base + ' is missing from the registry'); return; }
      check(matches.length === 1, x.base + ' is ambiguous: ' + matches.join(', '));
      const e = types[matches[0]];
      if (!e || typeof e !== 'object') { check(false, matches[0] + ' is not an entry'); return; }
      if (x.layout === 'USER') {
        const f = e.k === 'class' && Array.isArray(e.f) ? e.f : [];
        check(f.length === 42 && f[19] === 'i' && f[33] === 's', matches[0] + ' layout ' + layoutStr(e) + ' (expected 42 fields with idx 19 int and idx 33 string)');
      } else {
        check(layoutStr(e) === x.layout, matches[0] + ' layout ' + layoutStr(e) + ' (expected ' + x.layout + ')');
      }
      if (x.base === 'com.cronometer.shared.entries.changes.AddEntryChange') check(e.from === 'ser', matches[0] + ' should be a serializer-only layout (from:"ser")');
    });
    // reader / writer method maps cover every kind we read or write
    const rk = new Set(Object.values(registry.readerMethods || {})), wk = new Set(Object.values(registry.writerMethods || {}));
    REQUIRED_KINDS.forEach((k) => {
      check(rk.has(k), 'no reader method for kind ' + k);
      check(wk.has(k), 'no writer method for kind ' + k);
    });
    check(registry.readerHelpers && !!registry.readerHelpers.readObject, 'readObject implementation not recorded');
    // service methods
    const sm = Array.isArray(registry.serviceMethods) ? registry.serviceMethods : [];
    REQUIRED_METHODS.forEach((m) => check(sm.indexOf(m) >= 0, 'CronometerService method ' + m + ' not found'));
    check(sm.length > 150, 'only ' + sm.length + ' CronometerService methods (expected > 150)');
    return { ok: problems.length === 0, problems, checked };
  }

  // ------------------------------------------------------------------------------------------------
  // 7. fetchBundle()
  // ------------------------------------------------------------------------------------------------
  /** SPEC 0: on an https page the module base must be the page's own origin. `loc` defaults to location. */
  function sameOriginCheck(moduleBase, loc) {
    loc = loc || (typeof location !== 'undefined' ? location : null);
    let u;
    try { u = new URL(moduleBase); } catch (e) { throw new Error('registry-builder: moduleBase is not an absolute URL: ' + moduleBase); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('registry-builder: moduleBase must be http(s): ' + moduleBase);
    if (loc && loc.protocol === 'https:' && u.origin !== loc.origin) throw new Error('registry-builder: moduleBase origin ' + u.origin + ' differs from the page origin ' + loc.origin);
    return u.origin;
  }

  /** tools/fetch_bundle.py concat(): plain concatenation; a newline only after a part that lacks one. */
  function concatParts(parts) {
    let out = '';
    for (let i = 0; i < parts.length; i++) { out += parts[i]; if (!parts[i].endsWith('\n')) out += '\n'; }
    return out;
  }

  // tools/fetch_bundle.py fetch(): these statuses mean "no such fragment" (the end of the list); everything
  // else is a failure that is retried and then raised. 200 fragments like the offline tool (14 in this build).
  const END_OF_LIST_STATUS = { 403: true, 404: true, 410: true };
  const DEFAULT_MAX_FRAGMENTS = 200;
  const DEFAULT_TIMEOUT_MS = 60000;      // per file; the leftovers fragment is 3.3 MB (fetch_bundle.py: 60 s)
  const DEFAULT_RETRIES = 3;             // attempts per file (fetch_bundle.py: retries=3)
  const DEFAULT_RETRY_DELAY_MS = 1500;   // pause before attempt 2, twice that before attempt 3 (1.5 s * attempt)
  function sleep(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }

  async function fetchBundle(moduleBase, permutation, opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(window) : null);
    if (typeof fetchImpl !== 'function') throw new Error('registry-builder: no fetch implementation');
    const maxFragments = typeof opts.maxFragments === 'number' ? opts.maxFragments : DEFAULT_MAX_FRAGMENTS;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const retries = typeof opts.retries === 'number' && opts.retries >= 1 ? Math.floor(opts.retries) : DEFAULT_RETRIES;
    const retryDelayMs = typeof opts.retryDelayMs === 'number' && opts.retryDelayMs >= 0 ? opts.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const perm = String(permutation || '').toUpperCase();
    if (!HEX32.test(perm)) throw new Error('registry-builder: invalid permutation ' + permutation);
    let base = String(moduleBase || '');
    if (!base.endsWith('/')) base += '/';
    sameOriginCheck(base);

    /** One GET with a timeout -> {status:200, text} | {status: 403|404|410, text:''} (the end of the list);
     *  any other outcome (5xx, another status, a transport error, the timeout) is retried `retries` times
     *  with a growing pause (fetch_bundle.py: 1.5 s * attempt) and then thrown with the URL and the status. */
    async function getText(url) {
      let last = null;
      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs * attempt);
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
        let res;
        try {
          // mode 'same-origin': should cronometer.com ever answer a bundle URL with a redirect to another host,
          // the fetch fails BEFORE the redirected request is made (SPEC 0: never contact any other host) -
          // cors mode would follow it first. A same-origin redirect is still followed.
          res = await fetchImpl(url, { method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'follow', signal: ac ? ac.signal : undefined });
        } catch (e) {
          if (timer) clearTimeout(timer);
          last = e && e.name === 'AbortError'
            ? new Error('registry-builder: ' + url + ' timed out after ' + timeoutMs + ' ms')
            : new Error('registry-builder: fetch failed for ' + url + ': ' + ((e && e.message) || e));
          continue;
        }
        try {
          const status = res.status;
          if (status === 200) return { status, text: await res.text() };
          if (END_OF_LIST_STATUS[status]) return { status, text: '' };
          last = new Error('registry-builder: ' + url + ' answered HTTP ' + status);
        } catch (e) {
          last = new Error('registry-builder: could not read ' + url + ': ' + ((e && e.message) || e));
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw Object.assign(last || new Error('registry-builder: ' + url + ' failed'), { attempts: retries });
    }

    const parts = [];
    const mainUrl = base + perm + '.cache.js';
    const main = await getText(mainUrl);
    if (main.status !== 200) throw new Error('registry-builder: ' + mainUrl + ' answered HTTP ' + main.status);
    if (!main.text) throw new Error('registry-builder: ' + mainUrl + ' answered an empty body');
    parts.push(main.text);
    if (onProgress) onProgress({ phase: 'main', n: 0, status: main.status, chars: main.text.length });
    let truncated = false;
    for (let n = 1; ; n++) {
      if (n > maxFragments) { truncated = true; break; }   // fetch_bundle.py warns 'stopped at --max-fragments'; validate() refuses it
      const url = base + 'deferredjs/' + perm + '/' + n + '.cache.js';
      const r = await getText(url);                        // throws on anything but 200 / end-of-list
      if (onProgress) onProgress({ phase: 'fragment', n, status: r.status, chars: r.text.length });
      if (r.status !== 200) break;   // 403/404/410: the end of the list (fragment 0 never exists)
      parts.push(r.text);
    }
    const text = concatParts(parts);
    // `bytes` = the concatenated text's length in characters: GWT emits pure ASCII (non-ASCII as \uXXXX escapes),
    // so it is the byte count too - without materialising a second 5.7 MB copy through TextEncoder for a number
    // that only reaches the log and the attempt record.
    return { text, fragments: parts.length - 1, bytes: text.length, permutation: perm, truncated };
  }

  CMA.registryBuilder = {
    build, validate, fetchBundle, sameOriginCheck, concatParts, layoutStr,
    EXPECTED_LAYOUTS, MAX_UNKNOWN, REQUIRED_KINDS, REQUIRED_METHODS,
    DEFAULT_YIELD_EVERY, DEFAULT_MAX_FRAGMENTS, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES, DEFAULT_RETRY_DELAY_MS, END_OF_LIST_STATUS,
    // internals exposed for tests / diagnostics
    _internals: { Bundle, ReaderInfo, WriterInfo, Classifier, loadTable, findPolicies, findServiceMethods, splitStatements, splitFor, jsUnescape, gwtCompare, hasConditionalRead },
  };
})();
