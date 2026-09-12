const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'tools/lib/setup_state.js');
const ASKED_AT = '2026-09-12T00:00:00.000Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-setup-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input/setup-state.json');
  return {
    root, file,
    write(bytes) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    },
    run(command, patch, statePath) {
      const result = spawnSync(process.execPath, [HELPER, command, ...(statePath ? [statePath] : [])], {
        cwd: root, encoding: 'utf8', input: patch, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return result;
    },
  };
}

for (const declined of [false, true]) {
  test(`support_state_survives_restart: declined=${declined}`, (t) => {
    const f = fixture(t);
    const support_prompt = { asked_at: ASKED_AT, declined };
    const saved = f.run('merge', JSON.stringify({ support_prompt }));
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { setup_state_version: 1, support_prompt });
    const restarted = f.run('support-status');
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(restarted.stdout, 'skip\n');
  });
}

test('support_state_unasked_requires_confirmation', (t) => {
  const f = fixture(t);
  for (const bytes of [undefined, '{}', '{"support_prompt":{}}', '{"support_prompt":{"asked_at":""}}']) {
    if (bytes !== undefined) f.write(bytes);
    const result = f.run('support-status');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ask\n');
    if (bytes === undefined) assert.equal(fs.existsSync(f.file), false);
    else assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  }
});

test('support_state_survives_setup_merge', (t) => {
  const f = fixture(t);
  const existing = { support_prompt: { asked_at: ASKED_AT, declined: true }, custom: { locale: 'ja' } };
  assert.equal(f.run('merge', JSON.stringify(existing)).status, 0);
  const consent = { setup_completed_at: ASKED_AT, terms_sha256: 'a'.repeat(64), data_policy_sha256: 'b'.repeat(64) };
  const result = f.run('merge', JSON.stringify(consent));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { setup_state_version: 1, ...existing, ...consent });
  assert.equal(f.run('support-status').stdout, 'skip\n');
});

test('support_merge_preserves_existing_hashes_and_optional_fields', (t) => {
  const f = fixture(t);
  const existing = { setup_state_version: 1, terms_sha256: 'c'.repeat(64), data_policy_sha256: 'd'.repeat(64), custom: [1, null] };
  f.write(JSON.stringify(existing));
  const support_prompt = { asked_at: ASKED_AT, declined: false };
  const result = f.run('merge', JSON.stringify({ support_prompt }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { ...existing, support_prompt });
});

test('support_state_read_error_preserves_file', (t) => {
  const f = fixture(t);
  for (const bytes of [Buffer.from('{"support_prompt":\n'), Buffer.from('null'), Buffer.from('[]')]) {
    f.write(bytes);
    for (const command of ['support-status', 'merge']) {
      const result = f.run(command, '{"terms_sha256":"unchanged"}');
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /setup-state:/);
      assert.equal(result.stdout, '');
      assert.deepEqual(fs.readFileSync(f.file), bytes);
    }
  }
});

test('support_state_io_error_is_not_treated_as_missing', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.file, { recursive: true });
  const sentinel = path.join(f.file, 'keep.txt');
  fs.writeFileSync(sentinel, 'existing data');
  for (const command of ['support-status', 'merge']) {
    const result = f.run(command, '{}');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /setup-state:/);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing data');
  }
});

test('setup_merge_rejects_invalid_patch_without_changing_state', (t) => {
  const f = fixture(t);
  const bytes = '{"support_prompt":{"asked_at":"2026-09-12","declined":false}}\n';
  f.write(bytes);
  for (const patch of ['{', 'null', '[]']) {
    const result = f.run('merge', patch);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /setup-state:/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  }
});

test('setup_state_explicit_path_and_usage', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'separate/state.json');
  assert.equal(f.run('merge', '{"support_prompt":{"asked_at":"2026-09-12"}}', file).status, 0);
  assert.equal(f.run('support-status', undefined, file).stdout, 'skip\n');
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.run('unknown').status, 2);
});

function apiCommands(source) {
  return [...source.replace(/\\\r?\n/g, ' ').matchAll(/\bgh[ \t]+api\b[^`\r\n;&|]*/g)]
    .map(([command]) => command.trim());
}

test('support_api_extraction_checks_each_same_line_call', () => {
  const first = 'gh api --hostname github.com user/starred/saita-kun/saita-kun-feeder';
  const second = 'gh api user/following/HideTsug';
  assert.deepEqual(apiCommands(`\`${first}\` / \`${second}\``), [first, second]);
  assert.deepEqual(apiCommands(`${first} && ${second}`), [first, second]);
});

for (const [doc, count] of [['CLAUDE.md', 4], ['.claude/commands/setup.md', 0], ['README.md', 2], ['README.en.md', 2]]) {
  test(`support_api_commands_pin_hostname: ${doc}`, (t) => {
    const f = fixture(t);
    const commands = apiCommands(fs.readFileSync(path.join(ROOT, doc), 'utf8'));
    assert.equal(commands.length, count, 'all documented API calls must be extracted');
    fs.writeFileSync(path.join(f.root, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
    for (const command of commands) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: f.root, encoding: 'utf8', timeout: 10000,
        env: { PATH: f.root, GH_HOST: 'enterprise.example.invalid' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split('\n');
      assert.equal(args[0], 'api');
      assert.equal(args.filter((arg) => arg === '--hostname').length, 1, command);
      assert.equal(args[args.indexOf('--hostname') + 1], 'github.com', command);
    }
  });
}
