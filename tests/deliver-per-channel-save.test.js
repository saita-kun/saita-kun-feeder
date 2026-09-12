// Per-channel ledger checkpoints and delivery resumption with fixture channels.
// Keep these cases separate from the E2E suite rerun by e2e-isolation.test.js.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const ROOT = createFixtureRepo(after);
const ledgerLib = require(path.join(ROOT, 'lib', 'ledger'));
const FEED_SAMPLE = path.join(ROOT, 'tests', 'fixtures', 'feed-sample');

const tmp = path.join(ROOT, 'work');
fs.mkdirSync(tmp);

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

function writeChannel(name, sendScript) {
  const dir = path.join(ROOT, 'channels', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'channel.json'),
    JSON.stringify({
      contract_version: 1,
      name,
      description: `test-only ${name} channel`,
      requires_env: [],
    })
  );
  const sendPath = path.join(dir, 'send');
  fs.writeFileSync(sendPath, sendScript);
  fs.chmodSync(sendPath, 0o755);
}

function run(args, env = {}, nodeArgs = []) {
  const childEnv = { ...process.env, SAITA_FEEDER_DRY_RUN: '0', ...env };
  if (childEnv.SAITA_FEEDER_DRY_RUN === undefined) delete childEnv.SAITA_FEEDER_DRY_RUN;
  const res = spawnSync(process.execPath, [...nodeArgs, path.join(ROOT, 'runner', 'deliver.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv,
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

function checkpointRun(label, overrides = {}) {
  const dir = path.join(tmp, label);
  fs.mkdirSync(dir);
  const names = [`e2e-${label}-a`, `e2e-${label}-b`];
  const calls = path.join(dir, 'calls.txt');
  const ledger = path.join(dir, 'ledger.json');
  const out = path.join(dir, 'out');
  const profile = writeProfile(`profile-${label}.json`, {
    channels: names.map((name) => ({ name, enabled: true })),
    daily_cap: 10,
    ...overrides,
  });
  function configure(name, body = '') {
    writeChannel(name, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const digest = JSON.parse(fs.readFileSync(0, 'utf8'));",
      `fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${name}\n`)});`,
      body,
      '',
    ].join('\n'));
  }
  for (const name of names) configure(name);
  return {
    dir, names, calls, ledger, out, configure,
    args: ['--feed', FEED_SAMPLE, '--profile', profile, '--ledger', ledger,
      '--out', out, '--today', '2026-07-10'],
  };
}

test('FEED-11 preserves earlier success', () => {
  const setup = checkpointRun('preserve');
  const [a, b] = setup.names;
  const blockedOutput = path.join(setup.out, `digest-2026-07-10-${b}.md`);
  fs.mkdirSync(blockedOutput, { recursive: true });

  const first = run(setup.args);
  assert.strictEqual(first.status, 1, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stderr, /EISDIR/);
  assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n`);
  const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
  assert.deepStrictEqual(Object.keys(saved.entries).sort(), ['1001', '1002', '1003']);
  for (const entry of Object.values(saved.entries)) {
    assert.strictEqual(entry.channels[a].status, 'sent');
    assert.strictEqual(entry.channels[b], undefined);
  }

  fs.rmdirSync(blockedOutput);
  fs.writeFileSync(setup.calls, '');
  const second = run(setup.args);
  assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${b}\n`,
    'only B may be invoked on the next run');
  const retried = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
  for (const id of Object.keys(saved.entries)) {
    assert.deepStrictEqual(retried.entries[id].channels[a], saved.entries[id].channels[a]);
    assert.strictEqual(retried.entries[id].channels[b].status, 'sent');
  }
});

for (const cap of ['daily_cap', 'weekly_cap']) {
  test(`FEED-11 resumes unsent channel when ${cap} is exhausted`, () => {
    const setup = checkpointRun(`resume-${cap.replace('_', '-')}`, { [cap]: 3 });
    const [a, b] = setup.names;
    const received = path.join(setup.dir, 'received.json');
    setup.configure(b, `fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(digest));`);
    const blockedOutput = path.join(setup.out, `digest-2026-07-10-${b}.md`);
    fs.mkdirSync(blockedOutput, { recursive: true });

    const first = run(setup.args);
    assert.strictEqual(first.status, 1, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /EISDIR/);
    assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n`);
    assert.ok(!fs.existsSync(received));
    const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
    assert.deepStrictEqual(Object.keys(saved.entries).sort(), ['1001', '1002', '1003']);
    for (const entry of Object.values(saved.entries)) {
      assert.strictEqual(entry.channels[a].status, 'sent');
      assert.strictEqual(entry.channels[b], undefined);
    }

    fs.rmdirSync(blockedOutput);
    const second = run(setup.args);
    assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.ok(second.stdout.includes(`[${a}] 新着・更新なし — 配信しません`));
    assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n${b}\n`);
    const delivered = JSON.parse(fs.readFileSync(received, 'utf8'));
    assert.deepStrictEqual(delivered.items.map((item) => item.id).sort(), ['1001', '1002', '1003']);
    assert.strictEqual(delivered.dropped_count, 0);
    const retried = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
    for (const id of Object.keys(saved.entries)) {
      assert.deepStrictEqual(retried.entries[id].channels[a], saved.entries[id].channels[a]);
      assert.strictEqual(retried.entries[id].channels[b].status, 'sent');
      assert.strictEqual(retried.entries[id].channels[b].last_sent_hash, saved.entries[id].channels[a].last_sent_hash);
    }

    const before = fs.readFileSync(setup.ledger, 'utf8');
    const third = run(setup.args);
    assert.strictEqual(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n${b}\n`);
    assert.strictEqual(fs.readFileSync(setup.ledger, 'utf8'), before);
  });
}

test('FEED-11 resumes counted IDs while higher-priority new candidates remain capped', () => {
  const setup = checkpointRun('resume-mixed', { daily_cap: 2 });
  const [a, b] = setup.names;
  const received = path.join(setup.dir, 'received.json');
  setup.configure(b, `fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(digest));`);
  const data = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), 'utf8'));
  const ledger = { ledger_version: 1, entries: {} };
  for (const id of ['1001', '1003']) {
    const subsidy = data.subsidies.find((item) => item.id === id);
    ledgerLib.recordResult(ledger, subsidy, a, {
      ok: true, nowIso: '2026-07-10T00:00:00.000Z', hash: ledgerLib.contentHash(subsidy), notifiedAs: 'new',
    });
  }
  fs.writeFileSync(setup.ledger, JSON.stringify(ledger));

  const result = run(setup.args);
  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${b}\n`);
  const delivered = JSON.parse(fs.readFileSync(received, 'utf8'));
  assert.deepStrictEqual(delivered.items.map((item) => item.id), ['1001', '1003']);
  assert.strictEqual(delivered.dropped_count, 1);
  const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
  assert.strictEqual(saved.entries['1002'], undefined);
  for (const id of ['1001', '1003']) {
    assert.deepStrictEqual(saved.entries[id].channels[a], ledger.entries[id].channels[a]);
    assert.strictEqual(saved.entries[id].channels[b].status, 'sent');
  }
});

test('FEED-11 resumes a channel-local content update at the daily cap', () => {
  const setup = checkpointRun('resume-updated', { daily_cap: 3 });
  const [a, b] = setup.names;
  const received = path.join(setup.dir, 'received.json');
  setup.configure(b, `fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(digest));`);
  const data = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), 'utf8'));
  const ledger = { ledger_version: 1, entries: {} };
  for (const id of ['1001', '1002', '1003']) {
    const subsidy = data.subsidies.find((item) => item.id === id);
    for (const channel of setup.names) {
      ledgerLib.recordResult(ledger, subsidy, channel, {
        ok: true, nowIso: '2026-07-10T00:00:00.000Z', hash: ledgerLib.contentHash(subsidy), notifiedAs: 'new',
      });
    }
  }
  const feed = path.join(setup.dir, 'feed');
  writeMutatedFeed(feed, (data) => {
    const subsidy = data.subsidies.find((item) => item.id === '1001');
    subsidy.maximum_amount = 6000000;
    ledgerLib.recordResult(ledger, subsidy, a, {
      ok: true, nowIso: '2026-07-10T00:00:00.000Z', hash: ledgerLib.contentHash(subsidy), notifiedAs: 'updated',
    });
  });
  fs.writeFileSync(setup.ledger, JSON.stringify(ledger));

  const result = run([...setup.args, '--feed', feed]);
  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${b}\n`);
  const delivered = JSON.parse(fs.readFileSync(received, 'utf8'));
  assert.deepStrictEqual(delivered.items.map(({ id, notified_as }) => ({ id, notified_as })),
    [{ id: '1001', notified_as: 'updated' }]);
  assert.strictEqual(delivered.dropped_count, 0);
  const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
  for (const id of ['1001', '1002', '1003']) {
    assert.deepStrictEqual(saved.entries[id].channels[a], ledger.entries[id].channels[a]);
  }
  assert.strictEqual(saved.entries['1001'].channels[b].last_sent_hash, ledger.entries['1001'].channels[a].last_sent_hash);
});

for (const ok of [true, false]) {
  const outcome = ok ? 'successful channel shares capacity' : 'failed channel leaves capacity';
  test(`FEED-11 ${outcome} for another channel with different candidates`, () => {
    const setup = checkpointRun(`capacity-${ok ? 'success' : 'failure'}`, { daily_cap: 1 });
    const [a, b] = setup.names;
    setup.configure(a, `process.exit(${ok ? 0 : 7});`);
    const received = path.join(setup.dir, 'received.json');
    setup.configure(b, `fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(digest));`);
    const data = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), 'utf8'));
    const subsidy = data.subsidies.find((item) => item.id === '1002');
    const ledger = { ledger_version: 1, entries: {} };
    ledgerLib.recordResult(ledger, subsidy, b, {
      ok: true, nowIso: '2026-07-01T00:00:00.000Z', hash: ledgerLib.contentHash(subsidy), notifiedAs: 'new',
    });
    fs.writeFileSync(setup.ledger, JSON.stringify(ledger));

    const result = run(setup.args);
    assert.strictEqual(result.status, ok ? 0 : 2, `${result.stdout}\n${result.stderr}`);
    assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), ok ? `${a}\n` : `${a}\n${b}\n`);
    const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
    if (ok) {
      assert.ok(!fs.existsSync(received));
      assert.strictEqual(saved.entries['1001'], undefined);
    } else {
      const delivered = JSON.parse(fs.readFileSync(received, 'utf8'));
      assert.deepStrictEqual(delivered.items.map((item) => item.id), ['1001']);
      assert.strictEqual(delivered.dropped_count, 1);
      assert.strictEqual(saved.entries['1001'].channels[b].status, 'sent');
    }
    assert.strictEqual(saved.entries['1002'].channels[a].status, ok ? 'sent' : 'failed');
    assert.deepStrictEqual(saved.entries['1002'].channels[b], ledger.entries['1002'].channels[b]);
    assert.strictEqual(ledgerLib.countSentWithin(saved, Date.parse('2026-07-10T00:00:00.000Z'), 24 * 60 * 60 * 1000), 1);
  });
}

test('FEED-11 checkpoints failures and stops on save error', async (t) => {
  await t.test('B observes A failed before sending; ordinary send failure exits 2', () => {
    const setup = checkpointRun('failed');
    const [a, b] = setup.names;
    const observed = path.join(setup.dir, 'observed.json');
    setup.configure(a, 'process.exit(7);');
    setup.configure(b, [
      `const checkpoint = JSON.parse(fs.readFileSync(${JSON.stringify(setup.ledger)}, 'utf8'));`,
      `require('node:assert').strictEqual(checkpoint.entries['1001'].channels[${JSON.stringify(a)}].status, 'failed');`,
      `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(checkpoint));`,
    ].join('\n'));

    const result = run(setup.args);
    assert.strictEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n${b}\n`);
    const checkpoint = JSON.parse(fs.readFileSync(observed, 'utf8'));
    const saved = JSON.parse(fs.readFileSync(setup.ledger, 'utf8'));
    assert.deepStrictEqual(Object.keys(checkpoint.entries).sort(), ['1001', '1002', '1003']);
    for (const id of Object.keys(checkpoint.entries)) {
      assert.strictEqual(checkpoint.entries[id].channels[a].status, 'failed');
      assert.strictEqual(checkpoint.entries[id].channels[b], undefined);
      assert.deepStrictEqual(saved.entries[id].channels[a], checkpoint.entries[id].channels[a]);
      assert.strictEqual(saved.entries[id].channels[b].status, 'sent');
    }
  });

  for (const status of [0, 7]) {
    await t.test(`save error after adapter exit ${status} stops before B and exits 1`, () => {
      const setup = checkpointRun(`save-error-${status}`);
      const [a, b] = setup.names;
      setup.configure(a, `process.exit(${status});`);
      const original = '{"ledger_version":1,"entries":{}}\n';
      fs.writeFileSync(setup.ledger, original);
      const preload = path.join(setup.dir, 'fail-save.cjs');
      fs.writeFileSync(preload, [
        "const fs = require('node:fs');",
        'const rename = fs.renameSync;',
        'fs.renameSync = (from, to) => {',
        `  if (to === ${JSON.stringify(setup.ledger)}) throw new Error('FEED-11 save failure');`,
        '  return rename(from, to);',
        '};',
        '',
      ].join('\n'));

      const result = run(setup.args, {}, ['--require', preload]);
      assert.strictEqual(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /FEED-11 save failure/);
      assert.strictEqual(fs.readFileSync(setup.calls, 'utf8'), `${a}\n`);
      assert.ok(!fs.existsSync(path.join(setup.out, `digest-2026-07-10-${b}.md`)));
      assert.strictEqual(fs.readFileSync(setup.ledger, 'utf8'), original);
      assert.deepStrictEqual(fs.readdirSync(setup.dir).sort(),
        ['cache', 'calls.txt', 'fail-save.cjs', 'ledger.json', 'out']);
    });
  }
});
