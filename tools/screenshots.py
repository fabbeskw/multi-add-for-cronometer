#!/usr/bin/env python3
"""screenshots.py - the five Chrome Web Store screenshots (1280x800 PNG) of the REAL extension, privacy-safe by
construction: the multi-add shots are taken on an EMPTY future day of the diary and the TDEE shots show SYNTHETIC
demo data. Driven through the Chrome DevTools Protocol; the human does the login (Python 3, stdlib).

    python tools/screenshots.py [--out DIR] [--dry-run] [--headless] [--extra] [--profile DIR] [--keep-open]
                                [--chrome PATH] [--login-timeout MIN] [--engine rpc|ui] [--delay-ms N]
                                [--lines FILE] [--blur-selectors "sel, sel"] [--blur-text TEXT ...] [--no-blur]
    python tools/screenshots.py --check-store      # no Chrome: is store-assets/ exactly the five live shots? (exit 0/1)

The store set, in upload order (in <out>/):
  01-input.png          the panel's Input view over the diary: the sample list (a '## Dinner' header, an '@snacks'
                        tag), group Dinner selected, the diary date, the engine and Find foods
  02-preview.png        the preview table after Find foods (food, quantity, unit, grams, group, Add all)
  03-diary.png          the panel closed: the diary day with the new entries in Dinner and Snacks
  04-tdee-overview.png  the TDEE tab: the expenditure card (+/- band, status chip), the this-week card (target,
                        macros, expected weekly change) and the charts - SYNTHETIC demo data
  05-tdee-checkin.png   the weekly check-in dialog (old -> new target and the plain-English why) - SYNTHETIC demo data
--extra also writes extra-results.png (the Results view after Add all, with Undo this batch) and
extra-diagnostics.png (the Diagnostics view, the account id blurred). They are not part of the store set; the dry
run always takes them, so the green bar covers every capture path.

Privacy by construction:
  * EMPTY DAY. Before anything is added the diary is moved FORWARD with its own authored '.diary-date-next' arrow
    (one click = one day; every step waits until the app's getDayInfo for that day has reached the extension's
    capture) to today + 7 and checked: the diary FlexTable must hold no entry row (every row that is not a
    meal-group header 'td.diary-group-row' and carries text counts, hidden ones too) and, live, the extension's own
    getDayInfo read of that day must list no serving and no other element (exercise, biometric, note: a note can
    carry personal text; fail closed). A day with entries is skipped, up to 30 more days; when none is empty the run
    stops before adding anything. The extension adds to the day the diary shows: the panel's date and the plan's
    date are checked to be that day before Add all, and every capture is refused unless the diary still shows it
    (the app's last getDayInfo for that day answered HTTP 200) and every rendered entry row (counted once the rows
    have settled) contains the name of a food this run added - at most the rows added, exactly that many once they
    were all seen. After the undo the diary is moved back to the day it opened on (today).
  * SYNTHETIC TDEE. Shots 4-5 never read or show the owner's TDEE data. Inside the extension's isolated world the
    tool swaps CMA.tdeeData for an in-memory stub of the SPEC 12.3 contract: a synthetic person (120 days, trend
    weight 89.8 -> 83.7 kg, food logged on ~85% of days, weigh-ins on ~80%, Cronometer's burned ~8% high, a
    -0.5 %/week goal since day 21 with weekly check-ins; seeded, so the numbers are the same on every run, and dated
    so that its last day is today). It renders the TDEE tab, opens the check-in dialog, cancels it and puts the real
    data layer back. The tool never calls a method of the real layer; while the stub is in place the real enable()
    and sync() are replaced by refusing guards (counted: the dry run fails on any call). manifest.json records
    "data": "synthetic demo" for shots 4-5.
  * BLUR. Before every capture the MAIN world gets a blur style (filter: blur(9px)): DEFAULT_BLUR_SELECTORS (authored
    class names of the compiled app, see the comment there: the navbar account, the Energy Summary and targets
    widgets, the whole Water card and the Daily Target Editor's profile name), every element whose text carries the
    account's first name or e-mail address (read from the app's own User object, never printed; a NOTE is logged
    when no first name is found, so the owner can pass --blur-text), --blur-selectors / --blur-text additions and,
    in extra-diagnostics.png, the numeric account id inside the dump. The text blur runs again right before each
    capture, so an element rendered during the pause is caught (the capture is refused if new ones keep
    appearing). Diary entries are never blurred (the day holds only the sample foods).
  * UNDO. The RPC engine's undo is armed just BEFORE Add all is pressed (with the page clock as a mark), so a
    failure, a timeout or Ctrl+C anywhere after that still triggers it (a finally block): it waits (bounded) for a
    batch still running; no result and no batch newer than the mark means Add all never started (nothing to undo);
    otherwise it presses Undo this batch (fallbacks: the Input view's Undo last batch, then
    CMA.panel.undo(CMA.engineRpc.lastBatch), each only when the batch it would remove is newer than the mark, dated
    the empty day and of the size added - a stored batch of an older run, e.g. in a reused --profile, is never
    touched) and requires the outcome 'Undo: N removed, 0 failed' (N = the rows added: 4 for the sample list).
    After Ctrl+C exactly one bounded undo attempt is made. Whenever the undo did not complete the script ends with
    a loud WARNING naming the diary day that still holds the entries.
  * NOTHING OLD, NOTHING COMMITTABLE. A live run refuses to start while <out> already holds a picture (an earlier
    set may show a real diary and shares names with the new one: the owner looks at them and deletes them); a live
    --out must be store-assets/ (git-ignored PNGs) or outside the repository, and --profile (a logged-in session)
    must be outside it. A profile where the TDEE tab was enabled is refused (its real history would sync during the
    run). manifest.json times are UTC.

What it does (live mode, the default):
  1. starts a VISIBLE Chrome on a throw-away profile (or --profile DIR) through --remote-debugging-pipe, sizes the
     window so the page viewport is 1280x800 and pins it with Emulation.setDeviceMetricsOverride(1280x800, dpr 1);
  2. installs the extension from this repository with Extensions.loadUnpacked (Google Chrome 137+ ignores
     --load-extension; see tools/smoke_extension.py) BEFORE the diary is opened, then opens
     https://cronometer.com/#diary;
  3. waits (up to --login-timeout minutes, default 15) for the human to log in: the document must hold the app's
     <iframe id="cronometer">, the diary FOOD button and the extension's panel host. It never touches the login
     form; if the app landed on another view it only sets location.hash = '#diary'. Then it waits for the
     extension's session capture (RPC engine) and for the diary day from the app's getDayInfo;
  4. drives the extension through its OWN isolated world (Runtime.evaluate in the execution context whose origin is
     chrome-extension://<id>, auxData.isDefault false) by pressing the panel's real buttons: moves the diary to an
     empty future day (above), presses Continue on the panel's first-run notice (a new profile shows it once, in
     place of the Input view), types the sample list (shot 01), presses Find foods (shot 02), Add all (RPC engine:
     real updateDiary requests; --extra: extra-results.png), closes the panel and scrolls Dinner into view (shot
     03; --extra: extra-diagnostics.png), shows the TDEE tab over the synthetic stub (shots 04, 05), then undoes the
     batch and moves the diary back to today;
  5. writes <out>/manifest.json ([{file, shot, set, data, diaryDay, capturedAt, blurred, mode, size,
     extensionVersion, chrome, undo}, ...]; `undo` = what became of the added entries, e.g. 'Undo: 4 removed, 0
     failed') and verifies every PNG (IHDR 1280x800, 24-bit RGB, decoded rows not blank).
  6. afterwards, --check-store confirms the folder is ready to upload: exactly the five store shots, 'mode': 'live',
     the TDEE ones 'synthetic demo', a completed undo, valid PNGs, and no other picture in the folder.

--dry-run: everything except Cronometer. Opens tests/mock-cronometer.html (the fake diary + Add Food dialog of
tests/engine-ui.html) and switches on its day navigation (mock.useDays) with SYNTHETIC seeded entries on the start
day and on day +7, so the empty-day search has to skip a day. The extension does not inject on file: pages, so the
tool creates an isolated world named after the extension (Page.createIsolatedWorld), evaluates the ISOLATED-world
scripts of manifest.json into it in manifest order and mounts the panel by hand; the world is then found by name as
in the live run. The mock has no hook, so after each arrow click the tool writes the mock's day into
CMA.capture.state.diaryDate (what the capture takes from the app's getDayInfo). The scenario runs with the UI engine
(the mock has no RPC; the UI engine has no undo, so the undo is replaced by a check of the mock's window.__added). A
synthetic account label and id are added so the text blur and the Diagnostics id blur run too. For the setup step
only, a temporary in-memory chrome.storage.local stands in for a new profile's storage, so the first-run notice
appears and its Continue button is pressed as in the live run. A synthetic Water card and Daily Target Editor
header must be matched by the blur in every shot; the capture guard must refuse the day with one row too many and
the day with the right count but one foreign row; and the undo state machine is driven offline against scripted
answers (undo_probe_cases: never started, Undo this batch, a stored batch of another day, batches older than Add
all, a batch of the wrong size). The five shots, both extras and the synthetic TDEE demo are taken and checked; the
PNGs go to <out>/dry-run/. --headless implies --dry-run (nobody can log in to a headless window). The dry run is
part of the green bar: `python tools/screenshots.py --dry-run --headless`. It does not exercise the real RPC undo
in a page, the real login wait, the getDayInfo servings check or js_account_texts() against the app's User object.

Robustness: every wait has a timeout and names what it waited for; Ctrl+C closes Chrome (unless --keep-open, which
keeps the window until Enter is pressed - Chrome exits when the DevTools pipe closes, so the script has to stay
alive for that); no credential is ever typed. The temporary profile is deleted unless --profile was given; before
Chrome closes its cronometer.com storage and cookies are cleared so a profile that cannot be deleted holds no usable
login (a --profile DIR is left logged in on purpose, so treat that directory as a credential). Exit status: 0 =
PASS, 1 = FAIL (scenario, capture or verification), 2 = environment (Chrome, DevTools pipe, extension install), 3 =
the login was not completed in time or the run was interrupted.
"""
import argparse
import base64
import collections
import datetime
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Cdp, find_chrome  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIDTH, HEIGHT = 1280, 800
LIVE_URL = 'https://cronometer.com/#diary'
MOCK_PAGE = os.path.join(ROOT, 'tests', 'mock-cronometer.html')
# The store set in upload order, and the extras (--extra; the dry run always takes them).
STORE_SHOTS = [('01-input.png', 'input'), ('02-preview.png', 'preview'), ('03-diary.png', 'diary'),
               ('04-tdee-overview.png', 'tdee-overview'), ('05-tdee-checkin.png', 'tdee-checkin')]
EXTRA_SHOTS = [('extra-results.png', 'results'), ('extra-diagnostics.png', 'diagnostics')]
TDEE_SHOT_FILES = ('04-tdee-overview.png', '05-tdee-checkin.png')
# The earlier five-shot set (up to 0.3.0) used these names too. The dry run removes its own old files; a live output
# folder is never cleaned: a live run refuses to start while it holds any picture (old_pictures), and
# write_manifest() still names PNGs there that are not from the run.
LEGACY_SHOTS = ('03-results.png', '04-diary.png', '05-diagnostics.png')
SYNTHETIC = 'synthetic demo'          # manifest.json "data" of the TDEE shots
# The lines the store shots show (a header, a fraction, a size word and an @group tag: the format is visible).
LIVE_LINES = '## Dinner\n200g chicken breast\n1 1/2 cups rice, cooked\n2 large eggs\n1 medium banana @snacks'
# The same list spelled with the mock dataset's food names (tests/mock-cronometer.js DATASET), so every row of the
# dry run matches a result row of the fake dialog: the UI engine matches result rows by the typed name.
DRY_LINES = '## Dinner\n200g chicken breast, roasted\n1 1/2 cups rice, white, cooked\n2 large egg, whole, cooked\n1 medium banana, raw @snacks'
FOOD_BUTTON_SEL = 'button.button-panel-btn[title="Log a serving to your diary"]'   # SPEC 7 step 2, panel.js FOOD_BUTTON_SEL
HOST_ID = 'cma-multi-add-host'                                                       # panel.js HOST_ID
BLUR_STYLE_ID = 'cma-shot-blur'
BLUR_ATTR = 'data-cma-blur'
# Authored class names / ids of the compiled Cronometer client (tools/bundle/all.js, build 0A1C16E1...), grepped on
# 2026-09-28: the Pro navbar's account switcher (`Kth` template: button#navbarDropdown.navbar-account and its
# div.navbar-dropdown-container listing "Current Account:"), the page header of the login / Pro onboarding pages
# (#cronometer-header), and the diary's summary column widgets that show personal numbers - the Energy Summary
# (`fAd` adds 'energy-summary', `sHc` 'energy-summary-totals', `zIc` 'energy-summary-totals-container'), the
# targets block (`BBd` 'target-summary-container', `fEd` 'nutrient-targets-container', constant b4p
# 'macro-targets', the water bars 'display-water-target-bar' / 'water-tracking-target-bar') and the Daily Target
# editor ('targets-container'). The whole Water card carries the authored class 'water-tracking' (its heading
# 'Water <n> / <target> mL' sits outside the two bars), and the Daily Target Editor header is the template
# "<div class='daily-target-editor-title'>DAILY TARGET EDITOR <span/></div> <span/>" whose spans hold the target
# profile's name (which the user can choose): both spans are blurred, the fixed title text is not.
# Diary entries (.diary-panel rows, .diary-group*) are deliberately absent.
DEFAULT_BLUR_SELECTORS = [
    '#navbarDropdown', '.navbar-account', '.navbar-dropdown-container',
    '#cronometer-header', '.cronometer-header',
    '.energy-summary', '.energy-summary-totals', '.energy-summary-totals-container',
    '.target-summary-container', '.nutrient-targets-container', '.macro-targets',
    '.water-tracking', '.display-water-target-bar', '.water-tracking-target-bar', '.targets-container',
    '.daily-target-editor-title span', '.daily-target-editor-title ~ *',
]
# The dry run adds synthetic stand-ins for these (dry_account) and requires every one to be matched and blurred.
DRY_BLUR_PROBES = ('.water-tracking', '.daily-target-editor-title span', '.daily-target-editor-title ~ *')
# The diary's date arrows (authored classes; SPEC 6.5: <i> elements, the first VISIBLE one inside .diary-panel, since
# the hidden ClientDiaryDate panel uses the same classes). One click = one day = one getDayInfo.
NEXT_SEL, PREV_SEL = '.diary-date-next', '.diary-date-previous'
EMPTY_DAY_FIRST = 7            # the empty-day search starts this many days after today ...
EMPTY_DAY_MORE = 30            # ... and steps forward at most this many days further
MAX_DAY_STEPS = EMPTY_DAY_FIRST + EMPTY_DAY_MORE + 14   # bound for any single move of the diary (back to today included)
DAY_STEP_TIMEOUT_S = 20        # one arrow click until the extension's capture saw the app's getDayInfo for the new day
DAY_SETTLE_S = 1.2             # a day must look the same (3 polls in a row) for this long before its rows are counted
DAY_SETTLE_TIMEOUT_S = 12
# Dry run: synthetic entries on the mock's start day and on day +7 (the search must skip +7 and settle on +8).
DRY_SEED = {0: [('Breakfast', 'Seeded entry, start day (synthetic)', '1 serving')],
            EMPTY_DAY_FIRST: [('Lunch', 'Seeded entry, day +7 (synthetic)', '1 serving')]}
DRY_MOCK_DELAY_MS = 150        # the mock's day switch lands this long after the click (the app waits for getDayInfo)
# The synthetic TDEE person of JS_TDEE_DEMO_INSTALL: 120 days; the seed was chosen for an ordinary week (trend
# -0.46 kg, target 2,070 -> 2,030 kcal, Cronometer ~8 % high). Deterministic: the same numbers on every run.
TDEE_DEMO = {'days': 120, 'seed': 91, 'startKg': 89.6, 'trueTdee': 2700, 'cutDay': 21, 'rate': -0.5, 'cronoFactor': 1.09}
LOGIN_TIMEOUT_MIN = 15
READY_TIMEOUT_S = 120          # after the diary is visible: the capture must have seen authenticate / getDayInfo
FIND_TIMEOUT_S = 240           # 5 searches + getFood each + a possible 10 s decoder rebuild
ADD_TIMEOUT_S = 300            # 5 updateDiary + refresh (UI engine: a few seconds per row)
UNDO_TIMEOUT_S = 180
UNDO_RUN_WAIT_S = 60           # the undo first waits this long for a batch still running (Ctrl+C / timeout mid-run)
UNDO_TIMEOUT_INTERRUPTED_S = 60   # the single undo attempted after Ctrl+C is bounded tighter
TDEE_RENDER_TIMEOUT_S = 20
PROFILE_DELETE_TRIES, PROFILE_DELETE_PAUSE_S = 20, 0.5
# The dry run's synthetic account (never a real one): the text blur and the Diagnostics id blur must mark these.
DRY_ACCOUNT_NAME = 'Dryrunner'
DRY_ACCOUNT_EMAIL = 'dry.runner@example.test'
DRY_ACCOUNT_ID = '424242'
DRY_TEXT_HITS = 3              # the name span, the e-mail span, the text input holding the e-mail (not the password fields)

EXIT_OK, EXIT_FAIL, EXIT_ENV, EXIT_LOGIN = 0, 1, 2, 3


class StepError(Exception):
    """A scenario step did not reach its state in time, or the page answered something unexpected."""


class EnvError(Exception):
    """Chrome / the DevTools pipe / the extension install are unusable."""


class LoginTimeout(Exception):
    """The human did not log in within --login-timeout."""


def js(v):
    """A JSON literal that is also a JavaScript literal (safe embedding of Python values into snippets)."""
    return json.dumps(v)


def now_iso():
    # UTC: manifest.json is committed, and a local offset would tell where the owner lives
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def log(msg):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


def local_today():
    return datetime.date.today().isoformat()


def add_days(iso, n):
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)).isoformat()


def days_between(a, b):
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days


def offset_text(iso, base):
    n = days_between(base, iso)
    return 'today' if n == 0 else '%+d days' % n


# ---------------------------------------------------------------------------------------------------- JavaScript
# Snippets are IIFEs so `returnByValue` gets a plain object. Everything the extension world returns is state or
# counts; the nonce, the account name, the e-mail and the diary's food names never travel to the console (see
# js_account_texts()). Dates travel as 'YYYY-MM-DD'.
JS_ISO = "const iso = (d) => (d && d.year ? d.year + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0') : null);"
JS_PAGE_STATE = "(() => ({app: !!document.getElementById('cronometer'), food: !!document.querySelector(%s), host: !!document.getElementById(%s), hash: location.hash, path: location.pathname, ready: document.readyState}))()" % (js(FOOD_BUTTON_SEL), js(HOST_ID))
JS_NUDGE_DIARY = "(() => { location.hash = '#diary'; return location.hash; })()"
JS_EXT_PROBE = "(() => ({cma: typeof CMA === 'object', panel: !!(typeof CMA === 'object' && CMA.panel && typeof CMA.panel.mount === 'function'), host: !!document.getElementById(%s)}))()" % js(HOST_ID)
JS_READY = """(() => {
  try {
    const r = CMA.capture.ready();
    const s = CMA.capture.state || {};
    return {ok: !!r.ok, missing: r.missing || [], hasUserId: s.userId != null, mismatch: !!s.registryMismatch,
            groups: (s.groups || []).filter(g => g.enabled).map(g => g.name), groupsSource: s.groupsSource || null};
  } catch (e) { return {ok: false, missing: ['capture error: ' + (e && e.message)]}; }
})()"""
JS_USER_ID = "(() => { const s = CMA.capture && CMA.capture.state; return s && s.userId != null ? String(s.userId) : null; })()"
# The day the diary shows, as the extension's capture learned it from the app's own getDayInfo (hook-relayed; the
# extension's own reads are never relayed, SPEC 6.4), and when that getDayInfo arrived.
JS_CAPTURE_DAY = """(() => {
  %s
  const s = (typeof CMA === 'object' && CMA.capture && CMA.capture.state) || {};
  const g = s.lastGetDayInfo || null;
  return {date: iso(s.diaryDate), source: s.diaryDateSource || null, t: g && g.t ? g.t : 0, status: g ? g.status : null};
})()""" % JS_ISO
JS_MOCK_DAY = "(() => ({date: window.mock && typeof mock.date === 'function' ? mock.date() : null, changes: window.mock && typeof mock.dayChanges === 'function' ? mock.dayChanges() : -1}))()"
# The diary FlexTable (`Mud`, SPEC 7): a meal group's header row holds td.diary-group-row; every other row with text is
# an entry (a serving, exercise, biometric, note...). Rows of nested tables are not the table's own rows (t.rows).
# Only counts and the class names of the first entry row's cells leave the page (never a food name).
# `foreign` = rendered entry rows whose text contains none of `names` (the foods this run added; all rows when empty).
def js_day_rows(names=None):
    return """(() => {
  const names = %s.map(n => String(n).toLowerCase()).filter(Boolean);
  const heads = Array.from(document.querySelectorAll('td.diary-group-row'));
  const tables = [];
  for (const td of heads) { const t = td.closest('table'); if (t && tables.indexOf(t) < 0) tables.push(t); }
  let entries = 0, hidden = 0, foreign = 0, cells = null;
  for (const t of tables) {
    for (const tr of Array.from(t.rows)) {
      if (Array.from(tr.cells).some(c => c.classList.contains('diary-group-row'))) continue;
      const text = (tr.textContent || '').trim().toLowerCase();
      if (!text) continue;
      entries++;
      if (!tr.getClientRects().length) { hidden++; continue; }
      if (!names.some(n => text.includes(n))) foreign++;
      if (!cells) cells = Array.from(tr.cells).map(c => c.className || '-').join(' | ').slice(0, 160);
    }
  }
  return {groups: heads.length, visibleGroups: heads.filter(td => td.getClientRects().length > 0).length,
          tables: tables.length, entries, hidden, foreign, cells};
})()""" % js([str(n) for n in (names or [])])


JS_DAY_ROWS = js_day_rows()
JS_PANEL_DATES = """(() => {
  %s
  const st = CMA.panel.getState(), s = CMA.capture.state || {};
  return {diary: iso(s.diaryDate), source: s.diaryDateSource || null, override: iso(st.dateOverride), plan: st.plan ? iso(st.plan.date) : null};
})()""" % JS_ISO
JS_INPUT_STATE = """(() => {
  const root = CMA.panel.root, st = CMA.panel.getState();
  const find = Array.from(root.querySelectorAll('.cma-footer button')).find(b => b.textContent.trim() === 'Find foods');
  const banner = root.querySelector('.cma-banner');
  return {view: st.view, open: st.open, engine: st.settings.engine, input: st.input.length, find: !!find, findDisabled: !find || find.disabled,
          banner: banner && !banner.hidden ? banner.textContent.trim().slice(0, 160) : ''};
})()"""
JS_PREVIEW_STATE = """(() => {
  const root = CMA.panel.root, st = CMA.panel.getState();
  const rows = root.querySelectorAll('table.cma-preview tbody tr');
  const notice = root.querySelector('.cma-notice');
  const add = Array.from(root.querySelectorAll('.cma-footer button')).find(b => /^Add all/.test(b.textContent.trim()));
  const counts = {ready: 0, choice: 0, error: 0};
  if (st.plan) for (const r of st.plan.rows) { if (r.status === 'ready') counts.ready++; else if (r.status === 'needs-choice') counts.choice++; else counts.error++; }
  return {view: st.view, building: st.building, hasPlan: !!st.plan, rows: rows.length, counts,
          status: (root.querySelector('.cma-status') || {textContent: ''}).textContent.trim().slice(0, 200),
          notice: notice && !notice.hidden ? notice.textContent.trim().slice(0, 300) : '',
          add: !!add, addDisabled: !add || add.disabled, addTitle: add ? add.title : ''};
})()"""
JS_RESULTS_STATE = """(() => {
  const root = CMA.panel.root, st = CMA.panel.getState();
  const undo = Array.from(root.querySelectorAll('.cma-footer button')).find(b => /^Undo this batch/.test(b.textContent.trim()));
  const notice = root.querySelector('.cma-notice');
  const res = st.result;
  return {view: st.view, running: st.running, hasResult: !!res,
          added: res ? res.added.length : 0, failed: res ? res.failed.length : 0, skipped: res ? res.skipped.length : 0,
          ticks: root.querySelectorAll('ul.cma-results li.cma-r-ok').length, crosses: root.querySelectorAll('ul.cma-results li.cma-r-fail').length,
          undo: !!undo, undoDisabled: !undo || undo.disabled,
          status: (root.querySelector('.cma-status') || {textContent: ''}).textContent.trim().slice(0, 300),
          firstError: res && res.failed.length ? String(res.failed[0].error || '').slice(0, 200) : '',
          notice: notice && !notice.hidden ? notice.textContent.trim().slice(0, 300) : '',
          lastBatch: res && res.lastBatch && Array.isArray(res.lastBatch.servingIds) ? res.lastBatch.servingIds.length : 0,
          engineBatch: CMA.engineRpc && CMA.engineRpc.lastBatch && Array.isArray(CMA.engineRpc.lastBatch.servingIds) ? CMA.engineRpc.lastBatch.servingIds.length : 0};
})()"""
# Last-resort undo: the panel's own undo() on the engine's lastBatch (not awaited: JS_UNDO_STATE reports the outcome).
JS_UNDO_ENGINE_BATCH = """(() => {
  const b = CMA.engineRpc && CMA.engineRpc.lastBatch;
  if (!b || !Array.isArray(b.servingIds) || !b.servingIds.length) return {clicked: false, why: 'no CMA.engineRpc.lastBatch'};
  CMA.panel.undo(b);
  return {clicked: true, text: 'CMA.panel.undo(CMA.engineRpc.lastBatch) (' + b.servingIds.length + ')'};
})()"""
# The identity of the batches an undo could remove (never the ids themselves): the engine's in-memory lastBatch
# and the panel's storedBatch (what the Input view's "Undo last batch" removes; loaded from chrome.storage.local, so
# with a reused --profile it can be an older batch of another day), plus the page clock for arming.
JS_BATCH_IDS = """(() => {
  %s
  const one = (b) => (b && Array.isArray(b.servingIds) ? {date: typeof b.date === 'string' ? b.date.slice(0, 10) : iso(b.date), n: b.servingIds.length, at: Number(b.at) || 0} : null);
  const st = CMA.panel.getState();
  return {now: Date.now(), engine: one(CMA.engineRpc && CMA.engineRpc.lastBatch), stored: one(st.storedBatch), result: one(st.result && st.result.lastBatch)};
})()""" % JS_ISO
JS_ADDED_NAMES = """(() => {
  const st = CMA.panel.getState();
  if (!st.result) return [];
  return st.result.added.map(a => (a.row.hit && a.row.hit.name) || (a.row.item && a.row.item.name) || '').filter(Boolean);
})()"""
JS_UNDO_STATE = """(() => {
  const root = CMA.panel.root, st = CMA.panel.getState();
  const notice = root.querySelector('.cma-notice');
  const status = (root.querySelector('.cma-status') || {textContent: ''}).textContent.trim();
  const n = notice && !notice.hidden ? notice.textContent.trim() : '';
  const lb = CMA.engineRpc && CMA.engineRpc.lastBatch;
  return {status: status.slice(0, 300), notice: n.slice(0, 300), running: st.running,
          done: /^Undo: \\d+ removed/.test(status) || /^Undo: \\d+ removed/.test(n) || /^Undo failed/.test(n),
          remaining: lb && Array.isArray(lb.servingIds) ? lb.servingIds.length : 0};
})()"""
JS_SCROLL_GROUP = """(() => {
  const want = %s.toLowerCase();
  const titles = Array.from(document.querySelectorAll('.diary-group-title'));
  const t = titles.find(e => e.textContent.trim().toLowerCase() === want) || titles[0];
  if (!t) return {found: false};
  t.scrollIntoView({block: 'center', inline: 'nearest'});
  return {found: true, title: t.textContent.trim(), top: Math.round(t.getBoundingClientRect().top)};
})()"""
# '.diary-panel' is an authored class of the compiled client (tools/bundle/all.js: the constant QDp='diary-panel'
# and the template "<div class='diary-panel'>"); the entries are the table rows inside it. tests/mock-cronometer.js
# builds the same div.diary-panel > table > tr structure.
JS_DIARY_HAS = """(() => {
  const names = %s.map(n => String(n).toLowerCase());
  const rows = Array.from(document.querySelectorAll('.diary-panel tr'));
  const texts = rows.map(r => (r.textContent || '').toLowerCase());
  const seen = names.filter(n => texts.some(t => t.includes(n)));
  return {visible: seen.length, total: names.length};
})()"""
JS_MOCK_STATE = "(() => ({mock: !!(window.CMA && CMA.mock), handle: !!(window.mock && typeof mock.useDays === 'function'), added: Array.isArray(window.__added) ? window.__added.length : -1, ready: document.readyState}))()"
JS_MOCK_ADDED = "(() => (window.__added || []).map(a => ({text: a.name + ' ' + a.quantity + ' ' + a.measure + ' -> ' + a.group, date: a.date || null})))()"
JS_TDEE_STATE = """(() => {
  const r = CMA.panel.root, st = CMA.panel.getState();
  const q = (s) => r.querySelector(s);
  const t = (e) => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
  const ci = q('.cma-tdee-checkin');
  return {view: st.view, open: st.open, rendered: !!q('.cma-tdee'), loading: !!q('.cma-tdee-loading'), consent: !!q('.cma-tdee-consent'),
          waiting: !!q('.cma-tdee-waiting'), chip: t(q('.cma-tdee-exp .cma-tdee-chip')), big: t(q('.cma-tdee-exp .cma-tdee-big')),
          cmp: t(q('.cma-tdee-exp .cma-tdee-cmp')), target: t(q('.cma-tdee-week .cma-tdee-target')), macros: t(q('.cma-tdee-week .cma-tdee-macros')),
          expect: t(q('.cma-tdee-week .cma-tdee-expect')), next: t(q('.cma-tdee-week .cma-tdee-next')),
          charts: r.querySelectorAll('svg.cma-tdee-svg').length, band: r.querySelectorAll('path.cma-tdee-l-band').length,
          checkin: !!ci, checkinDisabled: !ci || ci.disabled, nudges: r.querySelectorAll('.cma-tdee-nudge').length,
          dialog: !!q('.cma-tdee-dialog'), change: t(q('.cma-tdee-dialog .cma-tdee-change')), why: r.querySelectorAll('.cma-tdee-dialog .cma-tdee-why li').length,
          accept: !!q('.cma-tdee-dialog .cma-tdee-accept'), msg: t(q('.cma-tdee-msg')),
          synthetic: !!(CMA.tdeeData && CMA.tdeeData.synthetic === true)};
})()"""
# The overview is taller than the panel (max-height 100vh - 80px), so the panel body's bottom edge cuts it somewhere.
# When that edge runs through a line of text (a chart heading, a legend, a readout), scroll the body down just far
# enough to show the whole line and 24 px of what follows, and then far enough that no sliver of the sub-view buttons
# (Overview / History / Settings) is left at the top - never so far that the cards' top leaves the view, and back to
# where it was if a line would still be cut. Nothing moves when no text is cut (the layout differs by a line or two
# between the mock and the live page: the dry run's sync box carries the "session is not captured" line).
JS_TDEE_TIDY = """(() => {
  const r = CMA.panel.root;
  const body = r.querySelector('.cma-body'), grid = r.querySelector('.cma-tdee-grid2'), nav = r.querySelector('.cma-tdee-subnav');
  if (!body || !grid) return {scrolled: 0, why: 'no panel body or cards'};
  const TEXT = '.cma-tdee-charts-h, .cma-tdee-chart-h, .cma-tdee-legend, .cma-tdee-readout, .cma-tdee-card-h, .cma-tdee-note';
  const cut = () => {
    const bb = body.getBoundingClientRect();
    let need = 0;
    for (const e of r.querySelectorAll(TEXT)) {
      const b = e.getBoundingClientRect();
      if (b.height > 0 && b.top < bb.bottom - 1 && b.bottom > bb.bottom + 1) need = Math.max(need, Math.ceil(b.bottom - bb.bottom) + 24);
    }
    return need;
  };
  const need = cut();
  if (!need) return {scrolled: 0};
  const bb = body.getBoundingClientRect();
  const room = Math.floor(grid.getBoundingClientRect().top - bb.top - 4);
  const hideNav = nav ? Math.ceil(nav.getBoundingClientRect().bottom - bb.top + 2) : 0;
  const by = Math.max(need, Math.min(hideNav, room));
  if (by > room) return {scrolled: 0, why: 'a line of text is cut, but showing it would hide the top of the cards (' + by + ' > ' + room + ' px)'};
  const before = body.scrollTop;
  body.scrollTop = before + by;
  if (cut()) { body.scrollTop = before; return {scrolled: 0, why: 'no scroll position leaves every line of text whole'}; }
  return {scrolled: body.scrollTop - before};
})()"""


def js_setup(engine, delay_ms, dry):
    """Mount, load the stored settings first (mount() reads them asynchronously: saving before that read
    settles would be overwritten by it), acknowledge the first-run notice when it is pending (a new profile: the
    panel shows it instead of the Input view until its Continue button, class cma-consent-accept, is pressed; the
    real button is clicked, the "remember my last typed list" box is left as it is), save ours, open the Input
    view. Returns {view, notice: 'accepted' | 'none', why?}.
    The dry run has no chrome.storage in its isolated world, and without storage the panel shows no notice; so
    for this step only it installs a temporary in-memory chrome.storage.local (like a new profile) and puts the
    previous window.chrome back afterwards, which makes the dry run cover the notice path the live run takes."""
    return """(async () => {
  const P = CMA.panel;
  const dry = %s;
  let shimmed = false, prevChrome;
  if (dry && !(window.chrome && window.chrome.storage && window.chrome.storage.local)) {
    const store = {};
    prevChrome = window.chrome;
    window.chrome = { storage: { local: {
      get(keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = store[k]; }); cb(out); },
      set(obj, cb) { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); }
    } } };
    shimmed = true;
  }
  let notice = 'none';
  try {
    P.mount();
    await P.loadSettings();
    if (typeof P.noticeAcknowledged === 'function' && P.noticeAcknowledged() === false) {
      P.open('input');
      const b = P.root.querySelector('.cma-footer .cma-consent-accept');
      if (!b) return {view: P.getState().view, notice: 'pending', why: 'the first-run notice has no Continue button (.cma-consent-accept)'};
      b.click();
      for (let i = 0; i < 100 && !P.root.querySelector('textarea.cma-input'); i++) await new Promise(r => setTimeout(r, 50));
      if (!P.root.querySelector('textarea.cma-input')) return {view: P.getState().view, notice: 'pending', why: 'Continue did not open the Input view'};
      notice = 'accepted';
    }
    await P.saveSettings({engine: %s, delayMs: %d});
  } finally {
    if (shimmed) window.chrome = prevChrome;
  }
  P.open('input');
  return {view: P.getState().view, notice};
})()""" % ('true' if dry else 'false', js(engine), int(delay_ms))


def js_type(text, group):
    """Type into the real textarea (input event => state.input, Find foods enabled) and pick the default group."""
    return """(() => {
  const root = CMA.panel.root;
  const ta = root.querySelector('textarea.cma-input');
  if (!ta) return {ok: false, why: 'no textarea in the Input view'};
  ta.value = %s;
  ta.dispatchEvent(new Event('input', {bubbles: true}));
  const sel = root.querySelector('select.cma-group');
  let group = null;
  if (sel) {
    const want = %s.toLowerCase();
    const opt = Array.from(sel.options).find(o => o.textContent.trim().toLowerCase() === want);
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles: true})); group = opt.textContent.trim(); }
  }
  return {ok: true, group, options: sel ? Array.from(sel.options).map(o => o.textContent.trim()) : []};
})()""" % (js(text), js(group))


def js_click(prefix):
    """Click the footer button whose text starts with prefix (the panel's real handlers run)."""
    return """(() => {
  const b = Array.from(CMA.panel.root.querySelectorAll('.cma-footer button')).find(x => x.textContent.trim().startsWith(%s));
  if (!b) return {clicked: false, why: 'no button'};
  if (b.disabled) return {clicked: false, why: 'disabled', title: b.title || ''};
  b.click();
  return {clicked: true, text: b.textContent.trim()};
})()""" % js(prefix)


def js_click_panel(selector):
    """Click the first element of the panel's shadow tree that matches selector (the view's real handler runs)."""
    return """(() => {
  const b = CMA.panel.root.querySelector(%s);
  if (!b) return {clicked: false, why: 'not found'};
  if (b.disabled) return {clicked: false, why: 'disabled', title: b.title || ''};
  b.click();
  return {clicked: true, text: b.textContent.trim()};
})()""" % js(selector)


def js_nav_click(selector):
    """Press one of the diary's date arrows the way the RPC engine's refresh does (engine-rpc.js clickEl: mousedown,
    mouseup, click on the first VISIBLE match inside .diary-panel, else the first visible match anywhere)."""
    return """(() => {
  const sel = %s;
  const vis = (e) => !!e && e.isConnected && e.getClientRects().length > 0;
  const el = Array.from(document.querySelectorAll('.diary-panel ' + sel)).find(vis) || Array.from(document.querySelectorAll(sel)).find(vis);
  if (!el) return {clicked: false, found: document.querySelectorAll(sel).length};
  for (const type of ['mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0}));
  el.click();
  return {clicked: true};
})()""" % js(selector)


def js_day_servings(day):
    """Live only: the extension's own getDayInfo read of `day` (the same read-only request the app sends when it shows a
    day, and the one plan.js sends before adding), reduced to counts: the Servings (CMA.rpc.servingsOf) and the
    elements of the DayInfo's two entry lists. The session never leaves the page; a failure message is redacted."""
    return """(async () => {
  const s = (CMA.capture && CMA.capture.state) || {};
  const redact = (m) => { let t = String(m == null ? '' : m); if (typeof s.nonce === 'string' && s.nonce.length > 3) t = t.split(s.nonce).join('<nonce>'); return t.slice(0, 200); };
  try {
    const p = %s.split('-').map(Number);
    const session = {moduleBase: s.moduleBase, permutation: s.permutation, policyHash: s.policyHash, nonce: s.nonce, userId: s.userId};
    const di = await CMA.rpc.getDayInfo(session, {year: p[0], month: p[1], day: p[2]});
    const f = di && Array.isArray(di.f) ? di.f : [];
    const len = (x) => (Array.isArray(x) ? x.length : 0);
    return {ok: true, servings: CMA.rpc.servingsOf(di).length, listed: len(f[2]) + len(f[3])};
  } catch (e) { return {ok: false, why: redact(e && e.message ? e.message : e)}; }
})()""" % js(day)


def js_sim_capture_day(day):
    """Dry run only: what the capture does when the hook relays the app's getDayInfo (capture.js handleRpc sets
    diaryDate from the Day parameter). The mock has no hook, so the tool writes the mock's day in by hand."""
    return """(() => {
  const s = CMA.capture && CMA.capture.state;
  if (!s) return false;
  const p = %s.split('-').map(Number);
  s.diaryDate = {day: p[2], month: p[1], year: p[0]};
  s.diaryDateSource = 'dry-run (the mock diary)';
  s.lastGetDayInfo = {date: s.diaryDate, t: Date.now(), status: 200};
  return true;
})()""" % js(day)


def js_blur_pre(needles):
    """Wrap every occurrence of a needle inside the Diagnostics <pre> in a blurred span (the pre is rebuilt from
    text nodes and spans, never from HTML)."""
    return """(() => {
  const pre = CMA.panel.root.querySelector('pre.cma-pre');
  if (!pre) return {ok: false, why: 'no diagnostics pre'};
  const needles = %s.filter(s => s && String(s).length);
  if (!needles.length) return {ok: true, blurred: 0};
  const re = new RegExp(needles.map(s => String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|'), 'g');
  const text = pre.textContent;
  const frag = document.createDocumentFragment();
  let i = 0, n = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) frag.appendChild(document.createTextNode(text.slice(i, m.index)));
    const span = document.createElement('span');
    span.textContent = m[0];
    span.style.filter = 'blur(6px)';
    span.setAttribute(%s, '1');
    frag.appendChild(span);
    i = m.index + m[0].length;
    n++;
  }
  frag.appendChild(document.createTextNode(text.slice(i)));
  pre.textContent = '';
  pre.appendChild(frag);
  return {ok: true, blurred: n};
})()""" % (js([str(x) for x in needles]), js(BLUR_ATTR))


def js_account_texts():
    """The account's first name and e-mail from the app's own User object, for the text blur. Evidence
    (tools/bundle/all.js): the Account settings page shows `this.q.n` as the e-mail with the '[set email]'
    placeholder (`Yhg`: `this.q=(_c(),$c)` ... `xKh(this.d,this.q.n)`) and edits `a.q.p` through the
    'Change First Name' dialog (`Nhg`); `$c` is the User global of the GWT iframe (SPEC 2.1: the app's globals
    live on <iframe id="cronometer">'s window, e.g. contentWindow.$strongName). Property letters change per
    build, so every own string property shaped like an e-mail is taken as well. The session key ($c.Q) is a hex
    token without '@' and is never matched, and nothing here is printed: the values only feed the blur."""
    return """(() => {
  try {
    const f = document.getElementById('cronometer');
    const w = f && f.contentWindow;
    const u = w && w.$c;
    if (!u || typeof u !== 'object') return {ok: false, why: 'no User object'};
    const out = [];
    const isEmail = s => typeof s === 'string' && /^[^\\s@]{1,64}@[^\\s@]+\\.[^\\s@]+$/.test(s.trim());
    const first = typeof u.p === 'string' ? u.p.trim() : '';
    if (first.length >= 2 && first.length <= 40 && /^[\\p{L}][\\p{L} .'-]*$/u.test(first)) out.push(first);
    const firstFound = out.length > 0;
    for (const k of Object.keys(u)) { const v = u[k]; if (isEmail(v) && !out.includes(v.trim())) out.push(v.trim()); }
    return {ok: true, texts: out, firstFound};
  } catch (e) { return {ok: false, why: String(e && e.message)}; }
})()"""


def js_blur(selectors, texts):
    """MAIN-world blur: a <style> with the selectors, plus [data-cma-blur] on the deepest elements whose text
    carries one of the texts (word-bounded for names, plain containment for e-mails) and on inputs holding them.
    The extension's host element and its shadow tree are skipped; diary rows are never marked."""
    return """(() => {
  const SEL = %s, TEXTS = %s, ATTR = %s;
  let style = document.getElementById(%s);
  if (!style) { style = document.createElement('style'); style.id = %s; (document.head || document.documentElement).appendChild(style); }
  const rules = ['[' + ATTR + ']{filter:blur(9px)!important}'];
  if (SEL.length) rules.push(SEL.join(',') + '{filter:blur(9px)!important}');
  style.textContent = rules.join('\\n');
  const matched = {};
  for (const s of SEL) { try { matched[s] = document.querySelectorAll(s).length; } catch (e) { matched[s] = -1; } }
  document.querySelectorAll('[' + ATTR + ']').forEach(e => { if (!e.closest('pre')) e.removeAttribute(ATTR); });
  const esc = s => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  const tests = TEXTS.map(t => String(t).trim()).filter(t => t.length >= 2).map(t => t.includes('@')
    ? {re: new RegExp(esc(t), 'i')} : {re: new RegExp('(^|[^\\\\p{L}\\\\p{N}])' + esc(t) + '($|[^\\\\p{L}\\\\p{N}])', 'iu')});
  let hits = 0;
  if (tests.length) {
    const host = document.getElementById(%s);
    const has = s => tests.some(t => t.re.test(s));
    for (const el of document.body.querySelectorAll('*')) {
      if (host && (el === host || host.contains(el))) continue;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'IFRAME') continue;
      if (el.closest('.diary-panel tr')) continue;
      if (!has(el.textContent || '')) continue;
      let deeper = false;
      for (const c of el.children) { if (has(c.textContent || '')) { deeper = true; break; } }
      if (deeper) continue;
      el.setAttribute(ATTR, '1'); hits++;
    }
    // password fields are never read or marked, whatever they hold (nor fields the page flags as passwords)
    for (const inp of document.querySelectorAll('input:not([type=password]), textarea')) {
      if (host && host.contains(inp)) continue;
      const ac = String(inp.getAttribute('autocomplete') || '').toLowerCase();
      if (/(^|\\s)(current|new)-password($|\\s)/.test(ac)) continue;
      if (has(inp.value || '')) { inp.setAttribute(ATTR, '1'); hits++; }
    }
  }
  return {matched, textHits: hits};
})()""" % (js(selectors), js(texts), js(BLUR_ATTR), js(BLUR_STYLE_ID), js(BLUR_STYLE_ID), js(HOST_ID))


# The synthetic TDEE demo (shots 04-05). Evaluated in the extension's isolated world. It builds an in-memory stub of
# the CMA.tdeeData contract (SPEC 12.3) around a synthetic person, parks the real data layer in CMA.__cmaShotDemo
# (its enable() / sync() replaced by refusing, counting guards) and resets the TDEE view so its next render reads the
# stub. No storage, no network: every stub method answers from memory. The person is generated with the engine's
# own calendar arithmetic (CMA.tdee.addDays), like tests/tdee-sim.js makePerson: a true expenditure of 2,700 kcal
# falling with weight (24 kcal/kg) and a slow adaptation on the cut; scale weight = tissue + glycogen (the cut's
# drop) + AR(1) water + salty-meal spikes + scale noise; food logged on ~85 % of days (always yesterday); weigh-ins
# on ~75 % plus three in the last week (no weigh-in nudge); Cronometer's burned = 1.09 x the true expenditure with
# exercise-day swings (~8 % high overall). Maintenance to day 21, then a -0.5 %/week goal; every 7th day (the
# check-in weekday = today's) the engine itself runs on the records so far and its weeklyCheckIn is recorded as
# accepted, and the person then eats that target +/- 190 kcal. Today's check-in is left open (due), so the dialog
# shows last week's target -> this week's.
JS_TDEE_DEMO_INSTALL = r"""(() => {
  const C = window.CMA;
  const T = C && C.tdee;
  if (!T || typeof T.runExpenditureModel !== 'function' || typeof T.weeklyCheckIn !== 'function' || typeof T.addDays !== 'function') return {ok: false, why: 'the TDEE engine (CMA.tdee) is not loaded'};
  if (!C.panel || !C.tdeeView || !C.tdeeView.test || typeof C.tdeeView.test.reset !== 'function') return {ok: false, why: 'the TDEE tab (CMA.tdeeView) is not registered'};
  if (C.__cmaShotDemo) return {ok: false, why: 'a synthetic TDEE demo is already installed'};
  const O = __OPTIONS__;
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const now = new Date();
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const localMs = (iso, h, m) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h, m).getTime();
  let seed = O.seed;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const N = O.days, W0 = O.startKg, E0 = O.trueTdee, CUT = O.cutDay, RATE = O.rate;
  const MODEL_OPTS = {config: {expenditureDriftKcal: 15}};                  // 'balanced', the default responsiveness
  const CHECKIN_SETTINGS = {proteinGPerKg: 1.8, fatShareOfRemaining: 0.35}; // the view's defaults
  const start = T.addDays(today, -(N - 1));
  const phi = Math.exp(-1 / 3);
  const forcedWeighIns = new Set([N - 1, N - 3, N - 5]);
  const days = [], checkins = [];
  let W = W0, water = 0, spike = 0, gly = 0, adapt = 0, target = null, lastGoal = null;
  const upTo = (t) => days.slice(0, t + 1).map((d, i) => ({date: d.date, intakeKcal: i === t ? null : d.intakeKcal, weightKg: d.weightKg, burnedKcal: i === t ? null : d.burnedKcal}));
  for (let t = 0; t < N; t++) {
    const date = T.addDays(start, t);
    const isToday = t === N - 1;
    const cut = t >= CUT;
    adapt += ((cut ? -90 : 0) - adapt) / 30;
    const trueTdee = E0 + 24 * (W - W0) + adapt;
    gly += ((cut ? -0.55 : 0) - gly) / 2.5;
    water = phi * water + 0.0045 * W * Math.sqrt(1 - phi * phi) * gauss();
    if (rnd() < 0.035) spike += 0.4 + 0.4 * rnd();
    spike *= 0.5;
    const scale = W + gly + water + spike + 0.0022 * W * gauss();
    const weighed = forcedWeighIns.has(t) || rnd() >= 0.25;
    days.push({date, intakeKcal: null, weightKg: weighed ? Math.round(scale * 10) / 10 : null, burnedKcal: null, burnedParts: null});
    const goal = cut ? RATE : 0;
    if (t >= 7 && (N - 1 - t) % 7 === 0 && !isToday) {
      const m = T.runExpenditureModel(upTo(t), MODEL_OPTS);
      if (m && m.current) {
        const changed = lastGoal !== null && lastGoal !== goal;
        const res = T.weeklyCheckIn({model: m.current, goal: {ratePctPerWeek: goal}, sex: 'other', previousTargetKcal: target, goalChanged: changed, settings: CHECKIN_SETTINGS});
        checkins.push({date, accepted: true, targetKcal: res.targetKcal, expenditureKcal: m.current.expenditureKcal, sdKcal: m.current.expenditureSdKcal,
          trendWeightKg: m.current.trendWeightKg, ratePctPerWeek: res.ratePctPerWeek, macros: res.macros, notes: res.notes, at: localMs(date, 8, 30),
          previousTargetKcal: target, goalChanged: changed, goalRatePctPerWeek: goal});
        target = res.targetKcal; lastGoal = goal;
      }
    }
    const intake = Math.round((target != null ? target : E0) + 190 * gauss());
    const logged = !isToday && (t === N - 2 || rnd() >= 0.15);
    const ex = rnd() < 3 / 7;
    const exercise = ex ? Math.round(210 + 170 * rnd()) : 0;
    const bmr = Math.round(1845 + 11 * (W - W0));
    const tef = logged ? Math.round(0.1 * intake) : 0;
    const burned = Math.round(trueTdee * O.cronoFactor + (ex ? 150 : -80) + 30 * gauss());
    const d = days[t];
    d.intakeKcal = logged ? intake : null;
    d.burnedKcal = isToday ? Math.round(bmr * 0.55) + 180 : burned;
    d.burnedParts = isToday ? {bmr: Math.round(bmr * 0.55), activity: 180, exercise: 0, tef: 0} : {bmr, activity: burned - bmr - exercise - tef, exercise, tef};
    W += (intake - trueTdee) / 7700;
  }
  const t0 = Date.now();
  const status = {enabled: true, syncing: false, phase: 'done', progress: {done: 0, total: 0}, lastFullAt: t0 - 26 * 3600000, lastDeltaAt: t0 - 3 * 60000,
    firstDay: start, lastError: null, notes: null, flagsSource: 'calendar', energyChunk: 92,
    prefs: {tef: true, unitsCalories: true, weightUnit: 'Kilograms', at: t0 - 26 * 3600000, assumed: false}, ready: true, blockedReason: null, blockedCode: null};
  const settings = {goal: {ratePctPerWeek: RATE}, sex: 'other', checkInWeekday: new Date(localMs(today, 12, 0)).getDay(), responsiveness: 'balanced',
    manualInitialKcal: null, proteinGPerKg: 1.8, fatShare: 0.35, activityAware: false, units: {weight: 'auto', energy: 'auto'}, modelStartDate: null,
    trustCompleteOnly: false, goalChangedAt: localMs(T.addDays(start, CUT), 7, 45), nudges: {}};
  const dayView = (d) => ({date: d.date, intakeKcal: d.intakeKcal, weightKg: d.weightKg, burnedKcal: d.burnedKcal, burnedParts: clone(d.burnedParts),
    complete: false, loggedFood: d.intakeKcal != null, excluded: false, excludedReason: null, partialSuspect: false, override: null, source: 'rpc'});
  let weighIn = null;
  for (let i = days.length - 1; i >= 0 && !weighIn; i--) if (days[i].weightKg != null) weighIn = {date: days[i].date, kg: days[i].weightKg};
  const y = days[N - 2];
  const probe = {date: y.date, consumed: y.intakeKcal, burned: y.burnedKcal, parts: clone(y.burnedParts), row: null, tefIncluded: true, weighIn};
  const counts = () => ({days: days.length, weighIns: days.filter(d => d.weightKg != null).length, intakeDays: days.filter(d => d.intakeKcal != null).length,
    burnedDays: days.filter(d => d.burnedKcal != null).length});
  const stub = {
    synthetic: true,
    init: () => Promise.resolve(stub.status()),
    status: () => Object.assign(clone(status), {counts: counts(), range: {from: start, to: today}}),
    enable: () => { status.enabled = true; return Promise.resolve(stub.status()); },
    disable: () => { status.enabled = false; return Promise.resolve(stub.status()); },
    sync: () => Promise.resolve(stub.status()),
    dayList: () => days.map(dayView),
    records: (o) => { const from = o && o.modelStartDate; return days.filter(d => !from || d.date >= from).map(d => ({date: d.date,
      intakeKcal: d.date === today ? null : d.intakeKcal, weightKg: d.weightKg, burnedKcal: d.date === today ? null : d.burnedKcal, excluded: false})); },
    setOverride: () => Promise.resolve(stub.status()),
    getSettings: () => clone(settings),
    saveSettings: (p) => { Object.assign(settings, clone(p || {})); return Promise.resolve(clone(settings)); },
    checkins: () => clone(checkins),
    recordCheckin: (c) => { checkins.push(clone(c)); return Promise.resolve(clone(c)); },
    importCsv: () => Promise.reject(new Error('not available in the screenshot demo')),
    probe: () => clone(probe),
    today: () => today,
    diagnostics: () => ({synthetic: true, days: days.length})
  };
  const real = C.tdeeData;
  const demo = {real, hadReal: Object.prototype.hasOwnProperty.call(C, 'tdeeData'), stub, calls: {enable: 0, sync: 0}, orig: null, guarded: false};
  if (real && typeof real === 'object') {
    demo.orig = {enable: real.enable, sync: real.sync};
    const refuse = (name) => function () { demo.calls[name]++; return Promise.reject(new Error('refused: the screenshot tool is showing a synthetic TDEE demo')); };
    try { real.enable = refuse('enable'); real.sync = refuse('sync'); demo.guarded = real.enable !== demo.orig.enable && real.sync !== demo.orig.sync; } catch (e) { demo.guarded = false; }
  }
  C.__cmaShotDemo = demo;
  C.tdeeData = stub;
  C.tdeeView.test.reinit();
  C.tdeeView.test.reset();
  const m = T.runExpenditureModel(stub.records({}), MODEL_OPTS);
  const last = checkins[checkins.length - 1];
  const next = m.current ? T.weeklyCheckIn({model: m.current, goal: {ratePctPerWeek: RATE}, sex: 'other', previousTargetKcal: last ? last.targetKcal : null, goalChanged: false, settings: CHECKIN_SETTINGS}) : null;
  const c = counts();
  return {ok: C.tdeeData === stub, guarded: demo.guarded, today, from: start, days: c.days, weighIns: c.weighIns, intakeDays: c.intakeDays, checkins: checkins.length,
    expenditure: m.current ? m.current.expenditureKcal : null, sd: m.current ? m.current.expenditureSdKcal : null, status: m.current ? m.current.status : null,
    calibrated: m.current ? !!m.current.calibrated : null, trend: m.current ? m.current.trendWeightKg : null, week: m.current ? m.current.weeklyTrendChangeKg : null,
    ratio: m.current ? m.current.cronometerCalibrationRatio : null, target: last ? last.targetKcal : null, newTarget: next ? next.targetKcal : null};
})()"""
# Put the real data layer back (idempotent). The TDEE view is closed first (it reads CMA.tdeeData on every render, so
# it must not render again before the swap), the guards are removed, the view state is reset (its next render starts
# with the real layer's init()). Nothing of the real layer is called.
JS_TDEE_DEMO_RESTORE = """(() => {
  const C = window.CMA, demo = C && C.__cmaShotDemo;
  if (!demo) return {ok: true, restored: false};
  let closed = false;
  try { const st = C.panel.getState(); if (st.open && st.view === 'tdee') { C.panel.close(); closed = true; } } catch (e) { /* the swap below still runs */ }
  const real = demo.real;
  if (demo.orig && real) { try { real.enable = demo.orig.enable; real.sync = demo.orig.sync; } catch (e) { /* reported by ok below */ } }
  if (demo.hadReal) C.tdeeData = real; else delete C.tdeeData;
  try { C.tdeeView.test.reset(); C.tdeeView.test.reinit(); } catch (e) { /* the view re-initialises on its next render anyway */ }
  delete C.__cmaShotDemo;
  const back = C.tdeeData === real && (!demo.orig || (real.enable === demo.orig.enable && real.sync === demo.orig.sync));
  return {ok: back, restored: true, closedPanel: closed, calls: demo.calls, stillSynthetic: !!(C.tdeeData && C.tdeeData.synthetic === true)};
})()"""


def js_tdee_demo_install():
    return JS_TDEE_DEMO_INSTALL.replace('__OPTIONS__', js(TDEE_DEMO))


# ---------------------------------------------------------------------------------------------------- PNG check
PNG_SIG = b'\x89PNG\r\n\x1a\n'


def png_verify(path):
    """(ok, detail): the file is a PNG of WIDTHxHEIGHT and its decoded pixels are not blank. The IDAT stream is
    inflated with zlib and every scanline un-filtered (None/Sub/Up/Average/Paeth); every 2nd pixel of every 2nd
    row is sampled and the image passes when >= 64 distinct colours occur and no colour covers > 99.5 percent.
    A capture that did not render is one colour (white), one with only a scrollbar has a couple of dozen; any
    rendered text brings hundreds of anti-aliasing shades (the sparse mock diary of the dry run: ~160 at a 1/16
    sample, the real diary far more), so the bar separates the two without demanding a busy page."""
    data = open(path, 'rb').read()
    if data[:8] != PNG_SIG:
        return False, 'not a PNG'
    pos, ihdr, idat = 8, None, []
    while pos + 8 <= len(data):
        ln, ctype = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if ctype == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif ctype == b'IDAT':
            idat.append(body)
        elif ctype == b'IEND':
            break
    if not ihdr:
        return False, 'no IHDR'
    w, h, depth, color, _comp, _filt, interlace = ihdr
    if (w, h) != (WIDTH, HEIGHT):
        return False, 'size %dx%d, expected %dx%d' % (w, h, WIDTH, HEIGHT)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if depth != 8 or interlace != 0 or not channels:
        return False, 'size ok but unsupported PNG layout for the blank check (depth %d, colour type %d, interlace %d)' % (depth, color, interlace)
    if color in (4, 6):
        # our own bar, not a store rule (the store asks for square corners, full bleed): 24-bit RGB, as Chrome writes
        return False, 'has an alpha channel (colour type %d): the set is 24-bit RGB' % color
    try:
        raw = zlib.decompress(b''.join(idat))
    except zlib.error as e:
        return False, 'IDAT does not inflate: %s' % e
    bpp, stride = channels, w * channels
    if len(raw) < h * (stride + 1):
        return False, 'IDAT too short (%d bytes for %d rows)' % (len(raw), h)
    prev = bytearray(stride)
    counts = collections.Counter()
    for y in range(h):
        off = y * (stride + 1)
        f = raw[off]
        line = bytearray(raw[off + 1:off + 1 + stride])
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            return False, 'row %d uses unknown filter %d' % (y, f)
        if y % 2 == 0:
            for x in range(0, stride, bpp * 2):
                counts[bytes(line[x:x + bpp])] += 1
        prev = line
    total = sum(counts.values())
    top = counts.most_common(1)[0][1] if counts else 0
    distinct = len(counts)
    share = top / float(total) if total else 1.0
    detail = '%dx%d %s, %d distinct colours in %d samples, dominant colour %.1f%%' % (w, h, {0: 'grey', 2: 'RGB', 3: 'palette'}.get(color, '?'), distinct, total, share * 100)
    if distinct < 64 or share > 0.995:
        return False, 'looks blank: ' + detail
    return True, detail


# ---------------------------------------------------------------------------------------------------- the tool
class Shooter:
    def __init__(self, opts):
        self.o = opts
        self.dry = opts.dry_run
        self.extra = bool(opts.extra or opts.dry_run)
        self.cdp = None
        self.sid = None
        self.tid = None
        self.ext_id = None
        self.ext_name = None
        self.main_frame = None
        self.contexts = {}                 # execution contexts of our session, id -> description (reader thread)
        self._ctx_lock = threading.Lock()  # guards self.contexts / self._ext_ctx against the CDP reader thread
        self._ext_ctx = None
        self.profile = None                # set before Chrome starts, so shutdown() can delete it even then
        self.temp_profile = False
        self.chrome_product = None
        self.blur_texts = list(opts.blur_text or [])
        self.selectors = [] if opts.no_blur else DEFAULT_BLUR_SELECTORS + [s.strip() for s in (opts.blur_selectors or '').split(',') if s.strip()]
        self.user_id = None
        self.shots = []                    # manifest entries
        self.added_names = []
        self.added_count = 0
        self.undone = None                 # None = nothing to undo; 'pending' = armed at Add all (RPC engine);
                                           # 'attempted' = undo started, outcome unknown; any other text = outcome
        self.undo_complete = None          # True when the outcome is 'Undo: <added> removed, 0 failed'
        # the diary days: the one it opened on, the empty one the shots are taken on, the one it shows now
        self.start_day = None
        self.shot_day = None
        self.cur_day = None
        self.rows_allowed = 0              # entry rows a capture may show on the empty day: 0, then the rows added
        self.entries_seen = False          # True once every added entry was seen in the diary (then exactly that many)
        self.armed_at = None               # page clock (ms) just before Add all was pressed; a batch of this run is newer
        self.skipped_days = []             # [(day, why)] days the empty-day search passed over
        self.back_on_start = None          # True / False after the move back to the start day (None: not tried)
        self.guard_refused = None          # dry run: True once the capture guard refused a day with a row too many
        self.demo_info = None              # JS_TDEE_DEMO_INSTALL result
        self.demo_restore = None           # JS_TDEE_DEMO_RESTORE result (None: nothing was installed)
        self.problems = []
        with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as fh:
            self.manifest = json.load(fh)
        self.ext_name = self.manifest.get('name')
        self.out_dir = os.path.join(opts.out, 'dry-run') if self.dry else opts.out

    def expected_shots(self):
        return STORE_SHOTS + (EXTRA_SHOTS if self.extra else [])

    # ------------------------------------------------------------------ chrome
    def launch(self):
        chrome = find_chrome(self.o.chrome)
        if not chrome:
            raise EnvError('Chrome not found; pass --chrome PATH or set CHROME')
        os.makedirs(self.out_dir, exist_ok=True)
        if self.dry:
            self.clean_dry_output()
        if self.o.profile:
            self.profile = os.path.abspath(self.o.profile)
            self.temp_profile = False
            os.makedirs(self.profile, exist_ok=True)
        else:
            self.profile = tempfile.mkdtemp(prefix='cma-shots-')
            self.temp_profile = True
        self.stderr_path = os.path.join(self.profile, 'chrome-stderr.txt')
        headless = bool(self.o.headless)
        extra = [] if headless else ['--hide-crash-restore-bubble', '--disable-session-crashed-bubble']
        try:
            self.cdp = Cdp(chrome, self.profile, self.stderr_path, headless=headless, window_size=(WIDTH, HEIGHT), extra_args=extra)
        except OSError as e:
            raise EnvError('could not start Chrome (%s): %s' % (chrome, e))
        v = self.cdp.call('Browser.getVersion', timeout=30)
        if 'error' in v:
            raise EnvError('DevTools pipe unavailable (%s)' % v['error'].get('message'))
        self.chrome_product = v['result'].get('product')
        log('Chrome %s (%s), profile %s%s' % (self.chrome_product, 'headless' if headless else 'visible window',
                                              self.profile, '' if self.temp_profile else ' (kept)'))
        r = self.cdp.call('Extensions.loadUnpacked', {'path': ROOT}, timeout=60)
        if 'error' in r:
            raise EnvError('Extensions.loadUnpacked failed: %s' % r['error'].get('message'))
        self.ext_id = r['result']['id']
        log('extension installed: %s %s as %s' % (self.ext_name, self.manifest.get('version'), self.ext_id))
        # the first tab (about:blank) becomes the diary tab; a flat session carries every command from here on
        targets = self.cdp.call('Target.getTargets').get('result', {}).get('targetInfos', [])
        pages = [t for t in targets if t.get('type') == 'page']
        if pages:
            self.tid = pages[0]['targetId']
        else:
            self.tid = self.cdp.call('Target.createTarget', {'url': 'about:blank'})['result']['targetId']
        a = self.cdp.call('Target.attachToTarget', {'targetId': self.tid, 'flatten': True})
        if 'error' in a:
            raise EnvError('Target.attachToTarget failed: %s' % a['error'].get('message'))
        self.sid = a['result']['sessionId']
        self.cdp.on('*', self._on_event)
        self.cdp.call('Page.enable', session_id=self.sid)
        self.cdp.call('Runtime.enable', session_id=self.sid)
        self.fit_window()
        e = self.cdp.call('Emulation.setDeviceMetricsOverride', {'width': WIDTH, 'height': HEIGHT, 'deviceScaleFactor': 1, 'mobile': False}, session_id=self.sid)
        if 'error' in e:
            raise EnvError('Emulation.setDeviceMetricsOverride failed: %s' % e['error'].get('message'))
        log('viewport pinned to %dx%d (dpr 1)' % (WIDTH, HEIGHT))

    def clean_dry_output(self):
        """The dry-run folder holds only this tool's mock pictures: remove the files of an earlier dry run (the shot
        names, old and new, and manifest.json) so it never mixes two runs. Nothing else is touched."""
        removed = []
        for n in [n for n, _s in STORE_SHOTS + EXTRA_SHOTS] + list(LEGACY_SHOTS) + ['manifest.json']:
            p = os.path.join(self.out_dir, n)
            if os.path.isfile(p):
                try:
                    os.remove(p)
                    removed.append(n)
                except OSError as e:
                    log('could not remove %s of an earlier dry run: %s' % (n, e))
        if removed:
            log('dry run: removed %d file(s) of an earlier dry run from %s' % (len(removed), self.out_dir))

    def fit_window(self):
        """Size the visible window so its native viewport is WIDTHxHEIGHT (the emulation override guarantees the
        capture size anyway; this only makes the human's view agree with it). Best effort."""
        if self.o.headless:
            return
        try:
            inner = self.eval_main('[innerWidth, innerHeight]', soft=True)
            w = self.cdp.call('Browser.getWindowForTarget', {'targetId': self.tid})
            if not inner or 'error' in w:
                return
            b = w['result']['bounds']
            dx, dy = b.get('width', WIDTH) - inner[0], b.get('height', HEIGHT) - inner[1]
            if 0 <= dx <= 200 and 0 <= dy <= 300:
                self.cdp.call('Browser.setWindowBounds', {'windowId': w['result']['windowId'], 'bounds': {'width': WIDTH + dx, 'height': HEIGHT + dy, 'windowState': 'normal'}})
                log('window sized to %dx%d so the page viewport is %dx%d' % (WIDTH + dx, HEIGHT + dy, WIDTH, HEIGHT))
        except Exception as e:      # noqa: BLE001 - cosmetic step
            log('window fit skipped: %s' % e)

    def _on_event(self, m):
        if m.get('sessionId') != self.sid:
            return
        method, p = m.get('method'), m.get('params') or {}
        with self._ctx_lock:
            if method == 'Runtime.executionContextCreated':
                c = p.get('context') or {}
                self.contexts[c.get('id')] = c
            elif method == 'Runtime.executionContextDestroyed':
                self.contexts.pop(p.get('executionContextId'), None)
            elif method == 'Runtime.executionContextsCleared':
                self.contexts.clear()
                self._ext_ctx = None

    def contexts_copy(self):
        """A snapshot of the execution contexts (the reader thread mutates the dict while we iterate)."""
        with self._ctx_lock:
            return dict(self.contexts)

    def navigate(self, url):
        self.cdp.drain('Page.loadEventFired')
        r = self.cdp.call('Page.navigate', {'url': url}, session_id=self.sid, timeout=60)
        if 'error' in r:
            raise EnvError('Page.navigate %s failed: %s' % (url, r['error'].get('message')))
        self.main_frame = r['result'].get('frameId')
        self.cdp.wait_event('Page.loadEventFired', session_id=self.sid, timeout=60)

    # ------------------------------------------------------------------ evaluation
    def _evaluate(self, expression, ctx=None, await_promise=False, timeout=60):
        params = {'expression': expression, 'returnByValue': True, 'awaitPromise': bool(await_promise)}
        if ctx:
            params['contextId'] = ctx
        r = self.cdp.call('Runtime.evaluate', params, timeout=timeout, session_id=self.sid)
        if 'error' in r:
            raise StepError('Runtime.evaluate: %s' % r['error'].get('message'))
        res = r['result']
        if res.get('exceptionDetails'):
            ex = res['exceptionDetails']
            text = ex.get('exception', {}).get('description') or ex.get('text') or 'exception'
            raise StepError('page script threw: %s' % text.splitlines()[0][:300])
        return res.get('result', {}).get('value')

    def eval_main(self, expression, await_promise=False, soft=False, timeout=60):
        """Evaluate in the page's MAIN world (default context of the main frame)."""
        try:
            return self._evaluate(expression, None, await_promise, timeout)
        except StepError:
            if soft:
                return None
            raise

    def ext_context(self):
        """The extension's isolated-world context on the main frame (origin chrome-extension://<id>, isDefault
        false; verified on Chrome 150: name = the extension's name). Re-picked after every navigation. The dry run
        finds the world inject_extension() created under the extension's name the same way."""
        contexts = self.contexts_copy()
        cached = self._ext_ctx
        if cached and cached in contexts:
            return cached
        wanted = 'chrome-extension://' + (self.ext_id or '')
        for cid, c in sorted(contexts.items(), reverse=True):
            aux = c.get('auxData') or {}
            if aux.get('isDefault'):
                continue
            if self.main_frame and aux.get('frameId') and aux['frameId'] != self.main_frame:
                continue
            if wanted not in (c.get('origin') or '') and c.get('name') != self.ext_name:
                continue
            try:
                probe = self._evaluate(JS_EXT_PROBE, cid, timeout=10)
            except StepError:
                continue
            if probe and probe.get('panel'):
                with self._ctx_lock:
                    self._ext_ctx = cid
                return cid
        return None

    def eval_ext(self, expression, await_promise=False, soft=False, timeout=60):
        """Evaluate in the extension's world (dry run: the isolated world inject_extension() created)."""
        ctx = self.ext_context()
        if not ctx:
            if soft:
                return None
            raise StepError('the extension\'s isolated world is not present on this page (contexts: %s)' % ', '.join(
                '%s %s %s' % (c.get('name') or '-', c.get('origin'), (c.get('auxData') or {}).get('type')) for c in self.contexts_copy().values()))
        try:
            return self._evaluate(expression, ctx, await_promise, timeout)
        except StepError as e:
            if 'Cannot find context' in str(e):
                with self._ctx_lock:
                    self._ext_ctx = None
            if soft:
                return None
            raise

    def wait(self, label, get, pred, timeout, interval=0.5):
        """Poll get() until pred(state) is true; StepError names the label and the last state on timeout."""
        deadline = time.time() + timeout
        last = None
        while True:
            try:
                last = get()
            except StepError as e:
                last = {'error': str(e)}
            if last is not None and pred(last):
                return last
            if time.time() > deadline:
                raise StepError('%s: not reached within %d s (last state: %s)' % (label, timeout, json.dumps(last)[:400]))
            time.sleep(interval)

    # ------------------------------------------------------------------ the diary day
    def day_state(self):
        """Where the diary is: live, the day the extension's capture took from the app's last getDayInfo (and when it
        arrived); dry run, the mock's own day (and how many switches landed)."""
        if self.dry:
            return self.eval_main(JS_MOCK_DAY, soft=True) or {}
        return self.eval_ext(JS_CAPTURE_DAY, soft=True, timeout=15) or {}

    def current_day(self):
        """The day the diary shows; live, only when the app's last getDayInfo succeeded (HTTP 200): capture.js takes the
        day from the request, so a failed read would name a day the page may not be showing."""
        st = self.day_state()
        if not self.dry and st.get('date') and st.get('status') != 200:
            log("the app's last getDayInfo (for %s) answered HTTP %s: the day the diary shows is not known" % (st.get('date'), st.get('status')))
            return None
        return st.get('date')

    def _fresh(self, st, mark):
        if self.dry:
            return (st.get('changes') or 0) > (mark.get('changes') or 0)
        return (st.get('t') or 0) > (mark.get('t') or 0) and st.get('status') == 200

    def step_day(self, direction):
        """Press the diary's next (+1) or previous (-1) arrow once and wait until the diary shows the day after (before)
        the current one: live, the capture has seen the app's getDayInfo for exactly that day; dry run, the mock
        switched. StepError when the arrow is missing or the day does not arrive."""
        cur = self.cur_day or self.current_day()
        if not cur:
            raise StepError('the day the diary shows is not known (no getDayInfo reached the extension yet): the diary cannot be moved safely')
        expected = add_days(cur, direction)
        sel = NEXT_SEL if direction > 0 else PREV_SEL
        mark = self.day_state()
        c = self.eval_main(js_nav_click(sel), soft=True) or {}
        if not c.get('clicked'):
            raise StepError('no visible %s arrow on the page (%s element(s) found): the diary cannot be moved' % (sel, c.get('found')))
        self.wait('the diary to show %s' % expected, self.day_state, lambda s: s.get('date') == expected and self._fresh(s, mark), DAY_STEP_TIMEOUT_S, 0.2)
        self.cur_day = expected
        if self.dry and not self.eval_ext(js_sim_capture_day(expected), soft=True):
            raise StepError('could not hand the mock\'s day to CMA.capture.state (dry run)')
        return expected

    def goto_day(self, target):
        """Move the diary to `target` one arrow click at a time (bounded by MAX_DAY_STEPS)."""
        cur = self.current_day()
        if not cur:
            raise StepError('the day the diary shows is not known (no getDayInfo reached the extension yet): the diary cannot be moved safely')
        self.cur_day = cur
        n = days_between(cur, target)
        if abs(n) > MAX_DAY_STEPS:
            raise StepError('the diary shows %s, %d days away from %s: more than the %d steps this tool takes (open today\'s diary and run again)' % (cur, n, target, MAX_DAY_STEPS))
        for _ in range(abs(n)):
            self.step_day(1 if n > 0 else -1)
        return self.cur_day

    def settled_rows(self, names=None):
        """js_day_rows(names) once the diary looks the same for DAY_SETTLE_S (3 polls in a row with the group rows
        present): the app renders the day after its getDayInfo answered, and a re-render must not be counted half-way."""
        t0 = time.time()
        last, same, cur = None, 0, {}
        expr = js_day_rows(names)
        while True:
            cur = self.eval_main(expr, soft=True) or {}
            key = (cur.get('groups'), cur.get('visibleGroups'), cur.get('entries'), cur.get('hidden'), cur.get('foreign'))
            same = same + 1 if key == last else 0
            last = key
            if same >= 2 and cur.get('groups') and time.time() - t0 >= DAY_SETTLE_S:
                return cur
            if time.time() - t0 > DAY_SETTLE_TIMEOUT_S:
                return cur
            time.sleep(0.35)

    def day_is_empty(self, day):
        """(empty, why) for the day the diary shows now. Empty = no entry row in the diary FlexTable and, live, no
        serving in the extension's own getDayInfo read of that day (a failed read leaves the diary to decide)."""
        rows = self.settled_rows()
        if not rows.get('groups'):
            raise StepError('cannot tell whether %s is empty: the page shows no meal-group rows (td.diary-group-row), so the diary layout is not '
                            'the one this tool knows or the diary is not on screen; nothing was added' % day)
        if rows.get('entries'):
            return False, '%d entry row(s)%s in the diary' % (rows['entries'], ' (%d hidden)' % rows['hidden'] if rows.get('hidden') else '')
        if self.dry:
            return True, 'no entry row in the mock diary (%d meal groups)' % rows['groups']
        sv = self.eval_ext(js_day_servings(day), await_promise=True, soft=True, timeout=45) or {}
        if sv.get('ok') and sv.get('servings'):
            return False, 'the diary shows no entry row, but Cronometer lists %d serving(s) for the day' % sv['servings']
        # Exercise, biometric and note entries are in the same two lists but are no Serving: fail closed on any
        # element (a note can carry personal text). If EVERY day is refused this way, the lists are not empty on an
        # empty day after all: the count is in this log line; report it rather than working around it.
        if sv.get('ok') and sv.get('listed'):
            return False, "the diary shows no entry row, but Cronometer lists %d element(s) (exercise, biometric, note...) in the day's entry lists" % sv['listed']
        # the rows once more, seconds after the day arrived: entries the app renders late must not pass for an empty day
        again = self.settled_rows()
        if again.get('entries') or not again.get('groups'):
            return False, '%s entry row(s) in the diary on a second look' % again.get('entries')
        if sv.get('ok'):
            return True, 'no entry row in the diary (%d meal groups, looked at twice); Cronometer lists nothing for the day (0 servings, 0 elements in its entry lists)' % (
                rows['groups'])
        return True, 'no entry row in the diary (%d meal groups, looked at twice); the servings check could not run (%s)' % (rows['groups'], sv.get('why') or 'no answer')

    def find_empty_day(self):
        """Move the diary forward to an empty day (today + EMPTY_DAY_FIRST, then day by day up to EMPTY_DAY_MORE more)
        BEFORE anything is added. StepError when none is empty: nothing has been added at that point."""
        today = local_today()
        self.start_day = self.current_day()
        if not self.start_day:
            raise StepError('the day the diary shows is not known (the extension saw no getDayInfo): reload the diary and run again; nothing was added')
        self.cur_day = self.start_day
        first = add_days(max(self.start_day, today), EMPTY_DAY_FIRST)
        log('empty day: the diary shows %s; looking for a day without entries from %s (today + %d) on, before anything is added' % (
            self.start_day, first, EMPTY_DAY_FIRST))
        self.goto_day(first)
        cells = None
        for i in range(EMPTY_DAY_MORE + 1):
            day = self.cur_day
            empty, why = self.day_is_empty(day)
            if empty:
                self.shot_day = day
                log('empty day: %s (%s) - %s; the sample list goes there' % (day, offset_text(day, today), why))
                return day
            self.skipped_days.append((day, why))
            if cells is None:
                cells = (self.eval_main(JS_DAY_ROWS, soft=True) or {}).get('cells')
            log('empty day: %s (%s) is not empty (%s)%s' % (day, offset_text(day, today), why, '' if i == EMPTY_DAY_MORE else ': trying the next day'))
            if i < EMPTY_DAY_MORE:
                self.step_day(1)
        raise StepError('no empty diary day between %s and %s (%d days, all with entries); nothing was added. Cell classes of the first entry row '
                        'seen: %s. Clear a future day in Cronometer, or check whether that row really is an entry' % (
                            first, self.cur_day, EMPTY_DAY_MORE + 1, cells or '?'))

    def ensure_shot_day(self):
        """The diary must still show the empty day before a view is prepared for a capture: the RPC engine's refresh
        falls back to a #dashboard -> #diary hash flip, which could leave the app on another day. Move it back."""
        if not self.shot_day:
            return
        cur = self.current_day()
        if cur == self.shot_day:
            self.cur_day = cur
            return
        log('the diary shows %s instead of %s: moving it back before the next capture' % (cur, self.shot_day))
        self.goto_day(self.shot_day)
        if self.current_day() != self.shot_day:
            raise StepError('the diary does not show the empty day %s (it shows %s): no capture' % (self.shot_day, self.current_day()))

    def return_to_start(self):
        """After the undo (or a run that stopped before adding anything): the diary back on the day it opened on
        (today). Not while entries this run added may still be on the empty day: the diary then stays there, where
        the owner has to remove them. Best effort; it only changes the view."""
        if not self.start_day:
            return
        left = self.undone in ('pending', 'attempted') or self.undo_complete is False or (not self.dry and self.o.engine != 'rpc' and self.added_names)
        if self.shot_day and left:
            log('the diary stays on %s: the entries added there were not (all) removed' % self.shot_day)
            return
        try:
            self.goto_day(self.start_day)
            self.back_on_start = self.current_day() == self.start_day
        except StepError as e:
            self.back_on_start = False
            log('note: the diary could not be moved back to %s (%s); nothing in the diary depends on it' % (self.start_day, e))
            return
        log('diary back on %s%s' % (self.start_day, '' if self.back_on_start else ' (not confirmed)'))

    # ------------------------------------------------------------------ capture + blur
    def apply_blur(self, extra_selectors=None):
        """Inject the MAIN-world blur; returns (the manifest's `blurred` list for this capture, text hits)."""
        if self.o.no_blur:
            return [], 0
        selectors = self.selectors + list(extra_selectors or [])
        r = self.eval_main(js_blur(selectors, self.blur_texts), soft=True) or {}
        blurred = [s for s, n in (r.get('matched') or {}).items() if n and n > 0]
        hits = int(r.get('textHits') or 0)
        if hits:
            blurred.append('[%s] (account name / e-mail text: %d element(s))' % (BLUR_ATTR, hits))
        return blurred, hits

    def check_day_rows(self, name):
        """The capture guard: the diary shows the empty day, and every rendered entry row is one this run added.
        Before Add all no entry row may be rendered; after it at most the rows added (exactly that many once they were
        all seen), and each must contain the name of a food this run added - a day that is not the empty one (the RPC
        engine's refresh flips #dashboard -> #diary and steps the date arrows) fails that even with few entries."""
        cur = self.current_day()
        if cur != self.shot_day:
            raise StepError('%s refused: the diary shows %s, not the empty day %s' % (name, cur, self.shot_day))
        page = self.eval_main(JS_PAGE_STATE, soft=True) or {}
        if not page.get('food') or (not self.dry and not str(page.get('hash') or '').startswith('#diary')):
            raise StepError('%s refused: the diary is not on screen (hash %s, FOOD button %s)' % (name, page.get('hash'), page.get('food')))
        # what can be in the picture: the rendered entry rows (the empty-day check counted hidden ones too)
        if self.rows_allowed:
            rows = self.settled_rows(self.added_names)
        else:
            rows = self.eval_main(JS_DAY_ROWS, soft=True) or {}
        shown = (rows.get('entries') or 0) - (rows.get('hidden') or 0)
        if not rows.get('groups') or shown > self.rows_allowed:
            raise StepError('%s refused: the diary day %s shows %s entry row(s) (%s meal-group rows), more than the %d this run added' % (
                name, self.shot_day, shown, rows.get('groups'), self.rows_allowed))
        if self.rows_allowed and rows.get('foreign'):
            raise StepError('%s refused: %d of the %d entry row(s) the diary shows match none of the foods this run added (another day, or an '
                            'entry that is not ours)' % (name, rows['foreign'], shown))
        if self.entries_seen and shown != self.rows_allowed:
            raise StepError('%s refused: the diary shows %d entry row(s), not the %d this run added' % (name, shown, self.rows_allowed))
        # the day once more after the rows settled: it must not have changed while they were counted
        if self.current_day() != self.shot_day:
            raise StepError('%s refused: the diary moved away from the empty day %s while its rows were counted' % (name, self.shot_day))

    def capture(self, name, shot, data, extra_blur=None):
        """Blur, check the diary still shows the empty day with no entry row but the ones this run added, capture the
        viewport, record the manifest entry."""
        if self.shot_day:
            self.check_day_rows(name)
        blurred, hits = self.apply_blur()
        time.sleep(0.5)                                   # let the blur filters and the last render settle
        if not self.o.no_blur:
            # the text blur once more right before the capture: a toast or a greeting rendered in the pause must
            # not be captured unblurred (up to two more passes until no new element carries the name / e-mail)
            for _attempt in range(3):
                blurred2, hits2 = self.apply_blur()
                if hits2 <= hits:
                    blurred = blurred2
                    break
                log('%s: %d new element(s) with the account name / e-mail appeared before the capture; blurred them, looking again' % (name, hits2 - hits))
                blurred, hits = blurred2, hits2
                time.sleep(0.4)
            else:
                raise StepError('%s refused: elements with the account name / e-mail kept appearing (%d after three passes)' % (name, hits))
        if extra_blur:
            blurred += extra_blur
        # The clip is in DOCUMENT coordinates (measured on Chrome 150: after the diary shot scrolled the page, a
        # clip at 0,0 showed a blank band for the scrolled-out top and the fixed panel shifted down by scrollY),
        # so the viewport is the clip at the current scroll offset.
        scroll = self.eval_main('[window.scrollX || 0, window.scrollY || 0]', soft=True) or [0, 0]
        r = self.cdp.call('Page.captureScreenshot', {'format': 'png', 'clip': {'x': scroll[0], 'y': scroll[1], 'width': WIDTH, 'height': HEIGHT, 'scale': 1},
                                                     'captureBeyondViewport': False}, session_id=self.sid, timeout=60)
        if 'error' in r:
            raise StepError('Page.captureScreenshot (%s): %s' % (name, r['error'].get('message')))
        path = os.path.join(self.out_dir, name)
        with open(path, 'wb') as fh:
            fh.write(base64.b64decode(r['result']['data']))
        kind = 'store' if name in [n for n, _s in STORE_SHOTS] else 'extra'
        self.shots.append({'file': name, 'shot': shot, 'set': kind, 'data': data, 'diaryDay': self.shot_day, 'capturedAt': now_iso(),
                           'blurred': blurred, 'mode': 'dry-run' if self.dry else 'live', 'size': [WIDTH, HEIGHT],
                           'extensionVersion': self.manifest.get('version'), 'chrome': self.chrome_product})
        log('captured %s (%s, %s)%s' % (name, shot, data, ' - blurred: ' + ', '.join(blurred) if blurred else ' - nothing to blur'))
        return path

    def diary_data(self):
        """The manifest's `data` of the multi-add shots (write_manifest() adds the undo outcome to every entry)."""
        base = self.start_day or local_today()
        return 'sample list on an empty day of %s (%s, %s)' % ('the mock diary' if self.dry else 'the diary', self.shot_day,
                                                                offset_text(self.shot_day, base) if self.shot_day else '?')

    def undo_text(self):
        """What became of the entries this run added, for manifest.json."""
        if self.dry:
            return 'none: the dry run adds with the UI engine to the mock page, which is discarded'
        if not self.added_count and self.undone is None:
            return 'nothing was added'
        if self.o.engine != 'rpc':
            return 'NOT undone: the UI engine has no undo (remove the entries on %s by hand)' % self.shot_day
        if self.undone in ('pending', 'attempted') or self.undone is None:
            return 'NOT undone (the undo %s): remove the entries on %s by hand' % ('never started' if self.undone != 'attempted' else 'outcome is unknown', self.shot_day)
        return self.undone if self.undo_complete else 'INCOMPLETE: %s (check %s)' % (self.undone, self.shot_day)

    # ------------------------------------------------------------------ live: login wait
    def wait_for_login(self):
        timeout = self.o.login_timeout * 60
        deadline = time.time() + timeout
        print()
        print('  Log in to Cronometer in the window that just opened. Do not close it.')
        print('  This script continues automatically once the diary and the extension are on screen')
        print('  (it never touches the login form; it only waits, up to %d minutes).' % self.o.login_timeout)
        print()
        last_note = time.time()
        last_nudge = 0
        while True:
            st = self.eval_main(JS_PAGE_STATE, soft=True, timeout=10) or {}
            if st.get('app') and st.get('food') and st.get('host'):
                log('diary detected (%s%s) with the extension present' % (st.get('path'), st.get('hash')))
                return
            if st.get('app') and not st.get('food') and st.get('hash') != '#diary' and time.time() - last_nudge > 12:
                # logged in but on another view (dashboard, foods...): the diary toolbar only exists on #diary
                last_nudge = time.time()
                self.eval_main(JS_NUDGE_DIARY, soft=True)
                log('app is running on %s: switching to #diary' % (st.get('hash') or '(no hash)'))
            if time.time() > deadline:
                raise LoginTimeout('no logged-in diary within %d minutes (app iframe %s, FOOD button %s, panel host %s)' % (
                    self.o.login_timeout, st.get('app'), st.get('food'), st.get('host')))
            if time.time() - last_note >= 30:
                last_note = time.time()
                left = int(deadline - time.time())
                log('still waiting for the login (%d:%02d left; app iframe %s, FOOD button %s, panel host %s)' % (
                    left // 60, left % 60, st.get('app'), st.get('food'), st.get('host')))
            time.sleep(1)

    def wait_for_capture(self):
        """The RPC engine needs the session the hook captured from the app's own start-up traffic; the empty-day
        search needs the diary day from the app's getDayInfo (any engine)."""
        if self.o.engine == 'rpc':
            st = self.wait('extension session capture (CMA.capture.ready)', lambda: self.eval_ext(JS_READY, soft=True), lambda s: s.get('ok'), READY_TIMEOUT_S, 1.0)
            self.user_id = self.eval_ext(JS_USER_ID, soft=True)
            log('capture ready: groups %s (from %s), account id %s' % (st.get('groups'), st.get('groupsSource'), 'known (blurred in the shots)' if self.user_id else 'unknown'))
            if st.get('mismatch'):
                log('note: the live build differs from the shipped decoder; the extension rebuilds it (the RPC engine waits for that)')
        st = self.wait('the diary day from the app\'s getDayInfo (CMA.capture.state.diaryDate)', self.day_state, lambda s: s.get('date'), READY_TIMEOUT_S, 1.0)
        log('the diary shows %s (from %s)' % (st.get('date'), st.get('source')))

    # ------------------------------------------------------------------ dry run: inject the extension
    def inject_extension(self):
        """Dry run: an isolated world named after the extension on the main frame (what Chrome gives a content
        script), the manifest's ISOLATED-world scripts evaluated into it in manifest order."""
        if not self.main_frame:
            raise StepError('no main frame id from Page.navigate: cannot create the isolated world')
        w = self.cdp.call('Page.createIsolatedWorld', {'frameId': self.main_frame, 'worldName': self.ext_name}, session_id=self.sid, timeout=30)
        if 'error' in w:
            raise StepError('Page.createIsolatedWorld failed: %s' % w['error'].get('message'))
        ctx = w['result']['executionContextId']
        scripts = []
        for cs in self.manifest.get('content_scripts', []):
            if cs.get('world') == 'MAIN':
                continue
            scripts += cs.get('js', [])
        for rel in scripts:
            path = os.path.join(ROOT, rel)
            with open(path, encoding='utf-8') as fh:
                src = fh.read()
            try:
                self._evaluate(src + '\n//# sourceURL=' + rel, ctx, False, 60)
            except StepError as e:
                raise StepError('injecting %s: %s' % (rel, e))
        probe = self._evaluate(JS_EXT_PROBE, ctx, False, 10)
        if not probe or not probe.get('panel'):
            raise StepError('the injected scripts did not define CMA.panel (%s)' % json.dumps(probe))
        # the scenario reaches the world through ext_context(), by name, exactly like the live run
        found = self.wait('the isolated world "%s" among the execution contexts' % self.ext_name, self.ext_context, lambda c: c == ctx, 10, 0.2)
        main_cma = self.eval_main("typeof window.CMA === 'object' && !!(window.CMA.panel || window.CMA.capture)", soft=True)
        if main_cma:
            raise StepError('the extension scripts leaked into the page\'s MAIN world')
        log('injected %d isolated-world scripts into the mock page (manifest order, world "%s", context %s)' % (len(scripts), self.ext_name, found))

    # ------------------------------------------------------------------ the scenario
    def scenario(self, lines, engine):
        # 0. an empty day, before anything is added --------------------------------------------------
        self.find_empty_day()

        # 1. Input view -------------------------------------------------------------------------------
        log('shot 1/5: Input view')
        setup = self.eval_ext(js_setup(engine, self.o.delay_ms, self.dry), await_promise=True) or {}
        if setup.get('view') != 'input' or setup.get('why'):
            raise StepError('panel did not open the Input view (%s)' % json.dumps(setup))
        if setup.get('notice') == 'accepted':
            log('first-run notice shown and acknowledged with its Continue button')
        elif self.dry:
            raise StepError('dry run: the first-run notice did not appear on the fresh (in-memory) storage (%s)' % json.dumps(setup))
        time.sleep(0.4)
        dates = self.eval_ext(JS_PANEL_DATES) or {}
        if dates.get('diary') != self.shot_day or dates.get('override'):
            raise StepError('the panel would add to %s (diary date %s, override %s), not to the empty day %s: nothing was added' % (
                dates.get('override') or dates.get('diary'), dates.get('diary'), dates.get('override'), self.shot_day))
        r = self.eval_ext(js_type(lines, 'Dinner'))
        if not r or not r.get('ok'):
            raise StepError('typing failed: %s' % json.dumps(r))
        if r.get('group') != 'Dinner':
            log('warning: no "Dinner" group in the select (options: %s)' % r.get('options'))
        st = self.wait('Find foods enabled', lambda: self.eval_ext(JS_INPUT_STATE, soft=True), lambda s: s.get('find') and not s.get('findDisabled'), 60, 0.5)
        log('input typed (%d chars), engine %s, group %s, diary date %s%s' % (st.get('input', 0), st.get('engine'), r.get('group'), self.shot_day,
                                                                              (', banner: ' + st['banner']) if st.get('banner') else ''))
        self.ensure_shot_day()
        self.capture('01-input.png', 'input', self.diary_data())

        # 2. Preview ----------------------------------------------------------------------------------
        log('shot 2/5: Find foods -> Preview')
        c = self.eval_ext(js_click('Find foods'))
        if not c or not c.get('clicked'):
            raise StepError('could not press Find foods: %s' % json.dumps(c))
        st = self.wait('preview table after Find foods', lambda: self.eval_ext(JS_PREVIEW_STATE, soft=True),
                       lambda s: s.get('hasPlan') and not s.get('building') and s.get('rows', 0) > 0, FIND_TIMEOUT_S, 1.0)
        if st.get('notice') and st['notice'].startswith('Search failed'):
            raise StepError('Find foods failed: %s' % st['notice'])
        log('preview: %d row(s) - %s' % (st.get('rows', 0), st.get('status')))
        dates = self.eval_ext(JS_PANEL_DATES) or {}
        if dates.get('plan') != self.shot_day:
            raise StepError('the plan is dated %s, not the empty day %s: Add all not pressed, nothing was added' % (dates.get('plan'), self.shot_day))
        self.ensure_shot_day()
        self.capture('02-preview.png', 'preview', self.diary_data())
        if st.get('addDisabled'):
            raise StepError('Add all is disabled (%s): nothing can be added, so the diary shot is impossible' % (st.get('addTitle') or 'no ready rows'))

        # Add all --------------------------------------------------------------------------------------
        log('Add all (to %s)' % self.shot_day)
        if engine == 'rpc':
            # Armed BEFORE the click: the click runs in the page before Python sees its answer, so a Ctrl+C or an
            # evaluate error while waiting for that answer must still run the undo. undo() only removes a batch that is
            # newer than this page-clock mark, dated the empty day (and of the size added), so an Add all that never
            # started ends as 'nothing to undo' and an older stored batch is never touched.
            arm = self.eval_ext(JS_BATCH_IDS) or {}
            if not arm.get('now'):
                raise StepError('could not read the page clock before Add all (%s): nothing was added' % json.dumps(arm)[:200])
            self.armed_at = arm['now']
            self.undone = 'pending'
        c = self.eval_ext(js_click('Add all'))
        if not c or not c.get('clicked'):
            raise StepError('could not press Add all: %s' % json.dumps(c))
        st = self.wait('results after Add all', lambda: self.eval_ext(JS_RESULTS_STATE, soft=True),
                       lambda s: s.get('hasResult') and not s.get('running'), ADD_TIMEOUT_S, 1.0)
        self.added_names = self.eval_ext(JS_ADDED_NAMES, soft=True) or []
        self.added_count = int(st.get('added') or 0)
        self.rows_allowed = self.added_count
        log('results: %d added, %d failed, %d skipped - %s' % (st.get('added', 0), st.get('failed', 0), st.get('skipped', 0), st.get('status')))
        if st.get('notice'):
            log('panel notice: %s' % st['notice'])
        if not st.get('added'):
            self.problems.append('no row was added (first error: %s)' % (st.get('firstError') or 'none'))
        elif engine == 'rpc' and not st.get('undo'):
            self.problems.append('the Results view offers no Undo button although rows were added')
        if self.extra:
            log('extra: Results view')
            time.sleep(0.6)
            self.ensure_shot_day()
            self.capture('extra-results.png', 'results', self.diary_data())

        # 3. Diary ------------------------------------------------------------------------------------
        log('shot 3/5: the diary day with the new entries')
        self.eval_ext("(() => { CMA.panel.close(); return true; })()")
        self.ensure_entries_visible()
        self.ensure_shot_day()
        sc = self.eval_main(JS_SCROLL_GROUP % js('Dinner'), soft=True) or {}
        log('scrolled %s into view' % ('the "%s" group' % sc.get('title') if sc.get('found') else 'nothing (no .diary-group-title found)'))
        time.sleep(0.8)
        self.capture('03-diary.png', 'diary', self.diary_data())

        if self.extra:
            log('extra: Diagnostics view')
            self.eval_ext("(() => { CMA.panel.open('diagnostics'); return CMA.panel.getState().view; })()")
            time.sleep(0.5)
            blur = []
            if not self.o.no_blur:
                uid = self.user_id or self.eval_ext(JS_USER_ID, soft=True)
                if uid:
                    b = self.eval_ext(js_blur_pre([uid]), soft=True) or {}
                    if b.get('blurred'):
                        blur.append('diagnostics: account id (%d occurrence(s))' % b['blurred'])
                    log('diagnostics: account id blurred in %d place(s)' % b.get('blurred', 0))
            self.ensure_shot_day()
            self.capture('extra-diagnostics.png', 'diagnostics', 'extension state: versions, counts, flags (no health values)', extra_blur=blur)

        # 4-5. TDEE, synthetic demo data ----------------------------------------------------------------
        self.tdee_shots()

    def tdee_shots(self):
        """Shots 4 and 5 over the synthetic stub; the real data layer is back before this returns (or raises)."""
        log('shot 4/5: TDEE overview (synthetic demo data)')
        self.demo_restore = {'ok': False, 'restored': False}        # an install is attempted: restore_tdee() must run
        try:
            info = self.eval_ext(js_tdee_demo_install()) or {}
            if not info.get('ok'):
                raise StepError('the synthetic TDEE demo could not be installed: %s' % (info.get('why') or json.dumps(info)[:300]))
            self.demo_info = info
            log('synthetic TDEE demo in place of CMA.tdeeData: %s .. %s, %d days, %d weigh-ins, %d with food, %d check-ins; expenditure %s +/- %s (%s%s), '
                'trend %s kg (%+.2f kg/week), target %s -> %s kcal; the real data layer\'s enable()/sync() %s' % (
                    info.get('from'), info.get('today'), info.get('days', 0), info.get('weighIns', 0), info.get('intakeDays', 0), info.get('checkins', 0),
                    info.get('expenditure'), info.get('sd'), info.get('status'), ', calibrated' if info.get('calibrated') else '', info.get('trend'),
                    info.get('week') or 0, info.get('target'), info.get('newTarget'), 'guarded' if info.get('guarded') else 'NOT guarded (the stub swap alone keeps the view off them)'))
            self.eval_ext("(() => { CMA.panel.open('tdee'); return CMA.panel.getState().view; })()")
            st = self.wait('the TDEE overview over the synthetic data', lambda: self.eval_ext(JS_TDEE_STATE, soft=True),
                           lambda s: s.get('synthetic') and s.get('rendered') and not s.get('loading') and s.get('chip') and s.get('target')
                           and s.get('charts', 0) >= 2 and s.get('checkin'), TDEE_RENDER_TIMEOUT_S, 0.3)
            if st.get('consent') or st.get('waiting'):
                raise StepError('the TDEE tab shows its %s screen, not the overview' % ('consent' if st.get('consent') else 'waiting'))
            if st.get('checkinDisabled'):
                raise StepError('the check-in is not due over the synthetic data (%s): the dialog shot is impossible' % st.get('next'))
            log('overview: %s | %s | %s | this week %s, %s, %s | %s | %d chart(s), %d nudge(s)' % (
                st.get('chip'), st.get('big'), st.get('cmp'), st.get('target'), st.get('macros'), st.get('expect'), st.get('next'),
                st.get('charts', 0), st.get('nudges', 0)))
            if st.get('msg'):
                log('TDEE view message: %s' % st['msg'])
            time.sleep(0.6)
            tidy = self.eval_ext(JS_TDEE_TIDY, soft=True) or {}
            if tidy.get('scrolled') or tidy.get('why'):
                log('overview: panel body scrolled %d px%s' % (tidy.get('scrolled') or 0, (' (' + tidy['why'] + ')') if tidy.get('why') else ' so its bottom edge cuts no line of text'))
            self.ensure_shot_day()
            self.capture('04-tdee-overview.png', 'tdee-overview', SYNTHETIC)

            log('shot 5/5: weekly check-in dialog (synthetic demo data)')
            c = self.eval_ext(js_click_panel('.cma-tdee-checkin'))
            if not c or not c.get('clicked'):
                raise StepError('could not press Check in: %s' % json.dumps(c))
            st = self.wait('the weekly check-in dialog', lambda: self.eval_ext(JS_TDEE_STATE, soft=True),
                           lambda s: s.get('synthetic') and s.get('dialog') and s.get('accept') and chr(0x2192) in (s.get('change') or ''), TDEE_RENDER_TIMEOUT_S, 0.3)
            log('check-in: %s (%d reason(s))' % (st.get('change'), st.get('why', 0)))
            time.sleep(0.6)
            self.ensure_shot_day()
            self.capture('05-tdee-checkin.png', 'tdee-checkin', SYNTHETIC)
            c = self.eval_ext(js_click_panel('.cma-tdee-cancel'), soft=True) or {}
            log('check-in dialog %s (nothing recorded)' % ('cancelled' if c.get('clicked') else 'left open: the restore below closes it'))
        finally:
            self.restore_tdee()

    def restore_tdee(self):
        """Put the real CMA.tdeeData back whenever an install was attempted (the script is idempotent: it answers
        restored false when no stand-in is in place; bounded). Reported, never raised."""
        if self.demo_restore is None or self.demo_restore.get('restored') or self.demo_restore.get('checked'):
            return
        r = {}
        for _attempt in range(2):
            r = self.eval_ext(JS_TDEE_DEMO_RESTORE, soft=True, timeout=15) or {}
            if r:
                break
            time.sleep(1)
        if not r:
            self.demo_restore = {'ok': False, 'restored': False, 'checked': True, 'why': 'no answer from the extension world'}
            self.problems.append('the synthetic TDEE demo could not be removed (no answer): reload the Cronometer tab before using its TDEE tab')
            log('TDEE demo NOT removed (no answer from the extension world): reload the Cronometer tab before using its TDEE tab')
            return
        r['checked'] = True
        self.demo_restore = r
        if not r.get('restored'):
            log('no synthetic TDEE stand-in was in place (nothing to restore)')
            return
        calls = r.get('calls') or {}
        log('real TDEE data layer restored (%s; view closed first: %s; refused calls to its enable() %d, sync() %d)' % (
            'ok' if r.get('ok') else 'NOT confirmed', 'yes' if r.get('closedPanel') else 'no', calls.get('enable', 0), calls.get('sync', 0)))
        if r.get('restored') and not r.get('ok'):
            self.problems.append('the real CMA.tdeeData was not confirmed back in place: reload the Cronometer tab before using its TDEE tab')
        if calls.get('enable') or calls.get('sync'):
            self.problems.append('something called the real TDEE data layer while the demo was shown (enable %d, sync %d; refused)' % (calls.get('enable', 0), calls.get('sync', 0)))

    def ensure_entries_visible(self):
        """After the RPC batch the app only re-reads the day when the engine's date-arrow clicks were seen; make
        sure the names are on screen before the diary shot (one more previous/next round trip if they are not)."""
        names = self.added_names
        if not names:
            return
        get = lambda: self.eval_main(JS_DIARY_HAS % js(names), soft=True)  # noqa: E731
        try:
            st = self.wait('new entries in the diary', get, lambda s: s.get('visible', 0) >= len(names), 12, 1.0)
        except StepError:
            st = get() or {}
            log('only %d of %d added entries are visible: refreshing the diary through its date arrows' % (st.get('visible', 0), len(names)))
            try:
                self.cur_day = self.current_day() or self.shot_day
                self.step_day(-1)
                self.step_day(1)
            except StepError as e:
                log('the refresh round trip failed: %s' % e)
            try:
                st = self.wait('new entries in the diary (after refresh)', get, lambda s: s.get('visible', 0) >= len(names), 15, 1.0)
            except StepError:
                st = get() or {}
                self.problems.append('only %d of %d added entries are visible in the diary shot' % (st.get('visible', 0), len(names)))
        if st.get('visible', 0) >= len(names):
            self.entries_seen = True        # from now on a capture needs exactly the added rows on screen
        log('diary shows %d of %d added entries' % (st.get('visible', 0), len(names)))

    def batch_is_ours(self, b):
        """(ok, why) for a batch identity from JS_BATCH_IDS: created after Add all was armed, dated the empty day and,
        when the number of added rows is known, holding that many ids. Anything else may be an older batch of another
        (real) day, restored from chrome.storage.local in a reused --profile: never undone by this tool."""
        if not b:
            return False, 'no batch'
        if self.armed_at is None or (b.get('at') or 0) < self.armed_at:
            return False, 'created before this run pressed Add all'
        if b.get('date') != self.shot_day:
            return False, 'dated %s, not the empty day %s' % (b.get('date'), self.shot_day)
        if self.added_count and b.get('n') != self.added_count:
            return False, '%s ids, not the %d rows added' % (b.get('n'), self.added_count)
        return True, 'this run\'s batch (%d ids on %s)' % (b.get('n') or 0, b.get('date'))

    def undo(self, interrupted=False):
        """Undo the batch this run added (RPC engine). First waits (bounded) for a batch that is still running - a
        timeout or Ctrl+C can land between Add all and the Results view - then presses Undo this batch; when the
        Results view offers none (it never rendered), the Input view's Undo last batch, then the panel's own
        undo() on CMA.engineRpc.lastBatch - each fallback only when the batch it would remove is this run's
        (batch_is_ours). No batch newer than the arming mark and no result = Add all never started: nothing to undo.
        Waits for the panel's outcome line and checks it."""
        if self.undone != 'pending':
            return
        log('undo: removing the entries this run added to %s%s' % (self.shot_day, ' (one bounded attempt after Ctrl+C)' if interrupted else ''))
        self.undone = 'attempted'
        st = self.wait('the Add all batch to stop running before the undo', lambda: self.eval_ext(JS_RESULTS_STATE, soft=True),
                       lambda s: not s.get('running'), UNDO_RUN_WAIT_S, 1.0)
        if not self.added_names:
            self.added_names = self.eval_ext(JS_ADDED_NAMES, soft=True) or []
        if not self.added_count:
            self.added_count = int(st.get('added') or 0)
        if st.get('hasResult') and not st.get('added') and not st.get('lastBatch') and not st.get('engineBatch'):
            self.undone = 'nothing to undo (the batch added no entry)'
            self.undo_complete = True
            log('undo: %s' % self.undone)
            return
        ids = self.eval_ext(JS_BATCH_IDS, soft=True)
        if not ids:
            raise StepError('the batches that could be undone are not readable (no answer from the extension world): remove the entries by hand')
        fresh = [k for k in ('result', 'engine', 'stored') if (ids.get(k) or {}).get('at', 0) >= (self.armed_at or float('inf'))]
        if not st.get('hasResult') and not fresh:
            self.undone = 'nothing to undo (Add all never started: no result and no batch newer than the moment it was pressed)'
            self.undo_complete = True
            log('undo: %s' % self.undone)
            return
        self.eval_ext("(() => { CMA.panel.open('results'); return CMA.panel.getState().view; })()", soft=True)
        time.sleep(0.4)
        c = self.eval_ext(js_click('Undo this batch'), soft=True)
        c2 = c3 = None
        why = []
        if not c or not c.get('clicked'):
            ok2, why2 = self.batch_is_ours(ids.get('stored'))
            if ok2:
                self.eval_ext("(() => { CMA.panel.open('input'); return true; })()", soft=True)
                time.sleep(0.4)
                c2 = self.eval_ext(js_click('Undo last batch'), soft=True)
            else:
                why.append('Undo last batch not pressed: its stored batch is %s' % why2)
            if not c2 or not c2.get('clicked'):
                ok3, why3 = self.batch_is_ours(ids.get('engine'))
                if ok3:
                    c3 = self.eval_ext(JS_UNDO_ENGINE_BATCH, soft=True)
                else:
                    why.append('CMA.engineRpc.lastBatch not undone: it is %s' % why3)
                if not c3 or not c3.get('clicked'):
                    raise StepError('no undo could be started (%s / %s / %s%s): remove the entries by hand' % (
                        json.dumps(c), json.dumps(c2), json.dumps(c3), ('; ' + '; '.join(why)) if why else ''))
        log('undo started: %s' % next(x for x in (c, c2, c3) if x and x.get('clicked')).get('text'))
        st = self.wait('undo outcome', lambda: self.eval_ext(JS_UNDO_STATE, soft=True), lambda s: s.get('done'),
                       UNDO_TIMEOUT_INTERRUPTED_S if interrupted else UNDO_TIMEOUT_S, 1.0)
        outcome = st.get('status') if (st.get('status') or '').startswith('Undo') else st.get('notice')
        self.undone = outcome or 'attempted'    # an empty outcome is unknown: keep the end-of-run warning
        expected = 'Undo: %d removed, 0 failed' % self.added_count
        self.undo_complete = bool(outcome) and outcome.startswith(expected)
        log('undo outcome: %s (expected "%s"; ids still stored for undo: %d)' % (outcome, expected, st.get('remaining', 0)))
        if not self.undo_complete:
            self.problems.append('the undo did not report "%s": %s' % (expected, outcome or 'no outcome'))
        if st.get('remaining'):
            self.problems.append('undo left %d entry id(s) in the stored batch: %s' % (st['remaining'], outcome))
        # a look at the diary after the engine's refresh: the names should be gone and the day empty again
        names = self.added_names
        if names and not interrupted:
            time.sleep(3)
            d = self.eval_main(JS_DIARY_HAS % js(names), soft=True) or {}
            rows = self.eval_main(JS_DAY_ROWS, soft=True) or {}
            log('diary %s now shows %d of the %d added entries and %s entry row(s)%s' % (
                self.current_day(), d.get('visible', 0), len(names), rows.get('entries', '?'), ' (reload the page to be sure)' if d.get('visible') else ''))

    # ------------------------------------------------------------------ flows
    def run_live(self):
        self.navigate(LIVE_URL)
        self.wait_for_login()
        if not self.ext_context():
            raise StepError('the extension\'s isolated world was not found on the diary page')
        self.wait_for_capture()
        if not self.o.no_blur:
            t = self.eval_main(js_account_texts(), soft=True) or {}
            if t.get('ok'):
                for s in t.get('texts') or []:
                    if s not in self.blur_texts:
                        self.blur_texts.append(s)
                log('account name / e-mail read from the app for the text blur: %d value(s)' % len(t.get('texts') or []))
                if not t.get('firstFound'):
                    log('NOTE: no first name found in the app\'s User object (this build may use another property): pass --blur-text '
                        '"<first name>" (and a last or display name) so it is blurred wherever it appears')
            else:
                log('account name not readable from the app (%s): pass --blur-text if it appears on screen' % t.get('why'))
        # A profile where the TDEE tab was enabled would sync the owner's real history after Add all (through the real
        # layer's own closures, which the demo's guards do not intercept) and extra-diagnostics.png would show its
        # counts and date ranges: refuse such a profile before anything is added (init() reads storage only).
        td = self.eval_ext("""(async () => {
  try {
    const d = CMA.tdeeData;
    if (!d || typeof d.status !== 'function') return {ok: true, enabled: false, why: 'no TDEE data layer'};
    if (typeof d.init === 'function') await d.init();
    return {ok: true, enabled: !!d.status().enabled};
  } catch (e) { return {ok: false, why: String(e && e.message)}; }
})()""", await_promise=True, soft=True, timeout=30) or {}
        if not td.get('ok'):
            raise StepError('could not tell whether the TDEE tab is enabled in this profile (%s): nothing was added' % td.get('why'))
        if td.get('enabled'):
            raise StepError('the TDEE tab is enabled in this Chrome profile: its real history would be refreshed and counted during the run. Use the '
                            'default temporary profile, or a --profile DIR where the TDEE tab was never enabled; nothing was added')
        lines = self.o.lines_text or LIVE_LINES
        interrupted = False
        try:
            self.scenario(lines, self.o.engine)
        except KeyboardInterrupt:
            interrupted = True
            raise                           # after the finally below: exactly one bounded undo attempt first
        finally:
            if self.undone == 'pending':
                if interrupted:
                    print()
                    log('interrupted after Add all: one bounded undo attempt before Chrome closes (Ctrl+C again skips it)')
                try:
                    self.undo(interrupted=interrupted)
                except KeyboardInterrupt:
                    if not interrupted:
                        raise
                    log('undo skipped by a second Ctrl+C')
                except Exception as e:      # noqa: BLE001 - reported, never masks the first error
                    self.problems.append('undo failed: %s' % e)
                    log('UNDO FAILED: %s - remove the added entries from %s by hand' % (e, self.shot_day))
            self.restore_tdee()             # normally done already by tdee_shots(); a no-op then
            if not interrupted:
                self.return_to_start()
        if self.added_names and self.o.engine != 'rpc':
            self.problems.append('the UI engine has no undo: %d entries remain in the diary on %s (remove them by hand)' % (len(self.added_names), self.shot_day))

    def run_dry(self):
        url = 'file:///' + MOCK_PAGE.replace('\\', '/')
        self.navigate(url)
        self.wait('mock page', lambda: self.eval_main(JS_MOCK_STATE, soft=True), lambda s: s.get('mock') and s.get('handle') and s.get('ready') == 'complete', 30, 0.5)
        log('mock diary loaded (%s)' % url)
        self.inject_extension()
        self.dry_account()
        start = self.dry_days()
        lines = self.o.lines_text or DRY_LINES
        try:
            self.scenario(lines, 'ui')
        finally:
            self.restore_tdee()
        added = self.eval_main(JS_MOCK_ADDED, soft=True) or []
        expected = len([l for l in lines.splitlines() if l.strip() and not l.strip().startswith('#') and not l.strip().startswith('//')])
        log('mock recorded %d add(s): %s' % (len(added), '; '.join('%s [%s]' % (a.get('text'), a.get('date')) for a in added)))
        if len(added) != expected:
            self.problems.append('the mock recorded %d adds, expected %d' % (len(added), expected))
        if any(a.get('date') != self.shot_day for a in added):
            self.problems.append('the mock recorded adds on %s, not only on the empty day %s' % (sorted(set(str(a.get('date')) for a in added)), self.shot_day))
        # the dry run's own checks of the empty-day search (the seeds are the tool's own: +0 and +7 hold entries)
        seeded = add_days(start, EMPTY_DAY_FIRST)
        if seeded not in [d for d, _why in self.skipped_days]:
            self.problems.append('the empty-day search did not skip the seeded day %s (skipped: %s)' % (seeded, self.skipped_days))
        if self.shot_day != add_days(start, EMPTY_DAY_FIRST + 1):
            self.problems.append('the shots were taken on %s, expected the first empty day %s' % (self.shot_day, add_days(start, EMPTY_DAY_FIRST + 1)))
        self.dry_guard_check()
        for name, ok, detail in undo_probe_cases():
            log('undo probe: %s - %s (%s)' % (name, 'ok' if ok else 'FAILED', detail))
            if not ok:
                self.problems.append('undo state machine: %s (%s)' % (name, detail))
        self.return_to_start()
        rows = self.settled_rows()
        if not self.back_on_start or self.current_day() != start or rows.get('entries') != 1:
            self.problems.append('the mock diary is not back on the start day %s with its one seeded entry (day %s, %s entry row(s))' % (start, self.current_day(), rows.get('entries')))

    def dry_guard_check(self):
        """Dry run: the capture guard must refuse the empty day (1) once it shows one entry row more than this run
        added (a synthetic row slipped into the mock's diary table), and (2) when the row count is right but one row is
        not one of ours (one added row hidden, a synthetic row shown instead: another day with as few entries).
        Both changes are undone afterwards."""
        self.guard_refused = self._guard_case('one row more than added', hide_one=False) and self._guard_case('same count, one foreign row', hide_one=True)

    def _guard_case(self, label, hide_one):
        added = self.eval_main("""(() => {
  const head = document.querySelector('td.diary-group-row');
  if (!head) return false;
  const tr = document.createElement('tr');
  tr.id = 'cma-dry-guard-row';
  for (const t of ['', 'Guard check entry (synthetic)', '1 serving']) { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); }
  head.closest('tr').after(tr);
  if (%s) {
    const names = %s.map(n => String(n).toLowerCase());
    const mine = Array.from(document.querySelectorAll('.diary-panel tr')).find(r => r.getClientRects().length && names.some(n => (r.textContent || '').toLowerCase().includes(n)));
    if (!mine) { tr.remove(); return false; }
    mine.setAttribute('data-cma-dry-hidden', mine.style.display || '-');
    mine.style.display = 'none';
  }
  return true;
})()""" % ('true' if hide_one else 'false', js(self.added_names)), soft=True)
        if not added:
            self.problems.append('the capture-guard check (%s) could not change the mock diary' % label)
            return False
        before = len(self.shots)
        refused = False
        try:
            self.capture('guard-check.png', 'guard-check', 'must be refused')
        except StepError as e:
            refused = True
            log('capture guard (%s): refused, as it must (%s)' % (label, str(e)[:140]))
        else:
            del self.shots[before:]
            try:
                os.remove(os.path.join(self.out_dir, 'guard-check.png'))
            except OSError:
                pass
            self.problems.append('the capture guard did not refuse a diary day with an entry row this run did not add (%s)' % label)
        finally:
            self.eval_main("""(() => {
  const r = document.getElementById('cma-dry-guard-row'); if (r) r.remove();
  for (const h of document.querySelectorAll('[data-cma-dry-hidden]')) { const d = h.getAttribute('data-cma-dry-hidden'); h.style.display = d === '-' ? '' : d; h.removeAttribute('data-cma-dry-hidden'); }
  return true;
})()""", soft=True)
        return refused

    def dry_days(self):
        """Dry run: the mock's day navigation on, starting today, with synthetic entries on today and on +7."""
        start = local_today()
        seed = {add_days(start, off): [{'group': g, 'name': n, 'amount': a} for g, n, a in rows] for off, rows in DRY_SEED.items()}
        got = self.eval_main('(() => window.mock.useDays(%s))()' % js({'start': start, 'entries': seed, 'delay': DRY_MOCK_DELAY_MS}))
        if got != start:
            raise StepError('the mock\'s day navigation did not start on %s (%r)' % (start, got))
        if not self.eval_ext(js_sim_capture_day(start), soft=True):
            raise StepError('could not hand the mock\'s day to CMA.capture.state (dry run)')
        log('mock day navigation on: start %s, synthetic seeded entries on %s' % (start, ', '.join(sorted(seed))))
        return start

    def dry_account(self):
        """Dry run: a synthetic account for the blur code paths the live run takes (never a real account). A
        label with the name and the e-mail in separate spans and a text input holding the e-mail must be marked; a
        password input and an autocomplete=current-password text field holding the name must not (js_blur skips
        them). The id goes into the capture state, so the Diagnostics dump carries it for js_blur_pre."""
        if self.o.no_blur:
            return
        r = self.eval_main("""(() => {
  const box = document.createElement('div');
  box.id = 'cma-dry-account';
  box.style.cssText = 'margin:0 0 8px;padding:4px 8px;border:1px dashed #999;display:flex;gap:8px;align-items:center';
  const label = document.createElement('span'); label.textContent = 'Signed in (synthetic):';
  const name = document.createElement('span'); name.textContent = %s;
  const mail = document.createElement('span'); mail.textContent = %s;
  const text = document.createElement('input'); text.type = 'text'; text.value = %s;
  const pw = document.createElement('input'); pw.type = 'password'; pw.value = %s;
  const cur = document.createElement('input'); cur.type = 'text'; cur.setAttribute('autocomplete', 'current-password'); cur.value = %s;
  box.append(label, name, mail, text, pw, cur);
  // stand-ins for the summary-column widgets with a personal figure (DRY_BLUR_PROBES), built like the compiled
  // client's: the whole Water card (class 'water-tracking', its heading outside the target bar) and the Daily Target
  // Editor header "<div><div class='daily-target-editor-title'>DAILY TARGET EDITOR <span/></div> <span/></div>"
  const water = document.createElement('div'); water.className = 'water-tracking';
  const wh = document.createElement('div'); wh.textContent = 'Water 0 / 2500 mL (synthetic)';
  const wb = document.createElement('div'); wb.className = 'water-tracking-target-bar'; wb.textContent = '0%%';
  water.append(wh, wb);
  const ed = document.createElement('div');
  const et = document.createElement('div'); et.className = 'daily-target-editor-title'; et.textContent = 'DAILY TARGET EDITOR ';
  const es1 = document.createElement('span'); es1.textContent = 'Mon';
  et.appendChild(es1);
  const es2 = document.createElement('span'); es2.textContent = 'Synthetic target profile';
  ed.append(et, es2);
  box.append(water, ed);
  document.body.insertBefore(box, document.body.firstChild);
  return true;
})()""" % (js(DRY_ACCOUNT_NAME), js(DRY_ACCOUNT_EMAIL), js(DRY_ACCOUNT_EMAIL), js(DRY_ACCOUNT_NAME), js(DRY_ACCOUNT_NAME)))
        if not r:
            raise StepError('could not add the synthetic account label to the mock page')
        for t in (DRY_ACCOUNT_NAME, DRY_ACCOUNT_EMAIL):
            if t not in self.blur_texts:
                self.blur_texts.append(t)
        ok = self.eval_ext("(() => { const s = CMA.capture && CMA.capture.state; if (!s) return false; s.userId = %s; s.userIdSource = 'dry-run'; return true; })()" % int(DRY_ACCOUNT_ID))
        if not ok:
            raise StepError('could not set the synthetic account id in CMA.capture.state')
        self.user_id = DRY_ACCOUNT_ID
        log('synthetic account for the blur checks: a name, an e-mail and an id (dry run only)')

    def check_dry(self):
        """(ok, [messages]): what the dry-run manifest.json must list, and what the run itself proved."""
        path = os.path.join(self.out_dir, 'manifest.json')
        try:
            with open(path, encoding='utf-8') as fh:
                entries = {e.get('file'): e for e in json.load(fh)}
        except (OSError, ValueError) as e:
            return False, ['dry-run manifest.json unreadable: %s' % e]
        msgs = []
        for name, shot in self.expected_shots():
            e = entries.get(name) or {}
            want_set = 'store' if (name, shot) in STORE_SHOTS else 'extra'
            if e.get('shot') != shot or e.get('set') != want_set:
                msgs.append('%s: manifest entry shot/set %r/%r, expected %r/%r' % (name, e.get('shot'), e.get('set'), shot, want_set))
            if e.get('diaryDay') != self.shot_day:
                msgs.append('%s: manifest diaryDay %r, expected the empty day %r' % (name, e.get('diaryDay'), self.shot_day))
            is_tdee = name in TDEE_SHOT_FILES
            if is_tdee and e.get('data') != SYNTHETIC:
                msgs.append('%s: manifest data %r, expected %r' % (name, e.get('data'), SYNTHETIC))
            if not is_tdee and e.get('data') == SYNTHETIC:
                msgs.append('%s: marked %r although it shows the diary' % (name, SYNTHETIC))
        if not self.o.no_blur:
            want_text = '[%s] (account name / e-mail text: %d element(s))' % (BLUR_ATTR, DRY_TEXT_HITS)
            for name, _shot in self.expected_shots():
                blurred = (entries.get(name) or {}).get('blurred') or []
                if want_text not in blurred:
                    msgs.append('%s: manifest lacks %r (has %s)' % (name, want_text, blurred))
            for name, _shot in self.expected_shots():
                blurred = (entries.get(name) or {}).get('blurred') or []
                missing = [p for p in DRY_BLUR_PROBES if p not in blurred]
                if missing:
                    msgs.append('%s: the blur did not match %s (the synthetic Water card / Daily Target Editor header)' % (name, missing))
            diag = (entries.get('extra-diagnostics.png') or {}).get('blurred') or []
            if not any(b.startswith('diagnostics: account id (') for b in diag):
                msgs.append('extra-diagnostics.png: manifest lacks the "diagnostics: account id" entry (has %s)' % diag)
        r = self.demo_restore or {}
        if not (r.get('restored') and r.get('ok') and not r.get('stillSynthetic')):
            msgs.append('the real CMA.tdeeData was not confirmed back after the TDEE shots (%s)' % json.dumps(r))
        if not (self.demo_info or {}).get('guarded'):
            msgs.append('the real TDEE data layer\'s enable()/sync() were not guarded during the demo')
        if self.guard_refused is not True:
            msgs.append('the capture guard was not shown to refuse a diary day with an entry row this run did not add (both cases)')
        if msgs:
            return False, msgs
        n_extra = len(self.expected_shots()) - len(STORE_SHOTS)
        if self.o.no_blur:
            first = 'dry-run manifest: %d shots on the empty day %s, "%s" on the TDEE shots only (blur checks skipped: --no-blur)' % (
                len(self.expected_shots()), self.shot_day, SYNTHETIC)
        else:
            first = ('dry-run manifest: %d store + %d extra shots, all on the empty day %s, "%s" on %s only; the text blur in every shot '
                     '(%d elements, password fields untouched), the account id in extra-diagnostics.png' % (
                         len(STORE_SHOTS), n_extra, self.shot_day, SYNTHETIC, ' and '.join(TDEE_SHOT_FILES), DRY_TEXT_HITS))
        return True, [first, 'empty day: %s skipped (seeded entries), shots on %s, the mock back on %s; the capture guard refused the day with one '
                             'entry row more than the run added and the day with the right count but one foreign row; TDEE demo: the real data '
                             'layer restored, 0 calls to its enable()/sync()' % (
                                 ', '.join(d for d, _w in self.skipped_days), self.shot_day, self.start_day),
                      'blur probes matched in every shot: %s' % ', '.join(DRY_BLUR_PROBES) if not self.o.no_blur else 'blur probes skipped (--no-blur)']

    def write_manifest(self):
        path = os.path.join(self.out_dir, 'manifest.json')
        undo = self.undo_text()
        for e in self.shots:
            e['undo'] = undo
        self.shots.sort(key=lambda e: (e.get('set') != 'store', e.get('file')))     # upload order, then the extras
        # newline='\n': the file is committed next to the PNGs and every text file in the repository is LF (text
        # mode on Windows would write CRLF); json.dump writes no final newline, so add the one editors expect.
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(self.shots, fh, indent=2)
            fh.write('\n')
        log('wrote %s' % path)
        # PNGs of an earlier run (the old five-shot set, extras of an --extra run) are never deleted: name them
        mine = set(e['file'] for e in self.shots)
        try:
            stale = sorted(f for f in os.listdir(self.out_dir) if f.lower().endswith('.png') and f not in mine)
        except OSError:
            stale = []
        if stale:
            log('note: %s also holds %s from an earlier run (not in this manifest.json; an old set may show a real diary): delete them before uploading' % (
                self.out_dir, ', '.join(stale)))

    def verify(self):
        ok_all = True
        for name, _shot in self.expected_shots():
            path = os.path.join(self.out_dir, name)
            if not os.path.isfile(path):
                print('FAIL  %s: missing' % name)
                ok_all = False
                continue
            ok, detail = png_verify(path)
            print('%s  %s: %s' % ('ok  ' if ok else 'FAIL', name, detail))
            ok_all = ok_all and ok
        if self.dry:
            ok, msgs = self.check_dry()
            for m in msgs:
                print('%s  %s' % ('ok  ' if ok else 'FAIL', m))
            ok_all = ok_all and ok
        return ok_all

    # ------------------------------------------------------------------ lifecycle
    def clear_session(self):
        """Best effort, bounded: drop cronometer.com's storage and every cookie of this profile before Chrome
        closes, so a temporary profile that cannot be deleted afterwards holds no usable login."""
        if not self.cdp or not self.cdp.alive():
            return
        cleared = []
        if self.sid:
            r = self.cdp.call('Storage.clearDataForOrigin', {'origin': 'https://cronometer.com', 'storageTypes': 'all'}, session_id=self.sid, timeout=10)
            if 'error' not in r:
                cleared.append('cronometer.com storage')
            r = self.cdp.call('Network.clearBrowserCookies', session_id=self.sid, timeout=10)
            if 'error' not in r:
                cleared.append('cookies')
        if 'cookies' not in cleared:
            r = self.cdp.call('Storage.clearCookies', timeout=10)          # browser-level fallback
            if 'error' not in r:
                cleared.append('cookies')
        log('session data cleared before closing Chrome: %s' % (', '.join(cleared) or 'nothing (Chrome did not answer)'))

    def shutdown(self, interrupted=False):
        if self.cdp:
            if self.o.keep_open and not self.o.headless and not interrupted:
                print()
                print('  --keep-open: the Chrome window stays open. Press Enter here to close it', flush=True)
                try:
                    input()
                except (EOFError, KeyboardInterrupt):
                    pass
            if self.temp_profile:
                try:
                    self.clear_session()
                except Exception as e:      # noqa: BLE001 - best effort; the delete below still runs
                    log('session clear skipped: %s' % e)
            if interrupted:
                self.cdp.kill()
            else:
                self.cdp.close()
        if self.temp_profile and self.profile:
            for _ in range(PROFILE_DELETE_TRIES):   # Chrome releases its profile files a moment after exiting
                shutil.rmtree(self.profile, ignore_errors=True)
                if not os.path.exists(self.profile):
                    break
                time.sleep(PROFILE_DELETE_PAUSE_S)
            if not os.path.exists(self.profile):
                log('temporary profile deleted')
            else:
                print()
                print('  !!! The temporary Chrome profile could NOT be deleted: %s' % self.profile)
                print('  !!! Delete that folder by hand (its Cronometer storage and cookies were cleared first, best effort).')
                print()


class _UndoProbe(Shooter):
    """Drives Shooter.undo() against scripted answers instead of a page (dry run: the mock has no RPC engine, so the
    live undo path is otherwise never exercised). `page` maps what the extension world would answer; every click is
    recorded, and a click makes JS_UNDO_STATE report the outcome."""

    def __init__(self, page, added_count=4, armed_at=1000):   # noqa: D107 - no Chrome, no files
        self.o = argparse.Namespace(no_blur=True, engine='rpc', dry_run=False)
        self.dry = False
        self.page = page
        self.clicks = []
        self.problems = []
        self.shot_day = '2031-01-15'
        self.added_names = ['probe food']
        self.added_count = added_count
        self.armed_at = armed_at
        self.undone = 'pending'
        self.undo_complete = None

    def eval_ext(self, expression, await_promise=False, soft=False, timeout=60):
        if expression == JS_RESULTS_STATE:
            return self.page['results']
        if expression == JS_BATCH_IDS:
            return self.page['ids']
        if expression == JS_ADDED_NAMES:
            return list(self.added_names)
        if expression == JS_UNDO_STATE:
            return {'done': bool(self.clicks), 'status': 'Undo: %d removed, 0 failed' % self.added_count if self.clicks else '', 'notice': '', 'remaining': 0}
        for label, expr in (('Undo this batch', js_click('Undo this batch')), ('Undo last batch', js_click('Undo last batch'))):
            if expression == expr:
                if label in self.page.get('buttons', ()):
                    self.clicks.append(label)
                    return {'clicked': True, 'text': label}
                return {'clicked': False, 'why': 'no button'}
        if expression == JS_UNDO_ENGINE_BATCH:
            self.clicks.append('engine lastBatch')
            return {'clicked': True, 'text': 'CMA.panel.undo(CMA.engineRpc.lastBatch)'}
        return True                                   # CMA.panel.open(...)

    def eval_main(self, expression, await_promise=False, soft=False, timeout=60):
        return {}


def undo_probe_cases():
    """[(name, ok, detail)] for the undo state machine: armed before the click, fallback identity checks, 'nothing
    to undo'. Pure Python; part of the dry run (green bar)."""
    day = '2031-01-15'
    ours = {'date': day, 'n': 4, 'at': 2000}
    old = {'date': '2030-12-01', 'n': 3, 'at': 500}
    idle = {'running': False, 'hasResult': False, 'added': 0, 'lastBatch': 0, 'engineBatch': 0}
    done = {'running': False, 'hasResult': True, 'added': 4, 'lastBatch': 4, 'engineBatch': 4}
    cases = [
        ('Add all never started: nothing to undo, nothing clicked', {'results': idle, 'ids': {'now': 3000, 'engine': None, 'stored': old, 'result': None}, 'buttons': ('Undo last batch',)},
         lambda u: u.undone.startswith('nothing to undo') and u.undo_complete and not u.clicks),
        ('Results view offers Undo this batch: it is pressed', {'results': done, 'ids': {'now': 3000, 'engine': ours, 'stored': None, 'result': ours}, 'buttons': ('Undo this batch',)},
         lambda u: u.clicks == ['Undo this batch'] and u.undo_complete),
        ('no Undo this batch, stored batch of another day: never pressed, engine batch of this run undone',
         {'results': dict(done, hasResult=False), 'ids': {'now': 3000, 'engine': ours, 'stored': old, 'result': None}, 'buttons': ('Undo last batch',)},
         lambda u: u.clicks == ['engine lastBatch'] and u.undo_complete),
        ('no Undo this batch, stored and engine batch both older than Add all: nothing removed, the warning path runs',
         {'results': dict(done, hasResult=True), 'ids': {'now': 3000, 'engine': old, 'stored': old, 'result': None}, 'buttons': ('Undo last batch',)},
         lambda u: 'error' in u.__dict__ and not u.clicks and u.undone == 'attempted'),
        ('a fresh batch of the wrong size is not undone',
         {'results': dict(done, hasResult=True), 'ids': {'now': 3000, 'engine': dict(ours, n=2), 'stored': None, 'result': None}, 'buttons': ()},
         lambda u: 'error' in u.__dict__ and not u.clicks),
    ]
    out = []
    for name, page, pred in cases:
        u = _UndoProbe(page)
        try:
            u.undo(interrupted=True)
        except StepError as e:
            u.error = str(e)
        try:
            ok = bool(pred(u))
        except Exception as e:      # noqa: BLE001 - a broken predicate is a failed case
            ok = False
            u.error = 'predicate: %s' % e
        out.append((name, ok, 'undone=%r, clicks=%s%s' % (u.undone, u.clicks, (', error=' + u.__dict__['error'][:120]) if 'error' in u.__dict__ else '')))
    return out


def check_store(out_dir):
    """--check-store: is <out_dir> ready to upload? A live manifest.json listing exactly the five store shots (each
    'mode': 'live', the TDEE ones 'synthetic demo', a complete undo), each PNG present and valid, and no other PNG in
    the folder (an old set may show a real diary). Returns (ok, [lines])."""
    lines, ok = [], True
    path = os.path.join(out_dir, 'manifest.json')
    try:
        with open(path, encoding='utf-8') as fh:
            entries = json.load(fh)
    except (OSError, ValueError) as e:
        return False, ['FAIL  %s unreadable: %s' % (path, e)]
    by_file = {e.get('file'): e for e in entries if isinstance(e, dict)}
    for name, shot in STORE_SHOTS:
        e = by_file.get(name)
        if not e:
            ok = False
            lines.append('FAIL  %s: not in manifest.json (a live run of this version has not produced it)' % name)
            continue
        bad = []
        if e.get('mode') != 'live':
            bad.append('mode %r (only a live run of the real panel may be uploaded)' % e.get('mode'))
        if e.get('shot') != shot or e.get('set') != 'store':
            bad.append('shot/set %r/%r' % (e.get('shot'), e.get('set')))
        if (name in TDEE_SHOT_FILES) != (e.get('data') == SYNTHETIC):
            bad.append('data %r' % e.get('data'))
        if not str(e.get('undo') or '').startswith('Undo: '):
            bad.append('undo %r (the sample entries were not confirmed removed)' % e.get('undo'))
        pth = os.path.join(out_dir, name)
        if os.path.isfile(pth):
            pok, detail = png_verify(pth)
            if not pok:
                bad.append(detail)
        else:
            bad.append('PNG missing')
        ok = ok and not bad
        lines.append(('FAIL  %s: %s' % (name, '; '.join(bad))) if bad else ('ok    %s: live, %s, %s' % (name, e.get('capturedAt'), e.get('data'))))
    wanted = set(n for n, _s in STORE_SHOTS)
    try:
        others = sorted(f for f in os.listdir(out_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg')) and f not in wanted)
    except OSError:
        others = []
    if others:
        ok = False
        lines.append('FAIL  %s also holds %s: not part of the store set (an old set shows a real diary) - delete them before uploading' % (out_dir, ', '.join(others)))
    lines.append('STORE SET READY (open every PNG once more before uploading)' if ok else 'STORE SET NOT READY')
    return ok, lines


def old_pictures(out_dir):
    """The pictures a live run refuses to start next to: every PNG / JPEG already in <out_dir> (the old 0.2.0 set, or
    a failed run's, may show a real diary and has names the new set shares)."""
    try:
        return sorted(f for f in os.listdir(out_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg')) and os.path.isfile(os.path.join(out_dir, f)))
    except OSError:
        return []


def inside(path, root):
    a, b = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(root))
    return a == b or a.startswith(b.rstrip('\\/') + os.sep)


def parse_args(argv):
    ap = argparse.ArgumentParser(description='Chrome Web Store screenshots of Multi-Add for Cronometer: the real extension on an empty diary day, the TDEE tab on synthetic data.',
                                 epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'store-assets'), help='output directory (default: store-assets/; the dry run writes to <out>/dry-run/)')
    ap.add_argument('--dry-run', action='store_true', help='use tests/mock-cronometer.html and the UI engine instead of cronometer.com')
    ap.add_argument('--headless', action='store_true', help='headless Chrome (implies --dry-run: nobody can log in to a headless window)')
    ap.add_argument('--extra', action='store_true', help='also capture extra-results.png and extra-diagnostics.png (not part of the store set; the dry run always takes them)')
    ap.add_argument('--profile', help='Chrome user-data-dir to use and keep, logged in (default: a temporary profile, cleared and deleted afterwards)')
    ap.add_argument('--keep-open', action='store_true', help='leave the Chrome window open until Enter is pressed')
    ap.add_argument('--chrome', help='path to chrome.exe (default: $CHROME or the usual install locations)')
    ap.add_argument('--login-timeout', type=int, default=LOGIN_TIMEOUT_MIN, metavar='MIN', help='minutes to wait for the login (default %d)' % LOGIN_TIMEOUT_MIN)
    ap.add_argument('--engine', choices=['rpc', 'ui'], default='rpc', help='engine for the live run (default rpc; only rpc has an undo). The dry run always uses ui')
    ap.add_argument('--delay-ms', type=int, default=250, help='delay between adds (the extension setting; default 250)')
    ap.add_argument('--lines', metavar='FILE', help='a text file with the input lines to type instead of the built-in sample')
    ap.add_argument('--blur-selectors', metavar='CSS', help='comma-separated CSS selectors to blur in addition to the built-in list')
    ap.add_argument('--blur-text', action='append', metavar='TEXT', help='blur every element whose text contains TEXT (repeatable; never printed)')
    ap.add_argument('--no-blur', action='store_true', help='blur nothing (not for shots you intend to upload)')
    ap.add_argument('--check-store', action='store_true', help='no Chrome: check that <out> (default store-assets/) holds exactly the five live store shots '
                                                              'of a completed run and nothing else, then exit 0 (ready) or 1')
    o = ap.parse_args(argv)
    if o.check_store:
        return o
    if o.headless and not o.dry_run:
        print('--headless implies --dry-run (a human cannot log in to a headless window)')
        o.dry_run = True
    if o.dry_run and o.engine != 'ui':
        o.engine = 'ui'
    o.lines_text = None
    if o.lines:
        with open(o.lines, encoding='utf-8') as fh:
            o.lines_text = fh.read().strip()
        if not o.lines_text:
            ap.error('--lines file is empty')
    if o.login_timeout <= 0:
        ap.error('--login-timeout must be positive')
    # A --profile keeps a logged-in session (a credential) and live PNGs show a diary: neither may land somewhere
    # `git add -A` would pick up. Live PNGs go only to the git-ignored store-assets/ (or outside the repository).
    if o.profile and inside(o.profile, ROOT):
        ap.error('--profile must be outside the repository (%s): a Chrome profile holds the Cronometer login' % ROOT)
    if not o.dry_run and inside(o.out, ROOT) and os.path.normcase(os.path.abspath(o.out)) != os.path.normcase(os.path.join(ROOT, 'store-assets')):
        ap.error('--out for a live run must be store-assets/ (git-ignored PNGs) or a folder outside the repository')
    return o


def main(argv):
    # the panel's status lines carry em dashes and ticks; a cp1252/cp437 console must not turn them into a crash
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except (AttributeError, ValueError):
            pass
    o = parse_args(argv)
    if o.check_store:
        ok, lines = check_store(os.path.abspath(o.out))
        for line in lines:
            print(line)
        return EXIT_OK if ok else EXIT_FAIL
    if not o.dry_run:
        old = old_pictures(o.out)
        if old:
            print('ENVIRONMENT: %s already holds %s. Pictures of an earlier run may show a real diary and share names with the new set: '
                  'look at them, delete them by hand and run again (nothing was started).' % (os.path.abspath(o.out), ', '.join(old)))
            return EXIT_ENV
    shooter = Shooter(o)
    status = EXIT_OK
    interrupted = False
    try:
        shooter.launch()
        if o.dry_run:
            log('DRY RUN: the mock diary, the UI engine, output under %s' % shooter.out_dir)
            shooter.run_dry()
        else:
            log('LIVE: %s, engine %s, output under %s' % (LIVE_URL, o.engine, shooter.out_dir))
            shooter.run_live()
    except KeyboardInterrupt:
        interrupted = True
        status = EXIT_LOGIN
        print()
        log('interrupted (Ctrl+C): closing Chrome')
    except LoginTimeout as e:
        status = EXIT_LOGIN
        log('LOGIN TIMEOUT: %s' % e)
    except EnvError as e:
        status = EXIT_ENV
        log('ENVIRONMENT: %s' % e)
    except StepError as e:
        status = EXIT_FAIL
        log('FAILED: %s' % e)
    finally:
        if shooter.shots:
            try:
                shooter.write_manifest()
            except OSError as e:
                shooter.problems.append('manifest.json could not be written: %s' % e)
        shooter.shutdown(interrupted=interrupted)
    day = shooter.shot_day or 'the day shown'
    if shooter.undone in ('pending', 'attempted'):
        print()
        print('  !!! WARNING: entries were added to the diary on %s and NOT undone - remove them by hand in the Cronometer diary' % day)
        print('  !!! (%s)' % ('the undo never started' if shooter.undone == 'pending' else 'the undo started but its outcome is unknown'))
        print()
    elif isinstance(shooter.undone, str) and shooter.undo_complete is False:
        print()
        print('  !!! WARNING: the undo did not remove everything - check the Cronometer diary on %s and remove leftover entries by hand' % day)
        print('  !!! (%s)' % shooter.undone)
        print()
    if status == EXIT_OK:
        print()
        if not shooter.verify():
            status = EXIT_FAIL
        for p in shooter.problems:
            print('FAIL  ' + p)
            status = EXIT_FAIL
        if shooter.undo_complete:
            print('ok    undo: %s' % shooter.undone)
        print()
        print(('SCREENSHOTS PASS (%s)' if status == EXIT_OK else 'SCREENSHOTS FAIL (%s)') % ('dry run: ' + shooter.out_dir if o.dry_run else shooter.out_dir))
    else:
        for p in shooter.problems:
            print('FAIL  ' + p)
        print()
        print('SCREENSHOTS FAIL (exit %d)' % status)
    return status


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
