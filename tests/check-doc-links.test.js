const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function write(root, file, contents) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
  return destination;
}

function fixture(t, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-doc-links-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  fs.cpSync(path.join(ROOT, 'tools'), path.join(repo, 'tools'), { recursive: true });
  for (const [file, contents] of Object.entries(files)) write(repo, file, contents);
  assert.equal(run('git', ['init', '--quiet'], repo).status, 0);
  assert.equal(run('git', ['add', '--', ...Object.keys(files)], repo).status, 0);
  const python = run('python3', ['-c', 'import sys; print(sys.executable)'], repo);
  assert.equal(python.status, 0, python.stderr);
  const fake = write(base, 'fake.py', `import contextlib, io, json, os, runpy, sys
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.response import addinfourl

def respond(request, *args, **kwargs):
    url = request.full_url
    print('HTTP_CALL ' + json.dumps({'url': url, 'method': request.get_method(),
          'headers': dict(request.header_items())}), file=sys.stderr)
    status = json.loads(os.environ['FEEDER_HTTP_RESPONSES'])[url]
    if status == 'network':
        raise URLError('fake connection failure')
    if status >= 400:
        raise HTTPError(url, status, 'fake HTTP response', {}, None)
    return contextlib.closing(addinfourl(io.BytesIO(b''), {}, url, status))

sys.argv = sys.argv[1:]
with patch('urllib.request.OpenerDirector.open', side_effect=respond), \\
     patch('urllib.request.urlopen', side_effect=respond), \\
     patch('http.client.HTTPConnection.connect', side_effect=AssertionError('HTTP must use the fake')):
    if sys.argv[0] == '-':
        exec(compile(sys.stdin.read(), '<stdin>', 'exec'))
    else:
        runpy.run_path(sys.argv[0], run_name='__main__')
`);
  fs.chmodSync(write(base, 'bin/python3', '#!/usr/bin/env bash\nexec "$FEEDER_REAL_PYTHON" "$FEEDER_HTTP_FAKE" "$@"\n'), 0o755);
  return {
    repo,
    check(args = [], responses = {}, script = 'tools/check-doc-links.sh') {
      const result = run('bash', [script, ...args], repo, {
        ...process.env, PATH: `${path.join(base, 'bin')}${path.delimiter}${process.env.PATH}`,
        FEEDER_REAL_PYTHON: python.stdout.trim(), FEEDER_HTTP_FAKE: fake,
        FEEDER_HTTP_RESPONSES: JSON.stringify(responses),
      });
      const calls = result.stderr.split('\n').filter((line) => line.startsWith('HTTP_CALL '))
        .map((line) => JSON.parse(line.slice('HTTP_CALL '.length)));
      return { ...result, calls };
    },
    isolateOtherGates() {
      write(repo, 'core-manifest.json', JSON.stringify({ core_paths: [] }));
      for (const gate of ['feed-contract', 'profile', 'channels', 'ledger']) {
        fs.chmodSync(write(repo, `tools/check-${gate}.sh`, '#!/usr/bin/env bash\nexit 0\n'), 0o755);
      }
      // Keep validate integration local and avoid recursively starting this suite.
      fs.chmodSync(write(base, 'bin/node', '#!/usr/bin/env bash\nexit 0\n'), 0o755);
    },
  };
}

test('links_scans_nested_and_hidden_markdown', (t) => {
  const f = fixture(t, Object.fromEntries([
    'README.md', 'docs/design/日本語 文書.md', '.claude/commands/setup.md',
    '.github/PULL_REQUEST_TEMPLATE.md', 'tests/fixtures/golden-digest/sample.md', 'plain.txt',
  ].map((file) => [file, '# Document\n'])));
  write(f.repo, 'untracked.md', '[missing](absent.md)');
  for (const repo of [f.repo, ROOT]) {
    const result = f.check([], {}, path.join(repo, 'tools/check-doc-links.sh'));
    assert.equal(result.status, 0, result.stderr);
    const expected = run('git', ['ls-files', '-z', '*.md'], repo).stdout.split('\0').filter(Boolean);
    const scanned = result.stdout.split('\n').filter((line) => line.startsWith('markdown: '))
      .map((line) => JSON.parse(line.slice('markdown: '.length)));
    assert.deepEqual(scanned.sort(), expected.sort());
  }
});

test('links_extracts_supported_syntax', (t) => {
  const urls = ['https://docs.example/guide?q=日本語&copy=full', 'https://docs.example/auto',
    'https://docs.example/bare_(part)?a=1&b=2', 'https://docs.example/badge'];
  const f = fixture(t, {
    'docs/page.md': [
      '[通常](../日本語.md?view=full#見出し)', '![画像](../image.svg)',
      '[参照][Guide]', '[Guide][]', '[Guide]', '[Guide]: ../日本語.md "Title"',
      '![image reference][Icon]', '[Icon]:\n  ../image.svg',
      '[空白](<../日本語 文書.md>)', '[括弧](../file(1).md)',
      '[encoded](../%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E6%96%87%E6%9B%B8.md)',
      `[![Badge](${urls[3]})](${urls[0]})`, `<${urls[1]}>`, `(${urls[2]}).`,
      `[query](${urls[0].replace('&', '&amp;')})`,
      '[anchor](#title)', '[mail](mailto:docs@example.test)',
      '```markdown', '[example](absent.md)', 'https://docs.example/fenced', '```',
      '~~~~', '![example](absent.png)', '~~~', 'https://docs.example/long-fence', '~~~~',
      '`[example](absent.md) https://docs.example/inline`',
      '\\[literal](absent.md)',
    ].join('\n'),
    '日本語.md': '', '日本語 文書.md': '', 'image.svg': '', 'file(1).md': '',
  });
  const result = f.check(['--external'], Object.fromEntries(urls.map((url) => [encodeURI(url), 200])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call.url).sort(), urls.map(encodeURI).sort());
  assert.match(result.stdout, /relative_ok=9\b/);
});

test('links_extracts_reference_definitions_from_containers', (t) => {
  const f = fixture(t, { 'README.md': '', 'present.md': '', 'present\tfile.md': '' });
  write(f.repo, 'README.md', [
    '[guide]', '', '123456789.\t> [guide]: <present\tfile.md>', '',
    '[direct](<present\tfile.md>)',
  ].join('\n'));
  const tabs = f.check();
  assert.equal(tabs.status, 0, tabs.stderr);
  assert.match(tabs.stdout, /links=2\b/);
  assert.match(tabs.stdout, /relative_ok=2\b/);

  const containers = [
    ['- ', '  '], ['123456789. ', '           '], ['> ', '> '],
    ['> - ', '>   '], ['- > ', '  > '], ['- - ', '    '], ['> > ', '> > '],
    ['  - ', '    '],
  ];
  for (const [opening, continuation] of containers) {
    for (const definition of [
      [`${opening}[guide]: missing.md`, `${continuation}  "Title [unused] https://docs.example/title"`],
      [`${opening}[guide]:`, `${continuation}  missing.md`],
    ]) {
      const markdown = [
        '[guide]', '', ...definition, continuation,
        `${continuation}[inside][guide]`, '', '[after][guide]', '',
        '[unused]: ignored.md', '[guide]: ignored-duplicate.md',
      ].join('\n');
      write(f.repo, 'README.md', markdown);
      const missing = f.check(['--external']);
      assert.equal(missing.status, 1, `${opening}: ${missing.stderr}`);
      assert.deepEqual(missing.calls, []);
      assert.match(missing.stdout, /links=3\b/);
      assert.match(missing.stdout, /relative_missing=3\b/);
      for (const line of [1, 6, 8]) {
        assert.match(missing.stderr, new RegExp(`README\\.md:${line}: missing\\.md`));
      }

      write(f.repo, 'README.md', markdown.replaceAll('missing.md', 'present.md'));
      const present = f.check(['--external']);
      assert.equal(present.status, 0, `${opening}: ${present.stderr}`);
      assert.deepEqual(present.calls, []);
      assert.match(present.stdout, /links=3\b/);
      assert.match(present.stdout, /relative_ok=3\b/);
    }
  }
});

test('links_preserves_links_between_escaped_backticks', (t) => {
  const f = fixture(t, { 'README.md': '', 'present.md': '' });
  for (const backslashes of [1, 2, 3, 4]) {
    const delimiter = '\\'.repeat(backslashes) + '`';
    write(f.repo, 'README.md', `Text ${delimiter} [visible](missing.md) ${delimiter} end.`);
    const result = f.check();
    const visible = backslashes % 2;
    assert.equal(result.status, visible, result.stderr);
    assert.match(result.stdout, new RegExp(`links=${visible}\\b`));
    assert.match(result.stdout, new RegExp(`relative_missing=${visible}\\b`));
    if (visible) assert.match(result.stderr, /README\.md:1: missing\.md/);
  }

  write(f.repo, 'README.md', [
    'Text \\` [visible](missing.md) \\` and `[sample](ignored.md)`.',
    'Text `[sample](ignored.md) \\` [visible](missing.md).',
    'Text \\` <!-- [sample](ignored.md) --> [visible](missing.md) \\`.',
    'Text \\` then ``[sample](ignored.md)`` and [visible](missing.md) \\`.',
  ].join('\n'));
  const mixed = f.check();
  assert.equal(mixed.status, 1, mixed.stderr);
  assert.match(mixed.stdout, /links=4\b/);
  assert.match(mixed.stdout, /relative_missing=4\b/);
  for (const line of [1, 2, 3, 4]) {
    assert.match(mixed.stderr, new RegExp(`README\\.md:${line}: missing\\.md`));
  }

  write(f.repo, 'README.md', 'Text \\` [visible](present.md) \\` end.');
  const present = f.check();
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /links=1\b/);
  assert.match(present.stdout, /relative_ok=1\b/);
});

test('links_reports_missing_and_unverified', (t) => {
  const f = fixture(t, { 'README.md': '[local](missing.md)\n<https://docs.example/check>' });
  const missing = f.check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /relative_missing=1\b/);
  assert.match(missing.stderr, /README\.md:1.*missing\.md/);
  write(f.repo, 'missing.md', '');
  for (const status of [200, 204, 404, 403, 429, 500, 'network']) {
    const result = f.check(['--external'], { 'https://docs.example/check': status });
    assert.equal(result.status, status === 200 || status === 204 ? 0 : 1, result.stderr);
    const category = status === 404 ? 'external_404' : status === 200 || status === 204 ? 'external_ok' : 'unverified';
    assert.match(result.stdout, new RegExp(`${category}=1\\b`));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].method, 'GET');
    assert.ok(Object.keys(result.calls[0].headers).every((name) => !/authorization|cookie/i.test(name)));
  }
});

test('links_masks_inline_destinations_and_titles_before_references', (t) => {
  const f = fixture(t, {
    'README.md': [
      '[real](ok.md "[ref]")',
      '[real](ok.md \'[text][ref]\')',
      '[real](ok.md "https://docs.example/title [ref]")',
      '[real](ok.md "Title\n[ref]")',
      '[ref]: missing.md',
      '[used]: ok.md',
      '[used]', '[text][used]', '[used][]',
    ].join('\n'),
    'ok.md': '',
  });
  const result = f.check(['--external']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout, /links=7\b/);
  assert.match(result.stdout, /relative_ok=7\b/);
  assert.match(result.stdout, /relative_missing=0\b/);

  write(f.repo, 'README.md', '[real](ok.md "Title\n[ref]")\n[ref]: missing.md\n[text][ref]');
  const missing = f.check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /relative_missing=1\b/);
  assert.match(missing.stderr, /README\.md:4: missing\.md/);
});

test('links_masks_html_comments_and_preserves_line_numbers', (t) => {
  const markdown = [
    '<!-- [old](missing-inline.md) -->',
    'Text <!-- ![old](missing-image.svg) --> [visible](present.md)',
    '<!--', '[old](missing-block.md)', '[unused]: missing-reference.md',
    '<https://docs.example/comment>', '~~~', '-->',
    '[unused]', '[visible](present.md)',
    '<!-- first --> <!-- [old](missing-adjacent.md) -->',
  ].join('\n');
  const f = fixture(t, { 'README.md': markdown, 'present.md': '' });
  const result = f.check(['--external'], { 'https://docs.example/comment': 404 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout, /links=2\b/);
  assert.match(result.stdout, /relative_ok=2\b/);
  assert.match(result.stdout, /relative_missing=0\b/);

  write(f.repo, 'README.md', markdown.replaceAll('present.md', 'missing-visible.md'));
  const missing = f.check(['--external']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.stdout, /links=2\b/);
  assert.match(missing.stdout, /relative_missing=2\b/);
  assert.match(missing.stderr, /README\.md:2: missing-visible\.md/);
  assert.match(missing.stderr, /README\.md:10: missing-visible\.md/);

  write(f.repo, 'README.md', [
    '`<!--` [visible](missing-span.md)', '',
    '```text', '<!--', '```', '[visible](missing-fence.md)', '',
    '    <!--', '[visible](missing-indent.md)', '', '-->',
  ].join('\n'));
  const examples = f.check();
  assert.equal(examples.status, 1, examples.stderr);
  assert.match(examples.stdout, /relative_missing=3\b/);
  assert.match(examples.stderr, /README\.md:1: missing-span\.md/);
  assert.match(examples.stderr, /README\.md:6: missing-fence\.md/);
  assert.match(examples.stderr, /README\.md:9: missing-indent\.md/);

  write(f.repo, 'README.md', 'Text `\n~~~\n`\n~~~\n\n[after](missing.md)');
  const blocks = f.check();
  assert.equal(blocks.status, 1, blocks.stderr);
  assert.match(blocks.stdout, /relative_missing=1\b/);
  assert.match(blocks.stderr, /README\.md:6: missing\.md/);

  write(f.repo, 'README.md', 'Text <!--\n[old](ignored.md)\n--> [visible](missing.md)\n');
  const suffix = f.check();
  assert.equal(suffix.status, 1, suffix.stderr);
  assert.match(suffix.stdout, /relative_missing=1\b/);
  assert.match(suffix.stderr, /README\.md:3: missing\.md/);

  write(f.repo, 'README.md', 'Text <!--\ncomment\n-->\n    [continued](missing.md)\n');
  const continuation = f.check();
  assert.equal(continuation.status, 1, continuation.stderr);
  assert.match(continuation.stdout, /relative_missing=1\b/);
  assert.match(continuation.stderr, /README\.md:4: missing\.md/);

  write(f.repo, 'README.md', [
    'Text ` <!-- [old](ignored.md) -->', '~~~', '`', '~~~', '[after](missing.md)',
  ].join('\n'));
  const unmatched = f.check();
  assert.equal(unmatched.status, 1, unmatched.stderr);
  assert.match(unmatched.stdout, /relative_missing=1\b/);
  assert.match(unmatched.stderr, /README\.md:5: missing\.md/);

  for (const destination of ['(missing.md)', '[target]']) {
    write(f.repo, 'README.md', `[text <!--\ncomment\n--> label]${destination}\n\n[target]: missing.md`);
    const label = f.check();
    assert.equal(label.status, 1, label.stderr);
    assert.match(label.stdout, /links=1\b/);
    assert.match(label.stdout, /relative_missing=1\b/);
    assert.match(label.stderr, /README\.md:1: missing\.md/);
  }
});

test('links_checks_inline_destinations_with_escaped_title_delimiters', (t) => {
  const titles = [
    String.raw`"A \"quoted\" title [unused] https://docs.example/title"`,
    String.raw`'A \'quoted\' title [unused] https://docs.example/title'`,
    String.raw`(A \(parenthesized\) title [unused] https://docs.example/title)`,
    String.raw`"A trailing backslash \\"`,
    '"A \\"quoted\\"\nmultiline title"',
  ];
  const f = fixture(t, {
    'README.md': titles.map((title) => `[guide](missing.md ${title})`)
      .concat('', '[unused]: missing-reference.md').join('\n'),
  });
  const result = f.check(['--external'], { 'https://docs.example/title': 404 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /links=5\b/);
  assert.match(result.stdout, /relative_missing=5\b/);
  assert.deepEqual(result.calls, []);
  for (let line = 1; line <= titles.length; line += 1) {
    assert.match(result.stderr, new RegExp(`README\\.md:${line}: missing\\.md`));
  }

  write(f.repo, 'missing.md', '');
  const present = f.check(['--external']);
  assert.equal(present.status, 0, present.stderr);
  assert.deepEqual(present.calls, []);
  assert.match(present.stdout, /relative_ok=5\b/);
});

test('links_masks_container_fences_and_checks_following_prose', (t) => {
  const f = fixture(t, { 'README.md': '', 'present.md': '' });
  const containers = [
    ['- ', '  '], ['1. ', '   '], ['> ', '> '],
    ['> - ', '>   '], ['- > ', '  > '], ['- - ', '    '], ['> > ', '> > '],
  ];
  for (const [opening, continuation] of containers) {
    for (const fence of ['~~~', '```']) {
      const markdown = [
        `${opening}${fence}text`,
        `${continuation}[sample](missing-sample.md)`,
        `${continuation}https://docs.example/code`,
        `${continuation}- ${fence}`,
        `${continuation}[sample](missing-second-sample.md)`,
        `${continuation}${fence}`,
        `${continuation}[inside](present.md)`, '', '[after](present.md)',
      ].join('\n');
      write(f.repo, 'README.md', markdown);
      const result = f.check(['--external'], { 'https://docs.example/code': 404 });
      assert.equal(result.status, 0, `${opening}${fence}: ${result.stderr}`);
      assert.deepEqual(result.calls, []);
      assert.match(result.stdout, /links=2\b/);
      assert.match(result.stdout, /relative_ok=2\b/);

      write(f.repo, 'README.md', markdown.replaceAll('present.md', 'missing-visible.md'));
      const missing = f.check(['--external']);
      assert.equal(missing.status, 1, missing.stderr);
      assert.deepEqual(missing.calls, []);
      assert.match(missing.stdout, /relative_missing=2\b/);
      assert.match(missing.stderr, /README\.md:7: missing-visible\.md/);
      assert.match(missing.stderr, /README\.md:9: missing-visible\.md/);

      write(f.repo, 'README.md', [
        `${opening}${fence}text`, `${continuation}[sample](missing-sample.md)`,
        '[after the container](missing-visible.md)',
      ].join('\n'));
      const unclosed = f.check();
      assert.equal(unclosed.status, 1, unclosed.stderr);
      assert.match(unclosed.stdout, /relative_missing=1\b/);
      assert.match(unclosed.stderr, /README\.md:3: missing-visible\.md/);
    }
  }
});

test('links_skips_indented_code_blocks_and_keeps_paragraph_links', (t) => {
  const f = fixture(t, {
    'README.md': [
      '    [start](missing-start.md)',
      '', 'Paragraph before the code example.', '',
      '    [example](missing.md)',
      '    https://docs.example/code',
      '', '\t[tab example](missing-tab.md)',
      '    [sample]: missing-reference.md',
      '[real](present.md)',
      '    [paragraph continuation](present.md)',
      '', '   [three spaces](present.md)', '[sample]',
    ].join('\n'),
    'present.md': '',
  });
  const result = f.check(['--external'], { 'https://docs.example/code': 404 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout, /links=3\b/);
  assert.match(result.stdout, /relative_ok=3\b/);
  assert.match(result.stdout, /relative_missing=0\b/);

  write(f.repo, 'README.md', '    [example](ignored.md)\n[real](missing.md)\n    [continuation](missing.md)');
  const missing = f.check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /relative_missing=2\b/);
  assert.match(missing.stderr, /README\.md:2: missing\.md/);
  assert.match(missing.stderr, /README\.md:3: missing\.md/);

  for (const list of ['- Item', '1.  Item', '  - Item', '- Item\n  - Nested item']) {
    write(f.repo, 'README.md', `${list}\n\n    [real](missing.md)`);
    const continuation = f.check();
    assert.equal(continuation.status, 1, continuation.stderr);
    assert.match(continuation.stdout, /relative_missing=1\b/);
  }
  write(f.repo, 'README.md', [
    '# Heading', '    [example](ignored.md)',
    '', '- - -', '', '    [example](ignored.md)',
    '```', '[example](ignored.md)', '```', '    [example](ignored.md)',
    '', '- Item', '', '      [example](ignored.md)',
    '', '  [real](present.md)',
  ].join('\n'));
  const blocks = f.check();
  assert.equal(blocks.status, 0, blocks.stderr);
  assert.match(blocks.stdout, /links=1\b/);
  assert.match(blocks.stdout, /relative_ok=1\b/);
});

test('links_masks_multiline_reference_titles', (t) => {
  const f = fixture(t, {
    'README.md': [
      '[used]: present.md', '  "see [example](missing.md)"', '',
      '[single]: present.md', "  'see [example](missing.md)",
      "  https://docs.example/title'", '',
      '[parenthesized]: present.md', '  (see [example] and',
      '  https://docs.example/title)', '',
      '[same-line]: present.md "see [example](missing.md)', '  [example]"', '',
      '[destination-next-line]:', '  present.md', '  "[example](missing.md)"', '',
      '[example]: missing-reference.md', '',
      '[used]', '[single]', '[parenthesized]', '[same-line]', '[destination-next-line]',
    ].join('\n'),
    'present.md': '',
  });
  const result = f.check(['--external'], { 'https://docs.example/title': 404 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout, /links=5\b/);
  assert.match(result.stdout, /relative_ok=5\b/);
  assert.match(result.stdout, /relative_missing=0\b/);

  write(f.repo, 'README.md', [
    '[used]: present.md', '  "Title" trailing [real](missing.md)', '',
    '[other]: present.md', '', '  "Separate [real](missing.md) paragraph"', '',
    '[used]', '[other]',
  ].join('\n'));
  const missing = f.check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /relative_ok=2\b/);
  assert.match(missing.stdout, /relative_missing=2\b/);
  assert.match(missing.stderr, /README\.md:2: missing\.md/);
  assert.match(missing.stderr, /README\.md:6: missing\.md/);
});

test('links_checks_only_destinations_for_inline_and_reference_labels', (t) => {
  const label = 'https://docs.example/dead';
  const target = 'https://docs.example/destination';
  const bare = 'https://docs.example/bare';
  const f = fixture(t, {
    'README.md': [
      `[${label}](present.md)`, `[${label}][local]`,
      `[see\n${label}][local]`, `[see [${label}]][local]`,
      `[${label}][]`, `[${label}]`,
      `![${label}](present.md)`, `![${label}][local]`,
      `[see [${label}]](present.md)`, '[see [unused]](present.md)',
      `[![${label}][local]](present.md)`,
      '[![Badge][local]][local]',
      '[![Badge](present.md "![example][unused]")](present.md)',
      `[${label}](${target})`, `[${label}][external]`, bare, '',
      '[local]: present.md', `[${label}]: present.md`,
      `[external]: ${target}`, '[unused]: missing.md',
    ].join('\n'),
    'present.md': '',
  });
  const result = f.check(['--external'], { [label]: 404, [target]: 200, [bare]: 200 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call.url), [target, bare]);
  assert.match(result.stdout, /links=19\b/);
  assert.match(result.stdout, /relative_ok=16\b/);
  assert.match(result.stdout, /external_ok=3\b/);
  assert.match(result.stdout, /external_404=0\b/);

  write(f.repo, 'README.md', '[![Badge][image]](present.md)\n\n[image]: missing.svg');
  const missingImage = f.check();
  assert.equal(missingImage.status, 1, missingImage.stderr);
  assert.match(missingImage.stdout, /relative_missing=1\b/);
  assert.match(missingImage.stderr, /README\.md:1: missing\.svg/);

  const literal = 'https://docs.example/literal**';
  for (const link of [`[${label}](present.md)`, `[${label}][local]`]) {
    write(f.repo, 'README.md', `**${link}** ${literal}\n\n[local]: present.md`);
    const emphasis = f.check(['--external'], { [label]: 404, [literal]: 200 });
    assert.equal(emphasis.status, 0, emphasis.stderr);
    assert.deepEqual(emphasis.calls.map((call) => call.url), [literal]);
    assert.match(emphasis.stdout, /relative_ok=1\b/);
  }
  for (const separator of ['\n\n', '\n \t\n']) {
    for (const suffix of ['[local]', '(present.md)']) {
      write(f.repo, 'README.md', `[see${separator}${label}]${suffix}\n\n[local]: present.md`);
      const paragraph = f.check(['--external'], { [label]: 404 });
      assert.equal(paragraph.status, 1, paragraph.stderr);
      assert.deepEqual(paragraph.calls.map((call) => call.url), [label]);
      assert.match(paragraph.stdout, /external_404=1\b/);
    }
  }
});

test('links_preserves_brackets_in_angle_autolinks', (t) => {
  const truncated = 'https://docs.example/search?filters';
  const f = fixture(t, { 'README.md': '' });
  for (const url of ['https://docs.example/search?filters[area]=Tokyo',
    'https://docs.example/search?filters[area](Tokyo)=yes']) {
    write(f.repo, 'README.md', `<${url}>\n\n[area]: missing.md`);
    for (const [status, otherStatus] of [[200, 404], [404, 200]]) {
      const result = f.check(['--external'], { [url]: status, [truncated]: otherStatus });
      assert.deepEqual(result.calls.map((call) => call.url), [url]);
      assert.equal(result.calls[0].method, 'GET');
      assert.equal(result.status, status === 200 ? 0 : 1, result.stderr);
      assert.match(result.stdout, /links=1\b/);
      assert.match(result.stdout, new RegExp(`external_${status === 200 ? 'ok' : '404'}=1\\b`));
    }
  }
});

test('links_separates_bare_url_emphasis_and_trailing_punctuation', (t) => {
  const cases = [];
  for (const [index, marker] of ['**', '__', '*', '_', '~~', '***', '**_'].entries()) {
    const closing = [...marker].reverse().join('');
    for (const [endingIndex, ending] of ['', '.', ',', ';', ':', '!', '?', ').', '.)', '。', '、', '）', '】', '」', '』'].entries()) {
      const url = `https://docs.example/guide-${index}-${endingIndex}`;
      cases.push([`${marker}${url}${closing}${ending}`, url]);
    }
    const url = `https://docs.example/part_(one)_${index}`;
    cases.push([`${marker}(${url}).${closing}`, url]);
    cases.push([`(${marker}${url}${closing}).`, url]);
    cases.push([`${marker}See ${url}${closing}.`, url]);
    cases.push([`${marker}See the guide\nat ${url}${closing}.`, url]);
    cases.push([`${marker}See *details* at ${url}${closing}.`, url]);
    cases.push([`${marker}See <${url}${closing}>${closing}`, `${url}${closing}`]);
    cases.push([`${marker}See <${url}${closing}>`, `${url}${closing}`]);
    cases.push([`and ${url}${closing}.`, url]);
  }
  for (const ending of ['.', ',;', ':!?', ').', '.)', '}.', '.}']) {
    cases.push([`https://docs.example/guide${ending}`, 'https://docs.example/guide']);
  }
  for (const url of ['https://docs.example/trailing_', 'https://docs.example/trailing__',
    'https://docs.example/trailing~', 'https://docs.example/part_(one)?view=my_value']) {
    cases.push([url, url]);
  }
  cases.push(['**Note** https://docs.example/literal**', 'https://docs.example/literal**']);
  cases.push(['data_label https://docs.example/literal_', 'https://docs.example/literal_']);
  cases.push(['*See _details* https://docs.example/overlap_', 'https://docs.example/overlap_']);
  cases.push(['**Note\n\nhttps://docs.example/paragraph**', 'https://docs.example/paragraph**']);
  const urls = [...new Set(cases.map(([, url]) => url))];
  const f = fixture(t, { 'README.md': cases.map(([markdown]) => markdown).join('\n') });
  const result = f.check(['--external'], Object.fromEntries(urls.map((url) => [url, 200])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call.url).sort(), urls.sort());
  assert.match(result.stdout, new RegExp(`links=${cases.length}\\b`));
  assert.match(result.stdout, new RegExp(`external_ok=${cases.length}\\b`));
});

test('links_skips_fixture_sample_urls', (t) => {
  const f = fixture(t, {
    'tests/fixtures/golden-digest/sample.md': 'https://example.jp/sample\nhttps://docs.example/fixture',
    'tests/fixtures/other/sample.md': 'https://example.jp/other',
    'README.md': 'https://example.jp/sample',
  });
  const urls = ['https://example.jp/sample', 'https://example.jp/other', 'https://docs.example/fixture'];
  const result = f.check(['--external'], Object.fromEntries(urls.map((url) => [url, 200])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call.url).sort(), urls.sort());
  assert.match(result.stdout, /skipped_fixture_sample=1\b/);
  assert.match(result.stdout, /external_ok=3\b/);
  assert.match(result.stdout, /SKIP.*tests\/fixtures\/golden-digest\/sample\.md.*fixture sample/);
  write(f.repo, 'README.md', '');
  const skipped = f.check(['--external'], Object.fromEntries(urls.filter((url) => url !== 'https://example.jp/sample').map((url) => [url, 200])));
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.ok(skipped.calls.every((call) => call.url !== 'https://example.jp/sample'));
});

test('links_default_mode_makes_no_http_calls', (t) => {
  const f = fixture(t, { 'README.md': '[external](https://docs.example/check)' });
  f.isolateOtherGates();
  for (const script of ['tools/check-doc-links.sh', 'tools/validate.sh']) {
    const result = f.check([], {}, script);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /external_pending=1\b/);
    assert.match(result.stdout, /external_ok=0\b/);
  }
  write(f.repo, 'README.md', '[missing](absent.md)');
  const missing = f.check([], {}, 'tools/validate.sh');
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.stdout, /validate: FAIL/);
});

test('core manifest distributes the doc link checker and regression test', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  for (const file of ['tools/check-doc-links.sh', 'tools/lib/check_doc_links.py', 'tests/check-doc-links.test.js']) {
    assert.ok(manifest.core_paths.includes(file), file);
  }
});
