const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OWNED_PATHS = [
  'profile/delivery-profile.json', 'profile/other.json',
  'state/notified.json', 'state/cache/feed.json', 'input/setup-state.json',
  'output/digest.md', 'channels/my-local/send', 'channels/mail/send',
  '.github/workflows/deliver.yml', '.git/config',
];
const FIRST_PATHS = ['README.md', 'tools/new/ok.txt'];

function write(root, rel, contents) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function snapshot(root, rel = '', entries = {}) {
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const child = path.join(rel, name);
    const file = path.join(root, child);
    const stat = fs.lstatSync(file);
    entries[child] = stat.isSymbolicLink() ? ['link', fs.readlinkSync(file)]
      : stat.isDirectory() ? ['directory']
        : ['file', stat.mode, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
    if (stat.isDirectory()) snapshot(root, child, entries);
  }
  return entries;
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-update-core-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'adopter');
  const upstream = path.join(base, 'upstream');
  const bin = path.join(base, 'bin');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  fs.cpSync(path.join(ROOT, 'tools'), path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'core-manifest.json'), path.join(repo, 'core-manifest.json'));
  write(repo, 'README.md', Buffer.from('local core\0\xff', 'latin1'));
  for (const rel of OWNED_PATHS) write(repo, rel, `local ${rel}\n`);
  for (const rel of FIRST_PATHS) write(upstream, rel, `updated ${rel}\n`);
  fs.chmodSync(write(bin, 'git', [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$1" in',
    '  diff|status) exit 0 ;;',
    '  clone) cp -R "$FEEDER_FAKE_UPSTREAM" "${@: -1}" ;;',
    '  *) exit 99 ;;',
    'esac',
    '',
  ].join('\n')), 0o755);
  return {
    base, repo, upstream,
    run(paths, { manifest = JSON.stringify({ manifest_version: 1, core_paths: paths }), failure } = {}) {
      write(upstream, 'core-manifest.json', manifest);
      const extraEnv = {};
      if (failure) {
        const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
        assert.equal(python.status, 0, python.stderr);
        extraEnv.FEEDER_REAL_PYTHON = python.stdout.trim();
        extraEnv.FEEDER_FAKE_FAILURE = failure;
        extraEnv.FEEDER_PYTHON_FAKE = write(base, 'prepare-fake.py', [
          'import builtins, os, runpy, shutil, sys',
          'from pathlib import Path',
          'from unittest.mock import patch',
          'sys.argv = sys.argv[1:]',
          'upstream, root = (Path(arg).resolve() for arg in sys.argv[1:3])',
          'later = upstream / "tools/new/later.bin"',
          'failure = os.environ["FEEDER_FAKE_FAILURE"]',
          'original_open, original_copy = builtins.open, shutil.copy2',
          'def read_source(file, mode="r", *args, **kwargs):',
          '    if failure == "read" and mode == "rb" and isinstance(file, (str, os.PathLike)) and Path(file) == later:',
          '        raise PermissionError("fake source read failure")',
          '    return original_open(file, mode, *args, **kwargs)',
          'def copy_source(src, dst, *args, **kwargs):',
          '    if root in Path(dst).resolve().parents:',
          '        print("FAKE: destination copy", file=sys.stderr)',
          '    if failure == "prepare" and Path(src) == later:',
          '        with original_open(dst, "wb") as output:',
          '            output.write(b"partial prepared bytes")',
          '        raise OSError("fake source preparation failure")',
          '    result = original_copy(src, dst, *args, **kwargs)',
          '    if upstream in Path(src).parents and root not in Path(dst).resolve().parents:',
          '        print(f"FAKE: prepared source: {Path(src).relative_to(upstream)}", file=sys.stderr)',
          '    return result',
          'with patch("builtins.open", side_effect=read_source), patch("shutil.copy2", side_effect=copy_source):',
          '    runpy.run_path(sys.argv[0], run_name="__main__")',
          '',
        ].join('\n'));
        fs.chmodSync(write(bin, 'python3', [
          '#!/usr/bin/env bash',
          'exec "$FEEDER_REAL_PYTHON" "$FEEDER_PYTHON_FAKE" "$@"',
          '',
        ].join('\n')), 0o755);
      }
      const before = snapshot(base);
      const result = spawnSync('bash', ['tools/update-core.sh', upstream], {
        cwd: repo, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TMPDIR: tmp, FEEDER_FAKE_UPSTREAM: upstream, ...extraEnv },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return { ...result, before };
    },
  };
}

function assertUnchanged(f, result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /ERROR:/);
  assert.doesNotMatch(result.stdout, /copied \d+ core files|== changes ==|次の手順:/);
  assert.doesNotMatch(result.stderr, /FAKE: destination copy/);
  const after = snapshot(f.base);
  assert.deepEqual(Object.keys(after), Object.keys(result.before), 'no files or directories may be created');
  for (const rel of Object.keys(after)) assert.deepEqual(after[rel], result.before[rel], rel);
}

function assertUpdated(f, result, paths) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`copied ${paths.length} core files`), result.stdout);
  assert.match(result.stdout, /次の手順:/);
  const expected = { ...result.before };
  for (const rel of paths) {
    expected[path.join('adopter', rel)] = expected[path.join('upstream', rel)];
    for (let dir = path.dirname(rel); dir !== '.'; dir = path.dirname(dir)) {
      expected[path.join('adopter', dir)] = ['directory'];
    }
    assert.deepEqual(fs.readFileSync(path.join(f.repo, rel)), fs.readFileSync(path.join(f.upstream, rel)), rel);
    assert.equal(fs.statSync(path.join(f.repo, rel)).mode & 0o111,
      fs.statSync(path.join(f.upstream, rel)).mode & 0o111, rel);
  }
  assert.deepEqual(snapshot(f.base), expected, 'only planned core files and their directories may change');
}

test('FEED-16 rejects paths outside core', async (t) => {
  for (const rel of [
    ...OWNED_PATHS, '.git', 'channels/dryrun-extra/send',
    'profile/delivery-profile.sample.json/extra', '.github/workflows/other.yml',
    'custom.txt', '', '.', './README.md', '../outside.txt',
    'docs/../README.md', 'docs/./file.md', 'docs//file.md', 'docs/file.md/',
    'docs\\file.md', 'docs/\0file.md', 'C:/outside.txt', null, 7,
  ]) {
    await t.test(JSON.stringify(rel), (t) => {
      const f = fixture(t);
      if (OWNED_PATHS.includes(rel)) write(f.upstream, rel, `upstream ${rel}\n`);
      write(f.base, 'outside.txt', 'outside bytes\n');
      assertUnchanged(f, f.run([...FIRST_PATHS, rel]));
    });
  }
  await t.test('absolute path', (t) => {
    const f = fixture(t);
    const absolute = write(f.base, 'outside.txt', 'outside bytes\n');
    assertUnchanged(f, f.run([...FIRST_PATHS, absolute]));
  });
});

test('FEED-16 rejects symlink components', async (t) => {
  for (const side of ['upstream', 'repo']) {
    for (const kind of ['file', 'parent']) {
      for (const target of ['inside', 'outside', 'dangling']) {
        await t.test(`${side} ${kind} ${target}`, (t) => {
          const f = fixture(t);
          const rel = kind === 'file' ? 'docs/linked.txt' : 'docs/linked/file.txt';
          const link = path.join(f[side], kind === 'file' ? rel : 'docs/linked');
          const targetRoot = target === 'inside' ? f[side] : `${f[side]}-outside`;
          const destination = path.join(targetRoot, 'docs/target');
          if (target !== 'dangling') {
            write(targetRoot, kind === 'file' ? 'docs/target' : 'docs/target/file.txt', 'target bytes\n');
          }
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.symlinkSync(path.relative(path.dirname(link), destination), link, kind === 'file' ? 'file' : 'dir');
          write(f[side === 'repo' ? 'upstream' : 'repo'], rel, 'regular bytes\n');
          assertUnchanged(f, f.run([...FIRST_PATHS, rel]));
        });
      }
    }
  }
  await t.test('destination directory cannot redirect a file copy', (t) => {
    const f = fixture(t);
    const rel = 'docs/existing.md';
    write(f.upstream, rel, 'updated bytes\n');
    const directory = path.join(f.repo, rel);
    fs.mkdirSync(directory, { recursive: true });
    const target = write(f.base, 'outside.txt', 'outside bytes\n');
    fs.symlinkSync(target, path.join(directory, 'existing.md'));
    assertUnchanged(f, f.run([...FIRST_PATHS, rel]));
  });
});

test('FEED-16 permits core samples', (t) => {
  const f = fixture(t);
  const paths = [...FIRST_PATHS, 'lib/new-core.js', 'profile/delivery-profile.sample.json',
    'channels/dryrun/send', '.github/workflows/validate.yml'];
  for (const rel of paths) write(f.upstream, rel, `updated ${rel}\n`);
  fs.chmodSync(path.join(f.upstream, 'channels/dryrun/send'), 0o755);
  write(f.upstream, '.github/workflows/deliver.yml', 'upstream workflow\n');
  const result = f.run(paths);
  assert.match(result.stderr, /WARN: .github\/workflows\/deliver.yml differs from upstream/);
  assertUpdated(f, result, paths);
});

test('FEED-18 rejects incomplete source', async (t) => {
  for (const kind of ['missing', 'directory']) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      const rel = 'docs/later.md';
      write(f.repo, rel, 'existing core bytes\n');
      if (kind === 'directory') write(f.upstream, `${rel}/child.txt`, 'directory contents\n');
      assertUnchanged(f, f.run([...FIRST_PATHS, rel]));
    });
  }
});

test('FEED-18 validates manifest before changes', async (t) => {
  const invalid = [
    ['invalid JSON', '{'],
    ['non-object array', []],
    ['non-object null', null],
    ['missing version', { core_paths: FIRST_PATHS }],
    ['unsupported version', { manifest_version: 2, core_paths: FIRST_PATHS }],
    ['string version', { manifest_version: '1', core_paths: FIRST_PATHS }],
    ['boolean version', { manifest_version: true, core_paths: FIRST_PATHS }],
    ['float version', '{"manifest_version":1.0,"core_paths":["README.md"]}'],
    ['missing paths', { manifest_version: 1 }],
    ...[null, 'README.md', {}, 7, false, [], [null], [''], ['README.md', 7],
      [...FIRST_PATHS, FIRST_PATHS[0]]].map((core_paths) => [
      `invalid paths ${JSON.stringify(core_paths)}`, { manifest_version: 1, core_paths },
    ]),
  ];
  for (const [name, value] of invalid) {
    await t.test(name, (t) => {
      const f = fixture(t);
      assertUnchanged(f, f.run(FIRST_PATHS, {
        manifest: typeof value === 'string' ? value : JSON.stringify(value),
      }));
    });
  }
});

test('FEED-18 prepares all sources first', async (t) => {
  for (const failure of ['read', 'prepare']) {
    await t.test(`${failure} failure leaves all existing SHA-256 hashes unchanged`, (t) => {
      const f = fixture(t);
      const rel = 'tools/new/later.bin';
      write(f.upstream, rel, Buffer.from([0, 255, 10, 128]));
      fs.chmodSync(write(f.repo, rel, 'existing core bytes\n'), 0o755);
      const result = f.run([...FIRST_PATHS, rel], { failure });
      assertUnchanged(f, result);
      assert.match(result.stderr, /FAKE: prepared source: README.md/);
      assert.match(result.stderr, /FAKE: prepared source: tools\/new\/ok.txt/);
      assert.match(result.stderr, /fake source (read|preparation) failure/);
    });
  }
  await t.test('successful update preserves every byte and executable bit', (t) => {
    const f = fixture(t);
    const paths = [...FIRST_PATHS, 'tools/added/send', 'core-manifest.json'];
    fs.chmodSync(path.join(f.repo, 'README.md'), 0o755);
    fs.chmodSync(path.join(f.upstream, 'README.md'), 0o644);
    fs.chmodSync(path.join(f.upstream, 'tools/new/ok.txt'), 0o755);
    fs.chmodSync(write(f.upstream, 'tools/added/send', Buffer.from([0, 255, 10, 128])), 0o751);
    assertUpdated(f, f.run(paths), paths);
  });
});

test('core manifest distributes the update helper and regression tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  for (const rel of ['tools/lib/update_core.py', 'tests/update-core.test.js']) {
    assert.ok(manifest.core_paths.includes(rel), rel);
  }
});
