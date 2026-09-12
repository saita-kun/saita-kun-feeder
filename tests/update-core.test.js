const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
      : stat.isDirectory() ? ['directory'] : ['file', stat.mode, fs.readFileSync(file)];
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
    run(paths) {
      write(upstream, 'core-manifest.json', JSON.stringify({ manifest_version: 1, core_paths: paths }));
      const before = snapshot(base);
      const result = spawnSync('bash', ['tools/update-core.sh', upstream], {
        cwd: repo, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TMPDIR: tmp, FEEDER_FAKE_UPSTREAM: upstream },
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
  const after = snapshot(f.base);
  assert.deepEqual(Object.keys(after), Object.keys(result.before), 'no files or directories may be created');
  for (const rel of Object.keys(after)) assert.deepEqual(after[rel], result.before[rel], rel);
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
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /copied 6 core files/);
  assert.match(result.stderr, /WARN: .github\/workflows\/deliver.yml differs from upstream/);
  const expected = result.before;
  for (const rel of paths) {
    expected[path.join('adopter', rel)] = expected[path.join('upstream', rel)];
    for (let dir = path.dirname(rel); dir !== '.'; dir = path.dirname(dir)) {
      expected[path.join('adopter', dir)] = ['directory'];
    }
  }
  assert.deepEqual(snapshot(f.base), expected, 'only planned core files and their directories may change');
});

test('core manifest distributes the update helper and regression tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  for (const rel of ['tools/lib/update_core.py', 'tests/update-core.test.js']) {
    assert.ok(manifest.core_paths.includes(rel), rel);
  }
});
