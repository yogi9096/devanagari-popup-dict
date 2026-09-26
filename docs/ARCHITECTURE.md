# Architecture & Design Decisions

This document explains the technical choices made while implementing the
Devanagari Popup Dictionary.

---

## 1. Zero External Dependencies

The extension is written entirely with vanilla Web APIs (DOM, Web Speech API,
Web Components/Shadow DOM, Web Extensions Storage API) and zero third-party
runtime JavaScript. Tooling runs on standard Node.js (>=18) and Python 3
without needing any `npm install` step.

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
  catalogue.json
  hi-wordnet.json
  hi-shabdkosh.json
  mr-wordnet.json
  mr-berntsen.json
```

Structure of a pack JSON:
```json
{
  "meta": {
    "id": "hi-wordnet",
    "name": "Hindi WordNet",
    "sourceLang": "hi",
    "targetLang": "en",
    "entryCount": 38879,
    "license": "CC BY-NC-SA 4.0",
    "attribution": "IIT Bombay (CFILT)"
  },
  "entries": [
    ["अंक", "n", "a number, mark, digit, or lap", "anka"],
    ...
  ],
  "index": {
    "अंक": [0, 42],
    ...
  }
}
```

- `entries` is a compact array of rows: `[headword, pos, gloss, roman]`.
- `index` maps normalized lookup keys to integer row offsets into `entries`.
- Polysemy is supported naturally: the same key points to multiple row indices.
- Prefix completion (`dict.suggest("भारत")`) scans keys lazily, capped at 8 results.

---

## 3. Two-Tier Lookup Strategy

Devanagari writing does not space inflected endings from roots. When a user
hovers over an inflected word (such as *लड़कियों* / *larkiyõ*):

1. **Exact match**: The key is normalized (nukta dropped, candrabindu folded to
   anusvara, zero-width joiners stripped) and checked directly against the
   active language packs.
2. **Morphological fallbacks**: If no exact match is found, the morphology
   engine (`src/common/morphology.js`) applies language-scoped heuristics:
   - **Hindi**: Plural oblique `-यों` → `-ी` (*लड़कियों* → *लड़की*), direct plural
     `-ियाँ` → `-ी`, masculine oblique `-ों` → `-ा`, verb endings (`-कर`, `-ते`,
     `-ती`, `-ता`, `-ने`, `-ना`, `-या`, `-ई`, `-ए`), plus irregular tables
     (*गया* → *जाना*, *हुआ* → *होना*, *कहा* → *कहना*).
   - **Marathi**: Plural `-े` → `-` / `-ी`, instrumental `-ाने` / `-ानी`,
     dative `-ला` / `-ना`, verb forms `-तात` / `-तात` / `-णे` (*करतात* → *करणे*),
     irregular pasts (*केले* → *करणे*, *झाले* → *होणे*).
3. **Cross-language fallback**: If Hindi packs fail to resolve, Marathi packs
   are consulted (and vice versa), explicitly tagged in the UI so the user
   knows the origin.

---

## 4. DOM Isolation & Shadow DOM

The popup tooltip is attached to the page inside an open `ShadowRoot`:
- Page CSS cannot bleed in and distort tooltip margins, fonts, or colors.
- Tooltip CSS cannot bleed out and alter the host page layout.
- The host page's DOM tree remains untouched; hover word detection uses
  `document.caretRangeFromPoint` / `document.caretPositionFromPoint` to
  extract text offsets without wrapping elements.
- Clean tear-down: the entire host is removed on click away, Escape press,
  or hover-off.

---

## 5. Viewport-Aware Positioning

The tooltip dynamically computes available space:
- Positions above the hovered text by default with a caret arrow.
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
