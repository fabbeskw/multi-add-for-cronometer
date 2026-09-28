#!/usr/bin/env python3
"""
gen_tdee.py - wrap the pristine Adaptive TDEE engine (an ES module) as the extension's classic scripts.

Usage:
    python tools/gen_tdee.py            # (re)writes src/tdee/adaptive-tdee.js and tests/tdee-sim.js
    python tools/gen_tdee.py --check    # regenerates in memory and byte-compares both files (exit 1 on drift)
    python tools/gen_tdee.py --quiet    # no summary on stdout

Input : vendor/adaptive-tdee/adaptive-tdee.js   the engine, kept exactly as upstream ships it (its maths is fixed)
        vendor/adaptive-tdee/simulate.mjs       the upstream synthetic-person generator (tests and evaluate.mjs)
Output: src/tdee/adaptive-tdee.js   = header + CMA guard + IIFE + the upstream text with ONLY the column-0 `export `
                                      prefixes removed, between /*<upstream>*/ ... /*</upstream>*/ markers, then
                                      window.CMA.tdee = Object.freeze({<every exported name>, UPSTREAM_SHA256})
        tests/tdee-sim.js           = the same treatment for simulate.mjs; its one import (names from
                                      ./adaptive-tdee.js) is bound from CMA.tdee, its exports become CMA.tdeeSim

Deterministic: no timestamps, sorted nothing (names keep upstream order), LF line endings written as bytes, so
two runs on the same vendor files are byte-identical and `--check` can sit in the green bar. The SHA-256 is taken
over the upstream text with CRLF normalised to LF (equal to the file's own hash for an LF checkout), so a Windows
checkout with core.autocrlf does not change the generated file.

Refused (exit 2, nothing written): any import statement or dynamic import()/import.meta in the engine, an import in
simulate.mjs other than `import { a, b } from './adaptive-tdee.js';`, `export default`, `export {`, `export *`,
an export that is not at column 0 or not a plain `const|let|var|function|class NAME` declaration, a duplicate or
reserved export name, the marker text inside the upstream source, and Unicode noncharacters / surrogates (Chrome
refuses a content script that contains them - SPEC 0, tools/check_manifest.py) in the input or the output.

Python 3 stdlib only.
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_SRC = 'vendor/adaptive-tdee/adaptive-tdee.js'
SIM_SRC = 'vendor/adaptive-tdee/simulate.mjs'
ENGINE_OUT = 'src/tdee/adaptive-tdee.js'
SIM_OUT = 'tests/tdee-sim.js'

GUARD = 'window.CMA = window.CMA || {};'
BEGIN = '/*<upstream>*/'
END = '/*</upstream>*/'
RESERVED = {'UPSTREAM_SHA256'}

A = re.ASCII
IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'
# the only export form accepted: `export ` at column 0 followed by a plain named declaration
EXPORT_DECL_RE = re.compile(r'^export (?:async )?(?:const|let|var|function\*?|class) (' + IDENT + r')(?![A-Za-z0-9_$])', A)
# any export keyword that starts a declaration / export list, wherever it sits (comments like "the export has"
# are prose and do not match)
EXPORT_ANY_RE = re.compile(r'(?<![A-Za-z0-9_$.])export(?=\s*(?:\{|\*|default\b|async\b|const\b|let\b|var\b|function\b|class\b))', A)
IMPORT_STMT_RE = re.compile(r'^\s*import(?=\s*[\s{*\'"(])', A | re.M)
IMPORT_DYN_RE = re.compile(r'(?<![A-Za-z0-9_$.])import\s*(?:\(|\.\s*meta\b)', A)
SIM_IMPORT_RE = re.compile(r"^import \{\s*(" + IDENT + r"(?:\s*,\s*" + IDENT + r")*)\s*,?\s*\} from '\./adaptive-tdee\.js';\n", A | re.M)


class GenError(Exception):
    pass


def bad_code_point(cp):
    return 0xD800 <= cp <= 0xDFFF or 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE


def check_code_points(text, what):
    for ln, line in enumerate(text.split('\n'), 1):
        bad = [ch for ch in line if bad_code_point(ord(ch))]
        if bad:
            raise GenError('%s:%d contains %s (noncharacter/surrogate; Chrome refuses the file)'
                           % (what, ln, ', '.join('U+%04X' % ord(ch) for ch in bad[:3])))


def read_text(rel):
    path = os.path.join(ROOT, rel)
    try:
        with open(path, 'rb') as fh:
            raw = fh.read()
    except OSError as e:
        raise GenError('cannot read %s: %s' % (rel, e))
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as e:
        raise GenError('%s is not valid UTF-8 at byte %d' % (rel, e.start))
    if text.startswith('﻿'):
        text = text[1:]
    text = text.replace('\r\n', '\n')
    check_code_points(text, rel)
    return text


def strip_exports(text, what):
    """Remove the column-0 `export ` prefixes; return (new text, exported names in source order)."""
    if BEGIN in text or END in text:
        raise GenError('%s contains the marker text %s / %s' % (what, BEGIN, END))
    names, out = [], []
    for ln, line in enumerate(text.split('\n'), 1):
        for m in EXPORT_ANY_RE.finditer(line):
            if m.start() != 0:
                raise GenError('%s:%d: export not at column 0: %s' % (what, ln, line.strip()[:80]))
        if line.startswith('export'):
            if re.match(r'export\s*(\{|\*|default\b)', line, A):
                raise GenError('%s:%d: only named declarations are supported (no export default / export { } / export *): %s'
                               % (what, ln, line[:80]))
            m = EXPORT_DECL_RE.match(line)
            if not m:
                raise GenError('%s:%d: unsupported export form: %s' % (what, ln, line[:80]))
            name = m.group(1)
            if name in names:
                raise GenError('%s:%d: duplicate export %s' % (what, ln, name))
            if name in RESERVED:
                raise GenError('%s:%d: export name %s is reserved by the wrapper' % (what, ln, name))
            names.append(name)
            line = line[len('export '):]
        out.append(line)
    if not names:
        raise GenError('%s exports nothing' % what)
    return '\n'.join(out), names


def refuse_imports(text, what):
    m = IMPORT_STMT_RE.search(text) or IMPORT_DYN_RE.search(text)
    if m:
        ln = text.count('\n', 0, m.start()) + 1
        raise GenError('%s:%d: imports are not supported in the wrapped engine (it must stay dependency-free)' % (what, ln))


def api_object(target, names, extra):
    lines = ['  %s,' % n for n in names] + ['  %s: %s,' % (k, v) for k, v in extra]
    return '%s = Object.freeze({\n%s\n});\n' % (target, '\n'.join(lines))


def build_engine():
    text = read_text(ENGINE_SRC)
    refuse_imports(text, ENGINE_SRC)
    sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
    body, names = strip_exports(text, ENGINE_SRC)
    out = (
        '/* ' + ENGINE_OUT + ' - generated - do not edit; regenerate with python tools/gen_tdee.py\n'
        ' *\n'
        ' * Source : ' + ENGINE_SRC + ' (pristine upstream Adaptive TDEE engine; its maths is fixed)\n'
        ' * SHA-256: ' + sha + ' (upstream text, LF line endings)\n'
        ' *\n'
        ' * The upstream ES module as a classic content script (SPEC 0). The text between the upstream markers is the\n'
        ' * upstream file with only the column-0 "export" keywords (and the space after them) removed;\n'
        ' * tests/tdee.html proves it against the vendor copy. To update the engine: replace the vendor files, run\n'
        ' * python tools/gen_tdee.py, run the suite.\n'
        ' */\n'
        + GUARD + '\n'
        '(function () {\n'
        "'use strict';\n"
        + BEGIN + '\n'
        + body
        + END + '\n'
        + api_object('window.CMA.tdee', names, [('UPSTREAM_SHA256', "'%s'" % sha)])
        + '})();\n'
    )
    check_code_points(out, ENGINE_OUT)
    return out, names, sha


def build_sim(engine_names):
    text = read_text(SIM_SRC)
    imported = []

    def drop(m):
        imported.extend(n.strip() for n in m.group(1).split(','))
        return ''
    stripped = SIM_IMPORT_RE.sub(drop, text)
    refuse_imports(stripped, SIM_SRC)
    missing = [n for n in imported if n not in engine_names]
    if missing:
        raise GenError('%s imports %s, which the engine does not export' % (SIM_SRC, ', '.join(missing)))
    sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
    body, names = strip_exports(stripped, SIM_SRC)
    binds = ''.join('const %s = window.CMA.tdee.%s;\n' % (n, n) for n in imported)
    out = (
        '/* ' + SIM_OUT + ' - generated - do not edit; regenerate with python tools/gen_tdee.py\n'
        ' *\n'
        ' * Source : ' + SIM_SRC + ' (upstream synthetic people whose true expenditure is known)\n'
        ' * SHA-256: ' + sha + ' (upstream text, LF line endings)\n'
        ' *\n'
        ' * Test helper only (never packaged): load after src/tdee/adaptive-tdee.js. The import line of the upstream\n'
        ' * module is replaced by bindings from CMA.tdee; the text between the upstream markers is the upstream file\n'
        ' * without that line and without the column-0 "export" keywords.\n'
        ' */\n'
        + GUARD + '\n'
        '(function () {\n'
        "'use strict';\n"
        + binds
        + BEGIN + '\n'
        + body
        + END + '\n'
        + api_object('window.CMA.tdeeSim', names, [])
        + '})();\n'
    )
    check_code_points(out, SIM_OUT)
    return out, names


def main(argv):
    check = '--check' in argv
    quiet = '--quiet' in argv
    unknown = [a for a in argv if a not in ('--check', '--quiet')]
    if unknown:
        print('usage: python tools/gen_tdee.py [--check] [--quiet]', file=sys.stderr)
        return 2
    try:
        engine, names, sha = build_engine()
        sim, sim_names = build_sim(names)
    except GenError as e:
        print('ERROR: ' + str(e), file=sys.stderr)
        return 2
    outputs = [(ENGINE_OUT, engine), (SIM_OUT, sim)]
    if check:
        drift = []
        for rel, text in outputs:
            path = os.path.join(ROOT, rel)
            try:
                with open(path, 'rb') as fh:
                    cur = fh.read()
            except OSError:
                cur = None
            if cur != text.encode('utf-8'):
                drift.append(rel)
        if drift:
            print('DRIFT: %s out of date with the vendor sources; run python tools/gen_tdee.py' % ', '.join(drift))
            return 1
        if not quiet:
            print('gen_tdee --check: %s and %s are up to date (upstream %s)' % (ENGINE_OUT, SIM_OUT, sha[:16]))
        return 0
    for rel, text in outputs:
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as fh:
            fh.write(text.encode('utf-8'))
    if not quiet:
        print('wrote %s (%d bytes) and %s (%d bytes)' % (ENGINE_OUT, len(engine.encode('utf-8')), SIM_OUT, len(sim.encode('utf-8'))))
        print('upstream sha256 : %s' % sha)
        print('CMA.tdee        : %s' % ', '.join(names))
        print('CMA.tdeeSim     : %s' % ', '.join(sim_names))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
