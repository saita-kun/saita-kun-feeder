const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createFixtureRepo } = require('./helpers/fixture-repo');

function setup(t) {
  let cleanup;
  const root = createFixtureRepo((fn) => { cleanup = fn; });
  const jobs = [];
  t.after(async () => {
    for (const job of jobs) fs.writeFileSync(job.go, 'go');
    for (const job of jobs) {
      if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL');
      await job.done;
    }
    cleanup();
  });
  const ledger = path.join(root, 'state', 'notified.json');
  const calls = path.join(root, 'calls.jsonl');
  const feed = path.join(root, 'tests', 'fixtures', 'feed-sample');
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'delivery-profile.sample.json')));
  profile.terms_accepted_sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'TERMS.md'))).digest('hex');
  profile.channels = [{ name: 'fake', enabled: true }];
  const profilePath = path.join(root, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const channel = path.join(root, 'channels', 'fake');
  fs.mkdirSync(channel);
  fs.writeFileSync(path.join(channel, 'channel.json'), JSON.stringify({
    contract_version: 1, name: 'fake', description: 'test-only adapter', requires_env: [],
  }));
  const barrier = `
    fs.writeFileSync(process.env.LOCK_READY, 'ready');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(process.env.LOCK_GO)) {
      if (Date.now() > deadline) throw new Error('barrier timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  `;
  fs.writeFileSync(path.join(channel, 'send'), `#!/usr/bin/env node
    const fs = require('node:fs');
    const digest = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(digest) + '\\n');
    if (process.env.LOCK_PHASE === 'adapter') { ${barrier} }
    process.exit(Number(process.env.LOCK_ADAPTER_EXIT || 0));
  `, { mode: 0o755 });
  const preload = path.join(root, 'barrier.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = function(filename, ...args) {
      if (filename === ${JSON.stringify(path.join(feed, 'meta.json'))} && process.env.LOCK_PHASE === 'feed') {
        ${barrier}
      }
      return read.call(this, filename, ...args);
    };
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (process.env.LOCK_FAIL_SAVE === '1') throw new Error('FEED-23 save failure');
      return rename.call(this, from, to);
    };
  `);
  function start({ target = ledger, phase = '', adapterExit = 0, failSave = false, feedPath = feed } = {}) {
    const id = jobs.length;
    const ready = path.join(root, `ready-${id}`);
    const go = path.join(root, `go-${id}`);
    const child = spawn(process.execPath, ['--require', preload, path.join(root, 'runner', 'deliver.js'),
      '--feed', feedPath, '--profile', profilePath, '--ledger', target,
      '--out', path.join(root, `out-${id}`), '--today', '2026-07-10'], {
      cwd: root,
      env: { ...process.env, SAITA_FEEDER_DRY_RUN: '0', LOCK_READY: ready, LOCK_GO: go,
        LOCK_PHASE: phase, LOCK_ADAPTER_EXIT: String(adapterExit), LOCK_FAIL_SAVE: failSave ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const job = { child, ready, go, output: '' };
    child.stdout.on('data', (data) => { job.output += data; });
    child.stderr.on('data', (data) => { job.output += data; });
    job.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    jobs.push(job);
    return job;
  }
  return { root, ledger, start,
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

async function ready(job) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(job.ready)) {
    assert.equal(job.child.exitCode, null, job.output);
    assert.equal(job.child.signalCode, null, job.output);
    assert.ok(Date.now() < deadline, `marker timeout: ${job.output}`);
    await delay(10);
  }
}

async function finish(job, code) {
  let timeout;
  try {
    const result = await Promise.race([job.done, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`exit timeout: ${job.output}`)), 10000);
    })]);
    assert.equal(result.signal, null, job.output);
    assert.equal(result.code, code, job.output);
  } finally {
    clearTimeout(timeout);
  }
}

function release(job) { fs.writeFileSync(job.go, 'go'); }

async function conflict(setup, target) {
  const before = setup.calls().length;
  const contender = setup.start({ target });
  await finish(contender, 1);
  assert.match(contender.output, /台帳はロックされています/);
  assert.doesNotMatch(contender.output, /feed:/);
  assert.equal(setup.calls().length, before);
  assert.ok(fs.existsSync(`${setup.ledger}.lock`), 'contender must preserve the owner lock');
}

test('FEED-23 serializes the same ledger', async (t) => {
  const s = setup(t);
  const owner = s.start({ phase: 'adapter' });
  await ready(owner);
  await conflict(s, s.ledger);
  release(owner);
  await finish(owner, 0);
  assert.equal(s.calls().length, 1);
  const saved = JSON.parse(fs.readFileSync(s.ledger));
  assert.deepEqual(Object.keys(saved.entries).sort(), ['1001', '1002', '1003']);
  await finish(s.start(), 0);
  assert.equal(s.calls().length, 1, 'saved delivery must not be sent again');
});

test('FEED-23 canonicalizes ledger aliases', async (t) => {
  for (const existing of [false, true]) {
    await t.test(existing ? 'existing ledger' : 'missing ledger and parents', async (t) => {
      const s = setup(t);
      if (existing) {
        fs.mkdirSync(path.dirname(s.ledger));
        fs.writeFileSync(s.ledger, '{"ledger_version":1,"entries":{}}');
      }
      const fileAlias = path.join(s.root, 'ledger-alias.json');
      const dirAlias = path.join(s.root, 'state-alias');
      fs.symlinkSync('state/notified.json', fileAlias);
      fs.symlinkSync('state', dirAlias);
      const owner = s.start({ target: fileAlias, phase: 'adapter' });
      await ready(owner);
      for (const target of [s.ledger, 'state/notified.json', fileAlias, path.join(dirAlias, 'notified.json')]) {
        await conflict(s, target);
      }
      const different = s.start({ target: path.join(s.root, 'other', 'nested', 'ledger.json'), phase: 'adapter' });
      await ready(different);
      assert.equal(s.calls().length, 2, 'both independent adapters must run before either is released');
      assert.deepEqual(s.calls()[0], s.calls()[1]);
      release(different);
      release(owner);
      await finish(different, 0);
      await finish(owner, 0);
      assert.ok(fs.lstatSync(fileAlias).isSymbolicLink(), 'atomic save must preserve ledger alias');
      assert.equal(JSON.parse(fs.readFileSync(fileAlias)).ledger_version, 1);
      await finish(s.start({ target: fileAlias }), 0);
      assert.equal(s.calls().length, 2);
    });
  }
});

for (const mode of ['parent after symlink', 'double symlink', 'missing trailing filename']) {
  test(`P-149 resolves ${mode}`, async (t) => {
    const s = setup(t);
    fs.mkdirSync(path.join(s.root, 'state', 'nested'), { recursive: true });
    fs.symlinkSync('state/nested', path.join(s.root, 'alias'));
    // Keep ".." intact: path.join/resolve would erase the regression input.
    let target = 'alias/../notified.json';
    if (mode === 'double symlink') {
      fs.symlinkSync('alias/..', path.join(s.root, 'outer-alias'));
      target = `${s.root}/outer-alias/notified.json`;
    }
    const existing = mode !== 'missing trailing filename';
    if (existing) await finish(s.start(), 0);
    const before = existing ? fs.readFileSync(s.ledger, 'utf8') : null;
    const owner = s.start({ target, phase: 'feed' });
    await ready(owner);
    assert.ok(fs.existsSync(`${s.ledger}.lock`), 'alias must lock the canonical ledger');
    await conflict(s, s.ledger);
    await conflict(s, target);
    release(owner);
    await finish(owner, 0);
    assert.equal(s.calls().length, 1, 'existing history must prevent redelivery');
    assert.ok(fs.existsSync(s.ledger), 'missing ledger must be created at the canonical path');
    if (existing) assert.equal(fs.readFileSync(s.ledger, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(s.root, 'notified.json')), 'must not create a separate ledger');
    await finish(s.start({ target }), 0);
    await finish(s.start(), 0);
    assert.equal(s.calls().length, 1, 'both paths must reuse the saved history');
    assert.ok(!fs.existsSync(`${s.ledger}.lock`));
  });
}

test('FEED-23 releases owned locks', async (t) => {
  for (const mode of ['success', 'adapter failure', 'feed error', 'ledger error', 'save error']) {
    await t.test(mode, async (t) => {
      const s = setup(t);
      if (mode === 'ledger error') {
        fs.mkdirSync(path.dirname(s.ledger));
        fs.writeFileSync(s.ledger, 'invalid JSON');
      }
      const failed = mode.includes('error');
      await finish(s.start({ adapterExit: mode === 'adapter failure' ? 7 : 0,
        failSave: mode === 'save error', feedPath: mode === 'feed error' ? path.join(s.root, 'missing') : undefined,
      }), failed ? 1 : mode === 'adapter failure' ? 2 : 0);
      assert.ok(!fs.existsSync(`${s.ledger}.lock`));
      if (mode === 'ledger error') fs.unlinkSync(s.ledger);
      await finish(s.start(), 0);
      assert.ok(!fs.existsSync(`${s.ledger}.lock`));
    });
  }
});

test('FEED-23 requires explicit stale recovery', async (t) => {
  const s = setup(t);
  const owner = s.start({ phase: 'feed' });
  await ready(owner);
  assert.equal(s.calls().length, 0, 'pause before any adapter is spawned');
  await conflict(s, s.ledger);
  owner.child.kill('SIGKILL');
  assert.equal((await owner.done).signal, 'SIGKILL');
  const lockPath = `${s.ledger}.lock`;
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  await conflict(s, s.ledger);
  assert.equal(s.calls().length, 0);
  assert.ok(!fs.existsSync(path.join(path.dirname(s.ledger), 'cache')));
  // All runners have exited, no adapters were spawned, and no new run starts until removal.
  fs.rmdirSync(lockPath);
  await finish(s.start(), 0);
  assert.equal(s.calls().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(s.ledger)).ledger_version, 1);
});
