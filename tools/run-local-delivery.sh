#!/usr/bin/env bash
# Run delivery once and persist only the standard ledger.
set -uo pipefail

for arg in "$@"; do
  case "$arg" in
    --ledger|--ledger=*)
      echo 'local-delivery: --ledger is unsupported; use node runner/deliver.js for a custom ledger.' >&2
      exit 1
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
cd "$ROOT" || exit 1
date +%FT%T%z

runner_status=0
node runner/deliver.js "$@" || runner_status=$?

save_ledger() {
  git add -- state/notified.json || return "$?"
  local diff_status=0
  git diff --cached --quiet -- state/notified.json || diff_status=$?
  case "$diff_status" in
    0) return 0 ;;
    1) git commit --only -m "chore: update delivery ledger" -- state/notified.json ;;
    *) return "$diff_status" ;;
  esac
}

ledger_status=0
save_ledger || ledger_status=$?
if [ "$ledger_status" -ne 0 ]; then
  echo "local-delivery: ledger save failed (git exit $ledger_status)" >&2
fi

if [ "$runner_status" -ne 0 ]; then
  exit "$runner_status"
fi
if [ "$ledger_status" -ne 0 ]; then
  exit 3
fi
exit 0
