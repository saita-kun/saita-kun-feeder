const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const INITIAL_LEDGER = '{"ledger_version":1,"entries":{}}\n';

function createRunner(t) {
  const root = createFixtureRepo(t.after.bind(t));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'profile/delivery-profile.sample.json')));
  profile.terms_accepted_sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'TERMS.md'))).digest('hex');
  profile.feed_base_url = 'https://feed.example.test/v1';
  profile.channels = [{ name: 'args-test', enabled: true }];
  const profilePath = path.join(work, 'profile.json');
  for (const file of [profilePath, path.join(root, 'profile/delivery-profile.json')]) {
    fs.writeFileSync(file, JSON.stringify(profile));
  }
  const ledgers = [path.join(work, 'ledger.json'), path.join(root, 'state/notified.json')];
  for (const file of ledgers) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, INITIAL_LEDGER);
  }

  // Observe acquisition and ledger saves inside the child process; feed data stays local.
  fs.writeFileSync(path.join(root, 'observe.cjs'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const feed = require('./lib/feed-client');",
    "const ledger = require('./lib/ledger');",
    'function record(event) {',
    "  fs.appendFileSync(path.join(__dirname, 'effects.jsonl'), JSON.stringify(event) + '\\n');",
    '}',
    'feed.loadFeed = async ({ baseUrl }) => {',
    "  record({ kind: 'feed', baseUrl });",
    "  const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'tests/fixtures/feed-sample', name)));",
    "  return { meta: read('meta.json'), data: read('subsidies.json'), source: 'fixture', warnings: [] };",
    '};',
    'const save = ledger.saveLedger;',
    'ledger.saveLedger = (...args) => {',
    "  record({ kind: 'ledger-write', path: args[0] });",
    '  return save(...args);',
    '};',
    '',
  ].join('\n'));

  const channel = path.join(root, 'channels', 'args-test');
  fs.mkdirSync(channel);
  fs.writeFileSync(path.join(channel, 'channel.json'), JSON.stringify({
    contract_version: 1, name: 'args-test', description: 'Records fixture delivery', requires_env: [],
  }));
  fs.writeFileSync(path.join(channel, 'send'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const digest = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'const event = {',
    "  kind: 'adapter', dryRun: process.env.SAITA_FEEDER_DRY_RUN || '',",
    '  date: digest.date, itemCount: digest.items.length, markdown: process.argv[2],',
    '};',
    "fs.appendFileSync(path.join(__dirname, '../../effects.jsonl'), JSON.stringify(event) + '\\n');",
    '',
  ].join('\n'), { mode: 0o755 });

  return {
    root, ledgers,
    options: {
      '--feed': profile.feed_base_url,
      '--profile': profilePath,
      '--ledger': ledgers[0],
      '--today': '2026-07-10',
      '--out': path.join(work, 'output'),
    },
  };
}

function run(fixture, args) {
  const result = spawnSync(process.execPath, [
    '--require', path.join(fixture.root, 'observe.cjs'),
    path.join(fixture.root, 'runner/deliver.js'), ...args,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      NODE_OPTIONS: '',
      SAITA_FEEDER_DRY_RUN: '',
    },
  });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null, result.stderr);
  const effectsPath = path.join(fixture.root, 'effects.jsonl');
  const effects = fs.existsSync(effectsPath)
    ? fs.readFileSync(effectsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { ...result, effects };
}

function assertLedgersUnchanged(fixture) {
  for (const file of fixture.ledgers) {
    assert.strictEqual(fs.readFileSync(file, 'utf8'), INITIAL_LEDGER);
  }
}

function assertRejected(fixture, args, option) {
  const result = run(fixture, args);
  assert.strictEqual(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`エラー: ${option} `));
  assert.strictEqual(result.stdout, '');
  assert.deepStrictEqual(result.effects, [], 'acquisition, adapter calls and ledger writes must be zero');
  assertLedgersUnchanged(fixture);
  for (const out of [fixture.options['--out'], path.join(fixture.root, 'output')]) {
    assert.ok(!fs.existsSync(out), 'invalid arguments must not create output');
  }
}

test('FEED-07 rejects missing option values', async (t) => {
  for (const option of ['--feed', '--profile', '--ledger', '--today', '--out']) {
    for (const [name, values] of [
      ['missing', []], ['empty', ['']], ['dry-run follows', ['--dry-run']],
      ['value option follows', ['--today', '2026-07-10']], ['unknown option follows', ['--unknown']],
    ]) {
      await t.test(`${option}: ${name}`, (t) => {
        const fixture = createRunner(t);
        const validArgs = Object.entries(fixture.options).filter(([key]) => key !== option).flat();
        assertRejected(fixture, [...validArgs, option, ...values], option);
      });
    }
  }
});

test('FEED-07 rejects nonexistent calendar dates', async (t) => {
  for (const today of ['2026-02-30', '2026-13-01', '1900-02-29', '2026-04-31', '2026-01-00']) {
    await t.test(today, (t) => {
      const fixture = createRunner(t);
      fixture.options['--today'] = today;
      assertRejected(fixture, Object.entries(fixture.options).flat(), '--today');
    });
  }
});

test('FEED-07 accepts valid leap dates', async (t) => {
  for (const today of ['2024-02-29', '2000-02-29']) {
    for (const dryRunFirst of [false, true]) {
      await t.test(`${today}: dry-run ${dryRunFirst ? 'first' : 'last'}`, (t) => {
        const fixture = createRunner(t);
        fixture.options['--today'] = today;
        const values = Object.entries(fixture.options).flat();
        const result = run(fixture, dryRunFirst ? ['--dry-run', ...values] : [...values, '--dry-run']);
        assert.strictEqual(result.status, 0, result.stderr);
        const base = path.join(fixture.options['--out'], `digest-${today}-args-test`);
        assert.deepStrictEqual(result.effects, [
          { kind: 'feed', baseUrl: fixture.options['--feed'] },
          { kind: 'adapter', dryRun: '1', date: today, itemCount: 3, markdown: `${base}.md` },
        ]);
        assert.strictEqual(JSON.parse(fs.readFileSync(`${base}.json`)).date, today);
        assert.ok(fs.readFileSync(`${base}.md`, 'utf8').startsWith(`# 補助金マッチダイジェスト ${today}\n`));
        assertLedgersUnchanged(fixture);
      });
    }
  }
});

test('FEED-07 observes fixture delivery effects', (t) => {
  const fixture = createRunner(t);
  const result = run(fixture, Object.entries(fixture.options).flat());
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.effects.map(({ kind }) => kind), ['feed', 'adapter', 'ledger-write']);
  assert.strictEqual(result.effects[1].dryRun, '0');
  assert.strictEqual(result.effects[2].path, fixture.ledgers[0]);
  assert.notStrictEqual(fs.readFileSync(fixture.ledgers[0], 'utf8'), INITIAL_LEDGER);
});
