const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FEEDBACK = 'docs/design/feed-contract-v1-producer-feedback.md';
const REGRESSION = 'tests/update-core-feedback.test.js';
const OWNED = [
  'profile/delivery-profile.json', 'state/notified.json',
  'input/setup-state.json', 'channels/my-local/send', '.github/workflows/deliver.yml',
];
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
};

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, input, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function write(root, rel, bytes) {
  const destination = path.join(root, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}

function fixture(t, collision) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-feedback-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const upstream = path.join(base, 'upstream.git');
  const adopter = path.join(base, 'adopter');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  const files = new Map(manifest.core_paths.map((rel) => [rel, {
    bytes: fs.readFileSync(path.join(ROOT, rel)),
    mode: fs.statSync(path.join(ROOT, rel)).mode & 0o111 ? '100755' : '100644',
  }]));
  assert.ok(files.has(FEEDBACK), 'historical feedback must be distributed');
  assert.ok(files.has(REGRESSION), 'the regression test must be distributed');
  const sentinels = new Map(OWNED.map((rel) => [rel, Buffer.from(`adopter sentinel: ${rel}\n`)]));

  // Import fixture histories only into disposable bare repos; never touch ROOT's index.
  function seed(repo, entries) {
    git(base, ['init', '--quiet', '--bare', '--template=', repo]);
    const chunks = [Buffer.from(
      'commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1 +0000\ndata 8\nfixture\n\n',
    )];
    for (const [rel, { bytes, mode }] of entries) {
      chunks.push(Buffer.from(`M ${mode} inline ${JSON.stringify(rel)}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'));
    }
    chunks.push(Buffer.from('\ndone\n'));
    git(repo, ['fast-import', '--quiet'], Buffer.concat(chunks));
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  files.set('.github/workflows/deliver.yml', { bytes: Buffer.from('upstream workflow\n'), mode: '100644' });
  seed(upstream, files);
  const oldFiles = new Map(files);
  oldFiles.delete(REGRESSION);
  oldFiles.set('core-manifest.json', { mode: '100644', bytes: Buffer.from(JSON.stringify({
    ...manifest, core_paths: manifest.core_paths.filter((rel) => rel !== FEEDBACK && rel !== REGRESSION),
  })) });
  oldFiles.set(FEEDBACK, { mode: '100644', bytes: Buffer.from('Old producer feedback\n') });
  for (const [rel, bytes] of sentinels) oldFiles.set(rel, { mode: '100644', bytes });
  if (collision === 'untracked' || collision === 'ignored') oldFiles.delete(FEEDBACK);
  if (collision === 'ignored') {
    oldFiles.set('.gitignore', { mode: '100644', bytes: Buffer.from(`${FEEDBACK}\n`) });
  }
  const oldRepo = path.join(base, 'old.git');
  seed(oldRepo, oldFiles);
  git(base, ['clone', '--quiet', '--no-hardlinks', oldRepo, adopter]);
  if (collision) write(adopter, FEEDBACK, 'Adopter conflict: preserve these bytes\n');
  return {
    adopter, files, sentinels,
    run() {
      const result = spawnSync('bash', ['tools/update-core.sh', upstream], {
        cwd: adopter, env: GIT_ENV, encoding: 'utf8', timeout: 30000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return result;
    },
  };
}

test('update_core_refreshes_historical_feedback', (t) => {
  const f = fixture(t);
  assert.notDeepEqual(fs.readFileSync(path.join(f.adopter, FEEDBACK)), f.files.get(FEEDBACK).bytes);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const rel of [FEEDBACK, REGRESSION, 'core-manifest.json']) {
    assert.deepEqual(fs.readFileSync(path.join(f.adopter, rel)), f.files.get(rel).bytes);
  }
});

test('update_core_preserves_adopter_owned_files', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN: .github\/workflows\/deliver.yml differs from upstream/);
  for (const [rel, bytes] of f.sentinels) {
    assert.deepEqual(fs.readFileSync(path.join(f.adopter, rel)), bytes, rel);
  }
});

test('update_core_stops_on_feedback_collisions_before_copying', async (t) => {
  for (const collision of ['dirty', 'untracked', 'ignored']) {
    await t.test(collision, (t) => {
      const f = fixture(t, collision);
      const paths = [...new Set([...f.files.keys(), ...OWNED])];
      const snapshot = () => paths.map((rel) => {
        const file = path.join(f.adopter, rel);
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      });
      const before = snapshot();
      const result = f.run();
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, collision === 'dirty' ? /working tree is dirty/ : /not tracked in Git index/);
      assert.doesNotMatch(result.stdout, /copied \d+ core files/);
      assert.deepEqual(snapshot(), before);
    });
  }
});
