/* hook-main.js - MAIN-world XMLHttpRequest hook + relay (SPEC section 2.2).
 *
 * Runs at document_start in the page's own JS world (manifest "world": "MAIN"), so it has NO chrome.*
 * APIs and must never throw into the page. It relays what the Cronometer app sends/receives to the
 * ISOLATED-world content script over a private MessageChannel port that the content script hands over
 * with its ping (window.postMessage with the port in the transfer list, targetOrigin = location.origin).
 *
 * Why a port and not window.postMessage for the traffic (review round 2): a `message` event dispatched on
 * `window` is delivered to every listener of every world and every script in that window, and the bundle
 * initialises third-party SDKs in the TOP window (`$wnd.braze.*` from cdn1.cronometer.com/js/braze.6.1.min.js,
 * `$wnd.amplitude.logEvent` from cdn.amplitude.com); every relayed message carries the session nonce (the
 * first String param of each RPC body, SPEC 2.1) and the decoded methods' full responses. A MessagePort has
 * exactly two ends, so after the handshake only the ping/pong itself is ever visible to page listeners and
 * it carries no data. Before the ping nothing legitimate listens (the content script pings synchronously
 * when it loads), so early traffic is only buffered (below) and never posted live. window.postMessage stays
 * the fallback for a ping that carried no port (older test pages) or a port that stopped working.
 *
 * Why patching the TOP window works (research/mv3-research-chrome-extension.md section B and
 * research/live-app-report.md section 1): the compiled GWT module runs inside the hidden
 * <iframe id="cronometer"> but starts with `var $wnd = $wnd || window.parent` and creates every request
 * with `new $wnd.XMLHttpRequest` - both the GWT-RPC transport (V1k) and the /api/v3/ REST client (MIf:
 * `a.i=new $wnd.XMLHttpRequest`). The bundle contains no plain `new XMLHttpRequest`, so hooking
 * XMLHttpRequest.prototype of the host window at document_start captures every RPC and REST call.
 *
 * Messages posted (all with source:'cma-hook'):
 *   { type:'xhr', seq, method, url, requestHeaders:{...}, requestBody:string|null, status,
 *     responseText:string|null, responseHeaders:string, t:Date.now(), replay? } one per relayed request
 *                                                                              (seq = 1, 2, ... per page;
 *                                                                              replay:true on a replayed copy)
 *   { type:'gwt', strongName, moduleBase }                                    once, when the iframe's
 *                                                                              $strongName appears
 *   { type:'pong', hooked:true, replayed:n, seq }                             answer to a content ping
 * Received: { source:'cma-content', type:'ping' } from the content script (same window, same origin),
 * with a MessagePort in the transfer list; the pong (and the 'gwt' repeat) go back the way the ping came
 * (the port, or the window for a port-less ping), everything else goes to the most recently adopted port.
 *
 * Early-traffic buffer: the ISOLATED content script is injected at document_idle, but the app's first
 * RPCs (authenticate, getDayInfo) can complete before that, especially with a warm cache, and
 * authenticate is the only source of the diary groups (SPEC 2.1). Every xhr message is therefore kept
 * in a bounded buffer until the content script's first ping; that ping replays the buffer in order
 * (replay:true) before the pong, after which buffering stops for good. content.js handles each seq
 * once, so a message that is somehow delivered twice is still processed a single time (SPEC 2.2).
 */
(function () {
  'use strict';
  try {
    var W = window;
    if (W.__cmaHookInstalled) return;                 // idempotent (the content script may be re-injected)
    var SOURCE = 'cma-hook';
    var ORIGIN = W.location.origin;
    // targetOrigin = location.origin (SPEC 2.2). An opaque origin reads as the string 'null', which
    // postMessage rejects; '/' then means "this document's origin" (only file: test pages hit this).
    var TARGET = ORIGIN && ORIGIN !== 'null' ? ORIGIN : '/';
    // On https://cronometer.com a same-window message carries origin === location.origin. Only an opaque
    // document origin (file: test pages) reports location.origin 'file://'/'null' while the event says 'null'.
    var OPAQUE = !/^https?:\/\//.test(ORIGIN || '');
    function sameOrigin(ev) { return ev.origin === ORIGIN || (OPAQUE && ev.origin === 'null'); }
    // /cronometer/app (CronometerService) and /cronometer/pro (ProService) GWT-RPC endpoints, and the
    // same-origin REST API (live-app-report.md sections 2 and 5).
    var RPC_RE = /\/cronometer\/(app|pro)(\?|$)/;
    var V3_RE = /\/api\/v3\//;

    // ---------------------------------------------------------------- transport
    var port = null;                  // MessagePort adopted from the content script's ping (latest wins)
    function postWindow(msg) {
      try { msg.source = SOURCE; W.postMessage(msg, TARGET); } catch (e) { /* never break the page */ }
    }
    function postPort(msg) {
      if (!port) return false;
      try { msg.source = SOURCE; port.postMessage(msg); return true; } catch (e) { port = null; return false; }
    }
    /** Relayed traffic: the private port when one was adopted, else (port-less pinger) the window. */
    function post(msg) {
      if (!postPort(msg)) postWindow(msg);
    }

    // ---------------------------------------------------------------- early-traffic buffer (SPEC 2.2)
    var seq = 0;                      // stamped on every relayed xhr message
    var pinged = false;               // true after the content script's first ping: buffering is over
    var pending = [];                 // xhr messages captured before that ping, oldest first
    var pendingChars = 0;             // total request+response body size held in `pending`
    var PENDING_MAX = 100;
    var PENDING_MAX_CHARS = 4 * 1024 * 1024;
    function sizeOf(msg) {
      return (typeof msg.requestBody === 'string' ? msg.requestBody.length : 0)
        + (typeof msg.responseText === 'string' ? msg.responseText.length : 0);
    }
    function isAuthenticate(msg) { return typeof msg.requestBody === 'string' && msg.requestBody.indexOf('|authenticate|') >= 0; }
    /** Drop the oldest buffered message that is NOT the authenticate exchange: it is the first RPC after load
     *  and the only source of the diary groups (SPEC 2.1), so it must survive an overflow. */
    function evictOne() {
      for (var i = 0; i < pending.length; i++) if (!isAuthenticate(pending[i])) return pending.splice(i, 1)[0];
      return pending.shift();
    }
    /** Stamp an xhr message with its seq; buffer it while nobody has pinged yet (nothing legitimate listens
     *  before the ping, and the ping replays the buffer), otherwise post it live over the port. */
    function relay(msg) {
      msg.seq = ++seq;
      if (!pinged) {
        pending.push(msg);
        pendingChars += sizeOf(msg);
        while (pending.length > PENDING_MAX || (pendingChars > PENDING_MAX_CHARS && pending.length > 1)) {
          pendingChars -= sizeOf(evictOne());
        }
        return;
      }
      post(msg);
    }
    /** Post every buffered message (marked replay:true), oldest first; returns how many. */
    function replayPending() {
      var list = pending;
      pending = [];
      pendingChars = 0;
      for (var i = 0; i < list.length; i++) {
        var copy = {};
        for (var k in list[i]) if (Object.prototype.hasOwnProperty.call(list[i], k)) copy[k] = list[i][k];
        copy.replay = true;
        post(copy);
      }
      return list.length;
    }

    function absolutize(url) {
      try { return new URL(String(url), W.location.href).href; } catch (e) { return String(url); }
    }
    function originOfUrl(url) { try { return new URL(String(url)).origin; } catch (e) { return null; } }
    // SPEC 0: only this page's own origin is relayed. The bundle initialises third-party SDKs in the TOP
    // window ($wnd.braze.*, $wnd.amplitude.*) whose XHRs inherit the patched prototype and use the same
    // /api/v3/ path shape on their own hosts (sdk.<cluster>.braze.com/api/v3/...). On https://cronometer.com
    // only same-origin URLs pass; on a file: test page (opaque origin) relative/file: URLs pass and any
    // http(s) host is foreign.
    function isOwnOrigin(url) {
      if (!OPAQUE) return originOfUrl(url) === ORIGIN;
      return !/^https?:\/\//i.test(String(url));
    }
    function isRelayed(url) { return (RPC_RE.test(url) || V3_RE.test(url)) && isOwnOrigin(url); }
    // Response bodies are relayed in full only for the methods capture.js decodes (SPEC 2.3: authenticate for
    // userId/groups, updateDiary for rejected adds, getDayInfo/getFood to detect a stale registry); every other
    // RPC response is cut to its head (enough for //OK, //EX, an exception payload and reauthenticate's string
    // result) and REST bodies are dropped (capture reads only url/status/method/headers of /api/v3/ traffic).
    // The relay carries no more than the receiver consumes even though the port is private.
    var FULL_RESPONSE_METHODS = { authenticate: 1, updateDiary: 1, getDayInfo: 1, getFood: 1 };
    var RESPONSE_HEAD = 4096;
    function methodOf(body) {
      // body = 7|0|n|moduleBase|policy|service|method|... : the 4th string-table entry is token index 6
      try { var t = String(body).split('|'); return t.length > 6 ? t[6] : null; } catch (e) { return null; }
    }

    // ---------------------------------------------------------------- XMLHttpRequest.prototype hook
    var P = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (!P || typeof P.open !== 'function' || typeof P.send !== 'function') return;
    var _open = P.open, _setRequestHeader = P.setRequestHeader, _send = P.send;

    P.open = function (method, url) {
      try {
        this.__cma = { method: String(method || 'GET').toUpperCase(), url: absolutize(url), headers: {} };
      } catch (e) { /* ignore */ }
      return _open.apply(this, arguments);
    };
    P.setRequestHeader = function (name, value) {
      try {
        if (this.__cma) this.__cma.headers[String(name)] = String(value);
      } catch (e) { /* ignore */ }
      return _setRequestHeader.apply(this, arguments);
    };
    P.send = function (body) {
      try {
        var xhr = this;
        var rec = xhr.__cma;
        if (rec && isRelayed(rec.url)) {
          // Only string bodies are meaningful (GWT-RPC text, JSON); FormData/Blob uploads relay as null.
          var requestBody = typeof body === 'string' ? body : null;
          // once: loadend fires exactly once per send(), so a reused XHR object never posts twice
          xhr.addEventListener('loadend', function () {
            try {
              var responseText = null;
              try {
                // responseText throws for non-text responseType (json/blob/arraybuffer)
                if (xhr.responseType === '' || xhr.responseType === 'text') responseText = xhr.responseText;
              } catch (e1) { responseText = null; }
              var responseHeaders = '';
              try { responseHeaders = xhr.getAllResponseHeaders() || ''; } catch (e2) { responseHeaders = ''; }
              var isV3 = V3_RE.test(rec.url) && !RPC_RE.test(rec.url);
              var text = responseText;
              if (isV3) text = null;
              else if (typeof text === 'string' && text.length > RESPONSE_HEAD && !FULL_RESPONSE_METHODS[methodOf(requestBody)]) text = text.slice(0, RESPONSE_HEAD);
              relay({
                type: 'xhr',
                method: rec.method,
                url: rec.url,
                requestHeaders: rec.headers,
                requestBody: isV3 ? null : requestBody,
                status: xhr.status,
                responseText: text,
                responseHeaders: responseHeaders,
                t: Date.now()
              });
            } catch (e3) { /* never break the page */ }
          }, { once: true });
        }
      } catch (e) { /* never break the page */ }
      return _send.apply(this, arguments);
    };

    try {
      Object.defineProperty(W, '__cmaHookInstalled', { value: true, configurable: true, enumerable: false, writable: false });
    } catch (e) { W.__cmaHookInstalled = true; }

    // ---------------------------------------------------------------- $strongName poll (SPEC 2.2)
    // The bootstrap (cronometer.nocache.js) creates <iframe id="cronometer"> and installs the compiled
    // module inside it; `$strongName` / `$moduleBase` are globals of that iframe window
    // (research/mv3-research-chrome-extension.md section C). Same origin, so contentWindow is readable.
    var gwtInfo = null;
    var ticks = 0;
    var timer = setInterval(function () {
      try {
        ticks++;
        var fr = W.document.getElementById('cronometer');
        var iw = fr && fr.contentWindow;
        var strongName = null;
        try { strongName = iw && iw.$strongName; } catch (e0) { strongName = null; }
        if (strongName) {
          var moduleBase = null;
          try {
            var am = W.__gwt_activeModules && W.__gwt_activeModules.cronometer;
            moduleBase = (am && am.moduleBase) || (W.cronometer && W.cronometer.__moduleBase) || iw.$moduleBase || null;
          } catch (e1) { moduleBase = null; }
          gwtInfo = { strongName: String(strongName), moduleBase: moduleBase ? String(moduleBase) : null };
          clearInterval(timer);
          // Before the ping nobody listens: the ping handler sends the stored copy.
          if (pinged) post({ type: 'gwt', strongName: gwtInfo.strongName, moduleBase: gwtInfo.moduleBase });
        } else if (ticks >= 240) {                    // 240 x 250 ms = 60 s
          clearInterval(timer);
        }
      } catch (e) {
        try { clearInterval(timer); } catch (e2) { /* ignore */ }
      }
    }, 250);

    // ---------------------------------------------------------------- ping / pong (SPEC 2.2)
    // The ISOLATED content script loads at document_idle; it pings to learn whether this hook is
    // installed (extension loaded after the page => no hook => the user must reload the tab) and hands
    // over the port that carries everything from then on.
    W.addEventListener('message', function (ev) {
      try {
        if (ev.source !== W || !sameOrigin(ev)) return;
        var d = ev.data;
        if (!d || typeof d !== 'object' || d.source !== 'cma-content') return;
        if (d.type === 'ping') {
          var p = ev.ports && ev.ports.length ? ev.ports[0] : null;
          if (p) port = p;                            // a re-injected content script's port replaces the old one
          // Answer the way the ping came: a port-less pinger (older test pages) listens on the window.
          var reply = p ? post : postWindow;
          // First ping: hand over everything captured before the content script was listening, in
          // wire order, and only then confirm the hook so the receiver knows the replay is complete.
          var replayed = 0;
          if (!pinged) { pinged = true; replayed = replayPending(); }
          reply({ type: 'pong', hooked: true, replayed: replayed, seq: seq });
          // The 'gwt' message is only ever sent after a ping (nobody listened before): send / repeat it.
          if (gwtInfo) reply({ type: 'gwt', strongName: gwtInfo.strongName, moduleBase: gwtInfo.moduleBase });
        }
      } catch (e) { /* never break the page */ }
    });
  } catch (e) {
    /* never break the page */
  }
})();
