const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledgerLib = require('../lib/ledger');
const { loadLedger, saveLedger, recordResult, contentHash, countSentWithin, sentIdsWithin } = ledgerLib;
const { createBudget, remainingBudget, selectWithinBudget } = require('../lib/select');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const NOW_ISO = '2026-07-10T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;
const SPECIAL_IDS = ['__proto__', 'constructor', 'toString'];

function resultFor(subsidy, overrides = {}) {
  return { ok: true, nowIso: NOW_ISO, hash: ledgerLib.contentHash(subsidy), ...overrides };
}

test('FEED-10 special ids survive JSON roundtrip', async (t) => {
  for (const existing of [false, true]) {
    await t.test(existing ? 'append to an existing ledger' : 'create a new ledger', (t) => {
      const root = createFixtureRepo(t.after.bind(t));
      const ledgerPath = path.join(root, 'state', 'notified.json');
      let ledger = ledgerLib.loadLedger(ledgerPath);
      const regular = { id: '1001', title: 'Existing fixture' };
      if (existing) {
        ledgerLib.recordResult(ledger, regular, 'dryrun', resultFor(regular));
        ledgerLib.saveLedger(ledgerPath, ledger);
        ledger = ledgerLib.loadLedger(ledgerPath);
      }

      const subsidies = SPECIAL_IDS.map((id) => ({ id, title: `Fixture ${id}` }));
      for (const subsidy of subsidies) {
        assert.equal(ledgerLib.planCandidate(ledger, subsidy, 'dryrun', NOW_MS).action, 'new');
        ledgerLib.recordResult(ledger, subsidy, 'dryrun', resultFor(subsidy));
        assert.ok(Object.hasOwn(ledger.entries, subsidy.id), `${subsidy.id} must be an own key`);
      }
      ledgerLib.saveLedger(ledgerPath, ledger);
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const loaded = ledgerLib.loadLedger(ledgerPath);
      const expected = existing ? [regular, ...subsidies] : subsidies;
      for (const saved of [ledger, parsed, loaded]) {
        assert.equal(saved.ledger_version, 1);
        assert.deepEqual(Object.keys(saved.entries).sort(), expected.map(({ id }) => id).sort());
        for (const subsidy of expected) {
          assert.ok(Object.hasOwn(saved.entries, subsidy.id));
          assert.ok(Object.hasOwn(saved.entries[subsidy.id].channels, 'dryrun'));
          assert.equal(saved.entries[subsidy.id].channels.dryrun.status, 'sent');
          assert.deepEqual(ledgerLib.planCandidate(saved, subsidy, 'dryrun', NOW_MS + 1), {
            action: 'skip', hash: ledgerLib.contentHash(subsidy),
          });
        }
        assert.equal(ledgerLib.countSentWithin(saved, NOW_MS, 1), expected.length);
      }
    });
  }
});

test('FEED-10 constructor channel remains independent', (t) => {
  const root = createFixtureRepo(t.after.bind(t));
  const ledgerPath = path.join(root, 'state', 'notified.json');
  let ledger = ledgerLib.loadLedger(ledgerPath);
  const original = { id: '1001', title: 'Original fixture' };
  const updated = { ...original, title: 'Updated fixture' };
  ledgerLib.recordResult(ledger, original, 'dryrun', resultFor(original));
  ledgerLib.saveLedger(ledgerPath, ledger);
  ledger = ledgerLib.loadLedger(ledgerPath);
  const ordinaryState = structuredClone(ledger.entries[original.id].channels.dryrun);

  assert.equal(ledgerLib.planCandidate(ledger, updated, 'constructor', NOW_MS).action, 'new');
  ledgerLib.recordResult(ledger, updated, 'constructor', resultFor(updated, { ok: false }));
  ledgerLib.saveLedger(ledgerPath, ledger);
  ledger = ledgerLib.loadLedger(ledgerPath);
  const channels = ledger.entries[original.id].channels;
  assert.deepEqual(Object.keys(channels).sort(), ['constructor', 'dryrun']);
  assert.ok(Object.hasOwn(channels, 'constructor'));
  assert.deepEqual(channels.dryrun, ordinaryState);
  assert.deepEqual(channels.constructor, {
    status: 'failed', last_sent_hash: ledgerLib.contentHash(updated),
    first_notified_at: NOW_ISO, last_attempt_at: NOW_ISO, retry_count: 0, notified_as: 'new',
  });
  const retryMs = NOW_MS + ledgerLib.RETRY_BACKOFF_MS + 1;
  assert.equal(ledgerLib.planCandidate(ledger, original, 'dryrun', retryMs).action, 'skip');
  assert.equal(ledgerLib.planCandidate(ledger, updated, 'dryrun', retryMs).action, 'updated');
  assert.equal(ledgerLib.planCandidate(ledger, updated, 'constructor', retryMs).action, 'retry');
  ledgerLib.recordResult(ledger, updated, 'constructor', resultFor(updated, {
    nowIso: new Date(retryMs).toISOString(),
  }));
  ledgerLib.saveLedger(ledgerPath, ledger);
  ledger = ledgerLib.loadLedger(ledgerPath);
  assert.deepEqual(ledger.entries[original.id].channels.dryrun, ordinaryState);
  assert.deepEqual(ledger.entries[original.id].channels.constructor, {
    status: 'sent', last_sent_hash: ledgerLib.contentHash(updated),
    first_notified_at: NOW_ISO, last_attempt_at: new Date(retryMs).toISOString(),
    retry_count: 0, notified_as: 'new',
  });
  assert.equal(ledgerLib.planCandidate(ledger, updated, 'constructor', retryMs).action, 'skip');
});

test('FEED-10 inherited keys are not entries', async (t) => {
  for (const inheritedLevel of ['entries', 'channels']) {
    await t.test(`ignore inherited ${inheritedLevel}`, () => {
      const subsidy = { id: '1001', title: 'Ordinary fixture' };
      const inheritedState = {
        status: 'failed', last_sent_hash: ledgerLib.contentHash(subsidy),
        first_notified_at: '2026-07-01T00:00:00.000Z',
        last_attempt_at: '2026-07-01T00:00:00.000Z', retry_count: 2, notified_as: 'updated',
      };
      const inheritedEntry = { channels: { dryrun: inheritedState } };
      const before = structuredClone(inheritedEntry);
      const entries = inheritedLevel === 'entries'
        ? Object.create({ [subsidy.id]: inheritedEntry })
        : { [subsidy.id]: { channels: Object.create({ dryrun: inheritedState }) } };
      const ledger = { ledger_version: 1, entries };

      assert.equal(ledgerLib.planCandidate(ledger, subsidy, 'dryrun', NOW_MS).action, 'new');
      ledgerLib.recordResult(ledger, subsidy, 'dryrun', resultFor(subsidy, { ok: false }));
      assert.ok(Object.hasOwn(ledger.entries, subsidy.id));
      assert.ok(Object.hasOwn(ledger.entries[subsidy.id].channels, 'dryrun'));
      assert.deepEqual(inheritedEntry, before, 'inherited history must remain unchanged');
      assert.deepEqual(ledger.entries[subsidy.id].channels.dryrun, {
        status: 'failed', last_sent_hash: ledgerLib.contentHash(subsidy),
        first_notified_at: NOW_ISO, last_attempt_at: NOW_ISO, retry_count: 0, notified_as: 'new',
      });
      assert.equal(ledgerLib.planCandidate(ledger, subsidy, 'dryrun',
        NOW_MS + ledgerLib.RETRY_BACKOFF_MS).action, 'skip');

      let attemptMs = NOW_MS;
      for (let count = 1; count <= ledgerLib.MAX_RETRY_COUNT; count += 1) {
        attemptMs += ledgerLib.RETRY_BACKOFF_MS + 1;
        assert.equal(ledgerLib.planCandidate(ledger, subsidy, 'dryrun', attemptMs).action, 'retry');
        ledgerLib.recordResult(ledger, subsidy, 'dryrun', resultFor(subsidy, {
          ok: false, nowIso: new Date(attemptMs).toISOString(),
        }));
        assert.equal(ledger.entries[subsidy.id].channels.dryrun.retry_count, count);
        assert.equal(ledger.entries[subsidy.id].channels.dryrun.notified_as, 'new');
      }
      assert.equal(ledgerLib.planCandidate(ledger, subsidy, 'dryrun',
        attemptMs + ledgerLib.RETRY_BACKOFF_MS + 1).action, 'skip');

      const updated = { ...subsidy, title: 'Updated ordinary fixture' };
      assert.equal(ledgerLib.planCandidate(ledger, updated, 'dryrun', attemptMs).action, 'updated');
      ledgerLib.recordResult(ledger, updated, 'dryrun', resultFor(updated, {
        nowIso: new Date(attemptMs).toISOString(), notifiedAs: 'updated',
      }));
      assert.equal(ledgerLib.planCandidate(ledger, updated, 'dryrun', attemptMs).action, 'skip');
      assert.equal(ledger.entries[subsidy.id].channels.dryrun.retry_count, 0);
      assert.equal(ledger.entries[subsidy.id].channels.dryrun.first_notified_at, NOW_ISO);
      assert.equal(ledger.entries[subsidy.id].channels.dryrun.notified_as, 'updated');
      assert.deepEqual(inheritedEntry, before);
    });
  }
});

function ledgerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = { ledger_version: 1, entries: {} };
  const subsidy = { id: '1001', title: 'Fixture subsidy' };
  recordResult(ledger, subsidy, 'fixture', {
    ok: true, nowIso: '2026-07-10T00:00:00.000Z', hash: contentHash(subsidy), notifiedAs: 'new',
  });
  return { dir, ledger };
}

test('FEED-11 atomic ledger replacement', async (t) => {
  for (const failure of ['partial write', 'rename']) {
    await t.test(`${failure} preserves the previous JSON and removes the temporary file`, (t) => {
      const { dir, ledger } = ledgerFixture(t);
      const destination = path.join(dir, 'ledger.json');
      const original = Buffer.from(`${JSON.stringify(ledger, null, 4)}\n`);
      fs.writeFileSync(destination, original);
      const next = loadLedger(destination);
      next.entries['1001'].channels.fixture.status = 'failed';
      const error = new Error(`FEED-11 ${failure} failure`);

      if (failure === 'partial write') {
        const write = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (file, data, options) => {
          write(file, data.slice(0, 12), options);
          throw error;
        });
      } else {
        t.mock.method(fs, 'renameSync', () => { throw error; });
      }

      assert.throws(() => saveLedger(destination, next), (caught) => caught === error);
      assert.ok(fs.readFileSync(destination).equals(original), 'previous ledger bytes must remain unchanged');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), ledger);
      assert.deepStrictEqual(fs.readdirSync(dir), ['ledger.json']);
    });
  }
});

test('ledger creation and replacement use unique temporary files in the destination directory', (t) => {
  const { dir, ledger } = ledgerFixture(t);
  const destination = path.join(dir, 'state', 'ledger.json');
  const rename = fs.renameSync;
  const temporaryPaths = [];
  let previous;
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.strictEqual(to, destination);
    assert.strictEqual(path.dirname(from), path.dirname(destination));
    assert.notStrictEqual(from, destination);
    assert.ok(!temporaryPaths.includes(from));
    temporaryPaths.push(from);
    if (previous) assert.deepStrictEqual(fs.readFileSync(destination), previous);
    else assert.ok(!fs.existsSync(destination));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(from, 'utf8')), ledger);
    return rename(from, to);
  });

  for (const status of ['sent', 'failed']) {
    ledger.entries['1001'].channels.fixture.status = status;
    saveLedger(destination, ledger);
    previous = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
    assert.deepStrictEqual(fs.readFileSync(destination), previous);
    assert.deepStrictEqual(loadLedger(destination), ledger);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(destination)), ['ledger.json']);
  }
  assert.strictEqual(temporaryPaths.length, 2);
});

function deliveryHistory(records) {
  const ledger = { ledger_version: 1, entries: {} };
  for (const [id, channel, nowIso, ok = true] of records) {
    const subsidy = { id, title: 'Fixture subsidy' };
    recordResult(ledger, subsidy, channel, { ok, nowIso, hash: contentHash(subsidy), notifiedAs: 'new' });
  }
  return ledger;
}

test('delivery budget counts unique successful IDs within inclusive time windows', () => {
  const ledger = deliveryHistory([
    ['now', 'a', NOW_ISO],
    ['now', 'b', NOW_ISO],
    ['day-edge', 'a', '2026-07-09T00:00:00.000Z'],
    ['before-day', 'a', '2026-07-08T23:59:59.999Z'],
    ['week-edge', 'a', '2026-07-03T00:00:00.000Z'],
    ['before-week', 'a', '2026-07-02T23:59:59.999Z'],
    ['future', 'a', '2026-07-10T00:00:00.001Z'],
    ['failed', 'a', NOW_ISO, false],
  ]);
  assert.deepStrictEqual([...sentIdsWithin(ledger, NOW_MS, DAY_MS)].sort(), ['day-edge', 'now']);
  assert.strictEqual(countSentWithin(ledger, NOW_MS, DAY_MS), 2);
  assert.deepStrictEqual([...sentIdsWithin(ledger, NOW_MS, 7 * DAY_MS)].sort(),
    ['before-day', 'day-edge', 'now', 'week-edge']);
  assert.strictEqual(countSentWithin(ledger, NOW_MS, 7 * DAY_MS), 4);
  assert.strictEqual(remainingBudget(ledger, NOW_MS, { dailyCap: 3, weeklyCap: 5 }), 1);
});

test('delivery budget shares counted IDs across channels and limits new candidates', () => {
  const ledger = deliveryHistory(['2', '3'].flatMap((id) =>
    ['a', 'b'].map((channel) => [id, channel, NOW_ISO])));
  const limits = { dailyCap: 3, weeklyCap: 3 };
  assert.strictEqual(remainingBudget(ledger, NOW_MS, limits), 1);
  const before = JSON.stringify(ledger);
  const budget = createBudget(ledger, NOW_MS, limits);
  const first = selectWithinBudget(['4', '3', '2', '1'].map((id) => ({ id })), budget);
  assert.deepStrictEqual(first.selected.map((item) => item.id), ['1', '2', '3']);
  assert.strictEqual(first.dropped, 1);
  const second = selectWithinBudget(['0', '1', '3', '5'].map((id) => ({ id })), budget);
  assert.deepStrictEqual(second.selected.map((item) => item.id), ['1', '3']);
  assert.strictEqual(second.dropped, 2);
  assert.strictEqual(JSON.stringify(ledger), before, 'selection must not change persisted send results');
});

test('delivery budget charges daily capacity for IDs counted only in the weekly window', () => {
  const ledger = deliveryHistory(['1', '2', '3'].map((id) =>
    [id, 'a', '2026-07-08T23:59:59.999Z']));
  const limits = { dailyCap: 2, weeklyCap: 3 };
  assert.strictEqual(remainingBudget(ledger, NOW_MS, limits), 0);
  const budget = createBudget(ledger, NOW_MS, limits);
  const result = selectWithinBudget(['0', '1', '2', '3'].map((id) => ({ id })), budget);
  assert.deepStrictEqual(result.selected.map((item) => item.id), ['1', '2']);
  assert.strictEqual(result.dropped, 2);
});

test('delivery selection preserves numeric budget behavior', () => {
  const candidates = ['3', '1', '2'].map((id) => ({ id }));
  assert.deepStrictEqual(selectWithinBudget(candidates, 2), {
    selected: [{ id: '1' }, { id: '2' }], dropped: 1,
  });
  assert.deepStrictEqual(selectWithinBudget(candidates, 0), { selected: [], dropped: 3 });
});
