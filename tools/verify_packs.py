#!/usr/bin/env python3
"""Validate the built packs in dict/ and print a short report.

Checks performed
----------------
* every pack listed in dict/index.json exists and parses as JSON
* entry rows are [headword, pos, gloss] or [headword, pos, gloss, roman]
* every index key is a valid loose key and points at rows whose own loose key
  matches (so the runtime can never return the wrong entry)
* no index points outside the entry array, no duplicate row references
* glosses and headwords are non-empty and within the size budget

Usage
-----
    python tools/verify_packs.py
    python tools/verify_packs.py --sample 5
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build_dict as bd  # noqa: E402  (same directory, deliberately simple)

MAX_GLOSS_CHARS = 2400


def verify_pack(pack_id: str, path: str, problems: list, sample: int) -> dict:
    with io.open(path, encoding="utf-8") as handle:
        pack = json.load(handle)

    entries = pack.get("entries") or []
    index = pack.get("index") or {}
    stats = {
        "id": pack_id,
        "entries": len(entries),
        "keys": len(index),
        "bytes": os.path.getsize(path),
        "license": pack.get("license", "?"),
    }

    if pack.get("formatVersion") != bd.FORMAT_VERSION:
        problems.append("%s: formatVersion %r != %r"
                        % (pack_id, pack.get("formatVersion"), bd.FORMAT_VERSION))
    if pack.get("count") != len(entries):
        problems.append("%s: count %r != %d rows" % (pack_id, pack.get("count"), len(entries)))

    indexed_rows = set()
    longest_gloss = 0
    for row_number, row in enumerate(entries):
        if not isinstance(row, list) or len(row) not in (3, 4):
            problems.append("%s: row %d has shape %r" % (pack_id, row_number, row))
            continue
        headword, pos, gloss = row[0], row[1], row[2]
        if not isinstance(headword, str) or not headword.strip():
            problems.append("%s: row %d has an empty headword" % (pack_id, row_number))
        if not isinstance(gloss, str) or not gloss.strip():
            problems.append("%s: row %d has an empty gloss" % (pack_id, row_number))
        elif len(gloss) > MAX_GLOSS_CHARS:
            problems.append("%s: row %d gloss is %d chars" % (pack_id, row_number, len(gloss)))
        longest_gloss = max(longest_gloss, len(gloss or ""))
        if not isinstance(pos, str):
            problems.append("%s: row %d pos is not a string" % (pack_id, row_number))

    for key, positions in index.items():
        if not isinstance(positions, list) or not positions:
            problems.append("%s: index key %r has no positions" % (pack_id, key))
            continue
        if key != bd.loose_key(key):
            problems.append("%s: index key %r is not normalised" % (pack_id, key))
        for position in positions:
            if not isinstance(position, int) or not 0 <= position < len(entries):
                problems.append("%s: index key %r -> bad row %r" % (pack_id, key, position))
                continue
            if position in indexed_rows:
                problems.append("%s: row %d is indexed twice" % (pack_id, position))
            indexed_rows.add(position)
            if bd.loose_key(entries[position][0]) != key:
                problems.append("%s: index key %r -> row %d headword %r"
                                % (pack_id, key, position, entries[position][0]))

    stats["unindexed"] = len(entries) - len(indexed_rows)
    stats["longestGloss"] = longest_gloss
    if stats["unindexed"]:
        for row_number, row in enumerate(entries):
            if row_number not in indexed_rows:
                problems.append("%s: row %d is unreachable (headword %r)"
                                % (pack_id, row_number, row[0] if row else row))
                if len(problems) > 60:
                    break

    if sample:
        for key in list(index)[:sample]:
            rows = [entries[position] for position in index[key] if position < len(entries)]
            print("    %s -> %s" % (key, " | ".join(row[0] + ": " + row[2][:70] for row in rows)))
    return stats


def main(argv: list | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sample", type=int, default=0, help="print N sample entries per pack")
    parser.add_argument("--dir", default=os.path.join(ROOT, "dict"), help="pack directory")
    args = parser.parse_args(argv)

    index_path = os.path.join(args.dir, "index.json")
    if not os.path.exists(index_path):
        print("no dict/index.json - run tools/build_dict.py first", file=sys.stderr)
        return 1

    with io.open(index_path, encoding="utf-8") as handle:
        catalog = json.load(handle)

    problems = []
    total_bytes = 0
    total_entries = 0
    print("%-16s %8s %8s %8s %9s %s" % ("pack", "entries", "keys", "unidx", "size", "licence"))
    for item in catalog["packs"]:
        path = os.path.join(args.dir, item["id"] + ".json")
        if not os.path.exists(path):
            problems.append("%s: missing file %s" % (item["id"], path))
            continue
        if item["bytes"] != os.path.getsize(path):
            problems.append("%s: index says %d bytes, file is %d"
                            % (item["id"], item["bytes"], os.path.getsize(path)))
        stats = verify_pack(item["id"], path, problems, args.sample)
        total_bytes += stats["bytes"]
        total_entries += stats["entries"]
        print("%-16s %8d %8d %8d %9s %s" % (
            stats["id"], stats["entries"], stats["keys"], stats["unindexed"],
            bd.human_size(stats["bytes"]), stats["license"]))

    print("%-16s %8d %8s %8s %9s" % ("TOTAL", total_entries, "", "", bd.human_size(total_bytes)))

    if problems:
        print("\n%d problem(s):" % len(problems), file=sys.stderr)
        for problem in problems[:40]:
            print("  - %s" % problem, file=sys.stderr)
        return 1
    print("\nall packs OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
