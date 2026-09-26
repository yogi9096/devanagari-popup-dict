#!/usr/bin/env python3
"""Package src/ into a signed-up-ready archive for AMO.

    python tools/build_zip.py            -> dist/devanagari-dict-<version>.zip
    python tools/build_zip.py --out my.zip

The archive is byte-for-byte reproducible: entries are sorted, timestamps are
pinned and permissions are normalised, so re-running the tool on an unchanged
tree produces the same hash.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")

EXCLUDED_DIRS = {"__pycache__", ".git", "node_modules"}
EXCLUDED_SUFFIXES = (".map", ".pyc", ".DS_Store")
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def collect(base: str) -> list:
    files = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        for filename in sorted(filenames):
            if filename.endswith(EXCLUDED_SUFFIXES):
                continue
            full = os.path.join(dirpath, filename)
            files.append(os.path.relpath(full, base).replace(os.sep, "/"))
    return sorted(files)


def build(out_path: str) -> dict:
    with io.open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    entries = collect(SRC)
    required = ["manifest.json", "background/background.js", "content/content.js"]
    missing = [name for name in required if name not in entries]
    if missing:
        print("cannot package, missing: %s" % ", ".join(missing), file=sys.stderr)
        return {}

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if os.path.exists(out_path):
        os.remove(out_path)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in entries:
            full = os.path.join(SRC, name)
            with open(full, "rb") as handle:
                payload = handle.read()
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, payload)

    digest = hashlib.sha256()
    with open(out_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    size = os.path.getsize(out_path)
    print("wrote %s (%d files, %s)" % (
        os.path.relpath(out_path, ROOT), len(entries), human(size)))
    print("sha256 %s" % digest.hexdigest())
    return {"path": out_path, "files": len(entries), "bytes": size,
            "version": manifest.get("version", ""), "name": manifest.get("name", "")}


def human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return "%.1f %s" % (value, unit)
        value /= 1024
    return str(size)


def main(argv: list | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=None, help="output archive path")
    parser.add_argument("--list", action="store_true", help="list the files that would be packaged")
    args = parser.parse_args(argv)

    if args.list:
        for name in collect(SRC):
            print(name)
        return 0

    with io.open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as handle:
        version = json.load(handle).get("version", "0.0.0")
    out = args.out or os.path.join(DIST, "devanagari-popup-dict-%s.zip" % version)
    result = build(out)
    return 0 if result else 1


if __name__ == "__main__":
    raise SystemExit(main())
