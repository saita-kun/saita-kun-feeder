#!/usr/bin/env node
// Local setup state: support-status [state-file] | merge [state-file] < patch.json
// Paths default to input/setup-state.json relative to the working directory.
const fs = require('node:fs');
const path = require('node:path');

function parseObject(bytes) {
  const value = JSON.parse(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('state and merge patch must be JSON objects');
  }
  return value;
}

function readState(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return parseObject(bytes);
}

function saveState(file, state) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(directory, '.setup-state-'));
  try {
    const staged = path.join(temporary, 'state.json');
    fs.writeFileSync(staged, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(staged, file);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const [command, file = 'input/setup-state.json', ...extra] = process.argv.slice(2);
  if (!['support-status', 'merge'].includes(command) || extra.length) {
    console.error('usage: setup_state.js <support-status|merge> [state-file] (merge reads a JSON object from stdin)');
    return 2;
  }
  try {
    const state = readState(file);
    if (command === 'support-status') {
      console.log(state.support_prompt?.asked_at ? 'skip' : 'ask');
    } else {
      const patch = parseObject(fs.readFileSync(0, 'utf8'));
      saveState(file, { setup_state_version: 1, ...state, ...patch });
      console.log('setup-state: OK');
    }
    return 0;
  } catch (error) {
    console.error(`setup-state: ${error.message}`);
    return 1;
  }
}

process.exitCode = main();
