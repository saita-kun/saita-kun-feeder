#!/usr/bin/env bash
# Feed contract v1 conformance gate.
# Usage: tools/check-feed-contract.sh [feed_dir]
# Default feed_dir: tests/fixtures/feed-sample (self-check of the bundled sample).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEED_DIR="${1:-$ROOT/tests/fixtures/feed-sample}"

exec python3 "$ROOT/tools/lib/check_feed_contract.py" "$FEED_DIR"
