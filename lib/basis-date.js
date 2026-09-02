// application_deadline is a JST calendar date published by Japanese public
// institutions; see docs/design/feed-contract-v1.md §4.1.
const DEADLINE_TIME_ZONE = 'Asia/Tokyo';

function basisDate(ms = Date.now(), timeZone = DEADLINE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type === 'year' || type === 'month' || type === 'day')
      .map(({ type, value }) => [type, value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function basisDateCarrier(dateStr) {
  // This is a UTC-midnight carrier for vendored matchers, not midnight in Tokyo.
  return new Date(`${dateStr}T00:00:00Z`);
}

module.exports = { DEADLINE_TIME_ZONE, basisDate, basisDateCarrier };
