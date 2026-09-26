const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const devanagari = require('../src/common/devanagari.js');
const normalize = require('../src/common/normalize.js');
const translit = require('../src/common/translit.js');
const posLabels = require('../src/common/pos-labels.js');
const morphology = require('../src/common/morphology.js');
const settings = require('../src/common/settings.js');
const tooltip = require('../src/common/tooltip.js');

describe('devanagari segmentation', () => {
  it('extracts a word from the middle of a sentence', () => {
    const text = 'मुलगा शाळेत जातो.';
    const found = devanagari.extractWord(text, 2);
    assert.equal(found.word, 'मुलगा');
    assert.equal(found.start, 0);
    assert.equal(found.end, 5);
  });

  it('prefers the character to the left at a word edge', () => {
    const text = 'राम गेला';
    const found = devanagari.extractWord(text, 3);
    assert.equal(found.word, 'राम');
  });

  it('rejects Latin-only text', () => {
    assert.equal(devanagari.extractWord('hello world', 2), null);
  });

  it('keeps conjuncts inside the word', () => {
    const words = devanagari.findWords('तो विद्यालय गेला');
    assert.deepEqual(words.map((w) => w.word), ['तो', 'विद्यालय', 'गेला']);
  });

  it('trims ZWJ/ZWNJ from the edges', () => {
    const found = devanagari.extractWord('\u200dराम\u200c घर', 3);
    assert.equal(found.word, 'राम');
  });

  it('finds sentence context with word offsets', () => {
    const text = 'राम घरी गेला. तो झोपला.';
    const context = devanagari.sentenceAround(text, 4, 8);
    assert.ok(context.text.includes('घरी'));
    const shown = context.text.slice(context.before, context.after);
    assert.ok(shown.includes('घरी'), 'expected घरी inside ' + JSON.stringify(shown));
  });
});

describe('lookup-key normalisation', () => {
  it('drops nukta, joiners and merges candrabindu', () => {
    assert.equal(normalize.looseKey('क़'), 'क');
    assert.equal(normalize.looseKey('क्\u200dष'), 'क्ष');
    assert.equal(normalize.looseKey('अँ'), 'अं');
    assert.equal(normalize.looseKey(' राम। '), 'राम');
    assert.equal(normalize.looseKey('  House '), 'house');
    assert.equal(normalize.looseKey(''), '');
  });
});

describe('transliteration', () => {
  it('handles the inherent a', () => {
    assert.equal(translit.toIso15919('राम'), 'rāma');
    assert.equal(translit.toIso15919('विद्यालय'), 'vidyālaya');
  });

  it('kills the a before virama and honours matras', () => {
    assert.equal(translit.toIso15919('क्ष'), 'kṣa');
    assert.equal(translit.toIso15919('की'), 'kī');
    assert.equal(translit.toIso15919('स्त्री'), 'strī');
  });

  it('folds base+nukta into the nukta letter', () => {
    assert.equal(translit.toIso15919('क़िला'), 'qilā');
  });

  it('assimilates anusvara to the following stop', () => {
    assert.equal(translit.toIso15919('अंग'), 'aṅga');
    assert.equal(translit.toIso15919('मुंबई'), 'mumbaī');
    assert.equal(translit.simplify(translit.toIso15919('मुंबई')), 'mumbai');
    assert.equal(translit.toIso15919('दुःख'), 'duḥkha');
    assert.equal(translit.toIso15919('डोळा'), 'ḍoḷā');
  });

  it('simplifies diacritics', () => {
    assert.equal(translit.simplify('aṅga ḍoḷā'), 'anga dola');
  });
});

describe('part-of-speech labels', () => {
  it('maps the markers used across the sources', () => {
    assert.equal(posLabels.label('m'), 'masculine noun');
    assert.equal(posLabels.label('adj. inv.'), 'adjective (invariable)');
    assert.equal(posLabels.label('(nm)'), 'masculine noun');
    assert.equal(posLabels.label('mc'), 'masculine, countable');
    assert.equal(posLabels.label(''), '');
  });
});

describe('morphology', () => {
  it('recovers Hindi lemmas', () => {
    const hi = (w) => morphology.candidates(w, 'hi').map((c) => c.word);
    assert.ok(hi('लड़कियों').includes('लड़की'));
    assert.ok(hi('लड़कों').includes('लड़का'));
    assert.ok(hi('घरों').includes('घर'));
    assert.ok(hi('बच्चों').includes('बच्चा'));
    assert.ok(hi('करता').includes('करना'));
    assert.ok(hi('करने').includes('करना'));
    assert.ok(hi('गया').includes('जाना'), 'irregular past of जाना');
  });

  it('recovers Marathi lemmas', () => {
    const mr = (w) => morphology.candidates(w, 'mr').map((c) => c.word);
    assert.ok(mr('मुलगे').includes('मुलगा'));
    assert.ok(mr('मुलग्यां').includes('मुलगा'));
    assert.ok(mr('घरां').includes('घर'));
    assert.ok(mr('मुले').includes('मूल'), 'irregular plural');
    assert.ok(mr('करतो').includes('करणे'));
    assert.ok(mr('करतात').includes('करणे'));
    assert.ok(mr('बोलला').includes('बोलणे'));
    assert.ok(mr('गेला').includes('जाणे'), 'irregular past of जाणे');
  });

  it('never returns the word itself and caps the list', () => {
    const list = morphology.candidates('अंक', 'hi');
    assert.ok(!list.some((c) => c.word === 'अंक'));
    assert.ok(list.length <= morphology.MAX_CANDIDATES);
  });
});

describe('settings', () => {
  it('normalises unknown input to safe defaults', () => {
    const merged = settings.normalize({ hoverDelay: 99999, languages: { mr: true } });
    assert.equal(merged.hoverDelay, 5000);
    assert.equal(merged.languages.mr, true);
    assert.equal(merged.enabled, true);
  });

  it('repairs an all-languages-off state', () => {
    const merged = settings.normalize({ languages: { hi: false, mr: false } });
    assert.equal(merged.languages.hi, true);
  });

  it('matches disabled hosts including subdomains', () => {
    const base = settings.normalize({ disabledHosts: ['mail.example.com', '*.other.org'] });
    assert.equal(settings.hostDisabled(base, 'mail.example.com'), true);
    assert.equal(settings.hostDisabled(base, 'sub.other.org'), true);
    assert.equal(settings.hostDisabled(base, 'evil.com'), false);
  });
});

describe('tooltip helpers', () => {
  it('splits numbered senses', () => {
    assert.deepEqual(
      tooltip.splitSenses('1. number. 2. issue (of a magazine). 3. act (of a play).'),
      ['number.', 'issue (of a magazine).', 'act (of a play).'],
    );
    assert.deepEqual(tooltip.splitSenses('just a gloss'), ['just a gloss']);
  });

  it('resolves the theme', () => {
    assert.equal(tooltip.resolveTheme('dark', {}), 'dark');
  });
});
