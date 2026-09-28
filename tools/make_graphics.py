#!/usr/bin/env python3
"""make_graphics.py - render the extension icons and the Chrome Web Store promo tiles (Python 3 stdlib + Chrome).

    python tools/make_graphics.py                    # render every asset below, verify it, write it
    python tools/make_graphics.py --only icons       # only the icons (or: promo, or one output file name)
    python tools/make_graphics.py --verify           # no Chrome: check the committed PNGs (sizes, alpha, padding)
    python tools/make_graphics.py --check            # render into a temp folder and compare pixels with the committed PNGs
    python tools/make_graphics.py --preview OUT.png  # also render graphics/preview.html (a contact sheet) to OUT.png
    python tools/make_graphics.py --chrome PATH      # a Chrome that is not in the usual place (or set CHROME)

The art is authored as SVG / HTML under graphics/ (the sources of record) and rendered by headless Chrome through
the DevTools pipe client tools/cdp.py (the one tools/smoke_extension.py and tools/screenshots.py use): per asset the
viewport is set to the exact output size with Emulation.setDeviceMetricsOverride (device scale factor 1), icons get
a fully transparent default background (Emulation.setDefaultBackgroundColorOverride a=0), promo tiles keep an
opaque page background, and Page.captureScreenshot captures a PNG clip of exactly that size. Chrome's PNG is then
decoded and re-encoded here (8-bit RGBA for icons, 8-bit RGB for promo tiles, zlib level 9, no ancillary chunks),
so the bytes depend only on the pixels: two runs on the same machine and Chrome build write identical files. Text
is laid out with the system font stack in graphics/promo.css (Segoe UI on Windows, Helvetica Neue on macOS), so a
promo tile rendered on another OS can differ slightly; the committed tiles were rendered on Windows.

Outputs and the Chrome Web Store rules they follow (developer.chrome.com/docs/webstore/images):
  icons/icon16.png  icon32.png  icon48.png   toolbar / Windows / chrome://extensions sizes, drawn on the pixel grid
                                             (16 px is simplified to two list rows so it stays legible)
  icons/icon128.png                          store + install icon: "The actual icon size should be 96x96 (for
                                             square icons); an additional 16 pixels per side should be transparent
                                             padding" - verified: every pixel outside 16..111 is fully transparent
  store-assets/promo/small-promo-440x280.png the small promo tile, REQUIRED by the store ("Only the extension icon,
                                             a small promotional image, and a screenshot are mandatory"); opaque
  store-assets/promo/marquee-1400x560.png    the marquee promo tile (optional; used only for featuring); opaque
Every PNG is verified after rendering: IHDR size, colour type (icons RGBA with fully transparent corners, promo
tiles RGB without alpha), not blank, and for the HTML sources that every [data-fit] text block lies inside the
tile (no clipped text). Exit status 0 = OK, 1 = a check failed, 2 = usage / Chrome or the DevTools pipe unavailable.
"""
import base64
import json
import os
import shutil
import struct
import sys
import tempfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Cdp, find_chrome  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPHICS = os.path.join(ROOT, 'graphics')

# (group, source under graphics/, output relative to the repo root, width, height, transparent background)
ASSETS = (
    ('icons', 'icon-16.svg', 'icons/icon16.png', 16, 16, True),
    ('icons', 'icon-32.svg', 'icons/icon32.png', 32, 32, True),
    ('icons', 'icon-48.svg', 'icons/icon48.png', 48, 48, True),
    ('icons', 'icon-128.svg', 'icons/icon128.png', 128, 128, True),
    ('promo', 'promo-small.html', 'store-assets/promo/small-promo-440x280.png', 440, 280, False),
    ('promo', 'marquee.html', 'store-assets/promo/marquee-1400x560.png', 1400, 560, False),
)
STORE_ICON_PADDING = 16          # 128 px store icon: 96x96 art + 16 px transparent padding per side
PREVIEW_SIZE = (1500, 760)
PNG_SIG = b'\x89PNG\r\n\x1a\n'


# ---------------------------------------------------------------------------------------------- PNG codec
def _chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)


def png_decode(data):
    """-> (width, height, colour type, rows) for an 8-bit, non-interlaced greyscale/RGB/RGBA PNG; rows are bytes
    with 1/3/4 bytes per pixel. Raises ValueError for anything else."""
    if data[:8] != PNG_SIG:
        raise ValueError('not a PNG')
    pos, idat, ihdr = 8, [], None
    while pos + 8 <= len(data):
        n, tag = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if tag == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            idat.append(body)
        elif tag == b'IEND':
            break
        pos += 12 + n
    if ihdr is None:
        raise ValueError('no IHDR')
    w, h, depth, ctype, _comp, _filt, interlace = ihdr
    bpp = {0: 1, 2: 3, 6: 4}.get(ctype)
    if depth != 8 or bpp is None or interlace:
        raise ValueError('unsupported PNG layout (depth %d, colour type %d, interlace %d)' % (depth, ctype, interlace))
    raw = zlib.decompress(b''.join(idat))
    stride = w * bpp
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        ft, line = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise ValueError('bad filter type %d' % ft)
        rows.append(bytes(line))
        prev = line
    return w, h, ctype, rows


def png_encode(w, h, ctype, rows):
    """8-bit RGB (2) or RGBA (6) PNG; the Up filter on every row, zlib level 9, no ancillary chunks: deterministic."""
    out, prev = bytearray(), bytes(len(rows[0]))
    for row in rows:
        out.append(2)
        out += bytes((a - b) & 0xFF for a, b in zip(row, prev))
        prev = row
    ihdr = struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0)
    return PNG_SIG + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', zlib.compress(bytes(out), 9)) + _chunk(b'IEND', b'')


def to_rgba(ctype, rows):
    if ctype == 6:
        return rows
    if ctype == 2:
        return [bytes(b for i in range(0, len(r), 3) for b in (r[i], r[i + 1], r[i + 2], 255)) for r in rows]
    return [bytes(b for v in r for b in (v, v, v, 255)) for r in rows]


def normalise(png, transparent):
    """Chrome's screenshot -> (width, height, colour type, rows) in the layout we commit (RGBA icons, RGB tiles)."""
    w, h, ctype, rows = png_decode(png)
    rows = to_rgba(ctype, rows)
    if transparent:
        return w, h, 6, rows
    bad = sum(1 for r in rows for i in range(3, len(r), 4) if r[i] != 255)
    if bad:
        raise ValueError('%d pixels are not opaque on a tile that must have an opaque background' % bad)
    return w, h, 2, [bytes(b for i in range(0, len(r), 4) for b in r[i:i + 3]) for r in rows]


# ---------------------------------------------------------------------------------------------- checks
def verify_png(path, width, height, transparent):
    """-> list of problems (empty = fine) for one written PNG."""
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
        w, h, ctype, rows = png_decode(data)
    except (OSError, ValueError, zlib.error) as e:
        return ['%s: %s' % (path, e)]
    problems = []
    if (w, h) != (width, height):
        problems.append('IHDR says %dx%d, expected %dx%d' % (w, h, width, height))
        return problems
    if transparent:
        if ctype != 6:
            return ['colour type %d, expected 6 (RGBA) for an icon' % ctype]

        def alpha(x, y):
            return rows[y][4 * x + 3]
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        opaque_corners = [c for c in corners if alpha(*c) != 0]
        if opaque_corners:
            problems.append('corner pixels not fully transparent: %s' % opaque_corners)
        if alpha(w // 2, h // 2) != 255:
            problems.append('the centre pixel is not opaque (alpha %d)' % alpha(w // 2, h // 2))
        if w == 128:
            pad = STORE_ICON_PADDING
            leaks = sum(1 for y in range(h) for x in range(w)
                        if (x < pad or y < pad or x >= w - pad or y >= h - pad) and alpha(x, y) != 0)
            if leaks:
                problems.append('%d pixels inside the 16 px store padding are not fully transparent' % leaks)
    else:
        if ctype != 2:
            problems.append('colour type %d, expected 2 (RGB, no alpha) for a promo tile' % ctype)
        distinct = set()
        for r in rows[::max(1, h // 20)]:
            for i in range(0, len(r), max(3, (len(r) // 60) // 3 * 3)):
                distinct.add(r[i:i + 3])
        if len(distinct) < 8:
            problems.append('looks blank (%d distinct colours sampled)' % len(distinct))
    return problems


JS_SETTLE = ('(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise(r => '
             'requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))')
# every [data-fit] block (the texts of the promo tiles) must lie inside the viewport and not overflow its own box
JS_FIT = r'''(() => {
  const W = innerWidth, H = innerHeight, out = [];
  for (const el of document.querySelectorAll('[data-fit]')) {
    const r = el.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) out.push(el.dataset.fit + ' outside the tile ' + JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]));
    if (el.scrollWidth > el.clientWidth + 1) out.push(el.dataset.fit + ' overflows its box horizontally (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
  }
  const imgs = [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => 'image not loaded: ' + i.getAttribute('src'));
  // FontFaceSet.check() answers true for any local font name, so measure instead: a font is installed when a sample
  // set in it differs in width from the same sample in both generic fallbacks
  const c = new OffscreenCanvas(8, 8).getContext('2d'), sample = 'Multi-Add for Cronometer 0123456789 mmmwwwiii';
  const width = f => { c.font = '32px ' + f; return c.measureText(sample).width; };
  const base = [width('monospace'), width('serif')];
  const fonts = ['Segoe UI Variable Display', 'Segoe UI', 'Helvetica Neue', 'Helvetica', 'Arial'].filter(f =>
    width('"' + f + '", monospace') !== base[0] || width('"' + f + '", serif') !== base[1]);
  return JSON.stringify({problems: out.concat(imgs), fonts});
})()'''


# ---------------------------------------------------------------------------------------------- rendering
def file_url(path):
    p = os.path.abspath(path).replace('\\', '/')
    return 'file:///' + p.lstrip('/')


class Renderer:
    def __init__(self, chrome, work):
        self.cdp = Cdp(chrome, os.path.join(work, 'profile'), os.path.join(work, 'chrome-stderr.txt'),
                       extra_args=['--hide-scrollbars', '--force-color-profile=srgb', '--allow-file-access-from-files'])
        v = self.cdp.call('Browser.getVersion', timeout=30)
        if 'error' in v:
            raise RuntimeError('DevTools pipe unavailable: %s' % v['error'].get('message'))
        self.product = v['result'].get('product')
        t = self.cdp.call('Target.createTarget', {'url': 'about:blank'})
        tid = t.get('result', {}).get('targetId')
        if not tid:
            raise RuntimeError('Target.createTarget failed: %s' % t.get('error'))
        a = self.cdp.call('Target.attachToTarget', {'targetId': tid, 'flatten': True})
        self.sid = a.get('result', {}).get('sessionId')
        if not self.sid:
            raise RuntimeError('Target.attachToTarget failed: %s' % a.get('error'))
        self.call('Page.enable')
        self.call('Runtime.enable')

    def call(self, method, params=None, timeout=30):
        r = self.cdp.call(method, params, timeout=timeout, session_id=self.sid)
        if 'error' in r:
            raise RuntimeError('%s: %s' % (method, r['error'].get('message')))
        return r.get('result', {})

    def evaluate(self, expression, await_promise=False):
        r = self.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': await_promise, 'returnByValue': True})
        if r.get('exceptionDetails'):
            raise RuntimeError('page script failed: %s' % r['exceptionDetails'].get('text'))
        return (r.get('result') or {}).get('value')

    def render(self, source, width, height, transparent):
        """-> (Chrome's PNG bytes, layout info dict) for one source rendered at exactly width x height."""
        self.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1,
                                                         'mobile': False, 'screenWidth': width, 'screenHeight': height})
        if transparent:
            self.call('Emulation.setDefaultBackgroundColorOverride', {'color': {'r': 0, 'g': 0, 'b': 0, 'a': 0}})
        else:
            self.call('Emulation.setDefaultBackgroundColorOverride', {})       # no override: an opaque page
        self.cdp.drain('Page.loadEventFired')
        nav = self.call('Page.navigate', {'url': file_url(source)})
        if nav.get('errorText'):
            raise RuntimeError('cannot open %s: %s' % (source, nav['errorText']))
        if self.cdp.wait_event('Page.loadEventFired', session_id=self.sid, timeout=30) is None:
            raise RuntimeError('%s did not finish loading' % source)
        self.evaluate(JS_SETTLE, await_promise=True)
        info = json.loads(self.evaluate(JS_FIT) or '{}')
        shot = self.call('Page.captureScreenshot', {
            'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False,
            'clip': {'x': 0, 'y': 0, 'width': width, 'height': height, 'scale': 1}}, timeout=60)
        return base64.b64decode(shot['data']), info

    def close(self):
        self.cdp.close()


def select(only):
    if not only:
        return list(ASSETS)
    picked = [a for a in ASSETS if only in (a[0], a[1], os.path.basename(a[2]), a[2])]
    if not picked:
        raise SystemExit('--only %s matches nothing (use icons, promo, or an output / source file name)' % only)
    return picked


def main(argv):
    args = list(argv)
    opts = {'--only': None, '--chrome': None, '--preview': None}
    flags = set()
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('-h', '--help'):
            print(__doc__)
            return 0
        if a in opts:
            if i + 1 >= len(args):
                print('%s needs a value' % a)
                return 2
            opts[a] = args[i + 1]
            i += 2
            continue
        if a in ('--verify', '--check'):
            flags.add(a)
            i += 1
            continue
        print('unknown argument %r\n' % a)
        print(__doc__)
        return 2
    assets = select(opts['--only'])
    problems = []

    def fail(msg):
        problems.append(msg)
        print('FAIL  ' + msg)

    if '--verify' in flags:
        for _g, _src, out, w, h, transparent in assets:
            p = verify_png(os.path.join(ROOT, out), w, h, transparent)
            for m in p:
                fail('%s: %s' % (out, m))
            if not p:
                print('ok    %s %dx%d %s' % (out, w, h, 'RGBA, transparent corners' + (', 16 px padding' if w == 128 else '')
                                             if transparent else 'RGB, opaque'))
        print()
        print('GRAPHICS OK' if not problems else 'GRAPHICS FAILED: %d problem(s)' % len(problems))
        return 1 if problems else 0

    chrome = find_chrome(opts['--chrome'])
    if not chrome:
        print('FAIL  Chrome not found; pass --chrome PATH or set CHROME')
        return 2
    work = tempfile.mkdtemp(prefix='cma-graphics-')
    check = '--check' in flags
    out_root = os.path.join(work, 'out') if check else ROOT
    try:
        try:
            r = Renderer(chrome, work)
        except (RuntimeError, OSError) as e:
            print('FAIL  %s' % e)
            return 2
        print('      %s (%s)' % (r.product, chrome))
        try:
            fonts_reported = False
            for _g, src, out, w, h, transparent in assets:
                source = os.path.join(GRAPHICS, src)
                if not os.path.isfile(source):
                    fail('%s: source graphics/%s is missing' % (out, src))
                    continue
                png, info = r.render(source, w, h, transparent)
                for m in info.get('problems', []):
                    fail('%s: layout: %s' % (out, m))
                if not transparent and not fonts_reported:
                    print('      fonts available: %s' % (', '.join(info.get('fonts') or []) or 'none of the stack - a generic sans-serif'))
                    fonts_reported = True
                try:
                    nw, nh, ctype, rows = normalise(png, transparent)
                except ValueError as e:
                    fail('%s: %s' % (out, e))
                    continue
                dest = os.path.join(out_root, out)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'wb') as fh:
                    fh.write(png_encode(nw, nh, ctype, rows))
                p = verify_png(dest, w, h, transparent)
                for m in p:
                    fail('%s: %s' % (out, m))
                if check:
                    committed = os.path.join(ROOT, out)
                    try:
                        with open(committed, 'rb') as fh:
                            _cw, _ch, cct, crows = png_decode(fh.read())
                    except (OSError, ValueError) as e:
                        fail('%s: cannot read the committed file (%s)' % (out, e))
                        continue
                    if (cct, crows) != (ctype, rows):
                        diff = sum(1 for a, b in zip(crows, rows) if a != b) if cct == ctype else h
                        fail('%s: differs from a fresh render (%d of %d rows) - run python tools/make_graphics.py' % (out, diff, h))
                    else:
                        print('ok    %s matches a fresh render pixel for pixel' % out)
                elif not p:
                    print('ok    wrote %s (%dx%d, %s, %d bytes)' % (out, w, h, 'RGBA' if transparent else 'RGB', os.path.getsize(dest)))
            if opts['--preview'] and not problems:
                dest = os.path.abspath(opts['--preview'])
                png, _info = r.render(os.path.join(GRAPHICS, 'preview.html'), PREVIEW_SIZE[0], PREVIEW_SIZE[1], False)
                with open(dest, 'wb') as fh:
                    fh.write(png)
                print('ok    preview sheet %s' % dest)
        finally:
            r.close()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print()
    print('GRAPHICS OK' if not problems else 'GRAPHICS FAILED: %d problem(s)' % len(problems))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
