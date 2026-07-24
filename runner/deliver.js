#!/usr/bin/env node
/**
 * Delivery runner: feed -> match -> select -> digest -> channel adapters.
 *
 * Usage:
 *   node runner/deliver.js [--feed <url|dir>] [--profile <path>] [--ledger <path>]
 *                          [--today YYYY-MM-DD] [--out <dir>] [--dry-run]
 *
 * --today fixes the reference date AND the ledger timestamps (deterministic
 * runs for tests). Without it, wall-clock time is used.
 * --dry-run: renders digests and invokes adapters with SAITA_FEEDER_DRY_RUN=1;
 * never mutates the ledger.
 *
 * Exit codes: 0 ok / 1 fatal / 2 completed with some failed sends.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { isOpen, isSubsidyMatchingUser } = require('../lib/match-user-subsidy');
const { loadFeed, freshnessWarnings } = require('../lib/feed-client');
const ledgerLib = require('../lib/ledger');
const { remainingBudget, selectWithinBudget } = require('../lib/select');
const { renderDigest } = require('../lib/digest');

const ROOT = path.resolve(__dirname, '..');
const CHANNEL_TIMEOUT_MS = 60 * 1000;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--feed') args.feed = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--today') args.today = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`未知の引数です: ${a}`);
  }
  if (args.today && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) {
    throw new Error(`--today は YYYY-MM-DD 形式で指定してください: ${args.today}`);
  }
  return args;
}

function loadProfile(profilePath) {
  if (!fs.existsSync(profilePath)) {
    throw new Error(
      `プロファイルがありません: ${profilePath} — /setup を実行してください`
    );
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (typeof profile.company_prefecture !== 'string' || !profile.company_prefecture) {
    throw new Error('プロファイルに company_prefecture がありません — /setup を実行してください');
  }
  return profile;
}

function enforceTermsGate(profile) {
  const termsPath = path.join(ROOT, 'TERMS.md');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(termsPath)).digest('hex');
  if (profile.terms_accepted_sha256 !== actual) {
    throw new Error(
      '利用規約への同意記録が現行の TERMS.md と一致しません — /setup で再同意してください'
    );
  }
}

function resolveChannels(profile, dryRun) {
  if (dryRun) return [{ name: 'dryrun' }];
  const enabled = (Array.isArray(profile.channels) ? profile.channels : []).filter(
    (c) => c && c.enabled !== false && typeof c.name === 'string'
  );
  if (enabled.length === 0) {
    console.log('有効なチャネルがありません — dryrun チャネルで実行します（/setup-channel で設定できます）');
    return [{ name: 'dryrun' }];
  }
  return enabled;
}

function runChannelAdapter(channelName, digestMdPath, digestJson, dryRun) {
  const dir = path.join(ROOT, 'channels', channelName);
  const sendPath = path.join(dir, 'send');
  if (!fs.existsSync(path.join(dir, 'channel.json')) || !fs.existsSync(sendPath)) {
    return { ok: false, error: `チャネル ${channelName} が不完全です（channel.json / send が必要）` };
  }
  const res = spawnSync(sendPath, [digestMdPath], {
    input: JSON.stringify(digestJson),
    env: { ...process.env, ...(dryRun ? { SAITA_FEEDER_DRY_RUN: '1' } : {}) },
    timeout: CHANNEL_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return { ok: res.status === 0, error: res.status === 0 ? null : `exit ${res.status}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const profilePath = args.profile || path.join(ROOT, 'profile', 'delivery-profile.json');
  const ledgerPath = args.ledger || path.join(ROOT, 'state', 'notified.json');
  const outDir = args.out || path.join(ROOT, 'output');

  const profile = loadProfile(profilePath);
  enforceTermsGate(profile);

  const today = args.today || new Date().toISOString().slice(0, 10);
  const nowMs = args.today ? Date.parse(`${args.today}T00:00:00Z`) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const todayDate = new Date(nowMs);

  const feedBase = args.feed || profile.feed_base_url;
  if (!feedBase) throw new Error('フィードの場所が未設定です（--feed または profile.feed_base_url）');

  // Cache lives next to the ledger (state/cache/ by default), so test runs
  // with a temp ledger are fully isolated from repo state.
  const feed = await loadFeed({
    baseUrl: feedBase,
    cachePath: path.join(path.dirname(ledgerPath), 'cache', 'last-good-feed.json'),
  });
  const warnings = [...feed.warnings, ...freshnessWarnings(feed.meta, nowMs)];

  const open = feed.data.subsidies.filter((s) => isOpen(s, todayDate));
  const matched = open.filter((s) =>
    isSubsidyMatchingUser(s, profile, { today: todayDate, isPaid: true })
  );
  console.log(
    `feed: ${feed.data.subsidies.length} 件（${feed.source}）/ open: ${open.length} 件 / マッチ: ${matched.length} 件`
  );

  const ledger = ledgerLib.loadLedger(ledgerPath);
  // Budget is fixed at run start: sibling channels deliver the same content,
  // so sends within this run do not consume each other's budget.
  const budget = remainingBudget(ledger, nowMs, {
    weeklyCap: profile.weekly_cap,
    dailyCap: profile.daily_cap,
  });

  const channels = resolveChannels(profile, args.dryRun);
  fs.mkdirSync(outDir, { recursive: true });

  let anyFailed = false;
  for (const channel of channels) {
    const actionable = [];
    for (const subsidy of matched) {
      const plan = ledgerLib.planCandidate(ledger, subsidy, channel.name, nowMs);
      if (plan.action !== 'skip') actionable.push({ subsidy, plan });
    }

    const { selected, dropped } = selectWithinBudget(
      actionable.map((a) => a.subsidy),
      budget
    );
    const planById = new Map(actionable.map((a) => [a.subsidy.id, a.plan]));
    const items = selected.map((subsidy) => ({
      subsidy,
      notifiedAs: planById.get(subsidy.id).action === 'retry' ? 'retry' : planById.get(subsidy.id).action,
    }));

    if (items.length === 0 && warnings.length === 0) {
      console.log(`[${channel.name}] 新着・更新なし — 配信しません`);
      continue;
    }

    const digest = renderDigest({
      items,
      today,
      generatedAt: feed.meta.generated_at,
      warnings,
      droppedCount: dropped,
    });

    const base = path.join(outDir, `digest-${today}-${channel.name}`);
    fs.writeFileSync(`${base}.md`, digest.markdown);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(digest.json, null, 2)}\n`);

    const result = runChannelAdapter(channel.name, `${base}.md`, digest.json, args.dryRun);
    console.log(
      `[${channel.name}] ${result.ok ? '送信成功' : `送信失敗: ${result.error}`}（${items.length} 件、繰り越し ${dropped} 件）`
    );

    if (!args.dryRun) {
      for (const { subsidy, notifiedAs } of items) {
        const plan = planById.get(subsidy.id);
        ledgerLib.recordResult(ledger, subsidy, channel.name, {
          ok: result.ok,
          nowIso,
          hash: plan.hash,
          notifiedAs: notifiedAs === 'retry' ? undefined : notifiedAs,
        });
      }
    }
    if (!result.ok) anyFailed = true;
  }

  if (!args.dryRun) ledgerLib.saveLedger(ledgerPath, ledger);
  for (const w of warnings) console.log(`警告: ${w}`);

  process.exitCode = anyFailed ? 2 : 0;
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exitCode = 1;
});
