#!/usr/bin/env bash
# Ledger structure gate (state/notified.json).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/tools/lib/check_ledger.py" "${1:-$ROOT/state/notified.json}"
