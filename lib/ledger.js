/**
 * Idempotency ledger (dr-006) — file port of the upstream SQL claim model.
 *
 * state/notified.json keys every notification by (subsidy_id, channel).
 * Diff detection uses a channel-local content hash over a FIXED field list
 * (HASH_FIELDS): changing that list re-notifies every row/channel as
 * "updated", so it only changes together with dr-006.
 *
 * Schema: schemas/ledger.schema.json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEDGER_VERSION = 1;
const MAX_RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;

// Fixed hash-field enumeration (dr-006). `description` is deliberately
// excluded so minor copy edits do not re-notify.
const HASH_FIELDS = [
  'title', 'detailed_url', 'prefectures', 'municipality', 'gov_level',
  'application_deadline', 'acceptance_start', 'maximum_amount', 'funding_limit',
  'subsidy_rate', 'eligible_scale', 'support_type', 'institution_name',
  'category_new_technology', 'category_it', 'category_entertainment',
  'category_professional', 'category_agriculture', 'category_construction',
  'category_wholesale', 'category_finance', 'category_realestate',
  'category_hospitality', 'category_medical', 'category_other',
  'purpose_capex', 'purpose_it_intro', 'purpose_rd', 'purpose_hr',
  'purpose_market', 'purpose_startup', 'purpose_succession',
];

function contentHash(subsidy) {
  const canonical = HASH_FIELDS.map((f) => [f, subsidy[f] === undefined ? null : subsidy[f]]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function loadLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) {
    return { ledger_version: LEDGER_VERSION, entries: {} };
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (ledger.ledger_version !== LEDGER_VERSION) {
    throw new Error(
      `未対応の ledger_version です: ${ledger.ledger_version}（対応: ${LEDGER_VERSION}）`
    );
  }
  if (!ledger.entries || typeof ledger.entries !== 'object') {
    throw new Error('台帳の entries が壊れています');
  }
  return ledger;
}

function saveLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Decide what to do for (subsidy, channel) at time nowMs.
 * Returns { action: 'new' | 'updated' | 'retry' | 'skip' }.
 * Rows that vanished from the feed stay in the ledger untouched (dr-006).
 */
function planCandidate(ledger, subsidy, channelName, nowMs) {
  const hash = contentHash(subsidy);
  const entry = ledger.entries[subsidy.id];
  if (!entry) return { action: 'new', hash };

  const ch = entry.channels && entry.channels[channelName];
  if (!ch) return { action: 'new', hash };
  if (ch.last_sent_hash !== hash) return { action: 'updated', hash };
  if (ch.status === 'sent') return { action: 'skip', hash };

  // failed: bounded retry with backoff (upstream reclaim semantics)
  const lastAttempt = Date.parse(ch.last_attempt_at || '') || 0;
  if ((ch.retry_count || 0) < MAX_RETRY_COUNT && nowMs - lastAttempt > RETRY_BACKOFF_MS) {
    return { action: 'retry', hash };
  }
  return { action: 'skip', hash };
}

/**
 * Record a send result. notifiedAs: 'new' | 'updated' (unchanged on retry).
 */
function recordResult(ledger, subsidy, channelName, { ok, nowIso, hash, notifiedAs }) {
  const entry = ledger.entries[subsidy.id] || { channels: {} };
  entry.channels = entry.channels || {};

  const prev = entry.channels[channelName];
  // retry_count = failed attempts after the initial failure (0 on first failure).
  const sameHash = prev && prev.last_sent_hash === hash;
  const retryCount = ok ? 0 : (prev && prev.status === 'failed' && sameHash ? (prev.retry_count || 0) + 1 : 0);
  entry.channels[channelName] = {
    status: ok ? 'sent' : 'failed',
    last_sent_hash: hash,
    first_notified_at: (prev && prev.first_notified_at) || nowIso,
    last_attempt_at: nowIso,
    retry_count: retryCount,
    notified_as: notifiedAs || (prev && prev.notified_as) || 'new',
  };

  ledger.entries[subsidy.id] = entry;
}

/**
 * Count subsidies already sent (any channel) within [nowMs - windowMs, nowMs].
 * Used for weekly/daily budget calculation.
 */
function countSentWithin(ledger, nowMs, windowMs) {
  let count = 0;
  for (const entry of Object.values(ledger.entries)) {
    const sentTimes = Object.values(entry.channels || {})
      .filter((ch) => ch.status === 'sent')
      .map((ch) => Date.parse(ch.last_attempt_at || ''))
      .filter((t) => Number.isFinite(t));
    if (sentTimes.some((t) => nowMs - t <= windowMs && t <= nowMs)) count += 1;
  }
  return count;
}

module.exports = {
  LEDGER_VERSION,
  MAX_RETRY_COUNT,
  RETRY_BACKOFF_MS,
  HASH_FIELDS,
  contentHash,
  loadLedger,
  saveLedger,
  planCandidate,
  recordResult,
  countSentWithin,
};
