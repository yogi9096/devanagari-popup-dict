const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const compat = require('../src/common/compat.js');
const settings = require('../src/common/settings.js');
const dictionary = require('../src/common/dictionary.js');

const ROOT = path.join(__dirname, '..');

// Read packs from disk instead of moz-extension:// URLs.
compat.fetchJson = async (url) => JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', String(url).replace(/^\/+/, '')), 'utf8'),
);

describe('dictionary integration (real packs)', () => {
  let dict;
  let cfg;

  before(async () => {
    // Each module attaches itself to the shared DecDi namespace when it is
    // required, so load them against an isolated global to keep this runner
    // independent of the unit tests.
    const sandbox = {};
    const vm = require('node:vm');
    const loadIsolated = (relative) => {
      const filename = path.join(ROOT, relative);
      const code = fs.readFileSync(filename, 'utf8');
      vm.runInNewContext(code, sandbox, { filename });
    };
    loadIsolated('src/common/compat.js');
    loadIsolated('src/common/normalize.js');
    loadIsolated('src/common/morphology.js');
    loadIsolated('src/common/settings.js');
    loadIsolated('src/common/dictionary.js');
    const DecDi = sandbox.DecDi;
    DecDi.compat.fetchJson = async (url) => JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', String(url).replace(/^\/+/, '')), 'utf8'),
    );
    dict = new DecDi.dictionary.Dictionary({ baseUrl: '' });
    cfg = DecDi.settings.normalize({});
    DecDi.dictionary.resetCache();
  });

  it('loads the catalogue with the expected packs', async () => {
    const catalog = await dict.loadCatalog();
    const ids = catalog.packs.map((p) => p.id).sort();
    assert.deepEqual(ids, ['hi-wiktionary', 'mr-berntsen', 'mr-vaze', 'mr-wiktionary']);
  });

  it('finds अंक', async () => {
    const result = await dict.lookup('अंक', cfg);
    assert.ok(!result.missing, 'अंक should be found');
    assert.ok(result.matches.some((m) => m.headword === 'अंक'));
    assert.ok(result.matches[0].gloss.length > 0);
  });

  it('resolves Hindi लड़कियों to लड़की', async () => {
    const result = await dict.lookup('लड़कियों', cfg);
    assert.ok(result.matches.length > 0, 'expected derived matches, tried: '
      + JSON.stringify(result.tried));
    const girl = result.matches[0];
    assert.equal(girl.headword, 'लड़की');
    assert.equal(girl.derivedFrom, result.query);
    assert.equal(girl.derivedLabel, 'feminine plural');
    assert.match(girl.gloss, /girl/);
  });

  it('resolves Hindi गया to जाना', async () => {
    const result = await dict.lookup('गया', cfg);
    assert.ok(result.matches.some((m) => m.headword === 'जाना'));
  });

  it('resolves Marathi करतात to करणे', async () => {
    const result = await dict.lookup('करतात', cfg);
    assert.ok(result.matches.length > 0, 'tried: ' + JSON.stringify(result.tried));
    assert.ok(result.matches.some((m) => m.headword === 'करणे'));
  });

  it('resolves Marathi मुले to मूल', async () => {
    const result = await dict.lookup('मुले', cfg);
    assert.ok(result.matches.some((m) => m.headword === 'मूल'));
  });

  it('respects the language toggles', async () => {
    const hindiOnly = settings.normalize({ languages: { hi: true, mr: false } });
    const result = await dict.lookup('करणे', hindiOnly);
    assert.ok(!result.matches.some((m) => m.headword === 'करणे' && /Marathi/i.test(m.pack.name))
      || result.missing);
  });

  it('suggests completions for unknown words', async () => {
    const suggestions = await dict.suggest('विद्या', cfg, 5);
    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((s) => s.headword.startsWith('विद्या')));
  });

  it('reports a miss with no matches', async () => {
    const result = await dict.lookup('झझझझ', cfg);
    assert.equal(result.missing, true);
    assert.equal(result.matches.length, 0);
  });
});
