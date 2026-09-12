#!/usr/bin/env bash
# Check tracked Markdown links; HTTP verification is opt-in with --external.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/tools/lib/check_doc_links.py" "$ROOT" "$@"
