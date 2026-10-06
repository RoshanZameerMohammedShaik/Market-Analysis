"""No em dashes and no semicolon splices in anything a user can read.

Roshan, 2026-10-06: "I strictly DO NOT want any em dashes across the application in any corner
or place or feature or in any card or in any names or sentences, and applies of unncessesary
semicolons too."

WHAT COUNTS AS PROSE, and why it matters that this is narrow:
  * JS/MJS  the inside of '...', "..." and `...` literals, which is what reaches the DOM.
            Code outside them is untouched: a semicolon there is syntax, not punctuation.
  * HTML    text nodes, and the content of title/aria-label/placeholder attributes.
  * Python  string literals (what print() and the published JSON carry).
  * JSON    string values.
  * CSS     only content:"..." strings. A semicolon in CSS is syntax.
Comments are rewritten too for em dashes (harmless, and it keeps the rule absolute so nobody
has to judge whether a given file is "user-facing"), but never for semicolons.

REPLACEMENTS, chosen so the result is grammatical rather than merely dash-free:
  "a — b"      -> "a, b"        the parenthetical case, which is most of them
  "a — B"      -> "a. B"        a new sentence was starting anyway
  "1914—1918"  -> "1914 to 1918"  a range
  "re—run"     -> "re-run"      an unspaced dash is standing in for a hyphen
  "a; b"       -> "a, b"        a splice; a semicolon joining two clauses in UI copy
Semicolons are left alone when they are clearly not prose: inside a URL, before a known HTML
entity, or when the text looks like code (contains {, }, =>, or ends a statement).

  python tools/prose_style_check.py          report only, exits 1 if anything is found
  python tools/prose_style_check.py --fix    rewrite in place
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EM, EN = '—', '–'
SKIP_DIRS = ('node_modules', '.git', 'dist', '.playwright-mcp', '__pycache__',
             'tools/_exp', 'model/_ohlc_cache', 'model/_bars_cache', 'model/ledger',
             'model/bot', 'model/replay_panel', 'www', '.venv')
SKIP_FILES = ('traced.json', 'markup.json', 'visible.json', 'package-lock.json',
              'xgb_trees.json', 'lstm_weights.json', 'lstm_weights_intraday.json',
              'lstm_weights_penny.json', 'vol_model.json', 'backtest_results.json',
              'prose_style_check.py')
EXTS = ('.js', '.mjs', '.html', '.py', '.json', '.css', '.md', '.yml')
ENTITIES = re.compile(r'&(?:[a-zA-Z][a-zA-Z0-9]{1,8}|#\d{1,5}|#x[0-9a-fA-F]{1,5});$')


# ── dash rewriting ───────────────────────────────────────────────────────────

def fix_dashes(s):
    for d in (EM, EN):
        # a range between numbers, including "2016-26" style
        s = re.sub(r'(\d)\s*' + d + r'\s*(\d)', r'\1 to \2', s)
        # spaced dash before a capital: a sentence was starting
        s = re.sub(r'\s*' + d + r'\s+(?=[A-Z])', '. ', s)
        # spaced dash otherwise: parenthetical
        s = re.sub(r'\s*' + d + r'\s+', ', ', s)
        # dash at the very start of a fragment
        s = re.sub(r'^\s*' + d + r'\s*', '', s)
        # unspaced between word characters: a hyphen was meant
        s = re.sub(r'(?<=\w)' + d + r'(?=\w)', '-', s)
        # anything left (trailing, doubled, next to punctuation)
        s = s.replace(' ' + d, ',').replace(d + ' ', ', ').replace(d, ', ')
    return s


# ── semicolon splices in prose ───────────────────────────────────────────────

def fix_semicolons(s):
    """`clause; clause` -> `clause, clause`, only where it is plainly prose.

    The guards matter more than the rewrite. A string can easily hold code: inline CSS
    ("width: 4px; height: 2px"), a style attribute, a URL with parameters. Rewriting a
    semicolon there changes behaviour rather than wording, so anything that looks like code
    is left exactly as it is.
    """
    if any(t in s for t in ('{', '}', '=>', '://', 'function', 'var ', 'const ', 'let ',
                            '!important', '&#')):
        return s

    css_decl = re.compile(r'(?:^|;)\s*[-\w]+\s*:\s*\S')

    def rep(m):
        before, after = m.group(1), m.group(2)
        head = s[:m.start(1) + 1]
        clause = head[head.rfind(';') + 1:] if ';' in head else head
        # a CSS declaration, not a sentence
        if css_decl.search(';' + clause):
            return m.group(0)
        if ENTITIES.search(clause + ';'):
            return m.group(0)
        return f'{before}, {after}'

    return re.sub(r'(\w);\s+([a-z])', rep, s)


def fix_prose(s, semicolons=True):
    out = fix_dashes(s)
    if semicolons:
        out = fix_semicolons(out)
    return out


# ── locating prose inside each file type ─────────────────────────────────────

def js_spans(src):
    """(start, end) of every string/template literal body, comments excluded."""
    spans, i, n = [], 0, len(src)
    while i < n:
        c, nxt = src[i], src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            i = src.find('\n', i)
            if i < 0:
                break
            continue
        if c == '/' and nxt == '*':
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in '"\'`':
            q, j = c, i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == q:
                    break
                j += 1
            spans.append((i + 1, j))
            i = j + 1
            continue
        i += 1
    return spans


def py_spans(src):
    spans = []
    for m in re.finditer(r'("""|\'\'\'|"|\')', src):
        q = m.group(1)
        start = m.end()
        j = src.find(q, start)
        while j > 0 and src[j - 1] == '\\':
            j = src.find(q, j + 1)
        if j < 0:
            break
        spans.append((start, j))
    # drop spans that start inside a # comment
    out = []
    for a, b in spans:
        line_start = src.rfind('\n', 0, a) + 1
        if '#' in src[line_start:a] and '"' not in src[line_start:a] and "'" not in src[line_start:a]:
            continue
        out.append((a, b))
    return out


def apply_spans(src, spans, semicolons=True):
    spans = sorted(set(spans))
    out, last, changed = [], 0, 0
    for a, b in spans:
        if a < last:
            continue
        out.append(src[last:a])
        body = src[a:b]
        new = fix_prose(body, semicolons)
        if new != body:
            changed += 1
        out.append(new)
        last = b
    out.append(src[last:])
    return ''.join(out), changed


def process(path, fix):
    src = open(path, encoding='utf-8').read()
    orig = src
    if path.endswith(('.js', '.mjs')):
        # prose inside literals (dashes + semicolons), dashes everywhere else too
        src, _ = apply_spans(src, js_spans(src), semicolons=True)
        src = fix_dashes_outside_literals(src)
    elif path.endswith('.py'):
        src, _ = apply_spans(src, py_spans(src), semicolons=True)
        src = fix_dashes_outside_literals(src)
    elif path.endswith('.html'):
        src = fix_html(src)
    elif path.endswith('.json'):
        src = fix_json(src)
    elif path.endswith('.css'):
        src = fix_css(src)
    else:                                    # .md, .yml: prose files, dashes only
        src = fix_dashes(src)
    if src != orig and fix:
        open(path, 'w', encoding='utf-8', newline='').write(src)
    return src != orig, (src.count(EM) + src.count(EN))


def fix_dashes_outside_literals(src):
    """Comments and anything else: dashes only, never semicolons."""
    return fix_dashes(src) if (EM in src or EN in src) else src


def fix_html(src):
    parts, last = [], 0
    for m in re.finditer(r'<!--.*?-->|<[^>]+>', src, re.S):
        text = src[last:m.start()]
        parts.append(fix_prose(text, semicolons=True))
        tag = m.group(0)
        if tag.startswith('<!--'):
            tag = fix_dashes(tag)
        else:
            # copy lives in these attributes
            tag = re.sub(r'((?:title|aria-label|placeholder|alt|content)=")([^"]*)"',
                         lambda a: a.group(1) + fix_prose(a.group(2), semicolons=False) + '"', tag)
            tag = fix_dashes(tag) if (EM in tag or EN in tag) else tag
        parts.append(tag)
        last = m.end()
    parts.append(fix_prose(src[last:], semicolons=True))
    return ''.join(parts)


def fix_json(src):
    try:
        data = json.loads(src)
    except ValueError:
        return fix_dashes(src)

    def walk(o):
        if isinstance(o, str):
            return fix_prose(o, semicolons=True)
        if isinstance(o, list):
            return [walk(x) for x in o]
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        return o

    new = walk(data)
    if new == data:
        return src
    indent = 2 if src.lstrip().startswith('{\n  ') else None
    return json.dumps(new, indent=indent, ensure_ascii=False,
                      separators=(',', ': ') if indent else (',', ':')) + ('\n' if src.endswith('\n') else '')


def fix_css(src):
    src = re.sub(r'(content:\s*")([^"]*)"', lambda m: m.group(1) + fix_prose(m.group(2), semicolons=False) + '"', src)
    return fix_dashes(src)


def main():
    fix = '--fix' in sys.argv
    changed, remaining, files = [], 0, 0
    for root, dirs, fs in os.walk(REPO):
        rp = (os.path.relpath(root, REPO) + '/').replace(os.sep, '/')
        if any(s in rp for s in SKIP_DIRS):
            continue
        for f in sorted(fs):
            if not f.endswith(EXTS) or f in SKIP_FILES:
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, REPO).replace(os.sep, '/')
            if any(s in rel for s in SKIP_DIRS) or any(s in rel for s in SKIP_FILES):
                continue
            files += 1
            try:
                did, left = process(p, fix)
            except Exception as e:
                print(f'  SKIP {rel}: {type(e).__name__}: {e}')
                continue
            if did:
                changed.append(rel)
            remaining += left
    if fix:
        print(f'rewrote {len(changed)} of {files} files; em/en dashes left: {remaining}')
        for c in changed[:12]:
            print(f'  {c}')
        if len(changed) > 12:
            print(f'  ... and {len(changed) - 12} more')
        return 0
    print(f'{files} files scanned; {len(changed)} still contain an em dash, an en dash or a '
          f'semicolon splice in prose')
    for c in changed[:25]:
        print(f'  {c}')
    if changed:
        print('\nRun: python tools/prose_style_check.py --fix')
    print(f'\nPROSE STYLE {"FAIL" if changed else "PASS"}')
    return 1 if changed else 0


if __name__ == '__main__':
    sys.exit(main())
