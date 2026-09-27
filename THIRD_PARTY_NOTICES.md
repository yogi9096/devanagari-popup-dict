# Third-Party Notices and Licences

This extension bundles dictionary packs compiled from open lexical datasets.
Each pack retains its own license and author attribution, exposed to the user
in the extension options page and inside every lookup result (`match.pack`).

All packs shipped with 0.3.0 are keyed by the English headword and answer in
Hindi; see `README.md` for why the extension is Hindi-only. The bundle is
redistributable, but it is **not** uniformly permissive: one pack is GPL.

| Pack | Licence | Share-alike |
|:---|:---|:---|
| `en-freedict-anusaaraka` | GPL v2.0-or-later | **yes** |
| `en-raghuvira` | Public domain | no |
| `en-wiktionary-hi` | CC BY-SA 4.0 | yes |

The GPL pack is a derived work of a GPL dictionary, so the pack file itself is
distributed under the same terms. The extension's own source code is a separate
work and stays MIT (see *Extension Code* below): the pack is a standalone JSON
data file, not a derivative of the code, and it is shipped unmodified in
substance so that it can be replaced by a rebuilt pack carrying the same licence.

---

## 1. Anusaaraka English-Hindi Dictionary (FreeDict)

- **Pack ID**: `en-freedict-anusaaraka`
- **Direction**: English → Hindi
- **Source**: *Anusaaraka English-Hindi Dictionary, Version 2.0*, Language
  Technologies Research Centre, IIIT Hyderabad (developed through a voluntary
  collaborative effort, funded by Satyam Computers), carried and cleaned up by
  the [FreeDict](https://github.com/freedict/fd-dictionaries/tree/master/eng-hin)
  project and mirrored by
  [indic-dict/stardict-hindi](https://github.com/indic-dict/stardict-hindi)
- **Licence**: GNU General Public License, version 2.0 or (at your option) any
  later version
- **Licence reference**: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
- **Derived entries**: 25,250 (22,554 unique headwords)
- **Notice**: This pack is a derivative work of a GPL-licensed dictionary and is
  distributed under the same licence. The source's own terms state that "the
  resulting work must also be licenced under GPL", and this pack is that
  resulting work. It must not be redistributed under terms stricter or looser
  than the GPL without permission from the upstream authors.
- **Notes**: The only substantial *general purpose* English→Hindi source that can
  be redistributed. Unlike Wiktionary's translation tables — which carry Hindi
  for almost no common verbs — it covers ordinary vocabulary, so `learn`,
  `listen` and `go` all resolve. Each row keeps the source's part of speech, and
  the source's English example sentence is stored in the entry's `sense` column,
  since the dictionary has no per-sense English definition. Quality is uneven by
  the source's own admission ("Database Status: low quality"); cross-references
  and grammatical notes are stripped at build time.

---

## 2. Raghu Vira's English-Hindi Dictionary

- **Pack ID**: `en-raghuvira`
- **Direction**: English → Hindi
- **Source**: Government of India publication, digitized by the
  [indic-dict/stardict-hindi](https://github.com/indic-dict/stardict-hindi) project
- **Attribution**: Dr. Raghu Vira, *A Comprehensive English-Hindi Dictionary of
  Government and Educational Words and Phrases*
- **Licence**: Public domain (Government of India publication)
- **Licence reference**: https://en.wikipedia.org/wiki/Public_domain
- **Derived entries**: 143,939
- **Notes**: A terminology dictionary covering administrative, scientific and
  educational vocabulary. Each row's English glossary text is retained as the
  entry's `sense`, which is how the tooltip can show what a term refers to.
  Coverage of everyday conversational vocabulary is limited by the nature of
  the source, which is why the Anusaaraka pack above is the default answer for
  ordinary words.

---

## 3. Wiktionary English to Hindi

- **Pack ID**: `en-wiktionary-hi`
- **Direction**: English → Hindi
- **Source**: [Wiktextract](https://github.com/tatuylonen/wiktextract) extraction
  of English Wiktionary, published by [kaikki.org](https://kaikki.org/dictionary/English/)
- **Attribution**: Wiktionary contributors, via Wiktextract (Tatu Ylonen) / kaikki.org
- **Licence**: Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0);
  English Wiktionary text is dual-licensed CC BY-SA 4.0 / GFDL
- **Licence reference**: https://creativecommons.org/licenses/by-sa/4.0/
- **Derived entries**: 3,403
- **Notice**: You are free to share and adapt the material for any purpose,
  including commercially, provided you give appropriate credit and distribute
  contributions under the same licence. Derived from the English Wiktionary,
  which is dual-licensed under CC BY-SA 4.0 and GFDL; this pack is distributed
  under CC BY-SA 4.0.

---

## Removed Sources

Earlier development builds bundled Hindi WordNet, Shabdkosh, Marathi WordNet,
the Berntsen Marathi-English Dictionary and a Wiktionary English→Marathi pack.
None of them is part of 0.3.0 and none of their data is distributed by it. The
English→Marathi pack was dropped in 0.3.0 because Marathi answers are no longer
offered; the others were dropped earlier. Two of the removed sources
(CC BY-NC-SA 4.0 and CC BY-NC 4.0) were non-commercial only, which is one reason
they were dropped in favour of the public-domain and CC BY-SA sources above.
Their notices are kept here for provenance.

- **Hindi WordNet** — IIT Bombay (CFILT), CC BY-NC-SA 4.0, 38,879 headwords.
  > Narayan, D., Bhattacharyya, P. et al. (2002). "An Experience in Building the
  > IndoWordNet: A WordNet for Hindi". In *First International Conference on
  > Global WordNet (GWC 2002)*.
- **Shabdkosh** — Shabdkosh contributors, CC BY-SA 3.0, 10,750 headwords.
- **Marathi WordNet** — IIT Bombay (CFILT), CC BY-NC-SA 4.0, 28,746 headwords.
- **Berntsen Marathi-English** — Maxine Berntsen, *A Basic Marathi-English
  Dictionary* (1982), via Digital Dictionaries of South Asia, University of
  Chicago. CC BY-NC 4.0, 4,496 headwords.
- **Wiktionary English→Marathi** — Wiktionary contributors, via Wiktextract /
  kaikki.org, CC BY-SA 4.0, 1,158 entries.

---

## Extension Code

All original extension code (JavaScript, CSS, HTML, Python tooling, documentation)
is released under the MIT Licence (see `LICENSE`).

The two are separate works that merely travel in one archive: the packs are JSON
data read at runtime and are not linked into the code, and nothing here adds a
restriction to any pack beyond its own licence.

## Where these notices travel

`LICENSE`, this file and `LICENSES/` are kept in the repository root *and*
packaged into every release archive by `tools/build_zip.py`, so the reader of an
installed copy has the same notices a reader of the repository does.
`tools/build_zip.py` refuses to build an archive that bundles a copyleft pack
without carrying the corresponding licence text, so a pack cannot be added to the
catalogue and quietly ship non-compliant.
