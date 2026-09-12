const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const {
  DEADLINE_TIME_ZONE,
  basisDate,
  basisDateCarrier,
} = require('../lib/basis-date');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'runner', 'deliver.js');
const FEED_SAMPLE = path.join(ROOT, 'tests', 'fixtures', 'feed-sample');
const FIXED_NOW_ISO = '2026-09-02T22:00:00.000Z';
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const EXPECTED_BASIS_DATE = '2026-09-03';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-basis-date-'));
const frozenClockPath = path.join(tmp, 'frozen-clock.cjs');
fs.writeFileSync(frozenClockPath, [
  'const RealDate = Date;',
  'class FrozenDate extends RealDate {',
  '  constructor(...args) {',
  `    super(...(args.length === 0 ? [${FIXED_NOW_MS}] : args));`,
  '  }',
  `  static now() { return ${FIXED_NOW_MS}; }`,
  '}',
  'global.Date = FrozenDate;',
  '',
].join('\n'));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeProfile(name, overrides = {}) {
  const profile = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'profile', 'delivery-profile.sample.json'), 'utf8')
  );
  profile.terms_accepted_sha256 = sha256(fs.readFileSync(path.join(ROOT, 'TERMS.md')));
  Object.assign(profile, overrides);
  const profilePath = path.join(tmp, name);
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  return profilePath;
}

function writeSyntheticFeed(dir, mutate) {
  fs.cpSync(FEED_SAMPLE, dir, { recursive: true });
  const dataPath = path.join(dir, 'subsidies.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  mutate(data);

  const dataBytes = Buffer.from(JSON.stringify(data));
  const gzipBytes = zlib.gzipSync(dataBytes);
  fs.writeFileSync(dataPath, dataBytes);
  fs.writeFileSync(path.join(dir, 'subsidies.json.gz'), gzipBytes);

  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.row_count = data.subsidies.length;
  meta.files['subsidies.json.gz'] = {
    bytes: gzipBytes.length,
    sha256: sha256(gzipBytes),
    sha256_uncompressed: sha256(dataBytes),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
}

function runDeliver(args, timeZone) {
  const res = spawnSync(
    process.execPath,
    ['--require', frozenClockPath, RUNNER, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TZ: timeZone, SAITA_FEEDER_DRY_RUN: '0' },
    }
  );
  assert.strictEqual(res.error, undefined);
  return res;
}

function deliveryArgs({ feed = FEED_SAMPLE, profile, ledger, out }) {
  return [
    '--feed', feed,
    '--profile', profile,
    '--ledger', ledger,
    '--out', out,
  ];
}

test('basisDate changes at the Asia/Tokyo calendar boundary', () => {
  assert.strictEqual(
    basisDate(Date.parse('2026-09-02T14:59:59.999Z')),
    '2026-09-02'
  );
  assert.strictEqual(
    basisDate(Date.parse('2026-09-02T15:00:00.000Z')),
    '2026-09-03'
  );
});

test('basisDate uses the next JST day at the default cron instant', () => {
  assert.strictEqual(DEADLINE_TIME_ZONE, 'Asia/Tokyo');
  // At 22:00 UTC the UTC date is still 2026-09-02, while JST is already 2026-09-03.
  assert.strictEqual(basisDate(Date.parse(FIXED_NOW_ISO)), EXPECTED_BASIS_DATE);
});

test('basisDate does not depend on the process time zone', () => {
  const originalTimeZone = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const utcResult = basisDate(FIXED_NOW_MS);
    process.env.TZ = 'America/Los_Angeles';
    const losAngelesResult = basisDate(FIXED_NOW_MS);
    assert.strictEqual(utcResult, EXPECTED_BASIS_DATE);
    assert.strictEqual(losAngelesResult, EXPECTED_BASIS_DATE);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test('basisDateCarrier represents the date at UTC midnight', () => {
  const carrier = basisDateCarrier('2026-09-03');
  assert.strictEqual(carrier.getUTCFullYear(), 2026);
  assert.strictEqual(carrier.getUTCMonth(), 8);
  assert.strictEqual(carrier.getUTCDate(), 3);
});

test('delivery uses one JST basis date for filenames, Markdown, and JSON across process time zones', () => {
  const profile = writeProfile('profile-date-consistency.json');
  const observedDates = [];

  for (const timeZone of ['UTC', 'America/Los_Angeles']) {
    const slug = timeZone.replaceAll('/', '-').toLowerCase();
    const runDir = path.join(tmp, `date-consistency-${slug}`);
    const ledger = path.join(runDir, 'state', 'notified.json');
    const out = path.join(runDir, 'output');
    const res = runDeliver(
      [...deliveryArgs({ profile, ledger, out }), '--dry-run'],
      timeZone
    );
    assert.strictEqual(res.status, 0, res.stderr);

    const markdownName = `digest-${EXPECTED_BASIS_DATE}-dryrun.md`;
    const jsonName = `digest-${EXPECTED_BASIS_DATE}-dryrun.json`;
    assert.deepStrictEqual(fs.readdirSync(out).sort(), [jsonName, markdownName].sort());

    const markdown = fs.readFileSync(path.join(out, markdownName), 'utf8');
    const digestJson = JSON.parse(fs.readFileSync(path.join(out, jsonName), 'utf8'));
    const filenameDate = /^digest-(\d{4}-\d{2}-\d{2})-dryrun\.md$/.exec(markdownName)[1];
    const headingDate = /^# 補助金マッチダイジェスト (\d{4}-\d{2}-\d{2})/m.exec(markdown)[1];
    const dates = [filenameDate, headingDate, digestJson.date];
    assert.deepStrictEqual(dates, Array(3).fill(EXPECTED_BASIS_DATE));
    observedDates.push(dates);
  }

  assert.deepStrictEqual(observedDates[0], observedDates[1]);
});

test('delivery keeps wall-clock ledger timestamps separate from the JST basis date', () => {
  const profile = writeProfile('profile-wall-clock.json');
  const runDir = path.join(tmp, 'wall-clock');
  const ledgerPath = path.join(runDir, 'state', 'notified.json');
  const out = path.join(runDir, 'output');
  const res = runDeliver(deliveryArgs({ profile, ledger: ledgerPath, out }), 'UTC');
  assert.strictEqual(res.status, 0, res.stderr);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const entries = Object.values(ledger.entries);
  assert.ok(entries.length > 0, 'the fixture must produce timestamped ledger entries');
  for (const entry of entries) {
    assert.strictEqual(entry.channels.dryrun.last_attempt_at, FIXED_NOW_ISO);
  }
  assert.ok(fs.existsSync(path.join(out, `digest-${EXPECTED_BASIS_DATE}-dryrun.md`)));
});

test('delivery excludes the previous basis day and renders same-day and next-day deadlines', () => {
  const profile = writeProfile('profile-deadline-boundary.json');
  const feed = path.join(tmp, 'feed-deadline-boundary');
  writeSyntheticFeed(feed, (data) => {
    data.subsidies.find(({ id }) => id === '1001').application_deadline = '2026-09-02';
    data.subsidies.find(({ id }) => id === '1002').application_deadline = '2026-09-03';
    data.subsidies.find(({ id }) => id === '1003').application_deadline = '2026-09-04';
  });

  const runDir = path.join(tmp, 'deadline-boundary');
  const ledger = path.join(runDir, 'state', 'notified.json');
  const out = path.join(runDir, 'output');
  const res = runDeliver(
    [...deliveryArgs({ feed, profile, ledger, out }), '--dry-run'],
    'UTC'
  );
  assert.strictEqual(res.status, 0, res.stderr);

  const base = path.join(out, `digest-${EXPECTED_BASIS_DATE}-dryrun`);
  const markdown = fs.readFileSync(`${base}.md`, 'utf8');
  const digestJson = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  assert.deepStrictEqual(digestJson.items.map(({ id }) => id), ['1002', '1003']);
  assert.doesNotMatch(markdown, /都内中小企業DX推進助成金/);
  assert.match(markdown, /締切: 2026-09-03（残り0日）/);
  assert.match(markdown, /締切: 2026-09-04（残り1日）/);
});
