const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');

function createFixtureRepo(registerCleanup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-e2e-'));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  registerCleanup(cleanup);
  try {
    // Copy fixture inputs and runtime files only; local profiles and channels stay out.
    for (const relative of [
      'runner', 'lib', 'channels/dryrun', 'TERMS.md', 'docs/data-policy.md',
      'profile/delivery-profile.sample.json', 'tests/fixtures',
    ]) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(SOURCE_ROOT, relative), destination, { recursive: true });
    }
    return root;
  } catch (error) {
    cleanup();
    throw error;
  }
}

module.exports = { createFixtureRepo };
