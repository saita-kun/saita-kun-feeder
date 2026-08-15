#!/usr/bin/env node
/**
 * Profile checker. Written in Node (not Python) so the category/purpose enums
 * come straight from the vendored matcher — no duplicated lists to drift.
 * Also cross-checks that schemas/delivery-profile.schema.json enums match
 * the matcher (single-source guarantee promised in the schema description).
 *
 * Usage: check_profile.js <profile.json> [--allow-sample]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { CATEGORY_KEYS, PURPOSE_KEYS } = require(path.join(ROOT, 'lib', 'match-user-subsidy'));
const { prefectureMapping } = require(path.join(ROOT, 'lib', 'prefecture-mapper'));

const SHA256_RE = /^[0-9a-f]{64}$/;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER_TLDS = ['invalid', 'example', 'test'];
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net'];

function isPlaceholderFeedBaseUrl(value) {
  if (value.includes('REPLACED-BY-SETUP')) return true;

  try {
    const hostname = new URL(value).hostname.replace(/\.$/, '');
    return PLACEHOLDER_TLDS.some((tld) => hostname === tld || hostname.endsWith(`.${tld}`)) ||
      EXAMPLE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const allowSample = args.includes('--allow-sample');
  const profilePath = args.filter((a) => !a.startsWith('--'))[0];
  if (!profilePath) {
    console.error('usage: check_profile.js <profile.json> [--allow-sample]');
    return 2;
  }

  const errors = [];

  // Schema <-> matcher enum sync (drift here would silently break matching)
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'delivery-profile.schema.json'), 'utf8')
  );
  const schemaCategories = schema.properties.categories.items.enum;
  const schemaPurposes = schema.properties.purposes.items.enum;
  if (JSON.stringify(schemaCategories) !== JSON.stringify(CATEGORY_KEYS)) {
    errors.push('schema categories enum != matcher CATEGORY_KEYS (update schemas/delivery-profile.schema.json)');
  }
  if (JSON.stringify(schemaPurposes) !== JSON.stringify(PURPOSE_KEYS)) {
    errors.push('schema purposes enum != matcher PURPOSE_KEYS (update schemas/delivery-profile.schema.json)');
  }

  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: ${profilePath} is not valid JSON: ${e.message}`);
    return 1;
  }

  if (profile.profile_version !== 1) errors.push(`profile_version must be 1, got ${profile.profile_version}`);

  if (typeof profile.terms_accepted_sha256 !== 'string' ||
      (!SHA256_RE.test(profile.terms_accepted_sha256) &&
        !(allowSample && profile.terms_accepted_sha256 === 'REPLACED-BY-SETUP'))) {
    errors.push('terms_accepted_sha256 must be a sha256 hex (run /setup to consent)');
  }

  if (typeof profile.company_prefecture !== 'string' || !prefectureMapping[profile.company_prefecture]) {
    errors.push(`company_prefecture must be a Japanese prefecture name, got ${JSON.stringify(profile.company_prefecture)}`);
  }
  if (profile.company_municipality !== null && profile.company_municipality !== undefined &&
      typeof profile.company_municipality !== 'string') {
    errors.push('company_municipality must be string or null');
  }
  if (profile.include_nationwide !== undefined && typeof profile.include_nationwide !== 'boolean') {
    errors.push('include_nationwide must be a boolean');
  }

  for (const [field, allowed] of [['categories', CATEGORY_KEYS], ['purposes', PURPOSE_KEYS]]) {
    const v = profile[field];
    if (v === null || v === undefined) continue;
    if (!Array.isArray(v)) {
      errors.push(`${field} must be an array or null`);
      continue;
    }
    const bad = v.filter((x) => !allowed.includes(x));
    if (bad.length) errors.push(`${field} contains unknown value(s): ${JSON.stringify(bad)} (allowed: ${allowed.join(', ')})`);
  }

  for (const field of ['amount_min', 'amount_max', 'subsidy_rate_min']) {
    const v = profile[field];
    if (v !== null && v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`${field} must be a number or null`);
    }
  }
  for (const field of ['employee_count', 'deadline_buffer_days']) {
    const v = profile[field];
    if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 0)) {
      errors.push(`${field} must be a non-negative integer or null`);
    }
  }
  for (const field of ['weekly_cap', 'daily_cap']) {
    const v = profile[field];
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
      errors.push(`${field} must be a positive integer`);
    }
  }

  if (typeof profile.feed_base_url !== 'string' || !profile.feed_base_url) {
    errors.push('feed_base_url must be a non-empty string');
  } else if (isPlaceholderFeedBaseUrl(profile.feed_base_url)) {
    errors.push(`feed_base_url is a placeholder (${JSON.stringify(profile.feed_base_url)}) — set the real feed URL (see https://www.subsidy-support.tech/llms.txt "公開データフィード")`);
  }

  if (!Array.isArray(profile.channels)) {
    errors.push('channels must be an array');
  } else {
    profile.channels.forEach((ch, i) => {
      if (!ch || typeof ch !== 'object' || typeof ch.name !== 'string' || !CHANNEL_NAME_RE.test(ch.name)) {
        errors.push(`channels[${i}]: name must match ${CHANNEL_NAME_RE}`);
        return;
      }
      if (ch.enabled !== undefined && typeof ch.enabled !== 'boolean') {
        errors.push(`channels[${i}]: enabled must be a boolean`);
      }
      if (ch.enabled !== false && !fs.existsSync(path.join(ROOT, 'channels', ch.name, 'send'))) {
        errors.push(`channels[${i}]: channels/${ch.name}/send does not exist (run /setup-channel)`);
      }
    });
  }

  // Secrets must never live in the profile.
  const raw = fs.readFileSync(profilePath, 'utf8');
  if (/hooks\.slack\.com|api\.line\.me|smtp:\/\/|password|secret|token/i.test(raw)) {
    errors.push('profile appears to contain a secret-like value — secrets belong in GHA Secrets / env (notifier contract §4)');
  }

  if (errors.length) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error(`check-profile: FAIL (${errors.length} error(s))`);
    return 1;
  }
  console.log(`check-profile: OK (${profilePath})`);
  return 0;
}

process.exitCode = main();
