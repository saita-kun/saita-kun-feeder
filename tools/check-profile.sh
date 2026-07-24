#!/usr/bin/env bash
# Profile gate. Validates profile/delivery-profile.json when present,
# otherwise the bundled sample (template self-check mode).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT/profile/delivery-profile.json" ]; then
  exec node "$ROOT/tools/lib/check_profile.js" "$ROOT/profile/delivery-profile.json"
else
  exec node "$ROOT/tools/lib/check_profile.js" "$ROOT/profile/delivery-profile.sample.json" --allow-sample
fi
