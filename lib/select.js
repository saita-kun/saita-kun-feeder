/**
 * Candidate ordering and delivery caps — minimal feeder implementation.
 *
 * Deliberately NOT vendored from upstream delivery-selection.js (it is tied to
 * paid-tier / LINE-quota concepts). Defaults match upstream numerically:
 * weekly cap 15, daily cap 5. Base ordering is deterministic (no randomness):
 * specific industry match first -> deadline asc -> maximum_amount desc
 * (unknown deadlines/amounts last) -> id asc. Then reserve up to two urgent
 * rows (deadline within 14 days) in the first five, when available.
 * Without a valid reference date, urgent slots are skipped (no wall-clock reads).
 * Without selected industries, ordering remains deadline -> amount -> id.
 * Provisional: the industry-specificity key is removed once feed contract v2
 * (issue #16) gives producers a dedicated representation for industry-agnostic
 * programs (issue #43).
 */

const { parseDeadline, isAmountUnknown, CATEGORY_KEYS } = require('./match-user-subsidy');
const { sentIdsWithin } = require('./ledger');

const DEFAULT_WEEKLY_CAP = 15;
const DEFAULT_DAILY_CAP = 5;

// Ranking heuristic only — NOT a re-classification of the feed (dr-001 keeps
// classification a producer responsibility). A row that flags nearly every
// industry carries no industry signal, so it cannot outrank a specific match.
const AGNOSTIC_CATEGORY_KEYS = CATEGORY_KEYS.filter((key) => key !== 'other'); // 11 keys
const AGNOSTIC_CATEGORY_THRESHOLD = 8; // >= 8 of 11 flagged -> industry-agnostic
const URGENT_DAYS = 14; // Deadline within 14 days = urgent.
const URGENT_WINDOW = 5; // Reserve inside the first 5 delivered rows.
const URGENT_MIN_SLOTS = 2; // At least 2 of those 5 are urgent when available.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function countIndustryFlags(subsidy) {
  return AGNOSTIC_CATEGORY_KEYS.filter((key) => Number(subsidy[`category_${key}`]) === 1).length;
}

function isIndustryAgnostic(subsidy) {
  return countIndustryFlags(subsidy) >= AGNOSTIC_CATEGORY_THRESHOLD;
}

function isSpecificIndustryMatch(subsidy, categories) {
  return Array.isArray(categories) && categories.length > 0
    && categories.some((category) => Number(subsidy[`category_${category}`]) === 1)
    && !isIndustryAgnostic(subsidy);
}

function daysUntilDeadline(subsidy, today) {
  if (!(today instanceof Date) || !Number.isFinite(today.getTime())) return null;
  const d = parseDeadline(subsidy.application_deadline);
  if (!d) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((d.getTime() - todayUtc) / DAY_MS);
}

function isUrgent(subsidy, today) {
  const days = daysUntilDeadline(subsidy, today);
  return days !== null && days <= URGENT_DAYS;
}

function sortDeterministic(subsidies, opts = {}) {
  const { categories, today } = opts;
  const base = [...subsidies].sort((a, b) => {
    const sa = isSpecificIndustryMatch(a, categories) ? 0 : 1;
    const sb = isSpecificIndustryMatch(b, categories) ? 0 : 1;
    if (sa !== sb) return sa - sb;

    const da = parseDeadline(a.application_deadline);
    const db = parseDeadline(b.application_deadline);
    const ta = da ? da.getTime() : Number.POSITIVE_INFINITY;
    const tb = db ? db.getTime() : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;

    const aa = isAmountUnknown(a.maximum_amount) ? -1 : Number(a.maximum_amount);
    const ab = isAmountUnknown(b.maximum_amount) ? -1 : Number(b.maximum_amount);
    if (aa !== ab) return ab - aa;

    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  if (!(today instanceof Date) || !Number.isFinite(today.getTime())) return base;

  const out = [];
  const pool = [...base];
  let urgentTaken = 0;
  while (pool.length) {
    let pickIndex = 0;
    if (out.length < URGENT_WINDOW) {
      const need = URGENT_MIN_SLOTS - urgentTaken;
      const slotsLeft = URGENT_WINDOW - out.length;
      if (need > 0 && slotsLeft <= need) {
        const idx = pool.findIndex((subsidy) => isUrgent(subsidy, today));
        // Promote only the missing urgent slots; if too few urgent rows exist,
        // take those available and leave the remaining base order unchanged.
        if (idx >= 0) pickIndex = idx;
      }
    }
    // Beyond the window, always consume the remaining base order.
    const [picked] = pool.splice(pickIndex, 1);
    if (isUrgent(picked, today)) urgentTaken += 1;
    out.push(picked);
  }
  return out;
}

/**
 * Shared run budget: each subsidy ID consumes capacity once per time window.
 */
function createBudget(ledger, nowMs, { weeklyCap, dailyCap }) {
  return [
    { cap: dailyCap || DEFAULT_DAILY_CAP, windowMs: DAY_MS },
    { cap: weeklyCap || DEFAULT_WEEKLY_CAP, windowMs: WEEK_MS },
  ].map(({ cap, windowMs }) => {
    const countedIds = sentIdsWithin(ledger, nowMs, windowMs);
    return { remaining: cap - countedIds.size, countedIds };
  });
}

/**
 * Remaining capacity for new IDs, preserving the numeric budget interface.
 */
function remainingBudget(ledger, nowMs, caps) {
  return Math.max(0, Math.min(...createBudget(ledger, nowMs, caps).map((window) => window.remaining)));
}

/**
 * Order candidates deterministically and select within a numeric or shared budget.
 * Selection reserves IDs in the supplied budget; callers commit it on success.
 * Returns { selected, dropped } — dropped count is surfaced, never silent.
 */
function selectWithinBudget(candidates, budget, opts = {}) {
  const ordered = sortDeterministic(candidates, opts);
  if (typeof budget === 'number') {
    return {
      selected: ordered.slice(0, budget),
      dropped: Math.max(0, ordered.length - budget),
    };
  }
  const selected = ordered.filter((subsidy) => {
    const id = String(subsidy.id);
    const uncounted = budget.filter((window) => !window.countedIds.has(id));
    if (uncounted.some((window) => window.remaining <= 0)) return false;
    for (const window of uncounted) {
      window.countedIds.add(id);
      window.remaining -= 1;
    }
    return true;
  });
  return {
    selected,
    dropped: ordered.length - selected.length,
  };
}

module.exports = {
  DEFAULT_WEEKLY_CAP,
  DEFAULT_DAILY_CAP,
  AGNOSTIC_CATEGORY_KEYS,
  AGNOSTIC_CATEGORY_THRESHOLD,
  URGENT_DAYS,
  URGENT_WINDOW,
  URGENT_MIN_SLOTS,
  countIndustryFlags,
  isIndustryAgnostic,
  isSpecificIndustryMatch,
  daysUntilDeadline,
  isUrgent,
  sortDeterministic,
  createBudget,
  remainingBudget,
  selectWithinBudget,
};
