const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HTTP_FETCH_TIMEOUT_MS,
  loadFeed,
} = require('../lib/feed-client');

const ROOT = path.resolve(__dirname, '..');
const FEED_SAMPLE = path.join(ROOT, 'tests', 'fixtures', 'feed-sample');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-feed-client-'));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('HTTP feed requires subsidies.json.gz and does not fall back to raw JSON', async () => {
  const originalFetch = global.fetch;
  let rawRequested = false;

  function response(status, body = Buffer.alloc(0)) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  global.fetch = async (url) => {
    const name = path.basename(new URL(String(url)).pathname);
    if (name === 'meta.json') {
      return response(200, fs.readFileSync(path.join(FEED_SAMPLE, 'meta.json')));
    }
    if (name === 'subsidies.json') {
      rawRequested = true;
      return response(200, fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json')));
    }
    return response(404, 'not found');
  };

  try {
    await assert.rejects(
      () => loadFeed({ baseUrl: 'https://feed.example.invalid/v1' }),
      /subsidies\.json\.gz/
    );
    assert.strictEqual(rawRequested, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('local feed paths may fall back to raw JSON fixtures', async () => {
  const rawDir = path.join(tmp, 'raw-feed');
  fs.mkdirSync(rawDir);
  fs.copyFileSync(path.join(FEED_SAMPLE, 'meta.json'), path.join(rawDir, 'meta.json'));
  fs.copyFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), path.join(rawDir, 'subsidies.json'));

  const feed = await loadFeed({ baseUrl: rawDir });
  assert.strictEqual(feed.source, 'network');
  assert.strictEqual(feed.data.subsidies.length, 5);
});

test('HTTP fetch timeout is 30 seconds', () => {
  assert.strictEqual(HTTP_FETCH_TIMEOUT_MS, 30 * 1000);
});
