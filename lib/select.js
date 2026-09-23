/**
 * Candidate ordering and delivery caps — minimal feeder implementation.
 *
 * Deliberately NOT vendored from upstream delivery-selection.js (it is tied to
 * paid-tier / LINE-quota concepts). Defaults match upstream numerically:
 * weekly cap 15, daily cap 5. Base ordering is deterministic (no randomness):
 * specific industry match first -> deadline asc -> maximum_amount desc
 * (unknown deadlines/amounts last) -> id asc. Then reserve up to two urgent
 * rows (deadline within 14 days) in the first five, when available. Shared
 * budgets reserve urgent capacity before accepting ordinary rows.
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

function sortBase(subsidies, categories) {
  return [...subsidies].sort((a, b) => {
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

}

// Each cursor only advances: selection is O(n) after the base sort. accept
// reserves capacity on success and must leave it unchanged on rejection.
function selectWithUrgentSlots(base, today, accept) {
  if (!(today instanceof Date) || !Number.isFinite(today.getTime())) return base.filter(accept);

  // Reserve urgent capacity first, so ordinary rows cannot exhaust it before
  // promotion begins. Track row indices rather than IDs to preserve row identity.
  const reserved = new Set();
  for (let index = 0; index < base.length && reserved.size < URGENT_MIN_SLOTS; index += 1) {
    if (isUrgent(base[index], today) && accept(base[index])) reserved.add(index);
  }
  // Reserved rows have already been accepted. All other rows get their normal
  // base-order budget check; a rejection must not change the budget.
  const selected = base.filter((subsidy, index) => reserved.has(index) || accept(subsidy));

  // Ordering is independent of budget reservation. Keep the legacy promotion
  // threshold, including fourth-position promotion when only one urgent exists.
  const out = [];
  const processed = new Set();
  let baseIndex = 0;
  let urgentIndex = 0;
  let urgentTaken = 0;
  const take = (index) => {
    processed.add(index);
    const subsidy = selected[index];
    if (isUrgent(subsidy, today)) urgentTaken += 1;
    out.push(subsidy);
  };

  while (baseIndex < selected.length) {
    if (processed.has(baseIndex)) {
      baseIndex += 1;
      continue;
    }
    if (out.length < URGENT_WINDOW) {
      const need = URGENT_MIN_SLOTS - urgentTaken;
      const slotsLeft = URGENT_WINDOW - out.length;
      if (need > 0 && slotsLeft <= need) {
        let promoted = false;
        while (urgentIndex < selected.length) {
          const index = urgentIndex++;
          if (!processed.has(index) && isUrgent(selected[index], today)) {
            take(index);
            promoted = true;
            break;
          }
        }
        // If fewer than two urgent rows were affordable, continue in base order.
        if (promoted) continue;
      }
    }
    take(baseIndex);
    baseIndex += 1;
  }
  return out;
}

function sortDeterministic(subsidies, opts = {}) {
  return selectWithUrgentSlots(sortBase(subsidies, opts.categories), opts.today, () => true);
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
  if (typeof budget === 'number') {
    const ordered = sortDeterministic(candidates, opts);
    return {
      selected: ordered.slice(0, budget),
      dropped: Math.max(0, ordered.length - budget),
    };
  }
  const base = sortBase(candidates, opts.categories);
  const selected = selectWithUrgentSlots(base, opts.today, (subsidy) => {
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
    dropped: base.length - selected.length,
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
