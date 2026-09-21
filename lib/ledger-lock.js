const fs = require('node:fs');
const path = require('node:path');

// Resolve each component before applying "..", including inside symlink targets.
function canonicalPath(filename, links = 0, base = fs.realpathSync(process.cwd())) {
  if (links > 40) throw new Error('台帳パスのシンボリックリンクが循環しています');
  const root = path.parse(filename).root;
  let resolved = root || base;
  const segments = filename.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : '/');
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat && stat.isSymbolicLink()) {
      resolved = canonicalPath(fs.readlinkSync(candidate), links + 1, resolved);
    } else {
      // Never give realpath an unresolved suffix: it may normalize ".." lexically.
      resolved = stat ? fs.realpathSync(candidate) : candidate;
    }
  }
  return resolved;
}

function acquireLedgerLock(filename) {
  let ledgerPath = canonicalPath(filename);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  ledgerPath = canonicalPath(ledgerPath);
  const lockPath = `${ledgerPath}.lock`;
  try {
    // Non-recursive mkdir is the exclusive acquisition operation.
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`台帳はロックされています: ${lockPath} — 待機せず終了します。異常終了後の明示復旧は docs/manual.md を参照してください`);
  }
  const owned = fs.statSync(lockPath);
  let released = false;
  return {
    ledgerPath,
    release() {
      if (released) return;
      released = true;
      // Never recursively remove a lock or remove another owner's replacement.
      const current = fs.lstatSync(lockPath);
      if (current.dev !== owned.dev || current.ino !== owned.ino) {
        throw new Error(`台帳ロックの所有権が変わっています: ${lockPath}`);
      }
      fs.rmdirSync(lockPath);
    },
  };
}

module.exports = { acquireLedgerLock };
