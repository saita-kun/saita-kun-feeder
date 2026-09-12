/**
 * Candidate ordering and delivery caps — minimal feeder implementation.
 *
 * Deliberately NOT vendored from upstream delivery-selection.js (it is tied to
 * paid-tier / LINE-quota concepts). Defaults match upstream numerically:
 * weekly cap 15, daily cap 5. Ordering is deterministic (no randomness):
 * deadline asc -> maximum_amount desc (unknown last) -> id asc.
 */

const { parseDeadline, isAmountUnknown } = require('./match-user-subsidy');
const { sentIdsWithin } = require('./ledger');

const DEFAULT_WEEKLY_CAP = 15;
const DEFAULT_DAILY_CAP = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function sortDeterministic(subsidies) {
  return [...subsidies].sort((a, b) => {
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
function selectWithinBudget(candidates, budget) {
  const ordered = sortDeterministic(candidates);
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
  sortDeterministic,
  createBudget,
  remainingBudget,
  selectWithinBudget,
};
