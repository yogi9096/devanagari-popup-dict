const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const devanagari = require('../src/common/devanagari.js');
const normalize = require('../src/common/normalize.js');
const translit = require('../src/common/translit.js');
const posLabels = require('../src/common/pos-labels.js');
const morphology = require('../src/common/morphology.js');
const settings = require('../src/common/settings.js');
const selection = require('../src/common/selection.js');
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

  it('extracts an English word from Latin text', () => {
    const found = devanagari.extractWord('hello world', 2);
    assert.equal(found.word, 'hello');
    assert.equal(found.start, 0);
    assert.equal(found.end, 5);
    assert.equal(found.script, 'latin');
  });

  it('keeps an English hyphenated or apostrophised word whole', () => {
    assert.equal(devanagari.extractWord('a well-known fact', 4).word, 'well-known');
    assert.equal(devanagari.extractWord("don't stop", 2).word, "don't");
  });

  it('does not let a Latin run swallow surrounding punctuation', () => {
    // The character class for word characters once spanned "'" to U+2010, which
    // silently matched every ASCII symbol in between.
    for (const text of ['50% of it', 'a/b', 'x|y', 'p?q', 'n#1', 'a&b', 'f(x)']) {
      const found = devanagari.extractWord(text, 0);
      if (found) {
        assert.ok(
          /^[A-Za-z][A-Za-z'\-]*$/.test(found.word),
          `${JSON.stringify(text)} gave ${JSON.stringify(found.word)}`,
        );
      }
    }
  });

  it('finds words of both scripts in reading order', () => {
    const words = devanagari.findWords('the book मिलता है');
    assert.deepEqual(words.map((w) => w.word), ['the', 'book', 'मिलता', 'है']);
    assert.deepEqual(words.map((w) => w.script),
      ['latin', 'latin', 'deva', 'deva']);
  });

  it('reports the script under an offset', () => {
    assert.equal(devanagari.scriptAt('word शब्द', 0), 'latin');
    assert.equal(devanagari.scriptAt('word शब्द', 6), 'deva');
  });

  it('keeps conjuncts inside the word', () => {
    const words = devanagari.findWords('तो विद्यालय गेला');
    assert.deepEqual(words.map((w) => w.word), ['तो', 'विद्यालय', 'गेला']);
  });

  it('trims ZWJ/ZWNJ from the edges', () => {
    const found = devanagari.extractWord('\u200dराम\u200c घर', 3);
    assert.equal(found.word, 'राम');
  });

  it('lists every word of a mixed-script sentence in reading order', () => {
    const found = devanagari.findWords('राम आला और सीता गई');
    assert.deepEqual(found.map((entry) => entry.word), ['राम', 'आला', 'और', 'सीता', 'गई']);
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
    assert.equal(posLabels.label('mc'), 'countable masculine noun');
    assert.equal(posLabels.label(''), '');
  });

  it('reads a Wiktextract marker as one part of speech plus qualifiers', () => {
    // "n m" is a masculine noun, not a noun and a separate "m" part of speech:
    // expanding it token by token used to yield "noun masculine noun".
    assert.equal(posLabels.label('n m'), 'masculine noun');
    assert.equal(posLabels.label('n f'), 'feminine noun');
    assert.equal(posLabels.label('n n'), 'neuter noun');
    assert.equal(posLabels.label('n c'), 'countable noun');
    assert.equal(posLabels.label('n u'), 'uncountable noun');
    assert.equal(posLabels.label('prop. n'), 'proper noun');
    assert.equal(posLabels.label('prop. n m'), 'masculine proper noun');
    assert.equal(posLabels.label('name'), 'proper noun');
  });

  it('never doubles a part of speech or appends a stray gender', () => {
    const nounMarkers = ['n', 'n m', 'n f', 'n n', 'prop. n', 'prop. n m'];
    for (const marker of nounMarkers) {
      const text = posLabels.label(marker);
      assert.equal(text.split('noun').length - 1, 1,
        `${JSON.stringify(marker)} gave ${JSON.stringify(text)}`);
    }
    for (const marker of nounMarkers.concat(['adj', 'v'])) {
      const text = posLabels.label(marker);
      assert.ok(!/\bnoun (masculine|feminine|neuter)\b/.test(text),
        `${JSON.stringify(marker)} gave ${JSON.stringify(text)}`);
    }
  });

  it('leaves ordinary parts of speech alone', () => {
    assert.equal(posLabels.label('adj'), 'adjective');
    assert.equal(posLabels.label('v'), 'verb');
    assert.equal(posLabels.label('vi'), 'intransitive verb');
    assert.equal(posLabels.label('prep'), 'preposition');
    assert.equal(posLabels.label('phrase'), 'phrase');
    assert.equal(posLabels.label('interj'), 'interjection');
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
});

describe('settings', () => {
  it('normalises unknown input to safe defaults', () => {
    const merged = settings.normalize({
      hoverDelay: 99999,
      maxSelectionWords: 99,
      maxSelectionChars: 5000,
    });
    assert.equal(merged.hoverDelay, 5000);
    assert.equal(merged.maxSelectionWords, 10, 'clamped to the hard cap');
    assert.equal(merged.maxSelectionChars, 200, 'clamped to the hard cap');
    assert.equal(merged.enabled, true);
    assert.equal(merged.trigger, 'selection');
  });

  it('cannot be switched off, in any stored shape', () => {
    // There is one answer language, so a stored `hi: false` - or a legacy blob
    // with Marathi switched on - must still leave Hindi on.  A dictionary that
    // can be configured into answering nothing is not a dictionary.
    assert.equal(settings.normalize({ languages: { hi: false } }).languages.hi, true);
    assert.deepEqual(
      settings.normalize({ languages: { hi: false, mr: true } }).languages,
      { hi: true },
    );
  });

  it('drops Marathi from a stored settings blob', () => {
    const merged = settings.normalize({ languages: { hi: true, mr: true } });
    assert.deepEqual(Object.keys(merged.languages), ['hi']);
    assert.equal(settings.normalize({ languages: { mr: true } }).languages.hi, true);
  });

  it('upgrades a 0.2 settings blob to the new trigger', () => {
    // 0.2 stored a hover trigger plus a separate lookupOnSelect flag.
    const both = settings.normalize({ version: 2, trigger: 'hover', lookupOnSelect: true });
    assert.equal(both.trigger, 'both');
    const hoverOnly = settings.normalize({ version: 2, trigger: 'hover', lookupOnSelect: false });
    assert.equal(hoverOnly.trigger, 'hover');
    // 'modifier' meant "hover, but hold a key", which is now hover + modifier.
    const shifted = settings.normalize({ version: 2, trigger: 'modifier', modifier: 'Alt' });
    assert.equal(shifted.trigger, 'hover');
    assert.equal(shifted.modifier, 'Alt');
    // Legacy fields must not survive into storage.
    const legacy = settings.normalize({ version: 2, direction: 'en-x', primaryLanguage: 'mr' });
    assert.equal('direction' in legacy, false);
    assert.equal('primaryLanguage' in legacy, false);
    assert.equal('lookupOnSelect' in legacy, false);
  });

  it('looks up inside frames by default', () => {
    // A frame that is switched off never constructs a Dictionary and never warms
    // up, so it costs no pack data - only the words the reader cannot look up.
    // Selection is a document-local event, so with this off a word inside an
    // iframe produces no popup at all, and the setting read as a data-cost dial
    // when it is not one.
    assert.equal(settings.DEFAULT_SETTINGS.allowFrames, true);
    assert.equal(settings.normalize({}).allowFrames, true);
    // A stored opt-out is still honoured.
    assert.equal(settings.normalize({ allowFrames: false }).allowFrames, false);
  });

  it('gates hover on the modifier only for the hover triggers', () => {    assert.equal(settings.onSelection(settings.normalize({ trigger: 'selection' })), true);
    assert.equal(settings.onSelection(settings.normalize({ trigger: 'both' })), true);
    assert.equal(settings.onSelection(settings.normalize({ trigger: 'hover' })), false);
    assert.equal(settings.onHover(settings.normalize({ trigger: 'selection' })), false);
    assert.equal(settings.onHover(settings.normalize({ trigger: 'both' })), true);
    assert.equal(settings.onHover(settings.normalize({ trigger: 'hover', modifier: 'Shift' })), true);
    assert.equal(
      settings.onHover(settings.normalize({ trigger: 'hover', modifier: 'none' })),
      true,
      '"no key" must not be treated as a held key',
    );
  });

  it('matches disabled hosts including subdomains', () => {
    const base = settings.normalize({ disabledHosts: ['mail.example.com', '*.other.org'] });
    assert.equal(settings.hostDisabled(base, 'mail.example.com'), true);
    assert.equal(settings.hostDisabled(base, 'sub.other.org'), true);
    assert.equal(settings.hostDisabled(base, 'evil.com'), false);
  });
});

describe('selection rules', () => {
  it('accepts the plain gesture it is built for', () => {
    for (const text of ['word', '  Dictionary  ', 'New York', 'look it up']) {
      assert.equal(selection.evaluate(text).ok, true, `expected ${JSON.stringify(text)} to pass`);
    }
  });

  it('returns the word to look up', () => {
    assert.equal(selection.evaluate('  Word ').query, 'Word');
    assert.equal(selection.evaluate('look it up').query, 'look it up');
  });

  it('declines the gestures that must not open a popup', () => {
    const cases = [
      ['', 'empty'],
      ['   ', 'blank'],
      ['\n\t ', 'whitespace only'],
      ['...', 'punctuation only'],
      ['https://example.com/page', 'url'],
      ['www.example.com', 'bare domain'],
      ['someone@example.com', 'email'],
      ['1234', 'number'],
      ['42.5', 'decimal'],
      ['2026-09-26', 'date'],
      ['12,345,678', 'grouped number'],
      ['अक', 'devanagari'],
      ['中文', 'other script'],
      ['a', 'one letter'],
      ['dogs and cats and birds and mice and more', 'too many words'],
      ['module.exports.someLongInternalNameThatNobodyWouldLookUp', 'identifier'],
    ];
    for (const [text, why] of cases) {
      const verdict = selection.evaluate(text);
      assert.equal(verdict.ok, false, `expected ${why} (${JSON.stringify(text)}) to be declined`);
      assert.ok(verdict.reason, 'a decline must say why, for the console');
    }
  });

  it('declines a drag across a paragraph but allows a short phrase', () => {
    const paragraph = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    assert.equal(selection.evaluate(paragraph).ok, false, 'a paragraph is not a lookup');
    assert.equal(selection.evaluate('alpha bravo charlie delta').ok, true, 'four words is a lookup');
    // The same paragraph is fine once the reader raises their own limit.
    assert.equal(
      selection.evaluate(paragraph, { maxWords: 12, maxChars: 200 }).ok,
      true,
      'a raised limit should be respected',
    );
  });

  it('honours the configured limits', () => {
    assert.equal(selection.evaluate('alpha bravo charlie', { maxWords: 2 }).ok, false);
    assert.equal(selection.evaluate('alpha bravo charlie', { maxWords: 3 }).ok, true);
    assert.equal(selection.evaluate('abcdefgh', { maxChars: 4 }).ok, false);
    // A nonsense limit must not disable the guard rails: 13 words is a drag
    // whatever the setting says.
    const many = 'aa bb cc dd ee ff gg hh ii jj kk ll mm';
    assert.equal(selection.evaluate(many, { maxWords: 99, maxChars: 200 }).ok, false);
  });

  it('ignores a missing or silly limit', () => {
    assert.equal(selection.evaluate('alpha bravo', { maxWords: 0, maxChars: -5 }).ok, true);
  });

  it('recognises a select-all over a short document', () => {
    assert.equal(selection.looksLikeSelectAll(95, 100), true);
    assert.equal(selection.looksLikeSelectAll(20, 100), false, 'a word in a long page is not');
    assert.equal(selection.looksLikeSelectAll(20, 0), false, 'unknown document size');
    assert.equal(selection.looksLikeSelectAll(20, undefined), false);
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

  it('speaks the answer in the pack\'s own language', () => {
    assert.equal(tooltip.speechLangFor({ pack: { targetLang: 'hi' } }), 'hi-IN');
    // An unknown or missing target falls back to the only language on offer
    // rather than leaving the platform to guess.
    assert.equal(tooltip.speechLangFor({ pack: { targetLang: 'xx' } }), 'hi-IN');
    assert.equal(tooltip.speechLangFor({ pack: {} }), 'hi-IN');
  });

  it('lets the hidden attribute actually hide the popup', () => {
    // The popup is shown and hidden by toggling `hidden`, but the UA rule for it
    // is a UA-origin declaration and the stylesheet's own `display: flex` beats
    // it.  Without an explicit `[hidden]` rule in the injected stylesheet,
    // Escape and the close button left the popup on screen.
    assert.match(tooltip.CSS, /\.decdi\[hidden\]\s*\{[^}]*display:\s*none/);
    assert.match(tooltip.CSS, /\.decdi\s*\{[^}]*display:\s*flex/);
  });

  it('offers a Latin-letter rendering for when no Devanagari voice exists', () => {
    // A machine with only en-US/en-IN voices cannot pronounce Devanagari and the
    // Web Speech API says nothing when handed text no installed voice can render,
    // so the extension reads the romanisation instead.  The console line the
    // reader saw ("no voice for hi-IN; installed: en-US, en-IN, ...") is this
    // case, and it must not leave them with silence.
    const everyday = { headword: 'learn', gloss: 'सीखना; रटना', roman: '', pack: { targetLang: 'hi' } };
    // Only the first word of the answer is spoken, Devanagari first.
    assert.equal(tooltip.speechTextFor(everyday), 'सीखना');
    // सीखना -> sīkhanā -> sikhana.  The macrons are stripped because an English
    // voice reads them as separate letters.
    assert.equal(tooltip.speechFallbackFor(everyday), 'sikhana');
    assert.doesNotMatch(tooltip.speechFallbackFor(everyday), /[^\x00-\x7F]/);

    // The pack's own ISO 15919 is preferred over a re-derivation, and stripped
    // of diacritics for an English voice.
    assert.equal(
      tooltip.speechFallbackFor({ headword: 'water', gloss: 'जल; पानी', roman: 'pānī', pack: {} }),
      'pani',
    );

    // Nothing Devanagari and no romanisation: there is no fallback to offer, so
    // the caller falls back to speaking the answer unchanged.
    assert.equal(tooltip.speechFallbackFor({ headword: 'Learn', gloss: '', pack: {} }), '');
    assert.equal(tooltip.speechFallbackFor(null), '');
  });

  it('passes the fallback through to the speech callback', () => {
    const spoken = [];
    const view = new tooltip.Tooltip({
      document: { addEventListener() {}, removeEventListener() {} },
      settings: { showTts: true },
      onRequestSpeak: (text, lang, roman) => spoken.push({ text, lang, roman }),
    });
    view.result = {
      query: 'learn',
      matches: [{ headword: 'learn', gloss: 'सीखना', roman: 'sīkhnā', pack: { targetLang: 'hi' } }],
    };
    view.visible = true;
    assert.equal(view.speakCurrent(), true);
    assert.equal(spoken[0].text, 'सीखना');
    assert.equal(spoken[0].lang, 'hi-IN');
    // Simplified, not the pack's ISO 15919: an English voice cannot be asked for
    // "sīkhnā" and get anything better than one asked for "sikhna".
    assert.equal(spoken[0].roman, 'sikhna');
  });

  it('never treats a keystroke in a field as a shortcut', () => {
    // The popup is very often open over a search box, so "a" and "c" have to
    // reach the field rather than the dictionary.
    const field = (tag, extra) => Object.assign({ nodeType: 1, tagName: tag }, extra);
    for (const target of [
      field('INPUT'), field('TEXTAREA'), field('SELECT'),
      field('DIV', { isContentEditable: true }),
      field('SPAN', { closest: (sel) => (sel === '[contenteditable]' ? {} : null) }),
    ]) {
      assert.equal(tooltip.isEditableTarget(target), true, target.tagName);
    }
    // A page element that merely looks near a field is not one.
    assert.equal(tooltip.isEditableTarget(field('DIV')), false);
    assert.equal(tooltip.isEditableTarget(field('P', { isContentEditable: false })), false);
    assert.equal(tooltip.isEditableTarget(null), false);
    assert.equal(tooltip.isEditableTarget({ nodeType: 3 }), false);
  });

  it('maps A, C and Shift to speak, copy and pin', () => {
    // These are documented in the README; the popup used to have no key handler
    // at all, so A (audio), C (copy) and Shift (pin) silently did nothing.
    const pressed = [];
    const view = new tooltip.Tooltip({
      document: { addEventListener() {}, removeEventListener() {} },
      settings: { showTts: true },
      onRequestSpeak: () => pressed.push('speak'),
      onRequestCopy: () => pressed.push('copy'),    });
    view.result = { query: 'learn', matches: [{ headword: 'learn', gloss: 'सीखना', pack: { targetLang: 'hi' } }] };
    view.visible = true;

    const press = (key, extra) => {
      const event = Object.assign({
        key,
        target: { nodeType: 1, tagName: 'P', isContentEditable: false },
        ctrlKey: false, altKey: false, metaKey: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
      }, extra);
      view.handleKey(event);
      return event.defaultPrevented === true;
    };

    assert.equal(press('a'), true);
    assert.equal(press('c'), true);
    assert.equal(press('Shift'), true);
    assert.deepEqual(pressed, ['speak', 'copy']);
    assert.equal(view.pinned, true, 'Shift pins the popup');
    assert.equal(press('Shift'), true);
    assert.equal(view.pinned, false, 'Shift again unpins it');

    // Anything else is left for the page.
    assert.equal(press('x'), false);
    assert.equal(press('Enter'), false);
    // A modified keystroke belongs to the browser.
    assert.equal(press('a', { ctrlKey: true }), false);
    assert.equal(press('c', { metaKey: true }), false);
    // Typing in a field is never a shortcut.
    assert.equal(press('a', { target: { nodeType: 1, tagName: 'INPUT' } }), false);
    assert.deepEqual(pressed, ['speak', 'copy']);

    // Nothing is spoken or copied while the popup is closed.
    view.visible = false;
    assert.equal(press('a'), false);
    assert.deepEqual(pressed, ['speak', 'copy']);
  });

  it('asks the focused element, not just the event target, before shortcutting', () => {
    // A real keypress targets the focused element, so event.target would usually
    // do - but an event dispatched at the document, or one retargeted out of a
    // shadow tree, reports the document while the reader is still typing in a
    // field.  Relying on event.target alone swallowed the letter "a" there.
    const spoken = [];
    const field = { nodeType: 1, tagName: 'INPUT' };
    const view = new tooltip.Tooltip({
      document: { addEventListener() {}, removeEventListener() {}, activeElement: field },
      settings: { showTts: true },
      onRequestSpeak: () => spoken.push('speak'),
      onRequestCopy: () => copied.push('copy'),
    });
    view.result = { query: 'learn', matches: [{ headword: 'learn', gloss: 'सीखना', pack: { targetLang: 'hi' } }] };
    view.visible = true;

    const press = (target) => {
      const event = {
        key: 'a',
        target,
        ctrlKey: false, altKey: false, metaKey: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
      };
      view.handleKey(event);
      return event.defaultPrevented === true;
    };

    // The event landed on the document, but a field has focus.
    assert.equal(press({ nodeType: 9, tagName: '#document' }), false);
    assert.deepEqual(spoken, []);
    // Targeting the field directly is caught too.
    assert.equal(press(field), false);
    assert.deepEqual(spoken, []);

    // Nothing focused: the shortcut is ours again.
    view.document.activeElement = { nodeType: 1, tagName: 'P', isContentEditable: false };
    assert.equal(press({ nodeType: 1, tagName: 'P' }), true);
    assert.deepEqual(spoken, ['speak']);

    // A shadow host is not itself editable, but the element inside it is.
    const inner = { nodeType: 1, tagName: 'TEXTAREA' };
    view.document.activeElement = { nodeType: 1, tagName: 'MY-WIDGET', shadowRoot: { activeElement: inner } };
    assert.equal(view.activeElement(), inner);
    assert.equal(press({ nodeType: 1, tagName: 'P' }), false);
    assert.deepEqual(spoken, ['speak']);
  });
});
