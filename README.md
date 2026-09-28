# Multi-Add for Cronometer

A Chrome extension (Manifest V3) that lets a logged-in [Cronometer](https://cronometer.com) **web** user add many
foods to the diary in one go. The web app's *Add Food to Diary* dialog closes after every add and has no
multi-add, so logging a whole meal means one search per item. This extension takes a list of lines such as

```
200g chicken breast
1 1/2 cups rice, cooked
2 large eggs @breakfast
```

searches Cronometer for each line, lets you check the matches, and adds them all to the diary date you are viewing.

Since 0.3.0 the panel also has an optional **TDEE** tab: an *adaptive* estimate of the energy you really burn,
learned from the food and the weight you already log in Cronometer (the approach MacroFactor popularised), with a
weekly check-in that suggests a calorie and macro target. It reads nothing until you enable it; see
[*Adaptive TDEE*](#adaptive-tdee).

Plain JavaScript, no build step, no npm, no external servers: everything talks to `cronometer.com` from inside the
tab you are already logged into.

> **Unofficial.** This is an independent, open-source tool. It is not affiliated with, endorsed by or supported by
> Cronometer Software Inc.; "Cronometer" is used only to name the website it works with, and no Cronometer logo or
> brand asset is used. See *Terms of service* at the end.

> **Status:** working, live-tested on 2026-09-28 (foods added through the RPC engine and undone; the UI-automation
> engine also verified). The RPC path is reconstructed from Cronometer's compiled web client and mirrors what the
> app itself sends. Because Cronometer redeploys often, the extension ships two engines, an undo, a runtime decoder
> rebuild and a diagnostics dump (see *Reporting a failure*). The **Adaptive TDEE** tab (0.3.0) is new and its
> history reads have **not** been checked against a live account yet: compare its *Check the numbers* block with
> your diary before you rely on it (see *Adaptive TDEE*).

## Install

Three ways in; all of them end with the same *reload the Cronometer tab once* step.

**Install from the Chrome Web Store** — *coming soon* (0.3.1 is prepared for submission). Once the listing is
approved the store page will be `<Chrome Web Store URL>` (see *Publishing*): open it, click **Add to Chrome**, then
continue at step 5 below.

**From a release zip** (no git, no Python; only Chrome's *Developer mode*):

1. Download `multi-add-for-cronometer-<version>.zip` from the latest entry on the Releases page,
   <https://github.com/fabbeskw/multi-add-for-cronometer/releases> (it is the exact package that goes to the store, built by `tools/build_zip.py`).
2. Unzip it into a folder you will keep — Chrome loads the extension from that folder on every start, so deleting
   or moving it breaks the install.
3. Open `chrome://extensions` (or Edge/Brave: their extensions page), turn on **Developer mode** (top right), click
   **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
4. Continue at step 5 below.

**From source** (developer mode):

1. Clone the repository, `git clone https://github.com/fabbeskw/multi-add-for-cronometer.git`, or download it as a zip from <https://github.com/fabbeskw/multi-add-for-cronometer> and unpack it.
2. Open `chrome://extensions` in Chrome (or Edge/Brave: their extensions page).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Open <https://cronometer.com/#diary> and **reload the tab once**. The extension must be present when the app
   starts, because it learns your session from the app's own start-up traffic. A tab that was already open before
   the extension was loaded shows *"Reload the Cronometer tab so the extension can see the app start"* in the panel.

No sign-in, no API key: it uses the session of the tab you are in.

## Screenshots

The five store screenshots (1280 × 800: the input list, the preview, the diary after *Add all*, the TDEE overview
and the TDEE weekly check-in) live in [store-assets/](store-assets/) and double as a visual tour. They are rendered
by `python tools/screenshots.py` (`python tools/screenshots.py --help` lists the modes and the output names), so they
can be regenerated after any change to the panel instead of being retaken by hand. They are privacy-safe: personal
UI is blurred, the multi-add shots are taken on an empty future day of the diary that holds only the four sample
entries the tool adds (and removes again afterwards), and the two TDEE shots use synthetic demo history, never a
real person's intake or weight. The PNGs are not committed (a live run shows the owner's diary page); until the
owner's live run of the current version, `store-assets/` holds no uploadable set. The store promo tiles are in
[store-assets/promo/](store-assets/promo/).

## Usage

Open the diary and press **Alt+Shift+M** (or **Ctrl+Alt+M** — on Windows with several keyboard layouts, Left
Alt+Shift also switches the input language), click the **Multi-add** button in the bottom-right corner, or click the
**MULTI** button that appears next to **FOOD** in the diary toolbar. (The extension's toolbar icon only shows these
instructions; the panel appears on pages where the Cronometer app runs, not on the logged-out landing page or the blog.
Ctrl+Alt+M is ignored while you are typing in a text field, because Windows reports AltGr as Ctrl+Alt.)

The first time, the panel shows a short notice of what the extension reads and keeps (with the choice *Remember my
last typed list*) in place of the Input view; press **Continue** to start. It is shown once per browser profile.

1. **Input** – paste or type one food per line (format below). Pick the default group, check the diary date (taken
   from the diary you are viewing; you can override it) and press **Find foods**.
2. **Preview** – one row per line: the matched food (a dropdown of the top 10 search hits), quantity, unit
   (a dropdown of that food's measures), the resulting grams, the diary group and a status.
   `✓` ready, `?` you need to pick a unit (the unit you typed does not exist for that food — the dropdown stays on
   *choose…*, names a suggestion when there is one, and a **Use …** button accepts it), `✗` cannot be added
   (no results, parse error). When you pick a unit for a `?` row the quantity you typed is converted into it
   (`150 g` → 3 × *large* of 50 g) or, when that is not possible (150 g cannot become 150 *full recipes*), reset to
   1 with a note. `?` also marks a line typed **without a unit** whose default measure is plain grams (`2 eggs` on a
   food that would start on *g*): the dropdown names a count-like suggestion (*large*, *bar*, *serving*). Picking a
   unit there, or **Use …**, keeps the number you typed as a count of that measure (2 × *large*) — the conversion
   above happens only when you typed a unit. Changing the quantity of a `?` row only stores the number; the row
   stays `?` until you pick a unit. For recipe-type measures the quantity is a count of servings and the Grams column
   shows the total. Fix what you want, remove lines with `×`, then press **Add all**.
3. **Results** – one line per row with `✓`/`✗` and a message. A `✓` with a note ("added (group … kept)", "added;
   the reply could not be read") means the entry is in the diary but not exactly as planned — read the note. From
   here you can **Undo this batch** (removes exactly the entries that were just added), **Reload page** (if the
   diary did not refresh by itself — the summary says when the extension could not confirm the refresh) or **Done**.

Settings (engine, delay between adds, remember last input) are in the **Settings** tab and are stored in your
browser profile only. *Remember last input* is **off unless you tick it** (the first-run notice shows it as an
unticked box, *Remember my last typed list*): when it is on, the list you typed is kept (with your account id) so it
is back when you reopen the panel; switch it off to stop, which also clears the stored copy.

### Input format cheat-sheet

| You type | Meaning |
|---|---|
| `200g chicken breast` / `chicken breast 200 g` / `chicken breast, 200g` | 200 g of the best match for *chicken breast* |
| `2 large eggs` | 2 × the measure named *large* |
| `2 eggs` | 2 × the food's default measure (the one the search row shows, else the food's own default). When that default is plain grams and the food has other measures, the row asks you to pick a unit and suggests one (*large*) — it never logs 2 g |
| `eggs x2`, `2x eggs`, `×2` | same as above |
| `1 1/2 cups rice, cooked`, `½ cup oats`, `1,5 cups` | fractions, unicode fractions and decimal commas work |
| `banana` | 1 × the default measure (same rule); a food that only has a *g* measure gets 100 g, like the app, and the row says so |
| `0.5 kg potatoes` | converted to 500 g |
| `3 tbsp olive oil`, `100 ml milk`, `1 slice bread` | volume / count units are matched to the food's measures |
| `## Dinner`, `# Dinner`, `Dinner:` | every line below goes to *Dinner* (until the next header) |
| `salmon 150g @lunch` | this line goes to *Lunch* (`@` tag at the start or end; group names match by prefix) |
| `# leftovers from yesterday`, `// a comment`, blank lines | ignored (a `#` line only switches the group when it looks like a group name: one word, or two words such as `Group 6` / `Second breakfast`) |
| `2 x 100g yoghurt`, `yoghurt 2 x 100g`, `protein bar 60g x2` | multipliers: 200 g, 200 g, 120 g |
| `oats 40 g, milk 200 ml` | two foods on one line, each with a quantity and unit, become two rows |
| `2% milk 1 cup`, `7up 330 ml` | a number glued to `%` or to a non-unit word stays in the name |
| `Breakfast` (a bare group name) | flagged in the preview — write `## Breakfast` or `Breakfast:` to switch groups |

Known units: `g kg mg oz lb ml l fl oz cup tbsp tsp slice piece serving large medium small xl xs scoop can bottle
packet bar each unit clove` plus common words like `tablet capsule glass bowl handful stick fillet …`. A word after
the number that is not a unit stays part of the food name (`2 cupcakes` → 2 × default measure of *cupcakes*).

Mass units always work for foods with a weight (grams are sent as grams; if the food has no *g* measure the quantity
is converted and the row says *shown as …*); a recipe that only has serving/"full recipe" measures is converted to a
number of servings when it knows its grams, otherwise the row asks you to choose. Volume units are converted between
ml/cup/tbsp/tsp when the food only has another volume measure. Anything else must exist as a measure on that food,
otherwise the row asks you to choose.

## Engines

* **RPC (default, fast)** – sends the same `updateDiary` request the *Add Food* dialog sends, one per food, 250 ms
  apart, then nudges the diary to refresh. Every added entry id is remembered, so **Undo this batch** can remove them
  again (for 24 hours, and only in the account that added them). A request that times out is *not* re-sent — it may
  have gone through — so such a row says "check the diary before re-adding". This is the engine to use normally.
* **UI automation (fallback)** – drives the real *Add Food to Diary* dialog: opens it, types the search, clicks the
  result row (the one from the same food database as the preview), sets group/measure/amount and presses
  *Add to Diary*, for every row. Slower (a few seconds per food) and it needs the diary page visible, but it does not
  depend on the RPC wire format at all: **Find foods** works with it even when no session was captured (rows are
  then marked *unverified* and grams are not previewed). It always adds to the day the diary is showing, so the date
  override is disabled and *Add all* refuses when the preview's date differs — navigate the diary first. A measure
  that the dialog does not offer is converted (the total grams stay right) or the row fails; a row is reported
  added only when Cronometer's own `updateDiary` answer was seen (or the entry is visible in the diary). Every
  fallback the engine had to take (group not offered or disabled, measure converted, an ambiguous result row) is
  written next to that row's tick instead of a plain "added"; a measure click the dialog did not register fails
  the row (the dialog logs whatever its toggle shows). Press **Escape twice** to abort a running UI batch. Custom
  recipes/meals from *My Foods* are only reachable through this engine; a custom *meal* can only be added with the
  dialog's own defaults (Cronometer hides the amount/measure controls for meals), so "2 servings of my meal" fails.

Switch engines in the Input view or in Settings.

## Adaptive TDEE

The **TDEE** tab (between *Results* and *Diagnostics*) estimates your real total daily energy expenditure from what
you actually log, instead of from a formula or a wearable:

* **What it computes.** Every day, a small model (a Kalman filter, the upstream *Adaptive TDEE* engine in
  `vendor/adaptive-tdee/`, used with its maths unchanged) predicts your next weigh-in from your logged intake and its
  current estimate, and nudges the estimate when the scale disagrees. A salty dinner or a water swing barely moves
  it; a real change moves it within a couple of weeks. You see the estimate as *2,480 kcal/day ± 90* with a status
  (*Getting to know you · day 3 of 7*, *Calibrating*, *Up to date*, or *Paused — log food on 4+ of 7 days and weigh in
  at least weekly*), a comparison with Cronometer's own figure (*Cronometer estimates 2,650 — your data says you burn
  about 6% less*), charts of the estimate and of your trend weight, and a History list of the days used.
* **Weekly check-in.** On your check-in day (Monday by default; the first one after a week of data) the tab offers a
  new calorie target for your goal (lose / maintain / gain, as a percentage of body weight per week) with protein,
  fat and carbs, and explains why it changed. You **accept** it or **skip this week**; both are recorded, and the
  target never changes between check-ins. Guardrails: loss is capped at 1% and gain at 0.5% of body weight per
  week, a calorie floor applies (1200 / 1500 / 1350 kcal by the sex you choose, used for nothing else), and once
  the estimate is calibrated the target moves at most 250 kcal per week unless you changed your goal (a goal changed
  and changed back does not count). A check-in comes at most every 6 days, also when you move the check-in day. The
  optional, experimental *activity-aware* line adds food on days Cronometer says you burned more than your 14-day
  average; it never lowers the target while the day is still running (today's burned figure is partial) and never
  goes under the calorie floor.
* **The target is display only.** Nothing is written back to Cronometer: copy the number and set it yourself in
  Cronometer → Targets.
* **Where the data comes from.** When you press **Enable**, the extension reads, through the session of your tab
  and with the same read requests the web app itself makes (`getCaloriesConsumedAndBurned`, `getBiometrics`,
  `getCalendarInfo`, `getFirstDayWithData`, `getPreference`): your daily energy intake, Cronometer's
  energy-burned figures (BMR, activity, exercise and — only if your Cronometer settings count it — the thermic
  effect of food), your weight history in kg and which days have food logged. It reads up to five years once, then
  only the last 14 days when you open the tab (at most every 10 minutes; everything again once a week) and, about 30
  seconds after you stop editing, the days you or the extension just edited in this tab. Today's food and today's
  (still partial) burned figure are never counted (the day is not over), and a day that looks only partly logged
  (under half of your usual intake) is skipped until you answer *Fully logged?* — a run of such days stays skipped
  until you confirm them (about a week of confirmed days makes a lower intake the new normal). You do not need to
  mark days complete in Cronometer; *Only trust completed days* is an option. You can also import Cronometer's own
  CSV exports (*Daily Nutrition* = `dailysummary.csv`, *Biometrics* = `biometrics.csv`; weights in kg, lb or st, the
  earliest weigh-in of a day counts) in the tab's Settings instead.
* **Consent and storage.** Nothing is read until you press **Enable** in the tab. The copy is kept only in this
  browser (`chrome.storage.local`, keys listed under *Privacy*), separately for each Cronometer account: another
  account on the same browser profile gets its own copy and never sees or changes yours. **Delete TDEE data** in
  the tab's Settings removes the logged-in account's copy; removing the extension removes all of them. **Delete TDEE data** in one Cronometer tab also stops the reading in every other open
  Cronometer tab at once.
* **Check the numbers.** The Overview shows the most recent complete day as the extension read it — consumed,
  burned with its parts (BMR + activity + exercise + TEF), the raw values Cronometer sent and your latest weigh-in —
  so you can compare them with the diary's Energy Summary for that day. If they do not match, press *Copy these
  numbers*, add the diary's Consumed and Burned values and open an issue (the Diagnostics dump does not contain these
  numbers; they are your own data, so share only what you want): the history requests were reconstructed from
  Cronometer's compiled client and have not been checked against a live account yet.
* **Units** follow your Cronometer preferences (kcal or kJ; kg, lb or stone) unless you pick others in the tab's
  Settings; when a preference could not be read the tab shows kcal and kg and says so. Colours are neutral on purpose: over or under a target is information, not a judgement.
* **Disclaimer.** Estimates only, not medical advice. Not suitable during pregnancy or with medical conditions that
  affect weight or fluid balance.

While Cronometer's new build is being decoded (see *Runtime decoder rebuild*) or the session is not captured, the tab
shows the stored data and waits; a Cronometer deploy that changes only the TDEE data types turns the tab's refresh
off ("TDEE sync unavailable: …") without affecting the multi-add engines.

## How it works

1. A tiny script hooks `XMLHttpRequest` on the page at start-up and mirrors Cronometer's own traffic to the extension.
2. From that traffic it learns your session token, user id, diary groups and the diary date being viewed (never from
   cookies, never persisted).
3. Each input line is parsed into name / quantity / unit, then searched with Cronometer's food-search endpoint.
4. The chosen food's measures are fetched with the app's `getFood` RPC; the unit you typed is matched to a measure and
   converted to grams.
5. The diary is read once (`getDayInfo`) to place each new entry after the existing ones in its group.
6. One `updateDiary` RPC per food, in the exact GWT-RPC wire format the app uses, followed by a diary refresh.

### Runtime decoder rebuild

Cronometer's replies are GWT-RPC streams: to read them the extension needs a *registry* of the app's serializable
types (names, CRC signatures, field layouts). The registry shipped in `src/lib/gwt-registry.js` was generated from
one compiled build of the app, identified by its *permutation* hash. Cronometer redeploys often, and a deploy can
change signatures or layouts.

Since 0.2.0 the extension handles that itself: when the live permutation (from the app's own traffic) differs from
the registry's, it fetches the current compiled client from `cronometer.com` (`<perm>.cache.js` plus the deferred
`deferredjs/<perm>/N.cache.js` fragments — the same public files the page already downloaded, same origin, no other
host; a fragment that answers 404 ends the list, a transient server or network error is retried three times and
then reported, never mistaken for the end of the list), rebuilds the registry from them with a JavaScript port of
`tools/gen_registry.py` (the analysis takes well under a second; the download is most of the wait), checks it
against the type layouts the engine depends on, stores it under `chrome.storage.local['cmaRegistry']` and activates
it. No Python and no developer tools are involved. While it runs the Input view shows *"Cronometer deployed a new
build — rebuilding the decoder from the live app (about 10 s)…"* with a progress line, then the green *"Decoder
rebuilt for build … (n types)"*; the RPC engine waits for a running rebuild before it searches or adds, and while
the decoder does not match the live build **Add all** is disabled for the RPC engine (the UI engine is not
affected). **Diagnostics** shows the decoder status (active source, decoder build and type count, live build, stored
decoder, last rebuild) and a **Rebuild decoder** button that starts it by hand. One rebuilt decoder is kept and
reused on the next page load until the next deploy (the next rebuild replaces it); a decoder stored by an older
version of the extension is discarded after an update and rebuilt, and the shipped registry always wins for the
build it was generated from. It contains no personal data — only type names, checksums and layouts derived from
code every visitor's browser receives. If the rebuild fails, or the new build lacks a type the engine needs, the
banner says *"Automatic decoder rebuild failed: …"* (or *"Decoder rebuild failed: …"* for a manual attempt), the
RPC engine reports unreadable replies instead of guessing, and the **UI automation** engine keeps working; a failed
automatic attempt is not repeated for 10 minutes, even across page reloads (the outcome is kept under
`chrome.storage.local['cmaRegistryAttempt']`; only an attempt that really failed counts — one interrupted by a
reload, or one whose result could not be saved, is simply repeated), while the button in Diagnostics always
retries at once; when the automatic attempt was skipped, the banner says why. A decoder rebuilt by another
Cronometer tab is picked up by the tabs that are already open. The manual Python route in *Maintenance* remains
for developers who refresh the registry shipped with the extension.

## Reporting a failure

Open an issue at <https://github.com/fabbeskw/multi-add-for-cronometer/issues>. Open the panel → **Diagnostics** → **Copy diagnostics** and paste the JSON
into the report, together with the input lines you used. The dump contains: extension version, whether the hook is installed, your user id, the app's current
permutation and policy hash, the diary groups and where they came from, the diary date, the page address and your
browser's user-agent string, the last 50 log lines of the capture and of the panel, the decoder status (`registry`:
active source, build, type count, stored decoder, last rebuild outcome and problems), a summary of the last
plan/result and, under `views.tdee`, the TDEE tab's state as counts, date ranges and flags only (how many days and
weigh-ins are stored, when it last refreshed, which settings are on) — never a weight, an intake, an expenditure or
a target. It does **not** contain your session token (shown only as `"nonce": "present"`/`"missing"`) or
cookies. The panel log **does** contain the food names you typed and searched (the capture log carries request
paths without the search query); remove lines you do not want to share. For a TDEE figure that does not match the
diary, add the text from *Check the numbers* → **Copy these numbers** (the day's consumed and burned figures and the
raw values Cronometer sent — your own data, copied only when you press it) and the diary's values for that day.

If the RPC engine fails for every row, try the UI automation engine first; it keeps working across deploys because
it only drives the dialog. A banner *"Cronometer deployed a new build"* in the Input view means the live app no longer
matches the serializer registry currently active; the extension rebuilds it on its own (see *Runtime decoder
rebuild* above) and the banner turns green once that succeeded. Diagnostics has a **Rebuild decoder** button to
start the rebuild by hand and shows its outcome; the dump carries the same information (`registry`).

## Limitations

* Cronometer Gold *time of day* on entries is not set (entries are untimed, like a normal toolbar add).
* Custom meals/recipes only via the UI engine; the RPC engine uses the public food search.
* Positions inside a group are computed when you press *Find foods* and refreshed right before *Add all*; if you add
  foods by hand in between, ordering inside the group may be off (never lost, only the order). The position counts
  food entries only; the app itself also counts exercises, notes and biometrics and treats timed (Gold) entries
  specially, so an entry may occasionally sort next to one of those instead of last.
* The preview and results name the diary date the entries are written to (the date is fixed when you press *Find
  foods*); if you move the diary to another day in between, the footer says so.
* Entry ordering: the diary only refreshes from its own requests, so after an RPC batch the extension clicks the
  date-previous/next arrows to reload the day. If that fails, press **Reload page**.
* One request at a time with a delay; large batches (50+) take a while on purpose. Server throttling is respected
  (one 5 s back-off, then the row fails).
* The extension is for the web app at `cronometer.com` only (not the mobile apps, not Cronometer Pro's client view).
* Adaptive TDEE: the history requests have not been checked against a live account yet (the sign and composition of
  Cronometer's burned figures, how many days one request may cover, whether accounts without Gold get the full
  range); use *Check the numbers* and report differences. The history read is limited to five years. The target is
  display only (nothing is written to Cronometer), the activity-aware daily target is experimental, and the CSV
  import accepts `YYYY-MM-DD` dates only.
* Adaptive TDEE keeps one account's copy at a time: if a second Cronometer account enables the tab in the same
  browser profile, its data replaces the first account's (it is never shown to the other account).

## Privacy

* Nothing leaves `cronometer.com`. The extension has host permission for that origin only and never contacts any
  other server. There is no analytics and no telemetry.
* The session token is kept in memory in the tab and is redacted from every log line and from the diagnostics dump.
  It is never written to `chrome.storage`.
* `chrome.storage.local` holds only your settings, the last input text (only if you ticked *Remember my last typed
  list* — switch *remember last input* off in Settings to stop and clear it; stored together with your user id and
  restored only for that
  account, so another account on the same browser profile never sees your list) and the ids of the last batch (for
  undo, together with the date, a timestamp and your user id so the button is shown to the right account only).
  Both can be deleted on demand: *Forget saved input* and *Forget last batch* in the Settings tab. Nothing typed is
  stored before you press **Continue** on the first-run notice, whose acknowledgement is kept as `cmaNoticeAck` (a
  version number, nothing personal).
* **Adaptive TDEE (only after you press *Enable* in the TDEE tab).** The extension then reads your intake, burned
  and weight history from `cronometer.com` (read-only requests the app itself makes) and keeps a copy in
  `chrome.storage.local`, under keys that end with your user id (`cmaTdeeDays:<user id>` and so on), so each account has its own copy: `cmaTdeeDays` (per
  day: energy consumed, Cronometer's burned figure and its parts, the first weigh-in in kg, whether food was logged
  / the day was marked complete, and when it was read), `cmaTdeeSync` (that you enabled it, when it last refreshed,
  the first day with data, your Cronometer TEF / energy-unit / weight-unit preferences, the last refresh error and
  what the last refresh could not read),
  `cmaTdeeOverrides` (days you excluded or confirmed), `cmaTdeeSettings` (goal, check-in day, protein and fat
  choices, sex for the calorie floor, units, dismissed hints) and `cmaTdeeCheckins` (up to 260 check-ins: date,
  accepted or skipped, target, estimate, trend weight, goal, macros). This is health data: it never leaves your browser,
  never appears in logs or in the diagnostics dump (counts only), and **Delete TDEE data** in the tab's Settings
  removes the logged-in account's five keys.
* The runtime-rebuilt decoder registry (type names, checksums, layouts derived from Cronometer's public compiled
  code; no personal data) is also kept in `chrome.storage.local` (key `cmaRegistry`, one record, plus
  `cmaRegistryAttempt`: when the last rebuild ran for which build and whether it worked) so it survives a page
  reload. Rebuilding it downloads Cronometer's own script files from `cronometer.com` inside your tab, exactly as
  the page itself does; they are analysed as text, never executed.
* `document.cookie` is never read.
* The full policy is in [PRIVACY.md](PRIVACY.md): it lists every `chrome.storage.local` key and every kind of
  request, and states that the use of the data adheres to the Chrome Web Store User Data Policy, including the
  Limited Use requirements. The store listing links to the copy in this repository (`tools/set_repo_url.py` fills
  that link, see *Publishing*).
* The page-level relay between the two extension worlds travels over a `MessageChannel` port that the
  extension's content script hands to its page-level hook, not over the window's message bus: only the handshake
  ("ping"/"pong", which carries no data) is visible to other scripts listening on the cronometer.com page
  (including Cronometer's own third-party SDKs), and nothing is relayed before that handshake. The port is not a
  secret (the latest ping's port wins, so a script of the page could hand over its own and would gain nothing it
  cannot already read by hooking the page's requests itself). The relay carries only same-origin request metadata
  and the response bodies the extension decodes. Traffic to other hosts is never relayed or inspected.
* The panel lives in a *closed* shadow root: page scripts cannot read what you typed, the search hits or the
  diagnostics dump through the DOM.

## Maintenance after a Cronometer deploy

The RPC engine reads the app's permutation and policy hash from live traffic, but the type CRCs of the classes it
*sends* (Serving, Day, AddEntryChange) and the layouts of the classes it *reads* come from the registry. A deploy
that changed one of them makes adds fail with *"… the serializer registry is out of date …"* (kind `incompatible`)
or shows up as `decode` lines in the diagnostics ("response could not be decoded (registry stale?)"). If Cronometer
answered `//OK` but the reply could not be read, the entry **is** in the diary: the row is shown as added without an
undo id, the batch stops right there ("stopped: reply unreadable") and the panel asks you to check the diary before
re-adding anything.

The Adaptive TDEE reads use a few more types (the daily energy rows, weigh-ins, calendar flags). A deploy that
changes only those is reported by the rebuilt decoder's check and turns the TDEE tab's refresh off ("TDEE sync
unavailable: …"), never the multi-add engines; the tab keeps showing its stored data.

**Automatic (users):** as soon as the permutations differ the panel starts the *Runtime decoder rebuild* described
under *How it works* (banner *"Cronometer deployed a new build — rebuilding the decoder from the live app"*, then
*"Decoder rebuilt for build …"*); Diagnostics shows the result, and its **Rebuild decoder** button repeats it by
hand at any time (an automatic attempt that failed is not repeated within 10 minutes, page reloads included; an
interrupted or unsaved one is). The UI engine keeps working meanwhile, and the RPC engine's *Add all* stays disabled until the decoder
matches again. Nothing to do unless the banner says *"Automatic decoder rebuild failed: …"* — then report it
(Diagnostics → Copy; the dump carries the rebuild outcome and the validation problems) and use the UI engine until
an update ships.

**Manual (developers):** regenerate the *shipped* registry (`src/lib/gwt-registry.js`, the built-in fallback every
install starts from) so that new installs need no rebuild, and so the unit tests — including
`tests/registry-builder.html`, which checks that the in-extension builder reproduces the generated file exactly —
run against the real build:

```
python tools/fetch_bundle.py                      # downloads the current compiled client into tools/bundle/
python tools/gen_registry.py tools/bundle/all.js  # → src/lib/gwt-registry.js; must print "unknown : 0"
python tools/check_manifest.py                    # manifest.json sanity (files, icons, load order)
bash tests/run.sh                                 # all test pages must print ALL TESTS PASSED
```

Then reload the extension on `chrome://extensions` (or bump the version and publish, see below).
`python tools/make_graphics.py` re-renders the icons and the store promo tiles from their SVG/HTML sources in
`graphics/` (headless Chrome; `--verify` checks the committed PNGs without Chrome).

Tests run in headless Chrome without node: `bash tests/run.sh [page.html]` — see `tests/README-tests.md` for the
list of pages, the runner flags and how to add a page.

## Packaging

```
python tools/build_zip.py            # → dist/multi-add-for-cronometer-<version>.zip
```

Builds the Chrome Web Store package from the working tree: `manifest.json`, `popup.html`, `LICENSE`, `icons/*.png`
and the `.js` files under `src/`, nothing else (tests, tools, docs, `dist/`, and any backup, scratch or non-JS file
under `src/` are excluded). Members are written in sorted order with fixed timestamps and deflated at level 9, so
two builds of the same tree are byte-identical. The script then re-opens the zip and verifies it — the manifest
parses and its name/description/version fit the store's limits, every file the manifest references is present,
no file outside the allow-list slipped in, every `src/` member is referenced by the manifest (an old copy of the
generated registry or a leftover script left beside the shipped ones fails the build), and no text file contains
a Unicode noncharacter (Chrome would refuse to install it) — prints the file list and sizes, and exits non-zero on
any problem. The zip is written under a temporary name and renamed to the release name only when every check
passed (a stale release zip is removed first), so a failed build never leaves a package that looks like a good one.
Run `python tools/check_manifest.py`, `python tools/gen_tdee.py --check` and `bash tests/run.sh` first; the version
in the file name is the manifest's.
The zip snapshots the tree, so rebuild it after any change to `src/` or `manifest.json` (the 0.3.1 package holds 26
files: manifest, popup, license, 4 icons (16, 32, 48, 128) and the 19 scripts; `vendor/` — the pristine upstream TDEE engine — and any
`.mjs` file are never packaged, only the generated `src/tdee/adaptive-tdee.js` is). `dist/` is a build output and is
gitignored: the zip of a tagged version is attached to a GitHub Release (<https://github.com/fabbeskw/multi-add-for-cronometer/releases>), which is where the *From a release
zip* install path points.

To check that the package really installs, run `python tools/smoke_extension.py dist/multi-add-for-cronometer-0.3.1.zip`
(without an argument it checks the working tree). It starts a headless Chrome on a throw-away profile, installs the
extension through the DevTools command `Extensions.loadUnpacked` — the same checks as *Load unpacked* — and opens
the extension's own popup page, expecting its title. Google Chrome 137 and later ignore the `--load-extension`
command-line flag ("not allowed in Google Chrome"), so the classic `chrome --headless --load-extension=… --dump-dom`
smoke proves nothing on a current Chrome; `--self-test` adds a broken-manifest control that must be rejected. The
DevTools-pipe client both tools use lives in `tools/cdp.py`.

## Publishing

[SUBMISSION-CHECKLIST.md](SUBMISSION-CHECKLIST.md) is the ordered path to *Submit for review*: which file or text
goes into which Developer Dashboard field, and which steps only the account owner can do (register and pay the fee,
2-Step Verification, verify the contact e-mail, the trader / non-trader declaration, pressing Submit), plus what to
do on a rejection. [STORE-LISTING.md](STORE-LISTING.md) holds every text block it refers to (summary, detailed
description, single-purpose statement, permission justifications, remote-code answer, data-usage answers, test
instructions and reviewer notes, trademark sentence), the graphic assets (icon, the required 440 × 280 small promo
tile and the optional marquee in `store-assets/promo/`, the five screenshots), the distribution settings (Unlisted
first) and the review risks with their mitigations. The privacy policy to host is [PRIVACY.md](PRIVACY.md); the listing, the policy and
this README refer to the repository through angle-bracket URL placeholders (repository, releases, issues, hosted
policy) that `python tools/set_repo_url.py https://github.com/<owner>/multi-add-for-cronometer` fills in one go
(idempotent, prints every replacement, `--check` fails while any placeholder is left). The five store screenshots
are not taken by hand: `python tools/screenshots.py` renders them from the real extension (shots 1-3 on an empty
future day of the owner's diary with four sample entries that are undone afterwards, the TDEE shots over synthetic
demo data; see
*Screenshots* above and [store-assets/README.md](store-assets/README.md) for what each shot shows, what is blurred
and how to regenerate them); its `--dry-run --headless` self-check is part of the test green bar, and
`python tools/screenshots.py --check-store` says whether `store-assets/` holds an uploadable set (exactly the five
live shots of a completed run; the dry-run pictures of the mock page are never uploaded).

## Terms of service

This is a personal tool that automates actions on **your own** Cronometer account, at human-like pace, through the
same requests the web app itself makes. It is an unofficial, independent project, not affiliated with, endorsed by or
supported by Cronometer Software Inc.; "Cronometer" is a trademark of its owner. Read Cronometer's Terms of Service
before using it, keep batches reasonable, and stop using it if Cronometer asks you to. Use at your own risk.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): how to run the checks (`tools/check_manifest.py`, `tests/run.sh`,
`tools/build_zip.py`, `tools/smoke_extension.py --self-test`, `tools/screenshots.py --dry-run --headless`,
`tools/gen_tdee.py --check`), how to regenerate the decoder registry after a Cronometer deploy, how to update the
Adaptive TDEE engine (`vendor/adaptive-tdee/` → `python tools/gen_tdee.py`; its maths is never edited by hand), the
code rules (classic scripts under the `CMA` namespace guard, no `eval`, no Unicode noncharacters, the session nonce
never logged, no weight or intake in a log or the diagnostics dump) and the rule that a change to data handling updates
[PRIVACY.md](PRIVACY.md) in the same pull request.

## License

MIT — see [LICENSE](LICENSE). Unofficial; not affiliated with Cronometer Software Inc.

## Changelog

* **0.3.1** (2026-09-28) — Chrome Web Store submission build. **First-run notice**: before the multi-add views are
  shown the first time, the panel says what the extension reads and keeps (including that the tab's session and
  account id were already read from the page's start-up requests and are held in memory only, the *Remember my last
  typed list* choice and a link to the privacy policy) and waits for **Continue**; nothing typed is stored before
  that (new key `cmaNoticeAck`, a version number). Remembering the typed list is now **opt-in** (off unless ticked;
  0.3.0 remembered it by default, and a list 0.3.0 kept is deleted when the notice is continued without the tick).
  Nothing new is read or sent. The store summary now names one subject (faster diary logging) with its two
  functions. The TDEE consent text no longer names a
  third-party app, and `src/lib/gwt-registry.js` carries a reviewer note in its generated header. Store graphics: a new icon set (the 128 px store icon now has 96 × 96 artwork with 16 px of transparent
  padding, as the store's image guidance asks; a 32 px icon joins 16/48/128) and the required 440 × 280 small promo
  tile plus the optional 1400 × 560 marquee in `store-assets/promo/`, all rendered from `graphics/` by
  `tools/make_graphics.py`. Privacy-safe screenshots: the set is now input, preview, diary, TDEE overview and TDEE
  check-in, and the TDEE shots use synthetic demo history; `tools/screenshots.py` also blurs the Water card and the
  Daily Target Editor's profile name, refuses a capture when a shown entry row is not one it added, arms its undo
  before Add all and never undoes an older stored batch, refuses to start next to old pictures, writes UTC times, and
  `--check-store` confirms `store-assets/` holds exactly the five live shots. Homepage link: `homepage_url` in the manifest points
  `chrome://extensions` at the public source. The listing texts were checked against the store's published rules
  (single purpose framed as one subject, permission justifications under 1,000 characters, remote-code answer,
  data-usage answers, test instructions and reviewer notes, brand word at most five times in the description,
  corrected review-time and visibility facts); `PRIVACY.md` lists every storage key and request type and states the
  Limited Use commitment; new `SUBMISSION-CHECKLIST.md`. `tools/check_manifest.py` accepts `homepage_url` (a GitHub
  repository URL) and an optional 32 px icon, and requires a description of at most 132 characters that starts with
  "Unofficial".
  **Per-account TDEE storage** (found live): every Cronometer account used in the same browser now keeps its own TDEE
  copy (`cmaTdee*:<user id>`); before, enabling the tab for a second account replaced the first account's settings
  and check-ins. 0.3.0 copies migrate automatically.
* **0.3.0** (2026-09-28) — **Adaptive TDEE** tab (optional, off until you press *Enable*): an expenditure estimate
  learned from your logged intake and weight trend, a comparison with Cronometer's burned figure, charts, a History
  list with per-day exclusions and a partial-day check, a weekly check-in with a display-only calorie and macro
  target (accept or skip; goal as % of body weight per week; guardrails), CSV import of Cronometer's own exports, a
  *Check the numbers* block, units from your Cronometer preferences and neutral colours. The history is read with the
  web app's own read requests (daily energy rows, weigh-ins, calendar flags, first day with data, three preferences)
  and kept in `chrome.storage.local` (`cmaTdee*`, per account since 0.3.1); *Delete TDEE data* removes it; the diagnostics dump
  carries counts only. The upstream engine is kept pristine in `vendor/adaptive-tdee/` and wrapped by
  `tools/gen_tdee.py` (`--check` joins the green bar). The panel gained a small view registry (the TDEE tab is its
  first user), the RPC engine announces its writes so the TDEE data refreshes the edited day, and the packaging
  checks state that `vendor/` and `.mjs` files never ship. A review round before release made *Delete TDEE data* reach
  every open Cronometer tab, keeps partly logged days out until you confirm them, leaves today's partial
  burned figure out of the model, converts stone and orders 12-hour times in the Biometrics CSV import, and keeps
  unsaved TDEE settings through a refresh (SPEC Appendix J). Not yet checked against a live account: see *Check the
  numbers*.
* **0.2.1** (2026-09-28) — no-unit lines never default to 1 g; publishing prep; screenshot tool. In detail: a line
  without a unit (`2 eggs`, `banana`, `1 protein bar`) takes the food's own default measure (the search row's measure,
  else the one the Add Food dialog starts on) and, when that default is plain grams and the food has other measures,
  the row asks you to pick a unit and suggests one (*Use bar*) instead of logging N g; a food that only has a gram
  measure gets 100 g like the app (or the number you typed, as grams) and the row says so. Publishing prep:
  `CONTRIBUTING.md`, `tools/set_repo_url.py` (fills the repository / issues / privacy-policy URL placeholders in one
  go), three install paths (store, release zip, source), private paths scrubbed from the docs. Screenshot tool:
  `tools/screenshots.py` renders the five store screenshots of the real extension over the real diary (with
  `tools/cdp.py`, the DevTools client that `tools/smoke_extension.py` now shares) and self-checks against the mock
  diary as part of the test run; the preview's Food column keeps its width next to a long unit name.
* **0.2.0** (2026-09-28) — renamed to *Multi-Add for Cronometer*; runtime registry rebuild (the extension fetches
  the live compiled client from cronometer.com after a deploy, regenerates the GWT decoder registry, stores it in
  `chrome.storage.local` and activates it, automatically on mismatch and manually from Diagnostics); Chrome Web Store
  packaging (`tools/build_zip.py`), privacy policy, store listing material, MIT license. Review fixes before
  publication (rounds 1–5): the bundle download treats only 404/403/410 as the end of the fragment list and retries transient
  errors; a stored decoder is re-validated, discarded after an extension update and never preferred over the
  shipped registry for its own build; failed automatic rebuilds are rate-limited across page reloads; the RPC engine
  waits for a running rebuild and refuses to add while the decoder does not match; a replayed `authenticate` reply
  is re-read once a matching decoder arrives late (diary groups are not lost); the registry parser recognises
  `$`-initial helper names, refuses conditional reads and accepts more enum shapes (`tools/gen_registry.py` and
  the in-extension port stay identical); `tools/build_zip.py` packages `src/**/*.js` only, cross-checks every
  script against the manifest and really deflates at level 9; the privacy policy and listing texts state what is
  stored (the input list is remembered by default, the account id is stored next to it) and which data types to
  declare; the registry parser's constants pass is linear (a large inlined asset no longer costs seconds),
  `else`/`catch`/`finally` reads are conditional, inlined helper bodies are typed and both generators use ASCII
  word classes; the decoder banner and Diagnostics settle on the store's own last event; only a completed failure
  rate-limits the automatic rebuild (interrupted or unsaved attempts are repeated) and a skipped attempt is
  explained; storage writes are bounded; a decoder rebuilt by another tab is adopted; validation names the changed
  layout first; bundle fetches use mode same-origin; `tools/build_zip.py` never leaves a failed package under the
  release name; Settings gained *Forget last batch*; the privacy texts list what the diagnostics dump contains.
* **0.1.0** (2026-09-28) — initial release, live-tested 2026-09-28: RPC engine (GWT-RPC `updateDiary` mirroring the
  Add Food dialog) with undo, UI-automation fallback engine, input parser with units/fractions/groups/multipliers,
  Shadow-DOM panel with preview, results, settings and diagnostics; offline registry generator and headless-Chrome
  test suite.
