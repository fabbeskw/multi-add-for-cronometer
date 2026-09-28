#!/usr/bin/env python3
"""screenshots.py - the five Chrome Web Store screenshots (1280x800 PNG) of the REAL extension over the REAL
Cronometer diary, driven through the Chrome DevTools Protocol, with the human doing the login (Python 3, stdlib).

    python tools/screenshots.py [--out DIR] [--dry-run] [--headless] [--profile DIR] [--keep-open]
                                [--chrome PATH] [--login-timeout MIN] [--engine rpc|ui] [--delay-ms N]
                                [--lines FILE] [--blur-selectors "sel, sel"] [--blur-text TEXT ...] [--no-blur]

What it does (live mode, the default):
  1. starts a VISIBLE Chrome on a throw-away profile (or --profile DIR) through --remote-debugging-pipe, sizes the
     window so the page viewport is 1280x800 and additionally pins the viewport with
     Emulation.setDeviceMetricsOverride(1280x800, dpr 1), so every capture is exactly 1280x800 whatever the window;
  2. installs the extension from this repository with the DevTools command Extensions.loadUnpacked (Google Chrome
     137+ ignores --load-extension; see tools/smoke_extension.py) BEFORE the diary is opened, so the MAIN-world hook
     is present when the app starts; then opens https://cronometer.com/#diary;
  3. waits (up to --login-timeout minutes, default 15) for the human to log in: the document must hold the app's
     <iframe id="cronometer">, the diary toolbar FOOD button (button.button-panel-btn[title="Log a serving to your
     diary"]) and the extension's panel host (#cma-multi-add-host). It never touches the login form; if the app
     landed on another view it only sets location.hash = '#diary';
  4. drives the extension through its OWN isolated world (Runtime.evaluate with the contextId of the
     Runtime.executionContextCreated context whose origin is chrome-extension://<id> and whose auxData.isDefault
     is false) by clicking the panel's real buttons: types the sample list into the Input view (shot 01), presses
     Find foods (shot 02, the preview table), presses Add all with the RPC engine (shot 03, the results with the
     Undo button), closes the panel and scrolls the Dinner group into view (shot 04, the diary with the new
     entries), opens Diagnostics (shot 05), then presses Undo this batch and waits for its outcome so the account is
     left as it was;
  5. before every capture blurs personal UI with CSS injected into the MAIN world (filter: blur(9px)): the selectors
     in DEFAULT_BLUR_SELECTORS (authored class names of the compiled app, see the comment there), any element whose
     text carries the account's first name or e-mail address (read from the app's own User object, never printed),
     --blur-selectors / --blur-text additions, and the numeric account id inside the Diagnostics dump; the diary
     entries themselves are never blurred (--no-blur switches all of it off);
  6. writes <out>/01-input.png ... 05-diagnostics.png (Page.captureScreenshot, png, clip 0,0,1280,800,
     captureBeyondViewport false) and <out>/manifest.json ([{file, shot, capturedAt, blurred:[...]}, ...]), then
     verifies every PNG (IHDR 1280x800, decoded rows not blank) and prints PASS or FAIL.

--dry-run: everything except Cronometer. Opens tests/mock-cronometer.html (the fake diary + Add Food dialog used by
tests/engine-ui.html). The extension does not inject on file: pages, so the tool creates an isolated world named
after the extension (Page.createIsolatedWorld on the main frame), evaluates the ISOLATED-world scripts of
manifest.json into it in manifest order and mounts the panel by hand; the extension world is then found by name
exactly as in the live run. The scenario runs with the UI automation engine against the mock (the mock has no RPC,
and the UI engine has no undo, so the undo step is replaced by a check of the mock's window.__added). A synthetic
account label (name + e-mail spans, a text input holding the e-mail, a password input and a current-password field
holding the name, which must NOT be marked) is added to the mock page and a synthetic account id to the capture
state, so the text blur and the Diagnostics id blur run too; verify() fails unless the dry-run manifest lists them.
The PNGs go to <out>/dry-run/. --headless implies --dry-run (nobody can log in to a headless window). The dry run is
part of the green bar: `python tools/screenshots.py --dry-run --headless`. It does not exercise the undo (the RPC
engine), the real login wait or js_account_texts() against the app's User object.

Robustness: every wait has a timeout and names what it waited for; Ctrl+C closes Chrome (unless --keep-open, which
keeps the window until Enter is pressed - Chrome exits when the DevTools pipe closes, so the script has to stay
alive for that); no credential is ever typed. The undo is armed the moment Add all is pressed (RPC engine), so a
failure, a timeout or Ctrl+C anywhere after that still triggers it: it waits (bounded) for the batch to finish, then
presses Undo this batch (fallback: the Input view's Undo last batch, then CMA.panel.undo(CMA.engineRpc.lastBatch));
on Ctrl+C exactly one bounded undo attempt is made before the script exits, and a warning is printed whenever
entries may remain. The temporary profile is deleted unless --profile was given; before Chrome closes, its
cronometer.com storage and cookies are cleared so a profile that cannot be deleted holds no usable login (a
--profile DIR is left logged in on purpose, so treat that directory as a credential). Exit status: 0 = PASS,
1 = FAIL (scenario, capture or verification), 2 = environment (Chrome, DevTools pipe, extension install), 3 = the
login was not completed in time or the run was interrupted.

Output names (in <out>/, or <out>/dry-run/ for the dry run): 01-input.png 02-preview.png 03-results.png
04-diary.png 05-diagnostics.png manifest.json.
"""
import argparse
import base64
import collections
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
SHOTS = [('01-input.png', 'input'), ('02-preview.png', 'preview'), ('03-results.png', 'results'),
         ('04-diary.png', 'diary'), ('05-diagnostics.png', 'diagnostics')]
# The lines the assignment asks for (a header, a fraction, a size word and an @group tag: the format is visible).
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
# editor ('targets-container'). Diary entries (.diary-panel rows, .diary-group*) are deliberately absent.
DEFAULT_BLUR_SELECTORS = [
    '#navbarDropdown', '.navbar-account', '.navbar-dropdown-container',
    '#cronometer-header', '.cronometer-header',
    '.energy-summary', '.energy-summary-totals', '.energy-summary-totals-container',
    '.target-summary-container', '.nutrient-targets-container', '.macro-targets',
    '.display-water-target-bar', '.water-tracking-target-bar', '.targets-container',
]
# The ISOLATED-world scripts in manifest order (mirrors manifest.json; read from it at run time so the two never drift).
LOGIN_TIMEOUT_MIN = 15
READY_TIMEOUT_S = 120          # after the diary is visible: the capture must have seen authenticate / getDayInfo
FIND_TIMEOUT_S = 240           # 5 searches + getFood each + a possible 10 s decoder rebuild
ADD_TIMEOUT_S = 300            # 5 updateDiary + refresh (UI engine: a few seconds per row)
UNDO_TIMEOUT_S = 180
UNDO_RUN_WAIT_S = 60           # the undo first waits this long for a batch still running (Ctrl+C / timeout mid-run)
UNDO_TIMEOUT_INTERRUPTED_S = 60   # the single undo attempted after Ctrl+C is bounded tighter
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
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()) + time.strftime('%z')


def log(msg):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


# ---------------------------------------------------------------------------------------------------- JavaScript
# Snippets are IIFEs so `returnByValue` gets a plain object. Everything the extension world returns is state or
# counts; the nonce, the account name and the e-mail never travel to the console (see account_texts()).
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
JS_REFRESH_CLICK = """(() => {
  const sel = %s;
  const el = Array.from(document.querySelectorAll('.diary-panel ' + sel)).find(e => e.getClientRects().length > 0) || document.querySelector(sel);
  if (!el) return false;
  el.click();
  return true;
})()"""
JS_MOCK_STATE = "(() => ({mock: !!(window.CMA && CMA.mock), added: Array.isArray(window.__added) ? window.__added.length : -1, ready: document.readyState}))()"
JS_MOCK_ADDED = "(() => (window.__added || []).map(a => a.name + ' ' + a.quantity + ' ' + a.measure + ' -> ' + a.group))()"


def js_setup(engine, delay_ms):
    """Mount, load the stored settings first (mount() reads them asynchronously: saving before that read
    settles would be overwritten by it), save ours, open the Input view."""
    return """(async () => {
  CMA.panel.mount();
  await CMA.panel.loadSettings();
  await CMA.panel.saveSettings({engine: %s, delayMs: %d});
  CMA.panel.open('input');
  return CMA.panel.getState().view;
})()""" % (js(engine), int(delay_ms))


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
    for (const k of Object.keys(u)) { const v = u[k]; if (isEmail(v) && !out.includes(v.trim())) out.push(v.trim()); }
    return {ok: true, texts: out};
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
        # the Developer Dashboard takes JPEG or 24-bit PNG without an alpha channel; Chrome 150 writes RGB (type 2)
        return False, 'has an alpha channel (colour type %d): the store wants 24-bit PNG without alpha' % color
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
        self.blur_texts = list(opts.blur_text or [])
        self.selectors = [] if opts.no_blur else DEFAULT_BLUR_SELECTORS + [s.strip() for s in (opts.blur_selectors or '').split(',') if s.strip()]
        self.user_id = None
        self.shots = []                    # manifest entries
        self.added_names = []
        self.undone = None                 # None = nothing to undo; 'pending' = armed at Add all (RPC engine);
                                           # 'attempted' = undo started, outcome unknown; any other text = outcome
        self.problems = []
        with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as fh:
            self.manifest = json.load(fh)
        self.ext_name = self.manifest.get('name')
        self.out_dir = os.path.join(opts.out, 'dry-run') if self.dry else opts.out

    # ------------------------------------------------------------------ chrome
    def launch(self):
        chrome = find_chrome(self.o.chrome)
        if not chrome:
            raise EnvError('Chrome not found; pass --chrome PATH or set CHROME')
        os.makedirs(self.out_dir, exist_ok=True)
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
        log('Chrome %s (%s), profile %s%s' % (v['result'].get('product'), 'headless' if headless else 'visible window',
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

    # ------------------------------------------------------------------ capture + blur
    def apply_blur(self, extra_selectors=None):
        """Inject the MAIN-world blur; returns the manifest's `blurred` list for this capture."""
        if self.o.no_blur:
            return []
        selectors = self.selectors + list(extra_selectors or [])
        r = self.eval_main(js_blur(selectors, self.blur_texts), soft=True) or {}
        blurred = [s for s, n in (r.get('matched') or {}).items() if n and n > 0]
        if r.get('textHits'):
            blurred.append('[%s] (account name / e-mail text: %d element(s))' % (BLUR_ATTR, r['textHits']))
        return blurred

    def capture(self, name, shot, extra_blur=None):
        blurred = self.apply_blur()
        if extra_blur:
            blurred += extra_blur
        time.sleep(0.5)                                   # let the blur filters and the last render settle
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
        self.shots.append({'file': name, 'shot': shot, 'capturedAt': now_iso(), 'blurred': blurred, 'mode': 'dry-run' if self.dry else 'live', 'size': [WIDTH, HEIGHT]})
        log('captured %s (%s)%s' % (name, shot, ' - blurred: ' + ', '.join(blurred) if blurred else ' - nothing to blur'))
        return path

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
        """The RPC engine needs the session the hook captured from the app's own start-up traffic."""
        if self.o.engine != 'rpc':
            return
        st = self.wait('extension session capture (CMA.capture.ready)', lambda: self.eval_ext(JS_READY, soft=True), lambda s: s.get('ok'), READY_TIMEOUT_S, 1.0)
        self.user_id = self.eval_ext(JS_USER_ID, soft=True)
        log('capture ready: groups %s (from %s), account id %s' % (st.get('groups'), st.get('groupsSource'), 'known (blurred in the shots)' if self.user_id else 'unknown'))
        if st.get('mismatch'):
            log('note: the live build differs from the shipped decoder; the extension rebuilds it (the RPC engine waits for that)')

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
        # 1. Input view -------------------------------------------------------------------------------
        log('step 1/5: Input view')
        view = self.eval_ext(js_setup(engine, self.o.delay_ms), await_promise=True)
        if view != 'input':
            raise StepError('panel did not open the Input view (view=%r)' % view)
        time.sleep(0.4)
        r = self.eval_ext(js_type(lines, 'Dinner'))
        if not r or not r.get('ok'):
            raise StepError('typing failed: %s' % json.dumps(r))
        if r.get('group') != 'Dinner':
            log('warning: no "Dinner" group in the select (options: %s)' % r.get('options'))
        st = self.wait('Find foods enabled', lambda: self.eval_ext(JS_INPUT_STATE, soft=True), lambda s: s.get('find') and not s.get('findDisabled'), 60, 0.5)
        log('input typed (%d chars), engine %s, group %s%s' % (st.get('input', 0), st.get('engine'), r.get('group'), (', banner: ' + st['banner']) if st.get('banner') else ''))
        self.capture('01-input.png', 'input')

        # 2. Preview ----------------------------------------------------------------------------------
        log('step 2/5: Find foods -> Preview')
        c = self.eval_ext(js_click('Find foods'))
        if not c or not c.get('clicked'):
            raise StepError('could not press Find foods: %s' % json.dumps(c))
        st = self.wait('preview table after Find foods', lambda: self.eval_ext(JS_PREVIEW_STATE, soft=True),
                       lambda s: s.get('hasPlan') and not s.get('building') and s.get('rows', 0) > 0, FIND_TIMEOUT_S, 1.0)
        if st.get('notice') and st['notice'].startswith('Search failed'):
            raise StepError('Find foods failed: %s' % st['notice'])
        log('preview: %d row(s) - %s' % (st.get('rows', 0), st.get('status')))
        self.capture('02-preview.png', 'preview')
        if st.get('addDisabled'):
            raise StepError('Add all is disabled (%s): nothing can be added, so the results / diary shots are impossible' % (st.get('addTitle') or 'no ready rows'))

        # 3. Results ----------------------------------------------------------------------------------
        log('step 3/5: Add all -> Results')
        c = self.eval_ext(js_click('Add all'))
        if not c or not c.get('clicked'):
            raise StepError('could not press Add all: %s' % json.dumps(c))
        if engine == 'rpc':
            # armed before the results wait: a timeout, a failure or Ctrl+C from here on still runs the undo
            self.undone = 'pending'
        st = self.wait('results after Add all', lambda: self.eval_ext(JS_RESULTS_STATE, soft=True),
                       lambda s: s.get('hasResult') and not s.get('running'), ADD_TIMEOUT_S, 1.0)
        self.added_names = self.eval_ext(JS_ADDED_NAMES, soft=True) or []
        log('results: %d added, %d failed, %d skipped - %s' % (st.get('added', 0), st.get('failed', 0), st.get('skipped', 0), st.get('status')))
        if st.get('notice'):
            log('panel notice: %s' % st['notice'])
        if not st.get('added'):
            self.problems.append('no row was added (first error: %s)' % (st.get('firstError') or 'none'))
        elif engine == 'rpc' and not st.get('undo'):
            self.problems.append('the Results view offers no Undo button although rows were added')
        time.sleep(0.6)
        self.capture('03-results.png', 'results')

        # 4. Diary ------------------------------------------------------------------------------------
        log('step 4/5: diary with the new entries')
        self.eval_ext("(() => { CMA.panel.close(); return true; })()")
        self.ensure_entries_visible()
        sc = self.eval_main(JS_SCROLL_GROUP % js('Dinner'), soft=True) or {}
        log('scrolled %s into view' % ('the "%s" group' % sc.get('title') if sc.get('found') else 'nothing (no .diary-group-title found)'))
        time.sleep(0.8)
        self.capture('04-diary.png', 'diary')

        # 5. Diagnostics ------------------------------------------------------------------------------
        log('step 5/5: Diagnostics view')
        self.eval_ext("(() => { CMA.panel.open('diagnostics'); return CMA.panel.getState().view; })()")
        time.sleep(0.5)
        extra = []
        if not self.o.no_blur:
            uid = self.user_id or self.eval_ext(JS_USER_ID, soft=True)
            if uid:
                b = self.eval_ext(js_blur_pre([uid]), soft=True) or {}
                if b.get('blurred'):
                    extra.append('diagnostics: account id (%d occurrence(s))' % b['blurred'])
                log('diagnostics: account id blurred in %d place(s)' % b.get('blurred', 0))
        self.capture('05-diagnostics.png', 'diagnostics', extra_blur=extra)

    def ensure_entries_visible(self):
        """After the RPC batch the app only re-reads the day when the engine's date-arrow clicks were seen; make
        sure the names are on screen before the diary shot (a second arrow round trip if they are not)."""
        names = self.added_names
        if not names:
            return
        get = lambda: self.eval_main(JS_DIARY_HAS % js(names), soft=True)  # noqa: E731
        try:
            st = self.wait('new entries in the diary', get, lambda s: s.get('visible', 0) >= len(names), 12, 1.0)
        except StepError:
            st = get() or {}
            log('only %d of %d added entries are visible: refreshing the diary through its date arrows' % (st.get('visible', 0), len(names)))
            if self.eval_main(JS_REFRESH_CLICK % js('.diary-date-previous'), soft=True):
                time.sleep(1.5)
                self.eval_main(JS_REFRESH_CLICK % js('.diary-date-next'), soft=True)
                time.sleep(1.5)
            try:
                st = self.wait('new entries in the diary (after refresh)', get, lambda s: s.get('visible', 0) >= len(names), 15, 1.0)
            except StepError:
                st = get() or {}
                self.problems.append('only %d of %d added entries are visible in the diary shot' % (st.get('visible', 0), len(names)))
        log('diary shows %d of %d added entries' % (st.get('visible', 0), len(names)))

    def undo(self, interrupted=False):
        """Undo the batch this run added (RPC engine). First waits (bounded) for a batch that is still running - a
        timeout or Ctrl+C can land between Add all and the Results view - then presses Undo this batch; when the
        Results view offers none (it never rendered), the Input view's Undo last batch, then the panel's own
        undo() on CMA.engineRpc.lastBatch. Waits for the panel's outcome line and prints it."""
        if self.undone != 'pending':
            return
        log('undo: removing the entries this run added%s' % (' (one bounded attempt after Ctrl+C)' if interrupted else ''))
        self.undone = 'attempted'
        st = self.wait('the Add all batch to stop running before the undo', lambda: self.eval_ext(JS_RESULTS_STATE, soft=True),
                       lambda s: not s.get('running'), UNDO_RUN_WAIT_S, 1.0)
        if not self.added_names:
            self.added_names = self.eval_ext(JS_ADDED_NAMES, soft=True) or []
        if st.get('hasResult') and not st.get('added') and not st.get('lastBatch') and not st.get('engineBatch'):
            self.undone = 'nothing to undo (the batch added no entry)'
            log('undo: %s' % self.undone)
            return
        self.eval_ext("(() => { CMA.panel.open('results'); return CMA.panel.getState().view; })()", soft=True)
        time.sleep(0.4)
        c = self.eval_ext(js_click('Undo this batch'), soft=True)
        c2 = c3 = None
        if not c or not c.get('clicked'):
            self.eval_ext("(() => { CMA.panel.open('input'); return true; })()", soft=True)
            time.sleep(0.4)
            c2 = self.eval_ext(js_click('Undo last batch'), soft=True)
            if not c2 or not c2.get('clicked'):
                c3 = self.eval_ext(JS_UNDO_ENGINE_BATCH, soft=True)
                if not c3 or not c3.get('clicked'):
                    raise StepError('no undo could be started (%s / %s / %s): remove the entries by hand' % (json.dumps(c), json.dumps(c2), json.dumps(c3)))
        log('undo started: %s' % next(x for x in (c, c2, c3) if x and x.get('clicked')).get('text'))
        st = self.wait('undo outcome', lambda: self.eval_ext(JS_UNDO_STATE, soft=True), lambda s: s.get('done'),
                       UNDO_TIMEOUT_INTERRUPTED_S if interrupted else UNDO_TIMEOUT_S, 1.0)
        outcome = st.get('status') if (st.get('status') or '').startswith('Undo') else st.get('notice')
        self.undone = outcome or 'attempted'    # an empty outcome is unknown: keep the end-of-run warning
        log('undo outcome: %s (ids still stored for undo: %d)' % (outcome, st.get('remaining', 0)))
        if self.undone.startswith('Undo failed'):
            self.problems.append('undo failed: %s' % self.undone)
        if st.get('remaining'):
            self.problems.append('undo left %d entry id(s) in the stored batch: %s' % (st['remaining'], outcome))
        # a look at the diary after the engine's refresh: the names should be gone
        names = self.added_names
        if names and not interrupted:
            time.sleep(3)
            d = self.eval_main(JS_DIARY_HAS % js(names), soft=True) or {}
            log('diary now shows %d of the %d added entries%s' % (d.get('visible', 0), len(names), ' (reload the page to be sure)' if d.get('visible') else ''))

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
            else:
                log('account name not readable from the app (%s): pass --blur-text if it appears on screen' % t.get('why'))
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
                    log('UNDO FAILED: %s - remove the added entries by hand' % e)
        if self.added_names and self.o.engine != 'rpc':
            self.problems.append('the UI engine has no undo: %d entries remain in the diary (remove them by hand)' % len(self.added_names))

    def run_dry(self):
        url = 'file:///' + MOCK_PAGE.replace('\\', '/')
        self.navigate(url)
        st = self.wait('mock page', lambda: self.eval_main(JS_MOCK_STATE, soft=True), lambda s: s.get('mock') and s.get('ready') == 'complete', 30, 0.5)
        log('mock diary loaded (%s)' % url)
        self.inject_extension()
        self.dry_account()
        lines = self.o.lines_text or DRY_LINES
        self.scenario(lines, 'ui')
        added = self.eval_main(JS_MOCK_ADDED, soft=True) or []
        expected = len([l for l in lines.splitlines() if l.strip() and not l.strip().startswith('#') and not l.strip().startswith('//')])
        log('mock recorded %d add(s): %s' % (len(added), '; '.join(added)))
        if len(added) != expected:
            self.problems.append('the mock recorded %d adds, expected %d' % (len(added), expected))

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

    def check_dry_blur(self):
        """(ok, [messages]): the dry-run manifest.json lists the blur entries the synthetic account must produce."""
        if self.o.no_blur:
            return True, ['dry-run blur check skipped (--no-blur)']
        path = os.path.join(self.out_dir, 'manifest.json')
        try:
            with open(path, encoding='utf-8') as fh:
                entries = {e.get('file'): e for e in json.load(fh)}
        except (OSError, ValueError) as e:
            return False, ['dry-run manifest.json unreadable: %s' % e]
        want_text = '[%s] (account name / e-mail text: %d element(s))' % (BLUR_ATTR, DRY_TEXT_HITS)
        ok, msgs = True, []
        for name, _shot in SHOTS:
            blurred = (entries.get(name) or {}).get('blurred') or []
            if want_text not in blurred:
                ok = False
                msgs.append('%s: manifest lacks %r (has %s)' % (name, want_text, blurred))
        diag = (entries.get('05-diagnostics.png') or {}).get('blurred') or []
        if not any(b.startswith('diagnostics: account id (') for b in diag):
            ok = False
            msgs.append('05-diagnostics.png: manifest lacks the "diagnostics: account id" entry (has %s)' % diag)
        if ok:
            msgs.append('dry-run manifest lists the text blur (%d elements, password fields untouched) in all %d shots and the account id in 05' % (DRY_TEXT_HITS, len(SHOTS)))
        return ok, msgs

    def write_manifest(self):
        path = os.path.join(self.out_dir, 'manifest.json')
        # newline='\n': the file is committed next to the PNGs and every text file in the repository is LF (text
        # mode on Windows would write CRLF); json.dump writes no final newline, so add the one editors expect.
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(self.shots, fh, indent=2)
            fh.write('\n')
        log('wrote %s' % path)

    def verify(self):
        ok_all = True
        for name, _shot in SHOTS:
            path = os.path.join(self.out_dir, name)
            if not os.path.isfile(path):
                print('FAIL  %s: missing' % name)
                ok_all = False
                continue
            ok, detail = png_verify(path)
            print('%s  %s: %s' % ('ok  ' if ok else 'FAIL', name, detail))
            ok_all = ok_all and ok
        if self.dry:
            ok, msgs = self.check_dry_blur()
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


def parse_args(argv):
    ap = argparse.ArgumentParser(description='Chrome Web Store screenshots of Multi-Add for Cronometer over the real diary.',
                                 epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'store-assets'), help='output directory (default: store-assets/; the dry run writes to <out>/dry-run/)')
    ap.add_argument('--dry-run', action='store_true', help='use tests/mock-cronometer.html and the UI engine instead of cronometer.com')
    ap.add_argument('--headless', action='store_true', help='headless Chrome (implies --dry-run: nobody can log in to a headless window)')
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
    o = ap.parse_args(argv)
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
    return o


def main(argv):
    # the panel's status lines carry em dashes and ticks; a cp1252/cp437 console must not turn them into a crash
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except (AttributeError, ValueError):
            pass
    o = parse_args(argv)
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
    if shooter.undone in ('pending', 'attempted'):
        print()
        print('  !!! WARNING: entries were added and NOT undone - remove them by hand in the Cronometer diary')
        print('  !!! (%s)' % ('the undo never started' if shooter.undone == 'pending' else 'the undo started but its outcome is unknown'))
        print()
    elif isinstance(shooter.undone, str) and shooter.undone.startswith('Undo failed'):
        print()
        print('  !!! WARNING: the undo reported a failure - check the Cronometer diary and remove leftover entries by hand')
        print('  !!! (%s)' % shooter.undone)
        print()
    if status == EXIT_OK:
        print()
        if not shooter.verify():
            status = EXIT_FAIL
        for p in shooter.problems:
            print('FAIL  ' + p)
            status = EXIT_FAIL
        if shooter.undone and shooter.undone not in ('pending', 'attempted'):
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
