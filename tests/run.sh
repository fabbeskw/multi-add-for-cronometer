#!/usr/bin/env bash
# Runs every tests/*.html page in headless Chrome and reports pass/fail.
# Usage: bash tests/run.sh [page.html ...]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-C:/Program Files/Google/Chrome/Application/chrome.exe}"
if [ ! -f "$CHROME" ]; then
  for c in "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe" \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$(command -v google-chrome 2>/dev/null)" "$(command -v chromium 2>/dev/null)"; do
    [ -n "$c" ] && [ -f "$c" ] && CHROME="$c" && break
  done
fi
if [ ! -f "$CHROME" ]; then echo "Chrome not found; set CHROME=/path/to/chrome"; exit 2; fi

pages=("$@")
if [ ${#pages[@]} -eq 0 ]; then
  pages=()
  for f in "$HERE"/*.html; do
    case "$(basename "$f")" in mock-*) ;; *) pages+=("$f");; esac
  done
fi

status=0
for p in "${pages[@]}"; do
  [ -f "$p" ] || p="$HERE/$p"
  p="$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
  # file:///C:/... form for Windows paths
  url="$p"
  case "$url" in
    /[a-zA-Z]/*) url="file:///$(echo "$url" | sed -E 's#^/([a-zA-Z])/#\1:/#')";;
    [a-zA-Z]:*) url="file:///$url";;
    /*) url="file://$url";;
  esac
  out="$("$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
        --virtual-time-budget=90000 --run-all-compositor-stages-before-draw --dump-dom "$url" 2>/dev/null)"
  # Judge ONLY the <pre id="results"> block, and only a line that is exactly the verdict: the dumped DOM also
  # contains the page's own script source, and a page whose script mentions the literal (registry-builder.html's
  # realtime branch does) would otherwise pass whatever its results say.
  body="$(printf '%s\n' "$out" | sed -n '/<pre id="results">/,/<\/pre>/p' | sed 's/.*<pre id="results">//; s#</pre>.*##')"
  if printf '%s\n' "$body" | grep -qx 'ALL TESTS PASSED'; then
    echo "PASS  $(basename "$p")"
  else
    status=1
    echo "FAIL  $(basename "$p")"
    printf '%s\n' "$out" | sed -n '/<pre id="results">/,/<\/pre>/p' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g; s/&quot;/"/g' | head -200
    if ! printf '%s' "$out" | grep -q 'id="results"'; then
      echo "  (no results element; page failed to load or threw before running)"
      printf '%s\n' "$out" | head -40
    fi
  fi
done
exit $status
