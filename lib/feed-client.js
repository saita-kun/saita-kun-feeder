/**
 * Feed client for the public subsidy data feed (contract v1).
 *
 * Fetches meta.json + subsidies.json.gz from a base location (http(s) URL or
 * local directory / file:// path), verifies integrity (sha256, header skew,
 * row_count) and falls back to the last known-good cache on any failure
 * (dr-004: graceful degradation). Node stdlib only.
 *
 * Contract SSoT: docs/design/feed-contract-v1.md
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const SUPPORTED_MAJOR = '1';
const STALE_WARN_HOURS = 48;
const STALE_DEAD_DAYS = 14;
const HTTP_FETCH_TIMEOUT_MS = 30 * 1000;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isHttp(base) {
  return /^https?:\/\//.test(base);
}

function stripFileScheme(base) {
  return base.replace(/^file:\/\//, '');
}

function joinFeedUrl(base, name) {
  if (isHttp(base)) return `${base.replace(/\/+$/, '')}/${name}`;
  return path.join(stripFileScheme(base), name);
}

async function fetchBytes(location) {
  if (isHttp(location)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(location, { redirect: 'follow', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${location}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`HTTP fetch timed out after ${HTTP_FETCH_TIMEOUT_MS}ms for ${location}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  return fs.readFileSync(location);
}

function parseGeneratedAt(meta) {
  const t = Date.parse(meta && meta.generated_at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute freshness warnings against a reference time (contract §6).
 * Never hard-fails: staleness is surfaced, delivery continues (dr-004).
 */
function freshnessWarnings(meta, nowMs) {
  const warnings = [];
  const generated = parseGeneratedAt(meta);
  if (generated === null) {
    warnings.push('フィードの generated_at を解釈できません（鮮度不明）');
    return warnings;
  }
  const ageHours = (nowMs - generated) / 3600000;
  if (ageHours > STALE_DEAD_DAYS * 24) {
    warnings.push(
      `フィードが ${Math.floor(ageHours / 24)} 日更新されていません — フィード停止の可能性があります（generated_at: ${meta.generated_at}）`
    );
  } else if (ageHours > STALE_WARN_HOURS) {
    warnings.push(
      `フィードが ${Math.floor(ageHours)} 時間更新されていません — 情報が古い可能性があります（generated_at: ${meta.generated_at}）`
    );
  }
  return warnings;
}

/**
 * Fetch and verify the feed. Returns { meta, data, source, warnings }.
 * source: 'network' | 'cache'. Throws only when both network and cache fail.
 */
async function loadFeed({ baseUrl, cachePath }) {
  const warnings = [];
  let verified = null;

  try {
    verified = await fetchAndVerify(baseUrl);
  } catch (err) {
    warnings.push(`フィード取得に失敗しました: ${err.message}`);
  }

  if (verified) {
    if (cachePath) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ meta: verified.meta, data: verified.data })
      );
    }
    return { ...verified, source: 'network', warnings };
  }

  if (cachePath && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    warnings.push('直近の正常取得キャッシュで継続します（新着は反映されません）');
    return { meta: cached.meta, data: cached.data, source: 'cache', warnings };
  }

  throw new Error(
    `フィードを取得できず、キャッシュもありません（baseUrl: ${baseUrl}）: ${warnings.join(' / ')}`
  );
}

async function fetchAndVerify(baseUrl) {
  const metaBytes = await fetchBytes(joinFeedUrl(baseUrl, 'meta.json'));
  const meta = JSON.parse(metaBytes.toString('utf8'));

  const version = String(meta.schema_version || '');
  if (version.split('.')[0] !== SUPPORTED_MAJOR) {
    throw new Error(`未対応の schema_version です: ${meta.schema_version}（対応 major: ${SUPPORTED_MAJOR}.x）`);
  }

  const fileMeta =
    meta.files && typeof meta.files === 'object' ? meta.files['subsidies.json.gz'] : null;

  let dataBytes;
  let gzBytes;
  try {
    gzBytes = await fetchBytes(joinFeedUrl(baseUrl, 'subsidies.json.gz'));
  } catch (err) {
    if (isHttp(baseUrl)) throw err;
    // Local fixture convenience: uncompressed artifact (still sha256-verified).
    dataBytes = await fetchBytes(joinFeedUrl(baseUrl, 'subsidies.json'));
  }
  if (gzBytes) {
    if (fileMeta && fileMeta.sha256 && sha256(gzBytes) !== fileMeta.sha256) {
      throw new Error('subsidies.json.gz の sha256 が meta.json と一致しません');
    }
    dataBytes = zlib.gunzipSync(gzBytes);
  }

  if (
    fileMeta &&
    fileMeta.sha256_uncompressed &&
    sha256(dataBytes) !== fileMeta.sha256_uncompressed
  ) {
    throw new Error('展開後 subsidies.json の sha256 が meta.json と一致しません');
  }

  const data = JSON.parse(dataBytes.toString('utf8'));

  if (data.schema_version !== meta.schema_version) {
    throw new Error(
      `meta/data の schema_version が一致しません（${meta.schema_version} / ${data.schema_version}）`
    );
  }
  if (data.generated_at !== meta.generated_at) {
    throw new Error(
      `meta/data の generated_at が一致しません（${meta.generated_at} / ${data.generated_at}）`
    );
  }
  if (!Array.isArray(data.subsidies)) {
    throw new Error('subsidies が配列ではありません');
  }
  if (Number.isInteger(meta.row_count) && meta.row_count !== data.subsidies.length) {
    throw new Error(
      `row_count が一致しません（meta: ${meta.row_count} / 実際: ${data.subsidies.length}）`
    );
  }

  return { meta, data };
}

module.exports = {
  STALE_WARN_HOURS,
  STALE_DEAD_DAYS,
  HTTP_FETCH_TIMEOUT_MS,
  loadFeed,
  freshnessWarnings,
  joinFeedUrl,
  sha256,
};
