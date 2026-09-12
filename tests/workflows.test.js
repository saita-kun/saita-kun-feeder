const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VALID = `name: fixture
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo fixture
`;
const INVALID = [
  ['indentation', VALID.replace('    steps:', '   steps:'), /could not parse as YAML:.*\[syntax-check\]/],
  ['actions-key', VALID.replace('runs-on:', 'runs_on:'), /unexpected key "runs_on"/],
];

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-workflows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fixtureRepo(t) {
  const root = temporary(t);
  for (const dir of ['tools', 'bin', '.github/workflows']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const name of ['validate.sh', 'check-workflows.sh']) {
    fs.copyFileSync(path.join(ROOT, 'tools', name), path.join(root, 'tools', name));
  }
  fs.writeFileSync(path.join(root, '.github/workflows/valid.yml'), VALID);
  fs.writeFileSync(path.join(root, '.github/workflows/also valid.yaml'), VALID);
  return root;
}

test('FEED-28 rejects malformed workflows', async (t) => {
  const version = run('actionlint', ['-version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.split('\n')[0], '1.7.12');
  for (const [name, source, diagnostic] of [['valid', VALID, null], ...INVALID]) {
    await t.test(name, () => {
      const dir = temporary(t);
      const file = path.join(dir, 'fixture.yml');
      fs.writeFileSync(file, source);
      const result = run('actionlint', ['-shellcheck=', '-pyflakes=', file]);
      assert.equal(result.status, diagnostic ? 1 : 0, result.stdout + result.stderr);
      if (diagnostic) assert.match(result.stdout + result.stderr, diagnostic);
      const checked = run('bash', [path.join(ROOT, 'tools/check-workflows.sh'), dir]);
      assert.equal(checked.status, result.status, checked.stdout + checked.stderr);
      if (diagnostic) {
        assert.match(checked.stdout + checked.stderr, diagnostic);
        assert.doesNotMatch(checked.stdout, /check-workflows: OK/);
      } else {
        assert.match(checked.stdout, /check-workflows: OK/);
      }
    });
  }
});

test('FEED-28 propagates checker failures', async (t) => {
  for (const scenario of ['valid', 'missing-cli', 'wrong-version', 'version-error', 'syntax-error']) {
    await t.test(scenario, () => {
      const root = fixtureRepo(t);
      const bin = path.join(root, 'bin');
      // Keep every other aggregate step successful, including the child test runner.
      for (const name of ['check-feed-contract', 'check-profile', 'check-channels', 'check-ledger']) {
        script(path.join(root, 'tools', `${name}.sh`), 'exit 0');
      }
      for (const name of ['python3', 'node']) {
        script(path.join(bin, name), 'exit 0');
      }
      for (const name of ['bash', 'dirname']) {
        const executable = run('/bin/bash', ['-c', `command -v ${name}`]).stdout.trim();
        fs.symlinkSync(executable, path.join(bin, name));
      }
      if (scenario !== 'missing-cli') {
        script(path.join(bin, 'actionlint'), `
if [ "$1" = "-version" ]; then
  echo ${scenario === 'wrong-version' ? '1.7.11' : '1.7.12'}
  exit ${scenario === 'version-error' ? 1 : 0}
fi
printf '%s\\n' "$@" > "$WORKFLOW_ARGS"
exit ${scenario === 'syntax-error' ? 1 : 0}`);
      }
      const argsFile = path.join(root, 'args.txt');
      const options = { cwd: root, env: { ...process.env, PATH: bin, WORKFLOW_ARGS: argsFile } };
      const checked = run('/bin/bash', ['tools/check-workflows.sh'], options);
      const result = run('/bin/bash', ['tools/validate.sh'], options);
      const valid = scenario === 'valid';
      assert.equal(checked.status, valid ? 0 : 1, checked.stdout + checked.stderr);
      assert.equal(result.status, valid ? 0 : 1, result.stdout + result.stderr);
      assert.match(result.stdout, valid ? /validate: OK/ : /validate: FAIL/);
      assert.doesNotMatch(result.stdout, valid ? /validate: FAIL/ : /validate: OK/);
      if (!valid) assert.match(result.stdout, /== FAIL: check-workflows/);
      const failedSteps = result.stdout.match(/^== FAIL: .+$/gm) || [];
      assert.deepEqual(failedSteps, valid ? [] : ['== FAIL: check-workflows']);
      assert.match(result.stdout, /^== node --test$/m);
      if (['missing-cli', 'wrong-version', 'version-error'].includes(scenario)) {
        assert.match(checked.stderr, /actionlint.*1\.7\.12/);
        assert.match(result.stderr, /actionlint.*1\.7\.12/);
        assert.equal(fs.existsSync(argsFile), false);
      } else {
        const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
        assert.deepEqual(args.slice(0, 2), ['-shellcheck=', '-pyflakes=']);
        assert.deepEqual(args.slice(2).map((file) => path.basename(file)).sort(),
          ['also valid.yaml', 'valid.yml']);
      }
    });
  }
});

test('FEED-28 rejects incomplete installer downloads before extraction', async (t) => {
  for (const scenario of ['download-error', 'checksum-mismatch']) {
    await t.test(scenario, (t) => {
      const root = temporary(t);
      const bin = path.join(root, 'bin');
      const dest = path.join(root, 'installed');
      const downloads = path.join(root, 'downloads');
      for (const dir of [bin, dest, downloads]) fs.mkdirSync(dir);
      const existing = path.join(dest, 'actionlint');
      fs.writeFileSync(existing, 'preserved install\n');
      script(path.join(bin, 'curl'), scenario === 'download-error' ? 'exit 22' : `
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    printf 'incomplete archive\\n' > "$1"
    exit 0
  fi
  shift
done
exit 2`);
      script(path.join(bin, 'tar'), 'touch "$EXTRACT_MARKER"');
      const marker = path.join(root, 'extracted');
      const result = run('bash', [path.join(ROOT, 'tools/install-actionlint.sh'), dest], {
        env: { ...process.env,
          PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
          TMPDIR: downloads, EXTRACT_MARKER: marker },
      });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      if (scenario === 'checksum-mismatch') assert.match(result.stderr, /SHA-256 mismatch/);
      assert.doesNotMatch(result.stdout, /install-actionlint: OK/);
      assert.equal(fs.existsSync(marker), false, 'unverified archives must not be extracted');
      assert.equal(fs.readFileSync(existing, 'utf8'), 'preserved install\n');
      assert.deepEqual(fs.readdirSync(downloads), [], 'temporary downloads must be removed');
    });
  }
});

test('FEED-28 checks all repository workflows', () => {
  for (const cwd of [ROOT, os.tmpdir()]) {
    const result = run('bash', [path.join(ROOT, 'tools/check-workflows.sh')], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /check-workflows: OK/);
  }
});

test('FEED-28 distributes the workflow gate and regression tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  for (const file of ['tools/install-actionlint.sh', 'tools/check-workflows.sh', 'tests/workflows.test.js']) {
    assert.ok(manifest.core_paths.includes(file), file);
  }
});
