const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = 'state/notified.json';

function fixture(t, realGit = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-local-delivery-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo with spaces');
  const bin = path.join(base, 'bin');
  for (const dir of ['tools', 'state']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(ROOT, 'tools/run-local-delivery.sh'), path.join(repo, 'tools/run-local-delivery.sh'));
  fs.writeFileSync(path.join(repo, LEDGER), '{"ledger_version":1,"entries":{}}\n');
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/usr/bin/env bash',
    'printf "node\\n" >> "$FEEDER_CALLS"',
    'printf "%s\\0" "$@" >> "$FEEDER_ARGS"',
    'pwd -P > "$FEEDER_CWD"',
    'echo "runner output"',
    'echo "runner diagnostic" >&2',
    'if [ "${FEEDER_LEDGER_CHANGE:-0}" = 1 ]; then printf "\\n" >> state/notified.json; fi',
    'exit "${FEEDER_RUNNER_STATUS:-0}"',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/usr/bin/env bash',
    'printf "git:%s\\n" "$1" >> "$FEEDER_CALLS"',
    'if [ "$FEEDER_REAL_GIT" = 1 ]; then PATH="$FEEDER_ORIGINAL_PATH" exec git "$@"; fi',
    'case "$1" in',
    '  add) exit "${FEEDER_ADD_STATUS:-0}" ;;',
    '  diff) exit "${FEEDER_DIFF_STATUS:-1}" ;;',
    '  commit) exit "${FEEDER_COMMIT_STATUS:-0}" ;;',
    '  *) exit 99 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, TZ: 'JST-9',
    FEEDER_ORIGINAL_PATH: process.env.PATH, FEEDER_REAL_GIT: realGit ? '1' : '0',
    FEEDER_CALLS: path.join(base, 'calls'), FEEDER_ARGS: path.join(base, 'args'),
    FEEDER_CWD: path.join(base, 'cwd'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  return {
    repo, git,
    run(args = [], overrides = {}) {
      fs.writeFileSync(env.FEEDER_CALLS, '');
      fs.writeFileSync(env.FEEDER_ARGS, '');
      const result = spawnSync('bash', [path.join(repo, 'tools/run-local-delivery.sh'), ...args], {
        cwd: base, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return { ...result,
        calls: fs.readFileSync(env.FEEDER_CALLS, 'utf8').trim().split('\n').filter(Boolean),
        args: fs.readFileSync(env.FEEDER_ARGS, 'utf8').split('\0').slice(0, -1),
        cwd: fs.existsSync(env.FEEDER_CWD) ? fs.readFileSync(env.FEEDER_CWD, 'utf8').trim() : null,
      };
    },
  };
}

test('cron_exit_status_matrix', async (t) => {
  for (const runner of [0, 1, 2, 127]) {
    for (const failure of ['none', 'add', 'diff', 'commit']) {
      await t.test(`runner ${runner}, save ${failure}`, (t) => {
        const overrides = { FEEDER_RUNNER_STATUS: String(runner) };
        if (failure !== 'none') overrides[`FEEDER_${failure.toUpperCase()}_STATUS`] = '128';
        const result = fixture(t).run([], overrides);
        assert.equal(result.status, runner || (failure === 'none' ? 0 : 3), result.stderr);
        const expected = ['node', 'git:add'];
        if (failure !== 'add') expected.push('git:diff');
        if (!['add', 'diff'].includes(failure)) expected.push('git:commit');
        assert.deepEqual(result.calls, expected);
        if (failure !== 'none') assert.match(result.stderr, /ledger.*failed/i);
      });
    }
  }
});

test('cron_no_ledger_change_is_success', (t) => {
  const result = fixture(t).run([], { FEEDER_DIFF_STATUS: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['node', 'git:add', 'git:diff']);
});

test('cron_commits_only_delivery_ledger', (t) => {
  const f = fixture(t, true);
  f.git('init', '--quiet', '--template=');
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'initial\n');
  f.git('add', '--', LEDGER, 'other.txt');
  f.git('commit', '--quiet', '-m', 'fixture baseline');
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'staged\n');
  f.git('add', '--', 'other.txt');
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'unstaged\n');
  const staged = f.git('diff', '--cached', '--', 'other.txt');
  const result = f.run([], { FEEDER_LEDGER_CHANGE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim(), LEDGER);
  assert.equal(f.git('show', `HEAD:${LEDGER}`), fs.readFileSync(path.join(f.repo, LEDGER), 'utf8'));
  assert.equal(f.git('diff', '--cached', '--', 'other.txt'), staged);
  assert.equal(fs.readFileSync(path.join(f.repo, 'other.txt'), 'utf8'), 'unstaged\n');
  const head = f.git('rev-parse', 'HEAD');
  const unchanged = f.run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.deepEqual(unchanged.calls, ['node', 'git:add', 'git:diff']);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('diff', '--cached', '--', 'other.txt'), staged);
});

test('cron_preserves_runner_arguments', (t) => {
  const f = fixture(t);
  const args = ['--dry-run', '--feed', 'feed with spaces', '--today', '2026-09-12',
    '--profile', 'profile/[sample]*.json', '--out', 'output/日本語\nnext'];
  const result = f.run(args, { FEEDER_RUNNER_STATUS: '2' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(path.resolve(result.cwd, result.args[0]), path.join(fs.realpathSync(f.repo), 'runner/deliver.js'));
  assert.deepEqual(result.args.slice(1), args);
  assert.equal(result.cwd, fs.realpathSync(f.repo));
  assert.equal(result.calls.filter((call) => call === 'node').length, 1);
  assert.match(result.stdout, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0900\nrunner output\n/);
  assert.match(result.stderr, /runner diagnostic/);
});

test('cron_rejects_ledger_before_runner_or_git', async (t) => {
  for (const args of [['--ledger', 'custom.json'], ['--dry-run', '--ledger', LEDGER],
    ['--ledger'], ['--ledger', ''], ['--ledger=custom.json'], ['--ledger=']]) {
    await t.test(JSON.stringify(args), (t) => {
      const result = fixture(t).run(args);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.args, []);
      assert.match(result.stderr, /--ledger/);
      assert.match(result.stderr, /node runner\/deliver\.js/);
    });
  }
});
