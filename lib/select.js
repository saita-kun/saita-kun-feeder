/**
 * Candidate ordering and delivery caps — minimal feeder implementation.
 *
 * Deliberately NOT vendored from upstream delivery-selection.js (it is tied to
 * paid-tier / LINE-quota concepts). Defaults match upstream numerically:
 * weekly cap 15, daily cap 5. Ordering is deterministic (no randomness):
 * deadline asc -> maximum_amount desc (unknown last) -> id asc.
 */

const { parseDeadline, isAmountUnknown } = require('./match-user-subsidy');
const { countSentWithin } = require('./ledger');

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
 * Remaining budget for this run, from the ledger's send history.
 */
function remainingBudget(ledger, nowMs, { weeklyCap, dailyCap }) {
  const weekly = (weeklyCap || DEFAULT_WEEKLY_CAP) - countSentWithin(ledger, nowMs, WEEK_MS);
  const daily = (dailyCap || DEFAULT_DAILY_CAP) - countSentWithin(ledger, nowMs, DAY_MS);
  return Math.max(0, Math.min(weekly, daily));
}

/**
 * Order candidates deterministically and truncate to budget.
 * Returns { selected, dropped } — dropped count is surfaced, never silent.
 */
function selectWithinBudget(candidates, budget) {
  const ordered = sortDeterministic(candidates);
  return {
    selected: ordered.slice(0, budget),
    dropped: Math.max(0, ordered.length - budget),
  };
}

module.exports = {
  DEFAULT_WEEKLY_CAP,
  DEFAULT_DAILY_CAP,
  sortDeterministic,
  remainingBudget,
  selectWithinBudget,
};
