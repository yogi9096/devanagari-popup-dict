# Devanagari Popup Dictionary

An offline hover dictionary browser extension for **Hindi** (हिन्दी) and
**Marathi** (मराठी) reading, inspired by Perapera Chinese and Rikaichamp.

Built specifically for Firefox (Manifest V3) with zero external runtime
dependencies.

---

## Features

- 📖 **Instant hover lookups**: Move your mouse over any Devanagari text on any
  webpage to view headwords, parts of speech, English definitions, and
  ISO 15919 transliteration in a clean popup tooltip.
- ⚡ **100% offline**: All dictionary data is pre-indexed and bundled locally
  under `src/dict/`. No network requests are made during lookups.
- 🔤 **Morphological resolution**: Handles inflected verbs, oblique nouns, and
  plural stems (e.g. *लड़कियों* → *लड़की*, *करतात* → *करणे*, *गया* → *जाना*).
- 🔊 **Text-to-speech**: Pronounces the hovered word via the Web Speech API
  (or press <kbd>A</kbd> / click the speaker icon).
- 🎨 **Adaptive theming**: Auto / Light / Dark modes; fully isolated from host
  page CSS via an open `ShadowRoot`.
- 📌 **Pinning & copying**: Press <kbd>Shift</kbd> or click the pin button to
  freeze the tooltip in place; press <kbd>C</kbd> to copy the headword and gloss.
- 🎛️ **Language toggles**: Independent toggles for Hindi and Marathi, customizable
  activation keys (<kbd>Shift</kbd>, <kbd>Alt</kbd>, or automatic hover),
  and a site-level disable list.
- 📜 **Attribution included**: Every lookup result carries the source pack's
  name, license, and author attribution.

---

## Bundled Dictionaries

| Language | Pack | Source | Licence | Entries |
|:---|:---|:---|:---|---:|
| Hindi | **Hindi WordNet** | IIT Bombay (CFILT) | CC BY-NC-SA 4.0 | 38,879 |
| Hindi | **Shabdkosh** | Community contributors | CC BY-SA 3.0 | 10,750 |
| Marathi | **Marathi WordNet** | IIT Bombay (CFILT) | CC BY-NC-SA 4.0 | 28,746 |
| Marathi | **Berntsen M-E** | Maxine Berntsen / Univ. of Chicago DDSA | CC BY-NC 4.0 | 4,496 |

Total bundled vocabulary: **82,871 entries** pre-indexed across 4 packs.
See `THIRD_PARTY_NOTICES.md` for full licensing and citation details.

---

## Quick Start

### 1. Requirements

- **Node.js** >= 18 (for the test runner and verification tools)
- **Python** >= 3.8 (for dictionary builders and icon generation; uses standard library only)
- **Firefox** 109+ (supports Manifest V3 background scripts & content scripts)

No `npm install` is strictly required to run the extension or suite.

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
4. Open any page with Devanagari text (e.g. Hindi Wikipedia: https://hi.wikipedia.org)
   and hover over words.

### 4. Build a Release Archive

```bash
npm run package
# or directly:
python tools/build_zip.py
```

This creates a reproducible, sorted `.zip` archive in `dist/devanagari-popup-dict-<version>.zip`
ready to upload to [addons.mozilla.org (AMO)](https://addons.mozilla.org/).

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
│   │   ├── morphology.js       # Hindi/Marathi inflection rules
│   │   ├── pos-labels.js       # Unified part-of-speech tag mapping
│   │   ├── settings.js         # User options storage & validation
│   │   ├── tooltip.js          # Shadow DOM tooltip UI
│   │   └── translit.js         # ISO 15919 transliteration engine
│   ├── content/
│   │   └── content.js          # Caret hover detection & DOM coordinator
│   ├── dict/                   # Pre-compiled JSON dictionary packs
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
│   ├── fetch_sources.py        # Dataset downloader
│   └── make_icons.py           # Pure-stdlib PNG icon generator
├── LICENSE
├── package.json
└── THIRD_PARTY_NOTICES.md
```

---

## Keyboard Shortcuts in the Tooltip

When the tooltip is visible:

| Key | Action |
|:---|:---|
| <kbd>Shift</kbd> | Toggle pinned mode (keeps tooltip open when moving mouse) |
| <kbd>A</kbd> | Play audio pronunciation (TTS) |
| <kbd>C</kbd> | Copy headword and primary definition to clipboard |
| <kbd>Esc</kbd> | Dismiss the tooltip |

---

## Licence

- Extension source code: **MIT Licence** (see `LICENSE`).
- Bundled dictionary data: see `THIRD_PARTY_NOTICES.md`.
