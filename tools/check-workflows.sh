#!/usr/bin/env bash
# Check all workflow YAML files without optional shell/Python linters.
# Usage: bash tools/check-workflows.sh [workflow_dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW_DIR="${1:-$ROOT/.github/workflows}"
VERSION=1.7.12
if ! command -v actionlint >/dev/null 2>&1; then
  echo "check-workflows: actionlint $VERSION required; run bash tools/install-actionlint.sh and add its directory to PATH" >&2
  exit 1
fi
if ! version="$(actionlint -version)"; then
  echo "check-workflows: cannot read actionlint $VERSION version" >&2
  exit 1
fi
if [ "${version%%$'\n'*}" != "$VERSION" ]; then
  echo "check-workflows: actionlint $VERSION required; run bash tools/install-actionlint.sh and add its directory to PATH" >&2
  exit 1
fi

shopt -s nullglob
workflows=("$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml)
if [ "${#workflows[@]}" -eq 0 ]; then
  echo "check-workflows: no workflows found in $WORKFLOW_DIR" >&2
  exit 1
fi
actionlint -shellcheck= -pyflakes= "${workflows[@]}"
echo "check-workflows: OK"
