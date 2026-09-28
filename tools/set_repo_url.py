#!/usr/bin/env python3
"""set_repo_url.py - fill the repository-URL placeholders in the docs once the GitHub repository exists.

    python tools/set_repo_url.py https://github.com/<owner>/multi-add-for-cronometer [--dry-run] [--check]

The README, the privacy policy and the store-listing text are written before the repository has a home, so they
carry four placeholders. This script replaces them, in README.md, PRIVACY.md, STORE-LISTING.md and popup.html
(the popup has none today; it is scanned so that one added later is not forgotten), with URLs derived from the
one argument:

    <repo URL>                                  -> <repo>
    <support URL>                               -> <repo>/issues
    <your contact email or GitHub issues URL>   -> <repo>/issues
    <privacy policy URL>                        -> <repo>/blob/HEAD/PRIVACY.md

The privacy link uses `blob/HEAD`, which GitHub resolves to the repository's default branch, so it stays valid
whether that branch is called main, master or anything else (the store listing must link a page that exists).

SPEC.md is deliberately not touched: it documents the placeholder names themselves. `<Chrome Web Store URL>`
(README) and `<item id>` (STORE-LISTING.md) are only known after the store review and stay as they are.

Two spellings are recognised, because GitHub's Markdown sanitizer drops an unknown tag such as `<repo URL>` from
rendered prose, so the docs keep the placeholders inside code spans where they render verbatim:

  * a code span that starts with a placeholder, e.g. `<repo URL>/releases`, becomes a Markdown autolink
    <https://github.com/owner/repo/releases> (clickable once the URL is real; the optional path suffix is kept);
  * a bare placeholder (inside a ``` block, in a table, in plain text) becomes the plain URL, which is what the
    Developer Dashboard text blocks need when they are pasted.

The script is idempotent: a second run finds nothing and changes nothing. It prints every replacement per file,
refuses anything but an https://github.com/<owner>/<repo> URL (a trailing slash or `.git` is stripped, an unfilled
`<owner>` is rejected), writes files back byte-for-byte except for the replacements (UTF-8, line endings kept),
and exits 0. `--dry-run` only prints what would change; `--check` exits 1 when a placeholder is still present
after the run (or, with `--dry-run`, before it) so a release script can refuse to package unfilled docs.
Python 3, stdlib only.
"""
import argparse
import io
import os
import re
import sys

FILES = ('README.md', 'PRIVACY.md', 'STORE-LISTING.md', 'SUBMISSION-CHECKLIST.md', 'popup.html')

# Placeholder -> path appended to the repository URL. Longer names first so that a placeholder that is a prefix
# of another can never match first (none is today, but the order keeps it that way).
PLACEHOLDERS = (
    ('<your contact email or GitHub issues URL>', '/issues'),
    ('<privacy policy URL>', '/blob/HEAD/PRIVACY.md'),   # HEAD = the default branch, whatever its name
    ('<support URL>', '/issues'),
    ('<repo URL>', ''),
)

# https://github.com/<owner>/<repo>: GitHub user/org names are alphanumerics and single hyphens (max 39 chars),
# repository names alphanumerics, '-', '_' and '.' (max 100). Anything else (a subpath, a query, a gist, an
# enterprise host, an unfilled "<owner>") is refused rather than guessed.
REPO_RE = re.compile(r'^https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/([A-Za-z0-9._-]{1,100})$')
# The suffix a code-span placeholder may carry (`<repo URL>/releases`): URL path/fragment characters only, so
# a sentence that happens to start with a placeholder in a code span is left alone.
SUFFIX_RE = r'[A-Za-z0-9._~/#?=&%+-]*'


def normalise_repo_url(arg):
    """Return the canonical https://github.com/owner/repo form of `arg`, or raise ValueError saying why not."""
    url = arg.strip()
    if url.endswith('/'):
        url = url[:-1]
    if url.endswith('.git'):
        url = url[:-4]
    if not url.startswith('https://'):
        raise ValueError('the repository URL must start with https:// (got %r)' % arg)
    m = REPO_RE.match(url)
    if not m:
        raise ValueError('expected https://github.com/<owner>/<repo> with real names (got %r)' % arg)
    owner, repo = m.groups()
    if repo.endswith('.'):
        raise ValueError('a GitHub repository name cannot end with a dot (got %r)' % arg)
    return 'https://github.com/%s/%s' % (owner, repo)


def replace_in_text(text, repo_url):
    """Return (new_text, [(placeholder, replacement, count), ...]) for one file's content."""
    changes = []
    for name, path in PLACEHOLDERS:
        target = repo_url + path
        # 1. `<placeholder>[suffix]` code spans -> <target[suffix]> autolinks.
        span_re = re.compile('`' + re.escape(name) + '(' + SUFFIX_RE + ')`')
        text, n = span_re.subn(lambda m: '<' + target + m.group(1) + '>', text)
        if n:
            changes.append(('`%s...`' % name, '<%s...>' % target, n))   # ASCII only: Windows consoles may be cp1252
        # 2. Bare placeholders -> the plain URL.
        n = text.count(name)
        if n:
            text = text.replace(name, target)
            changes.append((name, target, n))
    return text, changes


def remaining_placeholders(text):
    return [name for name, _ in PLACEHOLDERS if name in text]


def main(argv):
    ap = argparse.ArgumentParser(description='Fill the <repo URL>/<support URL>/<privacy policy URL>/contact '
                                             'placeholders in the docs from the GitHub repository URL.')
    ap.add_argument('repo_url', help='https://github.com/<owner>/<repo> (the final, existing repository)')
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    help='repository root (default: the parent of tools/)')
    ap.add_argument('--dry-run', action='store_true', help='print what would change, write nothing')
    ap.add_argument('--check', action='store_true',
                    help='exit 1 when a placeholder is still present (after writing, or before with --dry-run)')
    args = ap.parse_args(argv)

    try:
        repo_url = normalise_repo_url(args.repo_url)
    except ValueError as e:
        print('refused: %s' % e, file=sys.stderr)
        return 2
    print('repository: %s' % repo_url)

    total = 0
    unfilled = []
    for rel in FILES:
        path = os.path.join(args.root, rel)
        if not os.path.isfile(path):
            print('%s: missing, skipped' % rel)
            continue
        # newline='' keeps CRLF/LF exactly as found; the docs are LF, but a Windows checkout must not be rewritten.
        with io.open(path, encoding='utf-8', newline='') as f:
            original = f.read()
        text, changes = replace_in_text(original, repo_url)
        if not changes:
            print('%s: unchanged (no placeholder)' % rel)
        else:
            for name, target, n in changes:
                print('%s: %d x %s -> %s' % (rel, n, name, target))
                total += n
            if not args.dry_run:
                with io.open(path, 'w', encoding='utf-8', newline='') as f:
                    f.write(text)
        left = remaining_placeholders(original if args.dry_run else text)
        if left:
            unfilled.append((rel, left))

    verb = 'would change' if args.dry_run else 'changed'
    print('%s %d placeholder occurrence(s)' % (verb, total) if total else 'nothing to change')
    if args.check and unfilled:
        for rel, names in unfilled:
            print('check: %s still contains %s' % (rel, ', '.join(names)), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
