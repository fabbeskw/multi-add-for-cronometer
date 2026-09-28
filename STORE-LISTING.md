# Chrome Web Store listing — Multi-Add for Cronometer

Everything needed to fill in the Chrome Web Store **Developer Dashboard** for this extension, plus the publishing
procedure. Copy the text blocks as they are; replace every `<placeholder>` before submitting:
`python tools/set_repo_url.py https://github.com/<owner>/multi-add-for-cronometer` fills the privacy-policy, support
and repository URL placeholders here, in README.md and in PRIVACY.md from the repository URL (idempotent; it prints
what it changed; the policy URL becomes the `PRIVACY.md` page of the repository, support and contact its *Issues* page). `<Chrome Web Store URL>` (README) and `<item id>` (below) are only known after the review.

The package to upload is built with `python tools/build_zip.py` → `dist/multi-add-for-cronometer-<version>.zip`
(see *Packaging* in README.md). The version in the file name is the `version` in `manifest.json`.

---

## 1. Store listing tab

### Name (from manifest, max 45 characters)

```
Multi-Add for Cronometer
```

The "X for Cronometer" pattern is the accepted way to name a third-party tool without implying it is an official
Cronometer product. Do **not** use Cronometer's logo, wordmark or colours anywhere in the listing; the icons in
`icons/` are generic.

### Summary (from manifest `description`, max 132 characters — 130 used)

```
Unofficial: add many foods to your Cronometer web diary in one go, plus an adaptive TDEE estimate. Not affiliated with Cronometer.
```

### Category

**Tools** — a category the Developer Dashboard actually offers. Since the 2023 category revamp its dropdown is
the flat list *Tools, Workflow & Planning, Well-being, Developer Tools, Functionality & UI, …*; "Productivity" is
not selectable any more, it survives only as the store *section* Tools is filed under
(`chromewebstore.google.com/category/extensions/productivity/tools`). Alternative, if it fits the dashboard's
wording better: *Well-being* (the Lifestyle section, where health and nutrition tools live). Verify in the
dashboard before submitting.

### Language

**English** (the extension's UI is English only).

### Detailed description (plain text; the store shows it verbatim, no Markdown; keep under ~16,000 characters)

```
Multi-Add for Cronometer adds a small panel to the Cronometer web app (cronometer.com) that lets you log a whole meal at once instead of one food at a time.

The web app's "Add Food to Diary" dialog closes after every add and has no multi-add. With this extension you open the diary, press Alt+Shift+M (or click the Multi-add button), paste or type one food per line, for example

  200g chicken breast
  1 1/2 cups rice, cooked
  2 large eggs @breakfast

press "Find foods", check the matches in a preview table (change the matched food, quantity, unit or diary group for any line), then press "Add all". Every line is added to the diary day you are viewing, in the diary group you chose. A batch can be undone with one click for 24 hours.

WHAT IT UNDERSTANDS
- quantities in grams, kg, oz, lb, ml, l, cups, tbsp, tsp, slices, pieces, servings, "large"/"medium"/"small" and the food's own measures
- fractions and decimal commas (1 1/2 cups, ½ cup, 1,5 cups)
- multipliers (2 x 100g yoghurt, eggs x2)
- group headers (## Dinner, Dinner:) and per-line tags (@lunch)
- two foods on one line (oats 40 g, milk 200 ml)
- comments and blank lines are ignored

TWO ENGINES
- RPC (default, fast): sends the same requests the web app sends when you use its own Add Food dialog, one food at a time with a short delay, then refreshes the diary.
- UI automation (fallback): drives the app's real Add Food dialog for you, food by food. Slower, but it keeps working even when Cronometer changes its internals.
If Cronometer ships a new version of its web app, the extension rebuilds the part it needs from the new build automatically (it reads the app's own public script files from cronometer.com); you can also press "Rebuild decoder" in the Diagnostics tab.

ADAPTIVE TDEE (OPTIONAL, OFF UNTIL YOU ENABLE IT)
The panel's TDEE tab estimates how much energy you really burn each day from the food and the weight you already log in Cronometer (an adaptive estimate in the style of MacroFactor), shows how it compares with Cronometer's own burned figure, charts your expenditure and trend weight, and offers a weekly check-in with a suggested calorie and macro target for your goal (lose, maintain or gain). The target is display only: you set it in Cronometer yourself. Nothing is read until you press Enable in the tab; then the extension reads your daily intake, Cronometer's burned figures and your weight history from cronometer.com with the same read requests the web app itself uses, and keeps a copy in your browser only (one button deletes it). You can also import Cronometer's own CSV exports instead. Estimates only, not medical advice; not suitable during pregnancy or with medical conditions that affect weight or fluid balance.

PRIVACY
- Works only inside your own logged-in Cronometer tab. Nothing leaves cronometer.com.
- No account with us, no analytics, no telemetry, no third parties, no data sold.
- Your session is used in memory only and is never stored.
- Settings, your last input list (remembered by default; switch it off in Settings), the undo information for the last batch (both with your account number, so they are only offered to that account; both deletable in Settings) and a decoder table rebuilt from Cronometer's public code (no personal data) are kept in your browser only.
- If you enable the TDEE tab: your daily intake, energy-burned and weight history, the tab's settings and its check-in log are kept in your browser only, for your account only, and "Delete TDEE data" removes them. They never appear in the diagnostics dump.
Full policy: https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md

REQUIREMENTS
- A Cronometer account and the Cronometer WEB app at https://cronometer.com (not the mobile apps).
- After installing, open https://cronometer.com/#diary and reload the tab once so the extension can see the app start.

DISCLAIMER
This is an unofficial, independent tool. It is not affiliated with, endorsed by or supported by Cronometer Software Inc. "Cronometer" is a trademark of its owner and is used only to describe which website the extension works with. The extension automates actions on your own account through the same requests the web app makes; use it at a reasonable pace and in accordance with Cronometer's Terms of Service. Use at your own risk.

Source code, issues and support: https://github.com/fabbeskw/multi-add-for-cronometer/issues
```

### Trademark disclaimer sentence (also paste into any field that asks how third-party marks are used)

```
Multi-Add for Cronometer is an unofficial, independent extension and is not affiliated with, endorsed by or supported by Cronometer Software Inc.; "Cronometer" is a trademark of its owner, used only to identify the website the extension works with, and no Cronometer logo or brand asset is used.
```

### Graphic assets

| Asset | Size | Required | Notes |
|---|---|---|---|
| Store icon | 128 × 128 PNG | yes | Use `icons/icon128.png` (generic icon; no Cronometer branding). |
| Screenshots | **1280 × 800** (preferred) or 640 × 400, PNG or JPEG, no alpha | at least 1, up to 5 | See checklist below; `python tools/screenshots.py` renders them into `store-assets/` (committed). |
| Small promo tile | 440 × 280 PNG/JPEG | optional | Plain background, extension name, one line ("Log a whole meal in one go"). No Cronometer logo. |
| Marquee promo tile | 1400 × 560 | optional | Only needed if you want to be considered for featuring; skip for a soft launch. |

#### Screenshot checklist (5 shots, all 1280 × 800, rendered by `python tools/screenshots.py` into `store-assets/`)

1. **Input view** — the panel open over the diary with a realistic list typed in (use ordinary foods, a `## Dinner`
   header and an `@lunch` tag so the format is visible).
2. **Preview** — the table after *Find foods*: several ✓ rows, one `?` row with a *Use …* suggestion so the
   checking step is obvious.
3. **Results** — the ✓ list after *Add all* with the *Undo this batch* button visible.
4. **Diary after adding** — the Cronometer diary showing the new entries in their groups (the "why you want this"
   shot).
5. **Diagnostics / Settings** — the Diagnostics tab (shows the decoder status, the *Rebuild decoder* button and the "no session token"
   note) or the Settings tab with the two engines.

The five shots predate 0.3.0 and do not show the **TDEE** tab. `tools/screenshots.py` has no TDEE scenario yet; if
you replace shot 5 with the TDEE Overview, take it by hand on an account whose owner agreed to show its weight and
intake (the tab shows health data; blur or use a test account) and record it in `store-assets/manifest.json`.

**Generated, not hand-made:** `python tools/screenshots.py` (see `store-assets/README.md`) opens a Chrome window,
waits for you to log in, installs the extension, runs exactly this scenario on your diary through the panel's real
buttons (RPC engine; the four entries are added and undone again) and captures the five shots as the page viewport
(1280 × 800, so there is no URL bar to crop). Before each capture it blurs your name / e-mail in Cronometer's header,
the Energy Summary / targets widgets and, in the Diagnostics dump, your numeric account id; `store-assets/manifest.json`
records per file what was blurred. The permutation / policy hash in the dump are the app's public build identifiers and
may stay; the dump never shows the session token (`"nonce": "present"`). For the `?` row of shot 2 pass `--lines FILE`
with a line whose unit the food does not have (`2 slices banana`). Before uploading, open every PNG and look for
anything personal the blur did not cover (a widget Cronometer added since, a name in a place the tool does not know):
extend the blur with `--blur-selectors` / `--blur-text` and run again rather than editing the PNGs. The diary entries
visible in the shots are yours by design: capture on a day whose entries you are happy to show, or on an empty day.

### Additional fields

| Field | Value |
|---|---|
| Official URL | leave empty (or the repository page <https://github.com/fabbeskw/multi-add-for-cronometer> — *not* cronometer.com) |
| Homepage URL | <https://github.com/fabbeskw/multi-add-for-cronometer> (repository) |
| Support URL | <https://github.com/fabbeskw/multi-add-for-cronometer/issues> (repository *Issues* page, or a contact form) |
| Mature content | No |
| Google Analytics ID | leave empty (the extension has no analytics) |

---

## 2. Privacy tab

### Single purpose description

```
A companion for the Cronometer web diary: log many foods at once and estimate energy expenditure from the intake and weight already logged there. Everything happens inside the user's logged-in cronometer.com tab: a typed list of foods is added to the Cronometer food diary in one operation instead of one at a time, and, only if the user enables it, an adaptive estimate of daily energy expenditure (with a suggested weekly calorie target the user sets in Cronometer themselves) is computed from the intake, energy-burned and weight entries already in that diary.
```

Both features serve the same diary and work only on data the user logs in Cronometer; the TDEE part is off until
the user enables it. See §5 for the review risk this wording carries.

### Permission justifications

**storage**

```
Stores the user's extension settings (engine choice, delay between adds, whether to remember the last input), the last input list (remembered by default, the user can switch it off), the user's numeric Cronometer account id next to that list and next to the ids of the last batch of diary entries (so the undo and the remembered list are only offered to the account that created them; undo is possible for 24 hours, and both records can be deleted by the user at any time from the panel's Settings tab), and a technical decoder table derived from Cronometer's public compiled code. Only if the user enables the optional Adaptive TDEE tab, it also stores a copy of the user's per-day energy intake, Cronometer's energy-burned figures and first daily weigh-in (read from the user's own Cronometer account), the tab's settings, per-day exclusions and weekly check-in log, each record stamped with the account id and shown only to that account; the "Delete TDEE data" button removes them. All of it stays in chrome.storage.local on the user's device. Nothing is synced or transmitted.
```

**Host permission `https://cronometer.com/*`**

```
The extension runs only inside the Cronometer web app. It needs this origin to (1) inject its panel into the diary page, (2) observe the app's own requests in the user's tab so it can learn the current session and diary date without asking for credentials, (3) send the same diary requests the app itself sends (food search, add entry, remove entry), (4) after a Cronometer release, download the app's own public script files from cronometer.com (the same files the page loads) to rebuild the table it uses to read the app's responses; that table is stored locally and contains no personal data, and (5) only after the user enables the optional Adaptive TDEE tab, make the read-only requests the web app itself makes for its dashboard, Nutrition Report, weight history, diary calendar and settings (getCaloriesConsumedAndBurned, getBiometrics, getCalendarInfo, getFirstDayWithData, getPreference) to read the user's own energy intake, energy-burned and weight history; nothing is written back. No other host is accessed and no traffic to other hosts is inspected.
```

**Are you using remote code?** — **No.** All code is packaged in the extension; nothing is loaded from a server and
`eval` is not used. (The extension *reads* Cronometer's public JavaScript to build a decoding table, but it never
executes it; say so in the certification text if a reviewer asks.)

### Data usage disclosures

The store's User Data policy counts **collecting, transmitting, using or sharing** user data as "handling" it, and
requires the disclosure **even when the data is only processed or stored locally and never reaches the developer**
(Chrome Web Store User Data FAQ). Answer by what the code does, not by where the data ends up. Tick:

| Data type | Tick | Why (what the code does) |
|---|---|---|
| **Health information** | **yes** | the food list the user types is dietary data: it is stored locally by default (`cmaLastInput`), sent to Cronometer's food search and written into the user's diet diary; if the user enables the Adaptive TDEE tab, the per-day energy intake, energy-burned figures and weigh-ins are read from the user's Cronometer account and stored locally (`cmaTdeeDays`, with settings, per-day exclusions and check-ins in `cmaTdeeSettings` / `cmaTdeeOverrides` / `cmaTdeeCheckins`, and the consent, refresh state and three Cronometer preferences in `cmaTdeeSync`) |
| **Authentication information** | **yes** | the Cronometer session token is read from the app's own traffic, held in memory and sent with every diary request to cronometer.com |
| **Personally identifiable information** | **yes** | the numeric Cronometer account id is read from the app's traffic, stored locally next to the last batch and the last input (`cmaLastBatch`, `cmaLastInput`) and, when the TDEE tab is enabled, in every `cmaTdee*` record, written to the extension's own log and included in the diagnostics dump the user copies by hand |
| **Website content** | **yes** | Cronometer's responses (the diary of the day being viewed, the food details; with the TDEE tab enabled, the daily energy rows, weigh-ins, calendar flags and three settings) are decoded to place new entries, to pick measures and to compute the estimate |
| **User activity** | **yes** (recommended) | the extension observes the network requests the Cronometer web app makes in the user's tab (the page-level XMLHttpRequest hook); the store's own example for this category is network monitoring, so declare it rather than argue about it |
| Financial and payment information, Personal communications, Location, Web history | no | not handled at all (no other site is observed, `document.cookie` and browsing history are never read) |

Every one of these stays on the device or goes only to cronometer.com on the user's own behalf — the certifications
and the free-text paragraph below say so; an accurate disclosure is what a reviewer cross-checks against the
`storage` permission and the request hook, and it is shown on the public listing.

Then certify all three statements (they are true):

* *I do not sell or transfer user data to third parties, outside of the approved use cases* — **yes**
* *I do not use or transfer user data for purposes that are unrelated to my item's single purpose* — **yes**
* *I do not use or transfer user data to determine creditworthiness or for lending purposes* — **yes**

### Free-text explanation to paste where the dashboard asks for details (or into the reviewer notes)

```
This extension does not collect or transmit any user data to the developer or to any third party. It has no server, no analytics and no telemetry.

Inside the user's own logged-in cronometer.com tab it observes the Cronometer web app's own start-up requests to obtain the app's session token and the numeric account id, and uses them solely to send the same food-search and diary requests to cronometer.com that the web app sends when the user adds a food by hand. The session token is kept in memory only: never in storage, never in the extension's log and never in the diagnostics dump. The account id is kept in memory, stored locally next to the last batch and the last input list so that undo and the remembered list are only offered to the account that created them, and appears in the diagnostics dump the user copies by hand for a bug report. Food names typed by the user are sent only to Cronometer's own food search. Diary content is read only to place new entries correctly.

chrome.storage.local holds: extension settings; the user's last input list together with the account id (remembered by default; the user can switch "remember last input" off, which deletes the stored copy); the ids of the last batch of added entries with the account id for a 24-hour undo; and a decoder table derived from Cronometer's public compiled JavaScript plus a note about its last rebuild (type names and checksums, a build id, a timestamp and an error text - no personal data; the script files are downloaded from cronometer.com only and analysed as text, never executed). All of it stays on the device and is deleted with the extension.

The optional Adaptive TDEE tab reads nothing until the user presses Enable in it. After that it sends read-only requests to cronometer.com (the same ones the web app uses for its dashboard, Nutrition Report, weight history, diary calendar and settings) to obtain the user's per-day energy intake, Cronometer's energy-burned figures and weigh-ins, computes an expenditure estimate and a suggested weekly target locally, and stores the history, the tab's settings and its check-in log in chrome.storage.local, stamped with the account id and shown only to that account. Nothing is written back to Cronometer, nothing is transmitted anywhere else, the diagnostics dump contains only counts and dates for this data, and the "Delete TDEE data" button removes all of it.
```

### Privacy policy URL

```
https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md
```

Host `PRIVACY.md` at a public URL (a GitHub repository page, GitHub Pages, a gist, or any static host) and paste that
URL. The store requires a reachable policy for any extension that handles user data; this one is required because
of the host permission and the session handling.

---

## 3. Distribution tab

| Setting | Recommended | Why |
|---|---|---|
| Payment | Free | |
| Visibility | **Unlisted** for the first release, **Public** later | Unlisted items are installable by anyone with the link, pass the same review, and can be switched to Public without re-review. This is the soft-launch option: share the link with a few users, wait for the first Cronometer deploy to confirm the runtime rebuild works in the wild, then flip to Public. |
| Regions | All regions | |

---

## 4. Publishing step by step

1. **Developer account.** Go to <https://chrome.google.com/webstore/devconsole>, sign in with the Google account
   you want to own the listing, accept the developer agreement and pay the one-time **US$5** registration fee. Set
   up the *Account* page (publisher name shown on the listing, contact e-mail — it must be verified). Consider
   enabling 2-step verification on that Google account; the store requires it for publishers.
2. **Build the package** from a clean, tested tree:
   ```
   python tools/check_manifest.py      # ALL CHECKS PASSED
   python tools/gen_tdee.py --check    # the TDEE engine wrapper matches vendor/adaptive-tdee/ (exit 0)
   bash tests/run.sh                   # every page PASS
   python tools/build_zip.py           # PACKAGE OK: dist/multi-add-for-cronometer-0.3.0.zip
   ```
   The script refuses to produce a package that contains anything outside the allow-list (`src/` takes `.js`
   files only, and every one of them must be listed in the manifest) or that references a missing file, so a
   "PACKAGE OK" zip is exactly what the store will see. `dist/` is gitignored: attach the same zip to a GitHub
   Release (<https://github.com/fabbeskw/multi-add-for-cronometer/releases>) so the *From a release zip* install path in the README works.
3. **Load the zip locally once**: unzip it to a temporary folder and *Load unpacked* on `chrome://extensions`, open
   `https://cronometer.com/#diary`, reload, add two foods, undo them. This catches a manifest/file problem before
   review does. `python tools/smoke_extension.py dist/multi-add-for-cronometer-0.3.0.zip --self-test` does the
   install half of that headlessly (DevTools `Extensions.loadUnpacked` + the popup page).
4. **Upload.** Dashboard → *New item* → drop the zip. The dashboard reads name, version, description and permissions
   from `manifest.json`.
5. **Fill the tabs** with the text above: *Store listing* (description, category, language, icon, screenshots,
   URLs), *Privacy* (single purpose, permission justifications, remote code = No, data usage, certification, privacy
   policy URL), *Distribution* (free, Unlisted/Public, regions).
6. **Save draft** and use *Preview* to check the listing. Fix anything the dashboard flags in red (a missing
   screenshot or justification blocks submission).
7. **Submit for review.** Leave *Publish automatically after review* on unless you want to time the release.
8. **Review time.** Most submissions with a single host permission and `storage` are reviewed within 1–3 days;
   allow up to a couple of weeks for a first submission or after a rejection. The "observe the app's requests"
   behaviour (the page-level XMLHttpRequest hook) is the part most likely to draw a question — the reviewer notes
   text in §2 answers it. If rejected, the e-mail names the policy; fix, bump the version, rebuild, re-upload, and
   reply through the dashboard's appeal/resubmit flow.
9. **After publication**, the item page is `https://chromewebstore.google.com/detail/<item id>`; put that link in
   the README *Install* section (replace `<Chrome Web Store URL>` and drop the *coming soon* note) and, if
   visibility is Unlisted, share it directly.

### Publishing an update

1. Change `"version"` in `manifest.json` (`0.3.0` → `0.3.1`; the store rejects an upload whose version is not higher
   than the published one). Add the changelog line to README.md. If the panel changed visibly, regenerate the
   screenshots (`python tools/screenshots.py`) and upload the new ones with the package.
2. `python tools/check_manifest.py && python tools/gen_tdee.py --check && bash tests/run.sh && python tools/build_zip.py`.
3. Dashboard → the item → *Package* → *Upload new package* → drop the new zip → *Submit for review*. Listing text
   only needs changing if the behaviour changed; the privacy answers must be revisited if data handling changed
   (and then `PRIVACY.md` and its effective date too).
4. Users receive the update automatically within a few hours of approval (Chrome checks roughly every 5 hours).

---

## 5. Risks to be aware of

* **Cronometer's Terms of Service.** The extension automates actions on the user's own account through the same
  requests the web app makes, at a human-like pace (one request at a time, a delay between adds, server throttling
  respected). It is nevertheless an unofficial client, and Cronometer could object; the listing, the README and the
  privacy policy all say so and tell users to stop if asked. Keep the pace limits, never add features that scrape
  other users' data, and be prepared to unpublish if Cronometer requests it. The TDEE tab's reads are the heaviest
  part: its first read (and its full refresh, weekly or on *Refresh all*) of up to five years is about 70–90 read
  requests in a row, 250 ms apart, and it asks for energy windows of up to 92 days - more than the 56 days the app
  itself ever asks for (a refused window is halved, down to 28 days). After that it reads 3 requests for the last 14
  days when the tab is opened (at most every 10 minutes) and about 30 seconds after the user's diary edits.
* **Cronometer deploys can break the RPC engine.** The fast engine decodes Cronometer's GWT-RPC responses with a
  type registry that is specific to a compiled build. Cronometer redeploys often. Mitigations already shipped:
  (1) the extension detects a new build from the live permutation hash, **rebuilds the registry itself from the new
  build's public JavaScript** and activates it, automatically and on demand from Diagnostics; (2) the **UI-automation
  engine** does not depend on the wire format at all and keeps working meanwhile; (3) an unreadable reply after a
  successful add stops the batch and tells the user to check the diary, so nothing is duplicated silently.
  A deploy that changes the *structure* of the client (not just the hashes) can still defeat the rebuild; then a new
  extension version is needed, which is why the manual `tools/gen_registry.py` route is kept for developers.
* **Review scrutiny.** A page-level request hook plus a host permission on a health site is the kind of thing a
  reviewer looks at closely. Everything is explained honestly in §2, and the data-usage boxes are ticked for what
  the code handles locally too (the store counts local storage and use as handling); do not untick them to make
  review "easier" — an inaccurate disclosure is grounds for rejection or later removal.
* **Single-purpose policy (0.3.0).** The Chrome Web Store requires an extension to have a single, narrow purpose.
  0.3.0 adds a second feature (the Adaptive TDEE tab) to a "multi-add" extension, and the single-purpose statement in
  §2 was widened honestly to cover both ("a companion for the Cronometer web diary: log many foods at once and
  estimate energy expenditure from the intake and weight already logged there"). A reviewer may still push back on
  two features. The fallback is to ship the TDEE tab as a **separate listing** (its own extension built from
  `src/tdee/` and `src/ui/tdee-view.js` plus the shared capture / rpc layer) and to remove it from this one; do not
  hide the feature or understate it to get through review.
* **TDEE data not yet verified live.** The Adaptive TDEE reads were reconstructed from Cronometer's compiled client
  and have not been checked against a live account (SPEC §12.6). The tab's *Check the numbers* block lets a user
  compare them with the diary; expect early reports and a data-layer fix (with a `ROW_LAYOUT_VERSION` bump) before
  recommending the tab widely. The upgrade from 0.2.x also changes what the extension reads and stores (health
  history after consent), so the privacy answers above must be submitted with this version.
* **Support load.** Users will report failures caused by Cronometer changes. The Diagnostics dump (no secrets) is
  designed for that; point the Support URL at an issue tracker and ask for the dump plus the input lines.
