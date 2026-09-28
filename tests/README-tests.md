# Tests

Everything runs in **headless Chrome**; there is no node, no npm and no bundler. A test page is a plain HTML
file that loads `tests/lib.js` plus the `src/` files it exercises, writes its results into `<pre id="results">`
and ends with the literal line `ALL TESTS PASSED` (or `FAILED: n`).

## Running

```
bash tests/run.sh                    # every tests/*.html page except mock-*.html
bash tests/run.sh unit.html          # one page
bash tests/run.sh gwt.html capture.html
CHROME="D:/Chromium/chrome.exe" bash tests/run.sh    # non-standard Chrome location
```

Use Git Bash on Windows. The runner looks for Chrome in the usual places (`C:/Program Files/Google/Chrome`,
`C:/Program Files (x86)/...`, `%LOCALAPPDATA%`, macOS `/Applications`, `google-chrome` / `chromium` on PATH) and
exits with status 2 when it finds none, 1 when any page fails, 0 when all pass.

What `run.sh` does per page:

```
chrome --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
       --virtual-time-budget=90000 --run-all-compositor-stages-before-draw --dump-dom file:///.../tests/<page>.html
```

* `--virtual-time-budget=90000` fast-forwards timers: a `setTimeout(…, 5000)` costs nothing, so tests may use
  realistic delays. The budget is 90 s of *virtual* time per page (an empty `#results` block means a page ran
  out of it — the runner then prints the raw DOM); `lib.js` additionally applies a per-test
  timeout (default 15 s, `CMA.test.run({timeoutMs})`).
* `--allow-file-access-from-files` lets a page XHR sibling files (`tests/load-all.html` reads
  `../manifest.json`; `tests/capture.html` and `tests/hook.html` fire real `XMLHttpRequest`s through the hook).
* `--dump-dom` prints the final DOM; the runner extracts the `#results` block and passes the page only when a
  whole line inside it reads `ALL TESTS PASSED` (never the page source: a script that mentions the literal, like
  registry-builder.html's `?realtime=1` branch, must not make its page unfailable). On failure it prints the
  block. `(no results element; page failed to load or threw before running)` means a script threw before
  `CMA.test.run()` was reached — open the page in a normal Chrome window and look at the console.

Python checks that belong to the same green bar:

```
python tools/check_manifest.py                  # manifest.json: JSON, files/icons exist, load order = tests/load-all.html
python tools/gen_registry.py tools/bundle/all.js   # must print "unknown : 0" and rewrite src/lib/gwt-registry.js byte-identically
python tools/build_zip.py                       # store package: allow-list, manifest references, UTF-8 / noncharacters, CRC -> PACKAGE OK
python tools/smoke_extension.py --self-test     # installs the tree into headless Chrome via DevTools Extensions.loadUnpacked, opens popup.html
python tools/screenshots.py --dry-run --headless   # the store-screenshot tool against tests/mock-cronometer.html (see Store screenshots) -> SCREENSHOTS PASS
```

Scratch pages are fine while debugging: `tests/_*.html` and `tools/_*.py` are gitignored, and the runner would
otherwise pick a stray `tests/_probe.html` up as a test page (it runs every `tests/*.html` except `mock-*`).

## Store screenshots

`python tools/screenshots.py` renders the Chrome Web Store screenshots (1280 x 800) into `store-assets/`; the PNGs
are git-ignored (a live run captures a real diary; the account owner reviews them before upload), only the README
and `manifest.json` are committed. The live run needs a human login, writes to the real diary (and undoes it), and
is documented in `store-assets/README.md`: never run it as part of testing. Its dry run is part of the green bar
above and ships no `tests/` page:

```
python tools/screenshots.py --dry-run --headless
```

opens `tests/mock-cronometer.html` in headless Chrome with the extension installed through `Extensions.loadUnpacked`
(the same DevTools-pipe client as `tools/smoke_extension.py`, `tools/cdp.py`), creates an isolated world named after
the extension (`Page.createIsolatedWorld`; the extension does not inject on `file:` pages), evaluates the
ISOLATED-world scripts of `manifest.json` into it in manifest order, mounts the panel and runs the real scenario
with the UI-automation engine against the mock dialog: Input view (the sample list typed, Dinner selected) -> Find
foods -> Add all -> the diary with the four new rows -> Diagnostics. It captures
`store-assets/dry-run/01-input.png` ... `05-diagnostics.png` and `manifest.json`, checks the mock recorded four adds,
checks the manifest lists the blur of a synthetic account (name / e-mail text in 3 elements with the password fields
left alone, the account id in the Diagnostics dump), and verifies each PNG (IHDR 1280 x 800, 24-bit RGB, decoded
rows not blank); the verdict line is `SCREENSHOTS PASS` / `SCREENSHOTS FAIL` and the exit status is 0 only on PASS. Judge that line, not the pictures: the dry-run pictures
show the mock page, with the Input view's "No Cronometer app on this page" banner, and are not store material.

## Pages

| Page | Loads | Covers |
|---|---|---|
| `smoke.html` | lib.js | the runner itself (sync + async test) |
| `unit.html` | parse, units, plan, engine-rpc (+ a fake `CMA.rpc`) | SPEC §5 parser table, §5.3 measure matching incl. the no-unit default-measure rule (the hit measure, the f[0] default, a plain-gram default → needs-choice with a suggested count measure and no quantity, gram/ml-only foods 100 g / N g with notes, `isGramOrMlUnit`, `suggestMeasure`, `defaultMeasure` order, and the same rows through `plan.build`: an unusable hit measure asks for a unit, f[0] resolves it, `repick` + `servingFor` after the suggestion), §6 plan building/positions/rechoose/repick/reposition, §6.4 engine-rpc retry/throttle/session/cancel/undo/lastBatch, §6.5 refreshDiary |
| `gwt.html` | gwt-registry, gwt-stream, fixtures | §3: registry layouts, longs, escaping, Writer/Reader round trips with back-references, byte-equal request templates, captured responses, parseRequest/simpleParams |
| `registry-builder.html` | gwt-registry, registry-builder (+ `tools/bundle/all.js` read over XHR, `fetch` stubbed) | §3.5 builder: `fetchBundle` against a stubbed fetch (main + fragments in wire order, 403/404/410 end the list, a 5xx / 429 / transport error / timeout is retried 3× then thrown — never the end of the list, a transient failure recovers, fragment cap 200 → `truncated`, invalid permutation / foreign origin refused, `concatParts` = fetch_bundle.py), the `validate()` bar (the generated registry passes; a wrong Serving layout, too many unknowns, a missing / ambiguous required type, a truncated download fail; a CRC change alone passes), and the port's parity: the registry built from `tools/bundle/all.js` is deep-equal (same keys, same order, same JSON) to `src/lib/gwt-registry.js`, warnings match `gen_registry.py`'s stderr, deterministic, `$strongName` wins over the caller's permutation, a build with yields arms no timer; parser robustness against mutated copies of the real bundle: every reader helper renamed to a `$`-initial name (still 0 unknown), a read inside a ternary → unknown, hoisted / `|0` enum instantiates → enum; review round 5: `mode: 'same-origin'` on every fetch, validate() names the changed layout before the writer-kind symptom, a 100 000-char base64 run leaves the registry unchanged (timed only under a real clock — `?realtime=1` prints the constants pass), reads inside else / catch / finally → unknown, inlined `Number(a.b[--a.a])` / `!!a.b[--a.a]` → d / z, a non-ASCII letter glued to the reader variable → unknown. Needs `tools/bundle/all.js` (gitignored: run `python tools/fetch_bundle.py` first) — without it the parity tests are skipped with one `SKIPPED` line. Open `registry-builder.html?realtime=1` in a normal browser (no virtual time) for wall-clock build times (55–65 ms for the 5.7 MB bundle) |
| `registry-store.html` | gwt-registry, gwt-stream, registry-store (with a fake `chrome.storage.local` and a fake `CMA.registryBuilder` installed before it), rpc, capture, fixtures | §3.5 store: `init()` (empty / stored / late storage / 500 ms bound / `runtime.lastError` → `error`), `activate()` swaps `CMA.registry`, reloads the gwt caches (`CMA.gwt.SIG.SERVING`) and emits `registry`, malformed / other-version / other-schema / validate-failing records ignored and removed, the bundled registry preferred for its own build, `forget()` (+ the remove-failure fallback); `rebuild()` happy path (stored record with its stamp, progress phases, `bundle: 'live:<perm>'`), validate / fetch / build failures keep the registry, builder warnings logged as capture kind `registry` (5 lines + a count) and counted, single-flight + `inFlight()`, rate limit + `force`, the persisted attempt (`cmaRegistryAttempt`) across a store reload, `truncated` handed to validate, refusals; capture integration: the `X-GWT-Permutation` header activates the stored registry before the same message is decoded, one automatic rebuild per permutation, module base arriving later, `reset()` re-arms, the DOM-probe path, a decoder adopted late re-reads the replayed authenticate reply (groups, userId, nonce only when unknown), no nonce anywhere; review round 5: the single flight is released before the final `registry-progress` event, an unfinished (ok null) or unsaved (ok true, persisted false) persisted attempt does not rate-limit, `status().lastRefusal`, a hung `chrome.storage.set` is bounded (5 s), another tab's record arrives through `chrome.storage.onChanged` (own writes, removals, foreign records and stale instances ignored), the validation error names the problem count |
| `capture.html` | gwt-registry, gwt-stream, registry-store, rpc, capture, fixtures, hook-main, content | §2.3 session capture from hooked traffic (incl. `reauthenticate` nonce rotation), DOM fallbacks, §4 rpc against a stubbed `fetch` (decode `.applied`, raw-text `//EX` classification, app-identical search URL, prebuilt-Serving validation), real XHR relay through the hook's port, §3.5 runtime registry hooks (the `X-GWT-Permutation` header activates the store synchronously before the message is decoded and records `registrySource`; the `registry` event re-evaluates `registryMismatch`) |
| `hook.html` | hook-main, gwt-registry, gwt-stream, rpc, capture, then content.js loaded late | §2.2 early-traffic buffer + MessageChannel transport: nothing on the window before the ping, replay over the port in seq order, live traffic over the port, port-less ping answered on the window, de-duplication in content.js, foreign-origin `/api/v3/` URLs not relayed, REST bodies dropped |
| `hook-buffer.html` | hook-main only | §2.2 buffer overflow: 106 requests before the first ping are only buffered and the replay keeps the `authenticate` exchange (SPEC 2.1) |
| `engine-ui.html` | dom, engine-ui, mock-cronometer.js | §7 UI automation against the mock dialog: measure-before-amount, fast interstitial, abort rules, Escape×2, toggle-text mismatch (measure fails / group warns), per-row warnings, custom meal defaults, diary FlexTable visibility, keyup-Escape close, `TBe` flip, forced SEARCH |
| `panel.html` | parse, units, panel.css, panel (+ stubbed capture/plan/engines/chrome.storage/registryStore) | §8 panel: mount/toggle (closed shadow root), MULTI button re-insertion, readiness banner, engine select re-render, preview edits (needs-choice suggestion + Use button, a no-unit needs-choice row whose **Use** button and hand-picked measure keep the typed number as a count — SPEC §5.3 b, quantity conversion / reset for recipe counts, recipe grams), add all, added-with-notes rows, unverified-refresh hint, decode stop, undo, diagnostics redaction, settings + account-gated input persistence, UI refresh signal, §3.5 decoder banner states (rebuilding with a progress line — deploy wording only on a mismatch / rebuilt, incl. "not saved to chrome.storage" / failed: automatic vs manual, a persisted earlier failure) and the Diagnostics decoder block whose **Rebuild decoder** button calls the store with `force:true` (disabled while the live build or the builder is unknown), Find foods and Add all waiting for the store's `inFlight()`, Add all disabled and refused for the RPC engine while the decoder mismatches (the UI engine is not gated); review round 5: the REAL `registry-store.js` loaded beside a fake builder drives the banner and the Diagnostics block to their final state on its own last event (no hand-made event), a refused automatic attempt is explained ("was skipped: …"), Settings → *Forget last batch* |
| `load-all.html` | **every script in `manifest.json` order** + fixtures | namespaces exist (incl. `registryBuilder` / `registryStore`), no load-time exception, hook answers ping, `CMA.registryStore.init()` is logged before the hook's pong (§3.5 ordering), content.js bootstraps and mounts the panel, cross-module contracts (registry ↔ SIG ↔ plan ↔ rpc ↔ Writer byte-equality) |
| `mock-cronometer.html` | dom, engine-ui, mock-cronometer.js | **manual playground**, skipped by the runner: open it in a browser and drive the fake dialog by hand |

`tests/fixtures.js` holds the captured GWT-RPC strings from SPEC §9 and builders for synthetic value graphs
(`CMA.fixtures.user/food/dayInfo/serving…` and `authenticateResponse/foodResponse/…`). Pages that need real wire
strings load it after `gwt-stream.js`.

## Writing a test page

```html
<!doctype html><html><head><meta charset="utf-8"><title>my-page</title></head><body>
<pre id="results"></pre>
<script src="lib.js"></script>
<script src="../src/lib/parse.js"></script>          <!-- only what the page tests, in manifest order -->
<script>
(function () {
  const { describe, it, ok, eq, deepEq, approx, throws } = CMA.test;
  describe('my feature', () => {
    it('does the thing', () => { eq(CMA.parse.lines('2 eggs')[0].qty, 2); });
    it('async is fine', async () => { await new Promise(r => setTimeout(r, 500)); ok(true); });
    it('expects an exception', async () => { await throws(() => CMA.gwt.decodeLongBig('!'), /invalid/); });
  });
  CMA.test.run({ timeoutMs: 8000 });   // per-test timeout; writes #results, sets document.title to PASS / FAIL n
})();
</script></body></html>
```

`CMA.test` API (`tests/lib.js`): `describe(name, fn)`, `it(name, fn|asyncFn)`, `ok(cond, msg)`,
`eq(actual, expected, msg)` (strict, NaN-aware), `deepEq(a, b, msg)` (JSON-based; Maps and BigInts print
readably), `approx(a, b, eps, msg)`, `throws(fn, regex?, msg)` (returns the error), `run({timeoutMs})`.

Rules of thumb:

* Never load `src/` files as modules and never depend on the network: stub `window.fetch` (see `capture.html`),
  drive the hook with real `XMLHttpRequest`s to `/cronometer/app` (they fail with status 0 on `file:` but are relayed),
  or use the mock dialog.
* A page that installs a stub on `window.chrome` must restore it: `window.chrome` exists on a plain page and is not
  deletable (`panel.html` shows the pattern).
* Keep secrets out of results: the tests assert that the nonce never appears in logs, snapshots or diagnostics —
  keep doing that for any new state.
* New page = new row in the table above and, if it loads a different script set, keep the order of `manifest.json`.
* `tests/registry-builder.html` reads `tools/bundle/all.js` (5.7 MB, gitignored) with a synchronous XHR; on a fresh clone run
  `python tools/fetch_bundle.py` first or accept the `SKIPPED` parity line. Under `--virtual-time-budget` the page clock is
  frozen while a task runs, so its `build time < 8000 ms` assertion is only meaningful in a normal browser window.

## Manual test against the live site

Load the folder unpacked (`chrome://extensions` → Developer mode → Load unpacked), open
`https://cronometer.com/#diary`, reload the tab, press **Alt+Shift+M**. The **Diagnostics** tab shows what the
capture learned (hooked, userId, permutation, policy, groups + source, date + source) and the last log lines; nothing
in it is the session token. Its decoder block should say `bundled` (or `runtime` after a Cronometer deploy) and its
**Rebuild decoder** button must download the live bundle and end with *Decoder rebuilt: … types* within seconds; the
Input view's decoder banner reflects the same state. Try a one-line batch with the RPC engine first, then the
UI-automation engine.
