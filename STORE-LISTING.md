# Chrome Web Store listing — Multi-Add for Cronometer

Every text and file the Chrome Web Store **Developer Dashboard** asks for, checked against the store's published
rules (developer.chrome.com/docs/webstore, September 2026). Copy the fenced blocks as they are: they are plain text,
the store shows them verbatim. [SUBMISSION-CHECKLIST.md](SUBMISSION-CHECKLIST.md) is the short, ordered version that
says which block goes into which dashboard field and which steps only the account owner can do.

* Package: `python tools/build_zip.py` → `dist/multi-add-for-cronometer-<version>.zip` (the version is the one in
  `manifest.json`; this listing is written for **0.3.2**). Name, summary, version, icons and permissions come from
  the manifest in the zip and cannot be edited in the dashboard: changing them needs a version bump and a new zip.
* Repository-derived URLs are already filled in (`python tools/set_repo_url.py https://github.com/fabbeskw/multi-add-for-cronometer --check`
  exits 0). The item id is `eggnohhalgffodifhpdpedeofilfffhd` (approved and published, Unlisted, 2026-09-29).
* Character counts in brackets were measured on the text inside the block. The store documents 132 characters for
  the summary; the limits of the *single purpose*, *permission justification* and *test instructions* fields are
  not documented (about 1,000 characters is commonly reported), so every block for those fields is kept under 1,000.

---

## 1. Store listing tab

### Name (from the manifest; max 45)

```
Multi-Add for Cronometer
```

The "X for Cronometer" pattern names a third-party tool without implying it is an official product. No Cronometer
logo, wordmark or brand colour is used anywhere in the package or the listing; the icons and promo tiles are
original art.

### Summary (from the manifest `description`; max 132 — 129 used)

One subject (logging in the user's own diary) with two functions, matching the single-purpose text in §2.

```
Unofficial, not affiliated: faster Cronometer web diary logging - add a whole list of foods at once and track your adaptive TDEE.
```

### Category

**Tools** ("tools that don't fit into other categories"). The store has no Health & Fitness category;
*Well-being* ("self-help, mindfulness, and personal development") is the only other defensible choice and fits the
food diary less well. Pick Tools unless the dashboard's list has changed.

### Language

**English** (the extension's UI is English only).

### Detailed description (plain text; the store shows it verbatim, no Markdown)

The brand word appears five times in this text, URLs included (the store flags "unnatural repetition of the same
keyword more than 5 times"): keep it at five or fewer when editing. No superlatives, no testimonials, no list of
sites.

```
Log a whole meal in one step instead of one food at a time, and see what your logging says about the energy you really burn.

This unofficial extension adds a small panel to the Cronometer web diary. The web app's Add Food dialog closes after every food; with the panel you open your diary, press Alt+Shift+M (or click the Multi-add button) and type or paste one food per line:

  200g chicken breast
  1 1/2 cups rice, cooked
  2 large eggs @breakfast

Press "Find foods", check the matches in a preview table (change the food, amount, unit or diary group of any line), then press "Add all". Every line goes into the day you are viewing, in the group you chose. A batch added with the fast engine (the default) can be undone with one click for 24 hours.

WHAT THE LIST UNDERSTANDS
- grams, kg, oz, lb, ml, l, cups, tbsp, tsp, slices, pieces, servings, large / medium / small and each food's own measures
- fractions and decimal commas (1 1/2 cups, ½ cup, 1,5 cups)
- multipliers (2 x 100g yoghurt, eggs x2)
- calories (300cal almonds, almonds 300 kcal, 1250kJ almonds): as much of the food as has that many calories, worked out from the food's own calorie figure
- group headers (## Dinner, Dinner:) and per-line tags (@lunch)
- two foods on one line (oats 40 g, milk 200 ml); blank lines and comments are ignored

TWO WAYS TO ADD
- Fast (default): sends the same request the diary sends when you add a food yourself, one food at a time with a short pause, then refreshes the diary.
- UI automation (fallback): drives the diary's own Add Food dialog for you, food by food. Slower, but independent of the web app's internals.
When the web app ships a new version, the extension re-reads the app's public script files as text to update the table it uses to understand the diary's replies. Nothing it downloads is ever run. "Rebuild decoder" in the Diagnostics tab does the same on demand.

ADAPTIVE TDEE (OPTIONAL, OFF UNTIL YOU TURN IT ON)
The panel's TDEE tab turns the food and weigh-ins you already log into an estimate of the energy you really burn each day. It shows the estimate with its uncertainty, compares it with the diary's own burned figure, charts expenditure and trend weight, and offers a weekly check-in with a suggested calorie and macro target for your goal (lose, maintain or gain). The target is a suggestion: you set your targets in the diary yourself. The tab first explains what it reads and stores, and reads nothing until you press Enable. You can also import the diary's own CSV exports. Estimates only, not medical advice; not suitable during pregnancy or with medical conditions that affect weight or fluid balance.

PRIVACY
- Works only inside your own logged-in diary tab. No other website is contacted.
- No account with us, no analytics, no telemetry, no ads, no third parties, no data sold.
- Your session is used in memory only and is never stored.
- Before first use the panel shows what it reads and keeps, and waits for you to press Continue.
- Kept in your browser only: settings, undo information for the last batch, a decoder table with no personal data and, only if you tick "Remember my last typed list" (off unless you do), your last input list. If you enable the TDEE tab, also your intake, burned and weight history, its settings and check-ins; "Delete TDEE data" removes them.
The full privacy policy is linked from this listing.

REQUIREMENTS
- An account for the Cronometer web app. The mobile apps are not supported.
- After installing, open your diary at cronometer.com/#diary and reload the tab once.

DISCLAIMER
Unofficial and independent: not affiliated with, endorsed by or supported by Cronometer Software Inc. The name is used only to say which website the extension works with. The extension acts on your own account through the same requests the web app makes; use it at a reasonable pace and within the site's Terms of Service. Use at your own risk.

Source code, privacy policy and support: https://github.com/fabbeskw/multi-add-for-cronometer
```

### Trademark sentence (paste into any field that asks how third-party marks are used)

```
Multi-Add for Cronometer is an unofficial, independent extension and is not affiliated with, endorsed by or supported by Cronometer Software Inc.; "Cronometer" is a trademark of its owner, used only to identify the website the extension works with, and no Cronometer logo or brand asset is used.
```

### Graphic assets

The store's images page: "Only the extension icon, a small promotional image, and a screenshot are mandatory."

| Asset | Size / format | Required | File |
|---|---|---|---|
| Store icon | 128 × 128 PNG: 96 × 96 artwork centred with 16 px transparent padding per side; works on light and dark backgrounds | **yes** (taken from the zip) | `icons/icon128.png` |
| Screenshots | 1280 × 800 (preferred) or 640 × 400, PNG or JPEG, square corners, full bleed (no frame, no padding) | **yes**, at least 1, up to 5 (use all 5) | the five shots below, in order |
| Small promo tile | 440 × 280 PNG or JPEG, fills the whole tile, little or no text | **yes** (listings without it are shown after those that have it) | `store-assets/promo/small-promo-440x280.png` |
| Marquee promo tile | 1400 × 560 PNG or JPEG | optional (only used for the featured carousel) | `store-assets/promo/marquee-1400x560.png` |
| Promo video | YouTube link | optional (the images page names only icon, small tile and screenshot as mandatory) | none |

The icons and both promo tiles are rendered from the SVG/HTML sources in `graphics/` by `tools/make_graphics.py`
(original art: a list with a plus; no Cronometer logo, wordmark or colour; no claims such as "Editor's Choice").
Tile text: the name, the value line "Faster diary logging: a whole meal at once · adaptive TDEE from your log" (one
subject, two bullets, on the small tile; "Faster diary logging · adaptive TDEE" on the marquee) and
"Unofficial — not affiliated with Cronometer".
Promo images go through their own short review after upload and cannot be localised.

#### The five screenshots (all 1280 × 800, in this order)

| # | Shot | What it shows | Data shown |
|---|---|---|---|
| 1 | **Input** | the panel open over the diary with a typed list (`## Dinner` header, a fraction, a size word, an `@snacks` tag) | the sample list |
| 2 | **Preview** | the table after *Find foods*: matched food, amount, unit, grams and group per line, *Add all* | Cronometer's public food database |
| 3 | **Diary** | the diary day after *Add all* with the four new entries in Dinner and Snacks (panel closed) | the four sample entries only, on an empty future day, undone after capture |
| 4 | **TDEE overview** | the TDEE tab: expenditure estimate with its uncertainty, comparison with the diary's burned figure, charts | **synthetic demo history**, no real person's intake or weight |
| 5 | **TDEE check-in** | the weekly check-in with a suggested calorie and macro target | **synthetic demo history** |

The files are `01-input.png`, `02-preview.png`, `03-diary.png`, `04-tdee-overview.png` and `05-tdee-checkin.png`;
the capture date and what was blurred are recorded in `store-assets/manifest.json` (written by the live run) and
explained in `store-assets/README.md`; `python tools/screenshots.py` renders the set from the real extension. Before
uploading, open every PNG and check that no name, e-mail, account number or real health figure is visible. The
store's rule is that screenshots "demonstrate the actual user experience" of the current version: all five show the
real panel, and the TDEE shots use demo data because the tab shows health data. The set was captured live with 0.3.1
on 28 September 2026 (`store-assets/manifest.json`) and is reused for 0.3.2, which changes none of these five views
(the cheat-sheet in shot 1 is collapsed, and the preview footer names no search scope while *Search only my custom
foods* is off).

### Additional fields

| Field | Value |
|---|---|
| Official URL | leave empty (it is for a verified site you own; never cronometer.com) |
| Homepage URL | `https://github.com/fabbeskw/multi-add-for-cronometer` (also `homepage_url` in the manifest since 0.3.1) |
| Support URL | `https://github.com/fabbeskw/multi-add-for-cronometer/issues` |
| Mature content | No |
| Google Analytics ID | leave empty (the extension has no analytics) |

---

## 2. Privacy tab

### Single purpose description [≈ 640 characters]

```
Faster food and energy logging in the user's own Cronometer web diary. The extension works only on cronometer.com, inside the user's logged-in diary tab, and only on that user's diary. It serves this one purpose in two ways: it adds a whole typed list of foods to the diary in one step instead of one search per food, and, optionally and only after the user presses Enable, it turns the food and weight entries already logged in that same diary into an estimate of daily energy expenditure with a suggested weekly calorie target that the user sets in the diary themselves. It has no other function, contacts no other site and shows no ads.
```

Why this is one purpose and not two: the store's FAQ allows a single purpose defined by "a narrow focus area or
subject matter", and an extension "can offer various functions related to that focus area". Here the subject is
the user's own food and energy log on one website; both functions read or write only that log, from the same
panel, with the same session and the same host permission. The TDEE function does not work without the diary and
adds no permission. If a reviewer still rejects it under the single-purpose policy, see §6.

### Permission justification — `storage` [≈ 770 characters]

```
Keeps data on the user's device only (chrome.storage.local; nothing is synced or sent): the extension's settings and whether its first-run notice was acknowledged; the ids of the last batch of added diary entries with the account id, for a 24-hour undo; a decoder table derived from Cronometer's public web client and a note on its last rebuild (no personal data); and, only if the user ticks "Remember my last typed list" (off by default; switching it off deletes it), the last typed food list with the account id, so it is restored only for that account. Only after the user presses Enable in the optional TDEE tab: a copy of the user's daily intake, energy-burned and weight history, the tab's settings, day decisions and check-in log. "Delete TDEE data" removes those.
```

### Permission justification — host permission `https://cronometer.com/*` [≈ 940 characters]

```
The extension works only on the Cronometer web app and contacts no other host. It needs this origin to: (1) show its panel on the diary page; (2) observe, in the user's own tab, the app's same-origin requests to its own server through a page-level XMLHttpRequest hook, to learn the session, account id and diary date without asking for credentials (the session token stays in memory); (3) send the requests the app itself sends when a food is added by hand: food search (the site's own HTTPS endpoint, whose query-parameter format the site defines), add entry, remove entry (undo); (4) after a Cronometer release, download the app's public script files and parse them as TEXT into a data table used to read the app's replies, never executed; (5) only after the user presses Enable in the optional TDEE tab, send the app's own read-only requests for the user's intake, energy-burned and weight history. Nothing is sent to any other server.
```

### Remote code

Answer **"No, I am not using remote code."** If the dashboard offers a justification field, paste:

```
All code is in the package; there is no eval, no new Function and no script loaded from outside it. After a Cronometer release the extension downloads the web app's own public .cache.js files from cronometer.com and parses them as plain text to rebuild a data table (type names, checksums, field layouts) that its packaged decoder uses; nothing downloaded is executed or interpreted as instructions.
```

### Data usage — what to tick

The store counts collecting, using or storing data **even locally** as handling it (User Data FAQ: disclosure is
required "even when data is processed or stored locally on a user's device and is not transmitted"). Tick by what
the code does:

| Data type (store definition) | Tick | What the extension does |
|---|---|---|
| **Personally identifiable information** ("identification number") | **yes** | the numeric Cronometer account id is read from the app's traffic and stored next to the last input and last batch (`cmaLastInput`, `cmaLastBatch`) and in every `cmaTdee*` record |
| **Health information** | **yes** | the typed food list (dietary data) is sent to the site's food search, written to the diary and, only if the user ticks *Remember my last typed list*, remembered in `cmaLastInput`; after **Enable**, per-day intake, energy burned and weigh-ins (`cmaTdeeDays`), the TDEE settings, day decisions and check-ins (`cmaTdeeSettings`, `cmaTdeeOverrides`, `cmaTdeeCheckins`) and the consent / refresh record (`cmaTdeeSync`) are stored locally |
| Financial and payment information | no | not handled |
| **Authentication information** ("credentials", "authentication cookies") | **yes** | the session token is read from the app's own requests, held in memory only and sent back to cronometer.com with each request; never stored, never logged |
| Personal communications | no | not handled |
| Location | no | not handled |
| Web history | no | no other site and no browsing history is read |
| **User activity** ("network monitoring") | **yes** | the page-level XMLHttpRequest hook observes the web app's requests to its own server in the user's tab |
| **Website content** | **yes** | the site's replies (the diary day, food details; after **Enable**, the daily energy rows, weigh-ins, calendar flags and three preferences) are decoded to place entries and compute the estimate |

Certify all three statements (they are true):

* not being sold to third parties, outside of the approved use cases — **certify**
* not being used or transferred for purposes unrelated to the item's single purpose — **certify**
* not being used or transferred to determine creditworthiness or for lending purposes — **certify**

The matching Limited Use statement is in `PRIVACY.md` §6, one click from the listing.

### Privacy policy URL

```
https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md
```

`blob/HEAD` resolves to the repository's default branch. The policy lists every storage key and every kind of
request; it must stay public and reachable for as long as the item is published.

---

## 3. Test instructions tab

A **dedicated free test account** is part of the submission (SUBMISSION-CHECKLIST step A5): created for the review,
never the owner's personal account, with about three weeks of synthetic food entries and daily weigh-ins, so the TDEE
tab shows an estimate instead of "log a few days first". Its login goes **only into this dashboard tab** (the
username / password fields when the tab has them, otherwise typed by the owner on a line after the block), never
into the repository, the listing or an issue. Paste exactly one of the two blocks below; neither has a placeholder.

### Test instructions — with the test account (use this one) [≈ 946 characters]

```
Test account (synthetic data, made for this review): login in this tab. It holds about three weeks of synthetic food entries and daily weigh-ins.
1. Install, log in, open https://cronometer.com/#diary and RELOAD the tab once (the extension reads the app's start-up requests).
2. Press Alt+Shift+M (or Ctrl+Alt+M, or the Multi-add button bottom right). The toolbar icon shows these steps. The first time, read the short notice and press Continue.
3. Paste: 200g chicken breast / 1 cup rice, cooked / 2 large eggs (one per line). Press Find foods, then Add all: the entries appear in the diary. Press Undo this batch to remove them.
4. TDEE: open the TDEE tab, read the notice, press Enable. After the first read (about a minute) it shows an energy expenditure estimate and a weekly target from the account's history. Settings > Delete TDEE data clears it.
Nothing leaves cronometer.com. Reviewer notes: see the next field or the repository README.
```

### Test instructions — without a test account (fallback only) [≈ 909 characters]

```
Needs a Cronometer web account; a free one from https://cronometer.com is enough for steps 1-3.
1. Install, log in, open https://cronometer.com/#diary and RELOAD the tab once (the extension reads the app's start-up requests).
2. Press Alt+Shift+M (or Ctrl+Alt+M, or the Multi-add button bottom right). The toolbar icon shows these steps. The first time, read the short notice and press Continue.
3. Paste: 200g chicken breast / 1 cup rice, cooked / 2 large eggs (one per line). Press Find foods, then Add all: the entries appear in the diary. Press Undo this batch to remove them.
4. TDEE (optional): open the TDEE tab, read the notice, press Enable. A new account has no history, so the tab then asks for a few days of food and weight entries first; that is the expected state. Settings > Delete TDEE data clears it.
Nothing leaves cronometer.com. Reviewer notes: see the next field or the repository README.
```

### Reviewer notes [≈ 2,303 characters] (paste after the instructions if the field accepts more text; otherwise keep it ready for a reviewer's question)

```
How it works, for review:
- src/hook-main.js runs in the page's MAIN world at document_start on cronometer.com only. It wraps XMLHttpRequest to observe the web app's own requests to /cronometer/app, /cronometer/pro and /api/ on the same origin and relays them over a MessageChannel port (not the window message bus) to the content script. That is how the extension learns the session and diary date without asking for a password. Because it must see the app start, the session and account id are already in memory when the first-run notice appears; the notice says so, and neither is ever stored. It sends nothing itself and ignores other hosts.
- All requests the extension makes go to cronometer.com with credentials same-origin: food search, getFood, getDayInfo, updateDiary (add), removeServing (undo) and, only after the user enables the TDEE tab, five read-only calls (getCaloriesConsumedAndBurned, getBiometrics, getCalendarInfo, getFirstDayWithData, getPreference). The food search uses the web app's own same-origin HTTPS endpoint, whose format (the food name as a query parameter) is defined by the site, not by the extension.
- src/lib/gwt-registry.js is generated DATA, not code: a table of the web app's serialised types, produced by tools/gen_registry.py in the public repository. The hex strings are the app's public build hashes; short names such as "U0n" are the compiled app's own function names the decoder recognises. Its serviceMethods and policies lists name every RPC method and service of the web client ("adServed", "admin" included) for recognition only; the extension calls only the methods above.
- After a Cronometer release, src/lib/registry-builder.js downloads the app's public .cache.js files from cronometer.com and parses them as text into the same kind of table. Nothing downloaded is executed; there is no eval anywhere.
- src/tdee/adaptive-tdee.js is a generated wrapper around the unmodified engine in vendor/adaptive-tdee/ (tools/gen_tdee.py).
- Consent: the panel shows a first-run notice (what is read and kept, with an unticked, opt-in remember-list choice) and nothing typed is stored before Continue; the TDEE tab reads nothing before its own Enable.
- No analytics, no other host, no remote code. Source: https://github.com/fabbeskw/multi-add-for-cronometer
```

---

## 4. Distribution tab

| Setting | Recommended | Why |
|---|---|---|
| Payment | Free | |
| Visibility | **Unlisted** for the first release, **Public** later | Unlisted items get the same review but no listing: anyone with the link can install. Share it with a few users, wait for the first Cronometer deploy to confirm the automatic decoder rebuild in the wild, then change the visibility to Public and **republish** (the store's update docs say "change your visibility ... and then republish"; assume it can be reviewed again). |
| Regions | All regions | |

---

## 5. Publishing and updates

The owner-only steps (developer registration and fee, mandatory 2-Step Verification, verified contact e-mail,
trader / non-trader declaration, Submit) and the field-by-field order are in
[SUBMISSION-CHECKLIST.md](SUBMISSION-CHECKLIST.md). Facts to plan around:

* **Review time:** "For most extensions, review is completed within a few days, but it can take up to a few weeks."
  New developers, new extensions and hard-to-review code get closer review; contact developer support if it is
  pending for more than three weeks.
* **After approval** the item publishes automatically unless deferred publishing was chosen; a deferred approval
  must be published within **30 days** or it goes back to draft.
* **Item page**: <https://chromewebstore.google.com/detail/multi-add-for-cronometer/eggnohhalgffodifhpdpedeofilfffhd> (in the README *Install* section since 0.3.2).

### Publishing an update

1. Raise `"version"` in `manifest.json` (the store refuses a package whose version is not higher than the published
   one) and add the changelog line to README.md.
2. Green bar: `bash tests/run.sh`, `python tools/check_manifest.py`, `python tools/gen_tdee.py --check`,
   `python tools/build_zip.py`, `python tools/smoke_extension.py --self-test`,
   `python tools/screenshots.py --dry-run --headless`, `python tools/make_graphics.py --verify`.
3. Dashboard → the item → *Package* → *Upload new package* → the new zip → *Submit for review*. If the panel changed
   visibly, upload new screenshots; if data handling changed, update `PRIVACY.md` (effective date), the Privacy tab
   answers and this file **before** submitting.
4. Users get the update automatically within hours of approval.

---

## 6. Risks and how this listing answers them

| Risk (store violation code) | What could trigger it | Mitigation in this submission | If it happens |
|---|---|---|---|
| **Single purpose** (Red Magnesium / Red Lithium) | bulk add plus a TDEE estimate read as two products | §2 frames one subject (the user's own food and energy log on one site); the TDEE part is optional, off by default, uses no extra permission | ship the TDEE tab as a **separate listing** (its own extension from `src/tdee/`, `src/ui/tdee-view.js` and the shared capture / rpc layer) and remove it here; new publishers may publish two items, so this fits. Never hide or understate the feature to pass review. |
| **Disclosure and consent** (Purple Nickel; the 2026 rule enforced from 1 August 2026 requires in-product disclosure and an affirmative consent before *any* collection) | the request hook reads the session from page load on (in memory only), before any in-product notice | since 0.3.1 the panel shows a first-run notice (what is read and kept locally, that the session and account id were already read from the page's start-up requests and are held in memory only, nothing sent elsewhere, an unticked opt-in remember-list choice, a link to the policy) and waits for **Continue** before its multi-add views; nothing typed is stored before that, and the typed list only if the user ticks the box; the TDEE tab has its own notice and **Enable**; policy, listing and data-usage answers describe all of it | if a reviewer still asks for consent before the hook observes anything, gate the capture itself behind the acknowledgement (the hook would then need a page reload after Continue) |
| **Remote code** (Blue Argon) | the decoder rebuild downloads `.cache.js` files | "No remote code" with the explanation in §2 and the reviewer notes: parsed as text, never executed, no eval | point the reviewer at `src/lib/registry-builder.js`; if still refused, drop the runtime rebuild and ship registry updates as new versions (the UI engine keeps working meanwhile) |
| **Obfuscation** (Red Titanium) | hash strings and short compiled names in `src/lib/gwt-registry.js` | the file is readable generated data with a header; the generator is public; nothing is minified | explain in the reply; link `tools/gen_registry.py` |
| **Disclosure mismatch / privacy policy** (Purple Lithium, Red Nickel) | ticked boxes, description and code disagreeing; the page-level hook not mentioned | every box ticked for local handling too; the hook, the rebuild and the TDEE reads are named in the description, the justifications and the policy | fix the text, not by unticking; resubmit |
| **Not working at review** (Yellow Magnesium) | reviewer has no account, or skips the reload; the TDEE tab shows no estimate on an empty account; TDEE history reads not yet verified against a live account (SPEC §12.6) | the account requirement is stated in the description and the popup; test instructions with a reload step; a **required** dedicated test account with about three weeks of synthetic food and weigh-ins, on which the owner verifies the TDEE tab live before submitting (SUBMISSION-CHECKLIST A5, B) | reply with the steps; if a TDEE read broke after a Cronometer deploy, fix it and resubmit |
| **Metadata** (Yellow Zinc, Yellow Argon) | outdated screenshots, missing required tile, keyword repetition | five current screenshots including the TDEE tab, required small tile, brand word ≤ 5 times | regenerate and resubmit |
| **Impersonation / trademark** (Red Potassium, Red Silicon) | the name contains the site's brand | "X for Cronometer" naming, "Unofficial" first word of the summary, disclaimer, no brand assets | rename only if the trademark owner or the store asks |
| **Cronometer's Terms of Service** | an unofficial client automating the user's own account | human pace (one request at a time, 250 ms delay, throttling respected), no scraping of other users; the listing tells users to follow the site's terms | unpublish if Cronometer asks |
| **Cronometer deploys** | a new build changes the wire format | automatic decoder rebuild, UI-automation fallback, a batch stops on an unreadable reply instead of duplicating | new version; `tools/gen_registry.py` for developers |

The TDEE tab's first read (and its weekly full refresh) of up to five years is about 70–90 read requests in a row,
250 ms apart, in windows of up to 92 days (a refused window is halved down to 28); afterwards 3 requests for the last
14 days when the tab is opened (at most every 10 minutes) and about 30 seconds after the user's diary edits. This is
the heaviest traffic the extension produces and the part to throttle further if Cronometer objects.
