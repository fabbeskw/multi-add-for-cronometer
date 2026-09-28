/* Multi-Add for Cronometer — RPC engine (SPEC §6.4, §6.5).
 *
 * CMA.engineRpc.run(session, plan, opts, progressCb)
 *   → { added:[{row, servingId, serving, message?}], failed:[{row, error}], skipped:[{row, reason}],
 *       stopped:null|'session'|'cancelled'|'decode', lastBatch }
 *   Sequential; opts.delayMs (250) between rows; one automatic retry after
 *   opts.retryMs (3000) on NETWORK errors that cannot have reached the server
 *   (TypeError 'Failed to fetch', empty 502/503); never on a timeout (the request
 *   may have been processed — re-sending could add the food twice — so the row
 *   fails with kind 'timeout'), never on //EX or HTTP errors that carried a body
 *   (updateDiary is not idempotent); on CMA.errors.Throttled the
 *   engine backs off opts.throttleMs (5000) once and retries only when the error
 *   says the request was rejected (status 429 / retryable) — a throttle-version
 *   change on a 200 response may mean the add went through, so it is NOT retried.
 *   An //OK the registry cannot decode (rpc.js error with .applied) means the
 *   server DID add the entry: the row counts as added without an id and the batch
 *   stops with 'decode' so the user checks the diary instead of re-adding.
 *   Stops the batch on CMA.errors.Session. Afterwards refreshes the diary (§6.5)
 *   and stores lastBatch = {date, servingIds, at} in memory + chrome.storage.local.
 *   opts.sessionProvider (function) is re-read before every request so a nonce
 *   rotated by the app's reauthenticate mid-batch is used (SPEC 2.1).
 * CMA.engineRpc.undo(session, lastBatch, opts, progressCb)
 *   → { removed:[ids], failed:[{id, error}] }   (removeServing per id, sequential)
 * CMA.engineRpc.refreshDiary(opts) → { method:'nav'|'hash'|'none', verified:boolean, hashFlip?:true }
 * CMA.engineRpc.loadLastBatch() → Promise<lastBatch|null>   (from chrome.storage.local)
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;
  const STORAGE_KEY = 'cmaLastBatch';

  function sleep(ms) {
    if (CMA.dom && typeof CMA.dom.sleep === 'function') return CMA.dom.sleep(ms);
    return new Promise(r => setTimeout(r, Math.max(0, ms | 0)));
  }
  function safeCb(cb, evt) {
    if (typeof cb !== 'function') return;
    try { cb(evt); } catch (e) { /* never let UI callbacks break the batch */ }
  }
  function errMessage(e) {
    if (!e) return 'unknown error';
    const m = e.message || String(e);
    // Redact anything that looks like a token (SPEC §0: the nonce never reaches logs).
    return String(m).replace(/[A-Za-z0-9+\/=_-]{32,}/g, '[redacted]');
  }
  function opt(opts, key, dflt) { return opts && opts[key] != null ? opts[key] : dflt; }
  function rowsOf(plan) {
    if (Array.isArray(plan)) return plan;
    return plan && Array.isArray(plan.rows) ? plan.rows : [];
  }
  /**
   * A function returning the session to use for the next request: opts.sessionProvider when given (the panel
   * passes CMA.capture.session, so a nonce rotated by reauthenticate during a long batch is picked up), else
   * the snapshot passed to run()/undo().
   */
  function sessionSource(session, opts) {
    const provider = opts && typeof opts.sessionProvider === 'function' ? opts.sessionProvider : null;
    return () => {
      if (provider) { try { const s = provider(); if (s && typeof s === 'object') return s; } catch (e) { /* keep the snapshot */ } }
      return session;
    };
  }

  // ---------------------------------------------------------------------------
  // chrome.storage.local persistence (guarded: tests and plain pages have no chrome.storage)
  // ---------------------------------------------------------------------------
  function hasStorage() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.storage && !!chrome.storage.local;
    } catch (e) { return false; }
  }
  function storageSet(obj) {
    return new Promise(resolve => {
      if (!hasStorage()) return resolve(false);
      try {
        const r = chrome.storage.local.set(obj, () => resolve(true));
        if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
      } catch (e) { resolve(false); }
    });
  }
  function storageGet(key) {
    return new Promise(resolve => {
      if (!hasStorage()) return resolve(null);
      try {
        const done = res => resolve(res && res[key] != null ? res[key] : null);
        const r = chrome.storage.local.get(key, done);
        if (r && typeof r.then === 'function') r.then(done, () => resolve(null));
      } catch (e) { resolve(null); }
    });
  }

  const engine = {
    lastBatch: null,
    /** Last refreshDiary outcome, for diagnostics. */
    lastRefresh: null
  };

  async function saveLastBatch(batch) {
    engine.lastBatch = batch;
    // ids only + date + timestamp; never the session (SPEC §6.4).
    const stored = { date: batch.date, servingIds: batch.servingIds.slice(), at: batch.at, count: batch.servingIds.length, userId: batch.userId == null ? null : batch.userId };
    await storageSet({ [STORAGE_KEY]: stored });
    return batch;
  }
  async function loadLastBatch() {
    if (engine.lastBatch) return engine.lastBatch;
    const b = await storageGet(STORAGE_KEY);
    if (b && Array.isArray(b.servingIds)) engine.lastBatch = b;
    return engine.lastBatch;
  }
  async function clearLastBatch() {
    engine.lastBatch = null;
    await storageSet({ [STORAGE_KEY]: null });
  }

  // ---------------------------------------------------------------------------
  // One add with the retry policy of SPEC §6.4.
  // ---------------------------------------------------------------------------
  async function addOnce(sessionNow, serving, o, row, progressCb) {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await CMA.rpc.updateDiaryAdd(sessionNow(), serving);
      } catch (e) {
        if (e && e.kind === 'session') throw e;
        // //OK that could not be decoded: the server executed the add; never re-send (rpc.js sets .applied).
        if (e && e.applied === true) throw e;
        if (attempt >= 2) throw e;
        if (e && e.kind === 'throttled') {
          safeCb(progressCb, { phase: 'throttled', row, message: 'throttled; backing off ' + o.throttleMs + ' ms' });
          await sleep(o.throttleMs);
          // Retry only if the server rejected the request (HTTP 429) or rpc.js marked it retryable.
          if (e.status === 429 || e.retryable === true) continue;
          throw e;
        }
        if (e && e.timeout === true) {
          // rpc.fetchText turns the AbortController timeout into a Network error with .timeout; the request
          // may well have reached the server (a slow response under throttling is exactly when a batch is
          // stressing it), so re-sending updateDiary could add the food twice. Fail the row instead.
          const t = new Error('timed out waiting for the server — check the diary before re-adding this food (' + errMessage(e) + ')');
          t.kind = 'timeout'; t.cause = e;
          throw t;
        }
        if (CMA.errors.isNetwork(e)) {
          safeCb(progressCb, { phase: 'retry', row, message: 'network error; retrying in ' + o.retryMs + ' ms' });
          await sleep(o.retryMs);
          continue;
        }
        throw e; // //EX or HTTP error with a body: non-idempotent, never retried
      }
    }
  }

  /**
   * CMA.engineRpc.run — SPEC §6.4.
   */
  async function run(session, plan, opts, progressCb) {
    if (!CMA.rpc || typeof CMA.rpc.updateDiaryAdd !== 'function') throw new Error('CMA.rpc.updateDiaryAdd is not available');
    if (!CMA.plan || typeof CMA.plan.servingFor !== 'function') throw new Error('CMA.plan is not loaded');
    const o = {
      delayMs: opt(opts, 'delayMs', 250),
      retryMs: opt(opts, 'retryMs', 3000),
      throttleMs: opt(opts, 'throttleMs', 5000),
      refresh: opt(opts, 'refresh', true),
      refreshOpts: opt(opts, 'refreshOpts', null),
      isCancelled: typeof (opts && opts.isCancelled) === 'function' ? opts.isCancelled : () => false
    };
    const sessionNow = sessionSource(session, opts);
    const rows = rowsOf(plan);
    const date = (plan && !Array.isArray(plan) && plan.date) || opt(opts, 'date', null) || CMA.plan.todayDate();
    const result = { added: [], failed: [], skipped: [], stopped: null, lastBatch: null };
    // Unverified rows (built for the UI engine without a session) carry no measure id: never send them.
    const ready = rows.filter(r => r && r.status === 'ready' && !r.unverified);
    for (const r of rows) if (r && (r.status !== 'ready' || r.unverified)) result.skipped.push({ row: r, reason: r.unverified ? 'unverified row (UI engine only)' : (r.message || r.status) });

    let first = true;
    for (let i = 0; i < ready.length; i++) {
      const row = ready[i];
      if (result.stopped) { result.skipped.push({ row, reason: 'not attempted (' + result.stopped + ')' }); continue; }
      if (o.isCancelled()) { result.stopped = 'cancelled'; result.skipped.push({ row, reason: 'not attempted (cancelled)' }); continue; }
      if (!first) await sleep(o.delayMs);
      first = false;

      let serving;
      try {
        serving = CMA.plan.servingFor(row, date);
      } catch (e) {
        result.failed.push({ row, error: errMessage(e) });
        safeCb(progressCb, { phase: 'row', index: i, total: ready.length, row, ok: false, message: errMessage(e) });
        continue;
      }
      safeCb(progressCb, { phase: 'adding', index: i, total: ready.length, row, message: 'adding ' + (row.hit ? row.hit.name : '') });
      try {
        const res = await addOnce(sessionNow, serving, o, row, progressCb);
        const servingId = res && res.servingId != null ? String(res.servingId) : null;
        result.added.push({ row, servingId, serving: res && res.serving ? res.serving : serving });
        row.result = { ok: true, servingId };
        safeCb(progressCb, { phase: 'row', index: i, total: ready.length, row, ok: true, servingId });
      } catch (e) {
        if (e && e.applied === true) {
          // The server answered //OK (the entry is in the diary) but the reply could not be decoded — the
          // registry is stale. Count the row as added (no id, so no Undo for it) and stop: every further
          // add would end the same way, and a "failed" verdict would steer the user into duplicate adds.
          const message = 'added; the reply could not be read (registry stale) — no undo id';
          result.added.push({ row, servingId: null, serving, message });
          row.result = { ok: true, servingId: null, message };
          result.stopped = 'decode';
          safeCb(progressCb, { phase: 'row', index: i, total: ready.length, row, ok: true, servingId: null, message });
          continue;
        }
        const msg = errMessage(e);
        result.failed.push({ row, error: msg, kind: e && e.kind ? e.kind : null });
        row.result = { ok: false, error: msg };
        safeCb(progressCb, { phase: 'row', index: i, total: ready.length, row, ok: false, message: msg });
        if (e && e.kind === 'session') result.stopped = 'session';
      }
    }

    const servingIds = result.added.map(a => a.servingId).filter(id => id != null);
    if (servingIds.length) {
      const batch = {
        date, at: Date.now(),
        // the account the ids belong to: the panel offers Undo only to that user (and only for 24 h)
        userId: session && session.userId != null ? Number(session.userId) : null,
        servingIds
      };
      result.lastBatch = await saveLastBatch(batch);
    }
    if (o.refresh && result.added.length) {
      try {
        safeCb(progressCb, { phase: 'refresh', message: 'refreshing diary' });
        result.refresh = await refreshDiary(Object.assign({ date }, o.refreshOpts || {}));
      } catch (e) {
        result.refresh = { method: 'none', verified: false, error: errMessage(e) };
      }
    }
    safeCb(progressCb, { phase: 'done', result });
    return result;
  }

  /**
   * CMA.engineRpc.undo — removeServing for each id, sequential (SPEC §6.4).
   */
  async function undo(session, lastBatch, opts, progressCb) {
    if (!CMA.rpc || typeof CMA.rpc.removeServing !== 'function') throw new Error('CMA.rpc.removeServing is not available');
    const batch = lastBatch || engine.lastBatch;
    const ids = batch && Array.isArray(batch.servingIds) ? batch.servingIds.slice() : [];
    const o = { delayMs: opt(opts, 'delayMs', 250), refresh: opt(opts, 'refresh', true), refreshOpts: opt(opts, 'refreshOpts', null) };
    const sessionNow = sessionSource(session, opts);
    const result = { removed: [], failed: [], dropped: [], stopped: null };
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (result.stopped) { result.failed.push({ id, error: 'not attempted (' + result.stopped + ')' }); continue; }
      if (i > 0) await sleep(o.delayMs);
      safeCb(progressCb, { phase: 'removing', index: i, total: ids.length, id });
      try {
        await CMA.rpc.removeServing(sessionNow(), String(id));
        result.removed.push(id);
        safeCb(progressCb, { phase: 'row', index: i, total: ids.length, id, ok: true });
      } catch (e) {
        const kind = e && e.kind ? e.kind : null;
        result.failed.push({ id, error: errMessage(e), kind });
        // A server-side rejection (//EX, ErrorEntryChangeResult, HTTP error with a body, stale registry) is
        // final — typically the entry was already deleted by hand — so the id is forgotten; network, throttle
        // and session failures keep it for a later retry.
        if (kind === 'rpc' || kind === 'rejected' || kind === 'http' || kind === 'incompatible') result.dropped.push(id);
        safeCb(progressCb, { phase: 'row', index: i, total: ids.length, id, ok: false, message: errMessage(e) });
        if (e && e.kind === 'session') result.stopped = 'session';
      }
    }
    if (batch) {
      // keep only the ids that may still be in the diary
      const remaining = ids.filter(id => result.removed.indexOf(id) < 0 && result.dropped.indexOf(id) < 0);
      if (remaining.length === 0) await clearLastBatch();
      else await saveLastBatch({ date: batch.date, at: batch.at, userId: batch.userId, servingIds: remaining });
    }
    if (o.refresh && result.removed.length) {
      try { result.refresh = await refreshDiary(Object.assign({ date: batch && batch.date }, o.refreshOpts || {})); }
      catch (e) { result.refresh = { method: 'none', verified: false, error: errMessage(e) }; }
    }
    safeCb(progressCb, { phase: 'done', result });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Diary refresh (SPEC §6.5). The app only updates the diary from its own
  // updateDiary responses (live-app-report.md §7), so navigate away and back:
  // click `.diary-date-previous`, wait, click `.diary-date-next`, wait (each
  // click triggers getDayInfo). When the clicks produced no getDayInfo for the
  // target date (a hidden/other panel's nav — ClientDiaryDate also uses the
  // 'diary-date-previous' class — or the nav elements are absent), flip the hash
  // `#dashboard` → `#diary` (History handler re-fires ViewDailyReportEvent).
  // ---------------------------------------------------------------------------
  function isVisible(el) {
    try {
      if (CMA.dom && typeof CMA.dom.isVisible === 'function') return CMA.dom.isVisible(el);
      return !!el && el.isConnected && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    } catch (e) { return true; }
  }
  /** The element to click: the first VISIBLE match inside `.diary-panel`, else the first visible match anywhere, else the first match. */
  function navElement(sel, doc) {
    let list = [];
    try { list = Array.from(doc.querySelectorAll('.diary-panel ' + sel)); } catch (e) { list = []; }
    let el = list.find(isVisible);
    if (el) return el;
    try { list = Array.from(doc.querySelectorAll(sel)); } catch (e) { list = []; }
    return list.find(isVisible) || list[0] || null;
  }
  function clickEl(sel, root) {
    const doc = root || document;
    const el = navElement(sel, doc);
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      el.click();
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }

  function captureMark() {
    try {
      const s = CMA.capture && CMA.capture.state;
      if (!s) return null;
      return { lastRpcAt: s.lastRpcAt || 0, rpcCount: s.rpcCount || 0, diaryDate: s.diaryDate ? JSON.stringify(s.diaryDate) : null };
    } catch (e) { return null; }
  }
  function captureVerified(before, date) {
    const after = captureMark();
    if (!before || !after) return false;
    if (after.rpcCount > before.rpcCount || after.lastRpcAt > before.lastRpcAt) {
      if (date && after.diaryDate) {
        try {
          const d = JSON.parse(after.diaryDate);
          return Number(d.day) === Number(date.day) && Number(d.month) === Number(date.month) && Number(d.year) === Number(date.year);
        } catch (e) { return true; }
      }
      return true;
    }
    return false;
  }

  async function refreshDiary(opts) {
    const o = {
      waitMs: opt(opts, 'waitMs', 1200),
      hashWaitMs: opt(opts, 'hashWaitMs', 300),
      date: opt(opts, 'date', null),
      root: opt(opts, 'root', null),
      prevSel: opt(opts, 'prevSel', '.diary-date-previous'),
      nextSel: opt(opts, 'nextSel', '.diary-date-next')
    };
    const doc = o.root || (typeof document !== 'undefined' ? document : null);
    const out = { method: 'none', verified: false, clicks: 0 };
    if (!doc) { engine.lastRefresh = out; return out; }
    const before = captureMark();

    const hasPrev = !!navElement(o.prevSel, doc);
    const hasNext = !!navElement(o.nextSel, doc);
    if (hasPrev && hasNext) {
      out.method = 'nav';
      if (clickEl(o.prevSel, doc)) out.clicks++;
      await sleep(o.waitMs);
      // the diary may have re-rendered: query again
      if (clickEl(o.nextSel, doc)) out.clicks++;
      await sleep(o.waitMs);
      out.verified = captureVerified(before, o.date);
      // Only a getDayInfo for the target date proves the clicks reloaded the diary; otherwise fall through.
      if (out.clicks === 2 && out.verified) { engine.lastRefresh = out; return out; }
    }

    // Fallback: hash flip (live-app-report.md §7, medium confidence). The entries were added to the DIARY,
    // so always come back to #diary — restoring #foods/#settings would never reload the diary.
    try {
      if (typeof location !== 'undefined') {
        if (out.method === 'nav') out.hashFlip = true; else out.method = 'hash';
        location.hash = '#dashboard';
        await sleep(o.hashWaitMs);
        location.hash = '#diary';
        await sleep(o.waitMs);
        out.verified = captureVerified(before, o.date);
      }
    } catch (e) {
      out.error = errMessage(e);
    }
    engine.lastRefresh = out;
    return out;
  }

  engine.run = run;
  engine.undo = undo;
  engine.refreshDiary = refreshDiary;
  engine.loadLastBatch = loadLastBatch;
  engine.saveLastBatch = saveLastBatch;
  engine.clearLastBatch = clearLastBatch;
  engine.STORAGE_KEY = STORAGE_KEY;
  engine._sleep = sleep;
  CMA.engineRpc = engine;
})();
