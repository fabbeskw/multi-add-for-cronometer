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
python tools/gen_tdee.py --check                # src/tdee/adaptive-tdee.js + tests/tdee-sim.js regenerate byte-identically from vendor/adaptive-tdee/
python tools/gen_registry.py tools/bundle/all.js   # must print "unknown : 0" and rewrite src/lib/gwt-registry.js byte-identically
python tools/build_zip.py                       # store package: allow-list, manifest references, UTF-8 / noncharacters, CRC -> PACKAGE OK
python tools/smoke_extension.py --self-test     # installs the tree into headless Chrome via DevTools Extensions.loadUnpacked, opens popup.html
python tools/screenshots.py --dry-run --headless   # the store-screenshot tool against tests/mock-cronometer.html, synthetic data only (see Store screenshots) -> SCREENSHOTS PASS
python tools/make_graphics.py --verify          # icons/*.png + store-assets/promo/*.png: sizes, colour types, transparent corners, 16 px padding (no Chrome) -> GRAPHICS OK
```

Scratch pages are fine while debugging: `tests/_*.html` and `tools/_*.py` are gitignored, and the runner would
otherwise pick a stray `tests/_probe.html` up as a test page (it runs every `tests/*.html` except `mock-*`).

## Store screenshots

`python tools/screenshots.py` renders the five Chrome Web Store screenshots (1280 x 800: `01-input`, `02-preview`,
`03-diary`, `04-tdee-overview`, `05-tdee-checkin`; `--extra` adds `extra-results` and `extra-diagnostics`) into
`store-assets/`; the PNGs are git-ignored and the account owner reviews them before upload, only the README and
`manifest.json` are committed. The set is privacy-safe by construction: the multi-add shots are taken on an EMPTY
future diary day the tool finds first (today + 7 onwards, checked for entry rows; the run stops before adding anything
when none is empty), and the two TDEE shots show SYNTHETIC demo data (the tool swaps `CMA.tdeeData` for an in-memory
stub of the SPEC §12.3 contract and restores the real layer, whose `enable()` / `sync()` it never calls;
`manifest.json` records `"data": "synthetic demo"`). The live run needs the owner's login, writes four entries to
that empty day of the real diary and undoes them (it must report `Undo: 4 removed, 0 failed`), and is documented in
`store-assets/README.md`: **never run it as part of testing** (no test page or check may call `tools/screenshots.py`
without `--dry-run`). Its dry run is part of the green bar above and ships no `tests/` page:

```
python tools/screenshots.py --dry-run --headless
```

opens `tests/mock-cronometer.html` in headless Chrome with the extension installed through `Extensions.loadUnpacked`
(the same DevTools-pipe client as `tools/smoke_extension.py`, `tools/cdp.py`), creates an isolated world named after
the extension (`Page.createIsolatedWorld`; the extension does not inject on `file:` pages), evaluates the
ISOLATED-world scripts of `manifest.json` into it in manifest order, mounts the panel and switches on the mock's day
navigation (`mock.useDays`, see `tests/mock-cronometer.js`) with synthetic seeded entries on the start day and on
day +7. Then it runs the real scenario with the UI-automation engine: the empty-day search (it must skip +7 and settle
on +8; after each arrow click the tool hands the mock's day to `CMA.capture.state.diaryDate`, what the capture takes
from the app's `getDayInfo` live), the Input view (the sample list typed, Dinner selected, the panel's date = the
empty day) -> Find foods (the plan's date = the empty day) -> Add all -> the diary with the four new rows -> the TDEE
tab over the synthetic stub -> the check-in dialog (cancelled) -> the real data layer restored -> the diary moved
back to the start day. It captures `store-assets/dry-run/01-input.png` ... `05-tdee-checkin.png`, both extras and
`manifest.json` (removing its own earlier files first), checks the mock recorded four adds, all on the empty day,
that the capture guard refuses the day once a synthetic row this run did not add is slipped into the mock's diary
(every capture is refused while the day shows more entry rows than the run added) and again when one added row is
hidden and a synthetic row shown instead (right count, one row matching none of the added foods), that the undo state
machine passes its offline cases (`undo_probe_cases`: never started, Undo this batch, a stored batch of another day,
batches older than Add all, a batch of the wrong size), that a synthetic Water card and Daily Target Editor header
are blurred in every shot, that the start day shows its
seeded entry again, that the real `CMA.tdeeData` is back and its guarded `enable()` /
`sync()` were called 0 times, that the manifest marks shots 4 and 5 (only) `"synthetic demo"`, records the empty day
on every shot and lists the blur of a synthetic account (name / e-mail text in 3 elements with the password fields
left alone, the account id in the Diagnostics dump), and verifies each PNG (IHDR 1280 x 800, 24-bit RGB, decoded
rows not blank); the verdict line is `SCREENSHOTS PASS` / `SCREENSHOTS FAIL` and the exit status is 0 only on PASS
(about 40 s). Judge that line, not the pictures: the dry-run pictures show the mock page, with the Input view's "No
Cronometer app on this page" banner and the TDEE sync box's "session is not captured" line, and are not store
material.

## Pages

| Page | Loads | Covers |
|---|---|---|
| `smoke.html` | lib.js | the runner itself (sync + async test) |
| `unit.html` | parse, units, plan, engine-rpc (+ a fake `CMA.rpc`) | SPEC §5 parser table, the 0.3.2 search-scope flags (`/custom`, `/c`, `/all` at the start or end in any order with `@group`, kept quantities, split lines and a segment's own flag, header scope incl. `Dinner /custom:` / `/custom ## Dinner` and the scope-only `## /custom` / `/custom` lines, a flag inside a name failing the line, and what is NOT a flag: fractions, slashes in names, glued forms, `//`, `@custom`), the 0.3.2 calorie amounts (`cal` / `Cal` / `kcal` / `calories` / `kJ` / `kilojoules` glued or spaced, leading / trailing / mid-line, multipliers, split lines, decimal comma, fractions, `kilo calories` / `k cal` / `300-cal`, the thousands comma `1,250 kJ` and the refused spaced `1 250 kJ`; the negatives `calzone 2`, `2 calzones`, `calamari 100g`, `cal`, `vitamin c 500mg`, `2 kilo potatoes`, `2-pack almonds`; `0 cal` invalid), `units.pickEnergy` against the table (579 kcal/100 g → 51.8135 g in g / oz / cup, a serving-based recipe, the weightless full recipe, fallbacks from a weightless default, the refusals, kJ, the over-1-kg and under-5-kcal warnings, the typable rule (a quantity the dialog would type as 0 or cut off moves to the next measure or asks for another unit); `pickMeasure` / `convertQuantity` refusing energy units), §5.3 measure matching incl. the no-unit default-measure rule (the hit measure, the f[0] default, a plain-gram default → needs-choice with a suggested count measure and no quantity, gram/ml-only foods 100 g / N g with notes, `isGramOrMlUnit`, `suggestMeasure`, `defaultMeasure` order, and the same rows through `plan.build`: an unusable hit measure asks for a unit, f[0] resolves it, `repick` + `servingFor` after the suggestion), §6 plan building/positions/rechoose/repick/reposition, the custom-only `plan.build` (the setting, per-line override both ways, header flag, scope-only lines, a segment's flag, no flag ever in a query, "no custom food matches" also as the unverified reason, filtering before the maxHits slice; the fake search honours `opts.customOnly`), calorie-amount rows through `plan.build` (the default measure, kJ, split lines, recipes, a meal and missing / zero energy refused, getFood failure and unverified mode as errors, `0.1 cal casserole` asking for another unit, `repick` keeping the target, `rechoose` recomputing, the fake's `energyKcalOf` standing in for the real reader), §6.4 engine-rpc retry/throttle/session/cancel/undo/lastBatch and the `'diary-write'` event after a run / undo (one per batch, the plan date as ISO, no ids; none without a write; a throwing listener never breaks the batch), §6.5 refreshDiary |
| `gwt.html` | gwt-registry, gwt-stream, fixtures | §3: registry layouts (incl. the 0.3.2 NutrientMap / Nutrient / FoodType entries behind `F.FOOD.NUTRIENTS` / `TYPE`), longs, escaping, Writer/Reader round trips with back-references (a Food with a NutrientMap: numeric Map keys, filter and type enums), byte-equal request templates, captured responses, parseRequest/simpleParams |
| `registry-builder.html` | gwt-registry, registry-builder (+ `tools/bundle/all.js` read over XHR, `fetch` stubbed) | §3.5 builder: `fetchBundle` against a stubbed fetch (main + fragments in wire order, 403/404/410 end the list, a 5xx / 429 / transport error / timeout is retried 3× then thrown — never the end of the list, a transient failure recovers, fragment cap 200 → `truncated`, invalid permutation / foreign origin refused, `concatParts` = fetch_bundle.py), the `validate()` bar (the generated registry passes; a wrong Serving layout, too many unknowns, a missing / ambiguous required type, a truncated download fail; a CRC change alone passes), and the port's parity: the registry built from `tools/bundle/all.js` is deep-equal (same keys, same order, same JSON) to `src/lib/gwt-registry.js`, warnings match `gen_registry.py`'s stderr, deterministic, `$strongName` wins over the caller's permutation, a build with yields arms no timer; parser robustness against mutated copies of the real bundle: every reader helper renamed to a `$`-initial name (still 0 unknown), a read inside a ternary → unknown, hoisted / `|0` enum instantiates → enum; review round 5: `mode: 'same-origin'` on every fetch, validate() names the changed layout before the writer-kind symptom, a 100 000-char base64 run leaves the registry unchanged (timed only under a real clock — `?realtime=1` prints the constants pass), reads inside else / catch / finally → unknown, inlined `Number(a.b[--a.a])` / `!!a.b[--a.a]` → d / z, a non-ASCII letter glued to the reader variable → unknown; §12.2 the optional Adaptive TDEE layouts / methods are reported under `validate().optional.tdee` and never fail the core bar. Needs `tools/bundle/all.js` (gitignored: run `python tools/fetch_bundle.py` first) — without it the parity tests are skipped with one `SKIPPED` line. Open `registry-builder.html?realtime=1` in a normal browser (no virtual time) for wall-clock build times (55–65 ms for the 5.7 MB bundle) |
| `registry-store.html` | gwt-registry, gwt-stream, registry-store (with a fake `chrome.storage.local` and a fake `CMA.registryBuilder` installed before it), rpc, capture, fixtures | §3.5 store: `init()` (empty / stored / late storage / 500 ms bound / `runtime.lastError` → `error`), `activate()` swaps `CMA.registry`, reloads the gwt caches (`CMA.gwt.SIG.SERVING`) and emits `registry`, malformed / other-version / other-schema / validate-failing records ignored and removed, the bundled registry preferred for its own build, `forget()` (+ the remove-failure fallback); `rebuild()` happy path (stored record with its stamp, progress phases, `bundle: 'live:<perm>'`), validate / fetch / build failures keep the registry, builder warnings logged as capture kind `registry` (5 lines + a count) and counted, single-flight + `inFlight()`, rate limit + `force`, the persisted attempt (`cmaRegistryAttempt`) across a store reload, `truncated` handed to validate, refusals; capture integration: the `X-GWT-Permutation` header activates the stored registry before the same message is decoded, one automatic rebuild per permutation, module base arriving later, `reset()` re-arms, the DOM-probe path, a decoder adopted late re-reads the replayed authenticate reply (groups, userId, nonce only when unknown), no nonce anywhere; review round 5: the single flight is released before the final `registry-progress` event, an unfinished (ok null) or unsaved (ok true, persisted false) persisted attempt does not rate-limit, `status().lastRefusal`, a hung `chrome.storage.set` is bounded (5 s), another tab's record arrives through `chrome.storage.onChanged` (own writes, removals, foreign records and stale instances ignored), the validation error names the problem count |
| `capture.html` | gwt-registry, gwt-stream, registry-store, rpc, capture, fixtures, hook-main, content | §2.3 session capture from hooked traffic (incl. `reauthenticate` nonce rotation), DOM fallbacks, §4 rpc against a stubbed `fetch` (decode `.applied`, raw-text `//EX` classification, app-identical search URL, prebuilt-Serving validation), real XHR relay through the hook's port, the 0.3.2 custom-only search (default URL unchanged, `selectedTab=CUSTOM`, the defensive source filter keeping a null source, a count-only log note), `rpc.energyKcalOf` over a decoded getFood reply (nutrient 208, never 268; ALL / null / PRIMARY filters, missing, 0, NaN, not a Food) and `rpc.foodTypeOf`, §3.5 runtime registry hooks (the `X-GWT-Permutation` header activates the store synchronously before the message is decoded and records `registrySource`; the `registry` event re-evaluates `registryMismatch`), §12.2 the Adaptive TDEE reads' userId index and a captured `setUserPreference` carrying `pref: {key, value}` (the value never logged) |
| `hook.html` | hook-main, gwt-registry, gwt-stream, rpc, capture, then content.js loaded late | §2.2 early-traffic buffer + MessageChannel transport: nothing on the window before the ping, replay over the port in seq order, live traffic over the port, port-less ping answered on the window, de-duplication in content.js, foreign-origin `/api/v3/` URLs not relayed, REST bodies dropped |
| `hook-buffer.html` | hook-main only | §2.2 buffer overflow: 106 requests before the first ping are only buffered and the replay keeps the `authenticate` exchange (SPEC 2.1) |
| `engine-ui.html` | dom, engine-ui, mock-cronometer.js | §7 UI automation against the mock dialog: measure-before-amount, fast interstitial, abort rules, Escape×2, toggle-text mismatch (measure fails / group warns), per-row warnings, custom meal defaults, diary FlexTable visibility, keyup-Escape close, `TBe` flip, forced SEARCH, custom-only rows (a Custom Food row over same-named database rows via `opts.dataset`, no custom row → the row fails, a single database row never accepted, the search tabs never touched), a calorie-amount row added with its computed measure and quantity, an amount that is 0 at 3 decimals never typed (the row fails) |
| `panel.html` | parse, units, plan (kept as `window.__realPlan`), panel.css, panel (+ stubbed capture/plan/engines/chrome.storage/registryStore) | §8 panel: mount/toggle (closed shadow root), MULTI button re-insertion, readiness banner, engine select re-render, preview edits (needs-choice suggestion + Use button, a no-unit needs-choice row whose **Use** button and hand-picked measure keep the typed number as a count — SPEC §5.3 b, quantity conversion / reset for recipe counts, recipe grams), add all, added-with-notes rows, unverified-refresh hint, decode stop, undo, diagnostics redaction, settings + account-gated input persistence, the first-run notice (shown in place of Input / Preview / Results with fake storage, nothing typed stored before **Continue**, the remember choice unticked (opt-in: `rememberInput` defaults to false, only an explicit true is kept), a 0.3.0 list restored only after Continue with the box ticked and deleted when it is left unticked, the notice saying the session and account id were already read, no notice without `chrome.storage`), UI refresh signal, §3.5 decoder banner states (rebuilding with a progress line — deploy wording only on a mismatch / rebuilt, incl. "not saved to chrome.storage" / failed: automatic vs manual, a persisted earlier failure) and the Diagnostics decoder block whose **Rebuild decoder** button calls the store with `force:true` (disabled while the live build or the builder is unknown), Find foods and Add all waiting for the store's `inFlight()`, Add all disabled and refused for the RPC engine while the decoder mismatches (the UI engine is not gated); review round 5: the REAL `registry-store.js` loaded beside a fake builder drives the banner and the Diagnostics block to their final state on its own last event (no hand-made event), a refused automatic attempt is explained ("was skipped: …"), Settings → *Forget last batch*; 0.3.2: the *Search only my custom foods* checkbox round trip (an invalid stored value → false), `opts.customOnly` passed to `plan.build`, the preview footer's "custom foods only" / "N lines custom-only", the cheat-sheet; a calorie-amount row through the real `plan.repick` (Qty = the kcal / kJ target, the conversion note, a measure change keeping the target, a Qty edit changing it, a weightless measure asking for another, no **Use** button, the over-1-kg warning class, `energy` numbers in the dump); §8 view registry (`CMA.panel.registerView`): a definition queued in `CMA.panelViewQueue` before panel.js loads, the tab just before Diagnostics with its css and ctx helpers, events only while shown plus `hidden`, `views.<id>` in the dump (a throwing `diagnostics()` / `render()` is reported, redacted), invalid definitions refused, `setState({view})` / `open(view)`, unmount / remount / unregister |
| `load-all.html` | **every script in `manifest.json` order** + fixtures | namespaces exist (incl. `registryBuilder` / `registryStore` and the TDEE `tdee` / `tdeeData` / `tdeeView`), no load-time exception, hook answers ping, `CMA.registryStore.init()` is logged before the hook's pong (§3.5 ordering), content.js bootstraps and mounts the panel, cross-module contracts (registry ↔ SIG ↔ plan ↔ rpc ↔ Writer byte-equality; `300cal almonds` → a decoded Food's NutrientMap → `energyKcalOf` → `plan.repick` → `servingFor`), §12 wiring: the frozen engine API, the data layer's API and storage keys and its `rpc` / `diary-write` listeners, the TDEE tab just before Diagnostics, nothing read before consent in a bare page, `views.tdee` in the dump without weights or intakes, and an end-to-end run with `fetch` stubbed (every request decoded from the real Writer body and answered with the real encoder; anything unexpected throws): Enable → the full sync through the real rpc.js / capture / data layer, records and burned as served, the engine and the TDEE view on them, no nonce or health value in the dump, then an RPC-engine batch whose `'diary-write'` makes the data layer read the edited days again (the 30 s dirty debounce shortened to 2 s for the run) |
| `tdee.html` | tdee/adaptive-tdee (generated by `tools/gen_tdee.py`), `tdee-sim.js` (generated from `vendor/adaptive-tdee/simulate.mjs`) (+ the `vendor/adaptive-tdee/` files read over XHR) | the Adaptive TDEE engine: all 17 upstream node tests of `adaptive-tdee.test.mjs` ported 1:1 (names compared with the upstream file), the published `ADAPTIVE_TDEE_SPEC.md` §7 default-engine benchmark figures reproduced exactly, packaging parity (the text between the `/*<upstream>*/` markers = the vendor module with only the column-0 `export ` removed, `UPSTREAM_SHA256` = SHA-256 of the vendor file, same for `tdee-sim.js`), a frozen `CMA.tdee` with exactly the contract names and no leaked globals, the `check_manifest.py` classic-script / guard / noncharacter rules, `runExpenditureModel` over 365 days < 50 ms (`performance.now()` advances for synchronous work under virtual time; ~1 ms measured). The XHR checks print nothing extra and pass with one `ok` when file access is blocked |
| `tdee-data.html` | lib.js, gwt-registry, gwt-stream, registry-builder, rpc, capture, fixtures, tdee/adaptive-tdee, tdee/tdee-data (+ a stubbed `fetch`, then a fake `CMA.rpc` / `CMA.capture` / `chrome.storage.local` and an injected clock and timer queue) | §12.2–12.5: the five TDEE request bodies byte-equal to research/tdee-critic.md 5 (energy / calendar Day pairs, the whole-history and ranged getBiometrics, getFirstDayWithData, getPreference), reply decoding (the EthanDenny `double[][]` fixture, DataPoint[] with Time or null, CalendarInfo flags, malformed replies → kind `decode`, never "nothing logged"), consent (no request before `enable()`), every gate (capture not ready, decoder mismatch — also mid-sync —, rebuild in flight, missing layouts) with parked requests resuming, the full-sync order and windows, energy chunk halving on a row-count mismatch or //EX (not on decode), window-replace merges, the 10-minute delta limit and `force`, the 7-day full sync, single flight and cancelled jobs, dirty days from app writes and `'diary-write'`, setUserPreference, exclusions (partial-day heuristic - a run of low days stays excluded until confirmed -, overrides, trustCompleteOnly), today's intake null by the LOCAL date and today's partial burned out of `records()` (the engine's prior and 14-day average), a positive row counting whatever the calendar says, first weigh-in per day, burned = BMR + activity + abs(exercise) (+ TEF with the preference, compared case-insensitively), account gating and switching, the nonce and weights never stored in logs or diagnostics, the stored format and a failed read, ROW_LAYOUT_VERSION, settings and check-ins (incl. the view's nudges and check-in extras surviving a reload), failures (Session, Throttled, refused preferences / calendar reported as `notes`, not `lastError`), a refused short window never resent, an HTTP error never shrinking the saved window, a known first day kept on refusal, 5-year pruning, the viewed day only for id-only writes, one `cmaTdeeDays` write per short job, 250 ms spacing, CSV import (days not rows; stone / lb per row, the earliest weigh-in by 12- or 24-hour time, unknown units, the servings export and wrong files refused) and `probe()`; **other tabs**: the stored consent re-checked before every job (another tab's Delete / Disable / another account: no request, no key re-created) and two iframes running the real module over one fake storage whose `onChanged` reports sorted keys (consent adopted, no lost check-ins / settings / overrides, own echoes never roll memory back, Delete or Disable in one tab stops the other, a deletion during a sync writes nothing back, another account taking over). Nothing contacts cronometer.com |
| `tdee-view.html` | lib.js, panel.css, panel, tdee/adaptive-tdee, tdee-view (+ stubbed `CMA.events` / `CMA.capture` / `CMA.registryStore` and a contract stub of `CMA.tdeeData`; later the real `tdee-data.js`, loaded offline and fed by CSV files) | §12.7: registration before Diagnostics with its own stylesheet, the consent screen (what is read, PRIVACY link, disclaimer; nothing read), the waiting state while the account is unknown, the four status chips and the comparison line with the real engine, the sync line (Refresh = forced delta, Refresh all = full) and its gates, auto-refresh on open, SVG charts with bounded node counts, range selector, hover readout, the weekly check-in (preview, accept with Copy, fixed target between check-ins, skip, goal change lifting the cap, at most one every 6 days, a goal changed and back is none), the activity-aware line (no reduction while the day runs, the calorie floor, notes from the inputs), engine notes and the floor hint in kJ, the warm-up comparison, settings round trip, a sync / error ending while Settings is open keeping unsaved edits (and Reset / Save), units (kJ, stone, automatic; unread preferences = kg / kcal, TEF "not counted"), model start / reset (the first estimate tomorrow), a paused first sync's empty state, CSV inputs, Delete TDEE data, history pages of 60 rows (5 years stay bounded), exclusions, the partial-day and weigh-in nudges, **Check the numbers** and its Copy, keyboard focus kept across re-renders and the chart readout by arrow keys, neutral colours (no accent / ok / error token), the diagnostics leak check (no weight, intake, expenditure or target in `views.tdee` or the dump), lifecycle; then the same view against the REAL data layer fed by CSV files |
| `mock-tdee-evaluate.html` | tdee/adaptive-tdee, `tdee-sim.js` | **manual benchmark**, skipped by the runner: `vendor/adaptive-tdee/evaluate.mjs` ported to the browser, prints its estimator table (no verdict line) |
| `mock-cronometer.html` | dom, engine-ui, mock-cronometer.js | **manual playground**, skipped by the runner: open it in a browser and drive the fake dialog by hand. Also the page of `python tools/screenshots.py --dry-run`, which switches on the mock's opt-in day navigation (`mock.useDays({start, entries, delay})`: the date arrows switch days, each day keeps its own rows; off by default, so `engine-ui.html` sees the arrows only log) |

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
