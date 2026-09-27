# Devanagari Popup Dictionary

An offline, selection-first dictionary extension that looks up **English** words
and shows their **Hindi** (हिन्दी) meanings, inspired by Perapera Chinese and
Rikaichamp.

Select a word on any page and the popup shows the Devanagari answer, ISO 15919
transliteration, part of speech, and the English sense the translation came from.

Built specifically for Firefox (Manifest V3) with zero external runtime
dependencies.

---

## Features

- 📖 **Select a word, that's it**: release the mouse over a selected word and the
  meaning appears. Nothing else to press, and nothing happens when you are
  selecting something *else* — see [When it stays quiet](#when-it-stays-quiet).
- 🔎 **Word and short phrase**: works in a search box, a comment field or any
  <kbd>text input</kbd>, as well as ordinary page text. Right-click or press
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> to look up a selection explicitly.
- ⚡ **100% offline**: All dictionary data is pre-indexed and bundled locally
  under `src/dict/`. No network requests are made during lookups.
- 🪶 **Loaded in your idle time**: the packs are read only once the page is idle,
  so a lookup is instant without any page paying the cost up front.
- 🔤 **Morphological resolution**: Handles English plurals and inflections as
  well as Devanagari obliques and verb stems (e.g. *words* → *word*,
  *mice* → *mouse*, *लड़कियों* → *लड़की*, *करतात* → *करणे*).
- 🔊 **Text-to-speech**: Pronounces the answer in Hindi via the Web Speech API
  (or press <kbd>A</kbd> / click the speaker icon).
- 🎨 **Adaptive theming**: Auto / Light / Dark modes; fully isolated from host
  page CSS via an open `ShadowRoot`.
- 📌 **Pinning & copying**: Press <kbd>Shift</kbd> or click the pin button to
  freeze the popup in place; press <kbd>C</kbd> to copy the word and answer.
- 🎛️ **Hover if you prefer it**: *Look up on hover* is one setting away, and
  can be limited to holding <kbd>Shift</kbd>, <kbd>Ctrl</kbd> or <kbd>Alt</kbd>.
  Plus a per-site disable list.
- 📜 **Attribution included**: Every lookup result carries the source pack's
  name, license, and author attribution.

### When it stays quiet

A selection-triggered dictionary is only pleasant if it does not interrupt the
act of selecting text. The gesture is the request, so anything that is not
plausibly a lookup is declined before a single byte of data is fetched:

| Selection | Result |
|:---|:---|
| A word, or up to 4 words / 60 characters | ✅ looked up |
| A paragraph, or more than 12 words / 200 characters | ignored |
| Ctrl+A over a page | ignored |
| A URL, an email address, a date, a number | ignored |
| Devanagari or other non-Latin text | ignored |
| A password, read-only or disabled field | ignored |
| A single letter, or a token too long to be a word | ignored |

Both length limits are adjustable in the options. To see why a particular
selection was ignored, run `__decDi.lastDecline()` in the page console.

---

## Bundled Dictionaries

All three packs are keyed by the **English** headword, because that is the side
the reader points at.
| Pack | Direction | Source | Licence | Entries |
|:---|:---|:---|:---|---:|
| **Anusaaraka (FreeDict)** | English → Hindi | IIIT Hyderabad, via FreeDict | GPL v2.0-or-later | 25,250 |
| **Raghu Vira** | English → Hindi | Government of India (via `indic-dict/stardict-hindi`) | Public domain | 143,939 |
| **Wiktionary (Hindi)** | English → Hindi | kaikki.org (Wiktextract) | CC BY-SA 4.0 | 3,403 |

Total bundled vocabulary: **172,592 entries** across 3 packs (19.2 MB).
See `THIRD_PARTY_NOTICES.md` for full licensing and citation details — note that
the bundle is **not** uniformly permissive: the Anusaaraka pack is GPL.

### Coverage, honestly

Three packs, three jobs, and the order matters because the popup shows one entry
per pack before any pack may take a second slot:

- **Anusaaraka** is the everyday-vocabulary pack and the one to expect an answer
  from. It carries a part of speech for every row and an English example
  sentence for most, so entries read like a dictionary rather than a gloss.
- **Raghu Vira** supplies government, scientific and educational terminology
  (143,939 entries) — complements rather than overlaps. As a 1963 government
  publication it is weak on ordinary words, and its senses are ordered by domain,
  so its specialist senses can appear alongside the everyday one.
- **Wiktionary** adds 3,403 rows with the English sense attached to each
  translation. Small, and thin on common verbs: the whole English Wiktionary dump
  contains only ~4,000 Hindi translations, almost all nouns and adjectives.

A probe of 130 high-frequency English words resolves **129** with all three packs
(the miss is `its`). The one word class none of them covers well is function
words and inflected forms, which the morphology rules in
`src/common/morphology.js` reduce to a lemma before the index is consulted.

The `x-en` (Devanagari → English) direction is **not implemented**: the settings
model, pack selection and TTS all address the answer language, so only Hindi
answers are currently selectable.

---

## Quick Start

### 1. Requirements

- **Node.js** >= 20 (for the test runner and verification tools)
- **Python** >= 3.8 (for dictionary builders and icon generation; uses standard library only)
- **Firefox** 142+ (the manifest declares `strict_min_version`)

`npm run check` and `npm test` need no installed packages. `npm start` and
`npm run lint:amo` shell out to `web-ext`, which is the one devDependency:
run `npm install` if you want the live-reload runner or the AMO linter.

### 2. Run Tests & Code Verification

```bash
# Verify JavaScript syntax and manifest references
npm run check

# Run all unit and integration tests (uses Node's native runner)
npm test

# Run both check and test in sequence
npm run verify
```

### 3. Load into Firefox for Development

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `src/manifest.json` inside this repository.
4. Open any page with English prose (e.g. https://en.wikipedia.org)
   and select a word.

### 4. Build a Release Archive

```bash
npm run package
# or directly:
python tools/build_zip.py
```

This creates a reproducible, sorted `.zip` archive in `dist/devanagari-popup-dict-<version>.zip`
ready to upload to [addons.mozilla.org (AMO)](https://addons.mozilla.org/).

### 5. Rebuild the Dictionary Packs

Only needed when you change `tools/sources.json` or a source lexicon.

```bash
npm run dict          # fetch defaults, then build them
python tools/verify_packs.py   # validate shape, index integrity and script coverage
```

The English Wiktionary dump is a single ~3.3 GB download, cached once under
`tools/.cache/` and reused by every source that reads it. The Anusaaraka pack is
a 1.2 MB tarball and needs no special handling: `tools/build_dict.py` opens the
archive with the standard library and inflates the dictd member it contains.

---

## Extension Structure

```
├── dist/                       # Output .zip archives for AMO
├── docs/
│   └── ARCHITECTURE.md         # Design decisions and internals
├── src/
│   ├── manifest.json           # WebExtension Manifest V3
│   ├── background/
│   │   └── background.js       # Context menus and toolbar click routing
│   ├── common/
│   │   ├── devanagari.js       # Codepoint classification & segmentation
│   │   ├── dictionary.js       # Pack loading, indexing, and lookup
│   │   ├── morphology.js       # English + Hindi inflection rules
│   │   ├── pos-labels.js       # Unified part-of-speech tag mapping
│   │   ├── selection.js        # "Is this selection a lookup?" guard rails
│   │   ├── settings.js         # User options storage & validation
│   │   ├── tooltip.js          # Shadow DOM tooltip UI
│   │   └── translit.js         # ISO 15919 transliteration engine
│   ├── content/
│   │   └── content.js          # Selection/hover detection & DOM coordinator
│   ├── dict/                   # Pre-compiled JSON packs (sharded) + index.json
│   ├── icons/                  # 16, 32, 48, 96, 128px PNG and SVG icons
│   ├── options/                # Options page UI (HTML, CSS, JS)
│   └── popup/                  # Toolbar action popup UI
├── test/
│   ├── units.test.js           # Unit tests (segmentation, translit, rules)
│   └── dict-integration.test.js# End-to-end integration test with real packs
├── tools/
│   ├── build_dict.py           # Compiles raw lexicons into pack JSONs
│   ├── build_zip.py            # Reproducible zip packager for AMO
│   ├── check-js.js             # Static checker for syntax & manifest paths
│   ├── fetch_sources.py        # Dataset downloader (supports shared caches)
│   ├── make_icons.py           # Pure-stdlib PNG icon generator
│   └── verify_packs.py         # Validates built pack shape, index, and script
├── LICENSE
├── LICENSES/                     # Licence texts that must ship inside the .zip
├── package.json
└── THIRD_PARTY_NOTICES.md
```

---

## Keyboard Shortcuts in the Popup

With the popup open:

| Key | Action |
|:---|:---|
| <kbd>A</kbd> | Play audio pronunciation (TTS) in Hindi |
| <kbd>C</kbd> | Copy the word and its answer to the clipboard |
| <kbd>Shift</kbd> | Pin the popup open, or release it |
| <kbd>Esc</kbd> | Dismiss the popup |

The letter shortcuts are ignored while the cursor is in a text field and while
<kbd>Ctrl</kbd>/<kbd>Alt</kbd>/<kbd>Meta</kbd> is held, so they cannot swallow
typing. A popup opened by selecting a word is already pinned, so it stays while
you read it; <kbd>Esc</kbd> or the ✕ closes it, and <kbd>Shift</kbd> releases a
hover popup. `Alt`+`Shift`+<kbd>L</kbd> looks up the current selection from the
keyboard, and the right-click menu offers the same, which is how a lookup works
on a touch screen or a page that scrolls under a stationary pointer.

If a pronunciation does not play, the reason is logged to the page console as
`[devanagari-dict] speech: …` — the usual cause is that the platform has no
Hindi voice installed, which is a system setting rather than a fault in the
extension.

---

## Licence

- Extension source code: **MIT Licence** (see `LICENSE`).
- Bundled dictionary data: see `THIRD_PARTY_NOTICES.md`.
