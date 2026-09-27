/**
 * Dictionary pack loading and lookup.
 *
 * Packs are static JSON files shipped inside the extension (dict/<id>.json)
 * described by dict/index.json.  A pack is fetched lazily the first time one of
 * its languages is used on a page, then kept for the lifetime of that page, so
 * enabling a language costs one request and only when it is needed.
 *
 * Answer language: a pack is keyed by the side the reader points at, and its
 * `targetLang` is the language the answer is written in.  That is what the
 * `languages` setting selects on.  The UI only offers Hindi, so in practice
 * `targetLang` is always 'hi', but the pipeline stays language-generic so
 * another pack can be added without touching the lookup.
 *
  * Pack layout (see tools/build_dict.py):
  *   entries: [[headword, pos, gloss, roman, sense], ...]   (always 5 fields)
  *   index:   { <loose key>: [row, row, ...] }
  *
  * For an English -> Devanagari pack `gloss` is the Hindi word and
  * `sense` is the English sense that word answers, which is what lets the popup
  * say *why* a given translation was offered.  `roman` may be empty; `sense`
  * may be empty; `headword`, `pos` and `gloss` are always strings.
  */

(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const compat = isNode ? require('./compat') : (global.DecDi && global.DecDi.compat);
  const normalize = isNode ? require('./normalize') : (global.DecDi && global.DecDi.normalize);
  const morphology = isNode ? require('./morphology') : (global.DecDi && global.DecDi.morphology);
  const devanagari = isNode ? require('./devanagari') : (global.DecDi && global.DecDi.devanagari);

  const CATALOG_PATH = 'dict/index.json';
  const SUGGEST_LIMIT = 6;
  const MIN_SUGGEST_PREFIX = 2;
  const DEFAULT_MAX_MATCHES = 4;

  /** Module-level caches so every lookup on a page reuses the parsed packs. */
  const packCache = new Map();
  let catalogCache = null;

  function rowToMatch(pack, row, derived) {
    const match = {
      headword: row[0],
      pos: row[1] || '',
      gloss: row[2] || '',
      roman: row[3] || '',
      sense: row[4] || '',
      pack: {
        id: pack.id,
        name: pack.name,
        license: pack.license,
        attribution: pack.attribution,
        homepage: pack.homepage,
        sourceLang: pack.sourceLang,
        targetLang: pack.targetLang,
        // The UI needs to know how to read `sense`: a pack that has no per-sense
        // definition puts an example sentence there instead and says so here.
        flags: (pack.flags || (pack.meta && pack.meta.flags) || []).slice(),
      },
    };
    if (derived) {
      // derivedFrom = the surface form the reader hovered, derivedLemma = the
      // dictionary form the entry actually lives under.
      match.derivedFrom = derived.surface || '';
      match.derivedLemma = derived.lemma || derived.word || '';
      match.derivedLabel = derived.label || '';
    }
    return match;
  }

  /**
   * The language a pack is keyed by, which is the side the reader's word is on.
   * The *answer* language is `targetLang`, and that is what the `languages`
   * setting selects on, whichever way round the lookup runs.
   */
  function answerLanguage(pack) {
    return pack.targetLang;
  }

  /**
   * The language whose morphology table can lemmatise the reader's word.
   * Devanagari is returned as the marker 'deva' because one table selection
   * covers every Devanagari language on offer (see lookup()).
   */
  function lemmaLanguageFor(word) {
    return devanagari.scriptAt(word, 0) === 'deva' ? 'deva' : 'en';
  }

  /**
   * Re-assemble a pack from its shards.
   *
   * A pack above AMO's 5 MB parse limit is written as several files (see
   * MAX_SHARD_BYTES in tools/build_dict.py), and each shard's index points into
   * that shard's own entries.  Positions are therefore re-based onto the joined
   * array, and a word whose senses straddle a shard boundary has its positions
   * split across two shards - so a repeated key is concatenated, not replaced.
   * The joined pack is indistinguishable from a single-file one.
   */
  function joinShards(parts) {
    if (parts.length === 1) {
      return parts[0];
    }
    const pack = Object.assign({}, parts[0], { entries: [], index: {} });
    let offset = 0;
    for (const part of parts) {
      const entries = part.entries || [];
      for (const key of Object.keys(part.index || {})) {
        const positions = part.index[key].map((position) => position + offset);
        pack.index[key] = pack.index[key] ? pack.index[key].concat(positions) : positions;
      }
      for (const row of entries) {
        pack.entries.push(row);
      }
      offset += entries.length;
    }
    pack.count = pack.entries.length;
    pack.uniqueKeys = Object.keys(pack.index).length;
    // The shard header describes one file, not the joined pack.
    delete pack.shard;
    return pack;
  }

  class Dictionary {
    constructor(options) {
      const optionsValue = options || {};
      this.baseUrl = optionsValue.baseUrl || '';
      this.catalog = null;
      this.packs = new Map();
      this.failed = new Set();
    }

    path(relative) {
      return this.baseUrl ? this.baseUrl.replace(/\/$/, '') + '/' + relative : relative;
    }

    async loadCatalog() {
      if (this.catalog) {
        return this.catalog;
      }
      if (catalogCache) {
        this.catalog = catalogCache;
        return this.catalog;
      }
      // Must be an absolute extension URL, exactly like the packs below.  A bare
      // relative path would be resolved against the *page* by fetch() in a
      // content script, turning every lookup into a 404 against the site.
      const catalog = await compat.fetchJson(compat.getUrl(this.path(CATALOG_PATH)));
      if (!catalog || !Array.isArray(catalog.packs)) {
        throw new Error(CATALOG_PATH + ' does not contain a packs array');
      }
      catalogCache = catalog;
      this.catalog = catalog;
      return catalog;
    }

    /** Enabled packs, in catalogue order (the first pack is the preferred one). */
    async selectPacks(settings) {
      const catalog = await this.loadCatalog();
      const languages = (settings && settings.languages) || {};
      return catalog.packs.filter((meta) => {
        // `languages` names the language the answer is *written* in, which is
        // the pack's target side.
        if (!languages[answerLanguage(meta)]) {
          return false;
        }
        const explicit = settings && settings.packs ? settings.packs[meta.id] : undefined;
        if (explicit === undefined || explicit === null) {
          return Boolean(settings.useCatalogDefaults && meta.default);
        }
        return Boolean(explicit);
      });
    }

    async loadPack(meta) {
      if (this.packs.has(meta.id)) {
        return this.packs.get(meta.id);
      }
      if (!packCache.has(meta.id)) {
        // A pack may be split into shards, because AMO's validator will not
        // parse a .json of 5 MB or more.  `files` is the current catalogue shape;
        // `file` is the older single-file one, still honoured.
        const names = (Array.isArray(meta.files) && meta.files.length) ? meta.files : [meta.file];
        if (!names[0]) {
          throw new Error('pack ' + meta.id + ' has neither file nor files in the catalogue');
        }
        packCache.set(meta.id, Promise.all(names.map((name) => compat.fetchJson(compat.getUrl(name))))
          .then((parts) => {
            const pack = joinShards(parts);
            pack.meta = meta;
            pack.sortedKeys = null;
            return pack;
          }).catch((error) => {
            packCache.delete(meta.id);
            throw error;
          }));
      }
      const pack = await packCache.get(meta.id);
      this.packs.set(meta.id, pack);
      return pack;
    }

    /** Load every enabled pack (called once, on the first lookup of a page). */
    async preload(settings) {
      const metas = await this.selectPacks(settings);
      const results = await Promise.allSettled(metas.map((meta) => this.loadPack(meta)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          this.failed.add(metas[index].id);
        }
      });
      return this.failed.size === 0;
    }

    keysFor(word) {
      const key = normalize.looseKey(word);
      return key ? [key] : [];
    }

    /** Raw rows for one normalised key inside one pack. */
    rowsFor(pack, key) {
      if (!key || !pack || !pack.index) {
        return [];
      }
      // The index is a plain object parsed from JSON, so it inherits from
      // Object.prototype.  Without an own-property check, looking up the word
      // "constructor" would find the inherited constructor function and then
      // throw "positions is not iterable" on it.
      if (!Object.prototype.hasOwnProperty.call(pack.index, key)) {
        return [];
      }
      const positions = pack.index[key];
      if (!Array.isArray(positions)) {
        return [];
      }
      const rows = [];
      for (const position of positions) {
        const row = pack.entries[position];
        if (row) {
          rows.push(row);
        }
      }
      return rows;
    }

    /**
     * Look a word up in every enabled pack.
     *
     * The surface form is always tried first so an exact entry can never be
     * hidden by an inflection guess; only when the caller allows it do we walk
     * the lemma candidates produced by src/common/morphology.js.
     *
     * @param {string} word      the form under the cursor
     * @param {object} settings
     * @returns {Promise<object>} {query, languages, matches, tried, missing, packErrors}
     */
    async lookup(word, settings) {
      const config = settings || {};
      const languages = ['hi'].filter((code) => !config.languages || config.languages[code]);

      const exactKeys = this.keysFor(word);
      const exactKey = exactKeys[0] || '';
      const maxMatches = Number(config.maxMatches) || DEFAULT_MAX_MATCHES;
      const tried = [];
      const seen = new Set();

      // Rows are gathered without a cap and assembled at the end, because a
      // plain cap lets the first pack fill every slot: with a 140k-entry
      // terminology pack enabled alongside a 3k-entry everyday one, a reader
      // asking for a common word could see nothing but a second, rarer sense
      // of it.
      const found = [];

      const addRows = (pack, rows, derived) => {
        for (const row of rows) {
          // The answer language is part of a row's identity, so a pack added
          // for a second language later would not be silently deduped against
          // the first one's translation of the same word.
          const answer = pack.meta.targetLang;
          const dedupeKey = [answer, row[0], row[1], row[2], row[4]].join(' ');
          if (seen.has(dedupeKey)) {
            continue;
          }
          // Drop a terser duplicate of an entry we already show: two packs often
          // carry the same translation with only the wording or the POS changed.
          const duplicate = found.some((match) => match.pack.targetLang === answer
            && match.headword === row[0]
            && match.gloss === row[2]);
          if (duplicate) {
            continue;
          }
          seen.add(dedupeKey);
          found.push(rowToMatch(pack, row, derived));
        }
      };

      /**
       * Pick the rows to show: one from every pack first, then fill the rest.
       *
       * `found` arrives pack by pack in catalogue order, so taking the first
       * matching row per *language* spent every slot on whichever pack happens
       * to be listed first: with the 143,939-entry terminology pack ahead of
       * the 3,403-entry everyday one, a reader asking for a common word saw
       * nothing but that pack's rarer senses.  One row per pack guarantees the
       * second pack is represented before either is allowed a second row.
       *
       * Languages are still visited in order, so a pack answering in a later
       * language cannot take the slot belonging to an earlier one.
       */
      const assemble = () => {
        const out = [];
        const taken = new Set();
        const seenPacks = new Set();
        for (const language of languages) {
          for (let index = 0; index < found.length; index += 1) {
            const match = found[index];
            if (match.pack.targetLang !== language || seenPacks.has(match.pack.id)) {
              continue;
            }
            seenPacks.add(match.pack.id);
            taken.add(index);
            out.push(match);
            if (out.length >= maxMatches) {
              return out;
            }
          }
        }
        for (let index = 0; index < found.length && out.length < maxMatches; index += 1) {
          if (!taken.has(index)) {
            out.push(found[index]);
          }
        }
        return out;
      };

      const metas = await this.selectPacks(config);
      const packs = [];
      for (const meta of metas) {
        try {
          packs.push(await this.loadPack(meta));
        } catch (error) {
          this.failed.add(meta.id);
        }
      }

      for (const pack of packs) {
        addRows(pack, this.rowsFor(pack, exactKey), null);
      }

      if (config.showDerived !== false && found.length < maxMatches) {
        /*
         * Inflection handling.
         *
         * The reader's word sits on the *head* side of every pack, so a
         * candidate lemma is only worth trying against a pack keyed by the same
         * language.  An English lemma (from the English rules) applies to every
         * English-headed pack; a Devanagari lemma produced by the Hindi rules
         * applies only to packs headed in that language, so a Hindi-suffixed
         * guess is never offered as if it were an English misspelling.
         */
        const headLanguage = lemmaLanguageFor(word);
        const tableLanguages = headLanguage === 'deva' ? languages : [headLanguage];
        const candidates = [];
        for (const language of tableLanguages) {
          for (const candidate of morphology.candidates(word, language)) {
            if (!candidates.some((other) => other.candidate.word === candidate.word)) {
              candidates.push({ candidate, table: language });
            }
          }
        }
        for (const { candidate, table } of candidates) {
          if (found.length >= maxMatches) {
            break;
          }
          const key = normalize.looseKey(candidate.word);
          if (!key || key === exactKey) {
            continue;
          }
          const before = found.length;
          for (const pack of packs) {
            const applicable = headLanguage === 'deva'
              ? pack.meta.sourceLang === table
              : pack.meta.sourceLang === headLanguage;
            if (!applicable) {
              continue;
            }
            addRows(pack, this.rowsFor(pack, key), {
              surface: word,
              lemma: candidate.word,
              label: candidate.label,
            });
          }
          if (found.length > before) {
            tried.push(candidate);
          }
        }
      }

      const matches = assemble();

      return {
        query: word,
        languages,
        matches,
        tried,
        packErrors: Array.from(this.failed),
        missing: matches.length === 0,
      };
    }

    /** Headwords that start with the query, for "did you mean". */
    async suggest(word, settings, limit) {
      const key = normalize.looseKey(word);
      if (!key || key.length < MIN_SUGGEST_PREFIX) {
        return [];
      }
      const max = Number(limit) || SUGGEST_LIMIT;
      const out = [];
      const seen = new Set();

      let metas = [];
      try {
        metas = await this.selectPacks(settings || {
          languages: { hi: true, mr: true },
          useCatalogDefaults: true,
        });
      } catch (error) {
        return [];
      }

      for (const meta of metas) {
        let pack;
        try {
          pack = await this.loadPack(meta);
        } catch (error) {
          continue;
        }
        if (!pack.sortedKeys) {
          pack.sortedKeys = Object.keys(pack.index).sort();
        }
        const keys = pack.sortedKeys;
        let low = 0;
        let high = keys.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (keys[middle] < key) {
            low = middle + 1;
          } else {
            high = middle;
          }
        }
        for (let index = low; index < keys.length && out.length < max; index += 1) {
          const candidateKey = keys[index];
          if (candidateKey.slice(0, key.length) !== key) {
            break;
          }
          const positions = this.rowsFor(pack, candidateKey);
          const row = positions.length ? positions[0] : null;
          if (row && !seen.has(row[0])) {
            seen.add(row[0]);
            out.push({ headword: row[0], gloss: row[2], pack: meta.id });
          }
        }
        if (out.length >= max) {
          break;
        }
      }
      return out;
    }
  }

  const namespace = {
    Dictionary,
    CATALOG_PATH,
    SUGGEST_LIMIT,
    packCache,
    resetCache() {
      packCache.clear();
      catalogCache = null;
    },
  };

  global.DecDi = Object.assign(global.DecDi || {}, { dictionary: namespace });
  if (isNode) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
