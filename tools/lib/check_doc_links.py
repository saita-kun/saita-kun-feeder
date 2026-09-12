#!/usr/bin/env python3
"""Check Git-tracked Markdown links using only the standard library.

Supports inline/image, reference, angle and bare HTTP links. Code blocks,
code spans and HTML comments are ignored. Heading anchors are outside this check.
"""

import argparse
import html
import http.client
import json
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

DESTINATION = r'<([^<>\n]*)>|((?:\\.|[^\\\s()]|\([^()\n]*\))+)'
# Labels may wrap within a paragraph, but cannot span blank lines.
LABEL_CHARACTER = r'(?:\\.|[^\[\]\\\n]|\n(?![ \t]*\n))'
LABEL_TEXT = r'(?:' + LABEL_CHARACTER + r'|\[' + LABEL_CHARACTER + r'*\])'
LABEL = re.compile(r'(?<!\\)\[' + LABEL_TEXT + r'*\]$')
TITLE = r'''"(?:\\.|[^"\\\n]|\n(?![ \t]*\n))*"|'(?:\\.|[^'\\\n]|\n(?![ \t]*\n))*'|\((?:\\.|[^()\\\n]|\n(?![ \t]*\n))*\)'''
INLINE = re.compile(r'\]\(\s*(?:' + DESTINATION + r')(?:\s+(?:' + TITLE + r'))?\s*\)')
DEFINITION = re.compile(r'^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(?:' + DESTINATION +
                        r')(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(?:' + TITLE + r'))?[ \t]*$', re.M)
REFERENCE_SYNTAX = r'\[(' + LABEL_TEXT + r'+)\](?:[ \t]*\[([^\]\n]*)\])?'
REFERENCE = re.compile(r'(?<!\\)' + REFERENCE_SYNTAX)
IMAGE_REFERENCE = re.compile(r'(?<!\\)!' + REFERENCE_SYNTAX)
AUTOLINK = re.compile(r'<(https?://[^\s<>]+)>')
HTTP_URL = re.compile(r'''https?://[^\s<>`"'\[\]|）】」』、。]+''')
LIST_MARKER = re.compile(r'^ {0,3}(?:[-+*]|\d{1,9}[.)])( +|$)')
QUOTE_MARKER = re.compile(r'^ {0,3}> ?')
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})(.*)$')
# Paired backslashes leave an opener active; backslashes inside a span are literal.
CODE_SPAN = re.compile(r'(?<!\\)(?:\\\\)*(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)')
INLINE_IGNORED = re.compile(CODE_SPAN.pattern + r'|<!--[\s\S]*?-->')
BLOCK_END = re.compile(r'^ {0,3}(?:#{1,6}(?:\s|$)|(?:=+|-+)\s*$|'
                       r'(?:\*\s*){3,}$|(?:_\s*){3,}$|(?:-\s*){3,}$)')


def blank(text):
    return re.sub(r'[^\n]', ' ', text)


def blank_comment(text):
    # Nonbreaking spaces hide content without creating blank lines inside link labels.
    return re.sub(r'\S', '\u00a0', text)


def mask_ranges(text, ranges, mask=blank):
    masked = list(text)
    for start, end in ranges:
        masked[start:end] = mask(text[start:end])
    return ''.join(masked)


def prose(source):
    fence, lines, containers, paragraph = None, [], [], False
    offset, hidden_until, code_until = 0, 0, 0
    for line in source.splitlines(keepends=True):
        start, offset = offset, offset + len(line)
        hidden = max(0, hidden_until - start)
        line = blank_comment(line[:hidden]) + line[hidden:]
        if hidden >= len(line):
            lines.append(line)
            continue
        content = expanded = line.expandtabs(4)
        # Existing containers must continue before a fence can continue or close.
        for index, padding in enumerate(containers):
            quote_marker = QUOTE_MARKER.match(content) if padding is None else None
            if quote_marker:
                content = content[quote_marker.end():]
            elif padding is not None and (content.startswith(' ' * padding) or not content.strip()):
                content = content[padding:]
            else:
                del containers[index:]
                fence = None
                break
        if not fence:
            while True:
                quote_marker = QUOTE_MARKER.match(content)
                item = LIST_MARKER.match(content)
                if quote_marker:
                    containers.append(None)
                    content = content[quote_marker.end():]
                elif item and not BLOCK_END.match(content):
                    padding = len(item[1])
                    width = item.end() - padding + (padding if 1 <= padding <= 4 else 1)
                    containers.append(width)
                    content = content[width:]
                else:
                    break
                paragraph = False
        marker = FENCE.match(content)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            lines.append(blank(line))
            paragraph = False
            code_until = 0
        elif not content.strip():
            lines.append(line)
            if not hidden:
                paragraph = False
        elif not hidden and not paragraph and content.startswith('    '):
            # Indented code cannot interrupt a paragraph; list padding is not code indentation.
            lines.append(blank(line))
            code_until = 0
        elif not hidden and marker and (marker[1][0] != '`' or '`' not in marker[2]):
            fence = marker[1]
            lines.append(blank(line))
            paragraph = False
            code_until = 0
        else:
            block_end = BLOCK_END.match(content)
            # Mask comments in source order, keeping code-span delimiters literal.
            # Defer code-span masking until block boundaries have been processed.
            if re.match(r'^ {0,3}<!--', content):
                code_until = 0
            for match in INLINE_IGNORED.finditer(source, max(start, hidden_until, code_until)):
                if match.start() >= offset:
                    break
                if match[1] is not None:
                    code_until = match.end()
                    continue
                hidden_until = match.end()
                line = mask_ranges(line, [(match.start() - start, min(len(line), match.end() - start))], blank_comment)
            # Strip container columns without expanding tabs inside destinations.
            prefix = len(expanded) - len(content)
            column, index = 0, 0
            while column < prefix:
                column += 4 - column % 4 if line[index] == '\t' else 1
                index += 1
            lines.append(' ' * (column - prefix) + line[index:])
            paragraph = not block_end
    return INLINE_IGNORED.sub(lambda match: (blank if match[1] is not None else blank_comment)(match[0]),
                              ''.join(lines))


def closing_emphasis(text, end, protected_ranges):
    """Find open emphasis around a bare URL, including surrounding prose."""
    prefix, markers = text[:end], []
    url_bodies = protected_ranges + [(match.start(), match.start() + len(match[0].rstrip('*_~.,;:!?)}')))
                  for match in HTTP_URL.finditer(prefix)]
    for match in re.finditer(r'\n[ \t]*\n|(?<!\\)(?:\*+|_+|~{2,})', prefix):
        marker = match[0]
        if marker.startswith('\n'):
            markers.clear()
            continue
        if any(start <= match.start() < stop for start, stop in url_bodies):
            continue
        before = text[match.start() - 1] if match.start() else ' '
        after = text[match.end():match.end() + 1] or ' '
        before_punct = unicodedata.category(before)[0] in 'PS'
        after_punct = unicodedata.category(after)[0] in 'PS'
        left = not after.isspace() and (not after_punct or before.isspace() or before_punct)
        right = not before.isspace() and (not before_punct or after.isspace() or after_punct)
        can_open = left and (marker[0] != '_' or not right or before_punct)
        can_close = right and (marker[0] != '_' or not left or after_punct)
        if can_close:
            for index in range(len(markers) - 1, -1, -1):
                if markers[index][0] != marker[0]:
                    continue
                del markers[index + 1:]
                used = min(len(marker), len(markers[index]))
                markers[index] = markers[index][:-used]
                marker = marker[:-used]
                if not markers[index]:
                    markers.pop(index)
                if not marker:
                    break
        if marker and can_open:
            markers.append(marker)
    return ''.join(markers)[::-1]


def extract_links(source):
    text, links, definitions = prose(source), [], {}
    normalize = lambda label: ' '.join(label.split()).casefold()
    for match in DEFINITION.finditer(text):
        definitions.setdefault(normalize(match[1]), match[2] if match[2] is not None else match[3])
    text = DEFINITION.sub(lambda match: blank(match[0]), text)
    emphasis_text = text
    angle_ranges = [match.span() for match in AUTOLINK.finditer(text)]
    inline_ranges, inline_destinations, inline_labels = [], [], set()
    for match in INLINE.finditer(text):
        label = LABEL.search(text[:match.start() + 1])
        if label and not any(start <= label.start() < end for start, end in angle_ranges):
            links.append((label.start(), match[1] if match[1] is not None else match[2]))
            inline_ranges.append((label.start(), match.end()))
            inline_destinations.append((match.start() + 1, match.end()))
            inline_labels.add(label.start())
    text = mask_ranges(text, inline_ranges)
    autolink_ranges = []
    for match in AUTOLINK.finditer(text):
        links.append((match.start(), match[1]))
        autolink_ranges.append(match.span())
    text = mask_ranges(text, autolink_ranges)
    reference_ranges, reference_links = [], set()
    for match in REFERENCE.finditer(text):
        if match[2] is None and text[match.end():match.end() + 1] == '(':
            continue
        target = definitions.get(normalize(match[2] or match[1]))
        if target is not None:
            reference_links.add((match.start(), target))
            reference_ranges.append(match.span())
    # Reference images inside link labels still have destinations of their own.
    image_text = mask_ranges(emphasis_text, inline_destinations + autolink_ranges)
    for match in IMAGE_REFERENCE.finditer(image_text):
        if match.start() + 1 in inline_labels:
            continue
        target = definitions.get(normalize(match[2] or match[1]))
        if target is not None:
            reference_links.add((match.start() + 1, target))
            reference_ranges.append(match.span())
    links.extend(reference_links)
    text = mask_ranges(text, reference_ranges)
    protected_ranges = inline_ranges + autolink_ranges + reference_ranges
    for match in HTTP_URL.finditer(text):
        # Only paired wrapping markers are Markdown; URL suffixes may contain _ or ~.
        closing = closing_emphasis(emphasis_text, match.start(), protected_ranges)
        target = match[0]
        while True:
            trimmed = target.rstrip('.,;:!?')
            if closing and trimmed.endswith(closing):
                trimmed = trimmed[:-len(closing)]
                closing = ''
            elif closing:
                suffix = re.search(r'[*_~]+\Z', trimmed)
                if suffix and closing.startswith(suffix[0]):
                    trimmed = trimmed[:-len(suffix[0])]
                    closing = ''
            for left, right in [('(', ')'), ('{', '}')]:
                if trimmed.endswith(right) and trimmed.count(right) > trimmed.count(left):
                    trimmed = trimmed[:-1]
            if trimmed == target:
                break
            target = trimmed
        links.append((match.start(), target))
    for offset, target in sorted(links):
        target = re.sub(r'\\([!"#$%&\'()*+,\-./:;<=>?@\[\]\\^_`{|}~])', r'\1', target)
        target = re.sub(r'&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z][\da-zA-Z]*);',
                        lambda match: html.unescape(match[0]), target)
        yield text.count('\n', 0, offset) + 1, target


def check_http(url, opener):
    try:
        parsed = urlsplit(url)
        if parsed.username is not None or parsed.password is not None:
            return 'unverified', 'URL credentials are not supported'
        request = Request(quote(url, safe=":/?[]@!$&'()*+,;=%"),
                          headers={'User-Agent': 'saita-kun-feeder-doc-links/1.0'})
        with opener.open(request, timeout=15) as response:
            status = response.status
    except HTTPError as error:
        status = error.code
        error.close()
    except (URLError, OSError, ValueError, http.client.HTTPException) as error:
        return 'unverified', str(error)
    category = 'external_ok' if 200 <= status < 300 else 'external_404' if status == 404 else 'unverified'
    return category, f'HTTP {status}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--external', action='store_true', help='verify HTTP links without authentication')
    args = parser.parse_args()
    counts = Counter(dict.fromkeys(('markdown', 'links', 'relative_ok', 'relative_missing',
                                   'external_ok', 'external_404', 'unverified',
                                   'skipped_fixture_sample', 'external_pending', 'scan_errors'), 0))
    try:
        tracked = subprocess.run(['git', 'ls-files', '-z', '*.md'], cwd=args.root,
                                 check=True, capture_output=True).stdout.decode('utf-8')
    except (OSError, UnicodeError, subprocess.CalledProcessError) as error:
        print(f'check-doc-links: FAIL: cannot enumerate tracked Markdown: {error}', file=sys.stderr)
        return 1
    # No auth/cookie handlers or proxy credentials from the user's environment.
    opener = build_opener(ProxyHandler({})) if args.external else None
    cache = {}
    for name in filter(None, tracked.split('\0')):
        counts['markdown'] += 1
        print(f'markdown: {json.dumps(name, ensure_ascii=False)}')
        document = args.root / name
        try:
            source = document.read_text(encoding='utf-8')
        except (OSError, UnicodeError) as error:
            counts['scan_errors'] += 1
            print(f'ERROR: {name}: {error}', file=sys.stderr)
            continue
        for line, target in extract_links(source):
            counts['links'] += 1
            where = f'{name}:{line}: {target}'
            if target.startswith(('http://', 'https://')):
                if re.fullmatch(r'tests/fixtures/golden-digest/[^/]+\.md', name) and target.startswith('https://example.jp/'):
                    counts['skipped_fixture_sample'] += 1
                    print(f'SKIP: {where} (fixture sample; excluded from HTTP verification)')
                elif not args.external:
                    counts['external_pending'] += 1
                else:
                    url = target.split('#', 1)[0]
                    if url not in cache:
                        cache[url] = check_http(url, opener)
                    category, reason = cache[url]
                    counts[category] += 1
                    print(f'{category}: {where} ({reason})',
                          file=sys.stdout if category == 'external_ok' else sys.stderr)
            elif target and not target.startswith(('#', '//')) and not re.match(r'^[\w+.-]+:', target):
                relative = unquote(target.split('#', 1)[0].split('?', 1)[0])
                base = args.root if relative.startswith('/') else document.parent
                if (base / relative.lstrip('/')).exists():
                    counts['relative_ok'] += 1
                else:
                    counts['relative_missing'] += 1
                    print(f'ERROR: {where} (relative file missing)', file=sys.stderr)
    failed = any(counts[key] for key in ('relative_missing', 'external_404', 'unverified', 'scan_errors'))
    print('check-doc-links: ' + ('FAIL' if failed else 'OK') + ' ' +
          ' '.join(f'{key}={value}' for key, value in counts.items()))
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
