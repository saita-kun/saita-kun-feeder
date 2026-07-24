/**
 * Deterministic digest rendering (markdown for humans, JSON for adapters).
 * Same inputs always yield byte-identical output (golden-digest E2E relies
 * on this). No timestamps other than the ones passed in.
 */

const { parseDeadline } = require('./match-user-subsidy');
const { toJapanese } = require('./prefecture-mapper');
const { isAmountUnknown } = require('./match-user-subsidy');

const DAY_MS = 24 * 60 * 60 * 1000;

const DISCLAIMER =
  '本ダイジェストは登録プロファイルに基づく「マッチ候補」の提示であり、応募資格・採択可能性の認定ではありません。応募判断の前に必ず公式の公募要領を確認してください。';

const NOTIFIED_AS_LABEL = { new: '新着', updated: '更新', retry: '再送' };

function formatAmount(maximumAmount) {
  if (isAmountUnknown(maximumAmount)) return '不明（公募要領を確認）';
  const n = Number(maximumAmount);
  if (n >= 100000000 && n % 100000000 === 0) return `${n / 100000000}億円`;
  if (n % 10000 === 0) return `${(n / 10000).toLocaleString('en-US')}万円`;
  return `${n.toLocaleString('en-US')}円`;
}

function formatRegion(subsidy) {
  const prefs = Array.isArray(subsidy.prefectures) ? subsidy.prefectures : [];
  if (prefs.includes('zenkoku')) return '全国';
  const names = prefs.map(toJapanese).join('・');
  if (subsidy.municipality) return `${subsidy.municipality}（${names}）`;
  return names || '不明';
}

function formatDeadline(subsidy, todayUtcMs) {
  const d = parseDeadline(subsidy.application_deadline);
  if (!d) return '不明';
  const daysLeft = Math.floor((d.getTime() - todayUtcMs) / DAY_MS);
  return `${subsidy.application_deadline}（残り${daysLeft}日）`;
}

/**
 * Render a digest for one channel run.
 * items: [{ subsidy, notifiedAs }] already ordered.
 */
function renderDigest({ items, today, generatedAt, warnings = [], droppedCount = 0 }) {
  const todayUtcMs = Date.parse(`${today}T00:00:00Z`);
  const counts = { new: 0, updated: 0, retry: 0 };
  for (const it of items) counts[it.notifiedAs] = (counts[it.notifiedAs] || 0) + 1;

  const lines = [];
  lines.push(`# 補助金マッチダイジェスト ${today}`);
  lines.push('');
  lines.push(
    `> マッチ ${items.length} 件（新着 ${counts.new} / 更新 ${counts.updated} / 再送 ${counts.retry}）／ フィード生成: ${generatedAt}`
  );
  if (droppedCount > 0) {
    lines.push(`> 配信上限により ${droppedCount} 件を次回以降に繰り越しました。`);
  }
  lines.push('');

  if (warnings.length > 0) {
    lines.push('## ⚠ 注意');
    lines.push('');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  items.forEach(({ subsidy, notifiedAs }, i) => {
    lines.push(`## ${i + 1}. ${subsidy.title}`);
    lines.push('');
    lines.push(`- 区分: ${NOTIFIED_AS_LABEL[notifiedAs] || notifiedAs}`);
    lines.push(`- 締切: ${formatDeadline(subsidy, todayUtcMs)}`);
    lines.push(`- 上限額: ${formatAmount(subsidy.maximum_amount)}`);
    lines.push(`- 地域: ${formatRegion(subsidy)}`);
    if (subsidy.institution_name) lines.push(`- 実施: ${subsidy.institution_name}`);
    if (subsidy.subsidy_rate) lines.push(`- 補助率: ${subsidy.subsidy_rate}`);
    lines.push(`- 詳細: ${subsidy.detailed_url}`);
    lines.push('');
  });

  if (items.length === 0) {
    lines.push('今回の新着・更新はありません。');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(DISCLAIMER);
  lines.push('');

  const json = {
    digest_version: 1,
    date: today,
    feed_generated_at: generatedAt,
    warnings,
    dropped_count: droppedCount,
    items: items.map(({ subsidy, notifiedAs }) => ({
      id: subsidy.id,
      title: subsidy.title,
      detailed_url: subsidy.detailed_url,
      application_deadline: subsidy.application_deadline,
      maximum_amount: subsidy.maximum_amount,
      prefectures: subsidy.prefectures,
      municipality: subsidy.municipality,
      gov_level: subsidy.gov_level,
      institution_name: subsidy.institution_name,
      notified_as: notifiedAs,
    })),
  };

  return { markdown: lines.join('\n'), json };
}

module.exports = { renderDigest, formatAmount, formatRegion, DISCLAIMER };
