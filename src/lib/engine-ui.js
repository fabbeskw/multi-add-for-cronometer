/* CMA.engineUi — executes an add-plan by driving Cronometer's "Add Food to Diary" dialog (SPEC §7).
 *
 * This is the fallback engine: it never talks to the network itself, it only clicks/types in the TOP document
 * exactly like a user would. Every selector below is an authored CSS class / id / label string from
 * research/ui-automation-dialog-recipe.md (obfuscated GWT identifiers rotate per deploy and are never used).
 *
 *   CMA.engineUi.run(plan, opts, progressCb) → Promise<{added:[{row, warnings:[...]}], failed:[{row, error}], cancelled, abortReason}>
 *   `warnings` lists every silent fallback the row went through (group kept / groups disabled / measure
 *   converted or kept / ambiguous result row / meal defaults); the row's outcome line is then
 *   'added (…)' at level 'warn' so the panel shows it next to the tick instead of a plain 'added'.
 *
 *   plan  : array of rows, or {rows:[...]} (SPEC §6 row shape):
 *           row.hit.name (fallback row.item.name)   → search query + result-row match (row.hit.source disambiguates)
 *           row.pick.measure {name, grams, amount, ml, type} → measure dropdown item (label grammar below)
 *           row.pick.quantity / row.pick.grams        → amount box (grams keep the total right when the
 *                                                       requested measure is not offered and row.measures is known)
 *           row.groupId                             → resolved to a name via opts.groups [{id,name,enabled}]
 *   opts  : { groups, delayMs=250, refreshMs=1200, waitForRefresh(row)→Promise|null, doc=document, win,
 *             timeouts:{open:5000, search:15000, load:8000, close:3000}, settleMs=200, hashSettleMs=500 }
 *   progressCb({row, index, step, message, level}) is called for every diagnostic line (never contains secrets;
 *   this engine has no access to the session nonce at all).
 * The bundle facts every selector and event below relies on are listed right after the namespace guard.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  /* Facts this file relies on (all verbatim in the compiled bundle, quoted in the recipe / review round 1):
   *  - Row selection: PrettyTable `ADf` only selects when `jDf` → `Wpd` finds a TD under event.target whose
   *    parent TR sits in the table body; a mousedown targeted at the <tr> itself walks straight to the tbody
   *    and returns null. So the engine presses the FIRST CELL. `nDf`/`hDf` (Enter) need document.activeElement
   *    to be the TR.
   *  - Measure selector root: the FoodSummaryPanel ctor runs `KBe(this.C)` whose `ug(a.b,'row-container mb-0')`
   *    REPLACES the inner row's className (dCe had given it 'measure-selector'); only the widget root gets
   *    'add-serving-measure-selector' (`xke`). The amount box is `div.amount > … input.text-box` (`ug(this.g,'text-box')`
   *    replaces gwt-TextBox), the measure dropdown root is `.selection-dropdown`.
   *  - Disabled state: `$pc(widget,false)` puts 'disabled-input' + aria-disabled on the widget ROOT (div.amount,
   *    .selection-dropdown, the DiaryGroupDropdown root), not on the input/button inside it.
   *  - Measure item labels (`QBe` → `qqj`/`pqj`): `[amount ]name[  — Ng | — N ml]`: an amount prefix when
   *    Measure.a != 1 (`rqj`: 1/3 1/4 1/5 2/3 1/2, integers, else #.00), a gram suffix for every Weight measure
   *    except the plain 1 g 'g' (and for Recipe measures of recipes), an ml suffix for Volume measures with an
   *    ml value (except the plain 1 ml 'ml'); grams are shown with 1 decimal below 2 g else as an integer (`tqj`),
   *    ml likewise (`uqj`).
   *  - Result rows (`Mqe`): cell 0 = food name, cell 1 = source label (FoodSource enum name such as USDA/NCCDB,
   *    or 'Custom Food' / 'Custom Recipe' / 'Custom Meal' for the Custom source, 'UPC' / 'FDC UPC').
   *  - Add: `oke` hides the dialog (`km`) BEFORE the Serving is built and `updateDiary` is sent, so dialog
   *    detachment says nothing about success; the panel's refresh signal (updateDiary //OK, not rejected) does.
   *  - Selection = toggle text: `xqc(a,b){aHb(a.j,O4n(b.b));...}` writes the clicked item's text on the toggle and
   *    `lte` → `RBe` → `rqc` re-derives the selected measure at Add time by comparing each item's label with that
   *    text (`$Gb(a.j)`); the group likewise fires ValueChange from `xqc` and `ste` parses it. So a toggle that does
   *    not show the clicked item's text means the click did NOT register and the app would use the old value.
   *  - Custom meals: `zte` hides the whole MeasureSelector (`b.B==(Qaj(),Oaj)?yg(a.C,false):yg(a.C,true)`) but still
   *    enables/populates it, and `lte` reads its hidden amount and measure — values the real UI never lets a user
   *    change, so the engine adds a meal only with the dialog's defaults.
   *  - Diary table (`Mud`): a group's header row holds the DiaryGroupHeader (`Krd`: div.diary-group > title
   *    container + collapse button) in a cell styled 'diary-group-row'; the servings are the FOLLOWING rows of the
   *    same FlexTable ('diary-time' cell etc.), never children of .diary-group.
   *  - Escape: the search FocusPanel's `$qe` (`FSk(b.a)==27&&km(a.v)`) is registered with `D$k` = 'keyup'
   *    (`Ug(this.j,new Sre(this),(E$k(),E$k(),D$k))`), and the dialog body's `Orh` (`sm`) is keyup too.
   *
   * Batch abort rules (SPEC §7): dialog title mismatch, "Enter a valid time" modal (the row is reported as failed
   * and the rest of the batch is aborted, because the cause — a partially filled Gold timestamp — would recur),
   * or the user pressing Escape twice within 1 s. A row whose food cannot be found ("no results"), whose result
   * row / measure cannot be matched, or whose add is not confirmed only fails that row: the dialog is closed
   * and the next row starts fresh.
   */
  const D = () => window.CMA.dom; // resolved lazily so load order inside the test page does not matter

  const S = {
    FOOD_BUTTON: 'button.button-panel-btn[title="Log a serving to your diary"]', // recipe §1a
    DIALOG: '.pretty-dialog',                                                     // recipe §2 (PrettyDialog root)
    DIALOG_CONTAINER: '.container',
    DIALOG_TITLE: '.titlebar-title',
    DIALOG_CLOSE: '.titlebar-cancelbox .icon-x-big',
    SEARCH_INPUT: 'input.gwt-TextBox.search-field',
    SEARCH_BUTTON: 'button.food-search-btn',
    SPINNER: '.food-search-spinner',
    RESULT_ROWS: 'table.crono-table tr',
    RESULTS_CONTAINER: '.results-container',
    FOOD_NAME: 'div.food-search-name',
    GROUP_LABEL: '#food-summary-diaryGroupLabel',
    // MeasureSelector widget root (xke: vg(a.d.C,'add-serving-measure-selector')). Everything below is
    // relative to it (or to the fallback row found by measureRoot()).
    MEASURE_SELECTOR: '.add-serving-measure-selector',
    AMOUNT_INPUT: '.amount input.text-box',
    MEASURE_ITEMS: '.selection-dropdown a.dropdown-item',
    MEASURE_TOGGLE: '.selection-dropdown button.dropdown-btn',
    ADD_BUTTON: 'div.add-to-diary-btn-container button',
    DIARY_GROUP: '.diary-group',
    DIARY_GROUP_ROW: 'td.diary-group-row',
    DIARY_GROUP_TITLE: '.diary-group-title',
  };
  const T = {
    DIALOG_TITLE: 'Add Food to Diary',           // recipe §2: g.q='Add Food to Diary'
    FAST_PROMPT: 'Adding a Food?',               // recipe §1d
    FAST_CONTINUE: 'Continue Fast',
    INVALID_TIME: 'Enter a valid time',          // recipe §7: Message modal aborts the add
    NO_FOOD: 'no food selected',
    LOADING: 'loading...',
    ERROR_PREFIX: 'ERROR',
    DISABLED_ITEM: 'Disabled',                   // recipe §6: single item when DG_ON is false
  };

  class AbortError extends Error {
    constructor(message) { super(message); this.name = 'AbortError'; this.aborted = true; }
  }

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function rowName(row) {
    if (!row) return '';
    if (row.hit && row.hit.name) return String(row.hit.name);
    if (row.item && row.item.name) return String(row.item.name);
    return '';
  }
  function rowMeasure(row) { return row && row.pick && row.pick.measure ? row.pick.measure : null; }
  function rowMeasureName(row) {
    const m = rowMeasure(row);
    return m && m.name != null ? String(m.name) : '';
  }
  function rowQuantity(row) {
    const q = row && row.pick && row.pick.quantity;
    return q == null ? 1 : Number(q);
  }
  function groupNameFor(row, groups) {
    if (!row || row.groupId == null || !Array.isArray(groups)) return null;
    const g = groups.find((x) => x && Number(x.id) === Number(row.groupId));
    return g ? String(g.name) : null;
  }
  function isRecipeLike(m) {
    if (!m) return false;
    const t = m.type == null ? null : (typeof m.type === 'object' && typeof m.type.ordinal === 'number' ? ['Weight', 'Volume', 'Atomic', 'Recipe'][m.type.ordinal] : String(m.type));
    if (t === 'Recipe' || t === '3') return true;
    return norm(m.name).toLowerCase() === 'full recipe' && !(Number(m.grams) > 0);
  }

  /**
   * Format a quantity for the amount box (maxLength 6, recipe §5): up to 3 decimals, trailing zeros stripped,
   * decimals reduced until the text fits in 6 characters.
   */
  function formatQuantity(q) {
    const n = Number(q);
    if (!Number.isFinite(n)) throw new Error('invalid quantity: ' + q);
    const strip = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
    let s = strip(n.toFixed(3));
    for (let d = 2; s.length > 6 && d >= 0; d--) s = strip(n.toFixed(d));
    if (s.length > 6) s = s.slice(0, 6);
    return s;
  }

  // --- measure label grammar (QBe → qqj / pqj / rqj / tqj / uqj) ---------------------------------------
  /** `tqj(a, b)`: one decimal when the measure's grams-per-unit is below 2, else an integer. */
  function formatLabelGrams(value, gramsPerUnit) {
    return gramsPerUnit < 2 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  }
  /** `uqj(a)`: one decimal below 2 ml, else an integer. */
  function formatLabelMl(ml) {
    return ml < 2 ? String(Math.round(ml * 10) / 10) : String(Math.round(ml));
  }
  /** `rqj(a)`: the amount shown before the name when Measure.a != 1. */
  function formatLabelAmount(a) {
    if (Math.abs(a - 1 / 3) < 1e-6) return '1/3';
    if (a === 0.25) return '1/4';
    if (a === 0.2) return '1/5';
    if (Math.abs(a - 2 / 3) < 1e-6) return '2/3';
    if (a === 0.5) return '1/2';
    if (Number.isInteger(a)) return String(a);
    return a.toFixed(2);
  }
  /** The label the dialog renders for a measure {name, amount, grams, ml, type} (recipeFood: Recipe measures get grams too). */
  function measureLabel(m, recipeFood) {
    if (!m) return '';
    const name = norm(m.name);
    const amount = m.amount > 0 ? Number(m.amount) : 1;
    const grams = Number(m.grams) || 0;
    const ml = m.ml == null ? null : Number(m.ml);
    const type = m.type == null ? null : (typeof m.type === 'object' && typeof m.type.ordinal === 'number' ? ['Weight', 'Volume', 'Atomic', 'Recipe'][m.type.ordinal] : String(m.type));
    let label = amount !== 1 ? formatLabelAmount(amount) + ' ' + name : name;
    const plainGram = amount === 1 && grams === 1 && name === 'g';
    if ((type === 'Weight' && !plainGram) || (type === 'Recipe' && recipeFood && !(amount === 1 && name === 'g'))) {
      return label + '  — ' + formatLabelGrams(grams, grams) + 'g';
    }
    const plainMl = amount === 1 && name === 'ml' && ml != null && Math.abs(ml - 1) < 1e-6;
    if (type === 'Volume' && ml != null && !plainMl) return label + '  — ' + formatLabelMl(ml) + ' ml';
    return label;
  }
  const LABEL_RE = /^(?:(\d+(?:\.\d+)?|\d+\/\d+)\s+)?(.*?)(?:\s+[—–-]\s+(\d+(?:\.\d+)?)\s*(g|ml))?$/i;
  function fractionToNumber(s) {
    const m = /^(\d+)\/(\d+)$/.exec(s);
    if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
    return Number(s);
  }
  /** Parse a rendered measure label (or a hit's '1 breast - 172g') into {amount, name, num, unit, text}. */
  function parseMeasureLabel(text) {
    const t = norm(text);
    const m = LABEL_RE.exec(t);
    if (!m) return { amount: 1, name: t, num: null, unit: null, text: t };
    return {
      amount: m[1] ? fractionToNumber(m[1]) : 1,
      name: norm(m[2]),
      num: m[3] != null ? Number(m[3]) : null,
      unit: m[4] ? m[4].toLowerCase() : null,
      text: t,
    };
  }
  function nearly(a, b) { return Math.abs(Number(a) - Number(b)) < 1e-6; }
  function suffixMatches(p, want) {
    if (p.num == null) return false;
    if (p.unit === 'g' && Number(want.grams) > 0) return nearly(p.num, Number(formatLabelGrams(Number(want.grams), Number(want.grams))));
    if (p.unit === 'ml' && Number(want.ml) > 0) return nearly(p.num, Number(formatLabelMl(Number(want.ml))));
    return false;
  }
  /**
   * Find the dropdown item for measure `want` ({name, amount?, grams?, ml?}) among `items` (anchors).
   * Tiers: same name (and amount prefix) with a matching size suffix → same name → label text equals the
   * name → startsWith (logged as a warning by the caller). Returns {item, how, warn} or null.
   */
  function matchMeasureItem(items, want) {
    const dom = D();
    const wantName = norm(want && want.name).toLowerCase();
    if (!wantName) return null;
    const wantAmount = want.amount > 0 ? Number(want.amount) : 1;
    const parsed = items.map((el) => ({ el, p: parseMeasureLabel(dom.textOf(el)) }));
    const sameName = parsed.filter((x) => x.p.name.toLowerCase() === wantName || x.p.text.toLowerCase() === wantName);
    const sameAmount = sameName.filter((x) => nearly(x.p.amount, wantAmount));
    const pool = sameAmount.length ? sameAmount : sameName;
    if (pool.length) {
      const bySize = pool.find((x) => suffixMatches(x.p, want));
      if (bySize) return { item: bySize.el, how: 'name+size' };
      return { item: pool[0].el, how: pool.length > 1 ? 'name (first of ' + pool.length + ')' : 'name', warn: pool.length > 1 };
    }
    const starts = parsed.find((x) => x.p.name.toLowerCase().startsWith(wantName));
    if (starts) return { item: starts.el, how: 'startsWith', warn: true };
    return null;
  }

  // --- result-row source matching (Mqe / U9i) -------------------------------------------------------
  /** true / false / null (unknown) whether a result row's source cell agrees with the hit's source. */
  function sourceMatches(cellText, hit) {
    if (!hit || hit.source == null || hit.source === '') return null;
    const cell = norm(cellText).toLowerCase();
    const src = norm(hit.source).toLowerCase();
    if (!cell || !src) return null;
    if (cell === src) return true;
    if (src === 'custom' || src === 'user') return cell.startsWith('custom');   // 'Custom Food' / 'Custom Recipe' / 'Custom Meal'
    if (cell.startsWith('custom')) return false;
    if (src === 'fdcbranded') return cell === 'fdc upc';                          // U9i: ordinal 2 → 'FDC UPC'
    if (src === 'usdaweb') return cell === 'upc';                                 // U9i: ordinal 10 → 'UPC'
    return cell.indexOf(src) >= 0 || src.indexOf(cell) >= 0;
  }

  function dialogs(doc) { return D().qa(S.DIALOG, doc); }
  function dialogTitle(dlg) { return D().textOf(dlg.querySelector(S.DIALOG_TITLE)); }
  function addFoodDialog(doc) {
    return dialogs(doc).find((d) => dialogTitle(d) === T.DIALOG_TITLE && d.querySelector(S.SEARCH_INPUT)) || null;
  }
  function dialogWithText(doc, text) {
    return dialogs(doc).find((d) => D().textOf(d).includes(text)) || null;
  }
  /**
   * The MeasureSelector root: `.add-serving-measure-selector`, else the [role=group] row that contains the
   * amount box (in case a future deploy drops the root class but keeps the KBe row).
   */
  function measureRoot(dlg) {
    const root = dlg.querySelector(S.MEASURE_SELECTOR);
    if (root) return root;
    const inputs = D().qa('.amount input.text-box', dlg);
    for (const i of inputs) { const row = i.closest('[role="group"]'); if (row) return row; }
    return null;
  }
  /**
   * `$pc(widget,false)` sets disabled-input + aria-disabled on the widget ROOT: look at the element and its
   * ancestors up to (excluding) the dialog row it lives in.
   */
  function isDisabled(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.classList.contains('disabled-input') || n.getAttribute('aria-disabled') === 'true') return true;
      if (n.matches('[role="group"], .row-container, .food-summary-panel, .pretty-dialog')) break;
    }
    return false;
  }

  async function run(plan, opts, progressCb) {
    const dom = D();
    if (!dom) throw new Error('CMA.dom is not loaded (load src/lib/dom.js before engine-ui.js)');
    const o = Object.assign({
      groups: [], delayMs: 250, refreshMs: 1200, settleMs: 200, hashSettleMs: 500, waitForRefresh: null,
    }, opts || {});
    const doc = o.doc || document;
    const win = o.win || doc.defaultView || window;
    const timeouts = Object.assign({ open: 5000, search: 15000, load: 8000, close: 3000 }, o.timeouts || {});
    const rows = Array.isArray(plan) ? plan : (plan && Array.isArray(plan.rows) ? plan.rows : []);
    const result = { added: [], failed: [], cancelled: false, abortReason: null };

    // --- user cancel: Escape twice within 1 s (SPEC §7) ----------------------------------------------
    let cancelReason = null;
    let lastEscapeAt = 0;
    const onKey = (ev) => {
      if (ev.key !== 'Escape' && ev.keyCode !== 27) return;
      const now = Date.now();
      if (now - lastEscapeAt <= 1000) cancelReason = 'cancelled by user (Escape pressed twice)';
      lastEscapeAt = now;
    };
    doc.addEventListener('keydown', onKey, true);
    const abortCheck = () => cancelReason;

    let current = { row: null, index: -1 };
    const report = (step, message, level) => {
      if (typeof progressCb !== 'function') return;
      try { progressCb({ row: current.row, index: current.index, step, message, level: level || 'info' }); } catch (e) { /* never let a UI callback break the batch */ }
    };
    const wait = (fn, ms, label) => dom.waitFor(fn, { timeout: ms, interval: 50, label, abort: abortCheck });
    // Same, but fails the ROW immediately if the dialog vanishes (user pressed Escape once, app closed it).
    const waitIn = (dlg, fn, ms, label) => wait(() => {
      if (!dlg.isConnected) throw new Error('dialog closed unexpectedly while waiting for ' + label);
      return fn();
    }, ms, label);
    const checkCancel = () => { if (cancelReason) throw new AbortError(cancelReason); };

    // --- helpers ------------------------------------------------------------------------------------
    // Close the Add Food dialog (or, with `any`, every PrettyDialog the engine may have caused, e.g. a
    // wrongly titled one after a title-mismatch abort or the app's error dialog after a rejected add)
    // through its titlebar X, falling back to Escape.
    async function closeDialogIfOpen(reason, any) {
      const targets = any ? dialogs(doc) : [addFoodDialog(doc)].filter(Boolean);
      if (!targets.length) return;
      report('close', 'closing dialog (' + reason + '): ' + targets.map(dialogTitle).join(', '), 'warn');
      for (const dlg of targets) {
        const x = dlg.querySelector(S.DIALOG_CLOSE);
        if (x) dom.click(x);
        else {
          // No X: the app closes on KEYUP 27 in the search box (`$qe`, registered with D$k = 'keyup') and on
          // keyup 27 anywhere in the dialog body (`sm` registers `Orh` for keyup); keydown has no listener
          // on either, nor on the .pretty-dialog root.
          const search = dlg.querySelector(S.SEARCH_INPUT);
          if (search) dom.keyup(search, { key: 'Escape', keyCode: 27 });
          dom.keyup(dlg.querySelector(S.DIALOG_CONTAINER) || dlg, { key: 'Escape', keyCode: 27 });
        }
      }
      try {
        await dom.waitFor(() => targets.every((d) => !d.isConnected), { timeout: timeouts.close, interval: 50, label: 'dialog to close' });
      } catch (e) {
        throw new AbortError('could not close the dialog: ' + e.message);
      }
    }

    async function dismissModal(dlg) {
      const ok = dom.findByText('button', 'OK', { root: dlg, ci: true });
      if (ok) dom.click(ok);
      else { const x = dlg.querySelector(S.DIALOG_CLOSE); if (x) dom.click(x); }
      await dom.sleep(150);
    }

    function ensureDiaryHash() {
      let hash = '';
      try { hash = win.location.hash; } catch (e) { return false; }
      if (hash === '#diary') return false;
      report('hash', 'switching to #diary (was ' + (hash || '(none)') + ')');
      try { win.location.hash = '#diary'; } catch (e) { report('hash', 'could not set location.hash: ' + e.message, 'warn'); }
      return true;
    }

    async function openDialog() {
      // Never open a second dialog while one is showing (recipe §8/§10).
      const stale = dialogs(doc);
      if (stale.length) {
        report('open', 'waiting for an existing dialog to close: ' + stale.map(dialogTitle).join(', '), 'warn');
        try {
          await wait(() => dialogs(doc).length === 0, timeouts.close, 'previous dialog to close');
        } catch (e) {
          if (e.aborted) throw new AbortError(e.message);
          throw new AbortError('a dialog is already open ("' + stale.map(dialogTitle).join('", "') + '"); close it and retry');
        }
      }
      const btn = doc.querySelector(S.FOOD_BUTTON);
      if (!btn) throw new AbortError('FOOD toolbar button not found; open the diary page and retry');
      if (btn.disabled || btn.classList.contains('disabled')) {
        report('open', 'FOOD button is disabled; waiting', 'warn');
        await wait(() => !(btn.disabled || btn.classList.contains('disabled')), timeouts.open, 'FOOD button to enable');
      }
      report('open', 'clicking FOOD');
      dom.click(btn);

      let continued = false;
      const dlg = await wait(() => {
        const ok = addFoodDialog(doc);
        if (ok) return ok;
        const fast = dialogWithText(doc, T.FAST_PROMPT);
        if (fast) {
          if (!continued) {
            const cont = dom.findByText('button', T.FAST_CONTINUE, { root: fast, ci: true });
            if (cont) { report('open', '"' + T.FAST_PROMPT + '" prompt: clicking "' + T.FAST_CONTINUE + '"'); dom.click(cont); continued = true; }
          }
          return null;
        }
        const others = dialogs(doc).map(dialogTitle).filter((t) => t && t !== T.DIALOG_TITLE);
        if (others.length) throw new AbortError('unexpected dialog "' + others[0] + '" (expected "' + T.DIALOG_TITLE + '")');
        return null;
      }, timeouts.open, 'the "' + T.DIALOG_TITLE + '" dialog');
      await dom.sleep(o.settleMs); // slide-in + 120 ms reposition timer (recipe §9 step 4)
      return dlg;
    }

    async function search(dlg, query) {
      const input = dlg.querySelector(S.SEARCH_INPUT);
      const btn = dlg.querySelector(S.SEARCH_BUTTON);
      if (!input || !btn) throw new Error('search field or SEARCH button missing in the dialog');
      report('search', 'searching "' + query + '"');
      dom.setNativeValue(input, query);
      dom.click(btn); // immediate 250-result search, no debounce (recipe §3)

      const spinner = () => dlg.querySelector(S.SPINNER);
      const rowCount = () => dlg.querySelectorAll(S.RESULT_ROWS).length;
      const spinnerOn = () => { const s = spinner(); return !!s && dom.isVisible(s); };
      // Phase 1: the search has started (spinner visible) or already produced rows.
      try { await waitIn(dlg, () => spinnerOn() || rowCount() > 1, 2000, 'search to start'); } catch (e) { if (e.aborted || !e.timeout) throw e; /* timeout: maybe it was instant */ }
      // Phase 2: the spinner is gone.
      await waitIn(dlg, () => !spinnerOn(), timeouts.search, 'search spinner to hide');
      // Phase 3: rows, with a short grace period for the table rebuild.
      if (rowCount() <= 1) {
        try { await waitIn(dlg, () => rowCount() > 1, 400, 'result rows'); } catch (e) { if (e.aborted || !e.timeout) throw e; }
      }
      const n = rowCount();
      if (n <= 1) {
        const rc = dlg.querySelector(S.RESULTS_CONTAINER);
        const hint = rc && /no results/i.test(dom.textOf(rc)) ? '' : ' (results table empty)';
        throw new Error('no results for "' + query + '"' + hint);
      }
      report('search', (n - 1) + ' result row(s)');
      return Array.from(dlg.querySelectorAll(S.RESULT_ROWS)).slice(1);
    }

    /**
     * Pick the result row for the plan's hit: cell 0 must match the name (exact → case-insensitive →
     * startsWith); among several equally named rows the one whose source cell (cell 1) agrees with
     * row.hit.source wins. No name match: only a single-row result is accepted; otherwise the row fails —
     * the first row may be a different food with different measures or nutrition.
     */
    function pickRow(trs, row) {
      const cellText = (tr, i) => dom.textOf(tr.cells && tr.cells[i] ? tr.cells[i] : tr.querySelectorAll('td')[i]);
      const name = rowName(row);
      const want = norm(name);
      const wantCi = want.toLowerCase();
      const tiers = [
        ['exact', (t) => t === want],
        ['case-insensitive', (t) => t.toLowerCase() === wantCi],
        ['startsWith', (t) => t.toLowerCase().startsWith(wantCi)],
      ];
      for (const [how, test] of tiers) {
        const matches = trs.filter((tr) => test(cellText(tr, 0)));
        if (!matches.length) continue;
        let tr = matches[0];
        let note = how;
        if (matches.length > 1) {
          const bySource = matches.find((r) => sourceMatches(cellText(r, 1), row.hit) === true);
          if (bySource) { tr = bySource; note = how + ', source ' + cellText(bySource, 1); }
          else note = how + ', first of ' + matches.length + (row.hit && row.hit.source ? ' (none is from ' + row.hit.source + ')' : '');
        } else if (row.hit && sourceMatches(cellText(tr, 1), row.hit) === false) {
          note = how + ', source ' + cellText(tr, 1) + ' (plan hit was from ' + row.hit.source + ')';
        }
        return { tr, how: note, text: cellText(tr, 0), warn: matches.length > 1 && note.indexOf('first of') >= 0 };
      }
      if (trs.length === 1) return { tr: trs[0], how: 'only result', text: cellText(trs[0], 0), warn: true };
      const names = trs.slice(0, 5).map((tr) => '"' + cellText(tr, 0) + '"').join(', ');
      throw new Error('no result row matches "' + want + '" (' + trs.length + ' rows: ' + names + (trs.length > 5 ? ', …' : '') + ')');
    }

    async function selectRow(dlg, tr) {
      // Recipe §4 / ADf: PrettyTable selects on mousedown (button 0) whose target is a TD inside the body
      // (`Wpd` walks up from the target looking for a td; a tr target reaches the tbody first and returns
      // null). Press the first cell; without cells, focus the row and press Enter (`nDf` → `hDf`).
      const cell = (tr.cells && tr.cells[0]) || tr.querySelector('td');
      if (cell) {
        dom.mousedown(cell, { button: 0 });
        dom.mouseup(cell, { button: 0 });
      } else {
        try { tr.focus(); } catch (e) { /* headless focus can be a no-op */ }
        dom.keydown(tr, { key: 'Enter', keyCode: 13 });
      }
      const nameEl = () => dlg.querySelector(S.FOOD_NAME);
      await waitIn(dlg, () => {
        const t = dom.textOf(nameEl());
        if (t.startsWith(T.ERROR_PREFIX)) throw new Error('food failed to load (' + t + ')');
        if (!t || t === T.NO_FOOD || t === T.LOADING) return false;
        const root = measureRoot(dlg);
        const amount = root && root.querySelector(S.AMOUNT_INPUT);
        if (!amount || isDisabled(amount)) return false;
        return true;
      }, timeouts.load, 'food details to load');
      return dom.textOf(nameEl());
    }

    /**
     * Select the diary group. Returns {ok:true} when the dropdown now shows `groupName`, else {ok:false, warning}
     * — the entry then goes to the group the dialog preselected (`yud`: the last clicked header or the first
     * enabled group), which the row reports as a warning instead of a plain 'added'.
     */
    function chooseGroup(dlg, groupName) {
      const keep = (why) => { report('group', why, 'warn'); return { ok: false, warning: why }; };
      const label = dlg.querySelector(S.GROUP_LABEL);
      if (!label) return keep('no Diary Group row in the dialog; keeping the preselected group');
      // The row is `vue`'s template: <div class='w-100 d-flex …'><span class='label col-4' id='food-summary-diaryGroupLabel'>
      // <div class='col-8 …'><span>(DiaryGroupDropdown `gNh` root → div.dropdown)</span></div></div> — it carries NO
      // role="group" (the Time and Serving rows do). Take the nearest ancestor of the label that holds a dropdown,
      // stopping below the summary panel / dialog so another row's dropdown can never be picked.
      let dropdown = null;
      for (let n = label.parentElement, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
        if (n.matches(S.DIALOG) || n.classList.contains('food-summary-panel')) break;
        dropdown = n.querySelector('div.dropdown');
        if (dropdown) break;
      }
      const toggle = dropdown && dropdown.querySelector('button.dropdown-btn');
      const items = dropdown ? dom.qa('a.dropdown-item', dropdown) : [];
      if (!dropdown || !items.length) return keep('Diary Group dropdown not found; keeping the preselected group');
      // dNh (DG_ON false): `$pc(a,false)` on the DiaryGroupDropdown ROOT + a single 'Disabled' item.
      const disabled = isDisabled(toggle || dropdown) || (items.length === 1 && dom.textOf(items[0]) === T.DISABLED_ITEM);
      if (disabled) return keep('diary groups are disabled for this account; entry goes to the default group');
      const item = dom.findByText('a.dropdown-item', groupName, { root: dropdown, ci: true });
      if (!item) return keep('group "' + groupName + '" not in the dropdown [' + items.map(dom.textOf).join(', ') + ']; keeping "' + dom.textOf(toggle) + '"');
      dom.click(item);
      const now = dom.textOf(toggle);
      const itemText = dom.textOf(item);
      // `xqc` writes the item text on the toggle and fires the ValueChange `ste` parses: no change = group not set.
      if (toggle && now !== itemText) return keep('group click did not register: toggle shows "' + now + '" after clicking "' + itemText + '"; entry goes to "' + now + '"');
      report('group', 'group "' + itemText + '"');
      return { ok: true, warning: null };
    }

    /**
     * Select the plan's measure in the dialog. Returns {quantity, warning, skipAmount?} — the amount to type,
     * which is the plan's quantity when the measure was found, or a converted amount (pick.grams /
     * shownMeasure.grams) when the requested measure is not offered but the shown one is known from
     * row.measures (warning). Throws when neither is possible (adding the default measure with the requested
     * quantity would log the wrong food amount) and when the click did not register on the toggle (the app
     * would log the previously shown measure). For a meal (hidden selector) only the dialog defaults can be
     * added: the row fails unless the plan asks for exactly those, and `skipAmount` tells the caller not to type.
     */
    function chooseMeasure(dlg, row) {
      const sel = measureRoot(dlg);
      if (!sel) throw new Error('measure selector missing');
      const toggle = sel.querySelector(S.MEASURE_TOGGLE);
      const items = dom.qa(S.MEASURE_ITEMS, sel);
      const want = rowMeasure(row);
      const measureName = rowMeasureName(row);
      const quantity = rowQuantity(row);
      const shownLabel = dom.textOf(toggle);
      if (!dom.isVisible(sel)) {
        // Custom meal (`zte`: yg(a.C,false)): `lte` reads the hidden amount box and toggle at Add time and the
        // real UI offers no way to change them, so only "hidden amount × shown measure" can be added.
        const amountEl = sel.querySelector(S.AMOUNT_INPUT);
        const hiddenAmount = amountEl && amountEl.value !== '' ? Number(amountEl.value) : 1;
        const shown = parseMeasureLabel(shownLabel);
        if (!nearly(quantity, hiddenAmount)) throw new Error('meal: the amount cannot be set in the dialog (the measure selector is hidden for meals); only ' + formatQuantity(hiddenAmount) + ' × "' + shownLabel + '" can be added, not ' + formatQuantity(quantity));
        if (measureName && shown.name.toLowerCase() !== norm(measureName).toLowerCase() && shown.text.toLowerCase() !== norm(measureName).toLowerCase()) {
          throw new Error('meal: measure "' + measureName + '" cannot be selected in the dialog (the hidden selector shows "' + shownLabel + '")');
        }
        const w = 'meal: amount/measure are not settable in the dialog; added as ' + formatQuantity(hiddenAmount) + ' × "' + shownLabel + '"';
        report('measure', w, 'warn');
        return { quantity: hiddenAmount, warning: w, skipAmount: true };
      }
      if (!measureName) { const w = 'no measure requested; keeping "' + shownLabel + '"'; report('measure', w, 'warn'); return { quantity, warning: w }; }
      const match = matchMeasureItem(items, want);
      if (match) {
        dom.click(match.item); // GWT ClickHandler on the anchor; menu need not be open (recipe §5)
        const now = dom.textOf(toggle);
        const itemText = dom.textOf(match.item);
        // `xqc` sets the toggle text on click and `RBe`/`rqc` derive the selected measure FROM that text at Add
        // time: a mismatch means the click did not take and the app would log the previously shown measure.
        if (toggle && now !== itemText) throw new Error('measure click did not register: toggle shows "' + now + '" (wanted "' + itemText + '")');
        report('measure', 'measure "' + itemText + '" (' + match.how + ')', match.warn ? 'warn' : 'info');
        return { quantity, warning: match.warn ? 'measure "' + itemText + '" matched by ' + match.how : null };
      }
      // Not offered. Keep the shown measure only when the grams can be kept right.
      const labels = items.map(dom.textOf).join(', ');
      const shown = parseMeasureLabel(shownLabel);
      const known = Array.isArray(row.measures) ? row.measures.find((m) => m && norm(m.name).toLowerCase() === shown.name.toLowerCase() && nearly(m.amount > 0 ? m.amount : 1, shown.amount)) : null;
      const grams = row.pick && Number(row.pick.grams);
      if (known && Number(known.grams) > 0 && grams > 0 && !isRecipeLike(known) && !isRecipeLike(want)) {
        const q = grams / Number(known.grams);
        const w = 'measure "' + measureName + '" not offered [' + labels + ']; keeping "' + shownLabel + '" with amount ' + formatQuantity(q) + ' so the total stays ' + Math.round(grams * 10) / 10 + ' g';
        report('measure', w, 'warn');
        return { quantity: q, warning: w };
      }
      throw new Error('measure "' + measureName + '" is not offered for this food [' + labels + ']' + (known ? '' : '; the shown measure "' + shownLabel + '" is unknown to the plan, so the amount cannot be converted'));
    }

    function setAmount(dlg, quantity) {
      const sel = measureRoot(dlg);
      const input = sel && sel.querySelector(S.AMOUNT_INPUT);
      if (!input) throw new Error('amount input missing');
      const text = formatQuantity(quantity);
      // Measure FIRST, then amount: changing the measure can auto-flip 1↔100 (recipe §5).
      dom.setNativeValue(input, text, { change: true, keyup: true });
      if (input.value !== text) throw new Error('amount box rejected "' + text + '" (now "' + input.value + '")');
      report('amount', 'amount ' + text);
      return text;
    }

    async function clickAdd(dlg) {
      const btn = dlg.querySelector(S.ADD_BUTTON);
      if (!btn) throw new Error('"Add to Diary" button missing');
      if (btn.disabled) await waitIn(dlg, () => !btn.disabled, 2000, '"Add to Diary" button to enable');
      report('add', 'clicking "' + (dom.textOf(btn) || 'Add to Diary') + '"');
      dom.click(btn);
      // Wait for the dialog to detach (top-slide-out then hide after 100 ms, recipe §8), watching for the
      // "Enter a valid time" Message modal which aborts the add and leaves the dialog open (recipe §7).
      await wait(() => {
        const modal = dialogWithText(doc, T.INVALID_TIME);
        if (modal) { const e = new Error(T.INVALID_TIME); e.invalidTime = true; e.modal = modal; throw e; }
        return !dlg.isConnected && !addFoodDialog(doc);
      }, timeouts.close, 'dialog to close after Add');
    }

    /**
     * Is `foodName` shown in the diary, in `groupName`'s section when that header exists? The diary is a
     * FlexTable (`Mud`): a group's header row holds the DiaryGroupHeader (`Krd`: div.diary-group >
     * .diary-group-title-container > .diary-group-title) in a cell styled 'diary-group-row', and the group's
     * servings are the FOLLOWING sibling rows of that table up to the next header row — `.diary-group` itself
     * holds only the title, macros and the collapse button, never an entry.
     */
    function entryVisible(foodName, groupName) {
      try {
        const want = norm(foodName).toLowerCase();
        if (!want) return false;
        const isHeaderRow = (tr) => !!tr.querySelector(S.DIARY_GROUP_ROW + ', ' + S.DIARY_GROUP);
        const headerRows = [];
        for (const el of dom.qa(S.DIARY_GROUP_ROW + ', ' + S.DIARY_GROUP, doc)) {
          const tr = el.closest('tr');
          if (tr && headerRows.indexOf(tr) < 0) headerRows.push(tr);
        }
        if (!headerRows.length) return norm(dom.textOf(doc.body)).toLowerCase().includes(want); // no diary table: last resort
        const rowsOfGroup = (header) => {
          const out = [];
          for (let tr = header.nextElementSibling; tr && !isHeaderRow(tr); tr = tr.nextElementSibling) out.push(tr);
          return out;
        };
        const header = groupName ? headerRows.find((tr) => dom.textOf(tr.querySelector(S.DIARY_GROUP_TITLE)).toLowerCase() === groupName.toLowerCase()) : null;
        const rows = header ? rowsOfGroup(header) : [].concat.apply([], headerRows.map(rowsOfGroup));
        return rows.some((tr) => norm(dom.textOf(tr)).toLowerCase().includes(want));
      } catch (e) { return false; }
    }

    /**
     * The dialog hides before updateDiary is even sent (`oke`: `km(a.j)` first), so success is only known
     * from the panel's refresh signal: it resolves on the app's updateDiary //OK, rejects with `.rejected`
     * when that response carries an ErrorEntryChangeResult, with `.noHook` when there is no hook (then the
     * fixed delay is the best we can do) and plainly on timeout (then the diary is inspected: a visible
     * entry counts — returned as the row's warning — otherwise the row failed).
     */
    async function waitDiaryRefresh(row, foodName, groupName) {
      let failure = null;
      if (typeof o.waitForRefresh === 'function') {
        try {
          await o.waitForRefresh(row);
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          if ((e && e.noHook) || /hook not available/i.test(msg)) {
            report('refresh', 'no hook signal (' + msg + '); using the fixed delay', 'warn');
            await dom.sleep(o.refreshMs);
          } else if ((e && e.rejected) || /^rejected\b/i.test(msg)) {
            failure = new Error('the server rejected the entry: ' + msg.replace(/^rejected:?\s*/i, ''));
            failure.rejected = true;
          } else {
            failure = new Error('no updateDiary response after Add (' + msg + ')');
            failure.noResponse = true;
          }
        }
      } else {
        await dom.sleep(o.refreshMs);
      }
      const seen = entryVisible(foodName, groupName);
      let warning = null;
      if (failure && failure.noResponse && seen) {
        warning = failure.message + ', but the entry is visible in the diary; treating it as added';
        report('refresh', warning, 'warn');
        failure = null;
      }
      if (failure) throw failure;
      report('refresh', seen ? 'entry visible in the diary' : 'entry not visible in the diary yet (the diary may still be refreshing)', seen ? 'info' : 'warn');
      return warning;
    }

    // --- main loop ----------------------------------------------------------------------------------
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        current = { row, index: i };
        checkCancel();
        const name = rowName(row);
        const measureName = rowMeasureName(row);
        const quantity = rowQuantity(row);
        const groupName = groupNameFor(row, o.groups);
        if (!name) {
          result.failed.push({ row, error: new Error('row has no food name') });
          report('row', 'skipped: no food name', 'error');
          continue;
        }
        if (row.status === 'error' || (row.pick && row.pick.error)) {
          const msg = (row.pick && row.pick.error) || row.message || 'row is not ready';
          result.failed.push({ row, error: new Error(String(msg)) });
          report('row', 'skipped: ' + msg, 'error');
          continue;
        }
        report('row', 'start: ' + name + ' × ' + quantity + (measureName ? ' ' + measureName : '') + (groupName ? ' → ' + groupName : ''));
        // Every silent fallback of this row (group kept, measure converted, ambiguous result row, meal defaults…)
        // is collected here and reported with the outcome, so the panel never shows a plain green 'added' for it.
        const warnings = [];
        const noteWarn = (w) => { if (w) warnings.push(String(w)); };
        try {
          if (ensureDiaryHash()) await dom.sleep(o.hashSettleMs);        // step 1
          const dlg = await openDialog();                                  // step 2
          const trs = await search(dlg, name);                             // step 3
          const picked = pickRow(trs, row);                                // step 4
          report('select', 'row "' + picked.text + '" (' + picked.how + ')', picked.warn ? 'warn' : 'info');
          if (picked.warn) noteWarn('result row "' + picked.text + '" chosen by ' + picked.how);
          const loadedName = await selectRow(dlg, picked.tr);
          report('select', 'loaded "' + loadedName + '"');
          if (groupName) noteWarn(chooseGroup(dlg, groupName).warning);   // step 5
          else { const w = 'no group resolved for groupId ' + row.groupId + '; keeping the preselected group'; report('group', w, 'warn'); noteWarn(w); }
          const chosen = chooseMeasure(dlg, row);                          // step 6 (measure first)
          noteWarn(chosen.warning);
          if (!chosen.skipAmount) setAmount(dlg, chosen.quantity);         //         then amount
          await clickAdd(dlg);                                             // step 7
          noteWarn(await waitDiaryRefresh(row, loadedName, groupName));
          result.added.push({ row, warnings: warnings.slice() });
          report('row', 'added' + (warnings.length ? ' (' + warnings.join('; ') + ')' : ''), warnings.length ? 'warn' : 'info');
        } catch (err) {
          if (err && err.aborted) throw err instanceof AbortError ? err : new AbortError(err.message);
          if (err && err.invalidTime) {
            report('row', '"' + T.INVALID_TIME + '" modal: the timestamp fields are partially filled; aborting the batch', 'error');
            result.failed.push({ row, error: err });
            try { await dismissModal(err.modal); await closeDialogIfOpen('invalid time'); } catch (e) { /* aborting anyway */ }
            throw new AbortError(T.INVALID_TIME + ' — fix the Time of day fields in the Add Food dialog and retry');
          }
          result.failed.push({ row, error: err });
          report('row', 'failed: ' + (err && err.message), 'error');
          // A rejected add may leave the app's own error dialog behind: close every dialog in that case.
          await closeDialogIfOpen('row failed', !!(err && err.rejected));
        }
        if (i < rows.length - 1 && o.delayMs > 0) await dom.sleep(o.delayMs);
      }
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      result.abortReason = reason;
      result.cancelled = !!cancelReason;
      report('batch', 'aborted: ' + reason, 'error');
      const done = new Set(result.added.map((a) => a.row).concat(result.failed.map((f) => f.row)));
      for (const row of rows) if (!done.has(row)) result.failed.push({ row, error: new AbortError(reason) });
      if (!cancelReason) { try { await closeDialogIfOpen('batch aborted', true); } catch (e) { /* best effort */ } }
    } finally {
      doc.removeEventListener('keydown', onKey, true);
    }
    report('batch', 'done: ' + result.added.length + ' added, ' + result.failed.length + ' failed');
    current = { row: null, index: -1 };
    return result;
  }

  window.CMA.engineUi = {
    run, formatQuantity, AbortError,
    SELECTORS: S, TEXT: T,
    rowName, rowMeasureName, rowQuantity, groupNameFor,
    measureLabel, parseMeasureLabel, matchMeasureItem, sourceMatches,
    formatLabelGrams, formatLabelMl, formatLabelAmount,
  };
})();
