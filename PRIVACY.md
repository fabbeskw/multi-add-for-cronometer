# Privacy Policy — Multi-Add for Cronometer

**Effective date:** 28 September 2026 (updated for version 0.3.0: the optional Adaptive TDEE tab)
**Applies to:** the "Multi-Add for Cronometer" browser extension, version 0.2.0 and later; the Adaptive TDEE parts
apply from version 0.3.0

Multi-Add for Cronometer is an unofficial, open-source browser extension. It is not affiliated with, endorsed by or
supported by Cronometer Software Inc. "Cronometer" is a trademark of its owner and is used here only to say which
website the extension works with.

## 1. What the extension does

The extension adds a panel to the Cronometer **web app** (`https://cronometer.com`) that lets you type a list of
foods and add them all to your food diary at once, instead of searching for each food separately. Everything it
does happens inside the Cronometer tab you are already logged into, using your existing login.

Since version 0.3.0 the panel also has an optional **Adaptive TDEE** tab. If you turn it on (**Enable**), the
extension reads the energy intake, Cronometer's energy-burned figures and the weight history already logged in your
Cronometer account, estimates your real energy expenditure from them and suggests a weekly calorie target that you
can copy into Cronometer yourself. Until you press **Enable**, the tab reads and stores nothing.

## 2. The short version

* The extension talks to **cronometer.com only**, from your own logged-in tab, and to no other server.
* It has **no analytics, no telemetry, no crash reporting, no advertising and no third-party services**.
* It **never sells, shares or transmits** your data to the developer or anyone else. The developer has no server
  and cannot see anything you do.
* Your Cronometer session token is used **in memory only** and is **never stored** or sent anywhere except to
  cronometer.com, exactly as the Cronometer web app itself does.
* The only things saved on your device are your extension settings, your last input list (remembered by default;
  you can switch that off), the ids of the last batch you added (so you can undo it), a technical decoder table
  derived from Cronometer's public code and — **only if you enable the Adaptive TDEE tab** — a copy of your daily
  intake, energy-burned and weight history with the tab's settings and check-in log.
* The Adaptive TDEE data is **health data**. It is read from cronometer.com only after you press **Enable**, kept
  only in your browser for the Cronometer account it belongs to, never sent anywhere else, never put in the
  diagnostics dump (which shows only counts and dates for it), and deleted with one button (**Delete TDEE data**).

## 3. Data the extension handles, and where it goes

| Data | Where it comes from | What it is used for | Where it goes / is stored |
|---|---|---|---|
| **Session token** (the web app's session key) | Observed from the Cronometer app's own start-up requests inside your tab | Attached to the diary requests the extension sends on your behalf, exactly like the app does | **Memory only**, inside the tab. Never written to disk or extension storage; redacted from every log line and from the diagnostics dump; discarded when the tab closes. |
| **User id** (your Cronometer account number) | Same start-up traffic | To send diary requests, and to make sure "undo", the remembered input list and the Adaptive TDEE records are only offered to the account that created them | Memory; the number is also stored next to the last batch and the last input in `chrome.storage.local` (see below) and, if you enable the Adaptive TDEE tab, in each of its `cmaTdee*` records, and it appears in the diagnostics dump you copy by hand |
| **Food names you type** | You | Sent to Cronometer's own food search to find the matching foods | Sent to **cronometer.com only**, exactly like typing them into the app's search box |
| **Diary entries you add** | Built from your input and Cronometer's search results | Written to your Cronometer diary | Sent to **cronometer.com only** |
| **Diary contents** (the day you are viewing, your diary groups) | Cronometer's responses to your tab | To place new entries in the right group and position | Memory only |
| **Settings** (engine choice, delay between adds, "remember last input") | You | To remember your preferences | `chrome.storage.local` on your device |
| **Last input list** (the food lines you typed; **remembered by default** — switch off "remember last input" in the panel's *Settings* tab to stop, which also deletes the stored copy) | You | To restore your list next time you open the panel | `chrome.storage.local` on your device, together with your user id so it is only restored for the same account |
| **Last batch** (the diary entry ids added in the last run, the diary date, a timestamp, your user id) | Cronometer's responses | To let you **Undo this batch** for 24 hours | `chrome.storage.local` on your device (delete it at any time with *Forget last batch* in the panel's *Settings* tab) |
| **Decoder registry** (a table describing the data types of Cronometer's compiled web client) | Rebuilt by the extension from Cronometer's **public, compiled JavaScript** — the app's own script files, downloaded from cronometer.com inside your tab exactly as the page itself downloads them (no other host; analysed as text, never executed) — when Cronometer ships a new build, or when you press *Rebuild decoder* in the Diagnostics tab | To read Cronometer's responses correctly after a new release | `chrome.storage.local` on your device (one table under the key `cmaRegistry`, replaced by the next rebuild, plus a small note under `cmaRegistryAttempt` saying when the last rebuild ran for which build and whether it worked, so a failed one is not retried on every page load). Both contain **no personal data** at all — only type names, numeric checksums, field layouts, a build id, a timestamp and an error text derived from code every visitor's browser downloads. |
| **Adaptive TDEE history** (only after you press **Enable** in the TDEE tab): per day, the energy you logged, Cronometer's energy-burned figure and its parts (BMR, activity, exercise, thermic effect of food), your first weigh-in of the day in kg, whether food was logged and whether the day is marked complete, and when it was read | Read from **cronometer.com** inside your tab with the same read-only requests the web app makes for its own dashboard, Nutrition Report, weight history, diary calendar and settings — up to five years once, then recent days when you open the tab and about 30 seconds after you edit the diary in that tab (also while the panel is closed); or from a Cronometer CSV export you choose to import in the tab | To estimate your energy expenditure and trend weight, compare them with Cronometer's estimate and suggest a weekly target (all computed in your browser) | `chrome.storage.local` on your device under `cmaTdeeDays`, stamped with your user id and shown only to that account. Only one account's copy is kept: if a second Cronometer account enables the tab in the same browser profile, its data replaces the first one's. Never sent anywhere, never in logs or the diagnostics dump. |
| **Adaptive TDEE state and preferences** | Your consent and the extension's refresh bookkeeping; three of your Cronometer settings read from cronometer.com (whether Cronometer counts the thermic effect of food, kcal or kJ, your weight unit) | To know that you enabled the tab, when to refresh, and how to count and display the numbers | `chrome.storage.local` under `cmaTdeeSync` (with your user id): that you enabled it and when, the first day with data, the last refresh times, those three settings, technical refresh details, the last refresh error text and a note of what the last refresh could not read (no health values) |
| **Adaptive TDEE settings, day decisions and check-ins** | You | Your goal (lose / maintain / gain rate), check-in weekday, estimate responsiveness, optional starting estimate, protein and fat choices, sex (used only for the minimum-calorie floor), units, model start date, dismissed hints; the days you excluded or confirmed; each weekly check-in (date, accepted or skipped, suggested target, estimate and its uncertainty, trend weight, goal rate as chosen and as applied, macros) | `chrome.storage.local` under `cmaTdeeSettings`, `cmaTdeeOverrides` and `cmaTdeeCheckins` (up to 260 check-ins), each with your user id |
| **CSV files you import** into the TDEE tab (optional) | Your own Cronometer exports (*Daily Nutrition*, *Biometrics*), picked from your disk | Read in the browser to fill days the extension could not read from cronometer.com | Only the per-day values above are kept (`cmaTdeeDays`); the file itself is not stored or uploaded |
| **Diagnostics dump** (only when *you* press "Copy diagnostics") | Extension state and its last log lines | For you to paste into a bug report if you choose to | Copied to **your clipboard only**. It contains no session token and no cookies; it does contain your account id, your diary group names, the page address, your browser's user-agent string and the food names you typed and searched, which you can remove before sharing. For the TDEE tab it contains only counts, dates and on/off settings (for example how many days are stored and when they were last refreshed), never a weight, intake, burned figure, estimate or target. |

The extension never reads `document.cookie`, never reads your password, never contacts any host other than
`cronometer.com`, and never relays or inspects traffic to any other site (including third-party scripts that
Cronometer's own page may load).

## 4. Data that is *not* collected

The developer does not collect, receive, store or process any data about you or your use of the extension. There
is no account with the developer, no sign-up, no usage statistics, no error reporting and no remote configuration.
Nothing is ever transmitted to the developer, to a third party, or to any server other than `cronometer.com`.

## 5. Permissions and why they are needed

| Permission | Why |
|---|---|
| `storage` | To keep your settings, the last input list (remembered by default, can be switched off), the undo information for the last batch, the rebuilt decoder registry and the note about its last rebuild and, only if you enable the Adaptive TDEE tab, its history copy, settings and check-in log on your device (`chrome.storage.local`). |
| Host permission `https://cronometer.com/*` | To run inside the Cronometer web app, observe the app's own traffic in your tab (to learn the session and the diary date), send the same diary requests the app sends, and — only after you enable the Adaptive TDEE tab — make the same read-only requests the app makes to show your energy and weight history. No other site is ever accessed. |

The extension does not request `tabs`, `history`, `cookies`, `webRequest`, `identity`, clipboard-read or any other
permission, and it contains no remotely loaded code.

## 6. Data retention and deletion

* The session token and everything else held in memory disappear when the Cronometer tab is closed or reloaded.
* The last batch (undo information) is automatically discarded after 24 hours.
* Everything in `chrome.storage.local` (settings, last input, last batch, decoder registry and its rebuild note, and
  the Adaptive TDEE data if you enabled it) stays on your device until you delete it. To delete it:
  * **Remove the extension** (`chrome://extensions` → Remove). Chrome deletes the extension's storage with it; or
  * turn off "remember last input" in the panel's *Settings* tab (it is on by default) to stop storing your input
    list — the stored copy is cleared at once, and *Forget saved input* in the same tab clears it without changing
    the setting — and press *Forget last batch* in the same tab to delete the stored undo information at once
    (otherwise it is replaced by your next batch, deleted when you undo the batch completely, and discarded 24
    hours after it was created the next time the extension loads). The decoder table is replaced by the next
    rebuild and holds no personal data; or
  * press **Delete TDEE data** in the Settings of the TDEE tab: it deletes every Adaptive TDEE record
    (`cmaTdeeDays`, `cmaTdeeSync`, `cmaTdeeOverrides`, `cmaTdeeSettings`, `cmaTdeeCheckins`) at once and stops the
    reading — in every open Cronometer tab — until you press **Enable** again.
* Changes you make to your Cronometer diary through the extension live in your Cronometer account and are governed
  by Cronometer's own privacy policy; you can remove entries in Cronometer, or with the extension's *Undo this batch*
  button right after adding them.

## 7. Children

The extension is a tool for existing Cronometer account holders and is not directed at children.

## 8. Open source

The complete source code of the extension is public at <https://github.com/fabbeskw/multi-add-for-cronometer>, so every statement above can be verified
against it. The package you install is built from that source with no build step, minification or obfuscation.

## 9. Changes to this policy

If the extension's data handling ever changes, this policy will be updated, the effective date at the top will be
changed, and the change will be described in the extension's changelog before the new version is published. Since
the extension contacts no server of its own, it cannot notify you in-app; check this page when you update.

## 10. Contact

Questions about this policy or the extension: **<https://github.com/fabbeskw/multi-add-for-cronometer/issues>**

For questions about your Cronometer account or Cronometer's own handling of your data, contact Cronometer directly;
the developer of this extension has no access to your account.
