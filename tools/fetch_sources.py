#!/usr/bin/env python3
"""Download the raw dictionary sources listed in tools/sources.json.

Usage
-----
    python tools/fetch_sources.py --list
    python tools/fetch_sources.py --defaults
    python tools/fetch_sources.py --ids mr-berntsen hi-wiktionary
    python tools/fetch_sources.py --all --allow-nonredistributable

Downloads land in tools/.cache/<id>.<ext> and are recorded in
tools/.cache/fetch-manifest.json (size + sha256 + partial flag).
Re-running skips files that are already complete.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".cache")
REGISTRY = os.path.join(HERE, "sources.json")
MANIFEST = os.path.join(CACHE_DIR, "fetch-manifest.json")
USER_AGENT = "devanagari-popup-dictionary/0.1 (dictionary build tool)"

EXTENSIONS = {
    "babylon": ".babylon",
    "kaikki-jsonl": ".jsonl",
    "tsv": ".tsv",
    "csv": ".csv",
    "json": ".json",
}


def load_registry() -> list:
    with io.open(REGISTRY, encoding="utf-8") as handle:
        return json.load(handle)["sources"]


def cache_path(source: dict) -> str:
    return os.path.join(CACHE_DIR, source["id"] + EXTENSIONS[source["format"]])


def load_manifest() -> dict:
    if os.path.exists(MANIFEST):
        with io.open(MANIFEST, encoding="utf-8") as handle:
            return json.load(handle)
    return {"entries": {}}


def save_manifest(manifest: dict) -> None:
    with io.open(MANIFEST, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)


def human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return "%.1f %s" % (value, unit)
        value /= 1024
    return str(size)


def _sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dst: str, limit_bytes: int | None) -> tuple:
    """Stream url into dst, resuming from a leftover .part file when possible.

    Returns (bytes_written, sha256, partial).
    """
    tmp = dst + ".part"
    resume_from = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    headers = {"User-Agent": USER_AGENT}
    if resume_from:
        headers["Range"] = "bytes=%d-" % resume_from

    partial = False
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        status = getattr(response, "status", 200) or 200
        if resume_from and status != 206:
            resume_from = 0  # server ignored the Range header; start over
        written = resume_from
        with open(tmp, "ab" if resume_from else "wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                if limit_bytes is not None and written + len(chunk) > limit_bytes:
                    chunk = chunk[: limit_bytes - written]
                    partial = True
                out.write(chunk)
                written += len(chunk)
                sys.stdout.write("\r    %s ..." % human(written))
                sys.stdout.flush()
                if partial:
                    break

    if os.path.exists(dst):
        os.remove(dst)
    os.rename(tmp, dst)
    sys.stdout.write("\r")
    return os.path.getsize(dst), _sha256_of(dst), partial



def _configure_stdio() -> None:
    """Make Devanagari output survivable on legacy Windows consoles."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def main(argv: list | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="list the registered sources and exit")
    parser.add_argument("--ids", nargs="*", default=None, help="only these source ids")
    parser.add_argument("--all", action="store_true", help="fetch every registered source")
    parser.add_argument("--defaults", action="store_true", help="fetch the sources marked default:true")
    parser.add_argument("--allow-nonredistributable", action="store_true",
                        help="also fetch sources whose licence forbids redistribution (personal use only)")
    parser.add_argument("--limit-mb", type=float, default=None,
                        help="truncate downloads (smoke tests); the result is marked partial")
    parser.add_argument("--force", action="store_true", help="re-download even if a complete copy exists")
    args = parser.parse_args(argv)

    sources = load_registry()

    if args.list:
        print("%-16s %-4s %-4s %-14s %-15s %s" % ("id", "src", "tgt", "format", "licence", "default"))
        for source in sources:
            print("%-16s %-4s %-4s %-14s %-15s %s" % (
                source["id"], source["sourceLang"], source["targetLang"], source["format"],
                "redistributable" if source["redistribute"] else "PERSONAL-ONLY",
                "yes" if source.get("default") else "no"))
        return 0

    if args.ids:
        wanted = set(args.ids)
        selected = [s for s in sources if s["id"] in wanted]
        unknown = wanted - {s["id"] for s in selected}
        if unknown:
            print("unknown source id(s): %s" % ", ".join(sorted(unknown)), file=sys.stderr)
            return 2
    elif args.all:
        selected = list(sources)
    else:
        selected = [s for s in sources if s.get("default")]

    skipped = [s["id"] for s in selected
               if not s["redistribute"] and not args.allow_nonredistributable]
    selected = [s for s in selected
                if s["redistribute"] or args.allow_nonredistributable]
    if skipped:
        print("skipping non-redistributable sources "
              "(pass --allow-nonredistributable to fetch): %s" % ", ".join(skipped))

    if not selected:
        print("nothing to fetch")
        return 0

    os.makedirs(CACHE_DIR, exist_ok=True)
    manifest = load_manifest()
    limit = int(args.limit_mb * 1024 * 1024) if args.limit_mb else None
    failures = []

    for source in selected:
        dst = cache_path(source)
        previous = manifest["entries"].get(source["id"])
        if previous and not previous.get("partial") and os.path.exists(dst) and not args.force:
            print("%-16s cached (%s)" % (source["id"], human(previous["size"])))
            continue
        print("%-16s fetching %s" % (source["id"], source["url"]))
        started = time.time()
        try:
            size, sha, partial = download(source["url"], dst, limit)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            print("    FAILED: %s" % exc, file=sys.stderr)
            failures.append(source["id"])
            continue
        manifest["entries"][source["id"]] = {
            "file": os.path.basename(dst),
            "url": source["url"],
            "size": size,
            "sha256": sha,
            "partial": partial,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save_manifest(manifest)
        print("    ok %s in %.1fs%s"
              % (human(size), time.time() - started, " (PARTIAL)" if partial else ""))

    if failures:
        print("failed: %s" % ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
