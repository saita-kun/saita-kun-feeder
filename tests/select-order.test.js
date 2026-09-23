const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_KEYS } = require('../lib/match-user-subsidy');
const {
  AGNOSTIC_CATEGORY_KEYS, AGNOSTIC_CATEGORY_THRESHOLD,
  URGENT_DAYS, URGENT_WINDOW, URGENT_MIN_SLOTS,
  countIndustryFlags, isIndustryAgnostic, isSpecificIndustryMatch,
  daysUntilDeadline, isUrgent, sortDeterministic, selectWithinBudget, createBudget,
} = require('../lib/select');
const { recordResult } = require('../lib/ledger');

const TODAY = new Date('2026-09-19T00:00:00Z');
const OPTIONS = { categories: ['it'], today: TODAY };
const INDUSTRIES = CATEGORY_KEYS.filter((key) => key !== 'other');
const ids = (rows) => rows.map((row) => row.id);

function row(id, deadline, categories = ['it'], maximumAmount = 1000) {
  return {
    id, application_deadline: deadline, maximum_amount: maximumAmount,
    ...Object.fromEntries(categories.map((key) => [`category_${key}`, 1])),
  };
}

function crowdedCandidates(urgentCount = 3) {
  return [
    ...Array.from({ length: 6 }, (_, i) => row(`specific-${i}`, '2026-11-01')),
    ...Array.from({ length: urgentCount }, (_, i) =>
      row(`urgent-${i}`, '2026-10-03', INDUSTRIES.slice(0, 9))),
  ];
}

test('AC-1 specific industry match precedes an earlier agnostic deadline', () => {
  const agnostic = row('agnostic', '2026-09-20', INDUSTRIES.slice(0, 9));
  const specific = row('specific', '2026-11-01');
  assert.deepEqual(ids(sortDeterministic([agnostic, specific], OPTIONS)),
    ['specific', 'agnostic']);
});

test('AC-2 reserve exactly two urgent slots in a crowded first five', () => {
  const ordered = sortDeterministic(crowdedCandidates(), OPTIONS);
  assert.equal(ordered.slice(0, 5).filter((s) => isUrgent(s, TODAY)).length, 2);
  assert.deepEqual(ids(ordered), [
    'specific-0', 'specific-1', 'specific-2', 'urgent-0', 'urgent-1',
    'specific-3', 'specific-4', 'specific-5', 'urgent-2',
  ]);
});

test('AC-2b promote the only urgent row and preserve the remaining base order', () => {
  const ordered = sortDeterministic(crowdedCandidates(1), OPTIONS);
  assert.equal(ordered.slice(0, 5).filter((s) => isUrgent(s, TODAY)).length, 1);
  assert.deepEqual(ids(ordered), [
    'specific-0', 'specific-1', 'specific-2', 'urgent-0',
    'specific-3', 'specific-4', 'specific-5',
  ]);
});

test('AC-2 no promotion without urgent rows or once two are already taken', () => {
  const candidates = crowdedCandidates(0);
  assert.deepEqual(sortDeterministic(candidates, OPTIONS), candidates);
  const early = [row('early-0', '2026-09-19'), row('early-1', '2026-09-20')];
  assert.deepEqual(ids(sortDeterministic([...crowdedCandidates(), ...early], OPTIONS)), [
    'early-0', 'early-1', ...ids(crowdedCandidates()),
  ]);
  assert.deepEqual(sortDeterministic([], OPTIONS), []);
});

test('AC-3 order is deterministic across permutations and input is not mutated', () => {
  const candidates = crowdedCandidates();
  const before = structuredClone(candidates);
  const shuffled = [4, 8, 1, 6, 3, 0, 7, 5, 2].map((i) => candidates[i]);
  const shuffledBefore = structuredClone(shuffled);
  const first = sortDeterministic(candidates, OPTIONS);
  assert.deepEqual(ids(first), ids(sortDeterministic(shuffled, OPTIONS)));
  assert.deepEqual(ids(first), ids(sortDeterministic(candidates, OPTIONS)));
  assert.deepEqual(candidates, before);
  assert.deepEqual(shuffled, shuffledBefore);
  assert.notStrictEqual(first, candidates);
});

test('AC-3b omitted today preserves base order regardless of the current date', (t) => {
  const candidates = crowdedCandidates().reverse();
  const expected = [
    'specific-0', 'specific-1', 'specific-2', 'specific-3', 'specific-4', 'specific-5',
    'urgent-0', 'urgent-1', 'urgent-2',
  ];
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-18T00:00:00Z') });
  const first = sortDeterministic(candidates, { categories: ['it'] });
  t.mock.timers.setTime(new Date('2026-09-19T00:00:00Z').getTime());
  const second = sortDeterministic(candidates, { categories: ['it'] });
  assert.deepEqual(second, first);
  assert.deepEqual(ids(first), expected);
});

test('AC-3c invalid today values preserve base order without throwing', () => {
  const candidates = crowdedCandidates().reverse();
  const expected = [
    'specific-0', 'specific-1', 'specific-2', 'specific-3', 'specific-4', 'specific-5',
    'urgent-0', 'urgent-1', 'urgent-2',
  ];
  for (const today of [null, new Date('invalid'), '2026-09-19']) {
    assert.deepEqual(ids(sortDeterministic(candidates, { categories: ['it'], today })), expected);
  }
});

test('deadline helpers reject missing or invalid today values without throwing', () => {
  const subsidy = row('deadline', '2026-10-03');
  for (const today of [undefined, null, new Date('invalid'), '2026-09-19']) {
    assert.equal(daysUntilDeadline(subsidy, today), null);
    assert.equal(isUrgent(subsidy, today), false);
  }
});

test('AC-4 omitted options and empty categories preserve legacy ordering', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: TODAY });
  const candidates = [
    row('unknown-date-small', null, ['it'], 200),
    row('tie-b', '2026-10-20', ['it'], 500),
    row('early', '2026-09-20', INDUSTRIES, 100),
    row('unknown-amount-b', '2026-10-20', ['it'], null),
    row('tie-a', '2026-10-20', INDUSTRIES, '500'),
    row('larger', '2026-10-20', ['it'], 1000),
    row('unknown-amount-a', '2026-10-20', ['it'], '1'),
    row('unknown-date-large', 'No information', INDUSTRIES, 900),
    row('boundary', '2026-10-03', INDUSTRIES, 100),
  ];
  const expected = [
    'early', 'boundary', 'larger', 'tie-a', 'tie-b',
    'unknown-amount-a', 'unknown-amount-b', 'unknown-date-large', 'unknown-date-small',
  ];
  assert.deepEqual(ids(sortDeterministic(candidates)), expected);
  assert.deepEqual(ids(sortDeterministic(candidates, { categories: [], today: TODAY })), expected);
  assert.deepEqual(ids(selectWithinBudget(candidates, 3).selected), expected.slice(0, 3));
});

test('AC-5 agnostic threshold is eight of eleven and excludes other', () => {
  assert.deepEqual(AGNOSTIC_CATEGORY_KEYS, INDUSTRIES);
  assert.equal(AGNOSTIC_CATEGORY_KEYS.length, 11);
  assert.equal(AGNOSTIC_CATEGORY_THRESHOLD, 8);
  const seven = row('seven', '2026-11-01', INDUSTRIES.slice(0, 7));
  const eight = { ...seven, [`category_${INDUSTRIES[7]}`]: '1' };
  assert.equal(countIndustryFlags(seven), 7);
  assert.equal(isIndustryAgnostic(seven), false);
  assert.equal(countIndustryFlags(eight), 8);
  assert.equal(isIndustryAgnostic(eight), true);
  assert.equal(countIndustryFlags({ ...seven, category_other: 1 }), 7);
  assert.equal(isIndustryAgnostic({ ...seven, category_other: 1 }), false);
  assert.equal(countIndustryFlags({ category_it: 2, category_medical: '0' }), 0);
});

test('AC-1 specificity requires a selected flagged industry and a non-agnostic row', () => {
  const specific = { category_it: '1' };
  assert.equal(isSpecificIndustryMatch(specific, ['it']), true);
  assert.equal(isSpecificIndustryMatch(specific, ['medical', 'it']), true);
  for (const categories of [undefined, null, [], 'it', ['medical']]) {
    assert.equal(isSpecificIndustryMatch(specific, categories), false);
  }
  assert.equal(isSpecificIndustryMatch(row('all', null, INDUSTRIES), ['it']), false);
});

test('AC-2 urgency uses UTC day boundaries and includes day fourteen only', () => {
  assert.equal(URGENT_DAYS, 14);
  assert.equal(URGENT_WINDOW, 5);
  assert.equal(URGENT_MIN_SLOTS, 2);
  const lateToday = new Date('2026-09-19T23:59:59Z');
  for (const [deadline, days, urgent] of [
    ['2026-09-18', -1, true], ['2026-09-19', 0, true],
    ['2026-10-03', 14, true], ['2026-10-04', 15, false],
    [null, null, false], ['No information', null, false],
  ]) {
    const subsidy = row('deadline', deadline);
    assert.equal(daysUntilDeadline(subsidy, lateToday), days);
    assert.equal(isUrgent(subsidy, lateToday), urgent);
  }
});

test('AC-6 numeric selection forwards categories and today unchanged', () => {
  const candidates = crowdedCandidates();
  const ordered = sortDeterministic(candidates, OPTIONS);
  const { selected, dropped } = selectWithinBudget(candidates, 3, OPTIONS);
  assert.deepEqual(selected, ordered.slice(0, 3));
  assert.equal(dropped, candidates.length - 3);
  assert.deepEqual(selectWithinBudget(candidates, 5, OPTIONS).selected, ordered.slice(0, 5));
  const later = { ...OPTIONS, today: new Date('2026-11-01T00:00:00Z') };
  const laterSelection = selectWithinBudget(candidates, 5, later).selected;
  assert.deepEqual(laterSelection, sortDeterministic(candidates, later).slice(0, 5));
  assert.notDeepEqual(laterSelection, ordered.slice(0, 5));
});

const SHARED_TODAY = new Date('2026-09-21T00:00:00Z');
const SHARED_OPTIONS = { categories: ['it'], today: SHARED_TODAY };
const SPECIFIC_IDS = ['s0', 's1', 's2', 's3', 's4', 's5'];

function sharedCandidates(urgentCount = 4) {
  return [
    ...SPECIFIC_IDS.map((id) => row(id, '2026-11-01')),
    ...Array.from({ length: urgentCount }, (_, i) => row(`u${i}`, '2026-09-25', INDUSTRIES)),
  ];
}

function sharedBudget(countedIds, dailyCap, weeklyCap = 15) {
  const ledger = { ledger_version: 1, entries: {} };
  for (const id of countedIds) {
    recordResult(ledger, { id }, 'dryrun', {
      ok: true, nowIso: SHARED_TODAY.toISOString(), hash: 'sent', notifiedAs: 'new',
    });
  }
  return createBudget(ledger, SHARED_TODAY.getTime(), { dailyCap, weeklyCap });
}

test('shared budget reserves urgent IDs before s0 and s1 exhaust the remaining two IDs', () => {
  const candidates = sharedCandidates(2).filter((s) => s.id !== 's5');
  const budget = sharedBudget(['s2', 's3', 's4'], 5);
  const { selected, dropped } = selectWithinBudget(candidates, budget, SHARED_OPTIONS);
  assert.deepEqual(ids(selected), ['s2', 's3', 's4', 'u0', 'u1']);
  assert.equal(dropped, 2);
  assert.deepEqual(budget.map((window) => window.remaining), [0, 10]);
  for (const window of budget) {
    assert.deepEqual(window.countedIds, new Set(['s2', 's3', 's4', 'u0', 'u1']));
  }
});

for (const limitingWindow of ['daily', 'weekly']) {
  for (const remaining of [1, 2, 3, 4]) {
    test(`shared budget reserves urgent rows with ${limitingWindow} remaining ${remaining}`, () => {
      const candidates = sharedCandidates(2);
      const before = structuredClone(candidates);
      const counted = ['s2', 's3', 's4'];
      const cap = counted.length + remaining;
      const makeBudget = () => sharedBudget(counted,
        limitingWindow === 'daily' ? cap : 15, limitingWindow === 'weekly' ? cap : 15);
      const expected = {
        1: ['s2', 's3', 's4', 'u0'],
        2: ['s2', 's3', 's4', 'u0', 'u1'],
        3: ['s0', 's2', 's3', 'u0', 'u1', 's4'],
        4: ['s0', 's1', 's2', 'u0', 'u1', 's3', 's4'],
      }[remaining];
      const budget = makeBudget();
      const { selected, dropped } = selectWithinBudget(candidates, budget, SHARED_OPTIONS);
      assert.deepEqual(ids(selected), expected);
      assert.equal(selected.slice(0, 5).filter((s) => isUrgent(s, SHARED_TODAY)).length,
        Math.min(2, remaining));
      assert.equal(dropped, candidates.length - expected.length);
      assert.deepEqual(candidates, before);
      const selectedIds = new Set([...counted, ...expected]);
      for (const window of budget) assert.deepEqual(window.countedIds, selectedIds);
      assert.deepEqual(budget.map((window) => window.remaining),
        limitingWindow === 'daily' ? [0, 15 - selectedIds.size] : [15 - selectedIds.size, 0]);
      assert.deepEqual(ids(selectWithinBudget([...candidates].reverse(), makeBudget(),
        SHARED_OPTIONS).selected), expected);
    });
  }
}

test('shared budget rejection leaves every window unchanged before a later urgent reservation', () => {
  const budget = [
    { remaining: 1, countedIds: new Set(SPECIFIC_IDS) },
    { remaining: 0, countedIds: new Set([...SPECIFIC_IDS, 'u1', 'u2']) },
  ];
  const { selected, dropped } = selectWithinBudget(sharedCandidates(3), budget, SHARED_OPTIONS);
  // u0 fails the weekly window; it must not consume the daily slot needed by u1.
  assert.deepEqual(ids(selected), ['s0', 's1', 's2', 'u1', 's3', 's4', 's5']);
  assert.equal(dropped, 2);
  assert.deepEqual(budget[0], { remaining: 0, countedIds: new Set([...SPECIFIC_IDS, 'u1']) });
  assert.deepEqual(budget[1], {
    remaining: 0, countedIds: new Set([...SPECIFIC_IDS, 'u1', 'u2']),
  });
});

test('always-accepted ordering and numeric budgets match the legacy urgent promotion rule', () => {
  // Exhaust urgent/non-urgent assignments in up to eight candidates, including
  // the legacy fourth-position promotion when only one urgent row exists.
  for (let length = 0; length <= 8; length += 1) {
    for (let mask = 0; mask < 2 ** length; mask += 1) {
      const base = Array.from({ length }, (_, i) => row(`id-${i}`,
        mask & (1 << i) ? '2026-09-25' : '2026-11-01', [], length - i + 10));
      // A decreasing amount resolves ties within each deadline group.
      const expected = [...base].sort((a, b) =>
        a.application_deadline.localeCompare(b.application_deadline) || b.maximum_amount - a.maximum_amount);
      // Use specificity to create nontrivial placements across the two groups.
      base.forEach((s, i) => { s.category_it = i < Math.floor(length / 2) ? 1 : 0; });
      expected.sort((a, b) => b.category_it - a.category_it);
      let urgentTaken = 0;
      for (let i = 0; i < Math.min(5, expected.length); i += 1) {
        if (5 - i <= 2 - urgentTaken) {
          const next = expected.findIndex((s, j) => j >= i && isUrgent(s, SHARED_TODAY));
          if (next >= 0) expected.splice(i, 0, ...expected.splice(next, 1));
        }
        if (isUrgent(expected[i], SHARED_TODAY)) urgentTaken += 1;
      }
      const candidates = [...base].reverse();
      assert.deepEqual(sortDeterministic(candidates, SHARED_OPTIONS), expected);
      assert.deepEqual(selectWithinBudget(candidates, sharedBudget([], 20, 20),
        SHARED_OPTIONS).selected, expected);
      for (const cap of [0, 1, 3, 5, 10]) {
        assert.deepEqual(selectWithinBudget(candidates, cap, SHARED_OPTIONS), {
          selected: expected.slice(0, cap), dropped: Math.max(0, length - cap),
        });
      }
    }
  }
});

for (const scenario of [
  {
    name: 'reserve two deliverable urgent rows after uncounted urgent rows fail the budget',
    counted: [...SPECIFIC_IDS, 'u2', 'u3'], cap: 8,
    expected: ['s0', 's1', 's2', 'u2', 'u3', 's3', 's4', 's5'], dropped: 2,
  },
  {
    name: 'promote only the one urgent row that passes the budget',
    counted: [...SPECIFIC_IDS, 'u3'], cap: 7,
    expected: ['s0', 's1', 's2', 'u3', 's3', 's4', 's5'], dropped: 3,
  },
  {
    name: 'preserve base order when no urgent row passes the budget',
    counted: SPECIFIC_IDS, cap: 6,
    expected: ['s0', 's1', 's2', 's3', 's4', 's5'], dropped: 4,
  },
  {
    name: 'preserve base order when no urgent rows exist',
    counted: SPECIFIC_IDS, cap: 6, urgentCount: 0,
    expected: ['s0', 's1', 's2', 's3', 's4', 's5'], dropped: 0,
  },
  {
    name: 'promote exactly two urgent rows when every row is free',
    counted: [...SPECIFIC_IDS, 'u0', 'u1', 'u2', 'u3'], cap: 10,
    expected: ['s0', 's1', 's2', 'u0', 'u1', 's3', 's4', 's5', 'u2', 'u3'], dropped: 0,
  },
  {
    name: 'reserve urgent capacity before ordinary new rows exhaust a five-row budget',
    counted: [], cap: 5,
    expected: ['s0', 's1', 's2', 'u0', 'u1'], dropped: 5,
  },
  {
    name: 'count selected rows rather than rejected ordinary rows toward the first five',
    counted: ['s3', 's4', 's5', 'u2', 'u3'], cap: 5,
    expected: ['s3', 's4', 's5', 'u2', 'u3'], dropped: 5,
  },
]) {
  test(`shared budget: ${scenario.name}`, () => {
    const candidates = sharedCandidates(scenario.urgentCount);
    const before = structuredClone(candidates);
    const budget = sharedBudget(scenario.counted, scenario.cap);
    const { selected, dropped } = selectWithinBudget(candidates, budget, SHARED_OPTIONS);
    assert.deepEqual(ids(selected), scenario.expected);
    assert.equal(dropped, scenario.dropped);
    assert.equal(selected.length + dropped, candidates.length);
    assert.deepEqual(candidates, before);
    const counted = new Set([...scenario.counted, ...scenario.expected]);
    assert.deepEqual(budget.map((window) => window.countedIds), [counted, counted]);
    assert.deepEqual(budget.map((window) => window.remaining),
      [scenario.cap - counted.size, 15 - counted.size]);
    const repeated = selectWithinBudget([...candidates].reverse(),
      sharedBudget(scenario.counted, scenario.cap), SHARED_OPTIONS);
    assert.deepEqual(ids(repeated.selected), scenario.expected);
    assert.equal(repeated.dropped, scenario.dropped);
  });
}

test('shared budget checks every window before reserving an urgent row', () => {
  const candidates = sharedCandidates();
  const budget = [
    { remaining: 2, countedIds: new Set(SPECIFIC_IDS) },
    { remaining: 0, countedIds: new Set([...SPECIFIC_IDS, 'u2', 'u3']) },
  ];
  const { selected, dropped } = selectWithinBudget(candidates, budget, SHARED_OPTIONS);
  assert.deepEqual(ids(selected), ['s0', 's1', 's2', 'u2', 'u3', 's3', 's4', 's5']);
  assert.equal(dropped, 2);
  for (const window of budget) {
    assert.equal(window.remaining, 0);
    assert.deepEqual(window.countedIds, new Set([...SPECIFIC_IDS, 'u2', 'u3']));
  }
});

test('shared budget promotes only one more urgent row when one is already selected', () => {
  const candidates = sharedCandidates();
  candidates[0].application_deadline = '2026-09-25';
  const budget = sharedBudget([...SPECIFIC_IDS, 'u2', 'u3'], 8);
  const { selected, dropped } = selectWithinBudget(candidates, budget, SHARED_OPTIONS);
  assert.deepEqual(ids(selected), ['s0', 's1', 's2', 's3', 'u2', 's4', 's5', 'u3']);
  assert.equal(dropped, 2);
});

test('shared budget skips urgency for missing or invalid today without reading the clock', (t) => {
  const OriginalDate = Date;
  t.mock.method(globalThis, 'Date', class extends OriginalDate {
    constructor(...args) {
      assert.notEqual(args.length, 0, 'must not read the wall clock');
      super(...args);
    }
    static now() { assert.fail('must not read the wall clock'); }
  });
  const invalidDate = new Date('invalid');
  for (const today of [undefined, null, invalidDate, '2026-09-21']) {
    const budget = sharedBudget([...SPECIFIC_IDS, 'u2', 'u3'], 8);
    const { selected, dropped } = selectWithinBudget(sharedCandidates(), budget,
      { categories: ['it'], today });
    assert.deepEqual(ids(selected), ['s0', 's1', 's2', 's3', 's4', 's5', 'u2', 'u3']);
    assert.equal(dropped, 2);
  }
});

test('shared budget preserves deadline ordering without selected categories', () => {
  for (const categories of [undefined, []]) {
    const budget = sharedBudget([...SPECIFIC_IDS, 'u2', 'u3'], 8);
    const { selected, dropped } = selectWithinBudget(sharedCandidates(), budget,
      { categories, today: SHARED_TODAY });
    assert.deepEqual(ids(selected), ['u2', 'u3', 's0', 's1', 's2', 's3', 's4', 's5']);
    assert.equal(dropped, 2);
  }
});
