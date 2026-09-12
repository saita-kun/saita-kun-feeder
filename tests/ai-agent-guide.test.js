const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const guide = fs.readFileSync(path.join(ROOT, 'docs/ai-agent-guide.md'), 'utf8');
const lines = guide.split('\n');
const CANONICAL = 'https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/main/docs/ai-agent-guide.md';

function instruction(fragment) {
  const line = lines.find((value) => value.includes(fragment));
  assert.ok(line, `Missing guide instruction: ${fragment}`);
  return line;
}

test('AC1: guide starts with audience and version metadata', () => {
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0 && end < 8, 'metadata must fit within the first eight lines');
  const fields = [...lines.slice(1, end).join('\n')
    .matchAll(/^(audience|guide_version|updated_at|canonical): (.+)$/gm)];
  assert.equal(fields.length, 4);
  const metadata = Object.fromEntries(fields.map(([, key, value]) => [key, value]));
  assert.equal(metadata.audience, 'ai');
  assert.match(metadata.guide_version, /^\d+\.\d+\.\d+$/);
  assert.match(metadata.updated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(metadata.canonical, CANONICAL);
});

test('AC2: guide identifies a pinned revision and prioritizes the cloned version', () => {
  assert.ok(guide.includes(CANONICAL.replace('/main/', '/<tag-or-sha>/')));
  assert.match(guide, /git rev-parse HEAD/);
  assert.match(guide, /clone 済みの版.*優先/);
});

test('AC3: execution mode requires both write and command capabilities', () => {
  assert.match(instruction('操作モード'), /読み書き.*コマンド実行.*両方/);
  assert.match(instruction('代読モード'), /書込またはコマンド実行ができない/);
  assert.match(instruction('代読モード'), /未確認/);
});

test('AC3: creation consent and an explicit clone destination are required', () => {
  assert.match(instruction('明示同意'), /repo 作成.*clone/);
  assert.match(instruction('指定済みパス'), /優先/);
  assert.match(instruction('未指定の場合'), /保存先.*確認/);
  assert.match(guide, /git clone -- "\$FEEDER_REPO_URL" "\$FEEDER_DEST_DIR"/);
  assert.match(guide, /cd -- "\$FEEDER_DEST_DIR"/);
});

test('AC4: resume branches distinguish the repository and setup states', () => {
  for (const branch of [
    'clone済み: S1をスキップ', 'setup有効: S2をスキップ',
    'setup不完全: S2へ', '保存先が別repo: 停止',
  ]) instruction(branch);
  assert.match(instruction('support_prompt'), /だけ.*完了扱いにしない/);
  assert.match(guide, /8 条件.*すべて.*setup有効/);
  assert.match(guide, /不成立.*未確認.*setup不完全/);
});

test('AC4(a): setup state must exist and be readable as JSON', () => {
  assert.match(instruction('`input/setup-state.json`'), /存在.*JSON.*読める/);
});

test('AC4(b): both consent hashes must match the current document bytes', () => {
  const condition = instruction('`terms_sha256` / `data_policy_sha256`');
  assert.match(condition, /`TERMS.md` \/ `docs\/data-policy.md`/);
  assert.match(condition, /現行.*バイト列.*sha256.*一致/);
});

test('AC4(c): an actual profile and a successful profile check are both required', () => {
  const condition = instruction('実プロファイル `profile/delivery-profile.json`');
  assert.match(condition, /存在.*bash tools\/check-profile.sh.*成功.*exit 0/);
  assert.match(condition, /sample.*不可/);
});

test('AC4(d): profile consent must match the current terms hash', () => {
  assert.match(instruction('`profile.terms_accepted_sha256`'), /現行.*`TERMS.md`.*sha256.*一致/);
});

test('P55 AC1: confirmed Actions delivery skips additional local sending', () => {
  const branch = instruction('GitHub Actions: 確認済み');
  assert.match(branch, /手順 6.*Deliver.*`\[my-<name>\] 送信成功`.*利用者.*受信確認/);
  assert.match(branch, /受信確認が済んだ場合.*追加のローカル実配信を省きます/);
  assert.match(instruction('手動配信は'), /追加のお試し.*`--dry-run` のみ/);
  assert.doesNotMatch(guide, /お試しと実配信を確認/);
});

test('P55 AC1: pending Actions and local-only checks retain a single delivery test', () => {
  const pending = instruction('GitHub Actions: 未確認');
  assert.match(pending, /手順 6.*確認/);
  assert.match(pending, /スキップ.*新着なし.*確認済みとしません/);
  assert.match(pending, /翌日以降.*実行ログ.*受信/);
  assert.match(pending, /ローカル実配信で代替しません/);
  const local = instruction('| 手元での実行だけで運用 |');
  assert.match(local, /手順 4-3.*利用者.*確認.*1 回だけ/);
  assert.match(local, /確認済みなら繰り返しません/);
});

test('P55 AC2: skipping S2 still requires the environment gate before S3', () => {
  assert.match(instruction('setup有効: S2をスキップ'), /S3 前の環境ゲート.*S3 へ/);
  const gate = instruction('**S3 前の環境ゲート');
  assert.match(gate, /新規・再開共通.*S2 を省略する場合も/);
  assert.match(gate, /`\.claude\/commands\/setup.md`/);
  assert.match(gate, /条件 5・6.*S3 へ/);
  assert.match(instruction('| 5 |'), /python3.*導入.*確認.*`python3 --version`/);
  assert.match(instruction('| 6 |'), /成功.*exit 0.*`validate: OK`.*`bash tools\/validate.sh`/);
  assert.match(gate, /未導入.*先に導入/);
  assert.match(gate, /失敗または未確認.*S3 へ進まず/);
  assert.match(gate, /python3 未導入でも S2.*プロファイル作成.*dry-run.*進められます/);
  assert.ok(guide.indexOf(gate) < guide.indexOf('## S3. '));
});

test('P55 R2 AC1: skipping S2 requires a completed dry-run using the actual feed', () => {
  assert.match(instruction('setup有効: S2をスキップ'), /8 条件.*すべて/);
  const condition = instruction('| 7 |');
  assert.match(condition, /実プロファイル.*feed_base_url.*dry-run.*完走.*exit 0/);
  assert.match(condition, /`node runner\/deliver.js --profile profile\/delivery-profile.json --dry-run`/);
  assert.match(condition, /`--feed`.*fixture.*不可/);
  assert.match(condition, /（network）.*（cache）.*不可/);
  assert.match(instruction('`support_prompt`'), /dry-run の成功だけでは条件 1・2/);
});

test('P55 R2 AC1: failed or unconfirmed dry-runs resume the setup trial step', () => {
  const retry = instruction('dry-run が失敗または未確認');
  assert.match(retry, /キャッシュ.*S2.*`\.claude\/commands\/setup.md`.*手順 5.*戻/);
  assert.match(retry, /原因.*解消.*再実行/);
  assert.match(retry, /`bash tools\/validate.sh`.*fixture.*代用.*しません/);
  assert.ok(guide.indexOf(retry) < guide.indexOf('## S1. '));
  const setup = fs.readFileSync(path.join(ROOT, '.claude/commands/setup.md'), 'utf8');
  assert.match(setup, /本コマンド完了時点の受入基準.*check-profile.sh.*dry-run` が完走/);
  assert.match(setup, /## 5\. お試し実行への案内/);
});

test('P55 R2 AC2: eight setup checks share one table with verification commands', () => {
  const resume = guide.slice(guide.indexOf('### 既存状態からの再開'), guide.indexOf('## S1. '));
  const tables = [...resume.matchAll(/\| 条件 \|[^\n]*検証コマンド[^\n]*\n\|[-| ]+\|\n((?:\| \d+ \|[^\n]+\n)+)/g)];
  assert.equal(tables.length, 1, 'setup checks must have one command table');
  const rows = tables[0][1].trim().split('\n').map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(rows.map(([number]) => number), ['1', '2', '3', '4', '5', '6', '7', '8']);
  const commands = [
    /JSON\.parse.*readFileSync\("input\/setup-state.json"/,
    /terms_sha256.*TERMS.md.*data_policy_sha256.*docs\/data-policy.md.*createHash\("sha256"\)/,
    /^`test -f profile\/delivery-profile.json && bash tools\/check-profile.sh`$/,
    /readFileSync\("profile\/delivery-profile.json".*terms_accepted_sha256.*createHash\("sha256"\).*readFileSync\("TERMS.md"/,
    /^`python3 --version`$/,
    /^`bash tools\/validate.sh`$/,
    /^`node runner\/deliver.js --profile profile\/delivery-profile.json --dry-run`$/,
    /`gh repo view --json isPrivate --jq \.isPrivate "\$\(git remote get-url origin\)"`.*Settings/,
  ];
  rows.forEach((row, index) => {
    assert.equal(row.length, 3, `condition ${index + 1} must include a verification command`);
    assert.match(row[2], commands[index]);
  });
  assert.doesNotMatch(resume, /[47] 条件/);
});

test('P55 R3 AC1: skipping S2 requires current origin privacy evidence', () => {
  const condition = instruction('| 8 |');
  assert.match(condition, /現在の `origin`.*private.*再開時.*exit 0.*`true`/);
  assert.match(condition, /`gh repo view --json isPrivate --jq \.isPrivate "\$\(git remote get-url origin\)"`/);
  assert.match(condition, /gh が使えない場合.*同じ origin repo.*Settings.*Visibility.*Private.*利用者.*確認/);
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /`\/setup` — .*private repo 確認/);
});

test('P55 R3 AC1: public or unconfirmed origin resumes setup before delivery', () => {
  const retry = instruction('private 確認が');
  assert.match(retry, /`false`.*public.*未確認.*setup不完全.*S2.*`\.claude\/commands\/setup.md`.*手順 1/);
  assert.match(retry, /現在の origin.*private.*確認できるまで S3・配信・push へ進みません/);
  assert.match(retry, /過去の setup.*`404`.*代用しません/);
  assert.ok(guide.indexOf(retry) < guide.indexOf('## S1. '));
});

test('P55 R3 AC2: core manifest distributes the guide and its regression tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-manifest.json'), 'utf8'));
  for (const relative of ['docs/ai-agent-guide.md', 'tests/ai-agent-guide.test.js']) {
    assert.equal(manifest.core_paths.filter((entry) => entry === relative).length, 1, relative);
  }
});

test('P55 AC3: guide branches agree with setup transition and delivery contracts', () => {
  const setup = fs.readFileSync(path.join(ROOT, '.claude/commands/setup.md'), 'utf8');
  assert.match(setup, /`\/setup-channel` に進む前.*python3 を導入.*`bash tools\/validate.sh`.*`validate: OK`/);
  const channel = fs.readFileSync(path.join(ROOT, '.claude/commands/setup-channel.md'), 'utf8');
  assert.match(channel, /GitHub Actions で自動配信する場合.*ここを飛ばして手順 6.*1 回だけ/);
  assert.match(channel, /Deliver.*`\[my-<name>\] 送信成功`.*利用者に確認/);
  assert.match(instruction('実送信テストは'), /`\/setup-channel`.*利用者の確認を取ってから 1 回だけ/);
});

test('AC5: required handoff documents and referenced repository files exist', () => {
  for (const relative of [
    'CLAUDE.md', 'AGENTS.md', 'TERMS.md', 'docs/data-policy.md',
    '.claude/commands/setup.md', '.claude/commands/setup-channel.md', '.claude/commands/deliver.md',
  ]) {
    assert.ok(guide.includes(`\`${relative}\``), `Missing handoff reference: ${relative}`);
    assert.ok(fs.statSync(path.join(ROOT, relative)).isFile(), relative);
  }
  for (const [, relative] of guide.matchAll(/`((?:docs\/|\.claude\/commands\/)[^`*<>]+\.md)`/g)) {
    assert.ok(fs.statSync(path.join(ROOT, relative)).isFile(), relative);
  }
});
