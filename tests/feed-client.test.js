const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

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

const CACHE_SAVE_WARNING = 'キャッシュ保存に失敗しました（今回取得した検証済みフィードで継続します）';
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function cacheFixture() {
  const dir = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const cachePath = path.join(dir, 'cache.json');
  const previous = {
    meta: JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'meta.json'), 'utf8')),
    data: JSON.parse(fs.readFileSync(path.join(FEED_SAMPLE, 'subsidies.json'), 'utf8')),
  };
  const original = Buffer.from(`${JSON.stringify(previous, null, 2)}\n`);
  fs.writeFileSync(cachePath, original);
  const next = structuredClone(previous);
  next.data.subsidies[0].title += ' (updated)';
  const bytes = Buffer.from(JSON.stringify(next.data));
  const gz = zlib.gzipSync(bytes);
  next.meta.files['subsidies.json.gz'] = {
    bytes: gz.length, sha256: digest(gz), sha256_uncompressed: digest(bytes),
  };
  const baseUrl = fs.mkdtempSync(path.join(tmp, 'feed-'));
  fs.writeFileSync(path.join(baseUrl, 'meta.json'), JSON.stringify(next.meta));
  fs.writeFileSync(path.join(baseUrl, 'subsidies.json.gz'), gz);
  return { dir, cachePath, previous, original, next, baseUrl };
}

test('FEED-22 returns verified data on cache failure', async (t) => {
  const { cachePath, baseUrl, next } = cacheFixture();
  fs.unlinkSync(cachePath);
  const mkdir = t.mock.method(fs, 'mkdirSync', () => {
    throw new Error('injected cache directory failure');
  });
  const feed = await loadFeed({ baseUrl, cachePath });
  assert.strictEqual(mkdir.mock.callCount(), 1);
  assert.deepStrictEqual(feed, { ...next, source: 'network', warnings: [CACHE_SAVE_WARNING] });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('FEED-22 preserves the previous cache', async (t) => {
  for (const failure of ['mkdir', 'partial write', 'rename']) {
    await t.test(failure, async (t) => {
      const { dir, cachePath, previous, original, next, baseUrl } = cacheFixture();
      const error = new Error(`injected ${failure} failure`);
      let injected;
      if (failure === 'mkdir') {
        injected = t.mock.method(fs, 'mkdirSync', () => { throw error; });
      } else if (failure === 'partial write') {
        const write = fs.writeFileSync;
        injected = t.mock.method(fs, 'writeFileSync', (file, data, options) => {
          write(file, data.slice(0, 12), options);
          throw error;
        });
      } else {
        injected = t.mock.method(fs, 'renameSync', () => { throw error; });
      }
      const feed = await loadFeed({ baseUrl, cachePath });
      assert.strictEqual(injected.mock.callCount(), 1);
      assert.deepStrictEqual(feed, { ...next, source: 'network', warnings: [CACHE_SAVE_WARNING] });
      const after = fs.readFileSync(cachePath);
      assert.strictEqual(digest(after), digest(original));
      assert.deepStrictEqual(JSON.parse(after), previous);
      assert.deepStrictEqual(fs.readdirSync(dir), ['cache.json']);
    });
  }
});

test('FEED-22 keeps acquisition failures separate', async (t) => {
  for (const failure of ['missing feed', 'invalid checksum']) {
    await t.test(failure, async (t) => {
      const { cachePath, previous, original, baseUrl, next } = cacheFixture();
      if (failure === 'missing feed') {
        fs.unlinkSync(path.join(baseUrl, 'meta.json'));
      } else {
        next.meta.files['subsidies.json.gz'].sha256 = '0'.repeat(64);
        fs.writeFileSync(path.join(baseUrl, 'meta.json'), JSON.stringify(next.meta));
      }
      const mkdir = t.mock.method(fs, 'mkdirSync', () => {
        assert.fail('acquisition failure must not attempt a cache save');
      });
      const feed = await loadFeed({ baseUrl, cachePath });
      assert.strictEqual(feed.source, 'cache');
      assert.deepStrictEqual(feed.meta, previous.meta);
      assert.deepStrictEqual(feed.data, previous.data);
      assert.strictEqual(feed.warnings.length, 2);
      assert.match(feed.warnings[0], /フィード取得に失敗しました/);
      assert.match(feed.warnings[1], /直近の正常取得キャッシュで継続/);
      assert.deepStrictEqual(fs.readFileSync(cachePath), original);
      fs.unlinkSync(cachePath);
      await assert.rejects(loadFeed({ baseUrl, cachePath }), /フィードを取得できず、キャッシュもありません/);
      assert.strictEqual(mkdir.mock.callCount(), 0);
    });
  }
});

test('FEED-22 creates and replaces cache through unique sibling temporary files', async (t) => {
  const { baseUrl, next, original, cachePath } = cacheFixture();
  const rename = fs.renameSync;
  const temporaryPaths = new Set();
  const creationPath = path.join(tmp, 'new-cache', 'cache.json');
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.strictEqual(path.dirname(from), path.dirname(to));
    assert.notStrictEqual(from, to);
    assert.ok(!temporaryPaths.has(from));
    temporaryPaths.add(from);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(from, 'utf8')), next);
    if (to === cachePath) assert.deepStrictEqual(fs.readFileSync(to), original);
    return rename(from, to);
  });
  for (const destination of [cachePath, creationPath, creationPath]) {
    const feed = await loadFeed({ baseUrl, cachePath: destination });
    assert.deepStrictEqual(feed, { ...next, source: 'network', warnings: [] });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), next);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(destination)), ['cache.json']);
  }
  assert.strictEqual(temporaryPaths.size, 3);
});
