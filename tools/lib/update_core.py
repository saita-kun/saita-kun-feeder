#!/usr/bin/env python3
"""Validate the complete upstream manifest before copying core files."""

import json
from pathlib import Path
import shutil
import sys


# Local ownership policy from docs/design/repo-structure.md, never the upstream manifest.
CORE_PREFIXES = (
    ".claude/commands/", "channels/dryrun/", "docs/", "lib/", "runner/",
    "schemas/", "tests/", "tools/",
)
CORE_FILES = {
    ".github/workflows/validate.yml", ".gitignore", ".gitleaks.toml",
    "ADOPTERS.md", "AGENTS.md", "CLAUDE.md", "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md", "LICENSE", "NOTICE", "README.en.md", "README.md",
    "SECURITY.md", "TERMS.md", "TRADEMARK.md", "core-manifest.json",
    "profile/delivery-profile.sample.json",
}
DELIVER_REL = ".github/workflows/deliver.yml"


def validate_relative(rel):
    if (not isinstance(rel, str) or not rel or "\\" in rel or "\0" in rel
            or any(part in ("", ".", "..") for part in rel.split("/"))):
        raise ValueError(f"invalid core path: {rel!r}")
    if rel not in CORE_FILES and not rel.startswith(CORE_PREFIXES):
        raise ValueError(f"path outside local core scope: {rel!r}")


def checked_path(root, rel):
    candidate = root
    for part in rel.split("/"):
        candidate = candidate / part
        # Check before resolving so dangling and in-root links are rejected too.
        if candidate.is_symlink():
            raise ValueError(f"symlink in core path: {candidate}")
    if root not in candidate.resolve().parents:
        raise ValueError(f"path outside root: {candidate}")
    return candidate


def warn_workflow_difference(upstream, root):
    # The adopter-owned workflow is only compared when neither path uses links.
    try:
        src = checked_path(upstream, DELIVER_REL)
        dst = checked_path(root, DELIVER_REL)
    except (OSError, ValueError, RuntimeError):
        return
    if src.is_file() and dst.is_file() and src.read_bytes() != dst.read_bytes():
        print(
            "WARN: .github/workflows/deliver.yml differs from upstream; "
            "/setup-channel may append env:, so it is adopter-owned. "
            "Please review the upstream diff manually.",
            file=sys.stderr,
        )


def update_core(upstream, root):
    manifest = json.loads(checked_path(upstream, "core-manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("core_paths"), list):
        raise ValueError("core_paths must be an array")
    paths = []
    for rel in manifest["core_paths"]:
        validate_relative(rel)
        src, dst = checked_path(upstream, rel), checked_path(root, rel)
        # copy2 treats an existing directory as a container for another path.
        if dst.is_dir():
            raise ValueError(f"core destination is a directory: {rel!r}")
        paths.append((rel, src, dst))

    # No destination directories or files are changed until every path passes.
    warn_workflow_difference(upstream, root)
    copied = 0
    for rel, src, dst in paths:
        if not src.is_file():
            print(f"WARN: upstream core path missing, skipped: {rel}", file=sys.stderr)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    print(f"copied {copied} core files")


if __name__ == "__main__":
    try:
        update_core(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
