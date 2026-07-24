#!/usr/bin/env python3
"""Feed contract v1 conformance checker (stdlib only).

Validates a feed directory (meta.json + subsidies.json.gz)
against docs/design/feed-contract-v1.md. This is the producer acceptance gate:
a producer's real output must pass this checker.

Usage: check_feed_contract.py [--allow-raw-fixture] <feed_dir>
Exit 0 when conformant; exit 1 with one error per line otherwise.
"""

import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA_MAJOR = "1"

CATEGORY_KEYS = [
    "new_technology", "it", "entertainment", "professional", "agriculture",
    "construction", "wholesale", "finance", "realestate", "hospitality",
    "medical", "other",
]
PURPOSE_KEYS = ["capex", "it_intro", "rd", "hr", "market", "startup", "succession"]

PREFECTURES_ROMAJI = {
    "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima",
    "ibaraki", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa",
    "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu",
    "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara",
    "wakayama", "tottori", "shimane", "okayama", "hiroshima", "yamaguchi",
    "tokushima", "kagawa", "ehime", "kochi", "fukuoka", "saga", "nagasaki",
    "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa", "zenkoku",
}

GOV_LEVELS = {"national", "prefecture", "municipal"}
ELIGIBLE_SCALES = {"small", "sme", "any", None}

ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SCHEMA_VERSION_RE = re.compile(r"^1\.[0-9]+$")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_meta(meta, errors):
    if not isinstance(meta, dict):
        errors.append("meta.json: top level must be an object")
        return

    sv = meta.get("schema_version")
    if not isinstance(sv, str) or not SCHEMA_VERSION_RE.match(sv):
        errors.append(f"meta.json: schema_version must match 1.x, got {sv!r}")

    if not isinstance(meta.get("contract_url"), str) or not meta["contract_url"].startswith("http"):
        errors.append("meta.json: contract_url must be an http(s) URL")

    ga = meta.get("generated_at")
    if not isinstance(ga, str) or not ISO_TIMESTAMP_RE.match(ga):
        errors.append(f"meta.json: generated_at must be UTC ISO 8601 (Z-terminated), got {ga!r}")

    rc = meta.get("row_count")
    if not isinstance(rc, int) or isinstance(rc, bool) or rc < 0:
        errors.append(f"meta.json: row_count must be a non-negative integer, got {rc!r}")

    files = meta.get("files")
    entry = files.get("subsidies.json.gz") if isinstance(files, dict) else None
    if not isinstance(entry, dict):
        errors.append('meta.json: files["subsidies.json.gz"] is required')
    else:
        b = entry.get("bytes")
        if not isinstance(b, int) or isinstance(b, bool) or b < 0:
            errors.append("meta.json: files.subsidies.json.gz.bytes must be a non-negative integer")
        for key in ("sha256", "sha256_uncompressed"):
            v = entry.get(key)
            if not isinstance(v, str) or not SHA256_RE.match(v):
                errors.append(f"meta.json: files.subsidies.json.gz.{key} must be a lowercase hex sha256")

    if meta.get("license") != "CDLA-Permissive-2.0":
        errors.append(f'meta.json: license must be "CDLA-Permissive-2.0", got {meta.get("license")!r}')

    if "deprecated" in meta and not isinstance(meta["deprecated"], bool):
        errors.append("meta.json: deprecated must be a boolean")


def is_flag(v):
    return isinstance(v, int) and not isinstance(v, bool) and v in (0, 1)


def check_row(row, idx, errors):
    where = f"subsidies[{idx}]"
    if not isinstance(row, dict):
        errors.append(f"{where}: must be an object")
        return None, None

    rid = row.get("id")
    if not isinstance(rid, str) or not rid:
        errors.append(f"{where}: id must be a non-empty string, got {rid!r}")

    url = row.get("detailed_url")
    if not isinstance(url, str) or not re.match(r"^https?://", url):
        errors.append(f"{where}: detailed_url must be an http(s) URL")

    if not isinstance(row.get("title"), str) or not row["title"]:
        errors.append(f"{where}: title must be a non-empty string")

    for field in ("description", "municipality", "acceptance_start", "funding_limit",
                  "support_type", "institution_name", "application_deadline"):
        v = row.get(field)
        if v is not None and not isinstance(v, str):
            errors.append(f"{where}: {field} must be string or null, got {type(v).__name__}")

    prefs = row.get("prefectures")
    if not isinstance(prefs, list) or not all(isinstance(p, str) for p in prefs):
        errors.append(f"{where}: prefectures must be an array of strings")
        prefs = []
    else:
        unknown = [p for p in prefs if p not in PREFECTURES_ROMAJI]
        if unknown:
            errors.append(f"{where}: unknown prefecture value(s) {unknown!r}")

    gov = row.get("gov_level")
    if gov not in GOV_LEVELS:
        errors.append(f"{where}: gov_level must be one of {sorted(GOV_LEVELS)}, got {gov!r}")

    # Write invariant (contract §4.3): national <=> ["zenkoku"]
    if gov == "national" and prefs != ["zenkoku"]:
        errors.append(f'{where}: gov_level="national" requires prefectures == ["zenkoku"], got {prefs!r}')
    if gov != "national" and "zenkoku" in prefs:
        errors.append(f'{where}: "zenkoku" is only allowed when gov_level="national"')

    ma = row.get("maximum_amount")
    if ma is not None and not isinstance(ma, (int, float, str)) or isinstance(ma, bool):
        errors.append(f"{where}: maximum_amount must be number, string or null")

    sr = row.get("subsidy_rate")
    if sr is not None and not isinstance(sr, (int, float, str)) or isinstance(sr, bool):
        errors.append(f"{where}: subsidy_rate must be string, number or null")

    if row.get("eligible_scale") not in ELIGIBLE_SCALES:
        errors.append(f"{where}: eligible_scale must be small/sme/any/null, got {row.get('eligible_scale')!r}")

    for key in CATEGORY_KEYS:
        if not is_flag(row.get(f"category_{key}")):
            errors.append(f"{where}: category_{key} must be integer 0 or 1")
    for key in PURPOSE_KEYS:
        if not is_flag(row.get(f"purpose_{key}")):
            errors.append(f"{where}: purpose_{key} must be integer 0 or 1")

    return rid, url


def main(argv):
    allow_raw_fixture = False
    args = argv[1:]
    if args and args[0] == "--allow-raw-fixture":
        allow_raw_fixture = True
        args = args[1:]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    feed_dir = Path(args[0])
    errors = []

    meta_path = feed_dir / "meta.json"
    if not meta_path.is_file():
        print(f"ERROR: {meta_path} not found", file=sys.stderr)
        return 1
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"ERROR: meta.json is not valid JSON: {e}", file=sys.stderr)
        return 1

    check_meta(meta, errors)

    gz_path = feed_dir / "subsidies.json.gz"
    raw_path = feed_dir / "subsidies.json"
    meta_files = meta.get("files") if isinstance(meta.get("files"), dict) else {}
    gz_meta = meta_files.get("subsidies.json.gz") if isinstance(meta_files.get("subsidies.json.gz"), dict) else {}

    data_bytes = None
    if gz_path.is_file():
        gz_bytes = gz_path.read_bytes()
        if isinstance(gz_meta.get("bytes"), int) and gz_meta["bytes"] != len(gz_bytes):
            errors.append(f"integrity: gz size {len(gz_bytes)} != meta bytes {gz_meta['bytes']}")
        if isinstance(gz_meta.get("sha256"), str) and sha256_bytes(gz_bytes) != gz_meta["sha256"]:
            errors.append("integrity: sha256(subsidies.json.gz) does not match meta")
        try:
            data_bytes = gzip.decompress(gz_bytes)
        except OSError as e:
            print(f"ERROR: cannot gunzip subsidies.json.gz: {e}", file=sys.stderr)
            return 1
    elif allow_raw_fixture and raw_path.is_file():
        data_bytes = raw_path.read_bytes()
    elif raw_path.is_file():
        print(
            f"ERROR: subsidies.json.gz is required in {feed_dir} "
            "(use --allow-raw-fixture only for raw local fixtures)",
            file=sys.stderr,
        )
        return 1
    else:
        print(f"ERROR: subsidies.json.gz not found in {feed_dir}", file=sys.stderr)
        return 1

    if isinstance(gz_meta.get("sha256_uncompressed"), str) and \
            sha256_bytes(data_bytes) != gz_meta["sha256_uncompressed"]:
        errors.append("integrity: sha256(uncompressed subsidies.json) does not match meta sha256_uncompressed")

    # When both artifacts are present they must be the same bytes.
    if gz_path.is_file() and raw_path.is_file() and raw_path.read_bytes() != data_bytes:
        errors.append("integrity: subsidies.json and gunzipped subsidies.json.gz differ")

    try:
        data = json.loads(data_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"ERROR: subsidies data is not valid JSON: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict):
        errors.append("data: top level must be an object")
        data = {}

    # Header duplication / skew detection (contract §3)
    if data.get("schema_version") != meta.get("schema_version"):
        errors.append(f"skew: data schema_version {data.get('schema_version')!r} != meta {meta.get('schema_version')!r}")
    if data.get("generated_at") != meta.get("generated_at"):
        errors.append(f"skew: data generated_at {data.get('generated_at')!r} != meta {meta.get('generated_at')!r}")

    subsidies = data.get("subsidies")
    if not isinstance(subsidies, list):
        errors.append("data: subsidies must be an array")
        subsidies = []

    if isinstance(meta.get("row_count"), int) and meta["row_count"] != len(subsidies):
        errors.append(f"skew: meta row_count {meta['row_count']} != actual {len(subsidies)}")

    ids, urls = set(), set()
    for idx, row in enumerate(subsidies):
        rid, url = check_row(row, idx, errors)
        if rid is not None:
            if rid in ids:
                errors.append(f"subsidies[{idx}]: duplicate id {rid!r}")
            ids.add(rid)
        if url is not None:
            if url in urls:
                errors.append(f"subsidies[{idx}]: duplicate detailed_url {url!r}")
            urls.add(url)

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"check-feed-contract: FAIL ({len(errors)} error(s))", file=sys.stderr)
        return 1

    print(f"check-feed-contract: OK ({len(subsidies)} rows, schema {meta.get('schema_version')})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
