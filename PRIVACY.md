# Privacy Policy — Multi-Add for Cronometer

**Effective date:** 28 September 2026 (version 0.3.1; see *Changes to this policy* for what 0.3.1 changed)
**Applies to:** the "Multi-Add for Cronometer" browser extension, version 0.2.0 and later; the Adaptive TDEE parts
apply from version 0.3.0

Multi-Add for Cronometer is an unofficial, open-source browser extension. It is not affiliated with, endorsed by or
supported by Cronometer Software Inc. "Cronometer" is a trademark of its owner and is used here only to say which
website the extension works with.

## 1. What the extension does

The extension is a companion for the Cronometer **web** diary (`https://cronometer.com`). It has one purpose:
making food and energy logging in your own diary faster and more useful. It does that in two ways:

* **Multi-add.** A panel where you type a list of foods and add them all to your food diary at once, instead of
  searching for each food separately.
* **Adaptive TDEE (optional, off by default).** If you turn it on (**Enable** in the panel's TDEE tab), the extension
  reads the energy intake, Cronometer's energy-burned figures and the weight history already logged in your
  Cronometer account, estimates your real energy expenditure from them and suggests a weekly calorie target that you
  can copy into Cronometer yourself. Until you press **Enable**, the tab reads and stores nothing.

Everything happens inside the Cronometer tab you are already logged into, using your existing login.

## 2. The short version

* The extension talks to **cronometer.com only**, from your own logged-in tab, and to no other server.
* It has **no analytics, no telemetry, no crash reporting, no advertising and no third-party services**.
* It **never sells, shares or transmits** your data to the developer or anyone else. The developer has no server
  and cannot see anything you do.
* Your Cronometer session token is used **in memory only** and is **never stored** or sent anywhere except to
  cronometer.com, exactly as the Cronometer web app itself does.
* The first time you open the panel it shows what the extension reads and keeps and waits for you to press
  **Continue**; nothing you type is remembered before that, and afterwards only if you tick *Remember my last typed
  list* (it is off unless you tick it).
* The only things saved on your device are listed key by key in section 4: your extension settings, your last input
  list (only if you chose to remember it), the ids of the last batch you added (so you can undo it), a
  technical decoder table derived from Cronometer's public code and — **only if you enable the Adaptive TDEE tab** —
  a copy of your daily intake, energy-burned and weight history with the tab's settings and check-in log.
* The Adaptive TDEE data is **health data**. It is read from cronometer.com only after you press **Enable**, kept
  only in your browser for the Cronometer account it belongs to, never sent anywhere else, never put in the
  diagnostics dump (which shows only counts and dates for it), and deleted with one button (**Delete TDEE data**).

## 3. Data the extension handles, and where it goes

| Data | Where it comes from | What it is used for | Where it goes / is stored |
|---|---|---|---|
| **Session token** (the web app's session key) | Observed from the Cronometer app's own start-up requests inside your tab | Attached to the diary requests the extension sends on your behalf, exactly like the app does | **Memory only**, inside the tab. Never written to disk or extension storage; redacted from every log line and from the diagnostics dump; discarded when the tab closes. |
| **User id** (your numeric Cronometer account number) | Same start-up traffic | To send diary requests, and to make sure "undo", the remembered input list and the Adaptive TDEE records are only offered to the account that created them | Memory; the number is also stored next to the last batch and the last input (`cmaLastBatch`, `cmaLastInput`) and, if you enable the Adaptive TDEE tab, in each of its `cmaTdee*` records, and it appears in the diagnostics dump you copy by hand |
| **Food names you type** | You | Sent to Cronometer's own food search to find the matching foods | Sent to **cronometer.com only**, exactly like typing them into the app's search box (the site's own search address carries the name as a query parameter over HTTPS, as the web app itself does); kept in `cmaLastInput` only while "remember last input" is on, which is off unless you tick it on the first-run notice or in *Settings* |
| **Diary entries you add** | Built from your input and Cronometer's search results | Written to your Cronometer diary | Sent to **cronometer.com only** |
| **Diary contents** (the day you are viewing, your diary groups, food details) | Cronometer's responses in your tab | To place new entries in the right group and position and to pick the food's measures | Memory only |
| **Adaptive TDEE history** (only after you press **Enable**): per day, the energy you logged, Cronometer's energy-burned figure and its parts (BMR, activity, exercise, thermic effect of food), your first weigh-in of the day in kg, whether food was logged and whether the day is marked complete, and when it was read | Read from **cronometer.com** inside your tab with the same read-only requests the web app makes (section 5) — up to five years once, then recent days when you open the tab and about 30 seconds after you edit the diary in that tab (also while the panel is closed); or from a Cronometer CSV export you choose to import in the tab | To estimate your energy expenditure and trend weight, compare them with Cronometer's estimate and suggest a weekly target (all computed in your browser) | `chrome.storage.local` on your device (`cmaTdeeDays`), stamped with your user id and shown only to that account. Only one account's copy is kept: if a second Cronometer account enables the tab in the same browser profile, its data replaces the first one's. Never sent anywhere, never in logs or the diagnostics dump. |
| **CSV files you import** into the TDEE tab (optional) | Your own Cronometer exports (*Daily Nutrition*, *Biometrics*), picked from your disk | Read in the browser to fill days the extension could not read from cronometer.com | Only the per-day values above are kept (`cmaTdeeDays`); the file itself is not stored or uploaded |
| **Diagnostics dump** (only when *you* press "Copy diagnostics") | Extension state and its last log lines | For you to paste into a bug report if you choose to | Copied to **your clipboard only**. It contains no session token and no cookies; it does contain your account id, your diary group names, the page address, your browser's user-agent string and the food names you typed and searched, which you can remove before sharing. For the TDEE tab it contains only counts, dates and on/off settings (for example how many days are stored and when they were last refreshed), never a weight, intake, burned figure, estimate or target. |

The extension never reads `document.cookie`, never reads your password, never contacts any host other than
`cronometer.com`, and never relays or inspects traffic to any other site (including third-party scripts that
Cronometer's own page may load).

## 4. Everything stored on your device (`chrome.storage.local`)

These eleven keys are the complete list. Nothing else is stored, and nothing is synced: `chrome.storage.sync`,
`localStorage`, `sessionStorage`, IndexedDB and cookies are not used.

The five Adaptive TDEE records are kept **per Cronometer account**: each key ends with the account's numeric id (`cmaTdeeDays:<user id>` and so on), so a second account used in the same browser gets its own separate copy and never sees, changes or deletes another account's. Copies written by version 0.3.0 under the bare names are moved to the account's own keys the next time that account opens the panel.

| Key | Written when | Contents | Personal data? | Removed by |
|---|---|---|---|---|
| `cmaSettings` | you save the panel's *Settings*, or tick *Remember my last typed list* on the first-run notice (or press **Continue** with it unticked after an earlier version had it on) | engine choice (RPC or UI automation), delay between adds, whether to remember the last input (off unless you tick it) | no | *Reset* in Settings restores the defaults; removing the extension |
| `cmaNoticeAck` | you press **Continue** on the panel's first-run notice | the version number of the notice you acknowledged (so it is shown once, and again only if its text changes materially) | no | removing the extension |
| `cmaLastInput` | you type in the panel, after the first-run notice, while "remember last input" is on (only after you ticked it) | the food lines you typed and your user id | yes (dietary data, account id) | switching "remember last input" off (clears it at once); pressing **Continue** on the first-run notice with the box unticked (clears a list an earlier version kept); *Forget saved input*; removing the extension |
| `cmaLastBatch` | a batch is added with the RPC engine | the diary date, the ids of the added entries, their count, a timestamp and your user id | yes (account id; the entry ids point into your diary) | *Forget last batch*; undoing the whole batch; replaced by the next batch; discarded 24 hours after it was created (checked when the extension loads); removing the extension |
| `cmaRegistry` | the extension rebuilds its decoder after a Cronometer release, or you press *Rebuild decoder* | a table describing the data types of Cronometer's compiled web client (type names, numeric checksums, field layouts, the build id) | **no** | replaced by the next rebuild; removing the extension |
| `cmaRegistryAttempt` | each decoder rebuild | when the last rebuild ran, for which build, whether it worked and its error text (so a failed rebuild is not retried on every page load) | **no** | replaced by the next attempt; removing the extension |
| `cmaTdeeDays:<user id>` | only after you press **Enable** in the TDEE tab (a CSV you import there adds to it) | the per-day history described in section 3, with your user id | **yes — health data** | **Delete TDEE data**; removing the extension |
| `cmaTdeeSync:<user id>` | only after **Enable** | your user id, that you enabled the tab and when, the first day with data, the last refresh times, three of your Cronometer settings (whether Cronometer counts the thermic effect of food, kcal or kJ, your weight unit), technical refresh details, the last refresh error text and a note of what the last refresh could not read (no health values) | yes (account id, consent record) | **Delete TDEE data**; removing the extension |
| `cmaTdeeOverrides:<user id>` | you exclude or confirm a day in the TDEE History | the dates you excluded or confirmed, with your user id | yes (health-related) | **Delete TDEE data**; removing the extension |
| `cmaTdeeSettings:<user id>` | you save the TDEE settings | goal (lose / maintain / gain rate), check-in weekday, estimate responsiveness, optional starting estimate, protein and fat choices, sex (used only for the minimum-calorie floor), units, model start date, dismissed hints, with your user id | yes (health-related) | **Delete TDEE data**; removing the extension |
| `cmaTdeeCheckins:<user id>` | you accept or skip a weekly check-in | up to 260 check-ins: date, accepted or skipped, suggested target, estimate and its uncertainty, trend weight, goal rate as chosen and as applied, macros, with your user id | **yes — health data** | **Delete TDEE data**; removing the extension |

## 5. Every kind of network request

All requests go to `https://cronometer.com` from your own tab, with the cookies the browser already holds for it
(`credentials: same-origin`); the extension itself never reads those cookies.

| Request | Sent by | When | What it does |
|---|---|---|---|
| The app's own requests to `/cronometer/app`, `/cronometer/pro` and its `/api/` REST endpoints (for example `authenticate`, `getDayInfo`, `setUserPreference`) | **the Cronometer web app itself**; the extension only **observes** them through a page-level `XMLHttpRequest` hook | whenever the app talks to its server | read only: the extension learns the session token, your user id, the diary date and groups and, after **Enable**, notices your own diary and preference edits so the TDEE copy is refreshed. Requests to any other host are never observed. |
| Food search: `GET /api/v3/user/<id>/food-search/string?query=…` | extension | *Find foods* (one per line) | sends the food name you typed |
| `getFood`, `getDayInfo` (GWT-RPC) | extension | *Find foods*, *Add all* | read the food's measures and the day being filled |
| `updateDiary` (GWT-RPC, one food per request, with a delay) | extension (RPC engine) | *Add all* | **writes** the entries you confirmed to your diary |
| `removeServing` (GWT-RPC) | extension | *Undo this batch* | **removes** the entries of the last batch |
| The app's own *Add Food* dialog | the web app, driven by the extension (UI-automation engine) | *Add all* with the UI engine | the app sends its own requests, exactly as if you clicked |
| `getCaloriesConsumedAndBurned`, `getBiometrics`, `getCalendarInfo`, `getFirstDayWithData`, `getPreference` (GWT-RPC) | extension | **only after you press Enable** in the TDEE tab (see section 3 for when) | **read only**; the TDEE tab never writes anything to Cronometer |
| Cronometer's public script files: `GET <app>/<build>.cache.js` and `<app>/deferredjs/<build>/<n>.cache.js` | extension | after Cronometer ships a new build, or when you press *Rebuild decoder* | downloads the same files the page itself loads; they are **analysed as text to rebuild the decoder table and never executed** (no `eval`, no script injection). No personal data is sent. |

## 6. Data that is *not* collected

The developer does not collect, receive, store or process any data about you or your use of the extension. There
is no account with the developer, no sign-up, no usage statistics, no error reporting and no remote configuration.
Nothing is ever transmitted to the developer, to a third party, or to any server other than `cronometer.com`.

**Limited Use.** The use of information received by this extension will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/), including the
Limited Use requirements. User data is used only to provide the single purpose described in section 1; it is not
sold, not transferred to anyone, not used for advertising, not used or transferred to determine creditworthiness or
for lending purposes, and not read by any human (the developer included).

## 7. Permissions and why they are needed

| Permission | Why |
|---|---|
| `storage` | To keep the eleven records listed in section 4 on your device (`chrome.storage.local`): your settings and whether you acknowledged the first-run notice, the last input list (only if you ticked *Remember my last typed list*), the undo information for the last batch, the rebuilt decoder table and the note about its last rebuild and, only if you enable the Adaptive TDEE tab, its history copy, settings, day decisions and check-in log. |
| Host permission `https://cronometer.com/*` | To run inside the Cronometer web app, observe the app's own traffic in your tab (to learn the session and the diary date), send the same diary requests the app sends, download the app's own public script files to rebuild the decoder table after a Cronometer release (read as text, never executed), and — only after you enable the Adaptive TDEE tab — make the same read-only requests the app makes to show your energy and weight history. No other site is ever accessed. |

The extension does not request `tabs`, `history`, `cookies`, `webRequest`, `identity`, clipboard-read or any other
permission, and it contains no remotely loaded code: every line of code it runs is in the package.

## 8. Your choices, data retention and deletion

* **First-run notice.** Before the panel's multi-add views are shown the first time, the panel says what the
  extension reads and keeps, links to this policy, lets you choose whether your last typed list is remembered
  (*Remember my last typed list*, **unticked**: it is kept only if you tick it) and waits for **Continue**. Nothing
  you type is stored before that. If an earlier version (0.3.0, which remembered the list by default) kept a list
  and you press **Continue** without ticking the box, that list is deleted. The request hook that learns the
  session runs from page load (it has to see the app start), so by the time the notice is shown the extension has
  already read your session and account id from the app's start-up requests; the notice says so. They are held in
  memory in the tab only, never stored or sent anywhere, and are gone when the tab is closed or reloaded.
* **Adaptive TDEE is opt-in.** Before you press **Enable**, the TDEE tab says what it will read and store and links
  to this policy; nothing is read or stored for it until you press the button. **Delete TDEE data** withdraws that
  consent.
* The session token and everything else held in memory disappear when the Cronometer tab is closed or reloaded.
* The last batch (undo information) is automatically discarded after 24 hours.
* Everything in `chrome.storage.local` (section 4) stays on your device until you delete it. To delete it:
  * **Remove the extension** (`chrome://extensions` → Remove). Chrome deletes the extension's storage with it; or
  * turn off "remember last input" in the panel's *Settings* tab (it is off unless you ticked it) to stop storing
    your input list — the stored copy is cleared at once, and *Forget saved input* in the same tab clears it without changing
    the setting — and press *Forget last batch* in the same tab to delete the stored undo information at once
    (otherwise it is replaced by your next batch, deleted when you undo the batch completely, and discarded 24
    hours after it was created the next time the extension loads). The decoder table is replaced by the next
    rebuild and holds no personal data; or
  * press **Delete TDEE data** in the Settings of the TDEE tab: it deletes every Adaptive TDEE record of the
    Cronometer account you are logged in with (`cmaTdeeDays:<user id>`, `cmaTdeeSync:<user id>`,
    `cmaTdeeOverrides:<user id>`, `cmaTdeeSettings:<user id>`, `cmaTdeeCheckins:<user id>`) at once and stops the
    reading for that account — in every open Cronometer tab — until you press **Enable** again. Another account's
    copy in the same browser is not touched; log in with that account to delete it, or remove the extension.
* Changes you make to your Cronometer diary through the extension live in your Cronometer account and are governed
  by Cronometer's own privacy policy; you can remove entries in Cronometer, or with the extension's *Undo this batch*
  button right after adding them (batches added with the default fast engine; the UI-automation engine has no undo).

## 9. Children

The extension is a tool for existing Cronometer account holders and is not directed at children.

## 10. Open source

The complete source code of the extension is public at <https://github.com/fabbeskw/multi-add-for-cronometer>, so every statement above can be verified
against it. The package you install is built from that source with no build step, minification or obfuscation.
Two files in it are generated data and say so in their header: `src/lib/gwt-registry.js` (the decoder table for the
Cronometer build the release was tested with, produced by `tools/gen_registry.py`) and `src/tdee/adaptive-tdee.js`
(the estimate engine, wrapped from `vendor/adaptive-tdee/` by `tools/gen_tdee.py`).

## 11. Changes to this policy

If the extension's data handling ever changes, this policy will be updated, the effective date at the top will be
changed, and the change will be described in the extension's changelog before the new version is published. Since
the extension contacts no server of its own, it cannot notify you in-app; check this page when you update.

* **0.3.1** (28 September 2026): a first-run notice in the panel (section 8) and its record `cmaNoticeAck` (a
  version number, no personal data); remembering the last input list is now opt-in (off unless you tick it on that
  notice or in *Settings*; 0.3.0 remembered it by default, and a list it kept is deleted when you continue without
  ticking) and happens only after the notice was acknowledged. Nothing new is read or sent. The policy now lists every storage key (section 4) and every kind of request (section
  5) and states the Limited Use commitment (section 6); the extension's entry on `chrome://extensions` links to the
  public source code.
* **0.3.0** (28 September 2026): the optional Adaptive TDEE tab (health history read and stored locally, only after
  **Enable**).
* **0.2.0** (28 September 2026): first published policy.

## 12. Contact

Questions about this policy or the extension: **<https://github.com/fabbeskw/multi-add-for-cronometer/issues>**

For questions about your Cronometer account or Cronometer's own handling of your data, contact Cronometer directly;
the developer of this extension has no access to your account.
