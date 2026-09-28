/* CMA.dom — small DOM helpers shared by the UI-automation engine and the panel (SPEC §7.1).
 *
 * Everything here is plain ES2020, classic-script style: attaches to window.CMA.dom.
 * Facts these helpers rely on (research/ui-automation-dialog-recipe.md):
 *  - GWT reads `event.button` (§4: `$Pk.yr` → button 0 = left), `event.keyCode` (§1b/§4: `FSk`) and
 *    `event.ctrlKey` (§1b: `DSk`), so synthetic events must carry those exact properties.
 *  - GWT reads `input.value` straight from the DOM at Add time (§5: `O$h`), so writing the value through the
 *    native prototype setter and dispatching `input`/`change`/`keyup` is sufficient and also works for
 *    frameworks (React-style) that patch the instance setter.
 *  - All widgets live in the TOP document (§0), so helpers take an optional root/document but default to
 *    the global `document`.
 */
window.CMA = window.CMA || {};
(function () {
  'use strict';

  /** Promise that resolves after `ms` milliseconds (setTimeout based so --virtual-time-budget fast-forwards it). */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  /**
   * Poll `fn` until it returns a truthy value.
   *   waitFor(fn, {timeout=5000, interval=50, label, abort}) → Promise<truthyValue>
   * - Rejects with a descriptive Error (`err.timeout === true`) after `timeout` ms.
   * - If `abort` (a function) returns a truthy reason at any poll, rejects immediately with
   *   Error('aborted: <reason>') and `err.aborted === true`.
   * - An exception thrown by `fn` itself propagates immediately (used by the engine to turn
   *   "ERROR" labels into row errors without waiting for the timeout).
   */
  async function waitFor(fn, opts) {
    const o = opts || {};
    const timeout = o.timeout == null ? 5000 : Number(o.timeout);
    const interval = o.interval == null ? 50 : Math.max(1, Number(o.interval));
    const label = o.label || (fn && fn.name) || 'condition';
    const started = Date.now();
    for (;;) {
      if (typeof o.abort === 'function') {
        const reason = o.abort();
        if (reason) {
          const err = new Error('aborted: ' + reason + ' (while waiting for ' + label + ')');
          err.aborted = true;
          throw err;
        }
      }
      const value = fn();
      if (value) return value;
      if (Date.now() - started >= timeout) {
        const err = new Error('Timed out after ' + timeout + ' ms waiting for ' + label);
        err.timeout = true;
        throw err;
      }
      await sleep(interval);
    }
  }

  /**
   * Set an <input>/<textarea> value the way a user would, bypassing any instance-level value setter
   * (React etc.), then dispatch `input` (always) and optionally `change` and `keyup`.
   *   setNativeValue(el, value, {change=false, keyup=false, focus=true})
   */
  function setNativeValue(el, value, opts) {
    if (!el || typeof el !== 'object') throw new Error('setNativeValue: element required');
    const o = opts || {};
    const str = value == null ? '' : String(value);
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    let proto = null;
    if (win.HTMLTextAreaElement && el instanceof win.HTMLTextAreaElement) proto = win.HTMLTextAreaElement.prototype;
    else if (win.HTMLInputElement && el instanceof win.HTMLInputElement) proto = win.HTMLInputElement.prototype;
    else if (win.HTMLSelectElement && el instanceof win.HTMLSelectElement) proto = win.HTMLSelectElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (o.focus !== false && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* focus can throw on detached nodes; value still set below */ }
    }
    if (desc && typeof desc.set === 'function') desc.set.call(el, str);
    else el.value = str;
    el.dispatchEvent(new win.Event('input', { bubbles: true, cancelable: false }));
    if (o.change) el.dispatchEvent(new win.Event('change', { bubbles: true, cancelable: false }));
    if (o.keyup) {
      el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }));
    }
    return el;
  }

  function mouseEvent(el, type, init) {
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const ev = new win.MouseEvent(type, Object.assign({
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: type === 'mousedown' ? 1 : 0, view: win,
    }, init || {}));
    return el.dispatchEvent(ev);
  }

  /** Left mousedown (button 0, bubbles, cancelable). Recipe §4: this is what selects a PrettyTable row. */
  function mousedown(el, init) { return mouseEvent(el, 'mousedown', init); }
  /** Matching mouseup (button 0). */
  function mouseup(el, init) { return mouseEvent(el, 'mouseup', init); }
  /** Full press = mousedown then mouseup on the same element. */
  function press(el, init) { mousedown(el, init); return mouseup(el, init); }

  /**
   * Click an element: dispatches a `click` MouseEvent with button 0 / bubbles / cancelable. We prefer a
   * dispatched event over `el.click()` so that the same code path works for non-button elements
   * (GWT anchors/labels attach ClickHandlers to `click` regardless of tag).
   */
  function click(el, init) {
    if (!el) throw new Error('click: element required');
    return mouseEvent(el, 'click', init);
  }

  /**
   * Dispatch a keydown on `el` honouring `keyCode`, which GWT reads (`FSk` = event.keyCode).
   *   keydown(el, {key:'Enter', keyCode:13, ctrlKey:false, shiftKey, altKey, metaKey, bubbles:true})
   * Chrome accepts `keyCode` in KeyboardEventInit; we also define it explicitly on the instance in case
   * the init dictionary is ignored, so `event.keyCode` is always what the caller asked for.
   */
  function keydown(el, init, type) {
    const o = init || {};
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const keyCode = o.keyCode == null ? keyCodeFor(o.key) : Number(o.keyCode);
    const ev = new win.KeyboardEvent(type || 'keydown', {
      bubbles: o.bubbles == null ? true : !!o.bubbles,
      cancelable: true,
      composed: true,
      key: o.key || '',
      code: o.code || '',
      keyCode: keyCode,
      which: keyCode,
      ctrlKey: !!o.ctrlKey,
      shiftKey: !!o.shiftKey,
      altKey: !!o.altKey,
      metaKey: !!o.metaKey,
      view: win,
    });
    if (ev.keyCode !== keyCode) {
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
        Object.defineProperty(ev, 'which', { get: () => keyCode });
      } catch (e) { /* non-configurable in exotic environments; nothing more we can do */ }
    }
    return el.dispatchEvent(ev);
  }
  function keyup(el, init) { return keydown(el, init, 'keyup'); }

  const KEY_CODES = { Enter: 13, Escape: 27, Esc: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, ' ': 32 };
  function keyCodeFor(key) {
    if (!key) return 0;
    if (KEY_CODES[key] != null) return KEY_CODES[key];
    return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  }

  /** Normalised text of an element: whitespace collapsed and trimmed ('' for null). */
  function textOf(el) {
    if (!el) return '';
    const t = el.textContent != null ? el.textContent : (el.innerText || '');
    return String(t).replace(/\s+/g, ' ').trim();
  }

  function norm(s, ci) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return ci ? t.toLowerCase() : t;
  }

  /**
   * Find the first element matching `selector` whose normalised text matches `text`.
   *   findByText(selector, text, {exact=true, ci=false, startsWith=false, contains=false, root=document, filter})
   * Matching tiers, tried in order over the whole candidate list so a better match anywhere wins:
   *   1. exact (case-sensitive) — always tried first
   *   2. exact case-insensitive — when `ci`
   *   3. startsWith (case-insensitive when `ci`) — when `startsWith`
   *   4. contains  (case-insensitive when `ci`) — when `contains`
   * Returns the element or null. `filter(el)` can exclude candidates (e.g. hidden ones).
   */
  function findByText(selector, text, opts) {
    const o = opts || {};
    const root = o.root || document;
    const want = norm(text, false);
    const wantCi = norm(text, true);
    if (!want) return null;
    const all = Array.from(root.querySelectorAll(selector));
    const cands = typeof o.filter === 'function' ? all.filter(o.filter) : all;
    const texts = cands.map((el) => norm(textOf(el), false));
    let i;
    if (o.exact !== false) {
      i = texts.findIndex((t) => t === want);
      if (i >= 0) return cands[i];
    }
    if (o.ci) {
      i = texts.findIndex((t) => t.toLowerCase() === wantCi);
      if (i >= 0) return cands[i];
    }
    if (o.startsWith) {
      i = texts.findIndex((t) => (o.ci ? t.toLowerCase().startsWith(wantCi) : t.startsWith(want)));
      if (i >= 0) return cands[i];
    }
    if (o.contains) {
      i = texts.findIndex((t) => (o.ci ? t.toLowerCase().includes(wantCi) : t.includes(want)));
      if (i >= 0) return cands[i];
    }
    return null;
  }

  /**
   * Visible = attached to a document, no `display:none` / `visibility:hidden` on itself or an ancestor
   * (checked via computed style) and has at least one layout box. Works for the `.food-search-spinner`
   * (display:flex ↔ none) and for GWT's `yg(widget,false)` (display:none) hides.
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      const cs = win.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    return true;
  }

  /** querySelector on an optional root (defaults to document). */
  function q(selector, root) { return (root || document).querySelector(selector); }
  function qa(selector, root) { return Array.from((root || document).querySelectorAll(selector)); }

  window.CMA.dom = {
    sleep, waitFor, setNativeValue, click, mousedown, mouseup, press, keydown, keyup, keyCodeFor,
    textOf, findByText, isVisible, q, qa,
  };
})();
