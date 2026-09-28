/* CMA.mock — a faithful stand-in for Cronometer's diary page + "Add Food to Diary" dialog (SPEC §7.4).
 *
 * Every class name, id, label string, DOM shape, event semantic and timing below comes from
 * research/ui-automation-dialog-recipe.md (recipe §N cited inline) and the bundle facts quoted in
 * src/lib/engine-ui.js. The mock exists so tests/engine-ui.html can drive CMA.engineUi without a live
 * account; it deliberately reproduces the traps of the real app:
 *  - result rows select on `mousedown` (button 0) whose TARGET is a <td> of a body row (`ADf` → `jDf` →
 *    `Wpd`: a mousedown targeted at the <tr> itself is ignored) or on Enter while the <tr> is
 *    document.activeElement (`nDf` → `hDf`); `click` does nothing (§4)
 *  - the food summary goes "no food selected" → "loading..." → name; the amount box and the measure dropdown
 *    carry `disabled-input` + aria-disabled on their WIDGET ROOTS (`$pc`: div.amount / .selection-dropdown)
 *    until the food has loaded (§4, §5)
 *  - the measure selector is `div.add-serving-measure-selector > div.row-container.mb-0[role=group]`: `KBe`
 *    replaces the inner row's class, so there is NO `.measure-selector` element in the dialog
 *  - measure items are labelled like the app (`qqj`/`pqj`): `[amount ]name[  — Ng | — N ml]`
 *  - the measure and diary-group pickers are BootstrapDropdowns (anchors), not <select>s (§5, §6); the group
 *    row is `vue`'s template (div.w-100.d-flex > span.label#food-summary-diaryGroupLabel + div.col-8 > span >
 *    gNh root) and carries NO role="group"
 *  - changing the measure auto-flips the amount exactly like `TBe`: 1 → 100 when the new measure is the plain
 *    1 g 'g' / 1 ml 'ml', else 100 → 1 for ANY new measure (re-selecting 'g' while showing 100 flips it to 1),
 *    then a deferred command focuses/selects the amount box (`FCe` → `XBe`) (§5)
 *  - a Custom Meal hides the whole MeasureSelector after load (`zte`: `b.B==Oaj ? yg(a.C,false)`), yet Add
 *    still reads the hidden amount and measure (`lte`)
 *  - the dialog closes with `top-slide-out` and detaches 100 ms later; the diary refreshes after that (§8)
 *  - the diary is a FlexTable (`Mud`): one header row per group whose first cell is `td.diary-group-row` holding
 *    the DiaryGroupHeader `div.diary-group` (`Krd`: title container + macros + collapse button, no entries),
 *    followed by one `tr` per serving (`td.diary-time`, name, amount) until the next header row
 *  - Escape closes the dialog on KEYUP 27 in the search box (`$qe` is registered with D$k = 'keyup') and on
 *    keyup 27 anywhere in the dialog body (`sm` → `Orh`); keydown 27 does nothing
 *  - the SEARCH button always re-searches (`jre` sets the force flag before `Pqe`); only the typed/debounced
 *    path short-circuits a repeated query (§3, `Pqe` guard)
 *  - optional "Adding a Food?" fast interstitial (§1d), "Enter a valid time" Message modal (§7), disabled
 *    diary groups (§6, single 'Disabled' item + disabled root), `dropAdds` (the dialog closes but the
 *    server "rejects" the add: nothing is appended, as in the real app where `oke` hides the dialog before
 *    updateDiary is even sent) and `ignoreMeasureClicks` / `ignoreGroupClicks` (an item click that does not
 *    register: the toggle text — which is what the app reads at Add time — stays as it was)
 *
 *   const mock = CMA.mock.install(document, {
 *     fastRunning:false, invalidTime:false, groupsDisabled:false, dropAdds:false, ignoreMeasureClicks:false,
 *     ignoreGroupClicks:false, dialogTitle:'Add Food to Diary',
 *     groups:[...names], dataset:[...], delays:{open:100, spinner:200, load:150, close:100, refresh:50}, container:Element })
 *   mock.state, mock.reset(), mock.uninstall(), mock.dataset, mock.root, mock.labelFor(food, measure),
 *   mock.entries(groupName) → the serving <tr>s of that group, mock.headerRow(groupName)
 * Successful adds are recorded in window.__added as {name, quantity, measure, group} and their food ids
 * in mock.state.addedIds.
 *
 * Day navigation (opt-in, off by default: the arrows then only log and the date label stays fixed):
 *   mock.useDays({start:'YYYY-MM-DD' (default: the local today), entries:{'YYYY-MM-DD':[{group, name, amount}]},
 *                 delay:150}) → start
 * makes `.diary-date-previous` / `.diary-date-next` switch days like the real diary: each day keeps its own serving
 * rows, the switch lands `delay` ms after the click (the app re-renders after its getDayInfo) and the label reads
 * like the app's ('Monday, October 5, 2026'); adds made while it is on also record `date` in window.__added.
 * mock.date() → the ISO day shown (null while off), mock.dayChanges() → how many switches landed.
 * tools/screenshots.py --dry-run uses it for its empty-future-day search (synthetic seeded entries only).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';

  const DEFAULT_GROUPS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const DEFAULT_DELAYS = { open: 100, spinner: 200, load: 150, close: 100, refresh: 50 };
  const SEARCH_PLACEHOLDER = 'Search all foods & recipes...'; // recipe §2
  const SEARCH_TABS = ['All', 'Favorites', 'Common Foods', 'Beverages', 'Supplements', 'Brands', 'Restaurants', 'Custom'];
  const DASH = '  — ';                                    // wRo: two spaces, em dash, space

  // Measure = {name, grams (per unit as listed), type:'Weight'|'Volume'|'Atomic'|'Recipe', amount? (Measure.a,
  // default 1), ml? (Measure.f)}; `defaultMeasure` = name preselected after load; `source` = FoodSource enum
  // name (cell 1 of the results table; 'Custom' renders as Custom Food/Recipe/Meal by `type`).
  const DATASET = [
    { id: 1, name: 'Chicken Breast, Roasted', source: 'NCCDB', defaultMeasure: 'breast', measures: [
      { name: 'g', grams: 1, type: 'Weight' }, { name: 'oz', grams: 28.3495, type: 'Weight' }, { name: 'breast', grams: 172, type: 'Atomic' } ] },
    // same name, other database, other measures: the engine must pick by source, not by position
    { id: 9, name: 'Chicken Breast, Roasted', source: 'USDA', defaultMeasure: 'oz', measures: [
      { name: 'oz', grams: 28.3495, type: 'Weight' }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 2, name: 'Chicken Breast, Fried', source: 'NCCDB', defaultMeasure: 'g', measures: [
      { name: 'g', grams: 1, type: 'Weight' }, { name: 'oz', grams: 28.3495, type: 'Weight' } ] },
    { id: 3, name: 'Egg, Whole, Cooked', source: 'USDA', defaultMeasure: 'large', measures: [
      { name: 'large', grams: 50, type: 'Atomic' }, { name: 'medium', grams: 44, type: 'Atomic' }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 4, name: 'Egg White, Raw', source: 'USDA', defaultMeasure: 'large', measures: [
      { name: 'large', grams: 33, type: 'Atomic' }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 5, name: 'Rice, White, Cooked', source: 'NCCDB', defaultMeasure: 'cup', measures: [
      { name: 'cup', grams: 158, type: 'Volume', ml: 240 }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 6, name: 'Rice, Brown, Cooked', source: 'NCCDB', defaultMeasure: 'cup', measures: [
      { name: 'cup', grams: 195, type: 'Volume', ml: 240 }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 7, name: 'Olive Oil', source: 'USDA', defaultMeasure: 'tbsp', measures: [
      { name: 'tbsp', grams: 13.5, type: 'Volume', ml: 15 }, { name: 'tsp', grams: 4.5, type: 'Volume', ml: 5 },
      { name: 'g', grams: 1, type: 'Weight' }, { name: 'ml', grams: 0.92, type: 'Volume', ml: 1 } ] },
    { id: 8, name: 'Banana, Raw', source: 'USDA', defaultMeasure: 'medium', measures: [
      { name: 'medium', grams: 118, type: 'Atomic' }, { name: 'g', grams: 1, type: 'Weight' } ] },
    // 'cup, chopped' precedes 'cup' and a half-cup measure exists: prefix matching would pick the wrong item
    { id: 10, name: 'Broccoli, Raw', source: 'USDA', defaultMeasure: 'cup, chopped', measures: [
      { name: 'cup, chopped', grams: 91, type: 'Volume', ml: 240 }, { name: 'cup', grams: 88, type: 'Volume', ml: 240 },
      { name: 'cup', grams: 44, type: 'Volume', ml: 120, amount: 0.5 }, { name: 'g', grams: 1, type: 'Weight' } ] },
    { id: 20, name: "Mum's Granola", source: 'Custom', type: 'RECIPE', isRecipe: true, defaultMeasure: 'serving', measures: [
      { name: 'serving', grams: 45, type: 'Recipe' }, { name: 'g', grams: 1, type: 'Weight' } ] },
    // Custom Meal: `zte` hides the MeasureSelector after load; Add still reads its hidden amount/measure
    { id: 30, name: 'My Meal', source: 'Custom', type: 'MEAL', hideMeasureSelector: true, defaultMeasure: 'meal', measures: [
      { name: 'meal', grams: 320, type: 'Recipe' } ] },
  ];

  function el(doc, tag, cls, text, attrs) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function textOf(e) { return (e && e.textContent || '').replace(/\s+/g, ' ').trim(); }

  // ---- measure label, verbatim rules of qqj / pqj / rqj / tqj / uqj -----------------------------------
  function rqj(a) {
    if (Math.abs(a - 1 / 3) < 1e-6) return '1/3';
    if (a === 0.25) return '1/4';
    if (a === 0.2) return '1/5';
    if (Math.abs(a - 2 / 3) < 1e-6) return '2/3';
    if (a === 0.5) return '1/2';
    if (Number.isInteger(a)) return String(a);
    return a.toFixed(2);
  }
  function tqj(a, k) { return k < 2 ? String(Math.round(a * 10) / 10) : String(Math.round(a)); }
  function uqj(a) { return a < 2 ? String(Math.round(a * 10) / 10) : String(Math.round(a)); }
  function labelFor(food, m) {
    const amount = m.amount > 0 ? m.amount : 1;
    const c = amount !== 1 ? rqj(amount) + ' ' + m.name : m.name;
    const plainGram = amount === 1 && m.grams === 1 && m.name === 'g';
    const e = !plainGram && m.type === 'Weight';
    const d = !!(food && food.isRecipe) && m.type === 'Recipe' && !(amount === 1 && m.name === 'g');
    if (e || d) return c + DASH + tqj(m.grams, m.grams) + 'g';
    const plainMl = amount === 1 && m.name === 'ml' && m.ml != null && Math.abs(m.ml - 1) < 1e-6;
    if (m.type === 'Volume' && m.ml != null && !plainMl) return c + DASH + uqj(m.ml) + ' ml';
    return c;
  }
  // U9i / Mqe: the source cell shows the FoodSource enum name, 'Custom' becomes Custom Food/Recipe/Meal.
  function sourceLabel(food) {
    if (food.source === 'Custom') return food.type === 'MEAL' ? 'Custom Meal' : food.type === 'RECIPE' ? 'Custom Recipe' : 'Custom Food';
    return food.source;
  }
  function sourceClass(food) {
    if (food.source === 'Custom') return food.type === 'MEAL' ? 'source-custom-meal' : 'source-custom';
    return 'source-lab';
  }

  function install(doc, opts) {
    doc = doc || document;
    const o = Object.assign({ fastRunning: false, invalidTime: false, groupsDisabled: false, dropAdds: false, ignoreMeasureClicks: false, ignoreGroupClicks: false, dialogTitle: 'Add Food to Diary', groups: DEFAULT_GROUPS.slice(), dataset: DATASET }, opts || {});
    const delays = Object.assign({}, DEFAULT_DELAYS, o.delays || {});
    const win = doc.defaultView || window;
    const dataset = o.dataset.map((f) => Object.assign({}, f, { measures: f.measures.map((m) => Object.assign({}, m)) }));
    win.__added = [];
    const state = {
      dialogOpen: false, fastPrompts: 0, searches: 0, selections: 0, adds: 0, droppedAdds: 0, closedWithoutAdd: 0, invalidTimePrompts: 0,
      lastQuery: null, selected: null, measure: null, group: null, addedIds: [], log: [],
    };
    const log = (m) => { state.log.push(m); if (state.log.length > 500) state.log.shift(); };
    const timers = new Set();
    const later = (fn, ms) => { const t = win.setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    // `$pc(widget, enabled)`: disabled-input + aria-disabled on the widget ROOT element.
    const setEnabled = (root, enabled) => {
      if (enabled) { root.classList.remove('disabled-input'); root.removeAttribute('aria-disabled'); }
      else { root.classList.add('disabled-input'); root.setAttribute('aria-disabled', 'true'); }
    };

    // ---------------------------------------------------------------- diary skeleton (recipe §1a, live-app-report §6)
    const container = o.container || doc.body;
    const root = el(doc, 'div', 'diary-panel', null, { 'data-cma-mock': '1' });
    const nav = el(doc, 'div', 'diary-date-nav d-flex align-items-center');
    const prev = el(doc, 'i', 'icon-chevron-left diary-date-previous');
    const dateBtn = el(doc, 'button', 'gwt-Button diary-date-btn', 'Sunday, September 27, 2026');
    const next = el(doc, 'i', 'icon-chevron-right diary-date-next');
    nav.append(prev, dateBtn, next);
    const DEFAULT_DATE_LABEL = dateBtn.textContent;
    prev.addEventListener('click', () => { log('date-previous'); stepDay(-1); });
    next.addEventListener('click', () => { log('date-next'); stepDay(1); });
    root.append(nav);

    const toolbar = el(doc, 'div', 'button-panel d-flex');
    const buttons = [
      ['FOOD', 'Log a serving to your diary', 'add-food-icon'], ['EXERCISE', 'Log an exercise to your diary', 'add-exercise-icon'],
      ['BIOMETRIC', 'Log a biometric to your diary', 'add-biometric-icon'], ['NOTE', 'Add a note to your diary', 'add-note-icon'],
      ['FAST', 'Log a fast to your diary', 'add-fast-icon'],
    ];
    let foodButton = null;
    for (const [label, title, icon] of buttons) {
      const b = el(doc, 'button', 'gwt-Button button-panel-btn', null, { title, type: 'button' });
      const img = el(doc, 'img', 'me-1', null, { alt: '', src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>' + icon + '</title></svg>') });
      b.append(img, doc.createTextNode(' '), el(doc, 'span', null, label));
      if (label === 'FOOD') { foodButton = b; b.setAttribute('accesskey', 'a'); }
      toolbar.append(b);
    }
    root.append(toolbar);

    // Diary FlexTable (`Mud`): the header row of a group has its first cell styled 'diary-group-row' (colspan 8)
    // holding the DiaryGroupHeader widget (`Krd`: div.diary-group > div.diary-group-title-container > title label +
    // .diary-group-macros, then div.btn-collapse-container > button.btn-collapse); the group's servings are the
    // rows that FOLLOW it in the same table, each with a 'diary-time' cell, the name and the amount.
    const diaryTable = el(doc, 'table', 'diary-table');
    const diaryBody = el(doc, 'tbody');
    diaryTable.append(diaryBody);
    const headerRows = new Map();
    for (const g of o.groups) {
      const tr = el(doc, 'tr', 'diary-group-expanded', null, { 'data-group': g });
      const td = el(doc, 'td', 'diary-group-row', null, { colspan: '8' });
      const block = el(doc, 'div', 'diary-group');
      const tc = el(doc, 'div', 'diary-group-title-container');
      tc.append(el(doc, 'div', 'gwt-Label diary-group-title', g), el(doc, 'div', 'diary-group-macros', '0 kcal'));
      const cc = el(doc, 'div', 'btn-collapse-container no-print');
      cc.append(el(doc, 'button', 'gwt-Button btn-collapse', '', { type: 'button', 'aria-label': 'Collapse diary group' }));
      block.append(tc, cc);
      td.append(block);
      tr.append(td);
      diaryBody.append(tr);
      headerRows.set(g, tr);
    }
    root.append(diaryTable);
    container.append(root);
    const isHeaderRow = (tr) => !!tr && !!tr.querySelector('td.diary-group-row');
    /** The serving rows of a group: the rows after its header up to the next header. */
    const entriesOf = (name) => {
      const out = [];
      const h = headerRows.get(name);
      for (let tr = h && h.nextElementSibling; tr && !isHeaderRow(tr); tr = tr.nextElementSibling) out.push(tr);
      return out;
    };

    // ---------------------------------------------------------------- optional day navigation (mock.useDays)
    const days = { on: false, date: null, stash: new Map(), delay: 150, changes: 0 };
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const isoUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    const isoAdd = (iso, n) => new Date(isoUtc(iso) + n * 86400000).toISOString().slice(0, 10);
    const dayLabel = (iso) => { const d = new Date(isoUtc(iso)); return WEEKDAY_NAMES[d.getUTCDay()] + ', ' + MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };
    const localIso = () => { const d = new win.Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
    /** A serving row as the Add handler builds it. */
    const entryRow = (name, amount) => {
      const tr = el(doc, 'tr', null, null, { 'data-name': name });
      tr.append(el(doc, 'td', 'diary-time', ''), el(doc, 'td', 'no-left-padding', name), el(doc, 'td', null, amount));
      return tr;
    };
    /** Append a serving row after the group's existing rows (right before the next header row). */
    const appendToGroup = (group, tr) => {
      const header = headerRows.get(group) || diaryBody.rows[0];
      let after = header;
      while (after.nextElementSibling && !isHeaderRow(after.nextElementSibling)) after = after.nextElementSibling;
      diaryBody.insertBefore(tr, after.nextElementSibling);
    };
    function showDay(iso) {
      const rows = [];
      for (const g of o.groups) for (const tr of entriesOf(g)) rows.push([g, tr]);
      for (const [, tr] of rows) tr.remove();
      days.stash.set(days.date, rows);
      days.date = iso;
      dateBtn.textContent = dayLabel(iso);
      for (const [g, tr] of days.stash.get(iso) || []) appendToGroup(g, tr);
      days.stash.delete(iso);
      days.changes++;
      log('day ' + iso);
    }
    /** An arrow click: nothing but the log while day navigation is off (the default). */
    function stepDay(n) { if (days.on) later(() => { if (days.on) showDay(isoAdd(days.date, n)); }, days.delay); }

    // ---------------------------------------------------------------- generic PrettyDialog (recipe §2, bundle `sm`)
    function prettyDialog(title) {
      const dlg = el(doc, 'div', 'pretty-dialog top-slide-in', null, { role: 'dialog' });
      const cont = el(doc, 'div', 'container');
      const tb = el(doc, 'div', 'titlebar-container');
      const ttc = el(doc, 'div', 'title-text-container');
      ttc.append(el(doc, 'div', 'gwt-Label titlebar-title', title));
      const cancelBox = el(doc, 'div', 'titlebar-cancelbox');
      cancelBox.append(el(doc, 'i', 'icon-x-big', null, { role: 'button', 'aria-label': 'Close' }));
      tb.append(ttc, cancelBox);
      cont.append(tb);
      dlg.append(cont);
      return { dlg, cont, cancelIcon: cancelBox.firstChild };
    }

    // Confirm/Message modal: bundle `Mm(title, html, buttons)` → PrettyDialog + `um` label + `tm` button row.
    function showModal(title, body, choices, onChoice) {
      const { dlg, cont, cancelIcon } = prettyDialog(title);
      cont.append(el(doc, 'div', 'gwt-Label mt-3', body));
      const row = el(doc, 'div', 'prettyDialogChoices mt-4');
      choices.forEach((c, i) => {
        // `tm`: the first of several buttons is the borderless one, the rest are flat (bundle constants Znp)
        const b = el(doc, 'button', 'gwt-Button ' + (choices.length > 1 && i === 0 ? 'btn-borderless-jungle-green ms-4' : 'btn-flat-jungle-green ms-4'), c, { type: 'button' });
        b.style.width = '180px';
        b.addEventListener('click', () => { dlg.remove(); onChoice(c); });
        row.append(b);
      });
      cont.append(row);
      cancelIcon.addEventListener('click', () => { dlg.remove(); onChoice(null); });
      doc.body.append(dlg);
      return dlg;
    }

    // ---------------------------------------------------------------- Add Food dialog (recipe §2–§8)
    let dialog = null; // { dlg, ... } while open

    function openAddFoodDialog() {
      if (dialog) { log('FOOD clicked while a dialog is open: ignored'); return; }
      state.dialogOpen = true;
      state.lastQuery = null; state.selected = null; state.measure = null; state.group = o.groups[0];
      const { dlg, cont, cancelIcon } = prettyDialog(o.dialogTitle);
      const body = el(doc, 'div', 'dynamic-add-food-container');

      // --- left pane: FoodSearchPanel
      const scroll = el(doc, 'div', 'top-level-scroll-container add-food-diary w-100 d-flex flex-column');
      const content = el(doc, 'div', 'food-search-content');
      const sc = el(doc, 'div', 'search-container');
      const searchInput = el(doc, 'input', 'gwt-TextBox search-field', null, { type: 'text', placeholder: SEARCH_PLACEHOLDER });
      sc.append(searchInput, el(doc, 'i', 'icon-x-circle-fill', null, { style: 'display:none' }), el(doc, 'i', 'icon-filter filter-icon'));
      const searchBtn = el(doc, 'button', 'gwt-Button btn-borderless-jungle-green food-search-btn', 'SEARCH', { type: 'button' });
      const tabs = el(doc, 'div', 'search-tab-container');
      SEARCH_TABS.forEach((t, i) => tabs.append(el(doc, 'div', 'gwt-Label search-tab' + (i === 0 ? ' food-search-selected-tab' : ''), t, { role: 'tab', tabindex: '0' })));
      const results = el(doc, 'div', 'results-container');
      const spinner = el(doc, 'div', 'food-search-spinner', 'Searching…');
      spinner.style.display = 'none';
      const table = el(doc, 'table', 'crono-table crono-table-hover');
      const tbody = el(doc, 'tbody');
      const header = el(doc, 'tr');
      header.append(el(doc, 'th', null, 'Description', { style: 'width:75%' }), el(doc, 'th', null, 'Source', { style: 'width:15%' }));
      tbody.append(header);
      table.append(tbody);
      const noResults = el(doc, 'div', 'GHL1WBHBL4');
      noResults.append(doc.createTextNode('no results — create a '), el(doc, 'a', 'gwt-Anchor', 'custom food', { href: 'javascript:void(0);' }));
      noResults.style.display = 'none';
      results.append(spinner, table, noResults);
      content.append(sc, searchBtn, tabs, results);
      scroll.append(content);

      // --- right pane: FoodSummaryPanel
      const panel = el(doc, 'div', 'static-panel food-summary-panel');
      const nameRow = el(doc, 'div', 'd-flex align-items-center');
      const nameLabel = el(doc, 'div', 'gwt-Label ms-2 food-search-name', 'no food selected');
      nameRow.append(el(doc, 'i', 'icon-star'), nameLabel, el(doc, 'i', 'icon-x-circle-fill'));
      const macros = el(doc, 'div', 'boxed-border-thingy w-50', '0 listed nutrients');

      const timeRow = el(doc, 'div', 'd-flex align-items-center row-container', null, { role: 'group', 'aria-labelledby': 'food-summary-timeOfDayLabel' });
      timeRow.append(el(doc, 'span', 'label col-4', 'Time of day', { id: 'food-summary-timeOfDayLabel' }),
        el(doc, 'button', 'gwt-Button disabled-input', '- -:- -', { type: 'button', 'aria-disabled': 'true' }), el(doc, 'i', 'honey-gold icon-lock'));

      // Diary group row (recipe §6): `vue` template — <div class='w-100 d-flex justify-content-center align-items-center
      // mt-2 mb-3'> <span class='label col-4' id='food-summary-diaryGroupLabel'>Diary Group</span> <div class='col-8
      // d-flex align-items-center'> <span id=…>(DiaryGroupDropdown `gNh` root = div.d-flex.align-items-center.w-100)
      // — unlike the Time and Serving rows it carries NO role="group"
      const groupRow = el(doc, 'div', 'w-100 d-flex justify-content-center align-items-center mt-2 mb-3');
      groupRow.append(el(doc, 'span', 'label col-4', 'Diary Group', { id: 'food-summary-diaryGroupLabel' }));
      const groupCol = el(doc, 'div', 'col-8 d-flex align-items-center');
      const groupSlot = el(doc, 'span', null, null, { id: 'cma-mock-group-slot' });
      const groupDD = bootstrapDropdown('food-summary-diaryGroupLabel', 'd-flex align-items-center w-100');
      groupDD.ignoreClicks = !!o.ignoreGroupClicks;
      groupSlot.append(groupDD.root);
      groupCol.append(groupSlot);
      groupRow.append(groupCol);
      if (o.groupsDisabled) {
        // dNh: DG_ON != 'true' → single item 'Disabled' and `$pc(a,false)` on the dropdown root
        groupDD.addItem('Disabled', 'Disabled');
        groupDD.select('Disabled');
        setEnabled(groupDD.root, false);
        state.group = o.groups[0];
      } else {
        o.groups.forEach((g, i) => groupDD.addItem(g, String(i)));
        groupDD.select(o.groups[0]);
      }
      groupDD.onChange = (label) => { if (o.groupsDisabled) return; state.group = label; log('group=' + label); };

      // Serving row: MeasureSelector root (xke: 'add-serving-measure-selector') > inner row whose class KBe
      // REPLACED with 'row-container mb-0' (no 'measure-selector' anywhere) > heading + NumberBox.amount + .selection-dropdown
      const msRoot = el(doc, 'div', 'add-serving-measure-selector');
      const ms = el(doc, 'div', 'row-container mb-0', null, { role: 'group', 'aria-labelledby': 'food-summary-servingSizeLabel' });
      ms.append(el(doc, 'div', 'gwt-Label selection-heading', 'Serving Size', { id: 'food-summary-servingSizeLabel' }));
      const amountWrap = el(doc, 'div', 'amount');                        // NumberBox root (fqc), class from KBe vg(a.a,'amount')
      const amountInner = el(doc, 'div');
      const amountInput = el(doc, 'input', 'gwt-TextBox text-box', null, { type: 'text', maxlength: '6', 'aria-label': 'Amount' });
      amountInput.value = '';
      amountInner.append(amountInput);
      amountWrap.append(el(doc, 'label', 'visually-hidden', 'Amount'), amountInner);
      setEnabled(amountWrap, false);
      const measureDD = bootstrapDropdown('food-summary-servingSizeLabel', 'selection-dropdown');
      measureDD.ignoreClicks = !!o.ignoreMeasureClicks;
      setEnabled(measureDD.root, false);
      ms.append(amountWrap, measureDD.root);
      msRoot.append(ms);

      const altInfo = el(doc, 'div', 'alt-info-container mt-4');
      altInfo.style.display = 'none';
      const addWrap = el(doc, 'div', 'add-to-diary-btn-container');
      const addBtn = el(doc, 'button', 'gwt-Button btn-flat-jungle-green', 'Add to Diary', { type: 'button' });
      addWrap.append(addBtn);
      panel.append(nameRow, macros, timeRow, groupRow, msRoot, altInfo, addWrap);

      body.append(scroll, panel);
      cont.append(body);
      doc.body.append(dlg);
      dialog = { dlg };
      later(() => dlg.classList.remove('top-slide-in'), 120);
      try { searchInput.focus(); } catch (e) { /* headless focus can be a no-op */ }

      // ---- search (recipe §3)
      let debounce = null;
      const runSearch = (query, force) => {
        const q = query.trim().toUpperCase();
        if (!force && q === state.lastQuery) { log('search short-circuit: ' + q); return; }
        state.lastQuery = q;
        state.searches++;
        spinner.style.display = 'flex';
        noResults.style.display = 'none';
        later(() => {
          spinner.style.display = 'none';
          while (tbody.rows.length > 1) tbody.deleteRow(1);
          const tokens = q.split(/\s+/).filter(Boolean);
          const hits = tokens.length ? dataset.filter((f) => tokens.every((t) => f.name.toUpperCase().includes(t))) : [];
          hits.forEach((f, i) => {
            const tr = el(doc, 'tr', null, null, { tabindex: i === 0 ? '0' : '-1' });
            const nameTd = el(doc, 'td', f.source === 'Custom' ? 'source-label-custom' : null, f.name);
            const srcTd = el(doc, 'td', 'source ' + sourceClass(f), sourceLabel(f));
            tr.append(nameTd, srcTd);
            tr.dataset.foodId = String(f.id);
            tbody.append(tr);
          });
          noResults.style.display = hits.length ? 'none' : 'block';
          log('search "' + q + '": ' + hits.length + ' hits');
        }, delays.spinner);
      };
      // `jre(a){a.A=true;Pqe(a,PJh(a.Y),250,a.cb)}`: the SEARCH button sets the force flag, so a repeated query
      // from the button always re-searches; only the typed/debounced path (`kre` → `Qqe` → `Kre`) short-circuits.
      searchBtn.addEventListener('click', () => runSearch(searchInput.value, true)); // immediate, 250 results
      searchInput.addEventListener('keydown', (ev) => {
        const text = searchInput.value;
        if (ev.keyCode === 13 || text.length >= 3 || (text.length === 0 && state.lastQuery)) {
          if (debounce) win.clearTimeout(debounce);
          debounce = later(() => runSearch(searchInput.value, false), 400); // throttle level 0 → 400 ms
        }
      });
      // `$qe` (`FSk(b.a)==27&&km(a.v)`) is registered on the search FocusPanel with D$k = 'keyup': keydown 27 is a no-op.
      searchInput.addEventListener('keyup', (ev) => { if (ev.keyCode === 27) { ev.stopPropagation(); closeDialog(false); } });

      // ---- row selection (recipe §4): mousedown button 0 on a TD of a body row, or Enter on the focused row
      const selectTr = (tr) => {
        if (!tr || tr === header) return;
        for (const r of tbody.rows) r.classList.toggle('select', r === tr);
        const food = dataset.find((f) => String(f.id) === tr.dataset.foodId);
        state.selections++;
        nameLabel.textContent = 'loading...';
        setEnabled(amountWrap, false);
        setEnabled(measureDD.root, false);
        measureDD.clear();
        later(() => {
          if (!food) { nameLabel.textContent = 'ERROR'; return; }
          state.selected = food;
          nameLabel.textContent = food.name;
          macros.textContent = food.measures.length + ' listed nutrients';
          food.measures.forEach((m) => measureDD.addItem(labelFor(food, m), labelFor(food, m)));
          const def = food.measures.find((m) => m.name === food.defaultMeasure) || food.measures[0];
          measureDD.select(labelFor(food, def));
          state.measure = def;
          amountInput.value = '1';
          setEnabled(amountWrap, true);                                     // UBe: $pc(a.d,true);$pc(a.a,true)
          setEnabled(measureDD.root, true);
          // zte: `b.B==(Qaj(),Oaj)?yg(a.C,false):yg(a.C,true)` — a meal hides the whole MeasureSelector widget
          msRoot.style.display = food.hideMeasureSelector ? 'none' : '';
          log('loaded ' + food.name);
        }, delays.load);
      };
      // `Wpd`: walk up from the event target looking for a TD whose parent TR's parent is the table body;
      // reaching the body first (a mousedown targeted at the <tr>) yields null → no selection.
      const rowFromTarget = (target) => {
        for (let d = target; d; d = d.parentNode) {
          if (d.tagName === 'TD') { const tr = d.parentNode; if (tr && tr.parentNode === tbody) return tr; }
          if (d === tbody) return null;
        }
        return null;
      };
      table.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        const tr = rowFromTarget(ev.target);
        if (tr) selectTr(tr); else log('mousedown ignored (no td under the target)');
      });
      // `nDf` → `hDf`: Enter selects document.activeElement when it is a TR of this table body.
      table.addEventListener('keydown', (ev) => {
        if (ev.keyCode !== 13) return;
        const a = doc.activeElement;
        if (a && a.tagName === 'TR' && a.parentElement === tbody) selectTr(a);
      });
      table.addEventListener('click', () => { log('click on results table ignored'); });

      // ---- measure change with the 1↔100 auto-flip (recipe §5, `TBe`):
      // `b=RBe(a); !!b && amount==1 && (b.a==1&&b.k==1&&name=='g' || Weight&&b.a==1&&name=='g' || Volume&&b.a==1&&name=='ml')
      //  ? amount=100 : amount==100 && (amount=1)` — the 100 → 1 flip applies to ANY new measure; then the deferred
      // `FCe` → `XBe(a){vKh(a.a,true);SJh(a.a.g)}` only focuses the amount box and selects its text.
      measureDD.onChange = (label) => {
        const food = state.selected;
        const m = food && food.measures.find((x) => labelFor(food, x) === label);
        if (!m) return;
        const prev = state.measure;
        state.measure = m;
        const a = m.amount > 0 ? m.amount : 1;
        const isUnit1 = (a === 1 && m.grams === 1 && m.name === 'g') || (m.type === 'Weight' && a === 1 && m.name === 'g') || (m.type === 'Volume' && a === 1 && m.name === 'ml');
        const amount = parseAmount(amountInput.value);
        if (isUnit1 && amount === 1) amountInput.value = '100';
        else if (amount === 100) amountInput.value = '1';
        later(() => { try { amountInput.focus(); amountInput.select(); } catch (e) { /* headless focus can be a no-op */ } }, 0);
        log('measure ' + (prev ? prev.name : '-') + ' → ' + m.name + ', amount ' + amountInput.value);
      };
      amountInput.addEventListener('keydown', (ev) => { if (ev.keyCode === 13) addBtn.click(); });

      // ---- Add (recipe §8): hide first, then "send", then refresh the diary
      addBtn.addEventListener('click', () => {
        if (addBtn.disabled) return;
        if (o.invalidTime) {
          state.invalidTimePrompts++;
          showModal('Message', 'Enter a valid time', ['OK'], () => {});
          return; // the add is aborted, the dialog stays open (`yg(a.b,true);return`)
        }
        const food = state.selected;
        if (!food) { log('Add with no food selected: ignored'); return; }
        const qty = parseAmount(amountInput.value);
        if (qty == null) { amountInput.classList.add('invalid-input'); log('invalid amount "' + amountInput.value + '"'); return; }
        const measure = state.measure ? state.measure.name : textOf(measureDD.toggle);
        const group = state.group || textOf(groupDD.toggle);
        closeDialog(true);
        if (o.dropAdds) {
          // the real app has already hidden the dialog when updateDiary fails or is rejected: nothing appears
          later(() => { state.droppedAdds++; log('add dropped (server rejected) ' + food.name); }, delays.close + delays.refresh);
          return;
        }
        later(() => {
          // a new serving row goes after the group's existing rows, i.e. right before the next header row
          const header = headerRows.get(group) || diaryBody.rows[0];
          let after = header;
          while (after.nextElementSibling && !isHeaderRow(after.nextElementSibling)) after = after.nextElementSibling;
          const entry = el(doc, 'tr', null, null, { 'data-name': food.name });
          entry.append(el(doc, 'td', 'diary-time', ''), el(doc, 'td', 'no-left-padding', food.name), el(doc, 'td', null, qty + ' ' + measure));
          diaryBody.insertBefore(entry, after.nextElementSibling);
          state.adds++;
          state.addedIds.push(food.id);
          win.__added.push(days.on ? { name: food.name, quantity: qty, measure, group, date: days.date } : { name: food.name, quantity: qty, measure, group });
          log('added ' + food.name + ' ' + qty + ' ' + measure + ' → ' + group);
        }, delays.close + delays.refresh);
      });

      // ---- close paths: X icon, Escape (keyup 27 anywhere in the dialog body: `sm` → `Orh`; never keydown)
      cancelIcon.addEventListener('click', () => closeDialog(false));
      dlg.addEventListener('keyup', (ev) => { if (ev.keyCode === 27) closeDialog(false); });
      dlg.addEventListener('keydown', (ev) => { if (ev.keyCode === 27) log('keydown 27 ignored (the app listens for keyup)'); });

      function closeDialog(added) {
        if (!dialog || dialog.dlg !== dlg || dialog.closing) return;   // `km` twice (search keyup + body keyup) hides once
        dialog.closing = true;
        if (!added) state.closedWithoutAdd++;
        dlg.classList.add('top-slide-out');
        addBtn.disabled = true;
        later(() => { dlg.remove(); if (dialog && dialog.dlg === dlg) { dialog = null; state.dialogOpen = false; } }, delays.close);
      }
      dialog.close = closeDialog;
    }

    // BootstrapDropdown (recipe §5/§6, bundle `Eqc`/`fqc`): root div(rootClass) > label + div > div.dropdown >
    // button.dropdown-btn.dropdown-toggle + div.dropdown-menu.scrollable-dropdown > a.dropdown-item
    let ddSeq = 0;
    function bootstrapDropdown(labelledBy, rootClass) {
      const id = 'cma-mock-dd-' + (++ddSeq);
      const root = el(doc, 'div', rootClass || '');
      const inner = el(doc, 'div');
      const dd = el(doc, 'div', 'dropdown');
      const toggle = el(doc, 'button', 'gwt-Button dropdown-btn dropdown-toggle', '', { type: 'button', 'data-toggle': 'dropdown', 'aria-haspopup': 'true', 'aria-expanded': 'false', id, 'aria-labelledby': labelledBy + ' ' + id });
      const menu = el(doc, 'div', 'dropdown-menu scrollable-dropdown', null, { 'aria-labelledby': id });
      dd.append(toggle, menu);
      inner.append(dd);
      root.append(el(doc, 'label', 'label d-block d-none', 'Measure', { for: id }), inner);
      toggle.addEventListener('click', () => { menu.classList.toggle('show'); });
      const api = {
        root, dd, toggle, menu, onChange: null, ignoreClicks: false,
        addItem(label, key) {
          const a = el(doc, 'a', 'gwt-Anchor dropdown-item', label, { href: 'javascript:void(0);', 'data-key': key });
          a.style.height = '32px';
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            // an item click that does not register: `xqc` never runs, so the toggle text (what the app reads at
            // Add time) and the selection stay as they were
            if (api.ignoreClicks) { log('dropdown click ignored: ' + label); return; }
            api.select(label); menu.classList.remove('show'); if (api.onChange) api.onChange(label, key);
          });
          menu.append(a);
          return a;
        },
        select(label) { toggle.textContent = label; try { toggle.focus(); } catch (e) { /* noop */ } },
        clear() { menu.textContent = ''; toggle.textContent = ''; },
      };
      return api;
    }

    // NumberBox parse (recipe §5, `O$h`): decimals and "a/b" fractions, clamped to ±99999.
    function parseAmount(text) {
      const s = String(text == null ? '' : text).trim();
      if (!s) return null;
      let v;
      const frac = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (frac) v = Number(frac[1]) / Number(frac[2]);
      else if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) v = Number(s);
      else return null;
      if (!Number.isFinite(v)) return null;
      return Math.max(-99999, Math.min(99999, v));
    }

    // FOOD button → optional fast interstitial (recipe §1d) → dialog after 100 ms
    foodButton.addEventListener('click', () => {
      if (foodButton.disabled) return;
      if (o.fastRunning) {
        state.fastPrompts++;
        showModal('Adding a Food?', 'You currently have a fast running. Do you want to continue or stop your fast upon adding a food?',
          ['Stop Fast', 'Continue Fast'], (choice) => {
            if (choice === 'Stop Fast') o.fastRunning = false;
            if (choice) later(openAddFoodDialog, delays.open);
          });
        return;
      }
      later(openAddFoodDialog, delays.open);
    });

    // Ctrl+Enter anywhere opens the dialog when none is showing (recipe §1b, `gsd` guard)
    const onBodyKey = (ev) => { if (ev.ctrlKey && ev.keyCode === 13 && !dialog) later(openAddFoodDialog, delays.open); };
    doc.body.addEventListener('keydown', onBodyKey);

    const handle = {
      root, state, dataset, options: o, delays, labelFor, table: diaryTable,
      headerRow(name) { return headerRows.get(name) || null; },
      groupBlock(name) { const h = headerRows.get(name); return h ? h.querySelector('.diary-group') : null; },
      entries(name) { return entriesOf(name); },
      get dialog() { return dialog ? dialog.dlg : null; },
      useDays(opts) {
        const p = opts || {};
        days.on = true;
        days.delay = p.delay == null ? 150 : Math.max(0, Number(p.delay) || 0);
        days.date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.start || '')) ? String(p.start) : localIso();
        days.stash.clear();
        days.changes = 0;
        dateBtn.textContent = dayLabel(days.date);
        const seed = p.entries && typeof p.entries === 'object' ? p.entries : {};
        for (const iso of Object.keys(seed)) {
          const rows = (Array.isArray(seed[iso]) ? seed[iso] : []).map((e) => [e.group, entryRow(String(e.name), String(e.amount || ''))]);
          if (iso === days.date) rows.forEach(([g, tr]) => appendToGroup(g, tr));
          else days.stash.set(iso, rows);
        }
        log('day navigation on, ' + days.date);
        return days.date;
      },
      date() { return days.on ? days.date : null; },
      dayChanges() { return days.changes; },
      reset() {
        for (const t of timers) win.clearTimeout(t);
        timers.clear();
        for (const d of Array.from(doc.querySelectorAll('.pretty-dialog'))) d.remove();
        dialog = null;
        for (const tr of Array.from(diaryBody.rows)) if (!isHeaderRow(tr)) tr.remove();
        Object.assign(days, { on: false, date: null, changes: 0 });
        days.stash.clear();
        dateBtn.textContent = DEFAULT_DATE_LABEL;
        win.__added = [];
        Object.assign(state, { dialogOpen: false, fastPrompts: 0, searches: 0, selections: 0, adds: 0, droppedAdds: 0, closedWithoutAdd: 0, invalidTimePrompts: 0, lastQuery: null, selected: null, measure: null, group: null, addedIds: [], log: [] });
      },
      uninstall() {
        handle.reset();
        doc.body.removeEventListener('keydown', onBodyKey);
        root.remove();
      },
    };
    return handle;
  }

  window.CMA.mock = { install, DATASET, DEFAULT_GROUPS, DEFAULT_DELAYS, labelFor };
})();
