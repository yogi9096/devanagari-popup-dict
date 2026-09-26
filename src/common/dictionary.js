/**
 * Dictionary pack loading and lookup.
 *
 * Packs are static JSON files shipped inside the extension (dict/<id>.json)
 * described by dict/index.json.  A pack is fetched lazily the first time one of
 * its languages is used on a page, then kept for the lifetime of that page, so
 * enabling a language costs one request and only when it is needed.
 *
 * Pack layout (see tools/build_dict.py):
 *   entries: [[headword, pos, gloss, roman?], ...]
 *   index:   { <loose key>: [row, row, ...] }
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const compat = isNode ? require('./compat') : (global.DecDi && global.DecDi.compat);
  const normalize = isNode ? require('./normalize') : (global.DecDi && global.DecDi.normalize);
  const morphology = isNode ? require('./morphology') : (global.DecDi && global.DecDi.morphology);

  const CATALOG_PATH = 'dict/index.json';
  const SUGGEST_LIMIT = 6;
  const MIN_SUGGEST_PREFIX = 2;
  const DEFAULT_MAX_MATCHES = 3;

  /** Module-level caches so every lookup on a page reuses the parsed packs. */
  const packCache = new Map();
  let catalogCache = null;

  function rowToMatch(pack, row, derived) {
    const match = {
      headword: row[0],
      pos: row[1] || '',
      gloss: row[2] || '',
      roman: row[3] || '',
      pack: {
        id: pack.id,
        name: pack.name,
        license: pack.license,
        attribution: pack.attribution,
        homepage: pack.homepage,
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
      const catalog = await compat.fetchJson(this.path(CATALOG_PATH));
      if (!catalog || !Array.isArray(catalog.packs)) {
        throw new Error('dict/index.json does not contain a packs array');
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
        if (!languages[meta.sourceLang]) {
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
        const url = compat.getUrl(meta.file);
        packCache.set(meta.id, compat.fetchJson(url).then((pack) => {
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
      const positions = pack.index[key];
      if (!positions) {
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
      const languages = ['hi', 'mr'].filter((code) => !settings.languages || settings.languages[code]);
      const primary = settings.primaryLanguage;
      languages.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));

      const exactKeys = this.keysFor(word);
      const exactKey = exactKeys[0] || '';
      const maxMatches = Number(settings.maxMatches) || DEFAULT_MAX_MATCHES;
      const matches = [];
      const tried = [];
      const seen = new Set();

      const addRows = (pack, rows, derived) => {
        for (const row of rows) {
          if (matches.length >= maxMatches) {
            return;
          }
          const dedupeKey = [row[0], row[2]].join(' ');
          if (seen.has(dedupeKey)) {
            continue;
          }
          // Drop a terser duplicate of a headword we already show (Vaze's gloss
          // for अंक and Berntsen's often differ only by wording).
          const duplicate = matches.some((match) => match.headword === row[0]
            && (match.gloss === row[2] || match.gloss.indexOf(row[2]) >= 0));
          if (duplicate) {
            continue;
          }
          seen.add(dedupeKey);
          matches.push(rowToMatch(pack, row, derived));
        }
      };

      const metas = await this.selectPacks(settings);
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

      if (settings.showDerived !== false && matches.length < maxMatches) {
        const candidates = [];
        const candidateMeta = new Map();
        for (const language of languages) {
          for (const candidate of morphology.candidates(word, language)) {
            if (!candidates.some((other) => other.word === candidate.word)) {
              candidates.push(candidate);
              candidateMeta.set(candidate.word, candidateMeta.get(candidate.word) || []);
              candidateMeta.get(candidate.word).push(language);
            }
          }
        }
        for (const candidate of candidates) {
          if (matches.length >= maxMatches) {
            break;
          }
          const key = normalize.looseKey(candidate.word);
          if (!key || key === exactKey) {
            continue;
          }
          const before = matches.length;
          for (const pack of packs) {
            // A Hindi lemma candidate belongs in Hindi-derived packs; letting a
            // Hindi-suffixed guess also match the Marathi packs produces noise
            // (e.g. करणा the trumpet for Marathi करतात).
            if (candidateMeta.has(candidate.word)) {
              const langs = candidateMeta.get(candidate.word);
              if (langs.length === 1 && langs[0] !== pack.meta.sourceLang) {
                continue;
              }
            }
            addRows(pack, this.rowsFor(pack, key), {
              surface: word,
              lemma: candidate.word,
              label: candidate.label,
            });
          }
          if (matches.length > before) {
            tried.push(candidate);
          }
        }
      }

      // When nothing was found in the packs of the word's own language, the
      // inflection tables of the *other* language may still hold the right
      // lemma (shared Devanagari vocabulary). Offer those as explicit
      // cross-language matches rather than silence.
      if (matches.length === 0 && settings.showDerived !== false) {
        const otherLanguages = ['hi', 'mr'].filter((code) => languages.indexOf(code) < 0);
        const extra = [];
        for (const language of otherLanguages) {
          for (const candidate of morphology.candidates(word, language)) {
            if (!extra.some((other) => other.word === candidate.word)) {
              extra.push(candidate);
            }
          }
        }
        for (const candidate of extra) {
          if (matches.length >= maxMatches) {
            break;
          }
          const key = normalize.looseKey(candidate.word);
          if (!key || key === exactKey) {
            continue;
          }
          const before = matches.length;
          for (const pack of packs) {
            addRows(pack, this.rowsFor(pack, key), {
              surface: word,
              lemma: candidate.word,
              label: candidate.label,
            });
          }
          if (matches.length > before) {
            tried.push(candidate);
          }
        }
      }

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
          const positions = pack.index[candidateKey];
          const row = positions && positions.length ? pack.entries[positions[0]] : null;
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
