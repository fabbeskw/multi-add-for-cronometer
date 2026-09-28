#!/usr/bin/env python3
"""build_zip.py - build the Chrome Web Store package (Python 3, stdlib only).

    python tools/build_zip.py [repo-root] [--out DIR]

Writes  dist/multi-add-for-cronometer-<version>.zip  (version = manifest.json "version") containing exactly

    manifest.json
    popup.html
    LICENSE
    icons/*.png
    src/**/*.js       (the content scripts and the generated registry - .js only, and every one of them must
                       be listed in the manifest, see below)

and nothing else: tests/, tools/, SPEC.md, README.md, PRIVACY.md, STORE-LISTING.md, dist/, .gitignore, .git/,
__pycache__/, editor droppings (.bak, .orig, ~), a stray registry backup (gwt-registry.js.old) or a scratch .py
under src/ never make it into the package.

The archive is reproducible: members are added in sorted order with a fixed timestamp and fixed permission bits
and deflated at level 9 (passed per member: ZipFile.writestr ignores the archive-level compresslevel for a
hand-built ZipInfo), so building twice from the same tree gives byte-identical zips.

After writing, the zip is re-opened and verified independently of the file walk:
  * manifest.json parses, is manifest_version 3, and carries a name/description/version the store accepts
    (name <= 45 chars, description <= 132 chars, version = 1-4 dot-separated integers);
  * every file the manifest references (content_scripts js/css, icons, action.default_popup/default_icon,
    background.service_worker, non-glob web_accessible_resources) is present in the archive;
  * every member is on the allow-list above (no stray file can leak into the upload), and every src/ member is
    referenced by the manifest (MV3 lists every script the extension runs: an unreferenced src/ file is a
    leftover that invites reviewer questions);
  * no member is a directory entry, no member name is absolute or contains "..";
  * every text member (.js/.html/.json/.css) is valid UTF-8 without surrogates or Unicode noncharacters
    (Chrome refuses such content scripts at install time - see tools/check_manifest.py).
Prints the member list with sizes and the total, exits 0 when everything passed and 1 otherwise. The archive
is written under a temporary name and renamed to the release name only when every check passed; a previous
package under the release name is removed first. A failed build therefore never leaves a zip that looks like
a good one for a later `upload dist/*.zip` to pick up.
"""
import io
import json
import os
import re
import sys
import zipfile

# ---- package contents --------------------------------------------------------------------------------
ROOT_FILES = ('manifest.json', 'popup.html', 'LICENSE')
ROOT_DIRS = ('icons', 'src')                       # walked recursively
DIR_ALLOWED_EXT = {'icons': ('.png',), 'src': ('.js',)}   # per directory: the only extensions that are packaged
COMPRESS_LEVEL = 9
SKIP_DIR_NAMES = {'__pycache__', '.git', 'node_modules'}
SKIP_FILE_NAMES = {'.DS_Store', 'Thumbs.db', '.gitignore'}
SKIP_FILE_SUFFIXES = ('.pyc', '.swp', '.orig', '.rej', '~')

# Fixed metadata for reproducible archives. ZIP timestamps start at 1980-01-01; the date itself is irrelevant to
# Chrome, it only needs to be constant between builds.
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
FIXED_ATTR = (0o100644 << 16)                      # regular file, rw-r--r--

TEXT_EXT = ('.js', '.html', '.json', '.css')

STORE_NAME_MAX = 45
STORE_DESCRIPTION_MAX = 132
VERSION_RE = re.compile(r'^\d{1,5}(\.\d{1,5}){0,3}$')


def bad_code_point(cp):
    """Surrogates and Unicode noncharacters, which Chrome's UTF-8 validator rejects in content scripts."""
    return 0xD800 <= cp <= 0xDFFF or 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE


def collect_members(root):
    """Return the sorted list of (zip name, absolute path) pairs that belong in the package."""
    members = []
    for name in ROOT_FILES:
        members.append((name, os.path.join(root, name)))
    for d in ROOT_DIRS:
        base = os.path.join(root, d)
        allowed_ext = DIR_ALLOWED_EXT.get(d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(n for n in dirnames if n not in SKIP_DIR_NAMES and not n.startswith('.'))
            for fn in filenames:
                if fn in SKIP_FILE_NAMES or fn.endswith(SKIP_FILE_SUFFIXES) or fn.startswith('.'):
                    continue
                if allowed_ext is not None and not fn.lower().endswith(allowed_ext):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace(os.sep, '/')
                members.append((rel, full))
    members.sort(key=lambda m: m[0])
    return members


def is_allowed_member(name):
    """The allow-list applied to the finished archive (independent of collect_members)."""
    if name in ROOT_FILES:
        return True
    parts = name.split('/')
    if len(parts) < 2:
        return False
    top = parts[0]
    if top not in ROOT_DIRS:
        return False
    if any(p in SKIP_DIR_NAMES or p.startswith('.') for p in parts[:-1]):
        return False
    fn = parts[-1]
    if fn in SKIP_FILE_NAMES or fn.endswith(SKIP_FILE_SUFFIXES) or fn.startswith('.'):
        return False
    allowed_ext = DIR_ALLOWED_EXT.get(top)
    return allowed_ext is None or fn.lower().endswith(allowed_ext)


def referenced_files(manifest):
    """Every concrete file path the manifest points at (globs in web_accessible_resources are skipped)."""
    refs = []
    for cs in manifest.get('content_scripts') or []:
        refs.extend(cs.get('js', []))
        refs.extend(cs.get('css', []))
    refs.extend((manifest.get('icons') or {}).values())
    action = manifest.get('action') or {}
    if action.get('default_popup'):
        refs.append(action['default_popup'])
    di = action.get('default_icon')
    if isinstance(di, str):
        refs.append(di)
    elif isinstance(di, dict):
        refs.extend(di.values())
    bg = manifest.get('background') or {}
    if bg.get('service_worker'):
        refs.append(bg['service_worker'])
    for war in manifest.get('web_accessible_resources') or []:
        refs.extend(r for r in war.get('resources', []) if '*' not in r)
    if manifest.get('options_page'):
        refs.append(manifest['options_page'])
    if (manifest.get('options_ui') or {}).get('page'):
        refs.append(manifest['options_ui']['page'])
    return [r.lstrip('/') for r in refs]


def write_zip(out_path, members):
    """Write the archive deterministically: sorted members, fixed timestamps and attributes, deflate 9."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=COMPRESS_LEVEL) as zf:
        for name, full in members:
            with open(full, 'rb') as fh:
                data = fh.read()
            zi = zipfile.ZipInfo(name, date_time=FIXED_DATE_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = FIXED_ATTR
            zi.create_system = 3                   # "Unix", constant regardless of the build host
            # writestr takes the level from the ZipInfo (None for a hand-built one -> zlib's default 6), not
            # from the ZipFile: pass it explicitly so the archive really is deflate 9
            zf.writestr(zi, data, compresslevel=COMPRESS_LEVEL)
    with open(out_path, 'wb') as fh:
        fh.write(buf.getvalue())
    return len(buf.getvalue())


def verify_zip(path, problems):
    """Re-open the finished archive and check it the way the store / Chrome will see it."""
    def fail(msg):
        problems.append(msg)
        print('FAIL  ' + msg)

    def good(msg):
        print('ok    ' + msg)

    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        names = [i.filename for i in infos]

        # -- structure ---------------------------------------------------------------------------------
        for i in infos:
            n = i.filename
            if n.endswith('/') or i.is_dir():
                fail('directory entry in archive: %s' % n)
            if n.startswith('/') or n.startswith('\\') or '..' in n.split('/') or ':' in n or '\\' in n:
                fail('unsafe member name: %s' % n)
        if len(set(names)) != len(names):
            fail('duplicate member names in archive')

        # -- allow-list --------------------------------------------------------------------------------
        stray = [n for n in names if not is_allowed_member(n)]
        if stray:
            fail('files outside the allow-list: %s' % ', '.join(stray))
        else:
            good('every member is on the allow-list (manifest.json, popup.html, LICENSE, icons/*.png, src/**/*.js)')
        for must in ROOT_FILES:
            if must not in names:
                fail('required file missing from archive: %s' % must)

        # -- manifest ----------------------------------------------------------------------------------
        if 'manifest.json' not in names:
            return None
        try:
            manifest = json.loads(zf.read('manifest.json').decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as e:
            fail('manifest.json inside the archive does not parse: %s' % e)
            return None
        if manifest.get('manifest_version') != 3:
            fail('manifest_version must be 3, got %r' % manifest.get('manifest_version'))
        name = manifest.get('name') or ''
        desc = manifest.get('description') or ''
        version = manifest.get('version') or ''
        if not name or len(name) > STORE_NAME_MAX:
            fail('manifest name must be 1..%d characters, got %d' % (STORE_NAME_MAX, len(name)))
        if not desc or len(desc) > STORE_DESCRIPTION_MAX:
            fail('manifest description must be 1..%d characters, got %d' % (STORE_DESCRIPTION_MAX, len(desc)))
        if not VERSION_RE.match(version):
            fail('manifest version %r is not 1-4 dot-separated integers' % version)
        if not problems:
            good('manifest.json parses: %s %s (description %d chars)' % (name, version, len(desc)))

        refs = referenced_files(manifest)
        missing = [r for r in refs if r not in names]
        if missing:
            fail('files referenced by the manifest are missing from the archive: %s' % ', '.join(missing))
        else:
            good('all %d files referenced by the manifest are in the archive' % len(refs))
        # the converse for src/: MV3 names every script the extension runs, so a src/ member the manifest does
        # not reference is a leftover (an old copy of the generated registry, a scratch file) that must not ship
        unreferenced = [n for n in names if n.startswith('src/') and n not in refs]
        if unreferenced:
            fail('src/ files that the manifest does not reference (leftovers?): %s' % ', '.join(unreferenced))
        else:
            good('every src/ member is referenced by the manifest (%d scripts)' % sum(1 for n in names if n.startswith('src/')))

        # -- text encoding -----------------------------------------------------------------------------
        enc_ok = True
        for n in names:
            if not n.lower().endswith(TEXT_EXT):
                continue
            raw = zf.read(n)
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError as e:
                enc_ok = False
                fail('%s is not valid UTF-8 at byte %d' % (n, e.start))
                continue
            for ln, line in enumerate(text.split('\n'), 1):
                bad = [ch for ch in line if bad_code_point(ord(ch))]
                if bad:
                    enc_ok = False
                    fail('%s:%d contains %s (noncharacter/surrogate; Chrome rejects the file) - use \\uXXXX escapes'
                         % (n, ln, ', '.join('U+%04X' % ord(ch) for ch in bad[:3])))
                    break
        if enc_ok:
            good('every text member is valid UTF-8 without noncharacters')

        # -- integrity ---------------------------------------------------------------------------------
        corrupt = zf.testzip()
        if corrupt:
            fail('archive CRC check failed on %s' % corrupt)
        else:
            good('archive CRC check passed')

        # -- listing -----------------------------------------------------------------------------------
        print()
        total = 0
        for i in infos:
            total += i.file_size
            print('  %9d  %s' % (i.file_size, i.filename))
        print('  %9d  bytes in %d files (uncompressed); archive %d bytes' % (total, len(infos), os.path.getsize(path)))
        print()
        return manifest


def main(argv):
    args = list(argv)
    out_dir = None
    if '--out' in args:
        i = args.index('--out')
        if i + 1 >= len(args):
            print('--out needs a directory')
            return 2
        out_dir = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    root = os.path.abspath(args[0]) if args else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if out_dir is None:
        out_dir = os.path.join(root, 'dist')
    problems = []

    # The version drives the file name; read it before packaging so a broken manifest fails fast.
    mpath = os.path.join(root, 'manifest.json')
    try:
        with open(mpath, encoding='utf-8') as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as e:
        print('FAIL  manifest.json: %s' % e)
        return 1
    version = str(manifest.get('version') or '')
    if not VERSION_RE.match(version):
        print('FAIL  manifest version %r is not 1-4 dot-separated integers' % version)
        return 1

    members = collect_members(root)
    missing_src = [n for n, full in members if not os.path.isfile(full)]
    if missing_src:
        print('FAIL  required source files are missing: %s' % ', '.join(missing_src))
        return 1
    if not any(n.startswith('src/') for n, _ in members):
        print('FAIL  src/ contains no files')
        return 1

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'multi-add-for-cronometer-%s.zip' % version)
    tmp_path = out_path + '.tmp'
    # Never leave a package under the release name that did not pass verification: a previous (or partial)
    # build is removed first, the archive is written under a temporary name and renamed only when every check
    # passed, otherwise it is deleted - the release name must never point at a broken package that looks
    # identical to a good one.
    for stale in (out_path, tmp_path):
        if os.path.lexists(stale):
            os.remove(stale)
    size = write_zip(tmp_path, members)
    print('wrote %s (%d bytes, %d files)' % (tmp_path, size, len(members)))
    print()

    try:
        verify_zip(tmp_path, problems)
    except Exception as e:                     # an archive that cannot even be opened is a failed build too
        problems.append('archive could not be verified: %s' % e)
        print('FAIL  archive could not be verified: %s' % e)

    if problems:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        print('FAILED: %d problem(s) - no package was written (%s removed, %s absent)'
              % (len(problems), os.path.basename(tmp_path), os.path.basename(out_path)))
        return 1
    os.replace(tmp_path, out_path)
    print('PACKAGE OK: %s' % out_path)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
