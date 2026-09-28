#!/usr/bin/env python3
"""check_manifest.py - sanity checks for manifest.json (Python 3, stdlib only).

    python tools/check_manifest.py [repo-root]

Checks
  * manifest.json parses and is manifest_version 3 with the keys the extension relies on;
  * every content_scripts js file, every icon and every web_accessible_resources entry exists;
  * icons are real PNGs whose pixel size matches their key (16/48/128);
  * host_permissions and every content_scripts match target https://cronometer.com/* only (SPEC 0);
  * the MAIN-world entry is exactly src/hook-main.js at document_start;
  * the ISOLATED-world list is exactly what tests/load-all.html loads, in the same order (so the test page
    cannot drift from the manifest), and every listed script starts with the CMA namespace guard.
Exit status 0 when everything passes, 1 otherwise (each failure is printed).
"""
import json
import os
import re
import struct
import sys

ALLOWED_MATCH = 'https://cronometer.com/*'
KNOWN_KEYS = {'manifest_version', 'name', 'description', 'version', 'minimum_chrome_version', 'permissions',
              'host_permissions', 'icons', 'action', 'content_scripts', 'web_accessible_resources'}
NAMESPACE_GUARD = 'window.CMA = window.CMA || {};'


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return None
    return struct.unpack('>II', head[16:24])


def scripts_of_test_page(path):
    """<script src="../src/..."> entries of tests/load-all.html in document order (paths relative to the root)."""
    with open(path, encoding='utf-8') as f:
        html = f.read()
    return [m.group(1) for m in re.finditer(r'<script\s+src="\.\./(src/[^"]+)"', html)]


def main(argv):
    root = os.path.abspath(argv[0]) if argv else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    problems = []

    def fail(msg):
        problems.append(msg)
        print('FAIL  ' + msg)

    def good(msg):
        print('ok    ' + msg)

    mpath = os.path.join(root, 'manifest.json')
    try:
        with open(mpath, encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        fail('manifest.json: %s' % e)
        return 1
    good('manifest.json parses (%s %s)' % (m.get('name'), m.get('version')))

    if m.get('manifest_version') != 3:
        fail('manifest_version must be 3, got %r' % m.get('manifest_version'))
    unknown = sorted(set(m) - KNOWN_KEYS)
    if unknown:
        fail('unexpected top-level keys: %s' % ', '.join(unknown))
    if m.get('permissions') != ['storage']:
        fail('permissions should be exactly ["storage"], got %r' % m.get('permissions'))
    if m.get('host_permissions') != [ALLOWED_MATCH]:
        fail('host_permissions should be exactly [%r], got %r' % (ALLOWED_MATCH, m.get('host_permissions')))

    # ---- files referenced by the manifest -------------------------------------------------------------
    listed = []
    for i, cs in enumerate(m.get('content_scripts') or []):
        for f in cs.get('js', []):
            listed.append(f)
        for css in cs.get('css', []):
            listed.append(css)
        if cs.get('matches') != [ALLOWED_MATCH]:
            fail('content_scripts[%d].matches must be [%r], got %r' % (i, ALLOWED_MATCH, cs.get('matches')))
    for size, f in (m.get('icons') or {}).items():
        listed.append(f)
        p = os.path.join(root, f)
        if os.path.isfile(p):
            dims = png_size(p)
            if dims is None:
                fail('icon %s is not a PNG' % f)
            elif dims != (int(size), int(size)):
                fail('icon %s is %dx%d but registered as %s' % (f, dims[0], dims[1], size))
    popup = (m.get('action') or {}).get('default_popup')
    if popup:
        listed.append(popup)
        p = os.path.join(root, popup)
        if os.path.isfile(p):
            with open(p, encoding='utf-8') as fh:
                html = fh.read()
            # MV3 extension-page CSP (SPEC 0): no inline <script>, no inline event handlers
            if re.search(r'<script(?![^>]*\bsrc=)[^>]*>', html, re.I) or re.search(r'\son\w+\s*=', html, re.I):
                fail('%s must not contain inline scripts or inline handlers (MV3 CSP)' % popup)
            else:
                good('%s is a static extension page (no inline script)' % popup)
    for war in m.get('web_accessible_resources') or []:
        for f in war.get('resources', []):
            if '*' not in f:
                listed.append(f)
    missing = [f for f in listed if not os.path.isfile(os.path.join(root, f))]
    if missing:
        fail('missing files: %s' % ', '.join(missing))
    else:
        good('%d referenced files exist (%d scripts, %d icons)' % (len(listed), sum(1 for f in listed if f.endswith('.js')),
                                                                   len(m.get('icons') or {})))

    # ---- text encoding ---------------------------------------------------------------------------------
    # Chrome refuses a content script (or extension page) that is not valid UTF-8 ("It isn't UTF-8 encoded")
    # and its validator (base::IsStringUTF8) also rejects surrogates and Unicode noncharacters (U+FDD0..U+FDEF,
    # U+xFFFE, U+xFFFF). A literal U+FFFF inside a regex character class triggered exactly that on install:
    # write such characters as \uXXXX escapes instead.
    def bad_code_point(cp):
        return 0xD800 <= cp <= 0xDFFF or 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE
    text_files = [f for f in listed if f.endswith(('.js', '.css', '.html', '.json'))]
    encoding_ok = True
    for f in text_files:
        p = os.path.join(root, f)
        if not os.path.isfile(p):
            continue
        with open(p, 'rb') as fh:
            raw = fh.read()
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError as e:
            encoding_ok = False
            fail('%s is not valid UTF-8 at byte %d (Chrome refuses it)' % (f, e.start))
            continue
        for ln, line in enumerate(text.split('\n'), 1):
            bad = [ch for ch in line if bad_code_point(ord(ch))]
            if bad:
                encoding_ok = False
                fail('%s:%d contains %s (a noncharacter/surrogate; Chrome rejects the file as not UTF-8) - use \\uXXXX escapes'
                     % (f, ln, ', '.join('U+%04X' % ord(ch) for ch in bad[:3])))
    if encoding_ok:
        good('every listed text file is valid UTF-8 without noncharacters')

    # ---- worlds / order --------------------------------------------------------------------------------
    cs = m.get('content_scripts') or []
    if len(cs) != 2:
        fail('expected exactly 2 content_scripts entries (MAIN hook + ISOLATED bundle), got %d' % len(cs))
    else:
        hook, iso = cs
        if hook.get('js') != ['src/hook-main.js'] or hook.get('world') != 'MAIN' or hook.get('run_at') != 'document_start':
            fail('content_scripts[0] must be src/hook-main.js in world MAIN at document_start, got %r' % hook)
        else:
            good('MAIN-world hook: src/hook-main.js at document_start')
        if iso.get('world') not in (None, 'ISOLATED') or iso.get('run_at') != 'document_idle':
            fail('content_scripts[1] must be the ISOLATED bundle at document_idle, got world=%r run_at=%r' % (iso.get('world'), iso.get('run_at')))
        iso_js = iso.get('js', [])
        if not iso_js or iso_js[-1] != 'src/content.js':
            fail('the ISOLATED list must end with src/content.js (it wires everything), got %r' % iso_js[-1:])
        if 'src/lib/gwt-registry.js' in iso_js and 'src/lib/gwt-stream.js' in iso_js and iso_js.index('src/lib/gwt-registry.js') > iso_js.index('src/lib/gwt-stream.js'):
            fail('src/lib/gwt-registry.js must load before src/lib/gwt-stream.js')
        page = os.path.join(root, 'tests', 'load-all.html')
        if os.path.isfile(page):
            page_scripts = scripts_of_test_page(page)
            expected = ['src/hook-main.js'] + iso_js
            if page_scripts != expected:
                fail('tests/load-all.html loads %r but the manifest lists %r' % (page_scripts, expected))
            else:
                good('tests/load-all.html loads the same %d scripts in manifest order' % len(expected))
        else:
            fail('tests/load-all.html is missing')
        for f in iso_js:
            p = os.path.join(root, f)
            if os.path.isfile(p):
                with open(p, encoding='utf-8') as fh:
                    head = fh.read(4000)
                if NAMESPACE_GUARD not in head:
                    fail('%s does not start with the namespace guard %r (SPEC 0)' % (f, NAMESPACE_GUARD))
                if re.search(r'\bimport\s+[\w{*]|\bexport\s+(default|const|function|class)\b|\brequire\(', head):
                    fail('%s looks like a module; content scripts must be classic scripts' % f)
        good('every ISOLATED script carries the CMA namespace guard and is a classic script')

    print()
    if problems:
        print('FAILED: %d problem(s)' % len(problems))
        return 1
    print('ALL CHECKS PASSED')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
