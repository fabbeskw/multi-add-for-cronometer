/* registry-store.js - keeps the GWT type registry in step with the live Cronometer build (SPEC section 3.5).
 *
 * ISOLATED world, loaded right after gwt-stream.js and registry-builder.js. Cronometer redeploys often (a new
 * X-GWT-Permutation every time) and a deploy may change type CRCs or layouts; src/lib/gwt-registry.js is
 * generated offline for ONE build. CMA.registryBuilder (src/lib/registry-builder.js) fetches the live bundle
 * from cronometer.com (same origin) and builds a registry with the generated file's shape; this store keeps
 * ONE such registry in chrome.storage.local, installs it as CMA.registry when the live permutation matches
 * it, and rebuilds it when capture.js reports a mismatch (or the user asks).
 *
 *   CMA.registryStore = {
 *     bundled, stored,           the generated registry (captured at load) | null or the storage record
 *     init() -> Promise<status>  reads chrome.storage.local['cmaRegistry'] (+ the last attempt) into memory,
 *                                never activates by itself; resolves within INIT_TIMEOUT_MS (500 ms) even
 *                                when storage is slow or absent (a late record is still adopted). A record
 *                                from another extension version / schema, or one the builder's validate()
 *                                rejects, is ignored AND removed: an update rebuilds instead of trusting it.
 *     activate(permutation) -> {source:'runtime'|'bundled', changed, permutation}   synchronous, idempotent
 *                                stored.registry when its permutation matches, else the bundled one, which is
 *                                the reference for ITS OWN build; on a change: CMA.gwt.reloadRegistry() +
 *                                CMA.events 'registry'.
 *     rebuild({moduleBase, permutation, reason, force}) -> Promise<{ok, source, ms, bytes, fragments, types,
 *                                warnings, problems, error, permutation, reason, persisted, truncated, refused?}>
 *                                fetchBundle -> build -> validate -> store -> activate. Single-flight
 *                                (inFlight() exposes the running promise; it is released BEFORE the final
 *                                'registry-progress' event, so a listener rendering from that event sees the
 *                                settled state); without `force` a permutation attempted < RATE_LIMIT_MS
 *                                (10 min) ago in this page, or whose persisted last attempt
 *                                ('cmaRegistryAttempt') is a COMPLETED failure, is refused ('recently
 *                                attempted'; an interrupted or an unsaved attempt never blocks). A failure
 *                                keeps the current registry; every run is recorded as lastRebuild, logged via
 *                                CMA.capture.log('registry', ...) and reported through 'registry-progress'
 *                                events; every chrome.storage write is bounded (STORAGE_TIMEOUT_MS).
 *     status()                   {active, activePermutation, activeTypes, activeRegistryPermutation,
 *                                bundledPermutation, storedPermutation, storedAt, storedTypes, inProgress,
 *                                inProgressPermutation, progress, lastRebuild, lastAttempt, lastRefusal,
 *                                builderLoaded, builderVersion, initDone, init}
 *     inFlight() -> Promise|null, forget() -> Promise<boolean> (drops the record + attempt, back to bundled)
 *   }
 * A record another tab stores is adopted through chrome.storage.onChanged. Nothing here touches the session
 * (the registry describes types, never data) and only same-origin URLs are fetched (SPEC 0). Keep this header
 * short: tools/check_manifest.py wants the guard within 4000 chars.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;

  const STORAGE_KEY = 'cmaRegistry';
  const ATTEMPT_KEY = 'cmaRegistryAttempt';   // {permutation, at, ok, error, reason, ms, builder, persisted}: the last real attempt
  const RECORD_SCHEMA = 1;                     // bump when the stored record's shape changes
  const INIT_TIMEOUT_MS = 500;
  const STORAGE_TIMEOUT_MS = 5000;             // bound on every chrome.storage write / remove: a callback that never comes must not hang a rebuild
  const RATE_LIMIT_MS = 10 * 60 * 1000;
  const MAX_LOGGED_WARNINGS = 5;     // builder warnings logged one by one; the rest as a count (capture.log is a ring buffer)
  const PAGE_IS_HTTP = typeof location !== 'undefined' && /^https?:\/\//.test(String(location.origin || ''));
  // The extension version stamps every record: a registry built by another version's builder (or validated
  // against another version's expectations) is never trusted after an update - it is rebuilt instead.
  const BUILDER_VERSION = (function () {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        const v = chrome.runtime.getManifest().version;
        if (v) return String(v);
      }
    } catch (e) { /* not an extension context */ }
    return 'dev';
  })();

  // ------------------------------------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------------------------------------
  // gwt-registry.js precedes this file, so CMA.registry is the generated registry - unless this script is
  // evaluated again while a runtime registry is installed (test pages reload it): keep the previous bundled one.
  const bundled = (function () {
    const r = CMA.registry && CMA.registry.types ? CMA.registry : null;
    const prev = CMA.registryStore && CMA.registryStore.bundled && CMA.registryStore.bundled.types ? CMA.registryStore.bundled : null;
    return r && r.source !== 'runtime' ? r : (prev || r);
  })();
  const bundledPermutation = bundled && bundled.permutation ? normPerm(bundled.permutation) : null;
  let stored = null;                 // {permutation, registry, builtAt, bytes, fragments, builder, schema}
  let active = 'bundled';            // which registry CMA.registry currently is
  let activePermutation = null;      // the permutation activate() was last called with
  let initPromise = null;
  let initDone = false;
  let initInfo = null;               // {how:'loaded'|'empty'|'timeout'|'error'|'no-storage', at, error?, late?}
  let inProgress = null;             // the running rebuild promise
  let inProgressPermutation = null;
  let lastProgress = null;           // the last 'registry-progress' payload (for the panel's banner)
  let lastRebuild = null;            // {at, ok, ms, bytes, fragments, types, warnings, problems, error, reason, permutation, persisted, truncated}
  let lastAttempt = null;            // {permutation, at, ok, error, reason, ms, builder, persisted}: memory copy of ATTEMPT_KEY
  let lastRefusal = null;            // {permutation, reason, error, at}: the last rebuild() the store refused (the panel explains a skipped automatic attempt)
  const attempts = new Map();        // permutation -> Date.now() of the last attempt in THIS page (rate limit)

  // ------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------
  function normPerm(p) {
    if (typeof p !== 'string') return null;
    const s = p.trim().toUpperCase();
    return s ? s : null;
  }
  function typesOf(reg) { return reg && reg.types && typeof reg.types === 'object' ? Object.keys(reg.types).length : 0; }
  function errText(e) { return e && e.message ? String(e.message) : String(e); }
  function log(fields) {
    try { if (CMA.capture && typeof CMA.capture.log === 'function') CMA.capture.log('registry', fields); } catch (e) { /* ignore */ }
  }
  function emit(name, payload) {
    try { if (CMA.events && typeof CMA.events.emit === 'function') CMA.events.emit(name, payload); } catch (e) { /* ignore */ }
  }
  function reloadGwt() {
    try { if (CMA.gwt && typeof CMA.gwt.reloadRegistry === 'function') CMA.gwt.reloadRegistry(); } catch (e) { /* ignore */ }
  }
  function builder() {
    const b = CMA.registryBuilder;
    return b && typeof b.build === 'function' && typeof b.fetchBundle === 'function' ? b : null;
  }
  function originOf(url) { try { return new URL(String(url)).origin; } catch (e) { return null; } }
  /**
   * Why a stored record must not be used, or null when it is fine: the shape (permutation + a registry with
   * types for it), the stamp (schema + builder version: another version rebuilds instead of trusting an old
   * build's output) and the builder's own validation bar (a corrupted or partial record is never activated).
   */
  function recordProblem(rec) {
    if (!rec || typeof rec !== 'object') return 'unusable record';
    const perm = normPerm(rec.permutation);
    const reg = rec.registry;
    if (!perm || !reg || typeof reg !== 'object' || !reg.types || typeof reg.types !== 'object') return 'unusable record';
    if (typesOf(reg) === 0) return 'unusable record';
    if (reg.permutation && normPerm(reg.permutation) !== perm) return 'unusable record';
    if (rec.schema !== RECORD_SCHEMA) return 'record schema ' + rec.schema + ' (this version writes ' + RECORD_SCHEMA + ')';
    if (rec.builder !== BUILDER_VERSION) return 'built by extension ' + rec.builder + ' (this is ' + BUILDER_VERSION + ')';
    const b = builder();
    if (b && typeof b.validate === 'function') {
      let v = null;
      try { v = b.validate(reg); } catch (e) { return 'fails validation: ' + errText(e); }
      if (!v || !v.ok) return 'fails validation: ' + (v && Array.isArray(v.problems) && v.problems.length ? v.problems.slice(0, 3).join('; ') : 'unknown problem');
    }
    return null;
  }
  function normalizeRecord(rec) {
    const reg = rec.registry;
    reg.source = 'runtime';                                     // CMA.gwt.registryInfo() reports it
    reg.permutation = normPerm(rec.permutation);
    return {
      permutation: reg.permutation,
      registry: reg,
      builtAt: typeof rec.builtAt === 'number' ? rec.builtAt : null,
      bytes: typeof rec.bytes === 'number' ? rec.bytes : null,
      fragments: typeof rec.fragments === 'number' ? rec.fragments : null,
      builder: rec.builder,
      schema: rec.schema,
    };
  }
  function normalizeAttempt(a) {
    if (!a || typeof a !== 'object' || typeof a.at !== 'number' || !normPerm(a.permutation)) return null;
    if (a.builder !== BUILDER_VERSION) return null;            // another version's outcome never blocks this one
    return { permutation: normPerm(a.permutation), at: a.at, ok: a.ok === true ? true : a.ok === false ? false : null,
      error: a.error == null ? null : String(a.error), reason: a.reason == null ? null : String(a.reason),
      ms: typeof a.ms === 'number' ? a.ms : null, builder: a.builder,
      persisted: a.persisted === true ? true : a.persisted === false ? false : null };
  }

  // ------------------------------------------------------------------------------------------------
  // chrome.storage.local (guarded: absent on plain test pages; callback and promise APIs). Every callback
  // reads chrome.runtime.lastError: an unread error is logged by Chrome as "Unchecked runtime.lastError" and
  // would make a failed read look like an empty store.
  // ------------------------------------------------------------------------------------------------
  function storage() {
    try { return typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
    catch (e) { return null; }
  }
  function lastError() {
    try {
      const e = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
      return e ? String(e.message || e) : null;
    } catch (e) { return null; }
  }
  /** -> Promise<{ok, value:{key: v}, error}>; never rejects. */
  function storageGet(keys) {
    return new Promise(function (resolve) {
      const s = storage();
      if (!s) return resolve({ ok: false, value: {}, error: 'no chrome.storage' });
      let done = false;
      const finish = function (v, err) { if (!done) { done = true; resolve(err ? { ok: false, value: {}, error: err } : { ok: true, value: v && typeof v === 'object' ? v : {}, error: null }); } };
      try {
        const r = s.get(keys, function (v) { finish(v, lastError()); });
        if (r && typeof r.then === 'function') r.then(function (v) { finish(v, null); }, function (e) { finish(null, errText(e)); });
      } catch (e) { finish(null, errText(e)); }
    });
  }
  /** -> Promise<boolean>; never rejects, and resolves false after STORAGE_TIMEOUT_MS when the callback never
   *  comes (init() bounds its read the same way): a rebuild's outcome must never depend on a storage callback. */
  function storageSet(obj) {
    return new Promise(function (resolve) {
      const s = storage();
      if (!s) return resolve(false);
      let done = false;
      const finish = function (okv) { if (!done) { done = true; clearTimeout(timer); resolve(!!okv); } };
      const timer = setTimeout(function () { finish(false); }, STORAGE_TIMEOUT_MS);
      try {
        const r = s.set(obj, function () { finish(!lastError()); });
        if (r && typeof r.then === 'function') r.then(function () { finish(true); }, function () { finish(false); });
      } catch (e) { finish(false); }
    });
  }
  function storageRemove(keys) {
    return new Promise(function (resolve) {
      const s = storage();
      if (!s || typeof s.remove !== 'function') return resolve(false);
      let done = false;
      const finish = function (okv) { if (!done) { done = true; clearTimeout(timer); resolve(!!okv); } };
      const timer = setTimeout(function () { finish(false); }, STORAGE_TIMEOUT_MS);
      try {
        const r = s.remove(keys, function () { finish(!lastError()); });
        if (r && typeof r.then === 'function') r.then(function () { finish(true); }, function () { finish(false); });
      } catch (e) { finish(false); }
    });
  }
  /** Drop a stored record that must not be used (fire and forget; a failed remove is overwritten with null). */
  function dropStoredRecord() {
    storageRemove([STORAGE_KEY]).then(function (removed) { if (!removed) return storageSet({ [STORAGE_KEY]: null }); }).catch(function () { /* ignore */ });
  }

  // ------------------------------------------------------------------------------------------------
  // init: load the stored registry into memory (no activation: the live permutation is not known yet)
  // ------------------------------------------------------------------------------------------------
  function adoptStored(rec, how, keepBad) {
    const problem = recordProblem(rec);
    if (problem) {
      if (rec !== undefined && rec !== null) {
        log({ note: (keepBad ? 'record stored by ' + how + ' ignored: ' : 'stored registry ignored (' + how + '): ') + problem + (normPerm(rec && rec.permutation) ? ' [build ' + normPerm(rec.permutation) + ']' : '') });
        if (!keepBad) dropStoredRecord();                       // never offered again; a rebuild replaces it
      }
      return false;
    }
    stored = normalizeRecord(rec);
    log({ note: 'stored decoder loaded (' + how + '): build ' + stored.permutation + ', ' + typesOf(stored.registry) + ' types' + (stored.builtAt ? ', built ' + new Date(stored.builtAt).toISOString() : '') });
    // capture may already have learned the permutation (an early DOM probe, or storage answering after the
    // timeout): install the record now, which emits 'registry' so capture re-evaluates the mismatch.
    if (activePermutation) activate(activePermutation);
    return true;
  }
  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve) {
      let settled = false;
      const finish = function (how, error) {
        if (settled) return;
        settled = true;
        initDone = true;
        initInfo = { how: how, at: Date.now() };
        if (error) initInfo.error = error;
        resolve(status());
      };
      if (!storage()) { finish('no-storage'); return; }
      const timer = setTimeout(function () { finish('timeout'); }, INIT_TIMEOUT_MS);
      storageGet([STORAGE_KEY, ATTEMPT_KEY]).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          log({ note: 'chrome.storage read failed: ' + r.error });
          if (settled && initInfo) initInfo.late = 'error';
          finish('error', r.error);
          return;
        }
        lastAttempt = normalizeAttempt(r.value[ATTEMPT_KEY]) || lastAttempt;
        let adopted = false;
        try { adopted = adoptStored(r.value[STORAGE_KEY], settled ? 'late' : 'storage'); } catch (e) { log({ note: 'stored registry could not be adopted: ' + errText(e) }); }
        if (settled && initInfo) initInfo.late = adopted ? 'loaded' : 'empty';
        finish(adopted ? 'loaded' : 'empty');
      });
    });
    return initPromise;
  }

  /**
   * Another Cronometer tab may finish its rebuild first (or an earlier one may still be rebuilding when this
   * page loads): adopt the record it stores. chrome.storage.onChanged fires in every extension context, the
   * writer's own included, so a record this page already holds - its own write echoing back - is ignored, as is
   * a record for the build this page is rebuilding right now (its own run ends with the same record) and a
   * removal elsewhere (forget() in another tab keeps this page's memory copy). A record this version must not
   * use is ignored but NOT removed: it is the other tab's. A store instance that was re-evaluated (test pages)
   * ignores the event once it is no longer CMA.registryStore.
   */
  function watchStorage(self) {
    try {
      const ev = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged;
      if (!ev || typeof ev.addListener !== 'function') return false;
      ev.addListener(function (changes, area) {
        try {
          if (CMA.registryStore !== self) return;
          if (area && area !== 'local') return;
          const ch = changes && changes[STORAGE_KEY];
          const rec = ch && ch.newValue;
          if (!rec || typeof rec !== 'object') return;
          const perm = normPerm(rec.permutation);
          if (!perm) return;
          if (stored && stored.permutation === perm && stored.builtAt === rec.builtAt) return;
          if (inProgress && inProgressPermutation === perm) return;
          adoptStored(rec, 'another tab', true);
        } catch (e) { /* never throw into the storage event */ }
      });
      return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------------------------------------------
  // activate: choose the registry for a live permutation (synchronous, idempotent)
  // ------------------------------------------------------------------------------------------------
  function activate(permutation) {
    const perm = normPerm(permutation);
    if (perm) activePermutation = perm;
    // The shipped, offline-generated registry is the reference for its own build: a runtime record for the
    // same permutation (built by an older builder, or by hand from Diagnostics) never replaces it.
    const useStored = !!(perm && stored && stored.permutation === perm && stored.registry && perm !== bundledPermutation);
    const next = useStored ? stored.registry : bundled;
    const source = useStored ? 'runtime' : 'bundled';
    if (!next) return { source: source, changed: false, permutation: perm };   // nothing to install (no registry at all)
    const changed = CMA.registry !== next;
    if (changed) {
      CMA.registry = next;
      reloadGwt();                                              // sigCache / boxCache / SIG getters
      active = source;
      const info = { source: source, permutation: perm, registryPermutation: next.permutation ? normPerm(next.permutation) : null, types: typesOf(next), changed: true };
      log({ note: 'decoder switched to the ' + source + ' registry (build ' + (info.registryPermutation || '?') + ', ' + info.types + ' types) for live build ' + (perm || '?') });
      emit('registry', info);
    } else {
      active = source;
    }
    return { source: source, changed: changed, permutation: perm };
  }

  // ------------------------------------------------------------------------------------------------
  // rebuild: fetch the live bundle, build, validate, store, activate
  // ------------------------------------------------------------------------------------------------
  function progress(perm, reason, payload) {
    const p = Object.assign({ permutation: perm, reason: reason, t: Date.now() }, payload || {});
    lastProgress = p;
    emit('registry-progress', p);
    return p;
  }
  function record(out) {
    lastRebuild = Object.assign({ at: Date.now() }, out);
    return out;
  }
  function refused(perm, reason, error) {
    // a refusal is logged and exposed as status().lastRefusal (the panel explains a skipped automatic attempt)
    // but never overwrites the outcome of a real attempt (diagnostics keep the useful one)
    lastRefusal = { permutation: perm, reason: reason, error: error, at: Date.now() };
    log({ note: 'rebuild refused (' + reason + '): ' + error });
    return Promise.resolve({ ok: false, source: active, ms: 0, bytes: null, fragments: null, types: null, warnings: 0, problems: [], error: error, permutation: perm, reason: reason, persisted: false, truncated: false, refused: true });
  }
  /** Persist the attempt (memory + ATTEMPT_KEY) so a page reload within RATE_LIMIT_MS does not download again. */
  function noteAttempt(fields) {
    lastAttempt = Object.assign({ permutation: null, at: Date.now(), ok: null, error: null, reason: null, ms: null, builder: BUILDER_VERSION, persisted: null }, lastAttempt && lastAttempt.permutation === fields.permutation ? lastAttempt : {}, fields);
    return storageSet({ [ATTEMPT_KEY]: lastAttempt });
  }
  function rebuild(opts) {
    opts = opts || {};
    const reason = typeof opts.reason === 'string' && opts.reason ? opts.reason : 'manual';
    const perm = normPerm(opts.permutation);
    if (inProgress) return inProgress;                          // single flight
    const t0 = Date.now();
    if (!perm) return refused(perm, reason, 'no permutation');
    const moduleBase = typeof opts.moduleBase === 'string' ? opts.moduleBase.trim() : '';
    if (!/^https?:\/\/.+\/$/.test(moduleBase) && !(!PAGE_IS_HTTP && /^[a-z][a-z0-9+.-]*:.*\/$/i.test(moduleBase))) {
      return refused(perm, reason, 'no module base');
    }
    if (PAGE_IS_HTTP && originOf(moduleBase) !== location.origin) return refused(perm, reason, 'module base on a foreign origin (' + originOf(moduleBase) + ')');   // SPEC 0
    const b = builder();
    if (!b) return refused(perm, reason, 'registry builder not loaded');
    if (!opts.force) {
      const last = attempts.get(perm);
      if (last !== undefined && t0 - last < RATE_LIMIT_MS) return refused(perm, reason, 'recently attempted');
      // the last attempt of an earlier page load (persisted): a COMPLETED failure (validation, a 5xx) must not
      // download the bundle again on every reload; the manual button passes force. An attempt that never
      // finished (the tab was reloaded during the download: ok null) or a success whose registry could not be
      // saved (ok true, persisted false) is not a failure and never blocks - the RPC engine would otherwise be
      // gated for 10 minutes on every reload without any error to show for it.
      if (lastAttempt && lastAttempt.permutation === perm && t0 - lastAttempt.at < RATE_LIMIT_MS) {
        const what = lastAttempt.ok === false ? 'failed: ' + (lastAttempt.error || 'unknown error') : lastAttempt.ok ? 'ok' + (lastAttempt.persisted === false ? ', not saved' : '') : 'unfinished';
        if (lastAttempt.ok === false) {
          log({ note: 'last attempt for build ' + perm + ' was ' + Math.round((t0 - lastAttempt.at) / 1000) + ' s ago (' + what + ')' });
          return refused(perm, reason, 'recently attempted');
        }
        log({ note: 'last attempt for build ' + perm + ' was ' + Math.round((t0 - lastAttempt.at) / 1000) + ' s ago (' + what + '): not counted against the rate limit' });
      }
    }
    attempts.set(perm, t0);
    inProgressPermutation = perm;
    lastProgress = null;
    log({ note: 'rebuilding the decoder for build ' + perm + ' from the live bundle (' + reason + (opts.force ? ', forced' : '') + ')' });
    // The work starts in a microtask so `inProgress` is set before the first 'registry-progress' event: a
    // listener that calls status() from that event already sees the run. doRebuild() releases the flight
    // right BEFORE its final 'registry-progress' event (done / error), so a listener that renders from that
    // event - the panel's banner and Diagnostics block - sees inProgress false and the recorded outcome; the
    // then() below is the safety net for anything that escapes doRebuild's own handling.
    let run = null;
    const release = function () { if (run && inProgress === run) { inProgress = null; inProgressPermutation = null; } };
    run = Promise.resolve().then(function () { return doRebuild(b, moduleBase, perm, reason, t0, release); });
    inProgress = run;
    run.then(release, release);
    return run;
  }
  async function doRebuild(b, moduleBase, perm, reason, t0, release) {
    const out = { ok: false, source: active, ms: 0, bytes: null, fragments: null, types: null, warnings: 0, problems: [], error: null, permutation: perm, reason: reason, persisted: false, truncated: false };
    try {
      // the start note ('unfinished' in Diagnostics should the tab go away mid-download) is not awaited: the
      // download must not wait for a storage callback (and it does not rate-limit anything, see rebuild())
      noteAttempt({ permutation: perm, at: t0, ok: null, error: null, reason: reason, ms: null, persisted: null }).catch(function () { /* ignore */ });
      // The builder's own progress payloads (fetchBundle: {phase:'main'|'fragment', n, status, chars};
      // build: {phase, done, total}) are relayed under the store's phase with theirs as `step`.
      progress(perm, reason, { phase: 'fetch', message: 'downloading the live app bundle' });
      const bundle = await b.fetchBundle(moduleBase, perm, { onProgress: function (p) {
        p = p || {};
        progress(perm, reason, Object.assign({}, p, { phase: 'fetch', step: p.phase || null, fragment: typeof p.n === 'number' ? p.n : p.fragment, message: 'downloading the live app bundle' }));
      } });
      if (!bundle || typeof bundle.text !== 'string' || !bundle.text) throw new Error('empty bundle');
      out.bytes = typeof bundle.bytes === 'number' ? bundle.bytes : bundle.text.length;
      out.fragments = typeof bundle.fragments === 'number' ? bundle.fragments : null;
      out.truncated = !!bundle.truncated;
      if (out.truncated) log({ note: 'bundle download stopped at the fragment cap (' + out.fragments + ' fragments): the registry would miss deferred types' });
      progress(perm, reason, { phase: 'build', message: 'analysing the bundle', bytes: out.bytes, fragments: out.fragments });
      // The builder's warnings (what tools/gen_registry.py prints to stderr, e.g. a serializer whose layout
      // differs from its deserializer's) go to capture.log so they reach the Diagnostics dump instead of the
      // console; `bundle` records the provenance of this registry (the generated file says 'all.js').
      const warnings = [];
      const registry = await b.build(bundle.text, {
        permutation: perm, generatedAt: new Date().toISOString(), bundle: 'live:' + perm,
        onProgress: function (p) {
          p = p || {};
          progress(perm, reason, Object.assign({}, p, { phase: 'build', step: p.phase || null, message: 'analysing the bundle' }));
        },
        onWarning: function (msg) {
          warnings.push(String(msg));
          if (warnings.length <= MAX_LOGGED_WARNINGS) log({ note: 'builder warning: ' + String(msg) });
        },
      });
      out.warnings = warnings.length;
      if (warnings.length > MAX_LOGGED_WARNINGS) log({ note: 'builder: ' + (warnings.length - MAX_LOGGED_WARNINGS) + ' more warning(s) not shown' });
      if (!registry || !registry.types || typeof registry.types !== 'object') throw new Error('the builder returned no registry');
      // the builder reads the permutation from the bundle's $strongName; the record is keyed by the live one
      // (the file we fetched) - a disagreement is worth a log line but the fetched build is what it is
      if (registry.permutation && normPerm(registry.permutation) !== perm) log({ note: 'the bundle names build ' + normPerm(registry.permutation) + ' while the live permutation is ' + perm });
      progress(perm, reason, { phase: 'validate', message: 'checking the known layouts' });
      let v = { ok: true, problems: [] };
      if (typeof b.validate === 'function') v = b.validate(registry, { truncated: out.truncated, fragments: out.fragments }) || { ok: false, problems: ['validate() returned nothing'] };
      out.problems = Array.isArray(v.problems) ? v.problems.map(String) : [];
      if (!v.ok) throw Object.assign(new Error('the rebuilt registry failed validation' + (out.problems.length > 1 ? ' (' + out.problems.length + ' problems)' : '') + ': ' + (out.problems[0] || 'unknown problem')), { validation: true });
      out.types = typesOf(registry);
      registry.permutation = perm;
      registry.source = 'runtime';
      const rec = { schema: RECORD_SCHEMA, builder: BUILDER_VERSION, permutation: perm, registry: registry, builtAt: Date.now(), bytes: out.bytes, fragments: out.fragments };
      progress(perm, reason, { phase: 'store', message: 'saving the decoder' });
      out.persisted = await storageSet({ [STORAGE_KEY]: rec });        // one stored registry: replaces the previous one
      if (!out.persisted) log({ note: 'the rebuilt decoder could not be saved to chrome.storage (kept in memory for this page)' });
      stored = rec;                                                       // in memory even when storage refused it
      const act = activate(perm);
      out.source = act.source;
      out.ok = true;
      out.ms = Date.now() - t0;
      record(out);                                                        // before the final event: listeners read status()
      log({ note: 'decoder rebuilt for build ' + perm + ': ' + out.types + ' types from ' + out.bytes + ' chars (' + (out.fragments == null ? '?' : out.fragments) + ' fragments) in ' + out.ms + ' ms' + (out.warnings ? ', ' + out.warnings + ' builder warning(s)' : '') + (out.persisted ? '' : ', not persisted') });
      if (typeof release === 'function') release();                       // the flight is over BEFORE the final event
      progress(perm, reason, { phase: 'done', message: 'decoder rebuilt', types: out.types, ms: out.ms });
    } catch (e) {
      out.ok = false;
      out.ms = Date.now() - t0;
      out.error = errText(e);
      out.source = active;                                                // the current registry stays
      record(out);
      log({ note: 'rebuild failed after ' + out.ms + ' ms: ' + out.error, problems: out.problems.length ? out.problems.slice(0, 10) : undefined });
      if (typeof release === 'function') release();
      progress(perm, reason, { phase: 'error', message: out.error, problems: out.problems });
    }
    // the outcome note (bounded write): `persisted` says whether a success left a record for the next page load
    try { await noteAttempt({ permutation: perm, ok: out.ok, error: out.error, reason: reason, ms: out.ms, persisted: out.ok ? out.persisted : null }); } catch (e) { /* ignore */ }
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // status / inFlight / forget
  // ------------------------------------------------------------------------------------------------
  function status() {
    return {
      active: active,
      activePermutation: activePermutation,
      activeTypes: typesOf(CMA.registry),
      activeRegistryPermutation: CMA.registry && CMA.registry.permutation ? normPerm(CMA.registry.permutation) : null,
      bundledPermutation: bundledPermutation,
      storedPermutation: stored ? stored.permutation : null,
      storedAt: stored ? stored.builtAt : null,
      storedTypes: stored ? typesOf(stored.registry) : 0,
      inProgress: !!inProgress,
      inProgressPermutation: inProgressPermutation,
      progress: lastProgress,
      lastRebuild: lastRebuild ? Object.assign({}, lastRebuild) : null,
      lastAttempt: lastAttempt ? Object.assign({}, lastAttempt) : null,
      lastRefusal: lastRefusal ? Object.assign({}, lastRefusal) : null,
      builderLoaded: !!builder(),
      builderVersion: BUILDER_VERSION,
      initDone: initDone,
      init: initInfo ? Object.assign({}, initInfo) : null,
    };
  }
  /** The running rebuild's promise (single flight), or null. */
  function inFlight() { return inProgress; }
  async function forget() {
    stored = null;
    lastAttempt = null;
    const removed = await storageRemove([STORAGE_KEY, ATTEMPT_KEY]);
    if (!removed) await storageSet({ [STORAGE_KEY]: null, [ATTEMPT_KEY]: null });
    log({ note: 'stored decoder forgotten' });
    if (activePermutation) activate(activePermutation);       // back to the bundled registry when it was in use
    return true;
  }

  CMA.registryStore = {
    init, activate, rebuild, status, inFlight, forget,
    get bundled() { return bundled; },
    get stored() { return stored; },
    STORAGE_KEY, ATTEMPT_KEY, RECORD_SCHEMA, BUILDER_VERSION, INIT_TIMEOUT_MS, RATE_LIMIT_MS, STORAGE_TIMEOUT_MS, MAX_LOGGED_WARNINGS,
  };
  watchStorage(CMA.registryStore);
})();
