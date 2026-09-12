#!/usr/bin/env bash
# Install the pinned workflow checker on macOS or Linux (x64/ARM64).
# Usage: bash tools/install-actionlint.sh [install_dir]
set -euo pipefail

VERSION=1.7.12
DEST="${1:-$HOME/.local/bin}"
# Published SHA-256 values: https://github.com/rhysd/actionlint/releases/tag/v1.7.12
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64)
    PLATFORM=darwin_amd64
    SHA256=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  Darwin-arm64)
    PLATFORM=darwin_arm64
    SHA256=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  Linux-x86_64)
    PLATFORM=linux_amd64
    SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  Linux-aarch64|Linux-arm64)
    PLATFORM=linux_arm64
    SHA256=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  *) echo "install-actionlint: unsupported OS/architecture" >&2; exit 1 ;;
esac

ACTIONLINT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/feeder-actionlint.XXXXXX")"
trap 'rm -rf "$ACTIONLINT_TMP"' EXIT
ARCHIVE="actionlint_${VERSION}_${PLATFORM}.tar.gz"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${ARCHIVE}" \
  -o "$ACTIONLINT_TMP/$ARCHIVE"
node - "$ACTIONLINT_TMP/$ARCHIVE" "$SHA256" <<'NODE'
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const actual = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
if (actual !== process.argv[3]) {
  console.error('install-actionlint: SHA-256 mismatch');
  process.exit(1);
}
NODE
tar -xzf "$ACTIONLINT_TMP/$ARCHIVE" -C "$ACTIONLINT_TMP" actionlint
version="$("$ACTIONLINT_TMP/actionlint" -version)"
if [ "${version%%$'\n'*}" != "$VERSION" ]; then
  echo "install-actionlint: expected actionlint $VERSION" >&2
  exit 1
fi
mkdir -p "$DEST"
install -m 755 "$ACTIONLINT_TMP/actionlint" "$DEST/actionlint"
echo "install-actionlint: OK ($VERSION, $DEST/actionlint)"
