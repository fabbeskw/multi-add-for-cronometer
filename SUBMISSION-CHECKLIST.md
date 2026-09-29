# Chrome Web Store submission checklist — Multi-Add for Cronometer 0.3.2

The short, ordered path from this repository to *Submit for review*. Every text block it mentions is in
[STORE-LISTING.md](STORE-LISTING.md) (section numbers below); every file is in this repository. Steps marked
**OWNER** can only be done by the person who owns the developer account: they involve their Google account, a
payment, a legal declaration or pressing Submit, and no script or assistant does them.

## A. One-time account setup (OWNER)

1. **OWNER** — Sign in at <https://chrome.google.com/webstore/devconsole> with the Google account that will own the
   listing, accept the developer agreement and pay the one-time registration fee.
2. **OWNER** — Turn on **2-Step Verification** for that Google account. It is mandatory: the store requires it
   "for all developer accounts prior to publishing an extension or updating".
3. **OWNER** — *Account* page: set the publisher name shown on the listing and a contact e-mail, then **verify the
   e-mail** (the link arrives by mail; publishing is blocked until it is verified).
4. **OWNER** — Declare **Trader** or **Non-Trader** (EU Digital Services Act). A trader's legal name, address and
   phone number are shown publicly on the listing; a hobby project given away for free is usually non-trader, but
   this is the owner's legal decision.
5. **OWNER, required** — Create a **dedicated free Cronometer test account** for the reviewers (never the personal
   account): log about **three weeks** of synthetic food entries and a weigh-in every day, so the TDEE tab shows an
   estimate rather than "log a few days first" (reviewers rarely create third-party accounts, and an empty or broken
   tab invites a *not working* rejection). Then, with the 0.3.2 package loaded, open that account's TDEE tab, press
   **Enable** and check that it reads the history and shows an estimate and a weekly target; this is also the first
   live check of the TDEE reads (SPEC §12.6). Keep the login out of the repository.

## B. Build and check the package (anyone with the repository)

Run from the repository root; every line must end green:

```
bash tests/run.sh
python tools/check_manifest.py
python tools/gen_tdee.py --check
python tools/build_zip.py                         # → dist/multi-add-for-cronometer-0.3.2.zip
python tools/smoke_extension.py --self-test
python tools/smoke_extension.py dist/multi-add-for-cronometer-0.3.2.zip --self-test   # installs the zip itself
python tools/screenshots.py --dry-run --headless
python tools/make_graphics.py --verify           # icons + promo tiles: sizes, transparency, 16 px padding (no Chrome)
python tools/set_repo_url.py https://github.com/fabbeskw/multi-add-for-cronometer --check
```

Then:

5a. **Publish the source the policy points to.** The package, the listing and the dashboard link to
    `https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md`, and the policy and the reviewer
    notes say the public source can be checked against the zip. Until the 0.3.2 tree is on the default branch that
    URL serves an older policy (0.3.0: no Limited Use statement, no first-run notice; 0.3.1: no custom-only search,
    no calorie amounts).
    So: `git status` shows nothing uncommitted that belongs to the release (the whole 0.3.2 tree committed, including
    `SUBMISSION-CHECKLIST.md`, `graphics/`, `store-assets/promo/`, `icons/icon32.png`, `tools/make_graphics.py`), it is
    pushed to `main` and tagged `v0.3.2`; then, **logged out of GitHub** (a private window), the policy URL above shows
    the effective date 29 September 2026, section 6 with **Limited Use**, section 8 with the **First-run notice** and
    the 0.3.2 entry in section 11.
6. Unzip `dist/multi-add-for-cronometer-0.3.2.zip` into a temporary folder, *Load unpacked* it on
   `chrome://extensions`, open `https://cronometer.com/#diary`, reload, open the panel, check that the first-run notice
   appears (with *Remember my last typed list* unticked) and press **Continue**, add two foods and undo them. With a
   custom food in the account, *Find foods* on `<its name> /custom` must preview only custom items (the first live
   check of the custom-only search, SPEC Appendix M); Diagnostics must show no `custom-only search: dropped` line.
   Then *Find foods* on `300cal <some food>` (a plain database food, e.g. `300cal almonds`): the preview must say
   `300 kcal → …` with a sensible amount; **Add all** and confirm that Cronometer's diary shows about 300 kcal for that
   entry (the first live check of calorie amounts, SPEC Appendix N), then **Undo this batch**. Remove the unpacked
   extension again.
7. The five screenshots (see STORE-LISTING §1, *The five screenshots*) are the live 0.3.1 set of 28 September 2026
   (`store-assets/manifest.json`), reused for 0.3.2: none of the five views changed (the cheat-sheet in shot 1 is
   collapsed, and the preview footer names no search scope while *Search only my custom foods* is off).
   `python tools/screenshots.py --check-store` must still print `STORE SET READY` (exactly the five live shots, the
   TDEE ones on synthetic data, the undo completed, nothing else in the folder; it does not compare the recorded
   extension version). **OWNER** — open every PNG and confirm that no name, e-mail, account number, water or calorie
   target or other real health figure is visible. If the dashboard already holds these five (uploaded with 0.3.1),
   nothing needs uploading again. Never upload anything from `store-assets/dry-run/` (the mock page, not the real
   extension). When a later version changes one of these views, the owner renders a new set together with the
   maintainer (`python tools/screenshots.py`, a live run that needs the owner's login; it writes four sample entries
   to an empty future day of the diary and undoes them): first the **OWNER** deletes the current PNGs from
   `store-assets/` (`01-input.png`, `02-preview.png`, `03-diary.png`, `04-tdee-overview.png`,
   `05-tdee-checkin.png`), because the live run refuses to start while any picture is in that folder; then
   `--check-store` and the look at every PNG as above, and the new `store-assets/manifest.json` is committed; the PNGs
   stay out of git.
8. Attach the same zip to a GitHub Release tagged `v0.3.2`, so the README's *From a release zip* install path
   matches the store package.

## C. Developer Dashboard, field by field

*New item* (an update of an item that already exists: its *Package* tab → *Upload new package*) → upload
`dist/multi-add-for-cronometer-0.3.2.zip`. Name, summary, version, icon and permissions are read from the manifest in
the zip.

| Tab | Field | What to enter |
|---|---|---|
| Store listing | Description | STORE-LISTING §1 *Detailed description* (the whole block) |
| Store listing | Category | **Tools** |
| Store listing | Language | English |
| Store listing | Store icon | `icons/icon128.png` (if the dashboard asks; otherwise taken from the zip) |
| Store listing | Screenshots | the five 1280 × 800 PNGs from `store-assets/`, in the order of STORE-LISTING §1 (input, preview, diary, TDEE overview, TDEE check-in; names in `store-assets/manifest.json`), only after `--check-store` passed (step 7); never the dry-run shots |
| Store listing | Small promo tile (required) | `store-assets/promo/small-promo-440x280.png` |
| Store listing | Marquee promo tile (optional) | `store-assets/promo/marquee-1400x560.png` |
| Store listing | Promo video | leave empty |
| Store listing | Official URL | leave empty |
| Store listing | Homepage URL | `https://github.com/fabbeskw/multi-add-for-cronometer` |
| Store listing | Support URL | `https://github.com/fabbeskw/multi-add-for-cronometer/issues` |
| Store listing | Mature content | No |
| Privacy | Single purpose | STORE-LISTING §2 *Single purpose description* |
| Privacy | Justification: `storage` | STORE-LISTING §2 *Permission justification — storage* |
| Privacy | Justification: host permission | STORE-LISTING §2 *Permission justification — host permission* |
| Privacy | Remote code | **No, I am not using remote code** (plus the §2 *Remote code* block if a text field appears) |
| Privacy | Data usage | tick **Personally identifiable information, Health information, Authentication information, User activity, Website content**; leave Financial and payment, Personal communications, Location, Web history unticked (STORE-LISTING §2 table) |
| Privacy | Certifications | certify all three |
| Privacy | Privacy policy URL | `https://github.com/fabbeskw/multi-add-for-cronometer/blob/HEAD/PRIVACY.md` |
| Test instructions | Instructions | STORE-LISTING §3 *Test instructions — with the test account* (the block has no placeholder) |
| Test instructions | Username / password | the test login from step 5, typed by the owner into the tab's login fields (if the tab has none, on a line of its own after the block); nowhere else |
| Test instructions | (more text, if accepted) | STORE-LISTING §3 *Reviewer notes* |
| Distribution | Payment | Free |
| Distribution | Visibility | **Unlisted** |
| Distribution | Regions | All regions |

9. *Save draft*, then *Preview*: fix every field the dashboard marks in red.

## D. Submit (OWNER)

10. **OWNER** — Only when A5 (test account, TDEE checked live), 5a (the public policy URL shows the 0.3.2 text) and 7
    (`--check-store` passed, every PNG looked at) are done: press **Submit for review**. Choose whether to publish automatically after approval (default) or to
    defer; a deferred approval must be published within 30 days or it returns to draft.
11. Review usually takes a few days and can take a few weeks for a new developer and a new item. Contact developer
    support only after three weeks.

## E. After approval

12. Done for 0.3.1 (item `eggnohhalgffodifhpdpedeofilfffhd`, in README *Install* since 0.3.2). For the record: in README.md *Install*, replace
    `<Chrome Web Store URL>` with that link and drop *coming soon* with the review note in brackets.
13. Share the Unlisted link with a few users. After the first Cronometer deploy has been handled well by the
    automatic decoder rebuild, set Visibility to **Public** and republish (it may be reviewed again).

## F. If the submission is rejected

The e-mail names the policy and a violation code. Do not untick data-usage boxes or hide a feature to get through:
an inaccurate disclosure is itself a violation. Fix the cause, then (if the package changed) raise the version in
`manifest.json`, add a changelog line, run section B again, upload the new zip and resubmit. If the rejection looks
wrong, reply or appeal through the link in the e-mail and quote the relevant STORE-LISTING §3 reviewer note.

| Code | Usual meaning here | What to do |
|---|---|---|
| Red Magnesium / Red Lithium (single purpose) | bulk add and TDEE seen as two purposes | reply with the STORE-LISTING §2 reasoning once; if it is upheld, move the TDEE tab into its own extension (STORE-LISTING §6) and resubmit this one without it |
| Purple Nickel (disclosure / consent) | data read or stored before an in-product notice and consent | since 0.3.1 the panel has the first-run notice (it says the session and account id were read from the page's start-up requests and are held in memory only; nothing typed is stored before *Continue*, the typed list only if the user ticks the opt-in box) and the TDEE *Enable*; reply with that; if the reviewer objects to the session hook observing traffic before the notice, gate the capture behind the acknowledgement (STORE-LISTING §6), update PRIVACY.md, resubmit |
| Purple Lithium (privacy policy) | policy URL unreachable or incomplete | check that the PRIVACY.md link opens while logged out of GitHub; the repository must be public |
| Blue Argon (remote code) | the decoder rebuild's `.cache.js` downloads | reply with the *Remote code* block and point at `src/lib/registry-builder.js` (text parsing, no eval) |
| Red Titanium (obfuscation) | hashes and short names in `src/lib/gwt-registry.js` | reply that it is generated data and link `tools/gen_registry.py` |
| Yellow Magnesium (not working) | the reviewer could not reach the feature | check the test account from step 5 still logs in and shows a TDEE estimate; improve the test instructions (the reload step) |
| Yellow Zinc / Yellow Argon (metadata) | missing asset, outdated screenshots, keyword repetition | supply the asset or regenerate the shots; keep the brand word at five or fewer in the description |
| Purple Potassium (permissions) | a permission not needed | the manifest asks only `storage` and `https://cronometer.com/*`; reply with the justifications |
