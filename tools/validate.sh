#!/usr/bin/env bash
# Aggregate validation gate. Green here = the repo is structurally sound.
# Checkers live in the runtime nearest to their subject: feed/channels/ledger
# checkers are Python (standalone rules), the profile checker is Node (its
# enums come straight from the vendored matcher — no duplicated lists).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
step() {
  local label="$1"
  shift
  echo "== $label"
  if ! "$@"; then
    echo "== FAIL: $label"
    fail=1
  fi
}

# 1. Core manifest: every core path must exist
step "core-manifest paths" python3 - <<'EOF'
import json, pathlib, sys
manifest = json.loads(pathlib.Path("core-manifest.json").read_text())
missing = [p for p in manifest["core_paths"] if not pathlib.Path(p).exists()]
for p in missing:
    print(f"ERROR: core path missing: {p}", file=sys.stderr)
sys.exit(1 if missing else 0)
EOF

# 2. Contract / profile / channels / ledger gates
step "check-feed-contract" tools/check-feed-contract.sh
step "check-profile" tools/check-profile.sh
step "check-channels" tools/check-channels.sh
step "check-ledger" tools/check-ledger.sh

# 3. Test suite (golden matcher fixtures + E2E)
step "node --test" node --test

if [ "$fail" -ne 0 ]; then
  echo "validate: FAIL"
  exit 1
fi
echo "validate: OK"
