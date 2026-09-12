const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const ROOT = path.resolve(__dirname, '..');
const TODAY = '2026-07-10';
const GOLDEN_JSON = 'tests/fixtures/golden-digest/digest-2026-07-10-dryrun.json';

function createRepo(t) {
  const repo = fs.mkdtempSync(path.join(ROOT, '.channel-stdin-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // Copy only fixture inputs and runtime files; adapters stay in this temporary repo.
  for (const relative of [
    'runner', 'lib', 'TERMS.md', 'profile/delivery-profile.sample.json',
    'tools/check-channels.sh', 'tools/lib/check_channels.py',
    'tests/fixtures/feed-sample', 'tests/fixtures/golden-digest',
  ]) {
    const destination = path.join(repo, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(ROOT, relative), destination, { recursive: true });
  }
  const channel = path.join(repo, 'channels', 'dryrun');
  fs.mkdirSync(channel, { recursive: true });
  fs.writeFileSync(path.join(channel, 'channel.json'), JSON.stringify({
    contract_version: 1, name: 'dryrun', description: 'Records test stdin', requires_env: [],
  }));
  fs.writeFileSync(path.join(channel, 'send'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const capture = process.env.FEEDER_STDIN_CAPTURE;',
    'fs.writeFileSync(capture, fs.readFileSync(0));',
    "fs.writeFileSync(capture + '.mode', process.env.SAITA_FEEDER_DRY_RUN || '');",
    'process.exitCode = Number(process.env.FEEDER_FAKE_EXIT);',
    '',
  ].join('\n'), { mode: 0o755 });
  const profile = JSON.parse(fs.readFileSync(path.join(repo, 'profile/delivery-profile.sample.json')));
  profile.terms_accepted_sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(repo, 'TERMS.md'))).digest('hex');
  fs.writeFileSync(path.join(repo, 'profile.json'), JSON.stringify(profile));
  return repo;
}

function invoke(repo, name, command, args, exitCode = 0) {
  const capture = path.join(repo, `${name}.stdin`);
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      SAITA_FEEDER_DRY_RUN: '',
      FEEDER_STDIN_CAPTURE: capture,
      FEEDER_FAKE_EXIT: String(exitCode),
    },
  });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null, result.stderr);
  assert.ok(fs.existsSync(capture), `adapter must record stdin: ${result.stderr}`);
  return {
    ...result,
    stdin: fs.readFileSync(capture),
    mode: fs.readFileSync(`${capture}.mode`, 'utf8'),
  };
}

function deliver(repo, name, { dryRun = false, exitCode = 0 } = {}) {
  const ledger = path.join(repo, `${name}-ledger.json`);
  const out = path.join(repo, 'output', name);
  return {
    ...invoke(repo, name, process.execPath, [
      'runner/deliver.js', '--feed', 'tests/fixtures/feed-sample',
      '--profile', 'profile.json', '--ledger', ledger, '--out', out,
      '--today', TODAY, ...(dryRun ? ['--dry-run'] : []),
    ], exitCode),
    ledger,
    saved: fs.readFileSync(path.join(out, `digest-${TODAY}-dryrun.json`)),
  };
}

test('dryrun consumes complete stdin before exiting', (t) => {
  const repo = createFixtureRepo(t.after.bind(t));
  const payload = JSON.parse(fs.readFileSync(path.join(repo, GOLDEN_JSON), 'utf8'));
  payload.items[0].title = 'Fixture title '.repeat(100000);
  const input = `${JSON.stringify(payload, null, 2)}\n`;
  const markdownPath = path.join(repo, 'digest.md');
  const markdown = '# Fixture digest\n';
  fs.writeFileSync(markdownPath, markdown);

  for (const dryRun of ['0', '1']) {
    const result = spawnSync(path.join(repo, 'channels', 'dryrun', 'send'), [markdownPath], {
      input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SAITA_FEEDER_DRY_RUN: dryRun },
    });
    assert.ifError(result.error);
    assert.strictEqual(result.signal, null, result.stderr);
    assert.strictEqual(result.status, 0, result.stderr);
    const banner = dryRun === '1'
      ? `--- dryrun channel (SAITA_FEEDER_DRY_RUN=1): would print digest ${markdownPath} ---\n`
      : '';
    assert.strictEqual(result.stdout, `${banner}${markdown}`);
  }
});

test('runner_and_checker_stdin_are_identical', (t) => {
  const repo = createRepo(t);
  const runner = deliver(repo, 'runner');
  const checker = invoke(repo, 'checker', 'bash', ['tools/check-channels.sh']);
  const golden = fs.readFileSync(path.join(repo, GOLDEN_JSON));
  assert.strictEqual(runner.status, 0, runner.stderr);
  assert.strictEqual(checker.status, 0, checker.stderr);
  assert.match(checker.stdout, /check-channels: OK \(1 channel\(s\)\)/);
  assert.strictEqual(checker.mode, '1');
  assert.ok(runner.stdin.equals(checker.stdin), 'runner and checker stdin bytes must match');
  assert.ok(checker.stdin.equals(golden), 'checker stdin must match the golden bytes');
  assert.ok(runner.stdin.equals(golden), 'runner stdin must match the golden bytes');
  assert.ok(runner.stdin.equals(runner.saved), 'stdin must match the saved JSON bytes');
});

test('normal_and_dry_run_use_the_same_stdin', (t) => {
  const repo = createRepo(t);
  const normal = deliver(repo, 'normal');
  const dry = deliver(repo, 'dry', { dryRun: true });
  assert.strictEqual(normal.status, 0, normal.stderr);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.strictEqual(normal.mode, '');
  assert.strictEqual(dry.mode, '1');
  assert.ok(normal.stdin.equals(dry.stdin), 'normal and dry-run stdin bytes must match');
  assert.strictEqual(normal.stdin.at(-1), 0x0a, 'stdin must end with LF');
  assert.notStrictEqual(normal.stdin.at(-2), 0x0a, 'stdin must have exactly one trailing LF');
  assert.ok(dry.stdin.equals(dry.saved), 'dry-run stdin must match the saved JSON bytes');
  assert.ok(!fs.existsSync(dry.ledger), 'dry-run must not create a ledger');
});

test('stdin_preserves_json_and_ledger_semantics', (t) => {
  const repo = createRepo(t);
  const golden = JSON.parse(fs.readFileSync(path.join(repo, GOLDEN_JSON)));
  const originalLedger = Buffer.from('{"ledger_version":1,"entries":{}}\n');
  for (const dryRun of [false, true]) {
    for (const exitCode of [0, 7]) {
      const name = `semantics-${dryRun}-${exitCode}`;
      if (dryRun) fs.writeFileSync(path.join(repo, `${name}-ledger.json`), originalLedger);
      const result = deliver(repo, name, { dryRun, exitCode });
      assert.strictEqual(result.status, exitCode === 0 ? 0 : 2, result.stderr);
      assert.deepStrictEqual(JSON.parse(result.stdin.toString('utf8')), golden);
      assert.ok(result.stdin.includes(Buffer.from('世田谷区', 'utf8')), 'stdin must retain UTF-8 Japanese');
      if (dryRun) {
        assert.deepStrictEqual(fs.readFileSync(result.ledger), originalLedger);
      } else {
        const ledger = JSON.parse(fs.readFileSync(result.ledger));
        assert.strictEqual(ledger.ledger_version, 1);
        assert.deepStrictEqual(Object.keys(ledger.entries).sort(), golden.items.map(({ id }) => id).sort());
        for (const entry of Object.values(ledger.entries)) {
          const channel = entry.channels.dryrun;
          assert.strictEqual(channel.status, exitCode === 0 ? 'sent' : 'failed');
          assert.strictEqual(channel.notified_as, 'new');
          assert.strictEqual(channel.retry_count, 0);
          assert.strictEqual(channel.last_attempt_at, `${TODAY}T00:00:00.000Z`);
          assert.match(channel.last_sent_hash, /^[0-9a-f]{64}$/);
        }
      }
    }
  }
});
