const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ledgerLib = require('../lib/ledger');
const { createFixtureRepo } = require('./helpers/fixture-repo');

const NOW_ISO = '2026-07-10T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
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
