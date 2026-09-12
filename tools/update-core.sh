#!/usr/bin/env bash
# Pull core-layer updates from the canonical template repo.
#
# Validates the UPSTREAM core-manifest.json against the local core scope
# before copying any files. Adopter-owned files stay untouched; the sample
# profile and channels/dryrun are core. Review the diff, then commit.
#
# Usage: tools/update-core.sh [upstream-repo-url]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="${1:-https://github.com/saita-kun/saita-kun-feeder.git}"

cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree is dirty — commit or stash before update-core" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetching upstream: $UPSTREAM"
git clone --depth 1 --quiet "$UPSTREAM" "$TMP/upstream"

python3 "$ROOT/tools/lib/update_core.py" "$TMP/upstream" "$ROOT"

echo
echo "== changes =="
git status --short
echo
echo "次の手順: 1) git diff で内容確認（育成層が触られていないこと） 2) tools/validate.sh 3) コミット"
