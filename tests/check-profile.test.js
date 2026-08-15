// Regression tests for the profile gate, focused on feed_base_url placeholder
// detection (issue #4): a profile pointing at a reserved/example domain must
// fail loudly instead of passing the gate and then failing every fetch.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'tools', 'lib', 'check_profile.js');
const SAMPLE = path.join(ROOT, 'profile', 'delivery-profile.sample.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-check-profile-'));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeProfile(name, overrides = {}) {
  const profile = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  profile.terms_accepted_sha256 = '0'.repeat(64);
  Object.assign(profile, overrides);
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(profile));
  return p;
}

function run(args) {
  return spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8' });
}

test('bundled sample passes in template self-check mode (--allow-sample)', () => {
  const res = run([SAMPLE, '--allow-sample']);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('profile keeping the bundled default feed_base_url passes', () => {
  const res = run([writeProfile('ok.json')]);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('placeholder feed_base_url (.invalid domain) fails and names the field', () => {
  const res = run([writeProfile('placeholder.json', { feed_base_url: 'https://feed.example.invalid/v1' })]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /feed_base_url/);
});

test('placeholder feed_base_url is rejected even with --allow-sample', () => {
  const res = run([
    writeProfile('placeholder-sample.json', { feed_base_url: 'https://feed.example.invalid/v1' }),
    '--allow-sample',
  ]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /feed_base_url/);
});

test('REPLACED-BY-SETUP feed_base_url fails', () => {
  const res = run([writeProfile('unreplaced.json', { feed_base_url: 'REPLACED-BY-SETUP' })]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /feed_base_url/);
});
