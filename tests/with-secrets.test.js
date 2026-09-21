const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const WRAPPER = path.resolve(__dirname, '../tools/with-secrets.js');
const NAMES = ['P59_SECRET_ONE', 'P59_SECRET_TWO'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-secrets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = path.join(root, 'provider with spaces');
  const child = path.join(root, 'child.js');
  const value = `  fake-${randomBytes(24).toString('hex')}  `;
  fs.writeFileSync(provider, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('calls', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.P59_SECRET_ONE) process.exit(99);
const value = process.env.TEST_VALUE;
process.stderr.write(value);
switch (process.env.TEST_MODE) {
  case 'empty': break;
  case 'newline': process.stdout.write('\\n'); break;
  case 'nonzero': process.stdout.write(value); process.exitCode = 2; break;
  case 'timeout':
    process.stdout.write(value);
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000); break;
  case 'overflow': process.stdout.write(value.repeat(20000)); break;
  case 'nul': process.stdout.write(value + '\\0'); break;
  case 'invalid-utf8': process.stdout.write(Buffer.from([0xff])); break;
  case 'second-fails':
    process.stdout.write(value);
    if (process.argv[2] === 'P59_SECRET_TWO') process.exitCode = 2;
    break;
  default: process.stdout.write(value + '\\r\\n');
}
`, { mode: 0o755 });
  fs.writeFileSync(child, `
const fs = require('node:fs');
const assert = require('node:assert/strict');
fs.writeFileSync('started', 'yes');
const valid = process.env.P59_SECRET_ONE === process.env.TEST_VALUE
  && process.env.P59_SECRET_TWO === process.env.TEST_VALUE;
assert.equal(valid, true);
assert.deepEqual(process.argv.slice(2), JSON.parse(process.env.TEST_ARGS));
assert.equal(process.argv.some(arg => arg.includes(process.env.TEST_VALUE)), false);
process.exitCode = Number(process.env.TEST_STATUS || 0);
`);
  const args = ['space here', '$(touch injected)', '; touch injected', '*', '--env', ''];
  return {
    root, provider, child, value,
    run(overrides = {}, argv) {
      const result = spawnSync(process.execPath, [WRAPPER, ...(argv || [
        '--provider', provider, ...NAMES.flatMap(name => ['--env', name]),
        '--', process.execPath, child, ...args,
      ])], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
          TEST_VALUE: value, TEST_ARGS: JSON.stringify(args), ...overrides },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal((result.stdout + result.stderr).includes(value), false);
      for (const file of fs.readdirSync(root)) {
        assert.equal(fs.readFileSync(path.join(root, file), 'utf8').includes(value), false);
      }
      return result;
    },
  };
}

test('provider_value_reaches_child_env_only', (t) => {
  const f = fixture(t);
  const result = f.run({ P59_SECRET_ONE: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'calls'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)), NAMES.map(name => [name]));
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['calls', 'child.js', 'provider with spaces', 'started']);
});

test('provider_failure_prevents_child_start', async (t) => {
  for (const mode of ['empty', 'newline', 'nonzero', 'timeout', 'overflow', 'nul', 'invalid-utf8', 'second-fails']) {
    await t.test(mode, (t) => {
      const f = fixture(t);
      const result = f.run({ TEST_MODE: mode });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'with-secrets: provider failed; command not started\n');
      assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
    });
  }
});

test('existing_env_skips_provider', (t) => {
  const f = fixture(t);
  const result = f.run(Object.fromEntries(NAMES.map(name => [name, f.value])));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'calls')), false);
});

test('child_status_is_preserved', (t) => {
  const f = fixture(t);
  for (const status of [0, 2, 3]) {
    assert.equal(f.run({ TEST_STATUS: String(status) }).status, status);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
});

test('invalid_cli_and_missing_executables_fail_without_secret_output', (t) => {
  const f = fixture(t);
  for (const argv of [[], ['--provider'], ['--provider', f.provider, '--env', 'BAD=NAME'],
    ['--provider', f.provider, '--env', NAMES[0], process.execPath, f.child],
    ['--provider', f.provider, '--env', NAMES[0], '--'],
    ['--provider', f.provider, '--provider', f.provider, '--env', NAMES[0], '--', process.execPath],
    ['--provider', path.join(f.root, 'missing'), '--env', NAMES[0], '--', process.execPath, f.child],
    ['--provider', f.provider, '--env', NAMES[0], '--', path.join(f.root, 'missing')]]) {
    assert.equal(f.run({}, argv).status, 1);
    assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
  }
});
