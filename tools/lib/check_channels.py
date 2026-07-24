#!/usr/bin/env python3
"""Channel adapter conformance checker (notifier contract v1, stdlib only).

For every channels/<name>/ directory:
  1. channel.json conforms to schemas/channel-manifest.schema.json rules
     (name == directory name, requires_env patterns, no extra fields)
  2. send exists and is executable
  3. SAITA_FEEDER_DRY_RUN=1 launch with the golden digest fixture exits 0
     (side-effect-free mode is a contract MUST)

Channel-agnostic by design (dr-002): validates the contract, not the payload.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CHANNELS_DIR = ROOT / "channels"
FIXTURE_MD = ROOT / "tests" / "fixtures" / "golden-digest" / "digest-2026-07-10-dryrun.md"
FIXTURE_JSON = ROOT / "tests" / "fixtures" / "golden-digest" / "digest-2026-07-10-dryrun.json"

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ALLOWED_KEYS = {"contract_version", "name", "description", "requires_env", "generated_by", "generated_at"}
REQUIRED_KEYS = {"contract_version", "name", "description", "requires_env"}


def check_manifest(chan_dir, errors):
    manifest_path = chan_dir / "channel.json"
    if not manifest_path.is_file():
        errors.append(f"{chan_dir.name}: channel.json missing")
        return
    try:
        m = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        errors.append(f"{chan_dir.name}: channel.json is not valid JSON: {e}")
        return

    missing = REQUIRED_KEYS - set(m)
    if missing:
        errors.append(f"{chan_dir.name}: channel.json missing keys {sorted(missing)}")
    extra = set(m) - ALLOWED_KEYS
    if extra:
        errors.append(f"{chan_dir.name}: channel.json has unknown keys {sorted(extra)}")

    if m.get("contract_version") != 1:
        errors.append(f"{chan_dir.name}: contract_version must be 1")
    if m.get("name") != chan_dir.name:
        errors.append(f"{chan_dir.name}: channel.json name {m.get('name')!r} != directory name")
    if not isinstance(m.get("description"), str) or not m.get("description"):
        errors.append(f"{chan_dir.name}: description must be a non-empty string")

    envs = m.get("requires_env")
    if not isinstance(envs, list) or not all(isinstance(e, str) and ENV_RE.match(e) for e in envs):
        errors.append(f"{chan_dir.name}: requires_env must be a list of UPPER_SNAKE env var names")


def check_send(chan_dir, errors):
    send = chan_dir / "send"
    if not send.is_file():
        errors.append(f"{chan_dir.name}: send script missing")
        return
    if not os.access(send, os.X_OK):
        errors.append(f"{chan_dir.name}: send is not executable (chmod +x)")
        return

    env = dict(os.environ, SAITA_FEEDER_DRY_RUN="1")
    try:
        res = subprocess.run(
            [str(send), str(FIXTURE_MD)],
            input=FIXTURE_JSON.read_bytes(),
            env=env,
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        errors.append(f"{chan_dir.name}: send timed out in DRY_RUN mode")
        return
    if res.returncode != 0:
        errors.append(
            f"{chan_dir.name}: send must exit 0 under SAITA_FEEDER_DRY_RUN=1 "
            f"(got {res.returncode}; stderr: {res.stderr.decode(errors='replace').strip()[:200]})"
        )


def main():
    errors = []
    if not FIXTURE_MD.is_file():
        print(f"ERROR: fixture digest missing: {FIXTURE_MD}", file=sys.stderr)
        return 1
    if not FIXTURE_JSON.is_file():
        print(f"ERROR: fixture digest JSON missing: {FIXTURE_JSON}", file=sys.stderr)
        return 1

    chan_dirs = sorted(p for p in CHANNELS_DIR.iterdir() if p.is_dir())
    for chan_dir in chan_dirs:
        check_manifest(chan_dir, errors)
        check_send(chan_dir, errors)

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"check-channels: FAIL ({len(errors)} error(s))", file=sys.stderr)
        return 1
    print(f"check-channels: OK ({len(chan_dirs)} channel(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
