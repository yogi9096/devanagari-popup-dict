#!/usr/bin/env python3
"""Convert the raw sources in tools/.cache into extension dictionary packs in dict/.

The extension format is a compact JSON document:

    {
      "formatVersion": 1,
      "id": "en-wiktionary-hi",
      "name": "...", "sourceLang": "en", "targetLang": "hi",
      "license": "...", "attribution": "...",
      "count": 81234,
      "entries": [["dictionary", "n", "शब्दकोश", "śabdakōś", "reference work of words and their meanings"], ...],
      "index":   {"dictionary": [0], "word": [30, 31]}
    }

`entries` is an array of rows
(headword, part-of-speech, translation/gloss, romanisation?, english-sense?) and
`index` maps a *loose lookup key* to row numbers.  The loose key is what both this
script and src/content/normalize.js compute, so it must stay in sync:

    NFD -> drop ZWJ/ZWNJ -> drop nukta -> candrabindu becomes anusvara -> NFC
        -> trim surrounding punctuation -> lowercase

The reader points at an English word and the popup answers in Hindi or Marathi,
so for the shipped packs the headword is the English word and the third column
is the Devanagari translation.  Sources that run the other way (Hindi/Marathi
headword, English gloss) use the identical row shape.

Usage
-----
    python tools/build_dict.py --list
    python tools/build_dict.py --defaults
    python tools/build_dict.py --ids en-wiktionary-hi en-wiktionary-mr en-raghuvira
    python tools/build_dict.py --all --allow-partial
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import html
import io
import json
import os
import re
import sys
import tarfile
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(HERE, ".cache")
REGISTRY = os.path.join(HERE, "sources.json")
CACHE_MANIFEST = os.path.join(CACHE_DIR, "fetch-manifest.json")
DEFAULT_OUT = os.path.join(ROOT, "src", "dict")

TOOL_VERSION = "0.2.0"
FORMAT_VERSION = 2

#: Fallback gloss length cap for sources that do not set their own.
DEFAULT_MAX_GLOSS_CHARS = 1500

#: AMO's validator (addons-linter) refuses to *parse* any file of 5 MB or more,
#: and it picks its scanner from the file extension, so a .json pack at or above
#: that size is a hard validation ERROR with no opt-out.  A pack is therefore
#: written as one or more shards, each comfortably under the limit; 4 MB leaves
#: room for the shard metadata and stays clear of the threshold.
MAX_SHARD_BYTES = 4 * 1024 * 1024

#: Fraction of a shard's byte budget spent on entry rows.  The rest has to cover
#: the index and the metadata, which are not in the row budget and whose size
#: depends on the data; the split is corrected against the real serialised size
#: below, so this only decides how many correction rounds are needed.
SHARD_ROW_FRACTION = 0.75

#: Raw file extension per source format (must match tools/fetch_sources.py).
EXTENSIONS = {
    "babylon": ".babylon",
    "kaikki-jsonl": ".jsonl",
    "kaikki-en-translations": ".jsonl",
    "tsv": ".tsv",
    "csv": ".csv",
    "json": ".json",
    "stardict-dictd": ".tar.gz",
}

#: Formats that are streamed line by line instead of read into memory.  The
#: English Wiktextract dump is 3.2 GB, so it must never be slurped.
STREAMING_FORMATS = {"kaikki-jsonl", "kaikki-en-translations"}

#: Formats that must be read as bytes rather than decoded as text, because the
#: parser opens a compressed archive out of the bytes itself.
BINARY_FORMATS = {"stardict-dictd"}


def load_registry() -> list:
    with io.open(REGISTRY, encoding="utf-8") as handle:
        return json.load(handle)["sources"]


def cache_id(source: dict) -> str:
    """Manifest/cache key for a source.  Mirrors tools/fetch_sources.py.

    `en-wiktionary-hi` and `en-wiktionary-mr` are one download read two ways, so
    both name the same `sharedCache` id instead of fetching 3.2 GB each.
    """
    return source.get("sharedCache") or source["id"]


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


#: Cap on how many Devanagari terms one answer line may contribute, so a headword
#: with fifty synonyms does not turn the popup into a wall of text.
MAX_TERMS_PER_ANSWER = 6

#: Everything that may sit *inside* one Devanagari term.  Latin letters are
#: deliberately absent, so any English word is a boundary between two terms.
_TERM_SPLIT_RE = re.compile(
    "[^" + DEVANAGARI_CLASS
    + "\\s,.\u0964\u0965'()\\[\\]/%&+-]+")

#: Latin markers Raghuvira glues onto a term ("राष्ट्र n. (Const.)").
_LATIN_MARKER_RE = re.compile(
    r"(?:^|[\s(])(?:m|n|f|v|vb|vt|vi|vz|a|adj|adv|prep|conj|interj|pl|sg|const|no|pass)\s*\.\s*"
    r"(?=$|[\s)])",
    re.IGNORECASE)

_DEVA_START_RE = re.compile("[%s]" % DEVANAGARI_CLASS)


def extract_english_head_answer(text: str, max_terms: int = MAX_TERMS_PER_ANSWER) -> tuple:
    """Split an English-head dictionary line into (hindi_terms, english_sense).

    The Raghuvira dictionary writes one long line per headword that mixes a
    subject label, the English definition and the Devanagari terms:

        Finance (to add to the aggregate par value of stock ...) अधिपुञ्जीयन, तरलन
        Law n. राष्ट्र n. (Const.) (see country)
        Commerce and Accounts पुस्तक n. account book लेखा पुस्त, बही खाता bills payable book ...

    For a popup keyed on the English word the reader pointed at, only the
    Devanagari is the answer; the English is context that explains *which* meaning
    the term answers, so it is returned separately as the sense.
    """
    match = _DEVA_START_RE.search(text)
    if not match:
        return "", text.strip()
    english = text[: match.start()].strip(" ,;:.-")
    answer = text[match.start():]

    terms = []
    seen = set()
    for chunk in _TERM_SPLIT_RE.split(answer):
        chunk = _LATIN_MARKER_RE.sub(" ", chunk)
        chunk = chunk.strip(" .,;:()[]/'")
        chunk = re.sub(r"\s+", " ", chunk)
        if not chunk or not DEVANAGARI_CHAR_RE.search(chunk):
            continue
        # A chunk can open a parenthesis whose closing half sits in the English
        # part we already split off ("Physics Phys. चू (प्रदूषणशक्ति)"), so put
        # the missing half back rather than showing a dangling "(".
        opens = chunk.count("(")
        closes = chunk.count(")")
        if opens > closes:
            chunk += ")" * (opens - closes)
        elif closes > opens:
            chunk = "(" * (closes - opens) + chunk
        if chunk in seen:
            continue
        seen.add(chunk)
        terms.append(chunk)
        if len(terms) >= max_terms:
            break
    return "; ".join(terms), clean_text(english)


def make_row(headword: str, raw_definition: str, terms_line: str, opts: dict) -> tuple:
    """Build one (headword, pos, gloss, roman, sense) row, or None when unusable."""
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
    sense = ""
    if opts.get("englishHead"):
        # The line is English-first: keep only the Devanagari as the answer.
        gloss, sense = extract_english_head_answer(gloss)
    if not gloss:
        return None
    return (headword, pos, gloss, roman, sense)


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
        rows.append((word, KAIKKI_POS_MAP.get(pos_raw, pos_raw[:8].lower()), gloss, "", ""))
    return rows, {}


# --------------------------------------------------------------------------- #
# English -> Hindi (FreeDict / Anusaaraka, a dictd database in a tarball)
# --------------------------------------------------------------------------- #

#: dictd part-of-speech tags, mapped onto the short markers the other sources
#: use.  dictd spells them <N>, <V>, <VT>, <VTI>, <Adj>, <PhrV> and so on.
DICTD_POS_MAP = {
    "n": "n", "noun": "n", "propn": "name", "abbr": "n",
    "n/adj": "n", "n/det": "n", "n/pron": "n", "n/interj": "n",
    "v": "v", "vt": "v", "vi": "v", "vti": "v", "auxv": "v", "vneg": "v",
    "mv": "v", "vp": "v", "phrv": "v", "phrvt": "v", "phrvi": "v",
    "adj": "a", "adv": "adv", "prep": "prep", "conj": "conj",
    "pron": "pron", "pron/det": "det", "det/pron": "det", "interj": "interj",
    "interro": "interj", "det": "det", "num": "num", "art": "art",
    "pref": "prefix", "suffix": "suffix", "part": "part", "idm": "phrase",
}

#: A headword is the Latin text sitting immediately before a trailing part-of-
#: speech tag.  The 1999-vintage source very often omits the newline after an
#: example sentence, so the next headword arrives glued onto it:
#:
#:     16547  '      "He is an easygoing person."eat <VI>'
#:      945  '1. क्रिया~विशेषणadversary <N>'      (a sense, then the next headword)
#:
#: So the headword is found from the end of the line and whatever precedes it
#: still belongs to the entry above.  Meanings are Devanagari and headwords are
#: Latin, which makes the split unambiguous even mid-word.
DICTD_TAIL_RE = re.compile(
    r"(?<![A-Za-z'\-])([A-Za-z][A-Za-z'\-]*(?: [A-Za-z'\-]+){0,2})[ \t]*<([A-Za-z/]+)>[ \t]*$")

#: A numbered sense: "1. पानी"
DICTD_MEANING_RE = re.compile(r"^[ \t]*\d{1,2}\.[ \t]*(.+?)[ \t]*$")

#: An example sentence, in double quotes.
DICTD_EXAMPLE_RE = re.compile(r'^[ \t]*"(.*)"[ \t]*$')

#: Cross-references and grammatical notes the source leaves inside a sense, e.g.
#: "समाना[<जाना]" and "हो_जाना{स्थिति}".  They are stripped markup rather than
#: translations, and the popup prints the gloss verbatim, so they would be shown
#: to the reader as if they were part of the answer.
DICTD_GLOSS_JUNK_RE = re.compile(r"\[[^\[\]]*\]|\{[^<>{}]*\}")

#: The source joins compound parts with an underscore, e.g. "हो_जाना".
DICTD_JOINER_RE = re.compile("(?<=[%s])_(?=[%s])" % (DEVANAGARI_CLASS, DEVANAGARI_CLASS))


def _decompress(payload: bytes, name: str) -> bytes:
    """Inflate a `.dict.dz` / `.dict.gz` member by sniffing its magic bytes.

    StarDict's `.dz` suffix means bzip2, but the tarball indic-dict publishes
    for this dictionary gzips it under the same name, so the extension cannot
    be trusted and the header has to be read instead.
    """
    if payload[:2] == b"\x1f\x8b":
        return gzip.decompress(payload)
    if payload[:3] == b"BZh":
        return bz2.decompress(payload)
    raise ValueError("%s is neither gzip nor bzip2" % name)


def parse_dictd_targz(raw: bytes, opts: dict) -> list:
    """Read a FreeDict `.dict.dz` out of a StarDict tarball.

    The English-Hindi database is the Anusaaraka English-Hindi Dictionary V2.0
    (Language Technologies Research Centre, IIIT Hyderabad), carried by the
    FreeDict project.  It is the one substantial *general purpose* English->Hindi
    source that can be redistributed: Wiktionary's translation tables hold only
    about 2,000 Hindi headwords, almost all of them nouns and adjectives, where
    this has ~22,000 including ordinary verbs ("learn", "listen", "go") and it
    carries a part of speech for each one.

    Because the headword is keyed on Latin text and every sense is Devanagari,
    a line is split at its trailing `<TAG>` rather than at a newline: see
    DICTD_TAIL_RE for the glued-line shape this has to survive.

    Returns rows of (headword, pos, gloss, roman, sense), where `sense` holds
    the source's English example sentence rather than a definition - the
    database has no per-sense English gloss, and an example showing the word in
    use is the next most useful thing for the popup to show.
    """
    if not isinstance(raw, (bytes, bytearray)):
        raise ValueError("stardict-dictd sources must be read as bytes (a tar archive)")
    max_senses = int(opts.get("maxSenses", 6))
    max_examples = int(opts.get("maxExamples", 1))

    member_name = ""
    payload = b""
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.endswith((".dict.dz", ".dict.gz", ".dict")):
                member_name = member.name
                extracted = archive.extractfile(member)
                payload = extracted.read() if extracted else b""
                break
    if not member_name:
        raise ValueError("no .dict member inside the archive")
    if member_name.endswith((".dz", ".gz")):
        payload = _decompress(payload, member_name)

    rows = []
    headword = ""
    pos = ""
    meanings: list = []
    examples: list = []

    def close_entry():
        if headword and meanings:
            rows.append((headword, pos, "; ".join(meanings), "", "; ".join(examples)))

    for line in payload.decode("utf-8", errors="replace").replace("\r", "").split("\n"):
        head = ""
        tag = ""
        match = DICTD_TAIL_RE.search(line)
        if match:
            head = match.group(1).strip()
            tag = match.group(2).strip()
            line = line[: match.start()]

        # Whatever is left of the line still belongs to the entry above, so it
        # has to be consumed before the new headword opens.
        example = DICTD_EXAMPLE_RE.match(line)
        if example and headword and len(examples) < max_examples:
            text = clean_text(example.group(1))
            if text:
                examples.append(text)
        else:
            meaning = DICTD_MEANING_RE.match(line)
            if meaning and headword and len(meanings) < max_senses:
                gloss = clean_text(meaning.group(1).replace("~", " "))
                gloss = clean_text(DICTD_GLOSS_JUNK_RE.sub(" ", gloss))
                gloss = clean_text(DICTD_JOINER_RE.sub(" ", gloss))
                if gloss and DEVANAGARI_CHAR_RE.search(gloss) and gloss not in meanings:
                    meanings.append(gloss)

        if head:
            close_entry()
            headword = head
            pos = DICTD_POS_MAP.get(tag.lower(), tag.lower()[:8])
            meanings = []
            examples = []

    close_entry()
    return rows, {"member": member_name}


PARSERS = {
    "babylon": parse_babylon,
    "tsv": parse_tsv,
    "stardict-dictd": parse_dictd_targz,
}


# --------------------------------------------------------------------------- #
# English -> Devanagari (Wiktextract "translations")
# --------------------------------------------------------------------------- #

#: A headword the reader can actually point at: one plain Latin token.  Phrases
#: ("up to"), accented spellings (naïve) and non-Latin names are skipped, since
#: a single hover or selection would never produce a loose key that matches.
EN_HEADWORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")

#: Gender tags Wiktionary attaches to a translation, mapped to the short markers
#: the source dictionaries already use.
GENDER_TAGS = {"masculine": "m", "feminine": "f", "neuter": "n"}


def parse_kaikki_en_translations(handle, opts: dict) -> list:
    """Stream the English Wiktextract dump into English -> Devanagari rows.

    Each line is one English headword.  Its `translations` list holds the
    Devanagari renderings contributed to that entry, each tagged with the
    language it is written in (`lang_code`), how to pronounce it (`roman`) and
    which English sense it answers (`sense`).  We keep only the target language
    from the registry options.

    Note the two different `lang_code` fields: on the line it is "en" (the entry
    being described), on each translation it is the target language.
    """
    lang_code = opts.get("langCode")
    if not lang_code:
        raise ValueError("kaikki-en-translations needs options.langCode")
    max_senses = int(opts.get("maxSenses", 6))
    rows = []
    for line in handle:
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue  # a truncated final line from a partial download
        translations = obj.get("translations") or []
        if not translations:
            continue
        word = (obj.get("word") or "").strip()
        if not EN_HEADWORD_RE.match(word):
            continue
        pos_raw = (obj.get("pos") or "").strip()
        if pos_raw in SKIP_KAIKKI_POS:
            continue
        pos = KAIKKI_POS_MAP.get(pos_raw, pos_raw[:8].lower())

        seen = set()
        taken = 0
        for translation in translations:
            if taken >= max_senses:
                break
            if not isinstance(translation, dict):
                continue
            if (translation.get("lang_code") or translation.get("code")) != lang_code:
                continue
            target = clean_headword(translation.get("word") or "")
            if not target or not DEVANAGARI_CHAR_RE.search(target):
                continue
            if target in seen:
                continue
            seen.add(target)
            taken += 1
            row_pos = pos
            genders = [GENDER_TAGS[tag] for tag in (translation.get("tags") or [])
                       if tag in GENDER_TAGS]
            if genders and row_pos:
                row_pos = (row_pos + " " + " ".join(genders[:1])).strip()
            rows.append((
                word,
                row_pos,
                target,
                clean_text(translation.get("roman") or ""),
                clean_text(translation.get("sense") or ""),
            ))
    return rows, {}


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


#: Cap for the English sense column.  It is supporting detail under the
#: translation, not the entry itself, so it is trimmed harder than the gloss.
SENSE_MAX_CHARS = 220


def unpack_row(row) -> tuple:
    """Normalise a parser row to (headword, pos, gloss, roman, sense)."""
    headword, pos, gloss, roman = row[0], row[1], row[2], row[3]
    sense = row[4] if len(row) > 4 else ""
    return (headword, pos, gloss, roman, sense)


def merge_senses(existing: str, addition: str) -> str:
    """Join two sense descriptions without repeating one already present."""
    if not addition:
        return existing
    if not existing:
        return addition
    for part in existing.split("; "):
        if part == addition or part in addition or addition in part:
            return existing
    return existing + "; " + addition


def prepare_rows(rows: list, max_gloss: int | None, limit: int | None) -> list:
    """Deduplicate, trim and sort the rows of one source.

    Two source rows collapse when they have the same headword *and* the same
    translation: the same Hindi word often answers several English senses of one
    word, and those senses are merged into the single sense column instead of
    producing identical repeated entries.
    """
    merged: dict = {}
    order: list = []
    for raw in rows:
        headword, pos, gloss, roman, sense = unpack_row(raw)
        headword = clean_headword(headword)
        gloss = (gloss or "").strip()
        roman = (roman or "").strip()
        sense = clean_text(sense or "")
        if not headword or not gloss:
            continue
        if not loose_key(headword):
            continue  # nothing the runtime could ever match on
        key = (headword, gloss)
        if key in merged:
            row = merged[key]
            row[4] = merge_senses(row[4], truncate(sense, SENSE_MAX_CHARS))
            if roman and not row[3]:
                row[3] = roman
            if not row[1] and pos:
                row[1] = pos.strip()
            continue
        row = [
            headword,
            (pos or "").strip(),
            truncate(gloss, max_gloss),
            roman,
            truncate(sense, SENSE_MAX_CHARS),
        ]
        merged[key] = row
        order.append(key)
    prepared = [merged[key] for key in order]
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
    fetched = args.fetch_manifest.get(cache_id(source), {})
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


def shard_rows(pack: dict, max_bytes: int) -> list:
    """Split a built pack into shard payloads, each under `max_bytes`.

    AMO's validator will not parse a .json of 5 MB or more, so the terminology
    pack (16 MB) has to ship as several files.  `prepare_rows` has already sorted
    the rows by headword, so a contiguous split is also a contiguous run of
    headwords, which keeps the shard boundary meaningful to anyone reading the
    directory by hand.

    Each shard carries its own `index` whose positions are **local to that
    shard**; the runtime re-bases them when it joins the shards back into one
    pack.  A word whose senses straddle a boundary therefore has its positions
    split across two shards, which is why the join concatenates rather than
    overwrites.
    """
    rows = pack["entries"]
    index = pack["index"]

    keys_by_row: dict = {}
    for key, positions in index.items():
        for position in positions:
            keys_by_row.setdefault(position, []).append(key)

    # Serialise each row once, and measure it in *bytes*: the rows are Devanagari,
    # so a character count understates the file by roughly 3x and would put the
    # shards back over AMO's limit.  Re-encoding a growing slice per step would
    # also make this quadratic over 140k rows.
    encoded = [json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
               for row in rows]

    meta = {key: value for key, value in pack.items()
            if key not in ("entries", "index", "count", "uniqueKeys", "_bytes", "shard")}

    def build(start: int, end: int) -> dict:
        local: dict = {}
        for position in range(start, end):
            for key in keys_by_row.get(position, ()):
                local.setdefault(key, []).append(position - start)
        shard = dict(meta)
        shard["count"] = end - start
        shard["uniqueKeys"] = len(local)
        shard["shard"] = {"index": 0, "total": 0, "rowOffset": start}
        shard["entries"] = rows[start:end]
        shard["index"] = local
        return shard

    def payload_bytes(shard: dict) -> int:
        return len(json.dumps(shard, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    # Seed the split from the row sizes alone, then correct it: a shard's index and
    # metadata are not in that budget, so any shard that still overshoots is halved
    # and rebuilt until every one fits.  Without this the "4 MB" cap silently
    # produced 7 MB files.
    target = max(64 * 1024, int(max_bytes * SHARD_ROW_FRACTION))
    bounds = []
    start = 0
    while start < len(rows):
        end = start
        used = 0
        # Always take at least one row, so one huge row cannot loop forever.
        while end < len(rows) and (end == start or used + len(encoded[end]) <= target):
            used += len(encoded[end])
            end += 1
        bounds.append([start, end])
        start = end

    for _ in range(32):
        oversized = [i for i, (start, end) in enumerate(bounds)
                     if end - start > 1 and payload_bytes(build(start, end)) >= max_bytes]
        if not oversized:
            break
        for i in reversed(oversized):
            start, end = bounds[i]
            middle = start + (end - start) // 2
            bounds[i:i + 1] = [[start, middle], [middle, end]]
    else:
        raise ValueError("cannot split %s under %d bytes" % (pack.get("id"), max_bytes))

    total = len(bounds)
    shards = []
    for number, (start, end) in enumerate(bounds):
        shard = build(start, end)
        shard["shard"] = {"index": number, "total": total, "rowOffset": start}
        shards.append(shard)
    return shards


def write_pack(out_dir: str, pack: dict, max_bytes: int) -> tuple:
    """Write a pack as one or more shards.

    A pack that fits is written as `dict/<id>.json` exactly as before, so the
    common case is unchanged on disk.  Returns (filenames relative to src/,
    total bytes).
    """
    shards = shard_rows(pack, max_bytes)
    names = []
    total = 0
    for number, shard in enumerate(shards):
        if len(shards) == 1:
            name = "%s.json" % pack["id"]
        else:
            name = "%s-%02d.json" % (pack["id"], number)
        total += write_json(os.path.join(out_dir, name), shard)
        names.append("dict/" + name)
    return names, total


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
            # Always a list: a pack that exceeds AMO's 5 MB parse limit is
            # written as several shards (see MAX_SHARD_BYTES).  The runtime falls
            # back to a single `file` for an older catalogue.
            "files": pack["files"],
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

#: The real shape of an English Wiktextract line, trimmed to what the parser reads.
EN_FIXTURE = "\n".join([
    '{"word":"word","pos":"noun","lang_code":"en","translations":['
    '{"lang":"Bhojpuri","code":"bh","lang_code":"bh","sense":"unit","word":"शब्द"},'
    '{"lang":"Hindi","code":"hi","lang_code":"hi","sense":"unit of language",'
    '"roman":"śabd","tags":["masculine"],"word":"शब्द"},'
    '{"lang":"Hindi","code":"hi","lang_code":"hi","sense":"unit of language",'
    '"roman":"śabd"}]}',
    # a phrase headword: unusable, the reader can only point at one word
    '{"word":"up to","pos":"prep","lang_code":"en","translations":['
    '{"lang":"Hindi","code":"hi","lang_code":"hi","sense":"until","word":"तक"}]}',
    # a target that is not Devanagari: not an answer for this extension
    '{"word":"tree","pos":"noun","lang_code":"en","translations":['
    '{"lang":"German","code":"de","lang_code":"de","sense":"plant","word":"Baum"}]}',
])


#: The real shape of a dictd entry, trimmed to what the parser reads.  The two
#: glued lines are the point: the source routinely omits the newline after an
#: example sentence and after a sense, so the next headword lands on the end of
#: the line above it.
DICTD_FIXTURE = "\n".join([
    "learn <V>",
    '1. सीखना',
    '      "I want to learn Hindi."listen <V>',
    "1. सुनना",
    "      \"Please speak loudly.\"",
    "",
    "go <V>",
    "1. जाना",
    "1. समाना[<जाना]",
    "2. हो_जाना{स्थिति}",
    "3. ?",
    "",
    "book <N>",
    "1. पुस्तक, किताब",
])


def _dictd_fixture_targz(text: str) -> bytes:
    """Wrap a dictd fixture in the tarball layout the parser expects."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        compressed = gzip.compress(text.encode("utf-8"))
        info = tarfile.TarInfo("dictd_freedict2_eng-hin.dict.dz")
        info.size = len(compressed)
        archive.addfile(info, io.BytesIO(compressed))
    return buffer.getvalue()


def self_test() -> int:
    failures = []

    def check(label, actual, expected):
        if actual != expected:
            failures.append("%s: expected %r, got %r" % (label, expected, actual))

    check("loose_key nukta", loose_key("क़"), "क")
    check("loose_key zwj", loose_key("क्‍ष"), "क्ष")
    check("loose_key candrabindu", loose_key("अँ"), "अं")
    check("loose_key danda trim", loose_key("राम।"), "राम")
    check("loose_key latin", loose_key("  House "), "house")
    check("loose_key precomposed nukta", loose_key("क़"), "क")
    check("loose_key curly apostrophe", loose_key("Don’t"), "don’t")
    check("cache_id shared", cache_id({"id": "en-wiktionary-hi", "sharedCache": "en-wiktionary"}),
          "en-wiktionary")
    check("cache_id plain", cache_id({"id": "en-raghuvira"}), "en-raghuvira")

    rows, meta = parse_babylon(BABYLON_FIXTURE, {"stripHeadwordPrefix": True})
    check("babylon meta", meta.get("bookname"), "fixture (mr-en)")
    check("babylon row count", len(rows), 3)
    check("babylon first headword", rows[0][0], "अंक")
    check("babylon first pos", rows[0][1], "m")
    check("babylon first gloss", rows[0][2], "1. number. 2. issue (of a magazine, newspaper).")
    check("babylon last headword", rows[2][0], "अइंचण, अइता, अइरीण")
    check("babylon last gloss", rows[2][2], "For words beginning with अइ and अई, see under ऐ.")
    check("babylon row width", len(rows[0]), 5)

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

    rows, _ = parse_kaikki_en_translations(io.StringIO(EN_FIXTURE), {"langCode": "hi", "maxSenses": 6})
    check("en rows (phrase + non-Devanagari dropped)", len(rows), 1)
    check("en headword", rows[0][0], "word")
    check("en pos with gender", rows[0][1], "n m")
    check("en translation", rows[0][2], "शब्द")
    check("en roman", rows[0][3], "śabd")
    check("en sense", rows[0][4], "unit of language")

    rows, _ = parse_kaikki_en_translations(io.StringIO(EN_FIXTURE), {"langCode": "mr", "maxSenses": 6})
    check("en other target language", len(rows), 0)

    try:
        parse_kaikki_en_translations(io.StringIO(EN_FIXTURE), {})
        failures.append("en parser should require options.langCode")
    except ValueError:
        pass

    prepared = prepare_rows([("अंक", "m", "a" * 20, "", ""), ("अंक", "m", "a" * 20, "", "")], 5, None)
    check("truncate+dedupe", (len(prepared), prepared[0][2]), (1, "aaaaa \u2026"))

    prepared = prepare_rows([("dog", "n", "कुत्ता", "kuttā", "a domesticated canine"),
                             ("dog", "n", "कुत्ता", "", "an animal kept as a pet")], None, None)
    check("sense merge keeps one row", len(prepared), 1)
    check("sense merge text", prepared[0][4],
          "a domesticated canine; an animal kept as a pet")
    check("sense merge keeps roman", prepared[0][3], "kuttā")

    rows, meta = parse_dictd_targz(_dictd_fixture_targz(DICTD_FIXTURE),
                                  {"maxSenses": 6, "maxExamples": 1})
    check("dictd member found", meta.get("member"), "dictd_freedict2_eng-hin.dict.dz")
    check("dictd rows", [row[0] for row in rows], ["learn", "listen", "go", "book"])
    check("dictd pos from tag", rows[0][1], "v")
    check("dictd gloss after a glued example", rows[0][2], "सीखना")
    check("dictd example kept as the sense", rows[0][4], "I want to learn Hindi.")
    check("dictd a glued headword opens its own entry", rows[1][2], "सुनना")
    check("dictd its own example, not the one above", rows[1][4], "Please speak loudly.")
    check("dictd gloss after a glued headword", rows[2][2], "जाना; समाना; हो जाना")
    check("dictd drops the placeholder sense", "?" in rows[2][2], False)
    check("dictd last row gloss", rows[3][2], "पुस्तक, किताब")

    try:
        parse_dictd_targz(DICTD_FIXTURE, {})
        failures.append("dictd parser should reject text instead of bytes")
    except ValueError:
        pass

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
    parser.add_argument("--max-shard-bytes", type=int, default=MAX_SHARD_BYTES,
                        help="largest pack shard to write, in bytes (default 4 MB; "
                             "AMO's validator will not parse a .json of 5 MB or more)")
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
            cached = args.fetch_manifest.get(cache_id(source))
            state = "not fetched"
            if cached:
                state = human_size(cached["size"]) + (" (partial)" if cached.get("partial") else "")
            print("%-16s %-4s %-22s %-15s default=%-3s %s" % (
                source["id"], source["sourceLang"] + ">" + source["targetLang"],
                source["format"],
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
        key = cache_id(source)
        cache_file = os.path.join(CACHE_DIR, key + EXTENSIONS[source["format"]])
        fetched = args.fetch_manifest.get(key)
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
            if source["format"] in STREAMING_FORMATS:
                with io.open(cache_file, encoding="utf-8", errors="replace") as handle:
                    entries, _ = (parse_kaikki if source["format"] == "kaikki-jsonl"
                                  else parse_kaikki_en_translations)(handle, opts)
            elif source["format"] in BINARY_FORMATS:
                with io.open(cache_file, "rb") as handle:
                    entries, _ = PARSERS[source["format"]](handle.read(), opts)
            else:
                with io.open(cache_file, encoding="utf-8", errors="replace") as handle:
                    entries, _ = PARSERS[source["format"]](handle.read(), opts)
        except Exception as exc:  # noqa: BLE001
            print("%-16s FAILED: %s" % (source_id, exc), file=sys.stderr)
            failures.append(source_id)
            continue

        pack = build_pack(source, entries, args)
        names, size = write_pack(args.out, pack, args.max_shard_bytes)
        pack["files"] = names
        pack["_bytes"] = size
        packs.append(pack)
        suffix = "" if len(names) == 1 else " in %d shards" % len(names)
        print("%-16s %7d entries -> dict/%s.json%s (%s) in %.1fs%s" % (
            source_id, pack["count"], source_id, suffix, human_size(size),
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


