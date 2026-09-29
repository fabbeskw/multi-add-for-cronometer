# Store assets: the Chrome Web Store screenshots

Five 1280 x 800 PNG screenshots of the **real extension**, rendered by `tools/screenshots.py`, plus
`manifest.json`, which records for each file what it shows (`shot`, `set`: store or extra), which data is in it
(`data`, `diaryDay`), what was blurred, when and with which extension and Chrome version it was captured, and what
became of the sample entries the run added (`undo`, e.g. `Undo: 4 removed, 0 failed`). The store takes 1 to 5 screenshots, 1280 x 800 (preferred) or
640 x 400, PNG or JPEG, with square corners and full bleed (no frame, no padding); the tool writes exactly that: the
browser viewport, pinned to 1280 x 800, as 24-bit RGB PNG. Upload them in file order, 01 to 05.

The promo tiles (the required 440 x 280 small tile and the optional marquee) are in [promo/](promo/), with their own
README.

**The set is privacy-safe by construction.** No real diary entry and no real health figure is in any shot:

* **Shots 1 to 3 are taken on an empty diary day.** Before anything is added, the tool moves the diary forward with
  its own arrow (the authored `.diary-date-next` control, one day per click, each step confirmed by the app's own
  `getDayInfo` for that day) to **today + 7** and checks that the day has **no entry**: no row in the diary table
  except the meal-group headers (hidden rows count too), and, in a live run, no serving in the extension's own
  `getDayInfo` read of that day; the rows are looked at twice, seconds apart, so entries that render late do not
  pass for an empty day. A day with entries is skipped, up to 30 more days; if none is empty the run stops before
  adding anything. The extension adds to the day the diary shows, and the tool checks the panel's date and the
  plan's date against that day before it presses *Add all*. Every capture is refused unless the diary still shows
  that day with no more entry rows than the run added (none before *Add all*). So the only diary entries in the
  shots are the four sample foods the tool adds, and they are undone at the end (below). Then the diary is moved
  back to today.
* **Shots 4 and 5 show synthetic demo data** (`"data": "synthetic demo"` in `manifest.json`). For these two shots
  the tool puts an in-memory stand-in for the extension's TDEE data layer (`CMA.tdeeData`, the SPEC §12.3 contract)
  in place inside the extension's isolated world, renders the TDEE tab, opens the weekly check-in, cancels it, and
  puts the real data layer back. The stand-in serves a made-up person: 120 days ending today; trend weight
  89.8 → 83.7 kg; food logged on about 85 % of days and weigh-ins on about 80 %; Cronometer's *burned* about 8 %
  higher than the true expenditure; maintenance for three weeks, then a goal of −0.5 % of body weight per week,
  with a weekly check-in every seventh day that the extension's own engine computed. The numbers are seeded, so they
  are the same on every run. Nothing is stored or sent. The owner's TDEE data is never read or shown: the tool calls
  no method of the real data layer, and while the stand-in is shown the real layer's `enable()` and `sync()` are
  replaced by guards that refuse and count calls (the dry run fails on any call).
* **Personal parts of the page are blurred** (below). Diary entries are never blurred: the day holds only the sample
  foods.

## The five shots

| File | Shot | What it shows | Data in it | Blurred |
|---|---|---|---|---|
| `01-input.png` | Input | The panel open over the diary on the **Input** view with the sample list typed in (`## Dinner` header, `200g chicken breast`, `1 1/2 cups rice, cooked`, `2 large eggs`, `1 medium banana @snacks`), the group **Dinner** selected, the diary date (the empty day), the **RPC (fast)** engine and **Find foods**. | the sample list; Cronometer's page around the panel on the empty day | the account name / e-mail at the top right; the Energy Summary and targets widgets |
| `02-preview.png` | Preview | The table after **Find foods**: one row per line with the matched food, quantity, unit (the food's own measures), grams, diary group and a tick, and **Add all (4)**. | Cronometer's public food database | same |
| `03-diary.png` | Diary | The panel closed: the empty day of the Cronometer diary with the four new entries in **Dinner** and **Snacks** (the group headers show the totals the app computed) and the **Multi-add** launcher. | the four sample entries only | same |
| `04-tdee-overview.png` | TDEE overview | The **TDEE** tab: the expenditure card (status chip *Up to date*, the estimate ± its standard deviation, "Cronometer estimates … your data says you burn about 8 % less", trend weight, where the estimate started), the this-week card (the target, protein / fat / carbs, "≈ −0.39 kg/week if you hit it", *Check-in due today*, **Check in**) and the charts (expenditure with its ±1 SD band and Cronometer's 7-day burned average; the weight chart below). | **synthetic demo** | same (the diary behind the panel is the empty day) |
| `05-tdee-checkin.png` | TDEE check-in | The **weekly check-in** dialog: last week's target → this week's (2,070 → 2,030 kcal/day, −40), the macros and the plain-English why (expenditure moved from … to …, the trend weight change over the week at the average logged intake, the goal), **Accept new target** / **Skip this week** / **Cancel**. The tool presses Cancel afterwards: nothing is recorded. | **synthetic demo** | same |

When the overview is taller than the panel, the panel's bottom edge would cut through a line of text; the tool then
scrolls the panel body by a few pixels (never so far that the cards leave the top) so the edge cuts only a chart.

With `--extra` the tool also writes two shots that are **not** part of the store set: `extra-results.png` (the
Results view after *Add all*: four ticks with the entry ids, **Undo this batch (4)**, **Reload page**, **Done**) and
`extra-diagnostics.png` (the Diagnostics view: the decoder block and the JSON dump, with `"nonce"` shown only as
`present` and the numeric account id blurred everywhere in it). Their `manifest.json` entries say `"set": "extra"`.

What is blurred (`filter: blur(9px)`, injected into the page before every capture): the built-in selector list
(authored class names found in Cronometer's compiled client: the Pro navbar account switcher `#navbarDropdown` /
`.navbar-account` / `.navbar-dropdown-container`, the page header `#cronometer-header`, the diary's
`.energy-summary*`, `.target-summary-container`, `.nutrient-targets-container`, `.macro-targets`, the whole Water
card `.water-tracking` (its heading "Water 0 / <target> mL" sits outside the target bars, which are listed too), the
Daily Target editor `.targets-container` and the Daily Target Editor's profile name, `.daily-target-editor-title span`
and `.daily-target-editor-title ~ *`), every element whose text carries the account's first name or e-mail address
(read from the app's own User object in the page, never printed or stored; the console prints a NOTE when no first
name is found, then pass `--blur-text`), anything passed with `--blur-selectors` / `--blur-text` and, in
`extra-diagnostics.png`, the numeric account id. The text blur runs a second time right before each capture (a
capture is refused if new matches keep appearing). `manifest.json` lists per shot what actually matched; its times
are UTC.

## Status of the files here

* **The PNGs are not committed.** `.gitignore` excludes every picture below `store-assets/` except the promo tiles,
  and `store-assets/dry-run/`: a live run shows a real account's Cronometer page (blurred where personal, on an
  empty day, but still the owner's account). `manifest.json` is committed and describes the last live run.
* The `manifest.json` in the repository is the one of the **2026-09-28 live run with version 0.3.1** (`01-input` …
  `05-tdee-checkin`); 0.3.2 reuses that set, because it changes none of the five views. PNGs of the older 0.2.0 run
  that may sit in a working copy (`03-results.png`, `04-diary.png`, `05-diagnostics.png`) **show a real diary:
  delete them**. The tool never deletes anything in
  `store-assets/`: a live run **refuses to start** while any picture is in the folder (it names them), so the new set
  is never mixed with an old one, and at the end of a run it names every PNG there that is not from that run.
* `python tools/screenshots.py --check-store` (no Chrome) prints `STORE SET READY` only when this folder holds
  exactly the five store shots of a live run of this set (each `"mode": "live"`, the TDEE shots `"synthetic demo"`,
  a completed undo, valid PNGs) and no other picture. Upload nothing before it passes.
* `dry-run/` is the tool's self-check output against the mock diary. The green bar rewrites it (the dry run removes
  its own earlier files first); it is **not** store material.

## How they are made

`tools/screenshots.py` (Python 3 stdlib, no PIL) drives Chrome through the DevTools Protocol over
`--remote-debugging-pipe` (`tools/cdp.py`, the client `tools/smoke_extension.py` uses as well):

1. starts a **visible** Chrome on a temporary profile, sizes the window so the page viewport is 1280 x 800 and pins
   the viewport with `Emulation.setDeviceMetricsOverride` (1280 x 800, device scale factor 1);
2. installs the extension from the repository with `Extensions.loadUnpacked` (Google Chrome 137+ ignores
   `--load-extension`) **before** the diary is opened, so the extension sees the app start; opens
   `https://cronometer.com/#diary`;
3. waits for **you** to log in (up to 15 minutes; it never touches the login form; it only sets `#diary` when the app
   lands on another view), then for the extension's session capture and for the diary day from the app's
   `getDayInfo`;
4. moves the diary to an empty day (above);
5. drives the extension through its **own isolated world** (`Runtime.evaluate` in the execution context whose origin
   is `chrome-extension://<id>`): mounts the panel, presses **Continue** on the first-run notice (the temporary
   profile shows it once), saves the engine setting, types the list into the real textarea,
   picks Dinner, presses the real **Find foods** and **Add all** buttons (RPC engine: real `updateDiary` requests to
   the empty day), closes the panel for the diary shot, opens the TDEE tab over the synthetic stand-in, presses
   **Check in** and then **Cancel**, and restores the real TDEE data layer. Every wait is bounded and names what it
   waited for;
6. before every capture checks that the diary still shows the empty day (the app's last `getDayInfo` for it
   answered HTTP 200) and that every rendered entry row is one of the foods this run added (none before Add all;
   exactly the rows added once they were all seen), blurs the personal parts of the page, blurs the text once more
   and captures with `Page.captureScreenshot` (PNG, the viewport clip);
7. undoes the batch (below), moves the diary back to today, writes `manifest.json` and verifies every PNG (IHDR
   1280 x 800, 24-bit RGB, decoded rows not blank), then prints `SCREENSHOTS PASS` or `SCREENSHOTS FAIL`.

**The undo.** It is armed just **before** **Add all** is pressed (with the page clock as a mark), so it runs even
when a later step fails, times out or is interrupted with Ctrl+C (a `finally` block): it first waits (up to 60 s) for
a batch that is still running; with no result and no batch newer than the mark, Add all never started and there is
nothing to undo; otherwise it presses **Undo this batch**; if the Results view never rendered it falls back to the
Input view's **Undo last batch**, then to the panel's own undo of `CMA.engineRpc.lastBatch` - each fallback only for
a batch newer than the mark, dated the empty day and holding as many ids as rows were added, so an older batch kept
in a reused `--profile` (it may belong to a real day) is never removed. The run passes only when the panel reports
**`Undo: 4 removed, 0 failed`** (4 = the rows added; another number with `--lines`). After Ctrl+C exactly one bounded
undo attempt is made (a second Ctrl+C skips it). Whenever the undo did not start, its outcome is unknown or it did not
remove everything, the script ends with `WARNING: entries were added to the diary on <day> and NOT undone` (or `the
undo did not remove everything`), names that day and leaves the diary on it: remove the entries there yourself.

Nothing is typed into any login form, no cookie is read, the session token never leaves the extension. Before
Chrome closes, the temporary profile's cronometer.com storage and all its cookies are cleared, and the profile folder
is then deleted (retried for 10 s; a folder that cannot be deleted is printed prominently: delete it by hand).
**`--profile DIR` keeps a logged-in Cronometer session on disk**: that folder is neither cleared nor deleted, so a
second run needs no login, and anyone who can read it can use the account. Keep it private and delete it when done.
The tool refuses a `--profile` inside the repository (and a live `--out` inside it other than `store-assets/`), so
`git add -A` cannot pick up a login or a live picture, and it refuses a profile in which the TDEE tab was ever
enabled (the owner's real history would be refreshed during the run and counted in `extra-diagnostics.png`).

## Regenerating

```
python tools/screenshots.py                          # live: a Chrome window opens and waits for the owner's login; writes store-assets/*.png
python tools/screenshots.py --extra                  # the same, plus extra-results.png and extra-diagnostics.png
python tools/screenshots.py --dry-run                # the same flow against tests/mock-cronometer.html (UI engine), writes store-assets/dry-run/
python tools/screenshots.py --dry-run --headless     # the self-check the test green bar runs (no window)
```

**A live run is done by the account owner together with the maintainer**, never as part of testing: it needs the
owner's login and writes four entries to the owner's real diary (on the empty future day) and removes them again.
What happens: log in in the window that opened (any way you like; the script only watches the page), then leave the
window alone. The console reports each step; after the login the empty-day search takes 10 to 60 seconds (one
diary day per step) and the shots about 30 seconds more. The console prints the empty day it chose, the undo outcome
and whether the diary still shows any of the entries.

Options (`--help` prints them with the tool's full description): `--out DIR` (default `store-assets/`),
`--extra`, `--profile DIR` (see above), `--keep-open` (leave the window until Enter is pressed), `--chrome PATH`,
`--login-timeout MIN`, `--engine rpc|ui` (only the RPC engine has an undo: with `ui` the four entries stay on the
empty day and the run fails, naming that day), `--delay-ms N`, `--lines FILE` (your own input lines: a line whose
unit the food does not have, e.g. `2 slices banana`, gives a `?` row with a *Use …* suggestion in the preview),
`--blur-selectors "a, b"` (more CSS selectors to blur), `--blur-text TEXT` (blur every element containing that text;
repeatable), `--no-blur` (nothing blurred: never for shots you upload). Exit status: 0 PASS, 1 FAIL (a step, a
capture or the verification), 2 environment (Chrome, DevTools pipe, extension install), 3 login not completed in
time / interrupted.

### What the dry run covers, and what it does not

`--dry-run` runs the same code against the mock diary, with synthetic data only: the extension scripts in an
isolated world named after the extension (found by name, as in the live run), the mock's **day navigation** with
seeded entries on the start day and on day +7 (so the empty-day search must skip +7 and settle on +8, and the run
fails otherwise), the plan-date checks, the capture guard (a synthetic row slipped into the mock's diary must make
it refuse the capture, and so must one added row hidden with a synthetic row in its place: the right count, one
foreign row), the undo state machine (driven offline against scripted answers: Add all never started, Undo this
batch, a stored batch of another day, batches older than Add all, a batch of the wrong size), a synthetic Water card
and Daily Target Editor header that the default selectors must match in every shot, the real panel buttons with the UI engine (the four adds must all land on the empty day),
the first-run notice and its **Continue** button (a temporary in-memory `chrome.storage.local` stands in for a new
profile during the setup step), the move back to the start day, **both TDEE shots over the same synthetic
stand-in** (the run fails unless the real data layer is back afterwards and its `enable()` / `sync()` were never
called), the MAIN-world blur CSS, the text blur (a synthetic name / e-mail label and a text input on the mock page
are marked; a password input and an `autocomplete=current-password` field are not) and the Diagnostics account-id
blur (a synthetic id). It always takes the two extras, so every capture path runs. The tool fails unless the dry-run
`manifest.json` lists `"data": "synthetic demo"` on shots 4 and 5 only, the empty day on every shot and the blur
entries. The mock has no hook, so after each arrow click the tool hands the mock's day to the extension's capture
(what the capture takes from the app's `getDayInfo` in a live run); the dry-run TDEE overview therefore also shows
"The Cronometer session is not captured" in its sync box, which a live run does not.

It does **not** cover: the real RPC undo in a page (its Undo buttons against Cronometer), the real login wait and the `#diary` nudge,
the session capture (`CMA.capture.ready`) and the real `getDayInfo` traffic behind each day step, the servings check
of a candidate day, reading the name / e-mail from the app's User object, the default blur selectors and the
empty-day row check against the real Cronometer layout, and the session clearing against a real login. Those only
run live.

## Before uploading

* **The account owner reviews every PNG** before it is uploaded (or force-added to git), even though the set is
  built to hold nothing personal: open each file at full size.
* Look for anything personal the blur did not cover (a widget Cronometer added since, a name in a place the tool does
  not know, a notification): pass `--blur-selectors` / `--blur-text` and run again rather than editing the PNGs.
* Check that shots 1 to 3 show the empty day with only the four sample foods, and that shots 4 and 5 show the
  synthetic person (trend weight around 83.7 kg, expenditure around 2,495 kcal/day, target 2,070 → 2,030), not the
  owner's numbers.
* Check that the console ended with `ok    undo: Undo: 4 removed, 0 failed` and `SCREENSHOTS PASS`; after a
  `WARNING` remove the leftover entries on the day it names.
* Keep `manifest.json` next to the PNGs (it is not uploaded); delete PNGs the run named as not being from it, then
  run `python tools/screenshots.py --check-store`.
* Never upload anything from `dry-run/`: it shows the mock page, not the real extension over the real diary.
* Upload `01` to `05` in file order. No cropping is needed: the browser UI is not part of a capture.
