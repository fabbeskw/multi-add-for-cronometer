/* Tiny browser test runner for headless Chrome (no node).
 * Usage in a test page:
 *   <script src="lib.js"></script> ... <script>
 *   CMA.test.describe('parser', () => {
 *     CMA.test.it('parses grams', () => { CMA.test.eq(1, 1); });
 *     CMA.test.it('async ok', async () => { await something(); });
 *   });
 *   CMA.test.run();   // writes into <pre id="results">, sets document.title, and window.__testDone = true
 *   </script>
 * The page must contain <pre id="results"></pre>. Output ends with "ALL TESTS PASSED" or "FAILED: n".
 */
window.CMA = window.CMA || {};
(function () {
  const suites = [];
  let current = null;

  function describe(name, fn) {
    const suite = { name, tests: [] };
    suites.push(suite);
    const prev = current;
    current = suite;
    try { fn(); } finally { current = prev; }
  }
  function it(name, fn) {
    if (!current) throw new Error('it() outside describe()');
    current.tests.push({ name, fn });
  }
  class AssertionError extends Error { constructor(msg) { super(msg); this.name = 'AssertionError'; } }
  function fmt(v) {
    try {
      if (typeof v === 'bigint') return v.toString() + 'n';
      if (v instanceof Map) return 'Map(' + JSON.stringify([...v.entries()]) + ')';
      return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() + 'n' : x);
    } catch (e) { return String(v); }
  }
  function ok(cond, msg) { if (!cond) throw new AssertionError(msg || 'expected truthy'); }
  function eq(actual, expected, msg) {
    if (actual !== expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {
      throw new AssertionError((msg ? msg + ': ' : '') + 'expected ' + fmt(expected) + ' but got ' + fmt(actual));
    }
  }
  function deepEq(actual, expected, msg) {
    const a = fmt(actual), b = fmt(expected);
    if (a !== b) throw new AssertionError((msg ? msg + ': ' : '') + 'expected ' + b + '\n   got      ' + a);
  }
  function approx(actual, expected, eps, msg) {
    if (Math.abs(actual - expected) > (eps == null ? 1e-9 : eps)) {
      throw new AssertionError((msg ? msg + ': ' : '') + 'expected ~' + expected + ' but got ' + actual);
    }
  }
  async function throws(fn, re, msg) {
    let threw = null;
    try { await fn(); } catch (e) { threw = e; }
    if (!threw) throw new AssertionError((msg ? msg + ': ' : '') + 'expected an exception');
    if (re && !re.test(String(threw && (threw.message || threw)))) {
      throw new AssertionError((msg ? msg + ': ' : '') + 'exception ' + fmt(String(threw.message || threw)) + ' does not match ' + re);
    }
    return threw;
  }
  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout after ' + ms + ' ms')), ms);
      Promise.resolve().then(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }
  async function run(opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 15000;
    const out = [];
    let passed = 0, failed = 0;
    for (const suite of suites) {
      out.push('# ' + suite.name);
      for (const t of suite.tests) {
        try {
          await withTimeout(() => t.fn(), timeoutMs);
          passed++;
          out.push('  ok   ' + t.name);
        } catch (e) {
          failed++;
          out.push('  FAIL ' + t.name + '\n       ' + String(e && (e.stack || e.message || e)).split('\n').join('\n       '));
        }
      }
    }
    out.push('');
    out.push(failed === 0 ? 'ALL TESTS PASSED' : 'FAILED: ' + failed);
    out.push('(' + passed + ' passed, ' + failed + ' failed)');
    const text = out.join('\n');
    const pre = document.getElementById('results');
    if (pre) pre.textContent = text;
    document.title = failed === 0 ? 'PASS' : 'FAIL ' + failed;
    window.__testDone = true;
    window.__testFailed = failed;
    if (typeof console !== 'undefined') console.log(text);
    return { passed, failed, text };
  }
  window.CMA.test = { describe, it, ok, eq, deepEq, approx, throws, run, AssertionError };
})();
