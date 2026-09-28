#!/usr/bin/env python3
"""
gen_registry.py - build src/lib/gwt-registry.js from the compiled Cronometer GWT bundle.

Usage:
    python tools/gen_registry.py [tools/bundle/all.js] [--out=src/lib/gwt-registry.js] [--quiet]

Input : tools/bundle/all.js = <perm>.cache.js + deferredjs/<perm>/N.cache.js concatenated
        (produced by tools/fetch_bundle.py).
Output: src/lib/gwt-registry.js = `window.CMA.registry = {...}` (SPEC section 3.2), deterministic:
        sorted keys, generatedAt = bundle mtime (not the wall clock), so re-running on the same
        bundle reproduces the file byte for byte.

Everything is derived from the bundle on every run (SPEC 3.2 step 4): the reader-method -> kind
mapping, the writer-method -> kind mapping, the readObject implementation name, the inlined helper
names and the serializer table.  No obfuscated name is hard-coded; only GWT class-literal names
('ClientSerializationStreamReader', ...) and java.lang/java.util type names, which are stable.

Facts this relies on (verified on build 0A1C16E148676A90CBB128E4829A562F, 2026-09-27):
  * serializer tables: `a[<sigConst>]=[instantiate|undefined, deserialize|undefined(, serialize)]`,
    one table per GWT service (7 in this build) - rows are merged, the functions are shared.
  * reader class prototype: `_.Xs=function(){return i1n(this)}` (bool), `_.Ys/_.$s/_.bt` raw token
    (`this.b[--this.a]`), `_.Zs` Number(...) (double), `_._s` -> long decoder, `_.ct` -> string table,
    `_.Ps=function(){return U0n(this)}` readObject (`U0n` pushes a null slot BEFORE instantiate).
  * the compiler inlines the helpers in many deserializers: `U0n(a)`, `g1n(a,a.b[--a.a])`,
    `i1n(a)`, `a.b[--a.a]` - all recognised (and the helper bodies `Number(a.b[--a.a])` / `!!a.b[--a.a]`,
    should a later compile inline those too).
Parser rules shared with the in-extension port (src/lib/registry-builder.js, SPEC 3.5): both must give the
same answer for the same bundle - ASCII word classes, anchored constants, a read to the right of `?` / `&&` /
`||` / a nested function or inside a while/do/if/switch/try/else/catch/finally statement makes the type
unknown, an enum instantiate ends with an index expression.
  * collections: ArrayList `o_n` = size + elements; HashMap `b0n` = size + key/value pairs;
    Collections$SingletonList instantiate = `new lso(a.Ps())` (element only, no size);
    Arrays$ArrayList instantiate reads size + elements; TreeMap/TreeSet/EnumMap read one object and
    LinkedHashMap one boolean in instantiate (`pre`).  Subclasses of HashMap/ArrayList (e.g.
    UserPreferences) call the same helpers and are emitted as map/list.
Python 3 stdlib only.
"""
import collections
import datetime
import json
import os
import re
import sys

# --------------------------------------------------------------------------------------------
# Constants that are stable across Cronometer deploys (Java class names, not obfuscated names).
# --------------------------------------------------------------------------------------------
BOX_TYPES = {
    'java.lang.Boolean': 'z', 'java.lang.Byte': 'b', 'java.lang.Character': 'c', 'java.lang.Double': 'd',
    'java.lang.Float': 'f', 'java.lang.Integer': 'i', 'java.lang.Long': 'l', 'java.lang.Short': 'h',
    'java.lang.String': 's',
}
SET_TYPES = {'java.util.TreeSet'}                       # SPEC: {k:'set', pre:['o']}
ARRAYS_TYPES = {'java.util.Arrays$ArrayList'}           # SPEC: {k:'arrays'}
SINGLETON_TYPES = {'java.util.Collections$SingletonList'}
EMPTY_TYPES = {'java.util.Collections$EmptyList': 'list', 'java.util.Collections$EmptySet': 'set',
               'java.util.Collections$EmptyMap': 'map'}
DATE_TYPES = {'java.util.Date', 'java.sql.Date', 'java.sql.Time', 'java.sql.Timestamp'}
# java.util collections whose wire shape must be recognised (anything else, e.g. java.util exceptions,
# is an ordinary class)
KNOWN_COLLECTIONS = {'java.util.ArrayList', 'java.util.LinkedList', 'java.util.Vector', 'java.util.Stack',
                     'java.util.HashSet', 'java.util.LinkedHashSet', 'java.util.TreeSet', 'java.util.Arrays$ArrayList',
                     'java.util.HashMap', 'java.util.IdentityHashMap', 'java.util.EnumMap', 'java.util.LinkedHashMap',
                     'java.util.TreeMap', 'java.util.WeakHashMap', 'java.util.Hashtable'}

# element kind of primitive arrays by signature letter (JVM descriptors)
PRIM_ARRAY_ELEM = {'I': 'i', 'D': 'd', 'Z': 'z', 'J': 'l', 'B': 'b', 'S': 'h', 'C': 'c', 'F': 'f'}

# GWT obfuscated identifier alphabet; the FIRST character cycles fastest (Xs, Ys, Zs, $s, _s, at, bt ...)
GWT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_'

IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'
# Python's \w and \b are Unicode-aware, JavaScript's are ASCII: every pattern that uses them is compiled with
# re.ASCII so this generator and its port (src/lib/registry-builder.js) give the same answer for a non-ASCII
# character next to an identifier (SPEC 3.5 shared-parser rules). GWT emits pure ASCII today (non-ASCII as
# \uXXXX escapes); the flag keeps the parity if that changes.
A = re.ASCII
# The constant name is anchored at the START of its identifier run (lookbehind, plus the leading digits the
# unanchored pattern's leftmost match skipped anyway): a run no constant consumes - a base64 data URI, any
# double-quoted string - is scanned once instead of once per character (quadratic: 20 s for a 100 K-char run,
# 1 ms anchored). Mirrored by registry-builder.js.
CONST_RE = re.compile(r"(?<![A-Za-z0-9_$])[0-9]*(" + IDENT + r")='((?:[^'\\]|\\.)*)'")
ROW_RE = re.compile(r"a\[(" + IDENT + r")\]=\[(" + IDENT + r"|undefined),(" + IDENT + r"|undefined)(?:,(" + IDENT + r"))?\]")


def warn(msg):
    print('WARNING: ' + msg, file=sys.stderr)


def var_use(name):
    """Regex matching the variable `name` but not a property `.name` / identifier containing it."""
    return re.compile(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])", A)


COND_RE = re.compile(r"\?|&&|\|\||\bfunction\b", A)


def has_conditional_read(blanked):
    """True when a blanked statement (ReaderInfo.scan marks each read as ' _READ_ ') has a read to the
    RIGHT of a `?`, `&&`, `||` or a nested `function`: that read happens only for some values, so the
    layout is not fixed and the type must be unknown rather than a class with a guessed field list.  A
    read on the LEFT of the operator (`return Vho(),a.Xs()?true:false`, java.lang.Boolean's instantiate)
    is unconditional.  Mirrored by registry-builder.js hasConditionalRead()."""
    m = COND_RE.search(blanked)
    return bool(m) and blanked.find('_READ_', m.start()) >= 0


def js_unescape(s):
    """Minimal unescape for the single-quoted JS literals GWT emits for type signatures."""
    def one(m):
        e = m.group(1)
        if e[0] in 'ux' and len(e) > 1:
            return chr(int(e[1:], 16))
        return {'n': '\n', 'r': '\r', 't': '\t', '0': '\0'}.get(e, e)
    return re.sub(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", one, s)


def gwt_order_key(name):
    return (len(name), [GWT_ALPHABET.index(c) if c in GWT_ALPHABET else 99 for c in reversed(name)])


def split_statements(body):
    """Split a function body into top-level statements: on ';' at bracket depth 0 and after a
    '}' that returns to depth 0 (so `for(...){...}return x` gives two statements)."""
    out, depth, cur = [], 0, []
    for ch in body:
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        if ch == ';' and depth == 0:
            s = ''.join(cur).strip()
            if s:
                out.append(s)
            cur = []
            continue
        cur.append(ch)
        if ch == '}' and depth == 0:
            s = ''.join(cur).strip()
            if s:
                out.append(s)
            cur = []
    tail = ''.join(cur).strip()
    if tail:
        out.append(tail)
    return out


def split_for(stmt):
    """'for(header){body}' -> (header, body) with balanced parentheses."""
    depth, i = 0, 3
    while i < len(stmt):
        if stmt[i] == '(':
            depth += 1
        elif stmt[i] == ')':
            depth -= 1
            if depth == 0:
                break
        i += 1
    header = stmt[4:i]
    rest = stmt[i + 1:].strip()
    if rest.startswith('{') and rest.endswith('}'):
        return header, rest[1:-1]
    return header, rest


class Bundle:
    def __init__(self, js):
        self.js = js
        self._fn_cache = {}
        self.constants = {}
        for m in CONST_RE.finditer(js):
            name = m.group(1)
            if len(name) >= 2 and name not in self.constants:   # first wins; skip 1-letter locals
                self.constants[name] = js_unescape(m.group(2))

    def resolve(self, token):
        """A quoted literal or a constant name -> string (None when unknown)."""
        if token is None:
            return None
        if token.startswith("'") and token.endswith("'"):
            return js_unescape(token[1:-1])
        return self.constants.get(token)

    def fn(self, name):
        """Full text `function NAME(params){...}` (brace matched) or None."""
        if name in self._fn_cache:
            return self._fn_cache[name]
        key = 'function ' + name + '('
        i = self.js.find(key)
        text = None
        if i >= 0:
            j = self.js.find('{', i)
            depth, k, n = 0, j, len(self.js)
            while k < n:
                ch = self.js[k]
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            text = self.js[i:k + 1]
        self._fn_cache[name] = text
        return text

    def fn_parts(self, name):
        """(params list, inner body) of a function, or (None, None)."""
        text = self.fn(name)
        if text is None:
            return None, None
        head_end = text.find('{')
        params = [p.strip() for p in text[text.find('(') + 1:text.find(')')].split(',') if p.strip()]
        return params, text[head_end + 1:-1]

    def class_block(self, class_literal):
        """Prototype block of the class whose class literal is `class_literal`: the text between
        `<defineClass>(<id>,...` and `<makeClassLiteral>(<pkg>,'<literal>',<id>)`."""
        m = re.search(r"\b" + IDENT + r"\(" + IDENT + r",'" + re.escape(class_literal) + r"',(\d+)\)", self.js, A)
        if not m:
            return None
        cid = m.group(1)
        dm = None
        for dm in re.finditer(r"\b(" + IDENT + r")\(" + cid + r",\d+,", self.js[:m.start()], A):
            pass
        if dm is None:
            return None
        return self.js[dm.start():m.start()]


# --------------------------------------------------------------------------------------------
# 1. Reader side: derive reader-method -> kind and the inlined helper names.
# --------------------------------------------------------------------------------------------
class ReaderInfo:
    def __init__(self, bundle):
        self.b = bundle
        self.methods = {}          # prototype method name -> kind ('z','b','h','i','d','l','s','o')
        self.obj_impl = None       # e.g. 'U0n' : readObject implementation
        self.bool_helper = None    # e.g. 'i1n'
        self.dbl_helper = None     # e.g. 'j1n'
        self.long_helper = None    # e.g. 'k1n'
        self.long_decoder = None   # e.g. 'S0n'
        self.str_helper = None     # e.g. 'g1n'
        self.arr = 'b'             # token array field (this.b)
        self.idx = 'a'             # index field (this.a)
        self._pat = {}
        self.derive()

    @staticmethod
    def proto_methods(block):
        """[(method, inner body)] for `_.X=function Y(...){...}` in a prototype block."""
        out = []
        for m in re.finditer(r"_\.(" + IDENT + r")=function (?:" + IDENT + r")?\(([^)]*)\)\{", block):
            i = m.end() - 1
            depth, k = 0, i
            while k < len(block):
                if block[k] == '{':
                    depth += 1
                elif block[k] == '}':
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            out.append((m.group(1), block[i + 1:k].strip()))
        return out

    def derive(self):
        b = self.b
        client = b.class_block('ClientSerializationStreamReader')
        abstract = b.class_block('AbstractSerializationStreamReader')
        if client is None or abstract is None:
            raise SystemExit('cannot locate the serialization stream reader classes in the bundle')
        raw, numbers = [], []
        for meth, inner in self.proto_methods(client) + self.proto_methods(abstract):
            m = re.fullmatch(r"return this\.([a-z])\[--this\.([a-z])\]", inner)
            if m:
                self.arr, self.idx = m.group(1), m.group(2)
                raw.append(meth)
                continue
            m = re.fullmatch(r"return (" + IDENT + r")\(this\)", inner)
            if m:
                helper = m.group(1)
                hp, hb = b.fn_parts(helper)
                if hb is None:
                    warn('reader helper %s not found' % helper)
                    continue
                hb = hb.strip()
                if re.fullmatch(r"return !!" + IDENT + r"\." + IDENT + r"\[--" + IDENT + r"\." + IDENT + r"\]", hb):
                    self.methods[meth] = 'z'
                    self.bool_helper = helper
                elif re.fullmatch(r"return Number\(" + IDENT + r"\." + IDENT + r"\[--" + IDENT + r"\." + IDENT + r"\]\)", hb):
                    numbers.append(meth)
                    self.dbl_helper = self.dbl_helper or helper
                elif '.push(null)' in hb:
                    self.methods[meth] = 'o'
                    self.obj_impl = helper
                elif re.search(r"\[--", hb) and re.search(r"return (" + IDENT + r")\(", hb):
                    self.methods[meth] = 'l'
                    self.long_helper = helper
                    self.long_decoder = re.search(r"return (" + IDENT + r")\(", hb).group(1)
                else:
                    warn('unclassified reader helper %s: %s' % (helper, hb[:80]))
                continue
            m = re.fullmatch(r"return (" + IDENT + r")\(this,this\.([a-z])\[--this\.([a-z])\]\)", inner)
            if m:
                helper = m.group(1)
                hp, hb = b.fn_parts(helper)
                if hb and re.search(r"return " + IDENT + r">0\?" + IDENT + r"\." + IDENT + r"\[" + IDENT + r"-1\]:null", hb):
                    self.methods[meth] = 's'
                    self.str_helper = helper
                else:
                    warn('unclassified string-like reader %s' % meth)
            # anything else in these blocks is not a read method (fields, misc) -> ignore
        # Raw readers: the Java names sort readByte < readChar < readInt < readShort and GWT hands out
        # obfuscated names in that order (cross-checked below against the writer side).
        raw.sort(key=gwt_order_key)
        raw_kinds = {1: ['i'], 2: ['b', 'i'], 3: ['b', 'i', 'h'], 4: ['b', 'c', 'i', 'h']}.get(len(raw))
        if raw_kinds is None:
            raise SystemExit('unexpected number of raw reader methods: %r' % raw)
        for meth, kind in zip(raw, raw_kinds):
            self.methods[meth] = kind
        numbers.sort(key=gwt_order_key)
        for meth, kind in zip(numbers, ['d', 'f']):
            self.methods[meth] = kind
        missing = {'z', 'i', 'd', 'l', 's', 'o'} - set(self.methods.values())
        if missing:
            raise SystemExit('reader derivation incomplete, missing kinds %r (found %r)' % (missing, self.methods))

    # --- statement scanner -------------------------------------------------------------------
    def read_pattern(self, r):
        """Compiled regex matching every token-consuming expression where `r` is the reader variable."""
        if r in self._pat:
            return self._pat[r]
        R = re.escape(r)
        alts = []
        # Every inlined helper call is anchored with the same lookbehind as the `m` / `raw` alternatives (and
        # the writer's `h`), NOT a word boundary: `\b` before a `$`-initial name (GWT hands them out in
        # sequence: ... Z0n $0n _0n a1n ...) needs a word char BEFORE the `$`, but call sites are preceded by
        # `(` `,` `=` or a space, so such a helper would never match and every class using it would be unknown.
        if self.str_helper:
            alts.append(r"(?P<s>(?<![\w$.])%s\(%s,%s\.%s\[--%s\.%s\]\))" % (re.escape(self.str_helper), R, R, self.arr, R, self.idx))
        alts.append(r"(?P<m>(?<![\w$.])%s\.(?P<mm>%s)\(\))" % (R, '|'.join(re.escape(k) for k in self.methods)))
        if self.obj_impl:
            alts.append(r"(?P<o>(?<![\w$.])%s\(%s\))" % (re.escape(self.obj_impl), R))
        if self.bool_helper:
            alts.append(r"(?P<z>(?<![\w$.])%s\(%s\))" % (re.escape(self.bool_helper), R))
        if self.dbl_helper:
            alts.append(r"(?P<d>(?<![\w$.])%s\(%s\))" % (re.escape(self.dbl_helper), R))
        if self.long_helper:
            alts.append(r"(?P<l>(?<![\w$.])%s\(%s\))" % (re.escape(self.long_helper), R))
        # The double / bool helper BODIES, should a future compile inline them (`Number(a.b[--a.a])`,
        # `!!a.b[--a.a]`), are typed like the helpers - before the bare `raw` token read inside them would
        # count as an int (registry-builder.js readPattern has the same two alternatives).
        raw = r"%s\.%s\[--%s\.%s\]" % (R, self.arr, R, self.idx)
        alts.append(r"(?P<nd>(?<![\w$.])Number\(%s\))" % raw)
        alts.append(r"(?P<nz>(?<![\w$.])!!%s)" % raw)
        alts.append(r"(?P<raw>(?<![\w$.])%s)" % raw)
        self._pat[r] = re.compile('|'.join(alts), A)
        return self._pat[r]

    def scan(self, r, stmt):
        """-> (kinds in evaluation order, statement with the reads blanked out)."""
        pat = self.read_pattern(r)
        kinds = []

        def repl(m):
            g = m.lastgroup
            if g == 'm':
                kinds.append(self.methods[m.group('mm')])
            elif g == 'raw':
                kinds.append('i')   # inlined raw token read: int-like (byte/short/int share the wire form)
            elif g == 'nd':
                kinds.append('d')   # inlined double helper body
            elif g == 'nz':
                kinds.append('z')   # inlined bool helper body
            else:
                kinds.append(g)
            return ' _READ_ '
        return kinds, pat.sub(repl, stmt)


# --------------------------------------------------------------------------------------------
# 2. Writer side: writer-method -> kind by correlating classes that have both ser and deser.
# --------------------------------------------------------------------------------------------
class WriterInfo:
    def __init__(self, bundle):
        self.b = bundle
        self.methods = {}   # prototype method name -> kind
        self.candidates = []
        self.helper_to_method = {}   # inlined helper name (Y0n, Z0n, $0n, X0n) -> prototype method (Ts, Us, Ws, Ss)
        self.raw_writer = None       # e.g. 'v1n': appends one raw token (used inlined for byte/short/bool/long)
        self.long_encoder = None     # e.g. 'T0n'
        self.bool_method = None
        self.long_method = None
        self.int_method = None       # prototype method whose helper appends ''+value (writeInt)
        block = (bundle.class_block('AbstractSerializationStreamWriter') or '') + \
                (bundle.class_block('ClientSerializationStreamWriter') or '')
        for m in re.finditer(r"_\.(" + IDENT + r")=function (?:" + IDENT + r")?\((\w)\)\{([^}]*)\}", block, A):
            meth, param, body = m.group(1), m.group(2), m.group(3)
            self.candidates.append(meth)
            P = re.escape(param)
            if "?'1':'0'" in body or '?"1":"0"' in body:
                self.methods[meth] = 'z'      # writeBoolean is the only one with the '1'/'0' literal
                self.bool_method = meth
                continue
            mm = re.fullmatch(r"(" + IDENT + r")\(this,\(?(?:" + IDENT + r"\(\),)?''\+" + P + r"\)?\)", body)
            if mm:                            # writeByte/writeShort: RAW(this,''+a)
                self.raw_writer = mm.group(1)
                continue
            mm = re.fullmatch(r"(" + IDENT + r")\(this,(" + IDENT + r")\(" + P + r"\)\)", body)
            if mm:                            # writeLong: RAW(this,ENCODER(a))
                self.raw_writer = self.raw_writer or mm.group(1)
                self.long_encoder = mm.group(2)
                self.long_method = meth
                continue
            mm = re.fullmatch(r"(" + IDENT + r")\(this," + P + r"\)", body)
            if mm:                            # writeInt/Double/Object/String: HELPER(this,a)
                self.helper_to_method[mm.group(1)] = meth
                hp, hb = bundle.fn_parts(mm.group(1))
                if hb and self.raw_writer and re.fullmatch(re.escape(self.raw_writer) + r"\(" + IDENT + r",\(?(?:" + IDENT + r"\(\),)?''\+" + IDENT + r"\)?\)", hb.strip()):
                    self.int_method = self.int_method or meth
        if not self.candidates:
            raise SystemExit('cannot locate the serialization stream writer class')
        self.methods['#raw'] = 'i'
        self._pat = {}

    def write_pattern(self, w):
        """Matches prototype writes `w.Ts(` and the inlined helper forms; group 'm' = method,
        'h' = helper name, 'l' = inlined long, 'z' = inlined bool, 'r' = inlined raw int-like."""
        if w not in self._pat:
            W = re.escape(w)
            alts = [r"(?P<m>(?<![\w$.])%s\.(?P<mm>%s)\()" % (W, '|'.join(re.escape(k) for k in self.candidates))]
            if self.helper_to_method:
                alts.append(r"(?P<h>(?<![\w$.])(?P<hh>%s)\(%s,)" % ('|'.join(re.escape(k) for k in self.helper_to_method), W))
            if self.raw_writer:
                RW = re.escape(self.raw_writer)
                if self.long_encoder:
                    alts.append(r"(?P<l>(?<![\w$.])%s\(%s,%s\()" % (RW, W, re.escape(self.long_encoder)))
                alts.append(r"(?P<z>(?<![\w$.])%s\(%s,[^;]*?\?'1':'0'\))" % (RW, W))
                alts.append(r"(?P<r>(?<![\w$.])%s\(%s,)" % (RW, W))
            self._pat[w] = re.compile('|'.join(alts), A)
        return self._pat[w]

    def method_of(self, m):
        g = m.lastgroup
        if g == 'm':
            return m.group('mm')
        if g == 'h':
            return self.helper_to_method[m.group('hh')]
        if g == 'l':
            return self.long_method
        if g == 'z':
            return self.bool_method
        return '#raw'            # inlined raw ''+x: byte/short/int share the wire form (kind 'i')

    def scan_ser(self, name, depth=0):
        """[(writer method, written expression)] of a serializer (superclass calls inlined), or None."""
        params, inner = self.b.fn_parts(name)
        if inner is None or len(params) != 2 or depth > 8:
            return None
        w, o = params
        seq = []
        pat = self.write_pattern(w)
        use = var_use(w)
        for stmt in split_statements(inner):
            found = []
            for m in pat.finditer(stmt):
                meth = self.method_of(m)
                if meth is None:
                    return None
                found.append((meth, stmt[m.end():].split(')')[0]))
            rest = pat.sub(' _W_ ', stmt)
            if found:
                seq.extend(found)
                if use.search(rest):
                    return None
                continue
            m = re.fullmatch(r"(" + IDENT + r")\(" + re.escape(w) + r"," + re.escape(o) + r"\)", stmt)
            if m:
                sub = self.scan_ser(m.group(1), depth + 1)
                if sub is None:
                    return None
                seq.extend(sub)
                continue
            if use.search(stmt):
                return None
        return seq

    def correlate(self, pairs):
        """pairs: [(writer method sequence, reader kind sequence)] -> vote writer method -> kind."""
        votes = collections.defaultdict(collections.Counter)
        for wseq, kinds in pairs:
            if len(wseq) != len(kinds):
                continue
            for wm, k in zip(wseq, kinds):
                votes[wm][k] += 1
        for wm, c in votes.items():
            if wm.startswith('#'):
                continue          # pseudo method for inlined raw writes (byte/short/int are all decimal)
            kind, n = c.most_common(1)[0]
            if wm in self.methods and self.methods[wm] != kind:
                warn('writer method %s: literal says %s but correlation says %s' % (wm, self.methods[wm], kind))
                continue
            if len(c) > 1:
                warn('writer method %s has mixed votes %r' % (wm, dict(c)))
            self.methods[wm] = kind


# --------------------------------------------------------------------------------------------
# 3. Classification of every serializer-table row.
# --------------------------------------------------------------------------------------------
def flat(items):
    """Loop-free kinds list, or None when the structure contains a loop."""
    if items is None or any(isinstance(x, tuple) for x in items):
        return None
    return list(items)


class Classifier:
    def __init__(self, bundle, reader, writer):
        self.b, self.r, self.w = bundle, reader, writer
        self._reads_cache = {}

    # --- structural read extraction ------------------------------------------------------------
    def reads_of(self, name, depth=0):
        """(items, error): items = kinds in evaluation order; a loop is ('*', [kinds per iteration])."""
        if name in self._reads_cache:
            return self._reads_cache[name]
        params, inner = self.b.fn_parts(name)
        if inner is None:
            res = (None, 'function %s not found' % name)
        elif not params:
            res = ([], None)
        else:
            r = params[0]
            o = params[1] if len(params) > 1 else None
            res = self.reads_in(inner, r, o, name, depth)
        self._reads_cache[name] = res
        return res

    def reads_in(self, code, r, o, name, depth):
        items = []
        use = var_use(r)
        for stmt in split_statements(code):
            if stmt.startswith('for('):
                header, body = split_for(stmt)
                hk, hrest = self.r.scan(r, header)
                if hk or use.search(hrest):
                    return None, 'reads in for-header of %s: %s' % (name, stmt[:80])
                sub, err = self.reads_in(body, r, o, name, depth)
                if err:
                    return None, err
                if flat(sub) is None:
                    return None, 'nested loop in %s' % name
                items.append(('*', sub))
                continue
            # split_statements() cuts after every `}` that returns to depth 0, so `if(..){..}else{..}` and
            # `try{..}catch(e){..}finally{..}` arrive as separate statements: an else / catch / finally part is
            # as conditional as the head it belongs to (registry-builder.js readsIn has the same list).
            if re.match(r"(while|do|if|switch|try|else|catch|finally)\b", stmt, A):
                k, rest = self.r.scan(r, stmt)
                if k or use.search(rest):
                    return None, 'conditional reads in %s: %s' % (name, stmt[:80])
                continue
            found, rest = self.r.scan(r, stmt)
            if found and has_conditional_read(rest):
                return None, 'conditional reads in %s: %s' % (name, stmt[:80])
            items.extend(found)
            if not use.search(rest):
                continue
            m = re.fullmatch(r"(" + IDENT + r")\(" + re.escape(r) + r"," + re.escape(o or '__none__') + r"\)", stmt)
            if m and not found:   # superclass deserializer / shared collection helper
                if depth > 8:
                    return None, 'recursion too deep at %s' % name
                sub, err = self.reads_of(m.group(1), depth + 1)
                if err:
                    return None, err
                items.extend(sub)
                continue
            return None, 'unrecognised use of reader in %s: %s' % (name, stmt[:80])
        return items, None

    # --- helpers -------------------------------------------------------------------------------
    @staticmethod
    def base(sig):
        return sig.split('/')[0]

    @staticmethod
    def collection_shape(pre_items, f_items):
        """Recognise list/map/arrays shapes from read structures. -> (kind, pre) or None."""
        fp = flat(pre_items)
        if f_items == ['i', ('*', ['o'])] and fp is not None:
            return 'list', fp
        if f_items == ['i', ('*', ['o', 'o'])] and fp is not None:
            return 'map', fp
        if pre_items == ['i', ('*', ['o'])] and f_items == []:
            return 'arrays', []
        return None

    # --- main entry ----------------------------------------------------------------------------
    def classify(self, sig, row):
        inst, deser, ser = row['inst'], row['deser'], row['ser']
        base = self.base(sig)
        if sig.startswith('['):
            return self.classify_array(sig, row)
        if base in BOX_TYPES:
            t = BOX_TYPES[base]
            if inst:
                kinds = flat(self.reads_of(inst)[0])
                if kinds and len(kinds) == 1 and kinds[0] != t and not (t == 'c' and kinds[0] == 'i'):
                    warn('%s: instantiate reads %s, expected %s' % (sig, kinds[0], t))
                    t = kinds[0]
            return {'k': 'box', 't': t}
        if not inst and not deser:
            return self.classify_ser_only(sig, row)

        pre_items, err = self.reads_of(inst) if inst else ([], None)
        if err:
            return {'k': 'unknown', 'why': err}
        f_items, err = self.reads_of(deser) if deser else ([], None)
        if err:
            return {'k': 'unknown', 'why': err}
        pre, fields = flat(pre_items), flat(f_items)

        # ---- java.util special shapes (SPEC 3.2) ----
        if base in EMPTY_TYPES:
            if pre or fields:
                return {'k': 'unknown', 'why': 'empty collection with reads'}
            return {'k': 'empty', 't': EMPTY_TYPES[base]}
        if base in SINGLETON_TYPES:
            if pre != ['o'] or fields:
                return {'k': 'unknown', 'why': 'singleton with unexpected reads pre=%r f=%r' % (pre_items, f_items)}
            return {'k': 'singleton'}
        if base in DATE_TYPES:
            if pre != ['l'] or fields is None:
                return {'k': 'unknown', 'why': 'date type with unexpected reads pre=%r f=%r' % (pre_items, f_items)}
            entry = {'k': 'date'}
            if fields:
                entry['f'] = fields          # java.sql.Timestamp reads nanos after the long
            return entry
        shape = self.collection_shape(pre_items, f_items)
        if shape:
            kind, spre = shape
            if base in ARRAYS_TYPES and kind != 'arrays':
                return {'k': 'unknown', 'why': 'Arrays$ArrayList with unexpected shape'}
            if base in SET_TYPES:
                kind = 'set'
            entry = {'k': kind}
            if spre:
                entry['pre'] = spre
            if not base.startswith('java.util.'):
                entry['sub'] = True          # application subclass of a java.util collection
            return entry
        if base in KNOWN_COLLECTIONS:
            return {'k': 'unknown', 'why': 'java.util collection with unrecognised shape pre=%r f=%r' % (pre_items, f_items)}

        # ---- enum ----
        # Enum.values()[ordinal]: the instantiate ends with an index expression - `return c[b]` today, and a
        # future compile may hoist differently (`return ($pj(),c)[b]`, `return Xyz[b]`, `return c[b]|0`); a
        # class instantiate never ends with `[x]`.  The read shape (one int, no deserializer reads) is checked too.
        if inst:
            params, inner = self.b.fn_parts(inst)
            if inner is not None and re.search(r"return [^;]*\[[a-z]\](\|0)?$", inner.strip()):
                if pre == ['i'] and not fields:
                    return {'k': 'enum'}
                return {'k': 'unknown', 'why': 'enum-like instantiate with reads %r' % (pre_items,)}

        # ---- ordinary class ----
        if pre is None or fields is None:
            return {'k': 'unknown', 'why': 'loop in class reads pre=%r f=%r' % (pre_items, f_items)}
        entry = {'k': 'class', 'f': pre + fields}
        if pre:
            entry['ipre'] = len(pre)      # how many leading fields are read by instantiate (documentation)
        if ser:
            wseq = self.w.scan_ser(ser)
            if wseq is not None:
                wk = [self.w.methods.get(m, '?') for m, _ in wseq]
                if wk != entry['f']:
                    warn('%s: serializer layout %r differs from deserializer layout %r' % (sig, ''.join(wk), ''.join(entry['f'])))
        return entry

    def classify_ser_only(self, sig, row):
        """client -> server only types (AddEntryChange...): layout from the serializer."""
        wseq = self.w.scan_ser(row['ser'])
        if wseq is None:
            return {'k': 'unknown', 'why': 'unparseable serializer %s' % row['ser']}
        kinds = [self.w.methods.get(m) for m, _ in wseq]
        if None in kinds:
            return {'k': 'unknown', 'why': 'serializer %s uses unmapped writer methods %r' % (row['ser'], [m for m, _ in wseq])}
        return {'k': 'class', 'f': kinds, 'from': 'ser', '_w': wseq}

    def classify_array(self, sig, row):
        elem_sig = sig[1:].split('/')[0]
        if elem_sig.startswith('['):
            e = 'o'
        elif elem_sig.startswith('L'):
            e = 's' if elem_sig == 'Ljava.lang.String;' else 'o'
        else:
            e = PRIM_ARRAY_ELEM.get(elem_sig[0], 'o')
        entry = {'k': 'array', 'e': e}
        inst, deser = row['inst'], row['deser']
        if inst:
            items, err = self.reads_of(inst)
            if err or items != ['i']:
                return {'k': 'unknown', 'why': 'array instantiate %s: %s / reads %r' % (inst, err, items)}
        if deser:
            items, err = self.reads_of(deser)
            if err:
                return {'k': 'unknown', 'why': err}
            if len(items) == 1 and isinstance(items[0], tuple) and len(items[0][1]) == 1:
                entry['e'] = items[0][1][0]
            elif items:
                return {'k': 'unknown', 'why': 'array deserializer %s reads %r' % (deser, items)}
        elif not inst:
            entry['from'] = 'ser'   # client->server only: element kind from the signature
        return entry


# --------------------------------------------------------------------------------------------
# 4. Table, policies, service methods.
# --------------------------------------------------------------------------------------------
def load_table(bundle):
    rows = {}
    n_rows = 0
    n_tables = len(re.findall(r"function " + IDENT + r"\(\)\{var a=\{\};a\[", bundle.js))
    unresolved = 0
    for m in ROW_RE.finditer(bundle.js):
        sig = bundle.constants.get(m.group(1))
        if not sig:
            unresolved += 1
            continue
        n_rows += 1
        inst, deser, ser = [None if g in (None, 'undefined') else g for g in m.groups()[1:]]
        row = rows.setdefault(sig, {'inst': None, 'deser': None, 'ser': None})
        for key, val in (('inst', inst), ('deser', deser), ('ser', ser)):
            if val and row[key] and row[key] != val:
                warn('%s: conflicting %s functions %s / %s across tables' % (sig, key, row[key], val))
            row[key] = row[key] or val
    return rows, n_rows, n_tables, unresolved


def find_policies(bundle):
    """service path -> policy hash from the RemoteServiceProxy constructors:
       X.call(this,<getModuleBase>(),'app'|<const>,'<32 hex>',<typeSerializer>)"""
    policies = {}
    for m in re.finditer(r"\.call\(this," + IDENT + r"\(\),('[^']*'|" + IDENT + r"),'([A-F0-9]{32})'," + IDENT + r"\)", bundle.js):
        path = bundle.resolve(m.group(1))
        if path and path not in policies:
            policies[path] = m.group(2)
    if 'app' not in policies:   # fallback per SPEC 3.2
        m = re.search(r"'app','([A-F0-9]{32})'", bundle.js)
        if m:
            policies['app'] = m.group(1)
    return policies


def find_service_methods(bundle):
    """proxy class name -> sorted method names, via the RemoteServiceProxy.ServiceHelper ctor
       `function H(a,b,c){this.e=a;this.a=b+'.'+c;this.b=c;...}` and its `new H(this,<proxy>,<method>)` sites."""
    m = re.search(r"function (" + IDENT + r")\(a,b,c\)\{this\.e=a;this\.a=b\+'\.'\+c;this\.b=c;", bundle.js)
    if not m:
        return {}
    helper = m.group(1)
    out = collections.defaultdict(set)
    for mm in re.finditer(r"new " + re.escape(helper) + r"\(this,('[^']*'|" + IDENT + r"),('[^']*'|" + IDENT + r")\)", bundle.js):
        proxy, meth = bundle.resolve(mm.group(1)), bundle.resolve(mm.group(2))
        if proxy and meth:
            out[proxy].add(meth)
    return {k: sorted(v) for k, v in out.items()}


# --------------------------------------------------------------------------------------------
# 5. Emit.
# --------------------------------------------------------------------------------------------
EXPECTED_LAYOUTS = collections.OrderedDict([   # SPEC 3.3; the tests assert these
    ('com.cronometer.shared.entries.models.Serving/2553599101', 'ozzoioidiliii'),
    ('com.cronometer.shared.entries.models.Day/782579793', 'bbh'),
    ('com.cronometer.shared.entries.models.Time/1552252503', 'bbb'),
    ('com.cronometer.shared.entries.changes.AddEntryChange/3949104564', 'zzo'),
    ('com.cronometer.shared.entries.changes.AddEntryChangeResult/2006663169', 'o'),
    ('com.cronometer.shared.entries.changes.ErrorEntryChangeResult/4150648168', 'oo'),
    ('com.cronometer.shared.entries.models.DayInfo/416556043', 'zooozs'),
    ('com.cronometer.shared.foods.models.Measure/1979099908', 'dziziosood'),
    ('com.cronometer.shared.foods.models.FoodMeasures/2106205728', 'io'),
    ('com.cronometer.shared.foods.models.Food/2097636843', 'izoisiiioolooozsoooi'),
    ('com.cronometer.shared.foods.models.Translation/4034452093', 'osi'),
    ('com.cronometer.shared.user.models.Language/1257207975', 'ssss'),
    ('com.cronometer.shared.foods.models.SearchHit/1904627920', 'iiissisziosioi'),
    ('com.cronometer.shared.user.models.User/91151502', None),
    ('com.cronometer.shared.user.models.UserPreferences/1003470664', 'map'),
    ('java.util.HashMap/1797211028', 'map'),
    ('java.util.Collections$SingletonList/1586180994', 'singleton'),
    ('[Ljava.lang.String;/2600011424', 'array:s'),
    ('com.cronometer.shared.foods.models.Measure$Type/2365167904', 'enum'),
    ('com.cronometer.shared.foods.FoodSource/4236433762', 'enum'),
    ('com.cronometer.shared.user.exceptions.NotLoggedInException/844385496', 's'),
])
# SPEC 12.2: the types only the Adaptive TDEE reads decode (registry-builder.js OPTIONAL_LAYOUTS / checkOptional).
# Reported like the list above; a change there turns the TDEE sync off and never fails the core layouts.
OPTIONAL_LAYOUTS = collections.OrderedDict([
    ('com.cronometer.shared.charts.models.DataPoint/3560061380', 'ood'),
    ('[Lcom.cronometer.shared.charts.models.DataPoint;/1958809962', 'array:o'),
    ('com.cronometer.shared.entries.models.CalendarInfo/1410710242', 'o'),
    ('com.cronometer.shared.entries.models.CalendarDayInfo/3738020097', 'zoooozzzzo'),
    ('com.cronometer.shared.entries.DayQueryType/1802942352', 'enum'),
    ('[[D/158574334', 'array:o'),
    ('[D/2047612875', 'array:d'),
])


def layout_str(e):
    if e is None:
        return 'MISSING'
    if e['k'] == 'class':
        return ''.join(e['f'])
    if e['k'] == 'array':
        return 'array:' + e['e']
    return e['k'] + (':' + ''.join(e['pre']) if e.get('pre') else '')


def entry_json(e):
    e = {k: v for k, v in e.items() if not k.startswith('_')}
    return json.dumps(e, separators=(',', ':'), sort_keys=True)


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    opts = [a for a in argv if a.startswith('--')]
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    bundle_path = args[0] if args else os.path.join(here, 'bundle', 'all.js')
    out_path = os.path.join(root, 'src', 'lib', 'gwt-registry.js')
    for o in opts:
        if o.startswith('--out='):
            out_path = o[6:]
    quiet = '--quiet' in opts

    if not os.path.isfile(bundle_path):
        print('bundle not found: %s (run tools/fetch_bundle.py first)' % bundle_path, file=sys.stderr)
        return 2
    with open(bundle_path, encoding='utf-8', errors='replace') as fh:
        js = fh.read()
    bundle = Bundle(js)
    mtime = os.path.getmtime(bundle_path)
    generated_at = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    perm = re.search(r"\$strongName\s*=\s*'([0-9A-F]{32})'", js)
    perm = perm.group(1) if perm else None
    policies = find_policies(bundle)
    reader = ReaderInfo(bundle)
    writer = WriterInfo(bundle)
    rows, n_rows, n_tables, unresolved = load_table(bundle)
    if not rows:
        print('no serializer table rows found', file=sys.stderr)
        return 1
    classifier = Classifier(bundle, reader, writer)

    # pass 1: derive the writer map from every row that has both a deserializer and a serializer
    pairs = []
    for sig, row in rows.items():
        if row['deser'] and row['ser'] and not sig.startswith('['):
            kinds = flat(classifier.reads_of(row['deser'])[0])
            wseq = writer.scan_ser(row['ser'])
            if kinds is not None and wseq is not None and len(kinds) == len(wseq):
                pairs.append(([m for m, _ in wseq], kinds))
    writer.correlate(pairs)

    # pass 2: classify everything
    types = {}
    for sig in sorted(rows):
        try:
            entry = classifier.classify(sig, rows[sig])
        except Exception as exc:  # never let one row break the build
            entry = {'k': 'unknown', 'why': 'exception: %s' % exc}
        types[sig] = entry

    # pass 3: serializer-only enums. Enum serializers write the ordinal field of java.lang.Enum
    # (`a.Ts(b.g)` in this build); derive that field name from the enums that have an instantiate.
    ordinal_votes = collections.Counter()
    for sig, row in rows.items():
        if types[sig]['k'] == 'enum' and row['ser']:
            wseq = writer.scan_ser(row['ser'])
            if wseq and len(wseq) == 1:
                ordinal_votes[wseq[0][1]] += 1
    ordinal_field = ordinal_votes.most_common(1)[0][0] if ordinal_votes else None
    for sig, e in types.items():
        if e.get('from') == 'ser' and e['k'] == 'class' and e['f'] == ['i'] and ordinal_field \
                and e.get('_w') and e['_w'][0][1] == ordinal_field:
            types[sig] = {'k': 'enum', 'from': 'ser'}

    kinds_count = collections.Counter(e['k'] for e in types.values())
    unknowns = sorted((s, e['why']) for s, e in types.items() if e['k'] == 'unknown')
    service_methods = find_service_methods(bundle)
    crono = next((v for k, v in service_methods.items() if k.startswith('CronometerService')), [])

    registry = collections.OrderedDict()
    registry['generatedAt'] = generated_at
    registry['bundle'] = os.path.basename(bundle_path)
    registry['permutation'] = perm
    registry['policyHash'] = policies.get('app')
    registry['proPolicyHash'] = policies.get('pro')
    registry['policies'] = collections.OrderedDict(sorted(policies.items()))
    registry['readerMethods'] = collections.OrderedDict(sorted(reader.methods.items()))
    registry['readerHelpers'] = collections.OrderedDict([
        ('readObject', reader.obj_impl), ('bool', reader.bool_helper), ('double', reader.dbl_helper),
        ('long', reader.long_helper), ('longDecoder', reader.long_decoder), ('string', reader.str_helper)])
    registry['writerMethods'] = collections.OrderedDict(sorted(writer.methods.items()))
    registry['enumOrdinalField'] = ordinal_field
    registry['serviceMethods'] = crono
    registry['stats'] = collections.OrderedDict([
        ('tables', n_tables), ('rows', n_rows), ('types', len(types)),
        ('kinds', collections.OrderedDict(sorted(kinds_count.items()))), ('unknown', len(unknowns))])

    lines = []
    lines.append('/* GENERATED FILE - do not edit. Produced by tools/gen_registry.py (SPEC section 3.2)')
    lines.append(' * from %s (permutation %s, mtime %s).' % (os.path.basename(bundle_path), perm, generated_at))
    lines.append(" * For reviewers: this file is DATA, not logic - a lookup table of the Cronometer web client's serialised types")
    lines.append(" * that the packaged decoder (src/lib/gwt-stream.js) reads. The 32-digit hex strings are Cronometer's public build")
    lines.append(' * (permutation) and serialisation-policy hashes; short names such as "U0n" are function names of the compiled web')
    lines.append(' * client that the decoder recognises. Nothing in it runs besides this one assignment. The generator is public:')
    lines.append(' * tools/gen_registry.py in https://github.com/fabbeskw/multi-add-for-cronometer')
    lines.append(' * "serviceMethods" and "policies" list every RPC method and service name found in the web client, for recognition')
    lines.append(' * only (a rebuilt table is checked to still contain the methods the extension uses). The extension itself calls')
    lines.append(' * only the REST food search, getFood, getDayInfo, updateDiary, removeServing and, after the TDEE tab is enabled,')
    lines.append(' * getCaloriesConsumedAndBurned, getBiometrics, getCalendarInfo, getFirstDayWithData and getPreference')
    lines.append(' * (PRIVACY.md section 5); names such as "adServed" or "admin" in these lists are never called.')
    lines.append(' * Entry kinds: class {f:[wire-order field kinds]} | enum | box {t} | list | singleton | empty {t} |')
    lines.append(' * arrays | map {pre?} | set {pre?} | date {f?} | array {e} | unknown {why}.')
    lines.append(' * Field kinds: i int, z bool, s string, o object, d double, l long, b byte, h short, f float, c char.')
    lines.append(' * from:"ser" = layout taken from the client->server serializer (no deserializer in the bundle).')
    lines.append(' */')
    lines.append('window.CMA = window.CMA || {};')
    lines.append('window.CMA.registry = {')
    for key in ['generatedAt', 'bundle', 'permutation', 'policyHash', 'proPolicyHash', 'policies', 'readerMethods',
                'readerHelpers', 'writerMethods', 'enumOrdinalField', 'serviceMethods', 'stats']:
        lines.append('  %s: %s,' % (json.dumps(key), json.dumps(registry[key], separators=(',', ':'))))
    lines.append('  "types": {')
    sigs = sorted(types)
    for i, sig in enumerate(sigs):
        lines.append('    %s: %s%s' % (json.dumps(sig), entry_json(types[sig]), ',' if i < len(sigs) - 1 else ''))
    lines.append('  }')
    lines.append('};')
    text = '\n'.join(lines) + '\n'
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)

    # ---- report ---------------------------------------------------------------------------
    print('bundle      : %s (%d bytes, mtime %s)' % (bundle_path, len(js), generated_at))
    print('permutation : %s' % perm)
    print('policies    : %s' % json.dumps(policies, sort_keys=True))
    print('reader map  : %s   (readObject=%s, helpers bool=%s double=%s long=%s/%s string=%s, tokens this.%s[--this.%s])' % (
        json.dumps(reader.methods, sort_keys=True), reader.obj_impl, reader.bool_helper, reader.dbl_helper,
        reader.long_helper, reader.long_decoder, reader.str_helper, reader.arr, reader.idx))
    print('writer map  : %s   (from %d ser/deser pairs; enum ordinal field %r)' % (
        json.dumps(writer.methods, sort_keys=True), len(pairs), ordinal_field))
    # The int and double helper bodies are byte-identical (RAW(this,''+x): X0n/Y0n), so the literal scan cannot
    # tell writeDouble (Ss) from writeInt (Ts); report the method the correlated ser/deser map classified as 'i'.
    int_writer = next((m for m, k in sorted(writer.methods.items()) if k == 'i' and m != '#raw'), writer.int_method)
    print('writer inl. : helpers %s, raw=%s, long encoder=%s, bool=%s, long=%s, int=%s' % (
        json.dumps(writer.helper_to_method, sort_keys=True), writer.raw_writer, writer.long_encoder,
        writer.bool_method, writer.long_method, int_writer))
    print('tables      : %d serializer tables, %d rows, %d distinct type signatures, %d unresolved row vars' % (
        n_tables, n_rows, len(types), unresolved))
    print('kinds       : %s' % json.dumps(dict(kinds_count), sort_keys=True))
    print('from ser    : %d layouts taken from client->server serializers' % sum(1 for e in types.values() if e.get('from') == 'ser'))
    print('service     : %d CronometerService methods (proxies: %s)' % (len(crono), ', '.join(sorted(service_methods.keys()))))
    print('unknown     : %d' % len(unknowns))
    for sig, why in unknowns:
        print('   ? %s : %s' % (sig, why))
    if not quiet:
        print('known layouts (SPEC 3.3):')
        for sig, expected in EXPECTED_LAYOUTS.items():
            got = layout_str(types.get(sig))
            flag = '' if (expected is None or got == expected) else '   <-- expected ' + expected
            print('   %-76s %s%s' % (sig, got, flag))
        print('optional layouts (SPEC 12.2, Adaptive TDEE):')
        for sig, expected in OPTIONAL_LAYOUTS.items():
            got = layout_str(types.get(sig))
            flag = '' if got == expected else '   <-- expected ' + expected + ' (the TDEE sync would be off)'
            print('   %-76s %s%s' % (sig, got, flag))
    print('wrote %s (%d types)' % (out_path, len(types)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
