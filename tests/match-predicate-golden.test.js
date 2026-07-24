// tests/match-predicate-golden.test.js — 述語 golden fixtures ランナー（A16 Phase 1 / G2）
//
// tests/fixtures/match-predicate-golden/*.json を走査し、各 fixture を
// isSubsidyMatchingUser に投入して expected と突合する。1 fixture = 1 subtest
// （fixture 追加時にテスト増が自動）。
//
// fixtures は「JS の現挙動 = 正」を固定する golden 記録。jq 経路（退役済み）との
// divergence 8 系統は各ファイルの axis 注記を参照。JS 側の仕様変更でこのテストが
// 落ちた場合、それは述語セマンティクスの変更 = 設計レビュー対象である。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isSubsidyMatchingUser } = require('../lib/match-user-subsidy');

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'match-predicate-golden');

function loadGoldenFiles() {
  return fs.readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: f,
      doc: JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf8')),
    }));
}

function buildCase(doc, fixture) {
  const user = { ...doc.base_user, ...fixture.user };
  const subsidy = { ...doc.base_subsidy, ...fixture.subsidy };
  const opts = { ...fixture.opts };
  if (typeof opts.today === 'string') opts.today = new Date(`${opts.today}T00:00:00Z`);
  return { user, subsidy, opts };
}

const goldenFiles = loadGoldenFiles();

test('golden fixtures directory is non-empty', () => {
  assert.ok(goldenFiles.length >= 8, `expected >=8 golden files, found ${goldenFiles.length}`);
});

for (const { file, doc } of goldenFiles) {
  test(`golden: ${file} (${doc.axis})`, async (t) => {
    assert.ok(Array.isArray(doc.fixtures) && doc.fixtures.length > 0, `${file} has fixtures`);
    for (const fixture of doc.fixtures) {
      await t.test(fixture.name, () => {
        const { user, subsidy, opts } = buildCase(doc, fixture);
        const actual = isSubsidyMatchingUser(subsidy, user, opts);
        assert.strictEqual(
          actual,
          fixture.expected,
          `${file} / ${fixture.name}: expected ${fixture.expected}, got ${actual}`
        );
      });
    }
  });
}
