#!/usr/bin/env python3
"""Package src/ into a signed-up-ready archive for AMO.

    python tools/build_zip.py            -> dist/devanagari-dict-<version>.zip
    python tools/build_zip.py --out my.zip

The archive is reproducible for a given working tree: entries are sorted,
timestamps are pinned and permissions are normalised, so re-running the tool
without touching a file produces the same hash.

Note that "for a given working tree" is doing real work.  A packer that reads
files from disk also reads whatever line endings they happen to have, and git
rewrites them on checkout: with core.autocrlf=true a fresh clone gets CRLF where
an LF working tree has LF, which changes the archive's bytes.  Pinning line
endings for the repository (a .gitattributes with eol=lf) is what would make two
machines produce the same zip from the same commit.

Dictionary packs are chosen from src/dict/index.json rather than by walking the
directory.  A pack that is built but not in the catalogue is inert at runtime
and must not reach a release: the old Devanagari-headed packs are the obvious
trap, and one of them is CC BY-NC licensed.  Any dict file the catalogue does
not list is reported and skipped.
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
CATALOG = "dict/index.json"

#: Files kept in the repository root that must also travel *inside* the archive.
#: The extension's own licence and the third-party notices are obligations of the
#: distribution, not of the repository: one of the bundled packs is a GPL derived
#: work, and GPLv2 section 1 requires the licence and a copy of its text to
#: accompany the work.  Shipping src/ alone would put a GPL file in the reader's
#: hands with no licence and no notices, which is the one way this bundle really
#: is not safe.
ROOT_DOCS = ("LICENSE", "THIRD_PARTY_NOTICES.md")
LICENSE_DIR = "LICENSES"

#: Catalogue licence substrings that oblige the archive to carry licence text.
#: Creative Commons asks you to link rather than reproduce, which is what
#: THIRD_PARTY_NOTICES.md and the popup footer already do; the GPL insists on the
#: text itself.
NEEDS_LICENCE_TEXT = ("GPL", "GNU General Public License")


def catalogued_packs() -> set:
    """The exact set of dict/ files a release is allowed to contain."""
    allowed = {CATALOG}
    path = os.path.join(SRC, CATALOG)
    if not os.path.exists(path):
        raise SystemExit("cannot package, missing %s - run tools/build_dict.py" % CATALOG)
    with io.open(path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    for pack in catalog.get("packs") or []:
        pack_id = pack.get("id")
        if not pack_id:
            continue
        # A pack over AMO's 5 MB parse limit is written as several shards, so the
        # catalogue lists `files`.  `file` is the older single-file shape.
        names = pack.get("files")
        if not names:
            names = [pack.get("file") or ("dict/%s.json" % pack_id)]
        for name in names:
            # Each name is already relative to src/, the same basis collect() uses.
            allowed.add(name.replace(os.sep, "/").lstrip("/"))
    return allowed


def shipped_licences() -> list:
    """Licence texts from the repository's LICENSES/ directory, for the archive."""
    base = os.path.join(ROOT, LICENSE_DIR)
    if not os.path.isdir(base):
        return []
    return sorted(
        "%s/%s" % (LICENSE_DIR, name)
        for name in os.listdir(base)
        if name.lower().endswith(".txt")
    )


def check_licence_compliance(entries: list) -> list:
    """Refuse to build an archive that ships a copyleft pack without its text.

    A pack whose licence is the GPL is a derived work of a GPL dictionary, so the
    GPL requires the archive to carry the licence text.  Checking it here rather
    than in review means dropping the pack from the catalogue cannot quietly leave
    a non-compliant package behind, and a renamed licence string cannot either.
    """
    path = os.path.join(SRC, CATALOG)
    with io.open(path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    problems = []
    copyleft = [
        (pack.get("id"), str(pack.get("license", "")))
        for pack in catalog.get("packs") or []
        if any(marker in str(pack.get("license", "")) for marker in NEEDS_LICENCE_TEXT)
    ]
    shipped = set(entries)
    texts = sorted(
        name for name in shipped
        if name.startswith(LICENSE_DIR + "/") and name.lower().endswith(".txt")
    )
    for name in ROOT_DOCS:
        if name not in shipped:
            problems.append("the archive must carry %s" % name)
    for name in shipped:
        if not os.path.exists(os.path.join(SRC, name)) \
                and not os.path.exists(os.path.join(ROOT, name)):
            problems.append("%s is listed but is not in the repository" % name)
    for pack_id, licence in copyleft:
        # Any licence text at all is not enough: a Creative Commons text would
        # not discharge a GPL obligation, so the GPL one has to be named.
        if not any("gpl" in name.lower() or "gnu" in name.lower() for name in texts):
            problems.append(
                "pack %s is licensed %s, so the archive must carry a "
                "%s/*.txt copy of that licence" % (pack_id, licence, LICENSE_DIR))
    return problems


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


def selected_entries() -> list:
    """Every src/ file to package, plus the root documents the archive owes."""
    allowed = catalogued_packs()
    kept = []
    skipped = []
    for name in collect(SRC):
        if name.startswith("dict/") and name not in allowed:
            skipped.append(name)
        else:
            kept.append(name)
    kept.extend(shipped_licences())
    for name in ROOT_DOCS:
        full = os.path.join(ROOT, name)
        if os.path.exists(full):
            kept.append(name)
        else:
            print("missing %s in the repository root" % name, file=sys.stderr)
    return sorted(kept), skipped


def build(out_path: str) -> dict:
    with io.open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    entries, skipped = selected_entries()
    required = ["manifest.json", "background/background.js", "content/content.js", CATALOG]
    missing = [name for name in required if name not in entries]
    if missing:
        print("cannot package, missing: %s" % ", ".join(missing), file=sys.stderr)
        return {}
    problems = check_licence_compliance(entries)
    if problems:
        print("cannot package, licence obligations unmet:", file=sys.stderr)
        for problem in problems:
            print("  - %s" % problem, file=sys.stderr)
        return {}

    for name in skipped:
        print("skipped %s (not in %s)" % (name, CATALOG), file=sys.stderr)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if os.path.exists(out_path):
        os.remove(out_path)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in entries:
            full = os.path.join(SRC, name)
            if not os.path.exists(full):
                full = os.path.join(ROOT, name)
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
        entries, skipped = selected_entries()
        for name in entries:
            print(name)
        for name in skipped:
            print("# skipped %s (not in %s)" % (name, CATALOG))
        return 0

    with io.open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as handle:
        version = json.load(handle).get("version", "0.0.0")
    out = args.out or os.path.join(DIST, "devanagari-popup-dict-%s.zip" % version)
    result = build(out)
    return 0 if result else 1


if __name__ == "__main__":
    raise SystemExit(main())
