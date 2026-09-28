/* content.js - ISOLATED-world bootstrap (SPEC section 1 / 2.3 / 8), loaded last at document_idle.
 *
 *  - pings the MAIN-world hook (src/hook-main.js) with a fresh MessageChannel port in the transfer list
 *    (retrying 3x over 2 s) and records whether it answered (state.hooked); no answer means the extension
 *    was loaded after the page => the panel asks the user to reload the tab;
 *  - receives the hook's messages on that port (SPEC 2.2: after the handshake the relay never touches
 *    window.postMessage, which every page script could listen to) and still accepts window messages
 *    for a hook that answered a port-less ping, forwarding both to CMA.capture.handleMessage;
 *  - awaits CMA.registryStore.init() (bounded) BEFORE the first ping, so a decoder rebuilt for the live
 *    build (SPEC 3.5) is in memory when the hook replays the app's authenticate exchange;
 *  - runs the DOM fallbacks (CMA.capture.probeDom) at start, after the store init, on load and after the
 *    diary rendered;
 *  - mounts the panel once document.body exists and toggles it with Alt+Shift+M (or Ctrl+Alt+M);
 *  - exposes nothing to the page (content scripts live in their own world; nothing is posted except
 *    the ping, and nothing is attached to the DOM here).
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';
  const CMA = window.CMA;
  if (!CMA || !CMA.capture || typeof CMA.capture.handleMessage !== 'function') {
    try { console.warn('[CMA] capture library missing; content bootstrap skipped'); } catch (e) { /* ignore */ }
    return;
  }
  const capture = CMA.capture;
  const ORIGIN = window.location.origin;
  // postMessage rejects the opaque origin string 'null' (file: pages, used by the tests); '/' means "this document's origin".
  const TARGET = ORIGIN && ORIGIN !== 'null' ? ORIGIN : '/';
  // On https://cronometer.com a same-window message carries origin === location.origin; only an opaque
  // document origin (file: test pages: location.origin 'file://'/'null') reports the event origin as 'null'.
  const OPAQUE = !/^https?:\/\//.test(ORIGIN || '');
  function sameOrigin(ev) { return ev.origin === ORIGIN || (OPAQUE && ev.origin === 'null'); }
  const PING_ATTEMPTS = 3;
  const PING_INTERVAL_MS = 700;      // 3 attempts over ~2 s
  const SEEN_MAX = 20000;
  const seenSeq = new Set();         // seq numbers of the xhr messages already handled (SPEC 2.2 replay)
  let pongReceived = false;
  let mounted = false;
  const ports = [];                  // our ends of the channels handed to the hook (kept referenced)

  // ------------------------------------------------------------------ hook relay
  function onHookMessage(d) {
    try {
      if (!d || typeof d !== 'object' || d.source !== 'cma-hook') return;
      // The hook stamps every xhr message with a per-page seq and replays, on our first ping, the ones it
      // captured before this script existed. Should a message ever arrive twice (a port and a window copy,
      // a duplicated replay), handle each seq once.
      if (d.type === 'xhr' && typeof d.seq === 'number') {
        if (seenSeq.has(d.seq)) return;
        seenSeq.add(d.seq);
        if (seenSeq.size > SEEN_MAX) seenSeq.clear();                  // replays only happen once, at the first ping
      }
      if (d.type === 'pong') {
        pongReceived = true;
        if (typeof d.replayed === 'number' && d.replayed > 0) {
          capture.log('hook', { note: 'hook replayed ' + d.replayed + ' request(s) captured before the content script loaded' });
        }
      }
      capture.handleMessage(d);
      // first evidence of the app on this page (its own traffic): mount the panel now
      if (!mounted && (d.type === 'gwt' || d.type === 'xhr')) mountPanel();
    } catch (e) { /* keep the listener alive */ }
  }
  // Window path: only a hook that answered a port-less ping posts here (older test pages); verify source + origin.
  window.addEventListener('message', function (ev) {
    try {
      if (ev.source !== window || !sameOrigin(ev)) return;            // MDN/Chrome guidance: verify source + origin
      onHookMessage(ev.data);
    } catch (e) { /* keep the listener alive */ }
  });

  function ping() {
    try {
      // A port can be transferred once, so every ping attempt carries a fresh channel; the hook adopts the
      // port of the ping it answers and relays everything (replay, pong, gwt, live xhr) through it.
      let transfer = [];
      if (typeof MessageChannel === 'function') {
        const ch = new MessageChannel();
        ch.port1.onmessage = function (ev) { onHookMessage(ev && ev.data); };   // onmessage also starts the port
        ports.push(ch.port1);
        transfer = [ch.port2];
      }
      window.postMessage({ source: 'cma-content', type: 'ping' }, TARGET, transfer);
    } catch (e) { /* ignore */ }
  }
  function pingLoop(attempt) {
    if (pongReceived) return;
    if (attempt >= PING_ATTEMPTS) {
      if (!pongReceived) {
        capture.state.hooked = false;
        capture.log('hook', { note: 'no answer from the MAIN-world hook after ' + PING_ATTEMPTS + ' pings; reload the tab' });
        try { CMA.events.emit('state', capture.state); } catch (e) { /* ignore */ }
      }
      return;
    }
    ping();
    setTimeout(function () { pingLoop(attempt + 1); }, PING_INTERVAL_MS);
  }

  // ------------------------------------------------------------------ runtime registry (SPEC 3.5)
  // The first ping makes the hook replay the app's start-up traffic; the authenticate reply in it is decoded
  // as soon as its message arrives, with the registry capture activates from its X-GWT-Permutation header.
  // A decoder rebuilt for the live build (chrome.storage.local) must therefore be in memory BEFORE the ping:
  // CMA.registryStore.init() resolves within 500 ms even when storage is slow, and this bound guards a store
  // that never settles (or is missing on a partial install / an older test page).
  const REGISTRY_INIT_MAX_MS = 600;
  function initRegistryStore() {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      setTimeout(finish, REGISTRY_INIT_MAX_MS);
      try {
        const s = CMA.registryStore;
        if (!s || typeof s.init !== 'function') { finish(); return; }
        const p = s.init();
        if (p && typeof p.then === 'function') p.then(finish, finish); else finish();
      } catch (e) { finish(); }
    });
  }
  initRegistryStore().then(function () {
    try {
      const s = CMA.registryStore;
      const st = s && typeof s.status === 'function' ? s.status() : null;
      // logged BEFORE the ping, so the capture log proves the ordering (tests/load-all.html)
      capture.log('registry', { note: 'registry store initialised before the first ping', stored: st ? st.storedPermutation : null, bundled: st ? st.bundledPermutation : null });
    } catch (e) { /* ignore */ }
    probe();          // a permutation learned from the <script ...cache.js> tag activates the stored decoder early
    pingLoop(0);
  });

  // ------------------------------------------------------------------ DOM fallbacks
  function probe() { try { capture.probeDom(document); } catch (e) { /* ignore */ } }
  probe();
  if (document.readyState !== 'complete') window.addEventListener('load', probe, { once: true });
  setTimeout(probe, 3000);
  // the diary re-renders on every getDayInfo: refresh the group titles when no authenticate was captured
  try {
    CMA.events.on('rpc', function (ev) {
      if (ev && ev.method === 'getDayInfo' && capture.state.groupsSource !== 'authenticate') setTimeout(probe, 500);
    });
  } catch (e) { /* ignore */ }
  window.addEventListener('hashchange', function () { setTimeout(probe, 800); });

  // ------------------------------------------------------------------ panel
  // The manifest matches every https://cronometer.com/* page: the logged-out landing page, /login/ and the
  // blog live on the same origin without the GWT app. Mount the panel only where the app is (its hidden
  // <iframe id="cronometer">, its bootstrap/cache scripts, or traffic the hook relayed); the keyboard
  // shortcut mounts on demand regardless.
  function appPresent() {
    try {
      if (document.getElementById('cronometer')) return true;
      if (document.querySelector('script[src*=".cache.js"], script[src*="nocache.js"]')) return true;
      const s = capture.state;
      return !!(s && (s.gwt || s.rpcCount > 0 || s.restCount > 0));
    } catch (e) { return false; }
  }
  function mountPanel(force) {
    if (mounted) return;
    if (!CMA.panel || typeof CMA.panel.mount !== 'function') return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { mountPanel(force); }, { once: true }); return; }
    if (!force && !appPresent()) return;
    mounted = true;
    try { CMA.panel.mount(); } catch (e) { try { console.warn('[CMA] panel mount failed:', e); } catch (e2) { /* ignore */ } }
  }
  mountPanel();
  if (!mounted) {
    // the app's scripts may still be loading (or panel.js is missing in a partial install): retry as the document settles
    if (document.readyState !== 'complete') window.addEventListener('load', function () { mountPanel(); }, { once: true });
    setTimeout(function () { mountPanel(); }, 1500);
    setTimeout(function () { mountPanel(); }, 5000);
  }

  /** The element that would receive the key (through a shadow root if any). */
  function keyTarget(e) {
    try { const p = typeof e.composedPath === 'function' ? e.composedPath() : null; return (p && p[0]) || e.target; } catch (err) { return e.target; }
  }
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }
  window.addEventListener('keydown', function (e) {
    try {
      if (e.metaKey) return;
      const altShift = e.altKey && e.shiftKey && !e.ctrlKey;
      // Left Alt+Shift is Windows' built-in "switch input language" hotkey when several keyboard layouts
      // are installed, so Ctrl+Alt+M is accepted as well. Windows reports AltGr as Ctrl+Alt, and on some
      // layouts AltGr+M types a character (µ), so that chord is ignored while an editable field has focus.
      const ctrlAlt = e.ctrlKey && e.altKey && !e.shiftKey && !isEditable(keyTarget(e));
      if (!altShift && !ctrlAlt) return;
      const isM = e.code === 'KeyM' || String(e.key || '').toUpperCase() === 'M';
      if (!isM) return;
      if (!CMA.panel || typeof CMA.panel.toggle !== 'function') return;
      e.preventDefault();
      e.stopPropagation();
      mountPanel(true);          // an explicit user request: mount even where no app was detected
      CMA.panel.toggle();
    } catch (err) { /* ignore */ }
  }, true);
})();
