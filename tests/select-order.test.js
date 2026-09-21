const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_KEYS } = require('../lib/match-user-subsidy');
const {
  AGNOSTIC_CATEGORY_KEYS, AGNOSTIC_CATEGORY_THRESHOLD,
  URGENT_DAYS, URGENT_WINDOW, URGENT_MIN_SLOTS,
  countIndustryFlags, isIndustryAgnostic, isSpecificIndustryMatch,
  daysUntilDeadline, isUrgent, sortDeterministic, selectWithinBudget,
} = require('../lib/select');

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
