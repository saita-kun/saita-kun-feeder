// E2E: fixture feed -> match -> select -> digest -> dryrun channel -> ledger.
// Deterministic: --today fixes both matching dates and ledger timestamps, so
// the rendered digest must be byte-identical to tests/fixtures/golden-digest/.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FEED_SAMPLE = path.join(ROOT, 'tests', 'fixtures', 'feed-sample');
const GOLDEN_DIGEST = path.join(ROOT, 'tests', 'fixtures', 'golden-digest', 'digest-2026-07-10-dryrun.md');
const E2E_FAIL_CHANNEL = path.join(ROOT, 'channels', 'e2e-fail');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-e2e-'));
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(E2E_FAIL_CHANNEL, { recursive: true, force: true });
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeProfile(name, overrides = {}) {
  const profile = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'profile', 'delivery-profile.sample.json'), 'utf8')
  );
  profile.terms_accepted_sha256 = sha256(fs.readFileSync(path.join(ROOT, 'TERMS.md')));
  Object.assign(profile, overrides);
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(profile));
  return p;
}

function run(args) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'deliver.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(res.error, undefined);
  return res;
}

function writeMutatedFeed(dir, mutate) {
  // Uncompressed variant (contract-checker/feed-client both support it for
  // local fixtures); meta sha256_uncompressed is recomputed so integrity holds.
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), 'utf8'));
  mutate(data);
  const bytes = Buffer.from(JSON.stringify(data));
  const gz = zlib.gzipSync(bytes);
  fs.writeFileSync(path.join(dir, 'subsidies.json.gz'), gz);
  const meta = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'meta.json'), 'utf8'));
  meta.generated_at = data.generated_at;
  meta.row_count = data.subsidies.length;
  meta.files['subsidies.json.gz'] = {
    bytes: gz.length,
    sha256: sha256(gz),
    sha256_uncompressed: sha256(bytes),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

const profilePath = writeProfile('profile.json');
const ledgerPath = path.join(tmp, 'ledger.json');
const outDir = path.join(tmp, 'out');
const baseArgs = [
  '--feed', FEED_SAMPLE,
  '--profile', profilePath,
  '--ledger', ledgerPath,
  '--out', outDir,
];

test('E2E(1) first run: digest is byte-identical to golden', () => {
  const res = run([...baseArgs, '--today', '2026-07-10']);
  assert.strictEqual(res.status, 0, res.stderr);
  const digest = fs.readFileSync(path.join(outDir, 'digest-2026-07-10-dryrun.md'), 'utf8');
  const golden = fs.readFileSync(GOLDEN_DIGEST, 'utf8');
  assert.strictEqual(digest, golden);
});

test('E2E(2) ledger records 1001/1002/1003 as sent (new), excludes 1004/1005', () => {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(ledger.entries).sort(), ['1001', '1002', '1003']);
  for (const id of ['1001', '1002', '1003']) {
    const ch = ledger.entries[id].channels.dryrun;
    assert.strictEqual(ch.status, 'sent');
    assert.strictEqual(ch.notified_as, 'new');
    assert.strictEqual(ch.last_attempt_at, '2026-07-10T00:00:00.000Z');
  }
});

test('E2E(3) second run is idempotent: nothing delivered, ledger unchanged', () => {
  const before = fs.readFileSync(ledgerPath, 'utf8');
  const res = run([...baseArgs, '--today', '2026-07-10']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /新着・更新なし — 配信しません/);
  assert.strictEqual(fs.readFileSync(ledgerPath, 'utf8'), before);
});

test('E2E(4) content-hash change re-notifies exactly one row as updated', () => {
  const mutDir = path.join(tmp, 'feed-mut');
  writeMutatedFeed(mutDir, (data) => {
    data.subsidies.find((s) => s.id === '1001').maximum_amount = 6000000;
  });
  const res = run([
    '--feed', mutDir,
    '--profile', profilePath,
    '--ledger', ledgerPath,
    '--out', outDir,
    '--today', '2026-07-11',
  ]);
  assert.strictEqual(res.status, 0, res.stderr);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.strictEqual(ledger.entries['1001'].channels.dryrun.notified_as, 'updated');
  assert.strictEqual(ledger.entries['1001'].channels.dryrun.last_attempt_at, '2026-07-11T00:00:00.000Z');
  // 1002/1003 untouched on the second day
  assert.strictEqual(ledger.entries['1002'].channels.dryrun.last_attempt_at, '2026-07-10T00:00:00.000Z');
  const digest = fs.readFileSync(path.join(outDir, 'digest-2026-07-11-dryrun.md'), 'utf8');
  assert.match(digest, /マッチ 1 件（新着 0 \/ 更新 1 \/ 再送 0）/);
});

test('E2E(5) stale feed surfaces a warning banner in the digest', () => {
  const freshLedger = path.join(tmp, 'ledger-stale.json');
  const res = run([
    '--feed', FEED_SAMPLE,
    '--profile', profilePath,
    '--ledger', freshLedger,
    '--out', outDir,
    '--today', '2026-08-01',
  ]);
  assert.strictEqual(res.status, 0, res.stderr);
  const digest = fs.readFileSync(path.join(outDir, 'digest-2026-08-01-dryrun.md'), 'utf8');
  assert.match(digest, /## ⚠ 注意/);
  assert.match(digest, /フィード停止の可能性/);
});

test('dry-run never mutates the ledger', () => {
  const dryLedger = path.join(tmp, 'ledger-dry.json');
  const res = run([
    '--feed', FEED_SAMPLE,
    '--profile', profilePath,
    '--ledger', dryLedger,
    '--out', outDir,
    '--today', '2026-07-10',
    '--dry-run',
  ]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(dryLedger), 'dry-run must not create a ledger');
  assert.match(res.stdout, /SAITA_FEEDER_DRY_RUN=1/);
});

test('failing channel: recorded as failed, backoff skips, next day retries', () => {
  fs.mkdirSync(E2E_FAIL_CHANNEL, { recursive: true });
  fs.writeFileSync(
    path.join(E2E_FAIL_CHANNEL, 'channel.json'),
    JSON.stringify({
      contract_version: 1,
      name: 'e2e-fail',
      description: 'test-only failing channel',
      requires_env: [],
    })
  );
  const sendPath = path.join(E2E_FAIL_CHANNEL, 'send');
  fs.writeFileSync(sendPath, '#!/usr/bin/env bash\nif [ "${SAITA_FEEDER_DRY_RUN:-0}" = "1" ]; then exit 0; fi\nexit 1\n');
  fs.chmodSync(sendPath, 0o755);

  const failProfile = writeProfile('profile-fail.json', {
    channels: [{ name: 'e2e-fail', enabled: true }],
  });
  const failLedger = path.join(tmp, 'ledger-fail.json');
  const failArgs = ['--feed', FEED_SAMPLE, '--profile', failProfile, '--ledger', failLedger, '--out', outDir];

  const first = run([...failArgs, '--today', '2026-07-10']);
  assert.strictEqual(first.status, 2, 'partial failure exits 2');
  let ledger = JSON.parse(fs.readFileSync(failLedger, 'utf8'));
  assert.strictEqual(ledger.entries['1001'].channels['e2e-fail'].status, 'failed');
  assert.strictEqual(ledger.entries['1001'].channels['e2e-fail'].retry_count, 0);

  // Same instant: within the 30-min backoff, nothing is retried.
  const second = run([...failArgs, '--today', '2026-07-10']);
  assert.match(second.stdout, /新着・更新なし — 配信しません/);
  ledger = JSON.parse(fs.readFileSync(failLedger, 'utf8'));
  assert.strictEqual(ledger.entries['1001'].channels['e2e-fail'].retry_count, 0);

  // Next day: backoff elapsed, retried and failed again -> retry_count 1.
  const third = run([...failArgs, '--today', '2026-07-11']);
  assert.strictEqual(third.status, 2);
  ledger = JSON.parse(fs.readFileSync(failLedger, 'utf8'));
  assert.strictEqual(ledger.entries['1001'].channels['e2e-fail'].retry_count, 1);
  assert.strictEqual(ledger.entries['1001'].channels['e2e-fail'].notified_as, 'new');
});
