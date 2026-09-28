#!/usr/bin/env python3
"""Generate the extension icons (icons/icon16.png, icon48.png, icon128.png) with the standard library only.

The icon is a rounded green square with a white "+" (Cronometer's brand green family, no logo).
PNG encoding is done by hand (zlib + struct): 8-bit RGBA, no interlace, one IDAT chunk.

Usage:  python tools/make_icons.py [--out=icons] [--sizes=16,48,128]
"""
import os
import struct
import sys
import zlib

GREEN = (47, 158, 95)      # panel accent (#2f9e5f)
GREEN_DARK = (36, 128, 76)  # 1px border
WHITE = (255, 255, 255)


def _chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, width, height, pixels):
    """pixels: list of rows, each a list of (r, g, b, a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (None) for every scanline
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit, colour type 6 = RGBA
    png = b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + _chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def _inside_rounded_rect(x, y, size, radius):
    """True when the pixel centre (x+.5, y+.5) lies inside the rounded square [0,size]^2 with corner radius."""
    cx, cy = x + 0.5, y + 0.5
    if cx < 0 or cy < 0 or cx > size or cy > size:
        return False
    # distance to the nearest corner circle centre when in a corner region
    dx = max(radius - cx, 0, cx - (size - radius))
    dy = max(radius - cy, 0, cy - (size - radius))
    return dx * dx + dy * dy <= radius * radius


def draw_icon(size):
    radius = max(2, round(size * 0.2))
    border = 1 if size <= 16 else max(1, round(size * 0.04))
    # plus geometry: arm thickness ~18 % of size (min 2px), length ~56 % of size, centred
    thick = max(2, round(size * 0.18))
    length = max(thick + 2, round(size * 0.56))
    if (size - thick) % 2:      # keep the plus symmetric on the pixel grid
        thick += 1
    if (size - length) % 2:
        length += 1
    c0 = (size - thick) // 2
    l0 = (size - length) // 2
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            if not _inside_rounded_rect(x, y, size, radius):
                row.append((0, 0, 0, 0))
                continue
            inner = _inside_rounded_rect(x - border, y - border, size - 2 * border, max(1, radius - border))
            color = GREEN if inner else GREEN_DARK
            in_v = c0 <= x < c0 + thick and l0 <= y < l0 + length
            in_h = c0 <= y < c0 + thick and l0 <= x < l0 + length
            if in_v or in_h:
                color = WHITE
            row.append(color + (255,))
        rows.append(row)
    return rows


def main(argv):
    out_dir = 'icons'
    sizes = [16, 48, 128]
    for a in argv:
        if a.startswith('--out='):
            out_dir = a[len('--out='):]
        elif a.startswith('--sizes='):
            sizes = [int(s) for s in a[len('--sizes='):].split(',') if s.strip()]
        elif a in ('-h', '--help'):
            print(__doc__)
            return 0
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isabs(out_dir):
        out_dir = os.path.join(root, out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for size in sizes:
        path = os.path.join(out_dir, 'icon%d.png' % size)
        write_png(path, size, size, draw_icon(size))
        print('wrote %s (%d bytes)' % (path, os.path.getsize(path)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
