#!/usr/bin/env bash
# Pull core-layer updates from the canonical template repo.
#
# Copies every path listed in the UPSTREAM core-manifest.json into this
# working tree, leaving the adopter-owned layer (profile/ state/ channels/my-*
# input/ output/) untouched. Review the diff, then commit.
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

python3 - "$TMP/upstream" <<'EOF'
import json, pathlib, shutil, sys
upstream = pathlib.Path(sys.argv[1])
manifest = json.loads((upstream / "core-manifest.json").read_text())
copied = 0
for rel in manifest["core_paths"]:
    src = upstream / rel
    if not src.is_file():
        print(f"WARN: upstream core path missing, skipped: {rel}", file=sys.stderr)
        continue
    dst = pathlib.Path(rel)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    copied += 1
print(f"copied {copied} core files")
EOF

echo
echo "== changes =="
git status --short
echo
echo "次の手順: 1) git diff で内容確認（育成層が触られていないこと） 2) tools/validate.sh 3) コミット"
