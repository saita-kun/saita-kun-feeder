const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const SOURCE_ROOT = path.resolve(__dirname, '..');

function createSource(t) {
  const root = createFixtureRepo(t.after.bind(t));
  // Copy only the E2E entry point, so child runners cannot recurse into this test.
  for (const relative of ['tests/e2e-deliver.test.js', 'tests/helpers/fixture-repo.js']) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, relative), destination);
  }
  for (const [index, name] of ['e2e-a', 'e2e-b', 'e2e-dry', 'e2e-fail'].entries()) {
    const channel = path.join(root, 'channels', name);
    fs.mkdirSync(path.join(channel, 'existing'), { recursive: true });
    fs.writeFileSync(path.join(channel, 'channel.json'), JSON.stringify({
      contract_version: 1, name, description: `Preserved ${name}`, requires_env: [],
    }));
    const send = path.join(channel, 'send');
    fs.writeFileSync(send, `#!/usr/bin/env bash\n# Preserved ${name}\nexit 0\n`);
    fs.chmodSync(send, index % 2 === 0 ? 0o755 : 0o644);
    fs.writeFileSync(path.join(channel, 'existing', 'identity.txt'), `${name}\n`);
  }
  fs.mkdirSync(path.join(root, 'runs'));
  fs.writeFileSync(path.join(root, 'runs', 'keep.txt'), 'Outside each E2E run root\n');
  return root;
}

function snapshotTree(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = path.join(relative, entry.name);
      const file = path.join(root, name);
      const executable = fs.statSync(file).mode & 0o111;
      if (entry.isDirectory()) {
        return [{ name, executable }, ...snapshotTree(root, name)];
      }
      assert.ok(entry.isFile(), `fixture entry must be a regular file: ${name}`);
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return [{ name, executable, sha256 }];
    });
}

function runE2E(root, fail = false) {
  const temporary = path.join(root, 'runs');
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    FEEDER_E2E_TEST_FAILURE: fail ? '1' : '0',
  };
  // Start an independent test runner with TAP output.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--test', '--test-reporter=tap', 'tests/e2e-deliver.test.js',
    ], { cwd: root, env, timeout: 30000 });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { error = err; });
    child.on('close', (code, signal) => resolve({ code, signal, error, stdout, stderr }));
  });
}

function assertSuccessful(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null, output);
  assert.strictEqual(result.code, 0, output);
  assert.match(result.stdout, /ok \d+ - E2E\(1\) first run: digest is byte-identical to golden/);
  assert.match(result.stdout, /# fail 0\b/);
}

test('FEED-19 parallel isolation', async (t) => {
  const root = createSource(t);
  const before = snapshotTree(root);
  const results = await Promise.all([runE2E(root), runE2E(root)]);
  for (const result of results) assertSuccessful(result);
  assert.deepStrictEqual(snapshotTree(root), before,
    'source paths, SHA-256 hashes and executable bits must remain unchanged');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), ['keep.txt'],
    'both run roots must be removed while their parent and existing files remain');
});

test('FEED-19 cleanup after failure', async (t) => {
  const root = createSource(t);
  const suitePath = path.join(root, 'tests', 'e2e-deliver.test.js');
  const suite = fs.readFileSync(suitePath, 'utf8');
  const anchor = '  fs.chmodSync(sendPath, 0o755);';
  assert.ok(suite.includes(anchor), 'failure must be injected after channel creation');
  // Fail an E2E assertion midway through the copied suite, after files exist.
  fs.writeFileSync(suitePath, suite.replace(anchor, `${anchor}
  if (name === 'e2e-b' && process.env.FEEDER_E2E_TEST_FAILURE === '1') {
    assert.fail('FEED-19 injected test failure');
  }`));
  const before = snapshotTree(root);
  const [failed, successful] = await Promise.all([runE2E(root, true), runE2E(root)]);
  const output = `${failed.stdout}\n${failed.stderr}`;
  assert.ifError(failed.error);
  assert.strictEqual(failed.signal, null, output);
  assert.strictEqual(failed.code, 1, output);
  assert.match(failed.stdout, /not ok \d+ - channel-local hashes:/);
  assert.match(failed.stdout, /FEED-19 injected test failure/);
  assert.match(failed.stdout, /ok \d+ - failing channel:/);
  assert.match(failed.stdout, /# fail 1\b/);
  assertSuccessful(successful);
  assert.deepStrictEqual(snapshotTree(root), before,
    'a failed E2E test must preserve source files and the other run');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), ['keep.txt'],
    'failed and successful run roots must both be removed');
});
