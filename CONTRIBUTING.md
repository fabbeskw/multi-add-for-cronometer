# Contributing

Thanks for helping. This is a small, dependency-free project: plain JavaScript, Python 3 (stdlib only) for the
tooling, headless Chrome for the tests. No node, no npm, no bundler, no build step. Read [SPEC.md](SPEC.md)
before changing behaviour; it is the design of record and the tests are written against its section numbers.

## The green bar

Every change must keep all of these passing (Git Bash on Windows, any shell elsewhere; Chrome must be installed):

```
python tools/check_manifest.py        # manifest.json: files/icons exist, load order = tests/load-all.html, CMA guard
python tools/gen_tdee.py --check      # src/tdee/adaptive-tdee.js + tests/tdee-sim.js match vendor/adaptive-tdee/ byte for byte
bash tests/run.sh                     # every tests/*.html page in headless Chrome -> ALL TESTS PASSED
python tools/build_zip.py             # store package -> PACKAGE OK (allow-list, manifest references, noncharacters)
python tools/smoke_extension.py --self-test   # installs the tree into headless Chrome via DevTools Extensions.loadUnpacked
python tools/screenshots.py --dry-run --headless   # the store-screenshot tool's self-check against the mock diary -> SCREENSHOTS PASS
python tools/make_graphics.py --verify             # icons + store promo tiles: sizes, colour types, transparency (no Chrome) -> GRAPHICS OK
```

`bash tests/run.sh page.html` runs one page. How the runner works, what each page covers and how to write a new
one is in [tests/README-tests.md](tests/README-tests.md). A new feature gets tests on the page that owns that
module; a new page gets a row in that README's table and loads scripts in `manifest.json` order.

## Regenerating the decoder registry

The RPC engine decodes Cronometer's GWT-RPC replies with the registry in `src/lib/gwt-registry.js`, generated
from one compiled build of the web app. After a Cronometer deploy (or when `tests/registry-builder.html` reports
a parity difference):

```
python tools/fetch_bundle.py                       # downloads the current compiled client into tools/bundle/ (gitignored)
python tools/gen_registry.py tools/bundle/all.js   # rewrites src/lib/gwt-registry.js; must print "unknown : 0"
bash tests/run.sh                                  # registry-builder.html checks the in-extension port reproduces the file
```

`tools/gen_registry.py` and the JavaScript port in `src/lib/registry-builder.js` must stay equivalent: a change
to the parser is made in both, and `tests/registry-builder.html` proves it (same keys, same order, same JSON).

## Updating the Adaptive TDEE engine

The expenditure engine lives pristine in `vendor/adaptive-tdee/` (the upstream ES module, its node tests, the
simulator, the benchmark and `ADAPTIVE_TDEE_SPEC.md`); its maths is fixed. Never edit `src/tdee/adaptive-tdee.js` or
`tests/tdee-sim.js`: both are generated. To update: replace the vendor files, then

```
python tools/gen_tdee.py            # rewrites src/tdee/adaptive-tdee.js (CMA.tdee) and tests/tdee-sim.js (CMA.tdeeSim)
python tools/gen_tdee.py --check    # byte-compares both with a fresh generation; exit 1 on drift
bash tests/run.sh                   # tdee.html: the upstream tests, marker/SHA-256 parity, the SPEC section 7 figures
```

The generator only removes the column-0 `export ` prefixes and refuses anything else (imports, `export default`,
`export { }`, indented exports, noncharacters). A new upstream node test must also be ported to `tests/tdee.html`
(the page compares its test names with `adaptive-tdee.test.mjs`); `tests/mock-tdee-evaluate.html` is the manual
browser port of `evaluate.mjs`.

## Packaging a release

```
python tools/check_manifest.py && python tools/gen_tdee.py --check && bash tests/run.sh && python tools/build_zip.py
```

writes `dist/multi-add-for-cronometer-<version>.zip` (reproducible: two builds of the same tree are
byte-identical). `dist/` is gitignored; release zips are attached to a GitHub Release and uploaded to the Chrome
Web Store, never committed. Bump `"version"` in `manifest.json` and add a changelog line to README.md first.
The listing texts are in [STORE-LISTING.md](STORE-LISTING.md) and the ordered submission steps in
[SUBMISSION-CHECKLIST.md](SUBMISSION-CHECKLIST.md). After a visible change to the panel, the store screenshots are
regenerated with `python tools/screenshots.py` — a live run the account owner does together with the maintainer:
a Chrome window opens and waits for the owner's login, and the run writes four sample entries to an empty future day
of the owner's diary and undoes them. Only `store-assets/README.md` and `store-assets/manifest.json` are committed;
the screenshot PNGs are gitignored (`store-assets/*.png`) and reviewed by the owner before upload (see
[store-assets/README.md](store-assets/README.md)); the headless dry run in the green bar only proves the tool works.
The icons and the promo tiles in `store-assets/promo/` (committed: shapes and text only) are rendered from `graphics/`
by `python tools/make_graphics.py`.

## Code rules

These come from SPEC §0 and are enforced by `tools/check_manifest.py`, `tools/build_zip.py` and the tests:

* **Classic scripts, ES2020.** No modules, no TypeScript, no transpiling. Every content script starts with
  `window.CMA = window.CMA || {};` and attaches to `CMA.*`; load order is set in `manifest.json` and mirrored by
  `tests/load-all.html`.
* **No `eval`, no `new Function`, no inline scripts** in extension pages (MV3 CSP) and no remotely loaded code.
  The runtime decoder rebuild reads Cronometer's script files as *text*; it never executes them.
* **No Unicode noncharacters** (U+FDD0–U+FDEF, U+xFFFE/U+xFFFF) and no lone surrogates in any content script:
  Chrome refuses to install the extension. Use `\uXXXX` escapes for anything outside plain ASCII when in doubt.
* **The session nonce is never logged, stored or shown.** It lives in memory in the tab, is redacted from every
  log line, snapshot and diagnostics dump, and never reaches `chrome.storage`. The tests assert this; keep it
  true for any new state you add. Never call the `authenticate` RPC yourself.
* **Same-origin only.** Every request goes to `https://cronometer.com`; never read `document.cookie`; never relay
  or inspect traffic to another host.
* Mirror what the real UI sends (one `updateDiary` per food, sequential, with a delay). Do not batch changes into
  one call.
* Comments cite evidence: the SPEC section, the bundle symbol (`grep` `tools/bundle/all.js`) or the captured
  string a decision rests on.
* **Fixtures captured from a live account get their user id replaced before commit** (the tests use the synthetic
  `1234567`; public food, measure and serving ids may stay). Keep the digit count when the id sits inside a GWT
  body so the byte-equal tests stay meaningful.
* **Never commit screenshots of a real diary** (store assets, bug reports, docs) without the account owner's review:
  a diary shows foods, times, notes and the account name. The TDEE tab shows weight and intake history, so the rule
  applies to it with even more reason.
* **Adaptive TDEE** (SPEC §12): the engine's maths is fixed — change `vendor/adaptive-tdee/` only by replacing it with
  a new upstream copy and regenerating (above). The data layer reads nothing before the user's **Enable**, re-checks
  its gate (capture ready, decoder matching, no rebuild running) before every call and the stored consent before every
  job, follows the other open tabs through `chrome.storage.onChanged` (a Delete TDEE data in one tab stops them all;
  never write a `cmaTdee*` key from a memory copy that has not adopted the other tabs' changes), and keeps every record
  stamped with the account id. Weights, intakes, burned figures, estimates and targets never go into a log line, a status
  text, `lastError` or a `diagnostics()` result (counts, date ranges and flags only; `tests/tdee-data.html` and
  `tests/tdee-view.html` grep for leaks). "Today" is `CMA.capture.today()` (the local calendar date), never the
  diary's viewed day and never `toISOString()`. The TDEE view uses neutral colours only: no `--accent` / `--ok` /
  `--err`, no primary / danger button classes (no red/green judgement of over/under target).

## Privacy

If a pull request changes what the extension stores, reads, sends or shows (a new `chrome.storage` key, a new
field in the diagnostics dump, a new request, a new permission — including a new TDEE read or a new field in a
`cmaTdee*` record), it must update [PRIVACY.md](PRIVACY.md) — the data table, the effective date at the top — and
the data-usage answers in [STORE-LISTING.md](STORE-LISTING.md), in the same PR. The store cross-checks the
disclosures against the code, and users are told to check the policy when they update. If the change makes the
panel's first-run notice (`renderFirstRun` in `src/ui/panel.js`) inaccurate, update its text too and raise
`NOTICE_VERSION` there, so every user sees the new notice once.

## Pull requests

Keep the description short: what changed, why, and which test proves it. Paste the verdict lines of the checks
above. Bug reports are most useful with the Diagnostics dump (panel → Diagnostics → Copy; it contains no session
token) plus the input lines used — see *Reporting a failure* in the README.
