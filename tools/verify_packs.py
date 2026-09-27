#!/usr/bin/env python3
"""Validate the built packs in src/dict/ and print a short report.

Checks performed
----------------
* every pack listed in src/dict/index.json exists and parses as JSON
* every shard of a pack is under AMO's 5 MB parse limit (see AMO_MAX_PARSE_BYTES)
* the shards of a pack add up to the catalogue's count and bytes
* entry rows are [headword, pos, gloss, roman, sense] with all five fields
* the headword is the side the reader types, so it must be a Latin-script word
  for the en-x packs shipped here; the gloss is the Devanagari answer
* every index key is a valid loose key and points at rows whose own loose key
  matches (so the runtime can never return the wrong entry)
* no index points outside the entry array, no duplicate row references
* the catalogue and the pack agree on sourceLang/targetLang/count/bytes
* glosses and senses are within the size budget

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
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build_dict as bd  # noqa: E402  (same directory, deliberately simple)

MAX_GLOSS_CHARS = 2400
MAX_SENSE_CHARS = 600
#: addons-linter (AMO's validator) parses a file only while it is smaller than
#: this, and it chooses its scanner from the extension, so a .json at or above it
#: is a hard validation ERROR.  Packs are sharded to stay under it.
AMO_MAX_PARSE_BYTES = 5 * 1024 * 1024
# The reader always points at the headword; for the packs shipped here that side
# is English, and the answer side is Devanagari.
LATIN = re.compile(r"[A-Za-z]")
DEVANAGARI = re.compile(r"[\u0900-\u097f]")


def check_text(value, field, row_number, label, problems, limit, required=True):
    """Every text field must be a string; only some are required to be non-empty."""
    if not isinstance(value, str):
        problems.append("%s: row %d %s is not a string" % (label, row_number, field))
        return ""
    if required and not value.strip():
        problems.append("%s: row %d has an empty %s" % (label, row_number, field))
    elif len(value) > limit:
        problems.append("%s: row %d %s is %d chars" % (label, row_number, field, len(value)))
    return value


def verify_pack(pack_id: str, path: str, problems: list, sample: int, label: str) -> dict:
    with io.open(path, encoding="utf-8") as handle:
        pack = json.load(handle)

    entries = pack.get("entries") or []
    index = pack.get("index") or {}
    target = pack.get("targetLang", "?")
    stats = {
        "id": label,
        "pack": pack_id,
        "entries": len(entries),
        "keys": len(index),
        "bytes": os.path.getsize(path),
        "license": pack.get("license", "?"),
        "target": target,
        "count": pack.get("count"),
        "sourceLang": pack.get("sourceLang"),
        "targetLang": target,
    }

    if pack.get("formatVersion") != bd.FORMAT_VERSION:
        problems.append("%s: formatVersion %r != %r"
                        % (label, pack.get("formatVersion"), bd.FORMAT_VERSION))
    if pack.get("count") != len(entries):
        problems.append("%s: count %r != %d rows" % (label, pack.get("count"), len(entries)))
    if pack.get("id") != pack_id:
        problems.append("%s: pack declares id %r" % (label, pack.get("id")))
    if pack.get("sourceLang") == pack.get("targetLang"):
        problems.append("%s: sourceLang and targetLang are both %r"
                        % (label, pack.get("sourceLang")))

    indexed_rows = set()
    longest_gloss = 0
    latin_headwords = 0
    devanagari_glosses = 0
    for row_number, row in enumerate(entries):
        if not isinstance(row, list) or len(row) != 5:
            problems.append("%s: row %d has shape %r, expected 5 fields"
                            % (label, row_number, row))
            continue
        headword, pos, gloss, roman, sense = row
        check_text(headword, "headword", row_number, label, problems, 240)
        check_text(pos, "pos", row_number, label, problems, 120, required=False)
        check_text(gloss, "gloss", row_number, label, problems, MAX_GLOSS_CHARS)
        check_text(roman, "roman", row_number, label, problems, 240, required=False)
        check_text(sense, "sense", row_number, label, problems, MAX_SENSE_CHARS, required=False)
        longest_gloss = max(longest_gloss, len(gloss or ""))
        if isinstance(headword, str) and LATIN.search(headword):
            latin_headwords += 1
        if isinstance(gloss, str) and DEVANAGARI.search(gloss):
            devanagari_glosses += 1

    # A pack whose answers are not in the target script is either mislabelled or
    # a parser regression, and both are worth failing the build over.
    if entries and devanagari_glosses < len(entries):
        problems.append("%s: %d/%d answers carry no Devanagari (targetLang=%r)"
                        % (label, len(entries) - devanagari_glosses, len(entries), target))
    # A handful of headwords with no Latin is normal for a terminology pack
    # ("1", "0.1 mg. sensitivity balance"), so only a total absence is a fault:
    # that means the rows are stored the other way round.
    if entries and latin_headwords == 0:
        problems.append("%s: no headword carries Latin (sourceLang=%r) - rows look inverted"
                        % (label, pack.get("sourceLang")))
    stats["nonLatin"] = len(entries) - latin_headwords

    for key, positions in index.items():
        if not isinstance(positions, list) or not positions:
            problems.append("%s: index key %r has no positions" % (label, key))
            continue
        if key != bd.loose_key(key):
            problems.append("%s: index key %r is not normalised" % (label, key))
        for position in positions:
            if not isinstance(position, int) or not 0 <= position < len(entries):
                problems.append("%s: index key %r -> bad row %r" % (label, key, position))
                continue
            if position in indexed_rows:
                problems.append("%s: row %d is indexed twice" % (label, position))
            indexed_rows.add(position)
            if bd.loose_key(entries[position][0]) != key:
                problems.append("%s: index key %r -> row %d headword %r"
                                % (label, key, position, entries[position][0]))

    stats["unindexed"] = len(entries) - len(indexed_rows)
    stats["longestGloss"] = longest_gloss
    if stats["unindexed"]:
        for row_number, row in enumerate(entries):
            if row_number not in indexed_rows:
                problems.append("%s: row %d is unreachable (headword %r)"
                                % (label, row_number, row[0] if row else row))
                if len(problems) > 60:
                    break

    if sample:
        for key in list(index)[:sample]:
            rows = [entries[position] for position in index[key] if position < len(entries)]
            print("    %s -> %s" % (
                key,
                " | ".join("%s: %s (%s)" % (row[0], row[2][:60], row[4][:40] or "-")
                           for row in rows)))
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
    parser.add_argument("--dir", default=os.path.join(ROOT, "src", "dict"),
                        help="pack directory")
    args = parser.parse_args(argv)

    index_path = os.path.join(args.dir, "index.json")
    if not os.path.exists(index_path):
        print("no %s - run tools/build_dict.py first" % os.path.relpath(index_path, ROOT),
              file=sys.stderr)
        return 1

    with io.open(index_path, encoding="utf-8") as handle:
        catalog = json.load(handle)

    problems = []
    if catalog.get("formatVersion") != bd.FORMAT_VERSION:
        problems.append("index.json: formatVersion %r != %r"
                        % (catalog.get("formatVersion"), bd.FORMAT_VERSION))

    total_bytes = 0
    total_entries = 0
    total_non_latin = 0
    print("%-22s %-4s %8s %8s %8s %8s %9s %s"
          % ("pack/shard", "lang", "entries", "keys", "unidx", "nlatin", "size", "licence"))
    for item in catalog["packs"]:
        names = item.get("files") or [item.get("file") or (item["id"] + ".json")]
        pack_bytes = 0
        pack_entries = 0
        pack_keys = 0
        for number, name in enumerate(names):
            path = os.path.join(args.dir, os.path.basename(name))
            label = item["id"] if len(names) == 1 else "%s[%d]" % (item["id"], number)
            if not os.path.exists(path):
                problems.append("%s: missing file %s" % (label, path))
                continue
            # AMO's validator will not parse a .json of 5 MB or more and picks
            # its scanner by extension, so a shard over that size is a hard
            # validation error with no opt-out.  Catching it here means a pack
            # that grew too large fails the build rather than the review.
            size = os.path.getsize(path)
            if size >= AMO_MAX_PARSE_BYTES:
                problems.append("%s: %d bytes is at or above AMO's %d byte parse limit; "
                                "lower --max-shard-bytes"
                                % (label, size, AMO_MAX_PARSE_BYTES))
            stats = verify_pack(item["id"], path, problems, args.sample, label)
            # The catalogue is what the UI reads, so a disagreement with the pack
            # would mislabel every answer at runtime.
            for field in ("sourceLang", "targetLang", "license"):
                if item.get(field) != stats.get(field):
                    problems.append("%s: catalogue %s=%r != pack %r"
                                    % (label, field, item.get(field), stats.get(field)))
            pack_bytes += stats["bytes"]
            pack_entries += stats["entries"]
            pack_keys += stats["keys"]
            total_non_latin += stats["nonLatin"]
            print("%-22s %-4s %8d %8d %8d %8d %9s %s" % (
                stats["id"], stats["target"], stats["entries"], stats["keys"],
                stats["unindexed"], stats["nonLatin"],
                bd.human_size(stats["bytes"]), stats["license"] if number == 0 else ""))
        if item.get("bytes") != pack_bytes:
            problems.append("%s: index says %d bytes, shards total %d"
                            % (item["id"], item["bytes"], pack_bytes))
        if item.get("count") != pack_entries:
            problems.append("%s: index says %d entries, shards total %d"
                            % (item["id"], item["count"], pack_entries))
        if item.get("uniqueKeys") is not None and item["uniqueKeys"] > pack_keys:
            problems.append("%s: index says %d unique keys, shards hold %d at most"
                            % (item["id"], item["uniqueKeys"], pack_keys))
        total_bytes += pack_bytes
        total_entries += pack_entries

    print("%-16s %-4s %8d %8s %8s %8d %9s" % (
        "TOTAL", "", total_entries, "", "", total_non_latin, bd.human_size(total_bytes)))

    if problems:
        print("\n%d problem(s):" % len(problems), file=sys.stderr)
        for problem in problems[:40]:
            print("  - %s" % problem, file=sys.stderr)
        return 1
    print("\nall packs OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
