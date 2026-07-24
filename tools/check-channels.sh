#!/usr/bin/env bash
# Channel adapter contract gate (notifier contract v1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/tools/lib/check_channels.py"
