# Privacy Policy — Multi-Add for Cronometer

**Effective date:** 28 September 2026
**Applies to:** the "Multi-Add for Cronometer" browser extension, version 0.2.0 and later

Multi-Add for Cronometer is an unofficial, open-source browser extension. It is not affiliated with, endorsed by or
supported by Cronometer Software Inc. "Cronometer" is a trademark of its owner and is used here only to say which
website the extension works with.

## 1. What the extension does

The extension adds a panel to the Cronometer **web app** (`https://cronometer.com`) that lets you type a list of
foods and add them all to your food diary at once, instead of searching for each food separately. Everything it
does happens inside the Cronometer tab you are already logged into, using your existing login.

## 2. The short version

* The extension talks to **cronometer.com only**, from your own logged-in tab, and to no other server.
* It has **no analytics, no telemetry, no crash reporting, no advertising and no third-party services**.
* It **never sells, shares or transmits** your data to the developer or anyone else. The developer has no server
  and cannot see anything you do.
* Your Cronometer session token is used **in memory only** and is **never stored** or sent anywhere except to
  cronometer.com, exactly as the Cronometer web app itself does.
* The only things saved on your device are your extension settings, your last input list (remembered by default;
  you can switch that off), the ids of the last batch you added (so you can undo it) and a technical decoder table
  derived from Cronometer's public code.

## 3. Data the extension handles, and where it goes

| Data | Where it comes from | What it is used for | Where it goes / is stored |
|---|---|---|---|
| **Session token** (the web app's session key) | Observed from the Cronometer app's own start-up requests inside your tab | Attached to the diary requests the extension sends on your behalf, exactly like the app does | **Memory only**, inside the tab. Never written to disk or extension storage; redacted from every log line and from the diagnostics dump; discarded when the tab closes. |
| **User id** (your Cronometer account number) | Same start-up traffic | To send diary requests, and to make sure "undo" and the remembered input list are only offered to the account that created them | Memory; the number is also stored next to the last batch and the last input in `chrome.storage.local` (see below), and it appears in the diagnostics dump you copy by hand |
| **Food names you type** | You | Sent to Cronometer's own food search to find the matching foods | Sent to **cronometer.com only**, exactly like typing them into the app's search box |
| **Diary entries you add** | Built from your input and Cronometer's search results | Written to your Cronometer diary | Sent to **cronometer.com only** |
| **Diary contents** (the day you are viewing, your diary groups) | Cronometer's responses to your tab | To place new entries in the right group and position | Memory only |
| **Settings** (engine choice, delay between adds, "remember last input") | You | To remember your preferences | `chrome.storage.local` on your device |
| **Last input list** (the food lines you typed; **remembered by default** — switch off "remember last input" in the panel's *Settings* tab to stop, which also deletes the stored copy) | You | To restore your list next time you open the panel | `chrome.storage.local` on your device, together with your user id so it is only restored for the same account |
| **Last batch** (the diary entry ids added in the last run, the diary date, a timestamp, your user id) | Cronometer's responses | To let you **Undo this batch** for 24 hours | `chrome.storage.local` on your device (delete it at any time with *Forget last batch* in the panel's *Settings* tab) |
| **Decoder registry** (a table describing the data types of Cronometer's compiled web client) | Rebuilt by the extension from Cronometer's **public, compiled JavaScript** — the app's own script files, downloaded from cronometer.com inside your tab exactly as the page itself downloads them (no other host; analysed as text, never executed) — when Cronometer ships a new build, or when you press *Rebuild decoder* in the Diagnostics tab | To read Cronometer's responses correctly after a new release | `chrome.storage.local` on your device (one table under the key `cmaRegistry`, replaced by the next rebuild, plus a small note under `cmaRegistryAttempt` saying when the last rebuild ran for which build and whether it worked, so a failed one is not retried on every page load). Both contain **no personal data** at all — only type names, numeric checksums, field layouts, a build id, a timestamp and an error text derived from code every visitor's browser downloads. |
| **Diagnostics dump** (only when *you* press "Copy diagnostics") | Extension state and its last log lines | For you to paste into a bug report if you choose to | Copied to **your clipboard only**. It contains no session token and no cookies; it does contain your account id, your diary group names, the page address, your browser's user-agent string and the food names you typed and searched, which you can remove before sharing. |

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
| `storage` | To keep your settings, the last input list (remembered by default, can be switched off), the undo information for the last batch, the rebuilt decoder registry and the note about its last rebuild on your device (`chrome.storage.local`). |
| Host permission `https://cronometer.com/*` | To run inside the Cronometer web app, observe the app's own traffic in your tab (to learn the session and the diary date), and send the same diary requests the app sends. No other site is ever accessed. |

The extension does not request `tabs`, `history`, `cookies`, `webRequest`, `identity`, clipboard-read or any other
permission, and it contains no remotely loaded code.

## 6. Data retention and deletion

* The session token and everything else held in memory disappear when the Cronometer tab is closed or reloaded.
* The last batch (undo information) is automatically discarded after 24 hours.
* Everything in `chrome.storage.local` (settings, last input, last batch, decoder registry and its rebuild note)
  stays on your device until you delete it. To delete it:
  * **Remove the extension** (`chrome://extensions` → Remove). Chrome deletes the extension's storage with it; or
  * turn off "remember last input" in the panel's *Settings* tab (it is on by default) to stop storing your input
    list — the stored copy is cleared at once, and *Forget saved input* in the same tab clears it without changing
    the setting — and press *Forget last batch* in the same tab to delete the stored undo information at once
    (otherwise it is replaced by your next batch, deleted when you undo the batch completely, and discarded 24
    hours after it was created the next time the extension loads). The decoder table is replaced by the next
    rebuild and holds no personal data.
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
