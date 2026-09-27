# Architecture & Design Decisions

This document explains the technical choices made while implementing the
Devanagari Popup Dictionary.

---

## 1. Zero External Dependencies

The extension is written entirely with vanilla Web APIs (DOM, Web Speech API,
Web Components/Shadow DOM, Web Extensions Storage API) and zero third-party
runtime JavaScript. Tooling runs on standard Node.js (>=20) and Python 3
without needing any `npm install` step. (`web-ext` is a devDependency used only
by the optional `npm start` and `npm run lint:amo` scripts.)

Rationale:
- **Firefox AMO review**: Un-bundled, un-minified vanilla JavaScript passes
  automated and manual Mozilla add-on reviews without scrutiny over opaque
  bundles or obfuscated code.
- **Privacy & security**: No third-party network requests ever occur. The
  extension functions 100% offline.
- **Longevity**: No churn from framework major versions or broken transitive
  dependencies.

---

## 2. Inverted Index on Disk

Dictionary packs are compiled ahead of time by `tools/build_dict.py` into
flat JSON files living under `src/dict/`:

```
src/dict/
  index.json
  en-freedict-anusaaraka.json     3.1 MB
  en-raghuvira-00.json            3.7 MB  }  the terminology pack is sharded,
  en-raghuvira-01.json            3.9 MB  }  see "Packs are sharded" below
  en-raghuvira-02.json            3.9 MB  }
  en-raghuvira-03.json            3.9 MB  }
  en-raghuvira-04.json            0.5 MB  }
  en-wiktionary-hi.json           0.3 MB
```

All shipped packs are keyed by the **English** headword, because that is the side
the reader points at. `sourceLang` is always `en` and `targetLang` is the answer
language; it is `targetLang` that the `languages` setting, TTS and the UI counts
all address, whichever way round a future pack is keyed.

**Hindi only.** `settings.js` exposes exactly one answer language (`LANGUAGES`),
and `dictionary.js` filters the catalogue on it, so a pack answering in any other
language cannot be selected no matter what a hand-edited settings file claims.
Marathi sources were deleted from `tools/sources.json` rather than left dormant:
shipping a language the product does not offer is a licensing obligation with no
benefit, and the catalogue is what `tools/build_zip.py` packages.

Structure of a pack JSON:
```json
{
  "id": "en-raghuvira",
  "name": "Raghu Vira's English-Hindi Dictionary of Government and Educational Words",
  "sourceLang": "en",
  "targetLang": "hi",
  "count": 143939,
  "uniqueKeys": 134833,
  "license": "Government of India publication - public domain",
  "attribution": "Dr. Raghu Vira, A Comprehensive English-Hindi Dictionary...",
  "entries": [
    ["word", "", "शब्द", "śabda", "an expression of thought"],
    ...
  ],
  "index": {
    "word": [0, 42],
    ...
  }
}
```

- `entries` is a compact array of five-field rows:
  `[headword, pos, gloss, roman, sense]`.
  - `headword` — the side the reader types, and the only column the index keys on.
  - `gloss` — the Devanagari answer, never empty.
  - `roman` — ISO 15919 transliteration, may be empty.
  - `sense` — the English sense the translation was drawn from; for Raghu Vira
    this is the glossary's own English definition, otherwise the Wiktionary gloss.
    The Anusaaraka pack has no per-sense English definition, so it stores the
    source's English example sentence here instead — the popup renders the column
    the same way either way, and "here it is in a sentence" is the next most
    useful thing a learner can be shown.
- `index` maps normalized lookup keys to integer row offsets into `entries`.
- Polysemy is supported naturally: the same key points to multiple row indices.
- Prefix completion (`dict.suggest("educa")`) scans keys lazily, capped at 8 results.
- `tools/verify_packs.py` enforces the five-field shape, index/row agreement,
  normalised keys, and that the answers really are in the target script.

### Packs are sharded, because AMO will not parse a large one

`addons-linter` — the validator AMO runs on every submission — picks a file's
scanner from its **extension** and refuses to parse anything at or above **5 MB**.
A `.json` pack of 5 MB or more is therefore a hard validation *error*, with no
configuration to opt out; renaming the file to dodge the check would be evading
the validator rather than satisfying it, and would be noticed in review.

So a pack over the limit is written as several shards of at most 4 MB
(`MAX_SHARD_BYTES`, overridable with `--max-shard-bytes`). The catalogue lists
them as `files: [...]`, and `Dictionary.loadPack()` joins them back into one pack
at load time:

- Each shard carries its own `index` whose positions are **local to that shard**,
  plus a `shard: {index, total, rowOffset}` header.
- `joinShards()` concatenates the entry arrays and re-bases each shard's index
  positions onto the joined array. A word whose senses straddle a boundary has its
  positions split across two shards, so a repeated key is **concatenated**, never
  overwritten — dropping the second copy would silently hide a sense.
- The joined pack is indistinguishable from a single-file one: `count` and
  `uniqueKeys` are recomputed and the `shard` header is removed.

Rows are already sorted by headword, so a contiguous split is also a contiguous
run of headwords. Splitting is seeded from the encoded row sizes and then
*corrected against the real serialised size*, halving any shard that still
overshoots — the index is not in the row budget, and measuring rows in
characters rather than bytes understates a Devanagari file by roughly 3×, which
is how a "4 MB" cap silently produced 7 MB files the first time.
`tools/verify_packs.py` fails the build if any shard reaches 5 MB, and a test
asserts it for the shipped packs.

### The index is a plain object, and that matters

`JSON.parse` gives `index` a normal `Object.prototype`, so `pack.index[key]` finds
inherited members for words like `constructor`, `toString` and `valueOf`. A naive
lookup therefore finds a *function* where a position list should be and throws
`positions is not iterable`. `rowsFor()` guards twice — an own-property check and
an `Array.isArray` check — because "constructor" is not a hypothetical: it is a
real headword in the Anusaaraka pack, so the word is both genuinely present and
a prototype key.

### Where the data comes from, and why there are three packs

The English Wiktionary dump is 3.3 GB and yields only ~4,000 Hindi translations
across ~2,000 headwords, almost all nouns and adjectives: `learn`, `listen` and
`go` have **no** Hindi translation in it at all. Raghu Vira is a 1963 government
terminology publication, so it has `teach` but not `learn`. Together they left
the everyday-vocabulary gap that made a plain word like "learn" report no entry.

The Anusaaraka English-Hindi Dictionary V2.0 (IIIT Hyderabad, carried by FreeDict)
closes it: ~22,500 general headwords including ordinary verbs, each with a part
of speech. It is also the only substantial general-purpose English→Hindi source
that can be redistributed, and it is **GPL v2.0-or-later**, so the derived pack
is GPL too — see `THIRD_PARTY_NOTICES.md`. It is a 1999-vintage database whose
formatting is uneven, and `parse_dictd_targz()` exists because of that: the
source routinely omits the newline after an example sentence, so the next
headword arrives glued onto the end of the line above it
(`..."He is an easygoing person."eat <VI>`). A line is therefore split at its
trailing `<TAG>`, not at a newline, and whatever precedes that tag still belongs
to the entry above. Meanings are Devanagari and headwords are Latin, which makes
the split unambiguous even mid-word. Cross-references (`समाना[<जाना]`) and
grammatical notes (`हो_जाना{स्थिति}`) are stripped, because the popup prints the
gloss verbatim.

---

## 3. Two-Tier Lookup Strategy

English suffixes inflect as freely as Devanagari stem-final endings, so a single
exact key is rarely enough. When a reader selects or hovers over *words*:

1. **Exact match**: The key is normalized (case folded, nukta dropped,
   candrabindu folded to anusvara, zero-width joiners stripped, Latin ligature
   dash folded) and checked directly against the active packs.
2. **Morphological fallbacks**: If no exact match is found, the morphology
   engine (`src/common/morphology.js`) applies language-scoped heuristics,
   chosen by the script of the looked-up word:
   - **English**: plural/inflection stripping and irregular tables
     (*words* → *word*, *mice* → *mouse*, *ran* → *run*, *better* → *good*).
   - **Hindi**: Plural oblique `-यों` → `-ी` (*लड़कियों* → *लड़की*), direct plural
     `-ियाँ` → `-ी`, masculine oblique `-ों` → `-ा`, verb endings (`-कर`, `-ते`,
     `-ती`, `-ता`, `-ने`, `-ना`, `-या`, `-ई`, `-ए`), plus irregular tables
     (*गया* → *जाना*, *हुआ* → *होना*, *कहा* → *कहना*).

Candidates are scoped to the pack's own head language: an English lemma is
tried against every English-headed pack, while a Devanagari lemma produced by
the Hindi rules is only tried against packs headed `hi`. That is what stops a
Hindi-suffixed guess from being offered as if it were an English misspelling.

---

## 3a. Results Are Gathered, Then Assembled

Results are gathered first and assembled afterwards, rather than being capped as
they are found. A plain `maxMatches` cap lets whichever pack loads first consume
every slot, so with a 143,939-entry terminology pack enabled next to a
25,250-entry everyday one, a reader asking for a common word could see nothing
but a second, rarer sense of it.

Assembly therefore takes one result from each enabled pack before filling the
remaining slots, and de-duplicates on
`(targetLang, headword, pos, gloss, sense)`. Including `targetLang` in the
de-duplication key matters because two packs can legitimately translate the same
word the same way; the row is still kept once per language rather than collapsed.

The round-robin is over *packs*, not over languages, and it has to be: `found`
arrives pack by pack in catalogue order, so taking the first row per answer
language is the same as taking the first row of the first pack. Languages are
still visited in order, so a pack answering in a later language cannot take the
slot belonging to an earlier one.

---

## 3b. Selection Is the Request (`src/common/selection.js`)

The primary trigger is a selection, which means the extension has to read intent
from a gesture the reader also uses for everything else. Every rule lives in one
testable module that returns a *reason* for every decline, so "no popup appeared"
is always diagnosable:

- **Not a word at all**: empty, whitespace, or punctuation-only selections.
- **Too long to be a lookup**: over `maxSelectionWords` / `maxSelectionChars`,
  with hard floors of 12 words and 200 characters that no stored setting can
  raise. These run first, so dragging across an article costs nothing.
- **Not text a dictionary can answer**: URLs, domains, email addresses, numbers,
  dates, and anything containing Devanagari (the packs are keyed by English).
- **Not a word**: a single character, or a token too long to be a word, which is
  how minified identifiers and CSS hashes are kept out.
- **Select-all**: a selection covering ~90% or more of the document's text, which
  catches Ctrl+A on a short page that the length limits would otherwise allow.

Declines are silent by design — a reader who selected a paragraph to copy it
does not need to be told why there was no popup. Form controls are checked
before all of this so a password field is never read.

---

## 3c. Packs Load in Idle Time

The Raghu Vira pack is ~16 MB. Fetching it while a page is still loading competes
with the page the reader came for, so `preload()` is deferred to
`requestIdleCallback` (with a 5-second ceiling and a `setTimeout` fallback).
`loadPack()` caches its in-flight promise, so a lookup arriving before the warm-up
finishes awaits the same fetch rather than starting a second one.

Enabling `allowFrames` multiplies this in principle: the content script is
declared with `all_frames: true`, so *every* frame on the page instantiates its
own `Dictionary` and would warm up its own copy of every pack. That is why the
frame check in `shouldBeActive()` is a runtime gate rather than a manifest one —
`all_frames` is static and cannot follow a preference.

In practice the gate makes the cost disappear, which is why `allowFrames`
defaults to **on**. A frame that is switched off goes through `setActive(false)`,
which never constructs a `Dictionary` and never calls `scheduleWarmUp()`: it
fetches no pack and parses no JSON. All it costs is the ten small scripts and
five passive listeners. What switching it off actually costs is the reader,
because a selection is a document-local event — the top document cannot see a
selection made inside a frame, so on any page whose words live in an iframe
(a video player, a comment thread, an embedded search widget) selection produces
no popup at all. The option used to be described as a data-cost dial, "each frame
loads its own copy of the dictionaries", which is simply not what the code does.


---

## 4. DOM Isolation & Shadow DOM

The popup tooltip is attached to the page inside an open `ShadowRoot`:
- Page CSS cannot bleed in and distort tooltip margins, fonts, or colors.
- Tooltip CSS cannot bleed out and alter the host page layout.
- The host page's DOM tree remains untouched; the looked-up word is found through
  `Selection` / `document.caretRangeFromPoint` /
  `document.caretPositionFromPoint` to extract text offsets without wrapping
  elements.
- The same isolation hides the debug hook: `__decDi` is set on the content
  script's global, and Firefox gives every extension a sandbox per document, so
  the page's `window` does not have it. `__decDi.lastDecline()` therefore fails
  with "does not exist" in the *page* console even though the hook is set; it has
  to be read with this extension's content-script context selected in the
  DevTools console. Found by trying it, not by reading it.
- Clean tear-down: the entire host is removed on click away, Escape press,
  or hover-off.
- The popup is shown and hidden by toggling the `hidden` attribute, which needs
  an explicit `.decdi[hidden] { display: none }` rule in the injected
  stylesheet. The UA stylesheet's `[hidden]` rule is a *UA-origin* declaration,
  so the author-origin `display: flex` on `.decdi` beats it whatever the
  specificity. Without the extra rule, `hidden` is set and nothing happens:
  Escape and the close button both appear broken.

A selection-triggered popup is pinned open by default, because the reader's
pointer is on the word they are reading, not moving away from it. Hover popups
follow the pointer and hide after `hideDelay` as before.

---

## 4a. Speech, and why it is instrumented

TTS goes through the Web Speech API, which is a poor fit for a content script and
fails in ways that are otherwise indistinguishable from "the shortcut is broken":

- **No `cancel()` before `speak()`.** Gecko dispatches a cancel asynchronously,
  so one issued in the same task as `speak()` lands *after* the new utterance and
  takes it down with it. The previous code did exactly that, which is why pressing
  the speaker produced nothing.
- **The voice list is cached, not sampled once.** `getVoices()` is empty until
  the platform finishes enumerating and Firefox then fires `voiceschanged`.
  Reading it synchronously on the click misses the list on a cold start, so it is
  cached and refreshed on that event.
- **Every failure is logged.** A wrong-language or missing voice is reported
  only through `utterance.onerror`, and a platform with no voices installed says
  nothing at all. The utterance carries an `onerror` handler and the no-voice case
  is warned about explicitly, because "this profile has no Hindi voice" is a
  system setting the reader has to fix and they cannot act on it otherwise.

The popup's <kbd>A</kbd>/<kbd>C</kbd>/<kbd>Shift</kbd> shortcuts live in
`Tooltip.handleKey()` and are suppressed whenever focus is in a text field or a
modifier is held: the popup is very often open over a search box, and a
dictionary that swallows the letter "a" there is worse than one with no
shortcuts at all.

---

## 5. Viewport-Aware Positioning

The tooltip dynamically computes available space:
- Positions above the looked-up text by default with a caret arrow.
- Flips below the text if the word is too close to the top of the viewport.
- Clamps horizontally within viewport bounds (8px margins) so it never
  overflows off-screen on narrow viewports or mobile browsers.

---

## 6. Transliteration: ISO 15919 with Homorganic Anusvara

Transliteration maps every Devanagari codepoint deterministically to ISO 15919.
Crucially, the anusvara (ं) is **not** rendered blindly as `ṃ` in every context;
it assimilates to the place of articulation of the following consonant:

- Velar (क ख ग घ): *अंग* → `aṅga`
- Palatal (च छ ज झ): *पंच* → `pañca`
- Retroflex (ट ठ ड ढ): *घंटा* → `ghaṇṭā`
- Dental (त थ द ध): *दंत* → `danta`
- Labial (प फ ब भ): *मुंबई* → `mumbaī`
- Word-final or before fricatives: fallback to `ṃ`

This produces natural, recognizable transliterations without manual pronunciation
lexicons.
