#!/usr/bin/env python3
"""
fetch_bundle.py - download the live compiled Cronometer GWT bundle into tools/bundle/ and build all.js.

Usage:
    python tools/fetch_bundle.py [--base=https://cronometer.com/cronometer/] [--out=tools/bundle]
                                 [--max-fragments=200] [--rebuild-only]

Steps (SPEC 1 / 10, facts from research/live-app-report.md section 1):
  1. GET <base>cronometer.nocache.js and find the permutation strong name (32 upper-case hex chars;
     the bootstrap selects it per user agent with `h([<ua>],<strongName>)`, one permutation in this build).
  2. GET <base><perm>.cache.js                       (main permutation, `var $strongName = '...'`)
  3. GET <base>deferredjs/<perm>/N.cache.js for N = 1, 2, ... until the first non-200 (15 -> 404 in this build).
  4. Concatenate main + fragments (in order) into <out>/all.js, which tools/gen_registry.py reads.
Files are public (no login, no cookies); only urllib from the standard library is used.
--rebuild-only skips the network and rebuilds all.js from the files already in <out>.
"""
import os
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = 'https://cronometer.com/cronometer/'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/140.0.0.0 Safari/537.36')
HEX32 = re.compile(r"[0-9A-F]{32}")


def fetch(url, retries=3, timeout=60):
    """GET url -> bytes; None on HTTP 404/410 (end of the fragment list); raises on other failures."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    return None
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 404, 410):
                return None
            last = exc
        except (urllib.error.URLError, OSError) as exc:
            last = exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError('failed to fetch %s: %s' % (url, last))


def find_permutation(nocache_js):
    """Strong name from cronometer.nocache.js.  Prefers the permutation the bootstrap maps to the 'safari'
    user agent (what Chrome reports to GWT); falls back to the single hex constant."""
    consts = {}
    for m in re.finditer(r"([A-Za-z_$][A-Za-z0-9_$]*)='([^']*)'", nocache_js):
        consts.setdefault(m.group(1), m.group(2))
    by_ua = {}
    for m in re.finditer(r"[A-Za-z_$][A-Za-z0-9_$]*\(\[([^\]]*)\],([A-Za-z0-9_$+']+)\)", nocache_js):
        uas = [consts.get(v.strip(), v.strip().strip("'")) for v in m.group(1).split(',') if v.strip()]
        expr = m.group(2).split('+')[0].strip()
        perm = consts.get(expr, expr.strip("'"))
        if HEX32.fullmatch(perm):
            for ua in uas:
                by_ua.setdefault(ua, perm)
    for ua in ('safari', 'gecko1_8'):
        if ua in by_ua:
            return by_ua[ua]
    perms = sorted(set(HEX32.findall(nocache_js)))
    if len(perms) == 1:
        return perms[0]
    if by_ua:
        return sorted(by_ua.values())[0]
    raise RuntimeError('cannot determine the permutation from nocache.js (candidates: %r)' % perms)


def write(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(data)


def concat(parts):
    """Plain concatenation; a newline is inserted only when a part does not already end with one."""
    out = bytearray()
    for p in parts:
        out += p
        if not p.endswith(b'\n'):
            out += b'\n'
    return bytes(out)


def rebuild(out_dir):
    mains = sorted(f for f in os.listdir(out_dir) if HEX32.fullmatch(f.replace('.cache.js', '')) and f.endswith('.cache.js'))
    if not mains:
        raise RuntimeError('no <perm>.cache.js in %s' % out_dir)
    parts = [open(os.path.join(out_dir, mains[0]), 'rb').read()]
    frag_dir = os.path.join(out_dir, 'deferredjs')
    frags = []
    if os.path.isdir(frag_dir):
        frags = sorted((int(f.split('.')[0]), f) for f in os.listdir(frag_dir) if re.fullmatch(r"\d+\.cache\.js", f))
    for _, f in frags:
        parts.append(open(os.path.join(frag_dir, f), 'rb').read())
    data = concat(parts)
    write(os.path.join(out_dir, 'all.js'), data)
    print('rebuilt all.js from %s + %d fragments: %d bytes' % (mains[0], len(frags), len(data)))
    return 0


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    base = DEFAULT_BASE
    out_dir = os.path.join(here, 'bundle')
    max_fragments = 200
    rebuild_only = False
    for a in argv:
        if a.startswith('--base='):
            base = a[7:]
        elif a.startswith('--out='):
            out_dir = a[6:]
        elif a.startswith('--max-fragments='):
            max_fragments = int(a[16:])
        elif a == '--rebuild-only':
            rebuild_only = True
        else:
            print(__doc__)
            return 2
    if not base.endswith('/'):
        base += '/'
    if rebuild_only:
        return rebuild(out_dir)

    print('fetching %scronometer.nocache.js' % base)
    nocache = fetch(base + 'cronometer.nocache.js')
    if nocache is None:
        print('nocache.js not found at %s' % base, file=sys.stderr)
        return 1
    write(os.path.join(out_dir, 'cronometer.nocache.js'), nocache)
    perm = find_permutation(nocache.decode('utf-8', 'replace'))
    print('permutation %s' % perm)

    main_url = base + perm + '.cache.js'
    print('fetching %s' % main_url)
    main_js = fetch(main_url)
    if main_js is None:
        print('main permutation not found: %s' % main_url, file=sys.stderr)
        return 1
    write(os.path.join(out_dir, perm + '.cache.js'), main_js)
    if ("$strongName = '" + perm + "'").encode() not in main_js:
        print('WARNING: %s.cache.js does not declare $strongName = %s' % (perm, perm), file=sys.stderr)
    parts = [main_js]
    sizes = [len(main_js)]

    n = 1
    while n <= max_fragments:
        url = '%sdeferredjs/%s/%d.cache.js' % (base, perm, n)
        data = fetch(url)
        if data is None:
            print('fragment %d: not found -> %d fragments' % (n, n - 1))
            break
        write(os.path.join(out_dir, 'deferredjs', '%d.cache.js' % n), data)
        parts.append(data)
        sizes.append(len(data))
        print('fragment %d: %d bytes' % (n, len(data)))
        n += 1
    else:
        print('WARNING: stopped at --max-fragments=%d' % max_fragments, file=sys.stderr)

    all_js = concat(parts)
    write(os.path.join(out_dir, 'all.js'), all_js)
    print('wrote %s: %d bytes (main %d + %d fragments)' % (os.path.join(out_dir, 'all.js'), len(all_js), sizes[0], len(sizes) - 1))
    print('next: python tools/gen_registry.py %s' % os.path.join(out_dir, 'all.js'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
