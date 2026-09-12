// Delivery dry-run contract: CLI/environment modes, fake sends, and ledger writes.
// Keep the matrix separate from the E2E suite rerun by e2e-isolation.test.js.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

function run(args, env = {}) {
  const childEnv = { ...process.env, SAITA_FEEDER_DRY_RUN: '0', ...env };
  if (childEnv.SAITA_FEEDER_DRY_RUN === undefined) delete childEnv.SAITA_FEEDER_DRY_RUN;
  const res = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'deliver.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv,
  });
  assert.strictEqual(res.error, undefined);
  return res;
}

function runFakeChannel(name, { envValue, cliDryRun = false, existingLedger = false }) {
  writeChannel(name, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const digest = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'const call = { mode: process.env.SAITA_FEEDER_DRY_RUN, ids: digest.items.map(({ id }) => id) };',
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(call) + '\\n');",
    "if (call.mode !== '1') {",
    "  fs.appendFileSync(path.join(__dirname, 'sends.jsonl'), JSON.stringify(call.ids) + '\\n');",
    '}',
    '',
  ].join('\n'));
  const fakeProfile = writeProfile(`${name}-profile.json`, {
    channels: [{ name, enabled: true }],
  });
  const fakeLedger = path.join(tmp, `${name}-ledger.json`);
  if (existingLedger) {
    const seeded = { ledger_version: 1, entries: {} };
    const subsidy = JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json')))
      .subsidies.find(({ id }) => id === '1001');
    ledgerLib.recordResult(seeded, subsidy, name, {
      ok: true, nowIso: '2026-07-09T00:00:00.000Z',
      hash: ledgerLib.contentHash(subsidy), notifiedAs: 'new',
    });
    fs.writeFileSync(fakeLedger, JSON.stringify(seeded));
  }
  const before = existingLedger ? {
    hash: sha256(fs.readFileSync(fakeLedger)),
    mtimeNs: fs.statSync(fakeLedger, { bigint: true }).mtimeNs,
  } : null;
  const res = run([
    '--feed', FEED_SAMPLE, '--profile', fakeProfile,
    '--ledger', fakeLedger, '--out', path.join(tmp, `${name}-out`),
    '--today', '2026-07-10', ...(cliDryRun ? ['--dry-run'] : []),
  ], { SAITA_FEEDER_DRY_RUN: envValue });
  assert.strictEqual(res.status, 0, res.stderr);
  const calls = fs.readFileSync(path.join(ROOT, 'channels', name, 'calls.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(calls.length, 1, 'the configured adapter must be invoked once');
  assert.deepStrictEqual([...calls[0].ids].sort(), existingLedger ? ['1002', '1003'] : ['1001', '1002', '1003']);
  const sendsPath = path.join(ROOT, 'channels', name, 'sends.jsonl');
  const sends = fs.existsSync(sendsPath)
    ? fs.readFileSync(sendsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { fakeLedger, before, calls, sends };
}

function assertDryRunPreservesLedger({ fakeLedger, before, calls, sends }) {
  assert.strictEqual(calls[0].mode, '1');
  assert.deepStrictEqual(sends, [], 'dry-run must perform zero fake sends');
  if (before) {
    assert.strictEqual(sha256(fs.readFileSync(fakeLedger)), before.hash);
    assert.strictEqual(fs.statSync(fakeLedger, { bigint: true }).mtimeNs, before.mtimeNs,
      'dry-run must not write the existing ledger');
  } else {
    assert.ok(!fs.existsSync(fakeLedger), 'dry-run must not create a ledger');
  }
}

test('FEED-09 environment dry run preserves ledger', async (t) => {
  for (const cliDryRun of [false, true]) {
    for (const existingLedger of [false, true]) {
      await t.test(`CLI=${cliDryRun}, existing ledger=${existingLedger}`, () => {
        assertDryRunPreservesLedger(runFakeChannel(`e2e-env-dry-${cliDryRun}-${existingLedger}`, {
          envValue: '1', cliDryRun, existingLedger,
        }));
      });
    }
  }
  await t.test('environment dry run uses the dry-run fallback', () => {
    const fallbackProfile = writeProfile('profile-env-fallback.json', { channels: [] });
    const fallbackLedger = path.join(tmp, 'ledger-env-fallback.json');
    const res = run([
      '--feed', FEED_SAMPLE, '--profile', fallbackProfile,
      '--ledger', fallbackLedger, '--out', path.join(tmp, 'out-env-fallback'),
      '--today', '2026-07-10',
    ], { SAITA_FEEDER_DRY_RUN: '1' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /（dry-run fallback）/);
    assert.match(res.stdout, /SAITA_FEEDER_DRY_RUN=1/);
    assert.ok(!fs.existsSync(fallbackLedger));
  });
});

const normalEnvironments = [undefined, '0', '', 'true', '01', ' 1', '1 '];

test('FEED-09 CLI dry run wins over normal environment', async (t) => {
  for (const [index, envValue] of normalEnvironments.entries()) {
    for (const existingLedger of [false, true]) {
      await t.test(`env=${JSON.stringify(envValue)}, existing ledger=${existingLedger}`, () => {
        assertDryRunPreservesLedger(runFakeChannel(`e2e-cli-dry-${index}-${existingLedger}`, {
          envValue, cliDryRun: true, existingLedger,
        }));
      });
    }
  }
});

test('FEED-09 normal execution records fake sends', async (t) => {
  for (const [index, envValue] of normalEnvironments.entries()) {
    await t.test(`env=${JSON.stringify(envValue)}`, () => {
      const name = `e2e-normal-${index}`;
      const { fakeLedger, calls, sends } = runFakeChannel(name, { envValue });
      assert.strictEqual(calls[0].mode, '0');
      assert.deepStrictEqual(sends.map((ids) => [...ids].sort()), [['1001', '1002', '1003']]);
      const ledger = JSON.parse(fs.readFileSync(fakeLedger));
      assert.deepStrictEqual(Object.keys(ledger.entries).sort(), [...sends[0]].sort());
      for (const id of sends[0]) {
        assert.strictEqual(ledger.entries[id].channels[name].status, 'sent');
      }
    });
  }
});
