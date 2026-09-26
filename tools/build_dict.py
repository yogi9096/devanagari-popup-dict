#!/usr/bin/env python3
"""Convert the raw sources in tools/.cache into extension dictionary packs in dict/.

The extension format is a compact JSON document:

    {
      "formatVersion": 1,
      "id": "mr-berntsen",
      "name": "...", "sourceLang": "mr", "targetLang": "en",
      "license": "...", "attribution": "...",
      "count": 29464,
      "entries": [["अंक", "m", "1. number. 2. issue ...", "aṅk?"], ...],
      "index":   {"अंक": [0], "अंग": [30, 31]}
    }

`entries` is an array of rows (headword, part-of-speech, gloss, romanisation?) and
`index` maps a *loose lookup key* to row numbers.  The loose key is what both this
script and src/content/normalize.js compute, so it must stay in sync:

    NFD -> drop ZWJ/ZWNJ -> drop nukta -> candrabindu becomes anusvara -> NFC
        -> trim surrounding punctuation -> lowercase

Usage
-----
    python tools/build_dict.py --list
    python tools/build_dict.py --defaults
    python tools/build_dict.py --ids mr-berntsen hi-wiktionary
    python tools/build_dict.py --all --allow-partial
"""

from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(HERE, ".cache")
REGISTRY = os.path.join(HERE, "sources.json")
CACHE_MANIFEST = os.path.join(CACHE_DIR, "fetch-manifest.json")
DEFAULT_OUT = os.path.join(ROOT, "src", "dict")

TOOL_VERSION = "0.1.0"
FORMAT_VERSION = 1

#: Fallback gloss length cap for sources that do not set their own.
DEFAULT_MAX_GLOSS_CHARS = 1500

#: Raw file extension per source format (must match tools/fetch_sources.py).
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

# --------------------------------------------------------------------------- #
# Devanagari helpers (mirrored by src/content/normalize.js)
# --------------------------------------------------------------------------- #

ZWJ = "\u200d"
ZWNJ = "\u200c"
ZERO_WIDTH_SPACE = "\u200b"
NUKTA = "\u093c"
CANDRABINDU = "\u0901"
ANUSVARA = "\u0902"
DANDA = "\u0964"

#: Devanagari (U+0900-U+097F), Vedic Extensions (U+1CD0-U+1CFF) and Devanagari
#: Extended (U+A8E0-U+A8FF).  The astral Devanagari Extended-A block is
#: deliberately excluded: src/common/devanagari.js scans UTF-16 code units, so an
#: astral range would make the two implementations disagree about word edges.
DEVANAGARI_CLASS = "\u0900-\u097f\u1cd0-\u1cff\ua8e0-\ua8ff"
DEVANAGARI_CHAR_RE = re.compile("[%s]" % DEVANAGARI_CLASS)
DEVANAGARI_ONLY_RE = re.compile("^[%s]+$" % DEVANAGARI_CLASS)
LATIN_CHAR_RE = re.compile(r"[A-Za-z\u00c0-\u024f]")
TRIM_CHARS = " \t\r\n" + DANDA + "\u0965.,;:!?\"'()[]{}<>|*-\u2013\u2014\u2018\u2019\u201c\u201d"


def loose_key(word: str) -> str:
    """Normalised key used for lookups. Keep in sync with src/content/normalize.js."""
    if not word:
        return ""
    text = unicodedata.normalize("NFD", word)
    for junk in (ZWJ, ZWNJ, ZERO_WIDTH_SPACE, NUKTA):
        text = text.replace(junk, "")
    text = text.replace(CANDRABINDU, ANUSVARA)
    text = unicodedata.normalize("NFC", text)
    return text.strip(TRIM_CHARS).lower()


def is_devanagari_word(word: str) -> bool:
    return bool(word) and bool(DEVANAGARI_ONLY_RE.match(word))


# --------------------------------------------------------------------------- #
# Text cleanup
# --------------------------------------------------------------------------- #

_TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?/?>")
_JUNK_TOKEN_RE = re.compile(r"<\??[^a-zA-Z>]{0,6}>")
_BRACE_POS_RE = re.compile(r"\((?:\s*[a-z]{1,4}\.?\s*)\)")
_WS_RE = re.compile(r"[ \t]+")
_MULTI_NL_RE = re.compile(r"\n{2,}")

#: Leading grammatical labels used across the source dictionaries.
POS_MARKERS = (
    "adj. inv.", "adj.", "adv.", "prep.", "conj.", "pron.", "post.", "interj.",
    "intj.", "num.", "pref.", "suf.", "part.", "vi.", "vt.", "v.", "n.", "m.",
    "f.", "a.", "c.", "pp.", "inv.", "nm.", "nf.",
    "(nm)", "(nf)", "(v)", "(a)", "(adv)", "(adj)", "(pron)", "(interj)",
    "(n)", "(m)", "(f)", "(num)", "(prep)", "(conj)", "(post)",
    "nm", "nf", "nc", "mc", "mu", "mf",
)
_POS_LOOKUP = {marker.rstrip("."): marker.rstrip(".") for marker in POS_MARKERS}
_POS_LOOKUP.update({marker: marker.rstrip(".") for marker in POS_MARKERS})

#: A romanisation token such as "aṅk", "a:k", "ang".
_ROMAN_RE = re.compile(r"^[A-Za-z\u00c0-\u024f\u0300-\u036f:.^]+$")

#: Part-of-speech values from kaikki/wiktextract that are not worth shipping.
SKIP_KAIKKI_POS = {"Punctuation", "Symbol", "Character", "Letter", "Root", "Diacritical mark"}
KAIKKI_POS_MAP = {
    "noun": "n",
    "verb": "v",
    "adj": "adj",
    "adv": "adv",
    "pron": "pron",
    "conj": "conj",
    "prep": "prep",
    "postp": "postp",
    "num": "num",
    "intj": "interj",
    "particle": "part",
    "name": "prop. n",
    "phrase": "phrase",
    "prefix": "pref",
    "suffix": "suf",
    "infix": "inf",
    "interfix": "interfix",
    "contraction": "contr",
    "proverb": "prov",
    "determiner": "det",
    "article": "art",
}


def clean_text(text: str) -> str:
    """Strip markup and collapse whitespace, keeping the text readable as one line."""
    if not text:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = _TAG_RE.sub(" ", text)
    text = _JUNK_TOKEN_RE.sub(" ", text)
    text = html.unescape(text)
    text = text.replace("\u00a0", " ").replace(ZERO_WIDTH_SPACE, "")
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t]*\n[ \t]*", " ", text)
    text = _WS_RE.sub(" ", text)
    text = _MULTI_NL_RE.sub(" ", text)
    return text.strip()


_GLOSS_START_RE = re.compile("^(?:[A-Z]|\\d|[%s])" % DEVANAGARI_CLASS)


def _looks_like_gloss_start(rest: str) -> bool:
    """True when the text after a bare marker starts like prose rather than more markers."""
    return bool(_GLOSS_START_RE.match(rest.strip()))


def _strip_token(text: str, headwords: set, allow_roman: bool) -> tuple:
    """Peel one leading token off `text`.

    Returns (text_without_token, token_kind, token) where kind is one of
    "roman", "headword", "pos", "none".
    """
    match = re.match(r"^(\S+)(\s*)", text)
    if not match:
        return text, "none", ""
    token = match.group(1)
    rest = text[match.end():]
    bare = token.strip(".,;:")

    if token in POS_MARKERS or _BRACE_POS_RE.fullmatch(token):
        return rest, "pos", token
    if (bare in _POS_LOOKUP and len(bare) <= 6 and not DEVANAGARI_CHAR_RE.search(bare)
            and (token.endswith(".") or token.endswith(",")
                 or len(bare) > 1 or _looks_like_gloss_start(rest))):
        return rest, "pos", bare
    if DEVANAGARI_CHAR_RE.search(token) and bare in headwords:
        return rest, "headword", token
    if allow_roman and _ROMAN_RE.match(token) and 1 < len(token) <= 24 and LATIN_CHAR_RE.search(token):
        return rest, "roman", token
    return text, "none", ""


def split_gloss(raw: str, headwords: set, opts: dict) -> tuple:
    """Turn a raw definition into (gloss, pos_label, romanisation).

    The source dictionaries repeat the headword at the start of the definition
    ("अंक" then "अंक m. 1. number ..."), optionally followed by a romanisation and
    a grammatical label.  This peels those off so the popup shows only the gloss.
    """
    text = clean_text(raw)
    allow_roman = bool(opts.get("romanFromDefinition"))
    roman = ""
    pos_parts = []
    for _ in range(6):
        text, kind, token = _strip_token(text, headwords, allow_roman)
        if kind == "none":
            break
        if kind == "roman":
            if not roman and allow_roman:
                roman = token
        elif kind == "pos" and len(pos_parts) < 3:
            pos_parts.append(token.strip("(). "))

    pos = " ".join(pos_parts).strip()
    if not pos:
        inline = re.match(r"^\((\s*[a-z]{1,4}\.?\s*)\)\s*", text)
        if inline:
            pos = inline.group(1).strip()
            text = text[inline.end():]
    return text.strip(), pos, roman


# --------------------------------------------------------------------------- #
# Source parsers.  Each returns a list of (headword, pos, gloss, roman) rows.
# --------------------------------------------------------------------------- #

_HEADER_RE = re.compile(r"\A(?:[ \t]*#[^\n]*\n)+")


def split_babylon_header(text: str) -> tuple:
    """Return (header_lines, body) for a .babylon source file."""
    match = _HEADER_RE.match(text)
    if not match:
        return [], text
    header = [line.strip() for line in match.group(0).splitlines() if line.strip()]
    return header, text[match.end():]


def _terms_of(terms_line: str, opts: dict) -> list:
    terms = [term.strip() for term in terms_line.split("|")]
    terms = [term for term in terms if term]
    if opts.get("splitCommaTerms") and len(terms) == 1 and "," in terms_line:
        parts = [part.strip() for part in terms_line.split(",")]
        if all(part for part in parts) and len(parts) > 1:
            terms = parts
    return terms


HEADWORD_TRIM_CHARS = " \t\r\n.,;:!?*\"'()[]{}\u2018\u2019\u201c\u201d-|~=\u0964\u0965"


def clean_headword(word: str) -> str:
    """Tidy a raw headword: drop markup artefacts and surrounding punctuation."""
    if not word:
        return ""
    word = clean_text(word)
    word = word.strip(HEADWORD_TRIM_CHARS)
    word = re.sub(r"\s+", " ", word)
    return word


def make_row(headword: str, raw_definition: str, terms_line: str, opts: dict) -> tuple:
    """Build one (headword, pos, gloss, roman) row, or None when unusable."""
    headword = clean_headword(headword)
    if not headword:
        return None
    headwords = {clean_headword(term) for term in _terms_of(terms_line, opts)} | {headword}
    definition = raw_definition
    if opts.get("stripHeadwordPrefix") and terms_line.strip():
        cleaned = clean_text(terms_line)
        if cleaned and definition.startswith(cleaned):
            definition = definition[len(cleaned):].lstrip(" .,;:-")
    gloss, pos, roman = split_gloss(definition, headwords, opts)
    if not gloss:
        return None
    return (headword, pos, gloss, roman)


def parse_babylon(text: str, opts: dict) -> list:
    header, body = split_babylon_header(text)
    meta = {}
    for line in header:
        if "=" in line:
            key, value = line[1:].split("=", 1)
            meta[key.strip()] = value.strip()
    rows = []
    for block in re.split(r"\n[ \t]*\n", body):
        block = block.strip("\n")
        if not block.strip():
            continue
        lines = block.split("\n")
        terms_line = lines[0].strip()
        if not terms_line or terms_line.startswith("#"):
            continue
        definition = " ".join(clean_text(line) for line in lines[1:]).strip()
        if not definition:
            continue
        for term in _terms_of(terms_line, opts):
            row = make_row(term, definition, terms_line, opts)
            if row:
                rows.append(row)
    return rows, meta


def parse_tsv(text: str, opts: dict) -> list:
    """Two-column tab separated source (headword \\t definition)."""
    rows = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        headwords = [part.strip() for part in re.split(r"[,\u0964]", parts[0]) if part.strip()]
        definition = " ".join(clean_text(part) for part in parts[1:] if part.strip())
        for headword in headwords:
            row = make_row(headword, definition, headword, opts)
            if row:
                rows.append(row)
    return rows, {}


def parse_kaikki(handle, opts: dict) -> list:
    """Stream a kaikki.org (wiktextract) JSONL extract."""
    lang_code = opts.get("langCode")
    max_senses = int(opts.get("maxSenses", 5))
    rows = []
    for line in handle:
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue  # a truncated final line from a partial download
        if obj.get("lang_code") != lang_code:
            continue
        word = (obj.get("word") or "").strip()
        if not is_devanagari_word(word):
            continue
        pos_raw = (obj.get("pos") or "").strip()
        if pos_raw in SKIP_KAIKKI_POS:
            continue
        glosses = []
        for sense in (obj.get("senses") or [])[: max_senses * 2]:
            if sense.get("form_of") or sense.get("inflection_of"):
                continue
            if "form-of" in (sense.get("tags") or []):
                continue
            for gloss in sense.get("glosses") or []:
                gloss = clean_text(gloss)
                if gloss and gloss not in glosses:
                    glosses.append(gloss)
                if len(glosses) >= max_senses:
                    break
            if len(glosses) >= max_senses:
                break
        if not glosses:
            continue
        gloss = "; ".join(glosses)
        gloss = re.sub(r"^\s*\([^)]*\)\s*", "", gloss)
        if not gloss:
            continue
        rows.append((word, KAIKKI_POS_MAP.get(pos_raw, pos_raw[:8].lower()), gloss, ""))
    return rows, {}


PARSERS = {
    "babylon": parse_babylon,
    "tsv": parse_tsv,
}


# --------------------------------------------------------------------------- #
# Pack building
# --------------------------------------------------------------------------- #

def truncate(text: str, limit: int | None) -> str:
    """Shorten an over-long gloss at a natural boundary."""
    if not limit or len(text) <= limit:
        return text
    cut = text[:limit]
    for separator in (". ", "; ", ", "):
        position = cut.rfind(separator)
        if position > limit * 0.5:
            return cut[: position + len(separator)].strip()
    return cut.rstrip(" ;,.") + " \u2026"


def prepare_rows(rows: list, max_gloss: int | None, limit: int | None) -> list:
    """Deduplicate, trim and sort the rows of one source."""
    seen = set()
    prepared = []
    for headword, pos, gloss, roman in rows:
        headword = clean_headword(headword)
        gloss = (gloss or "").strip()
        if not headword or not gloss:
            continue
        if not loose_key(headword):
            continue  # nothing the runtime could ever match on
        gloss = truncate(gloss, max_gloss)
        key = (headword, gloss)
        if key in seen:
            continue
        seen.add(key)
        row = [headword, (pos or "").strip(), gloss]
        if roman:
            row.append(roman.strip())
        prepared.append(row)
    prepared.sort(key=lambda row: (row[0], row[1], row[2]))
    if limit:
        prepared = prepared[:limit]
    return prepared


def build_index(rows: list) -> dict:
    index = {}
    for position, row in enumerate(rows):
        key = loose_key(row[0])
        if not key:
            continue
        index.setdefault(key, []).append(position)
    return index


def build_pack(source: dict, entries: list, args) -> dict:
    opts = source.get("options") or {}
    max_gloss = args.max_gloss_chars or opts.get("maxGlossChars") or DEFAULT_MAX_GLOSS_CHARS
    rows = prepare_rows(entries, max_gloss, args.limit)
    index = build_index(rows)
    fetched = args.fetch_manifest.get(source["id"], {})
    return {
        "formatVersion": FORMAT_VERSION,
        "id": source["id"],
        "name": source["name"],
        "description": source.get("description", ""),
        "sourceLang": source["sourceLang"],
        "targetLang": source["targetLang"],
        "license": source["license"],
        "licenseUrl": source.get("licenseUrl", ""),
        "attribution": source.get("attribution", ""),
        "homepage": source.get("homepage", ""),
        "redistributable": bool(source.get("redistribute")),
        "flags": opts.get("flags", []),
        "count": len(rows),
        "uniqueKeys": len(index),
        "entries": rows,
        "index": index,
        "source": {
            "url": source["url"],
            "format": source["format"],
            "sha256": fetched.get("sha256", ""),
            "bytes": fetched.get("size", 0),
            "partial": bool(fetched.get("partial", False)),
        },
        "generatedAt": args.now,
        "generator": "%s %s" % (os.path.basename(__file__), TOOL_VERSION),
    }


def write_json(path: str, payload) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def write_index(out_dir: str, packs: list, args) -> None:
    catalog = {
        "formatVersion": FORMAT_VERSION,
        "generatedAt": args.now,
        "generator": "%s %s" % (os.path.basename(__file__), TOOL_VERSION),
        "packs": [{
            "id": pack["id"],
            "name": pack["name"],
            "description": pack["description"],
            "sourceLang": pack["sourceLang"],
            "targetLang": pack["targetLang"],
            "file": "dict/%s.json" % pack["id"],
            "count": pack["count"],
            "license": pack["license"],
            "licenseUrl": pack["licenseUrl"],
            "attribution": pack["attribution"],
            "homepage": pack["homepage"],
            "redistributable": pack["redistributable"],
            "flags": pack["flags"],
            "default": bool(args.default_ids.get(pack["id"], False)),
            "bytes": pack["_bytes"],
        } for pack in packs],
    }
    catalog["packs"].sort(key=lambda item: (item["sourceLang"], item["id"]))
    size = write_json(os.path.join(out_dir, "index.json"), catalog)
    print("\nwrote dict/index.json (%s, %d packs)" % (human_size(size), len(catalog["packs"])))


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return "%.1f %s" % (value, unit)
        value /= 1024
    return "%d B" % size


# --------------------------------------------------------------------------- #
# Self test
# --------------------------------------------------------------------------- #

BABYLON_FIXTURE = """#bookname=fixture (mr-en)

अंक
अंक m. 1. number. 2. issue (of a magazine, newspaper).

अंग
अंग n. 1. body. 2. part.

अइंचण, अइता, अइरीण
अइंचण, अइता, अइरीण. For words beginning with अइ and अई, see under ऐ.
"""

KAIKKI_FIXTURE = "\n".join([
    '{"word":"अंक","lang_code":"hi","pos":"noun","senses":[{"glosses":["number","digit"]}]}',
    '{"word":"अंक","lang_code":"mr","pos":"noun","senses":[{"glosses":["a number"]}]}',
    '{"word":"अंका","lang_code":"hi","pos":"verb","senses":[{"form_of":[{"word":"अंक"}],"glosses":["infl"]}]}',
    '{"word":"house","lang_code":"hi","pos":"noun","senses":[{"glosses":["x"]}]}',
])


def self_test() -> int:
    failures = []

    def check(label, actual, expected):
        if actual != expected:
            failures.append("%s: expected %r, got %r" % (label, expected, actual))

    check("loose_key nukta", loose_key("क़"), "क")
    check("loose_key zwj", loose_key("क्\u200dष"), "क्ष")
    check("loose_key candrabindu", loose_key("अँ"), "अं")
    check("loose_key danda trim", loose_key("राम।"), "राम")
    check("loose_key latin", loose_key("  House "), "house")
    check("loose_key precomposed nukta", loose_key("\u0958"), "क")

    rows, meta = parse_babylon(BABYLON_FIXTURE, {"stripHeadwordPrefix": True})
    check("babylon meta", meta.get("bookname"), "fixture (mr-en)")
    check("babylon row count", len(rows), 3)
    check("babylon first headword", rows[0][0], "अंक")
    check("babylon first pos", rows[0][1], "m")
    check("babylon first gloss", rows[0][2], "1. number. 2. issue (of a magazine, newspaper).")
    check("babylon last headword", rows[2][0], "अइंचण, अइता, अइरीण")
    check("babylon last gloss", rows[2][2], "For words beginning with अइ and अई, see under ऐ.")

    rows, _ = parse_babylon(BABYLON_FIXTURE, {"stripHeadwordPrefix": True, "splitCommaTerms": True})
    check("babylon comma terms", len(rows), 5)

    rows, _ = parse_kaikki(io.StringIO(KAIKKI_FIXTURE), {"langCode": "hi", "maxSenses": 5})
    check("kaikki rows", len(rows), 1)
    check("kaikki headword", rows[0][0], "अंक")
    check("kaikki pos", rows[0][1], "n")
    check("kaikki gloss", rows[0][2], "number; digit")

    rows, _ = parse_tsv("घर\tघर संज्ञा पुं॰ [सं॰] निवासस्थान ।\n", {})
    check("tsv rows", len(rows), 1)
    check("tsv headword", rows[0][0], "घर")

    prepared = prepare_rows([("अंक", "m", "a" * 20, ""), ("अंक", "m", "a" * 20, "")], 5, None)
    check("truncate+dedupe", (len(prepared), prepared[0][2]), (1, "aaaaa \u2026"))

    if failures:
        print("SELF TEST FAILED")
        for failure in failures:
            print("  - %s" % failure)
        return 1
    print("self test OK")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

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
    parser.add_argument("--self-test", action="store_true", help="run the built-in parser tests and exit")
    parser.add_argument("--ids", nargs="*", default=None, help="only build these source ids")
    parser.add_argument("--all", action="store_true", help="build every fetched source")
    parser.add_argument("--defaults", action="store_true", help="build the sources marked default:true")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output directory (default: dict/)")
    parser.add_argument("--limit", type=int, default=None, help="keep only the first N entries per pack")
    parser.add_argument("--max-gloss-chars", type=int, default=None, help="override the gloss cap")
    parser.add_argument("--allow-partial", action="store_true", help="build from truncated downloads")
    parser.add_argument("--allow-nonredistributable", action="store_true",
                        help="build personal-use packs from copyrighted sources; never publish these")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    sources = load_registry()
    args.now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    args.default_ids = {source["id"]: bool(source.get("default")) for source in sources}
    args.fetch_manifest = {}
    if os.path.exists(CACHE_MANIFEST):
        with io.open(CACHE_MANIFEST, encoding="utf-8") as handle:
            args.fetch_manifest = json.load(handle).get("entries", {})

    if args.list:
        for source in sources:
            cached = args.fetch_manifest.get(source["id"])
            state = "not fetched"
            if cached:
                state = human_size(cached["size"]) + (" (partial)" if cached.get("partial") else "")
            print("%-16s %-4s %-14s %-15s default=%-3s %s" % (
                source["id"], source["sourceLang"], source["format"],
                "redistributable" if source["redistribute"] else "PERSONAL-ONLY",
                "yes" if source.get("default") else "no", state))
        return 0

    if args.ids:
        wanted = set(args.ids)
        selected = [source for source in sources if source["id"] in wanted]
        unknown = wanted - {source["id"] for source in selected}
        if unknown:
            print("unknown source id(s): %s" % ", ".join(sorted(unknown)), file=sys.stderr)
            return 2
    elif args.all:
        selected = list(sources)
    else:
        selected = [source for source in sources if source.get("default")]

    skipped = [source["id"] for source in selected
               if not source["redistribute"] and not args.allow_nonredistributable]
    selected = [source for source in selected
                if source["redistribute"] or args.allow_nonredistributable]
    if skipped:
        print("skipping non-redistributable sources "
              "(pass --allow-nonredistributable to build for personal use): %s" % ", ".join(skipped))

    packs = []
    failures = []
    for source in selected:
        source_id = source["id"]
        cache_file = os.path.join(CACHE_DIR, source_id + EXTENSIONS[source["format"]])
        fetched = args.fetch_manifest.get(source_id)
        if not fetched or not os.path.exists(cache_file):
            print("%-16s SKIP (run: python tools/fetch_sources.py --ids %s)" % (source_id, source_id))
            if args.ids:
                failures.append(source_id)
            continue
        if fetched.get("partial") and not args.allow_partial:
            print("%-16s SKIP (partial download; re-fetch or pass --allow-partial)" % source_id)
            continue

        opts = source.get("options") or {}
        started = time.time()
        try:
            if source["format"] == "kaikki-jsonl":
                with io.open(cache_file, encoding="utf-8", errors="replace") as handle:
                    entries, _ = parse_kaikki(handle, opts)
            else:
                with io.open(cache_file, encoding="utf-8", errors="replace") as handle:
                    entries, _ = PARSERS[source["format"]](handle.read(), opts)
        except Exception as exc:  # noqa: BLE001
            print("%-16s FAILED: %s" % (source_id, exc), file=sys.stderr)
            failures.append(source_id)
            continue

        pack = build_pack(source, entries, args)
        pack["_bytes"] = write_json(os.path.join(args.out, source_id + ".json"), pack)
        packs.append(pack)
        print("%-16s %7d entries -> dict/%s.json (%s) in %.1fs%s" % (
            source_id, pack["count"], source_id, human_size(pack["_bytes"]),
            time.time() - started, " [PARTIAL SOURCE]" if fetched.get("partial") else ""))

    if packs:
        write_index(args.out, packs, args)
    if failures:
        print("failed: %s" % ", ".join(failures), file=sys.stderr)
        return 1
    if not packs:
        print("no packs built")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


