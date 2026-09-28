/* Multi-Add for Cronometer — panel stylesheet (SPEC §8).
 *
 * Exposed as the string CMA.panelCss so panel.js can drop it into a <style> element inside the
 * shadow root (MV3 CSP forbids inline <style> injection into extension pages, but a <style> node
 * created from a script string inside a content-script shadow root is fine; see
 * research/mv3-research-chrome-extension.md "Shadow-DOM panel that GWT CSS cannot restyle").
 *
 * Design rules from SPEC §8: system font 13px, compact, light/dark via prefers-color-scheme,
 * z-index 2147483647, panel max width 720px, everything self-contained under `:host{all:initial}`
 * so Cronometer's GWT/bootstrap CSS can neither leak in nor be affected.
 */
window.CMA = window.CMA || {};
window.CMA.panelCss = `
:host {
  all: initial;
  position: fixed;
  right: 0;
  bottom: 0;
  width: 0;
  height: 0;
  overflow: visible;
  z-index: 2147483647;
}
*, *::before, *::after { box-sizing: border-box; }

.cma {
  --bg: #ffffff;
  --fg: #1d1d1f;
  --muted: #6b6b70;
  --border: #d5d5d8;
  --row-alt: #f6f6f7;
  --input-bg: #ffffff;
  --accent: #2f9e5f;
  --accent-fg: #ffffff;
  --accent-dim: #e6f4ec;
  --warn-bg: #fff4d6;
  --warn-fg: #6b4d00;
  --warn-border: #f0d48a;
  --err: #c0392b;
  --err-bg: #fdecea;
  --ok: #1f8f4e;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .cma {
    --bg: #1f2023;
    --fg: #e8e8ea;
    --muted: #a3a3a8;
    --border: #3b3c41;
    --row-alt: #26272b;
    --input-bg: #2a2b30;
    --accent: #3fb872;
    --accent-fg: #0f1a14;
    --accent-dim: #22392c;
    --warn-bg: #4a3a10;
    --warn-fg: #ffe2a0;
    --warn-border: #7a6220;
    --err: #ff7b6b;
    --err-bg: #4a2320;
    --ok: #5fd08d;
    --shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
  }
}

/* Launcher (bottom-right) */
.cma-launcher {
  position: fixed;
  right: 16px;
  bottom: 16px;
  padding: 7px 14px;
  border: 0;
  border-radius: 18px;
  background: var(--accent);
  color: var(--accent-fg);
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
}
.cma-launcher:hover { filter: brightness(1.08); }
.cma-launcher:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

/* Panel */
.cma-panel {
  position: fixed;
  right: 16px;
  bottom: 56px;
  width: 720px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.cma-panel[hidden] { display: none; }

.cma-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--row-alt);
  cursor: move;
  user-select: none;
}
.cma-title { font-weight: 600; white-space: nowrap; }
.cma-nav { display: flex; gap: 2px; margin-left: 8px; flex-wrap: wrap; }
.cma-tab {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.cma-tab:hover { color: var(--fg); background: var(--accent-dim); }
.cma-tab[aria-selected="true"] { color: var(--fg); background: var(--bg); border: 1px solid var(--border); }
.cma-close {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: 16px/1 system-ui, sans-serif;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
}
.cma-close:hover { background: var(--err-bg); color: var(--err); }

.cma-body { padding: 10px 12px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.cma-footer {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--row-alt);
  flex-wrap: wrap;
}
.cma-footer .cma-spacer { flex: 1 1 auto; }

/* Controls */
.cma button, .cma input, .cma select, .cma textarea {
  font: inherit;
  color: var(--fg);
}
.cma-btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
  white-space: nowrap;
}
.cma-btn:hover:not(:disabled) { background: var(--accent-dim); }
.cma-btn:disabled { opacity: 0.5; cursor: default; }
.cma-btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
.cma-btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.cma-btn-danger { color: var(--err); border-color: var(--err); }
.cma-btn-small { padding: 2px 6px; font-size: 12px; line-height: 1.2; }

.cma input[type="text"], .cma input[type="number"], .cma input[type="date"], .cma select, .cma textarea {
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
}
.cma input:focus, .cma select:focus, .cma textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.cma textarea {
  width: 100%;
  min-height: 150px;
  resize: vertical;
  font: 13px/1.4 ui-monospace, Consolas, "SF Mono", Menlo, monospace;
  white-space: pre;
}
.cma select { max-width: 100%; }
.cma-qty { width: 64px; }

.cma-controls { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; margin: 8px 0; }
.cma-controls label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.cma-muted { color: var(--muted); }
.cma-small { font-size: 12px; }

.cma-banner {
  padding: 7px 10px;
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-fg);
  border-radius: 6px;
  margin-bottom: 8px;
}
.cma-banner[hidden] { display: none; }
/* Registry (decoder) banner states, SPEC 3.5: rebuilding (warn colours + progress line), rebuilt (green), failed (warn) */
.cma-banner.cma-banner-ok { border-color: var(--ok); background: var(--accent-dim); color: var(--fg); }
.cma-banner .cma-progress { margin-top: 3px; font-size: 12px; opacity: 0.85; }
.cma-registry-status { margin: 0 0 8px; }
.cma-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 4px 0 6px; font-size: 12px; }
.cma-kv dt { color: var(--muted); }
.cma-kv dd { margin: 0; word-break: break-all; }
.cma-registry-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cma-registry-outcome { font-size: 12px; }
.cma-registry-outcome.cma-ok { color: var(--ok); }
.cma-registry-outcome.cma-err { color: var(--err); }
.cma-notice {
  padding: 6px 10px;
  border-radius: 6px;
  margin-bottom: 8px;
  background: var(--accent-dim);
}
.cma-notice.cma-notice-error { background: var(--err-bg); color: var(--err); }
.cma-notice[hidden] { display: none; }
.cma-status { margin: 6px 0; min-height: 1.4em; color: var(--muted); }

.cma-help { margin-top: 8px; }
.cma-help summary { cursor: pointer; color: var(--muted); }
.cma-help code { font: 12px ui-monospace, Consolas, Menlo, monospace; background: var(--row-alt); padding: 0 3px; border-radius: 3px; }
.cma-help ul { margin: 4px 0 0 18px; padding: 0; }

/* Preview table */
.cma-table { width: 100%; border-collapse: collapse; }
.cma-table th, .cma-table td { padding: 3px 5px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--border); }
.cma-table th { font-weight: 600; color: var(--muted); font-size: 12px; white-space: nowrap; }
.cma-table tbody tr:nth-child(even) { background: var(--row-alt); }
.cma-c-line { width: 28px; color: var(--muted); text-align: right; }
.cma-c-food { max-width: 220px; }
/* The Food select has a percentage width, so it contributes nothing to the auto table layout's minimum and a
 * long Unit option ('medium - 7" to 7 7/8" long (118 g)') squeezed it to ~80 px in the live preview
 * (store-assets/02-preview.png, 2026-09-28, panel 720 px). Floor the food name and cap the measure select instead;
 * the opened dropdown still lists every option in full and the select's title carries the typed line. The two
 * limits leave ~20 px of slack in the 694 px table (# 30, food 130, qty 72, unit 180, grams 48, group 128,
 * status 60, remove 26), so the body never needs a horizontal scrollbar for a plain row. Both selectors carry
 * .cma plus the element so they beat ".cma select { max-width: 100% }" above: a lone .cma-measure class loses
 * to it and the cap would silently not apply (measured with a scratch page on 2026-09-28). No backtick may
 * appear anywhere in this file below the opening one: the stylesheet is a JS template literal. */
.cma .cma-c-food select { width: 100%; min-width: 120px; }
.cma select.cma-measure { max-width: 170px; text-overflow: ellipsis; }
.cma-c-grams { white-space: nowrap; text-align: right; }
.cma-c-status { max-width: 180px; font-size: 12px; }
.cma-c-x { width: 22px; text-align: center; }
.cma-status-ready .cma-icon { color: var(--ok); }
.cma-status-needs-choice .cma-icon { color: var(--warn-fg); }
.cma-status-error .cma-icon { color: var(--err); }
.cma-icon { font-weight: 700; margin-right: 4px; }

/* Results list */
.cma-results { list-style: none; margin: 0; padding: 0; }
.cma-results li { display: flex; gap: 8px; padding: 4px 2px; border-bottom: 1px solid var(--border); align-items: baseline; }
.cma-results .cma-icon { width: 16px; text-align: center; flex: 0 0 auto; }
.cma-results .cma-r-name { flex: 1 1 auto; }
.cma-results .cma-r-msg { color: var(--muted); font-size: 12px; max-width: 45%; }
.cma-r-ok .cma-icon { color: var(--ok); }
.cma-r-ok.cma-r-warn .cma-icon { color: var(--warn-fg); }
.cma-r-ok.cma-r-warn .cma-r-msg { color: var(--warn-fg); }
.cma-r-fail .cma-icon { color: var(--err); }
.cma-r-skip .cma-icon, .cma-r-pending .cma-icon { color: var(--muted); }
.cma-use-suggested { margin-left: 4px; }
.cma-c-count { white-space: nowrap; }

/* Diagnostics */
.cma-pre {
  font: 12px/1.35 ui-monospace, Consolas, Menlo, monospace;
  background: var(--row-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  max-height: 50vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
.cma-copybuf { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }

/* Settings */
.cma-form { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; max-width: 420px; }
.cma-form .cma-full { grid-column: 1 / -1; }
`;
