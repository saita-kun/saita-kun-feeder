const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'tools', 'check-feed-contract.sh');
const FEED_SAMPLE = path.join(__dirname, 'fixtures', 'feed-sample');
const FORBIDDEN_FIELDS = ['source', 'is_open', 'url_dead_since'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-check-feed-contract-'));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeFeed(data) {
  const dir = fs.mkdtempSync(path.join(tmp, 'feed-'));
  const bytes = Buffer.from(JSON.stringify(data));
  const gz = zlib.gzipSync(bytes);
  const meta = readJson(path.join(FEED_SAMPLE, 'meta.json'));
  meta.schema_version = data.schema_version;
  meta.generated_at = data.generated_at;
  meta.row_count = data.subsidies.length;
  meta.files['subsidies.json.gz'] = {
    bytes: gz.length,
    sha256: sha256(gz),
    sha256_uncompressed: sha256(bytes),
  };
  fs.writeFileSync(path.join(dir, 'subsidies.json.gz'), gz);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

function run(args = []) {
  const res = spawnSync('bash', [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(res.error, undefined);
  return res;
}

function assertForbidden(res, expected) {
  assert.doesNotMatch(res.stderr, /integrity:|skew:/);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.strictEqual(res.stdout, '');
  assert.deepStrictEqual(res.stderr.trim().split(/\r?\n/), [
    ...expected.map(([index, field]) => `ERROR: subsidies[${index}]: forbidden field: ${field}`),
    `check-feed-contract: FAIL (${expected.length} error(s))`,
  ]);
}

test('bundled sample passes the default CLI gate', () => {
  const res = run();
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stderr, '');
  assert.strictEqual(res.stdout.trim(), 'check-feed-contract: OK (5 rows, schema 1.0)');
});

test('regenerated sample passes with matching gzip and metadata', () => {
  const data = readJson(path.join(FEED_SAMPLE, 'subsidies.json'));
  const res = run([writeFeed(data)]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stderr, '');
  assert.strictEqual(res.stdout.trim(), 'check-feed-contract: OK (5 rows, schema 1.0)');
});

test('forbidden_fields_fail_by_presence', async (t) => {
  const sample = readJson(path.join(FEED_SAMPLE, 'subsidies.json'));
  for (const index of [0, sample.subsidies.length - 1]) {
    for (const field of FORBIDDEN_FIELDS) {
      for (const value of [null, false, 0, '']) {
        await t.test(`row ${index}: ${field}=${JSON.stringify(value)}`, () => {
          const data = structuredClone(sample);
          data.subsidies[index][field] = value;
          assertForbidden(run([writeFeed(data)]), [[index, field]]);
        });
      }
    }
  }
});

test('forbidden fixture reports every forbidden field on a later row', () => {
  const data = readJson(path.join(__dirname, 'fixtures', 'feed-contract', 'forbidden-fields.json'));
  assertForbidden(run([writeFeed(data)]), FORBIDDEN_FIELDS.map((field) => [1, field]));
});

test('unknown_fields_remain_compatible', () => {
  const data = readJson(path.join(FEED_SAMPLE, 'subsidies.json'));
  data.future_header = { version: 2 };
  for (const row of data.subsidies) {
    row.future_field = { source: null, is_open: false, url_dead_since: 0 };
    row.source_label = 'fixture';
  }
  const res = run([writeFeed(data)]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stderr, '');
  assert.strictEqual(res.stdout.trim(), 'check-feed-contract: OK (5 rows, schema 1.0)');
});

test('schema keeps both objects extensible and forbids only the three row keys', () => {
  const schema = readJson(path.join(ROOT, 'schemas', 'feed-subsidy.schema.json'));
  const rowSchema = schema.$defs.subsidyRow;
  assert.strictEqual(schema.additionalProperties, true);
  assert.strictEqual(rowSchema.additionalProperties, true);
  for (const field of FORBIDDEN_FIELDS) {
    assert.strictEqual(rowSchema.properties[field], false, field);
  }
  const forbidden = Object.keys(rowSchema.properties).filter((field) => rowSchema.properties[field] === false);
  assert.deepStrictEqual(forbidden.sort(), [...FORBIDDEN_FIELDS].sort());
});

test('core manifest distributes the contract regression test and fixture', () => {
  const manifest = readJson(path.join(ROOT, 'core-manifest.json'));
  for (const file of [
    'tests/check-feed-contract.test.js',
    'tests/fixtures/feed-contract/forbidden-fields.json',
  ]) {
    assert.ok(manifest.core_paths.includes(file), file);
  }
});
