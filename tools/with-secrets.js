#!/usr/bin/env node
// Resolve local secrets in memory before starting the requested command.
const { spawnSync } = require('node:child_process');
const { constants } = require('node:os');

const USAGE = 'Usage: node tools/with-secrets.js --provider <executable> --env <name> [--env <name> ...] -- <command> [args...]';

function parseArgs(argv) {
  let provider;
  const names = new Set();
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    const option = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    if (option === '--provider' && !provider) provider = value;
    else if (option === '--env' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) names.add(value);
    else throw new Error(USAGE);
  }
  const command = argv.slice(i + 1);
  if (!provider || !names.size || !command[0]) throw new Error(USAGE);
  return { provider, names, command };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    console.error(USAGE);
    return 1;
  }
  const env = Object.assign(Object.create(null), process.env);
  for (const name of args.names) {
    if (env[name]) continue;
    try {
      const result = spawnSync(args.provider, [name], {
        shell: false, env: process.env, stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error();
      // Remove only the provider's final line ending; preserve secret whitespace.
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(result.stdout).replace(/\r?\n$/, '');
      if (!value || value.includes('\0')) throw new Error();
      env[name] = value;
    } catch {
      // Never print provider output, paths, or exception messages.
      console.error('with-secrets: provider failed; command not started');
      return 1;
    }
  }
  try {
    const result = spawnSync(args.command[0], args.command.slice(1), {
      shell: false, env, stdio: 'inherit',
    });
    if (result.error) throw new Error();
    return result.status ?? (128 + (constants.signals[result.signal] || 1));
  } catch {
    console.error('with-secrets: command could not be started');
    return 1;
  }
}

process.exitCode = main();
