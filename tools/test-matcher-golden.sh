#!/usr/bin/env bash
# Thin wrapper for the vendored matcher golden suite (dr-005).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --test "$ROOT/tests/match-predicate-golden.test.js"
