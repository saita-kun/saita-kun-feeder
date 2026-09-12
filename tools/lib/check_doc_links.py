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
import string
import subprocess
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

# Labels may wrap within a paragraph, but cannot span blank lines.
LABEL_CHARACTER = r'(?:\\.|[^\[\]\\\n]|\n(?![ \t]*\n))'
REFERENCE_LABEL = re.compile(r'\[(' + LABEL_CHARACTER + r'{0,999})\]')
DEFINITION_START = re.compile(r'^ {0,3}(?=\[)', re.M)
SPACE = re.compile(r'[ \t]*(?:\n[ \t]*)?')
LINE_END = re.compile(r'[ \t]*(?=\n|\Z)')
BACKTICKS = re.compile(r'`+')
AUTOLINK = re.compile(r'<(https?://[^\s<>]+)>')
HTTP_URL = re.compile(r'''https?://[^\s<>`"'\[\]|）】」』、。]+''')
LIST_MARKER = re.compile(r'^ {0,3}(?:[-+*]|\d{1,9}[.)])( +|$)')
QUOTE_MARKER = re.compile(r'^ {0,3}> ?')
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})(.*)$')
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


def escaped(text, index):
    start = index
    while start and text[start - 1] == '\\':
        start -= 1
    return (index - start) % 2 == 1


def code_span_end(text, start):
    """Read a delimiter run; an unmatched run remains literal on this line."""
    opener = BACKTICKS.match(text, start)
    line_end = text.find('\n', opener.end())
    for closer in BACKTICKS.finditer(text, opener.end(), len(text) if line_end < 0 else line_end):
        # Backslashes inside code spans are literal, including before the closer.
        if len(closer[0]) == len(opener[0]):
            return closer.end()
    return opener.end()


def read_destination(text, start):
    """Read CommonMark destinations without interpreting their inline contents."""
    angle = text[start:start + 1] == '<'
    index, depth = start + int(angle), 0
    while index < len(text):
        char = text[index]
        if char == '\\' and text[index + 1:index + 2] in string.punctuation and index + 1 < len(text):
            index += 2
            continue
        if angle:
            if char == '>':
                return text[start + 1:index], index + 1
            if char in '<\n\r':
                return None
        elif ord(char) <= 32 or ord(char) == 127:
            break
        elif char == '(':
            depth += 1
        elif char == ')':
            if not depth:
                break
            depth -= 1
        index += 1
    if not angle and not depth and index > start:
        return text[start:index], index
    return None


def read_title(text, start):
    delimiter = text[start:start + 1]
    if delimiter not in ('"', "'", '('):
        return None
    closer = ')' if delimiter == '(' else delimiter
    index = start + 1
    while index < len(text):
        char = text[index]
        if escaped(text, index) and char in string.punctuation:
            index += 1
            continue
        if char == closer:
            return index + 1
        if (delimiter == '(' and char == '(') or (char == '\n' and re.match(r'\n[ \t]*\n', text[index:])):
            return None
        index += 1
    return None


def read_inline(text, start):
    if text[start:start + 1] != '(':
        return None
    position = SPACE.match(text, start + 1).end()
    if text[position:position + 1] == ')':
        return '', position + 1
    destination = read_destination(text, position)
    if destination:
        target, end = destination
        following = SPACE.match(text, end).end()
        if following > end:
            title_end = read_title(text, following)
            if title_end is not None:
                following = SPACE.match(text, title_end).end()
        if text[following:following + 1] == ')':
            return target, following + 1
    # A title may appear without a destination.
    title_end = read_title(text, position)
    if title_end is not None:
        end = SPACE.match(text, title_end).end()
        if text[end:end + 1] == ')':
            return '', end + 1
    return None


def normalize_label(label):
    return ' '.join(label.split()).casefold()


def read_definition(text, start):
    label = REFERENCE_LABEL.match(text, start)
    if not label or not normalize_label(label[1]) or text[label.end():label.end() + 1] != ':':
        return None
    destination = read_destination(text, SPACE.match(text, label.end() + 1).end())
    if not destination:
        return None
    target, end = destination
    following = SPACE.match(text, end).end()
    title_end = read_title(text, following) if following > end else None
    if title_end is not None and (ending := LINE_END.match(text, title_end)):
        return normalize_label(label[1]), target, ending.end()
    if ending := LINE_END.match(text, end):
        return normalize_label(label[1]), target, ending.end()
    return None


def read_link_text(text, start):
    index, depth = start + 1, 1
    while index < len(text):
        char = text[index]
        if escaped(text, index):
            index += 1
            continue
        if char == '\n' and re.match(r'\n[ \t]*\n', text[index:]):
            return None
        if char == '`':
            index = code_span_end(text, index)
            continue
        if text.startswith('<!--', index):
            end = text.find('-->', index + 4)
            if end >= 0:
                index = end + 3
                continue
        if char == '<' and (autolink := AUTOLINK.match(text, index)):
            index = autolink.end()
            continue
        if char == '[':
            depth += 1
        elif char == ']':
            depth -= 1
            if not depth:
                return index
            # Nested image destinations may themselves contain brackets.
            inline = read_inline(text, index + 1)
            if inline:
                index = inline[1]
                continue
        index += 1
    return None


def read_link(text, start, definitions):
    bracket = start + int(text.startswith('![', start))
    end = read_link_text(text, bracket)
    if end is None:
        return None
    inline = read_inline(text, end + 1)
    if inline:
        return inline[0], inline[1], bracket + 1, end
    reference = REFERENCE_LABEL.match(text, end + 1)
    label = reference[1] if reference and reference[1] else text[bracket + 1:end]
    target = definitions.get(normalize_label(label))
    if target is not None:
        return target, reference.end() if reference else end + 1, bracket + 1, end
    return None


def prose(source):
    fence, lines, containers, paragraph = None, [], [], False
    offset, hidden_until, code_until = 0, 0, 0
    destinations = {}
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
            # Only comments are hidden here. Consume complete destinations before
            # considering code or comment syntax within them.
            if re.match(r'^ {0,3}<!--', content):
                code_until = 0
            index = max(start, hidden_until, code_until)
            while index < offset:
                if escaped(source, index):
                    index += 1
                    continue
                if index in destinations:
                    code_until = destinations.pop(index)
                elif source[index] == '`':
                    code_until = code_span_end(source, index)
                elif source[index] == '[' and (definition := read_definition(source, index)):
                    code_until = definition[2]
                elif source[index] == '[' and (link := read_link(source, index, {})):
                    # Comments inside labels can contain block markers. Keep
                    # scanning the label and skip its destination and title.
                    destinations[link[3] + 1] = link[1]
                elif source[index] == '<' and (autolink := AUTOLINK.match(source, index)):
                    code_until = autolink.end()
                elif source.startswith('<!--', index) and (end := source.find('-->', index + 4)) >= 0:
                    hidden_until = end + 3
                    line = mask_ranges(line, [(index - start, min(len(line), hidden_until - start))], blank_comment)
                index = max(index + 1, code_until, hidden_until)
            # Strip container columns without expanding tabs inside destinations.
            prefix = len(expanded) - len(content)
            column, index = 0, 0
            while column < prefix:
                column += 4 - column % 4 if line[index] == '\t' else 1
                index += 1
            lines.append(' ' * (column - prefix) + line[index:])
            paragraph = not block_end
    return ''.join(lines)


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
    text, definitions, definition_ends = prose(source), {}, {}
    for match in DEFINITION_START.finditer(text):
        definition = read_definition(text, match.end())
        if definition:
            label, target, end = definition
            definitions.setdefault(label, target)
            definition_ends[match.start()] = end

    links, protected_ranges = [], list(definition_ends.items())

    def scan(start, end, images_only=False):
        # Scan left to right. A consumed destination or code span is never
        # reparsed as another kind of inline syntax.
        index = start
        while index < end:
            if index in definition_ends:
                index = definition_ends[index]
                continue
            if escaped(text, index):
                index += 1
                continue
            char = text[index]
            stop = index + 1
            if char == '`':
                stop = code_span_end(text, index)
            elif text.startswith('<!--', index) and (closing := text.find('-->', index + 4)) >= 0:
                stop = closing + 3
            elif char == '<' and (autolink := AUTOLINK.match(text, index)):
                stop = autolink.end()
                if not images_only:
                    links.append((index, autolink[1], True))
            elif (text.startswith('![', index) or (char == '[' and not images_only)) and (
                    link := read_link(text, index, definitions)):
                target, stop, label_start, label_end = link
                links.append((index, target, False))
                # Images embedded in link labels have their own destinations.
                scan(label_start, label_end, images_only=True)
            elif not images_only and (url := HTTP_URL.match(text, index)):
                target = trim_bare_url(url[0], closing_emphasis(text, index, protected_ranges))
                links.append((index, target, False))
                # Leave closing emphasis in the prose for subsequent URLs.
                stop = index + len(target)
            else:
                index += 1
                continue
            protected_ranges.append((index, stop))
            index = stop

    scan(0, len(text))
    for offset, target, autolink in sorted(links):
        # Backslashes in autolink destinations are literal.
        if not autolink:
            target = re.sub(r'\\([!"#$%&\'()*+,\-./:;<=>?@\[\]\\^_`{|}~])', r'\1', target)
        target = re.sub(r'&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z][\da-zA-Z]*);',
                        lambda match: html.unescape(match[0]), target)
        yield text.count('\n', 0, offset) + 1, target


def trim_bare_url(target, closing):
    # Only paired wrapping markers are Markdown; URL suffixes may contain _ or ~.
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
            return target
        target = trimmed


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
