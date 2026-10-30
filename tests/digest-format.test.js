const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatRate, renderDigest } = require('../lib/digest');

for (const [input, expected] of [
  [0.5, '50%'], [0.6667, '67%'], [0.66, '66%'], [0.02, '2%'],
  [1, '100%'], [0, '0%'],
  ['0.5', '50%'], ['0.6667', '67%'], ['0.66', '66%'], ['0.02', '2%'],
  ['1', '100%'], ['0', '0%'],
  ['2/3', '2/3'], ['定額', '定額'],
  [null, null], [undefined, null], ['', null],
  [1.5, '1.5'], [-0.5, '-0.5'], ['1.5', '1.5'], ['-0.5', '-0.5'],
  [Infinity, 'Infinity'], [NaN, 'NaN'], ['Infinity', 'Infinity'],
]) {
  test(`formatRate(${String(input)}: ${typeof input})`, () => {
    assert.equal(formatRate(input), expected);
  });
}

test('renderDigest formats rates, preserves zero omission and leaves JSON unchanged', () => {
  function render(rate) {
    return renderDigest({
      items: [{ subsidy: { id: 'rate-test', title: 'Rate test', subsidy_rate: rate }, notifiedAs: 'new' }],
      today: '2026-07-10',
      generatedAt: '2026-07-10T00:00:00Z',
    });
  }
  const baseline = render(undefined).json;
  for (const rate of [0, null, undefined, '']) {
    const digest = render(rate);
    assert.doesNotMatch(digest.markdown, /補助率:/);
    assert.deepEqual(digest.json, baseline);
  }
  for (const [rate, expected] of [[0.5, '50%'], ['0', '0%'], ['2/3', '2/3'], [1.5, '1.5']]) {
    const digest = render(rate);
    assert.ok(digest.markdown.includes(`- 補助率: ${expected}\n`));
    assert.deepEqual(digest.json, baseline);
  }
});
