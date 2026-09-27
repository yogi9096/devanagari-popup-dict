const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const normalize = require('../src/common/normalize.js');

const ROOT = path.join(__dirname, '..');

/**
 * These run against the real packs in src/dict, which are English -> Hindi and
 * English -> Marathi: the reader points at an English word and the popup answers
 * in Devanagari.  The modules are loaded into a fresh vm context so this runner
 * does not share module-level pack caches with the unit tests.
 */
describe('dictionary integration (real packs)', () => {
  let DecDi;
  let dict;
  let cfg;
  let requested;

  before(() => {
    const sandbox = {};
    const load = (relative) => {
      const filename = path.join(ROOT, relative);
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    };
    load('src/common/compat.js');
    load('src/common/devanagari.js');
    load('src/common/normalize.js');
    load('src/common/morphology.js');
    load('src/common/settings.js');
    load('src/common/dictionary.js');
    DecDi = sandbox.DecDi;
    // Stand in for a browser: getUrl() must produce an absolute extension URL,
    // and fetchJson() must reject anything that is not one.  Resolving relative
    // paths against disk instead is what let a content-script-breaking bug
    // (fetch('dict/index.json') resolving against the *page* origin) pass CI.
    DecDi.compat.getUrl = (p) => 'moz-extension://test-uuid/' + String(p).replace(/^\/+/, '');
    DecDi.compat.fetchJson = async (url) => {
      requested = requested || [];
      requested.push(String(url));
      if (!/^moz-extension:\/\/[^/]+\//.test(String(url))) {
        throw new Error('refusing non-absolute URL: ' + url);
      }
      return JSON.parse(fs.readFileSync(
        path.join(ROOT, 'src', String(url).replace(/^moz-extension:\/\/[^/]+\//, '')),
        'utf8',
      ));
    };
    dict = new DecDi.dictionary.Dictionary({ baseUrl: '' });
    cfg = DecDi.settings.normalize({});
    DecDi.dictionary.resetCache();
    requested = [];
  });

  it('fetches the catalogue and every pack from an absolute extension URL', async () => {
    await dict.loadCatalog();
    const result = await dict.lookup('word', cfg);
    assert.ok(result.matches.length > 0, 'the lookup should have produced answers');
    assert.ok(requested.length >= 2, 'expected the catalogue and at least one pack');
    const relative = requested.filter((u) => !/^moz-extension:\/\//.test(u));
    assert.deepEqual(relative, [],
      'a relative URL would be fetched against the page, not the extension: '
      + relative.join(', '));
  });

  it('defaults to answering in Hindi and nothing else', () => {
    assert.equal(cfg.trigger, 'selection');
    assert.equal(cfg.languages.hi, true);
    assert.equal('mr' in cfg.languages, false, 'Marathi must not come back');
  });

  it('loads the catalogue with the English-headed Hindi packs', async () => {
    const catalog = await dict.loadCatalog();
    const ids = catalog.packs.map((p) => p.id).sort();
    assert.deepEqual(ids, ['en-freedict-anusaaraka', 'en-raghuvira', 'en-wiktionary-hi']);
    for (const pack of catalog.packs) {
      assert.equal(pack.sourceLang, 'en', `${pack.id} should be keyed by English`);
      assert.equal(pack.targetLang, 'hi', `${pack.id} should answer in Hindi`);
      assert.ok(pack.count > 0);
    }
  });

  it('declares the licence of every pack it ships', async () => {
    // The popup prints these in its footer, and one of the packs is GPL: the
    // pack is a derived work of a GPL dictionary, so it has to say so.
    const catalog = await dict.loadCatalog();
    for (const pack of catalog.packs) {
      assert.ok(pack.license, `${pack.id} needs a licence`);
      assert.ok(pack.attribution, `${pack.id} needs attribution`);
    }
    const anusaaraka = catalog.packs.find((p) => p.id === 'en-freedict-anusaaraka');
    assert.match(anusaaraka.license, /GNU General Public License|GPL/);
    assert.equal(anusaaraka.default, true, 'the everyday pack must be on by default');
  });

  it('answers the ordinary verbs the terminology packs are missing', async () => {
    // "learn", "listen" and "go" are absent from both Raghu Vira (a 1963
    // government terminology dictionary) and the Wiktionary translation tables
    // (which carry Hindi for almost no common verbs).  These are the words a
    // reader is most likely to point at, so a pack has to cover them.
    for (const word of ['learn', 'listen', 'go', 'sleep', 'write', 'give']) {
      const result = await dict.lookup(word, cfg);
      assert.ok(!result.missing, `"${word}" should be found`);
      assert.ok(result.matches.some((m) => m.pack.id === 'en-freedict-anusaaraka'),
        `"${word}" should be answered by the everyday pack, got `
        + result.matches.map((m) => m.pack.id).join(', '));
    }
  });

  it('carries a part of speech and an example for the everyday pack', async () => {
    const result = await dict.lookup('learn', cfg);
    const everyday = result.matches.filter((m) => m.pack.id === 'en-freedict-anusaaraka');
    assert.ok(everyday.length > 0);
    assert.ok(everyday.every((m) => m.pos), 'the source tags a part of speech on every row');
    assert.ok(
      everyday.some((m) => m.sense),
      `expected an English example sentence, got ${JSON.stringify(everyday.map((m) => m.sense))}`,
    );
  });

  it('leaves no cross-reference markup in an answer', async () => {
    // The source writes senses like "समाना[<जाना]" and "हो_जाना{स्थिति}"; the
    // popup prints the gloss verbatim, so that markup has to be gone.
    for (const word of ['go', 'make', 'work', 'love', 'read']) {
      const result = await dict.lookup(word, cfg);
      for (const match of result.matches) {
        assert.doesNotMatch(match.gloss, /[\[\]]|\{\}|\[[^\]]*<|<[A-Za-z/]+>/,
          `${word} -> ${match.gloss}`);
        assert.ok(DecDi.devanagari.DEVANAGARI_CHAR.test(match.gloss),
          `${word} -> ${match.gloss}`);
      }
    }
  });

  it('every row has the five-column shape', async () => {
    const catalog = await dict.loadCatalog();
    for (const meta of catalog.packs) {
      for (const name of meta.files) {
        const shard = JSON.parse(
          fs.readFileSync(path.join(ROOT, 'src', name), 'utf8'),
        );
        assert.ok(shard.entries.length > 0, `${name} should not be empty`);
        for (const row of shard.entries.slice(0, 200)) {
          assert.equal(row.length, 5, `${name} row width`);
          assert.equal(typeof row[0], 'string');
          assert.ok(row[2].length > 0, `${name} row needs an answer`);
          assert.ok(
            DecDi.devanagari.DEVANAGARI_CHAR.test(row[2]),
            `${name} answer should be Devanagari, got ${row[2]}`,
          );
        }
      }
    }
  });

  it('keeps every shipped pack file under AMO\'s parse limit', async () => {
    // addons-linter picks its scanner from the file extension and refuses to
    // parse a .json of 5 MB or more, which is a hard validation ERROR rather
    // than a warning.  A pack above that size has to be written as shards, so
    // this is the guard that stops one silently becoming unshippable.
    const catalog = await dict.loadCatalog();
    const LIMIT = 5 * 1024 * 1024;
    for (const meta of catalog.packs) {
      for (const name of meta.files) {
        const bytes = fs.statSync(path.join(ROOT, 'src', name)).size;
        assert.ok(bytes < LIMIT,
          `${name} is ${bytes} bytes, at or above AMO's ${LIMIT} byte limit`);
      }
    }
  });

  it('joins a sharded pack back into one usable index', async () => {
    // The terminology pack is 16 MB and ships as several shards, each with an
    // index pointing into its own entries.  The runtime re-bases those positions
    // when it joins them, and a word whose senses straddle a boundary must end up
    // with all of them rather than the last shard's copy winning.
    const catalog = await dict.loadCatalog();
    const meta = catalog.packs.find((p) => p.id === 'en-raghuvira');
    assert.ok(meta.files.length > 1, 'the terminology pack should be sharded');

    const pack = await dict.loadPack(meta);
    assert.equal(pack.entries.length, meta.count,
      'the joined pack should hold every row');
    assert.equal(pack.shard, undefined, 'the joined pack is not itself a shard');

    // Every index position must be in range and must land on a row with the
    // headword that key normalises to - which is exactly what breaks if the
    // positions are not re-based.
    for (const [key, positions] of Object.entries(pack.index)) {
      for (const position of positions) {
        assert.ok(position >= 0 && position < pack.entries.length,
          `index key ${key} -> row ${position} is out of range`);
        const row = pack.entries[position];
        assert.equal(normalize.looseKey(row[0]), key,
          `index key ${key} -> row ${position} is headword ${row[0]}`);
      }
    }

    // At least one headword must genuinely straddle a boundary, or the
    // concatenating half of joinShards is untested by the pack above.
    const perShard = new Map();
    for (const name of meta.files) {
      const shard = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', name), 'utf8'));
      for (const key of Object.keys(shard.index)) {
        perShard.set(key, (perShard.get(key) || 0) + 1);
      }
    }
    const straddling = [...perShard.values()].filter((n) => n > 1).length;
    assert.ok(straddling > 0,
      'expected at least one headword to span two shards, so the join is exercised');

    // And a real lookup still resolves through the join.
    const result = await dict.lookup('catalyst', cfg);
    assert.ok(!result.missing, 'catalyst should be found through the joined shards');
  });

  it('answers the English word "word" in Hindi', async () => {
    const result = await dict.lookup('word', cfg);
    assert.ok(!result.missing, 'word should be found');
    const hindi = result.matches.filter((m) => m.pack.targetLang === 'hi');
    assert.ok(hindi.length > 0, 'expected a Hindi answer');
    assert.ok(hindi.some((m) => m.gloss.includes('शब्द')));
  });

  it('gives every pack a turn before letting one pack take a second slot', async () => {
    // "water" is in all three packs, and Raghu Vira lists several senses of it in
    // a row (a Finance one first, being a government terminology dictionary).
    // Taking one row per *language* rather than per *pack* handed every leading
    // slot to whichever pack the catalogue happens to list first.
    const result = await dict.lookup('water', cfg);
    const packs = result.matches.map((m) => m.pack.id);
    const packCount = new Set(packs).size;
    assert.equal(packCount, 3, `expected all three packs, got ${packs.join(', ')}`);
    // The leading rows are one per pack, before any pack takes a second slot.
    assert.equal(new Set(packs.slice(0, packCount)).size, packCount,
      `the first ${packCount} rows should be one per pack, got ${packs.join(', ')}`);
  });

  it('leads with the everyday sense, not the specialist one', async () => {
    // Raghu Vira orders its senses by domain, so a government terminology
    // dictionary lists a Finance sense of "water" before the ordinary one.  The
    // everyday pack is listed first in the catalogue and assembly takes one row
    // per pack in that order, so the answer a reader wants is the first row.
    const result = await dict.lookup('water', cfg);
    assert.ok(result.matches.length > 1);
    assert.equal(result.matches[0].pack.id, 'en-freedict-anusaaraka');
    assert.equal(result.matches[0].gloss, 'पानी');
  });

  it('marks which packs store an example instead of a definition', async () => {
    // The `sense` column means different things per pack, so the pack has to say
    // which: the popup labels an example rather than passing it off as a gloss.
    const result = await dict.lookup('learn', cfg);
    const everyday = result.matches.find((m) => m.pack.id === 'en-freedict-anusaaraka');
    assert.ok(everyday.pack.flags.includes('with-examples'));
    const raghuvira = await dict.lookup('water', cfg);
    assert.equal(
      raghuvira.matches.find((m) => m.pack.id === 'en-raghuvira').pack.flags
        .includes('with-examples'),
      false,
      'Raghu Vira stores definitions, not examples',
    );
  });

  it('tags every part of speech with a label the UI can print', async () => {
    // A raw dictd tag leaking through ("det/pron") is printed verbatim in the
    // popup, so every marker a pack emits has to resolve.
    const catalog = await dict.loadCatalog();
    const labels = require('../src/common/pos-labels.js');
    for (const meta of catalog.packs) {
      const pack = await dict.loadPack(meta);
      const seen = new Set(pack.entries.map((row) => row[1]));
      for (const pos of seen) {
        if (!pos) continue;
        const label = labels.label(pos);
        assert.ok(label && label === label.toLowerCase() && /^[a-z]/.test(label),
          `${meta.id} has an unlabelled part of speech: ${JSON.stringify(pos)}`);
      }
    }
  });

  it('never returns a Marathi answer, even from a stale pack', async () => {
    const catalog = await dict.loadCatalog();
    assert.ok(catalog.packs.every((p) => p.targetLang !== 'mr'));
    const result = await dict.lookup('word', cfg);
    assert.ok(result.matches.every((m) => m.pack.targetLang === 'hi'));
  });

  it('carries the English sense that each translation answers', async () => {
    const result = await dict.lookup('dictionary', cfg);
    const withSense = result.matches.filter((m) => m.sense);
    assert.ok(withSense.length > 0, 'expected at least one sense');
    assert.ok(
      withSense.some((m) => /reference work/i.test(m.sense)),
      `no dictionary sense among ${JSON.stringify(withSense.map((m) => m.sense))}`,
    );
  });

  it('keeps the headword English and the answer Devanagari', async () => {
    const result = await dict.lookup('water', cfg);
    assert.ok(!result.missing);
    for (const match of result.matches) {
      assert.equal(match.headword.toLowerCase(), 'water');
      assert.ok(DecDi.devanagari.DEVANAGARI_CHAR.test(match.gloss), match.gloss);
    }
  });

  it('offers the dictionary form of an inflected English word', async () => {
    // "words" is not itself a headword in the packs; the morphology pass should
    // still find it by reducing it to "word".
    const result = await dict.lookup('words', cfg);
    assert.ok(
      result.matches.some((m) => m.headword.toLowerCase() === 'word'),
      `expected a derived match for "word", got ${JSON.stringify(
        result.matches.map((m) => m.headword))} tried ${JSON.stringify(result.tried)}`,
    );
  });

  it('resolves an irregular English form', async () => {
    const result = await dict.lookup('mice', cfg);
    assert.ok(
      result.matches.some((m) => m.headword.toLowerCase() === 'mouse'),
      `expected "mouse", got ${JSON.stringify(result.matches.map((m) => m.headword))}`,
    );
  });

  it('resolves a doubled-consonant past tense', async () => {
    const result = await dict.lookup('stopped', cfg);
    assert.ok(
      result.matches.some((m) => m.headword.toLowerCase() === 'stop'),
      `expected "stop", got ${JSON.stringify(result.matches.map((m) => m.headword))}`,
    );
  });

  it('does not match the same Devanagari answer twice for one word', async () => {
    const result = await dict.lookup('nation', cfg);
    const seen = new Set();
    for (const match of result.matches) {
      const key = `${match.gloss}\u0000${match.pos}`;
      assert.ok(!seen.has(key), `duplicate row for ${key}`);
      seen.add(key);
    }
  });

  it('ignores a stored Marathi flag instead of honouring it', async () => {
    // A pre-0.3 settings file can still carry {"hi": true, "mr": true}.  The
    // reader has no way to turn mr off again, so normalisation must drop it.
    const upgraded = DecDi.settings.normalize({
      languages: { hi: true, mr: true },
      direction: 'en-x',
      primaryLanguage: 'mr',
      lookupOnSelect: true,
      showContext: true,
      showSense: false,
    });
    assert.deepEqual(Object.keys(upgraded.languages), ['hi']);
    const result = await dict.lookup('word', upgraded);
    assert.ok(result.matches.every((m) => m.pack.targetLang === 'hi'));
  });

  it('reports a miss for a word no pack has', async () => {
    const result = await dict.lookup('zzzzqqqx', cfg);
    assert.equal(result.missing, true);
    assert.equal(result.matches.length, 0);
  });

  it('suggests completions for a partial English word', async () => {
    const suggestions = await dict.suggest('nation', cfg, 5);
    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((s) => s.headword.toLowerCase().startsWith('nation')));
  });

  it('treats inherited Object properties as absent keys', async () => {
    // The pack index is a plain object parsed from JSON, so a naive
    // `pack.index[key]` finds Object.prototype members and then throws
    // "positions is not iterable" on the function it finds there.  "constructor"
    // is the interesting one: it is an ordinary English word a reader may well
    // point at, and with the everyday pack installed it really is a headword -
    // so it has to resolve through the own-property check rather than be
    // mistaken for a prototype member (or the other way round).
    const catalog = await dict.loadCatalog();
    const absent = await dict.loadPack(catalog.packs.find((p) => p.id === 'en-wiktionary-hi'));
    for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      // Length rather than deepEqual: the rows array is built in the vm realm,
      // so its prototype differs from this realm's Array.
      assert.equal(dict.rowsFor(absent, word.toLowerCase()).length, 0,
        `${word} should not resolve to an index row`);
      // The lookup must survive all four, whether or not a pack has the word.
      const result = await dict.lookup(word, cfg);
      assert.equal(typeof result.missing, 'boolean');
      for (const match of result.matches) {
        assert.ok(match.headword && typeof match.headword === 'string',
          `${word} produced a row with no headword: ${JSON.stringify(match)}`);
        assert.ok(DecDi.devanagari.DEVANAGARI_CHAR.test(match.gloss || ''),
          `${word} produced a row with no Devanagari answer: ${JSON.stringify(match.gloss)}`);
      }
    }

    // ...and a headword that genuinely is in the index still resolves.
    const everyday = await dict.loadPack(
      catalog.packs.find((p) => p.id === 'en-freedict-anusaaraka'),
    );
    assert.ok(dict.rowsFor(everyday, 'constructor').length > 0,
      'constructor is a real headword in the everyday pack');
  });
});
