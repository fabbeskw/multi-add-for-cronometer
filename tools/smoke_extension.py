#!/usr/bin/env python3
"""smoke_extension.py - install the extension into headless Chrome for real and open its popup (Python 3, stdlib).

    python tools/smoke_extension.py [<extension dir> | <package.zip>] [--chrome PATH] [--self-test] [--keep]

Why not `chrome --headless=new --load-extension=<dir> --dump-dom about:blank`? Google Chrome 137+ (the branded
build, every channel) ignores that flag - with --enable-logging=stderr it says "--load-extension is not allowed in
Google Chrome, ignoring" - so that smoke passes vacuously: nothing is loaded and nothing is reported, not even for
a manifest that is not JSON. Chrome's supported replacement is the DevTools command Extensions.loadUnpacked, which
is offered only to a client connected through --remote-debugging-pipe while --enable-unsafe-extension-debugging is
set. It installs the unpacked extension the way "Load unpacked" does (manifest parse, referenced files,
content-script and icon checks) and answers with the extension id, or with the error the extensions page would
show. This script:
  1. takes the repo root (default), any unpacked directory, or the store zip (extracted to a temporary folder);
  2. starts headless Chrome on a throw-away profile with the DevTools pipe and calls Extensions.loadUnpacked;
  3. opens chrome-extension://<id>/popup.html as a new target and waits for its <title> to equal the manifest
     name - the page can only render when the extension is installed and its files are served;
  4. with --self-test also installs a directory whose manifest is invalid JSON and expects an error, which proves
     the check is not vacuous on the Chrome build at hand.
Transport: JSON messages separated by NUL bytes; on Windows the pipe ends are inheritable handles named by
--remote-debugging-io-pipes=<read>,<write>, on macOS/Linux they are file descriptors 3 and 4 (the client is
tools/cdp.py, shared with tools/screenshots.py).
Exit status 0 = PASS, 1 = FAIL, 2 = usage / Chrome not found / DevTools pipe unavailable.
"""
import json
import os
import shutil
import sys
import tempfile
import time

# The pipe/CDP client lives in tools/cdp.py (shared with tools/screenshots.py); import it from this file's own
# directory so the tool works from any working directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Cdp, find_chrome  # noqa: E402

POPUP = 'popup.html'
CONNECT_TIMEOUT_S = 30
LOAD_TIMEOUT_S = 60
TITLE_TIMEOUT_S = 15


def load_and_probe(chrome, ext_dir, expected_title, work):
    """Install ext_dir; return (ok, detail). ok is None when the DevTools pipe itself is unavailable."""
    profile = os.path.join(work, 'profile')
    shutil.rmtree(profile, ignore_errors=True)
    stderr_path = os.path.join(work, 'chrome-stderr.txt')
    cdp = Cdp(chrome, profile, stderr_path)
    try:
        v = cdp.call('Browser.getVersion', timeout=CONNECT_TIMEOUT_S)
        if 'error' in v:
            return None, 'DevTools pipe unavailable (%s) - Chrome too old for --remote-debugging-io-pipes / Extensions.loadUnpacked?' % v['error'].get('message')
        print('      connected to %s' % v['result'].get('product'))
        r = cdp.call('Extensions.loadUnpacked', {'path': ext_dir}, timeout=LOAD_TIMEOUT_S)
        if 'error' in r:
            return False, 'Extensions.loadUnpacked: %s' % r['error'].get('message')
        eid = r['result']['id']
        print('      installed as %s' % eid)
        url = 'chrome-extension://%s/%s' % (eid, POPUP)
        t = cdp.call('Target.createTarget', {'url': url})
        tid = t.get('result', {}).get('targetId')
        if not tid:
            return False, 'could not open %s: %s' % (url, t.get('error', {}).get('message'))
        title = None
        deadline = time.time() + TITLE_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(0.25)
            for ti in cdp.call('Target.getTargets').get('result', {}).get('targetInfos', []):
                if ti.get('targetId') == tid:
                    title = ti.get('title')
            if title == expected_title:
                break
        if title != expected_title:
            return False, '%s rendered title %r, expected %r' % (url, title, expected_title)
        return True, 'id %s, %s rendered with title %r' % (eid, POPUP, title)
    finally:
        cdp.close()
        try:
            noise = open(stderr_path, 'rb').read().decode('utf-8', 'replace')
            for line in noise.splitlines():
                if 'xtension' in line and 'cloud_management' not in line:
                    print('      chrome: ' + line.strip()[:200])
        except OSError:
            pass


def main(argv):
    args = list(argv)
    chrome_arg, self_test, keep = None, False, False
    if '--chrome' in args:
        i = args.index('--chrome')
        if i + 1 >= len(args):
            print('--chrome needs a path')
            return 2
        chrome_arg = args[i + 1]
        del args[i:i + 2]
    if '--self-test' in args:
        self_test = True
        args.remove('--self-test')
    if '--keep' in args:
        keep = True
        args.remove('--keep')
    if len(args) > 1:
        print(__doc__)
        return 2
    source = os.path.abspath(args[0]) if args else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    chrome = find_chrome(chrome_arg)
    if not chrome:
        print('FAIL  Chrome not found; pass --chrome PATH or set CHROME')
        return 2
    work = tempfile.mkdtemp(prefix='cma-smoke-')
    status = 0
    try:
        if os.path.isfile(source) and source.lower().endswith('.zip'):
            import zipfile
            ext_dir = os.path.join(work, 'package')
            with zipfile.ZipFile(source) as zf:
                zf.extractall(ext_dir)
                members = len(zf.namelist())
            print('ok    extracted %s (%d members) to %s' % (os.path.basename(source), members, ext_dir))
        elif os.path.isdir(source):
            ext_dir = source
        else:
            print('FAIL  %s is neither a directory nor a .zip' % source)
            return 2
        mpath = os.path.join(ext_dir, 'manifest.json')
        try:
            with open(mpath, encoding='utf-8') as fh:
                manifest = json.load(fh)
        except (OSError, ValueError) as e:
            print('FAIL  %s: %s' % (mpath, e))
            return 1
        expected = str(manifest.get('name') or '')
        print('smoke %s %s from %s' % (manifest.get('name'), manifest.get('version'), ext_dir))
        print('      chrome: %s' % chrome)
        ok, detail = load_and_probe(chrome, ext_dir, expected, work)
        if ok is None:
            print('FAIL  ' + detail)
            return 2
        print(('ok    ' if ok else 'FAIL  ') + detail)
        status = 0 if ok else 1

        if self_test:
            broken = os.path.join(work, 'broken')
            os.makedirs(broken, exist_ok=True)
            with open(os.path.join(broken, 'manifest.json'), 'w', encoding='utf-8') as fh:
                fh.write('{ this is not json')
            print('self-test: a directory whose manifest is not JSON must be rejected')
            ok2, detail2 = load_and_probe(chrome, broken, expected, work)
            if ok2 is False and 'Manifest' in detail2:
                print('ok    rejected as expected: ' + detail2)
            else:
                print('FAIL  the broken manifest was not rejected (%s) - this Chrome does not really install extensions here' % detail2)
                status = 1
    finally:
        if keep:
            print('      work dir kept: %s' % work)
        else:
            shutil.rmtree(work, ignore_errors=True)
    print()
    print('SMOKE PASSED' if status == 0 else 'SMOKE FAILED')
    return status


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
