#!/usr/bin/env python3
"""Ledger structure checker (schemas/ledger.schema.json rules, stdlib only)."""

import json
import re
import sys
from pathlib import Path

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CH_REQUIRED = {"status", "first_notified_at", "last_attempt_at", "retry_count", "notified_as"}


def main(argv):
    ledger_path = Path(argv[1]) if len(argv) > 1 else Path("state/notified.json")
    errors = []
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"ERROR: cannot read {ledger_path}: {e}", file=sys.stderr)
        return 1

    if ledger.get("ledger_version") != 1:
        errors.append(f"ledger_version must be 1, got {ledger.get('ledger_version')!r}")
    entries = ledger.get("entries")
    if not isinstance(entries, dict):
        errors.append("entries must be an object")
        entries = {}

    for sid, entry in entries.items():
        where = f"entries[{sid!r}]"
        if not isinstance(entry, dict):
            errors.append(f"{where}: must be an object")
            continue
        if not isinstance(entry.get("content_hash"), str) or not SHA256_RE.match(entry["content_hash"]):
            errors.append(f"{where}: content_hash must be a sha256 hex")
        channels = entry.get("channels")
        if not isinstance(channels, dict):
            errors.append(f"{where}: channels must be an object")
            continue
        for cname, ch in channels.items():
            cw = f"{where}.channels[{cname!r}]"
            if not isinstance(ch, dict):
                errors.append(f"{cw}: must be an object")
                continue
            missing = CH_REQUIRED - set(ch)
            if missing:
                errors.append(f"{cw}: missing {sorted(missing)}")
            extra = set(ch) - CH_REQUIRED
            if extra:
                errors.append(f"{cw}: unknown keys {sorted(extra)}")
            if ch.get("status") not in ("sent", "failed"):
                errors.append(f"{cw}: status must be sent|failed")
            if ch.get("notified_as") not in ("new", "updated"):
                errors.append(f"{cw}: notified_as must be new|updated")
            rc = ch.get("retry_count")
            if not isinstance(rc, int) or isinstance(rc, bool) or rc < 0:
                errors.append(f"{cw}: retry_count must be a non-negative integer")

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"check-ledger: FAIL ({len(errors)} error(s))", file=sys.stderr)
        return 1
    print(f"check-ledger: OK ({len(entries)} entrie(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
