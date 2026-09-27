/**
 * Script-aware text handling: character classes and word extraction from a
 * caret position.
 *
 * The extension looks ENGLISH words up and shows a Hindi meaning, so Latin text
 * is what the pointer normally lands on.  Devanagari handling is still needed,
 * but for a different reason: the *answers* are in Devanagari, so the sense text
 * and the ISO 15919 pronunciation both operate on Devanagari even though
 * nothing is looked up by it.
 *
 * English and Hindi are written with spaces between words, so unlike Chinese
 * (Perapera's target) a "word" is delimited by whitespace and
 * punctuation - but a Devanagari word is *not* delimited per codepoint: matras,
 * virama, nukta, anusvara and ZWJ/ZWNJ all belong to the word, and they are
 * spread across several Unicode blocks.  The helpers here are the single source
 * of truth for that.
 *
 * Keep the character classes in sync with tools/build_dict.py
 * (DEVANAGARI_CLASS / loose_key).
 */
(function (global) {
  'use strict';

  /**
   * Devanagari (U+0900-U+097F), Vedic Extensions (U+1CD0-U+1CFF) and Devanagari
   * Extended (U+A8E0-U+A8FF).  The astral Devanagari Extended-A block is
   * deliberately excluded so that scanning by UTF-16 code unit cannot swallow
   * unrelated astral characters (emoji, rare scripts) into a word; the Python
   * side of the build uses the same set.
   */
  const DEVANAGARI_CLASS = '\u0900-\u097f\u1cd0-\u1cff\ua8e0-\ua8ff';

  const DEVANAGARI_CHAR = new RegExp('[' + DEVANAGARI_CLASS + ']', 'u');
  const DEVANAGARI_ONLY = new RegExp('^[' + DEVANAGARI_CLASS + ']+$', 'u');
  const DEVANAGARI_RUN = new RegExp('[' + DEVANAGARI_CLASS + ']+', 'gu');

  const ZWNJ = '\u200c';
  const ZWJ = '\u200d';
  const JOINERS = ZWNJ + ZWJ;

  //: Characters that are part of a word but never word-initial or word-final.
  const DANDA = '\u0964';

  /**
   * Latin letters: ASCII plus the Latin-1 Supplement and Latin Extended blocks,
   * so "São", "Réunion" and "cachaça" are one word each rather than a word
   * followed by stray accented letters.
   */
  const LATIN_LETTER = /[A-Za-z\u00c0-\u024f]/;
  const LATIN_DIGIT = /[0-9]/;

  /**
   * Punctuation that joins two English words into one: the hyphen in
   * "well-known", the apostrophe in "don't".  Only honoured *between* letters,
   * so a trailing hyphen or a leading quote never starts a word.
   */
  const LATIN_JOINERS = "'-\u2010\u2011\u2012\u2013\u02bc\u2019";

  /**
   * The same set, escaped for use *inside* a regex character class.
   * Interpolating LATIN_JOINERS raw would read "'" "-" U+2010 as a range from
   * U+0027 to U+2010, which silently matches every ASCII symbol in between
   * (%, /, \, |, $, ^ ...) and makes a word run swallow the punctuation around it.
   */
  const LATIN_JOINER_CLASS = "'\\-\u2010\u2011\u2012\u2013\u02bc\u2019";

  function isDevanagariChar(ch) {
    return typeof ch === 'string' && ch.length > 0 && DEVANAGARI_CHAR.test(ch);
  }

  function hasDevanagari(text) {
    return typeof text === 'string' && DEVANAGARI_CHAR.test(text);
  }

  function isDevanagariWord(text) {
    return typeof text === 'string' && text.length > 0 && DEVANAGARI_ONLY.test(text);
  }

  function isLatinLetter(ch) {
    return typeof ch === 'string' && ch.length > 0 && LATIN_LETTER.test(ch);
  }

  function hasLatinLetter(text) {
    return typeof text === 'string' && LATIN_LETTER.test(text);
  }

  function isJoiner(ch) {
    return ch === ZWNJ || ch === ZWJ;
  }

  /** True for characters that may appear inside a Devanagari word. */
  function isWordChar(ch) {
    return isJoiner(ch) || isDevanagariChar(ch);
  }

  /** True for characters that may appear inside an English word. */
  function isLatinWordChar(ch) {
    return isLatinLetter(ch) || (typeof ch === 'string' && LATIN_DIGIT.test(ch));
  }

  /**
   * Whether text[at] continues the word through a hyphen or an apostrophe.
   * Both are only word-internal when letters sit on either side, which keeps
   * "well-known" whole and stops the trailing dash of an em-dash from starting
   * a new word.
   */
  function isLatinJoinerAt(text, at) {
    const ch = text[at];
    if (LATIN_JOINERS.indexOf(ch) < 0) {
      return false;
    }
    return isLatinLetter(text[at - 1]) && isLatinLetter(text[at + 1]);
  }

  /** Word-character test for either script, dispatching on what is at `at`. */
  function isWordCharAt(text, at, script) {
    const ch = text[at];
    if (script === 'latin') {
      return isLatinWordChar(ch) || isLatinJoinerAt(text, at);
    }
    return isWordChar(ch);
  }

  /**
   * Which script the word under `offset` is written in.
   * @returns {'deva'|'latin'|null}
   */
  function scriptAt(text, offset) {
    if (typeof text !== 'string' || !text.length) {
      return null;
    }
    const at = Math.max(0, Math.min(offset | 0, text.length - 1));
    // Caret sits between characters, so probe both sides before deciding.
    if (isDevanagariChar(text[at])) {
      return 'deva';
    }
    if (at > 0 && isDevanagariChar(text[at - 1])) {
      return 'deva';
    }
    if (isLatinLetter(text[at])) {
      return 'latin';
    }
    if (at > 0 && isLatinLetter(text[at - 1])) {
      return 'latin';
    }
    if (at + 1 < text.length && isLatinLetter(text[at + 1])) {
      return 'latin';
    }
    return null;
  }

  function trimJoiners(text) {
    let start = 0;
    let end = text.length;
    while (start < end && isJoiner(text[start])) start += 1;
    while (end > start && isJoiner(text[end - 1])) end -= 1;
    return text.slice(start, end);
  }

  /**
   * Expand a caret offset inside `text` to the surrounding word, in whichever
   * script that word is written.
   *
   * @param {string} text   the text node's data
   * @param {number} offset caret offset (0..text.length)
   * @returns {{word: string, start: number, end: number, script: string}|null}
   */
  function extractWord(text, offset) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    const position = Math.max(0, Math.min(typeof offset === 'number' ? offset : 0, text.length));
    const script = scriptAt(text, position);
    if (!script) {
      return null;
    }

    // Caret positions are reported between characters.  Prefer the character to
    // the left when we are at the end of a word (that is what users expect when
    // the pointer sits on the trailing matra or on the right edge of a glyph).
    let pivot = position;
    if (pivot > 0
      && !isWordCharAt(text, pivot, script)
      && isWordCharAt(text, pivot - 1, script)) {
      pivot -= 1;
    }

    let start = pivot;
    let end = pivot;
    while (start > 0 && isWordCharAt(text, start - 1, script)) start -= 1;
    while (end < text.length && isWordCharAt(text, end, script)) end += 1;

    if (script === 'latin') {
      // Trim any joiner the expansion swallowed at either edge.
      while (start < end && LATIN_JOINERS.indexOf(text[start]) >= 0) start += 1;
      while (end > start && LATIN_JOINERS.indexOf(text[end - 1]) >= 0) end -= 1;
      const token = text.slice(start, end);
      if (token.length < 2 || !hasLatinLetter(token)) {
        return null;
      }
      return { word: token, start, end, script: 'latin' };
    }

    const raw = text.slice(start, end);
    const trimmed = trimJoiners(raw);
    if (!trimmed || !hasDevanagari(trimmed)) {
      return null;
    }
    if (!isDevanagariWord(trimmed.replace(/[\u200c\u200d]/g, ''))) {
      return null;
    }
    const leading = raw.length - raw.replace(/^[\u200c\u200d]+/, '').length;
    return {
      word: trimmed.normalize('NFC'),
      start: start + leading,
      end: start + leading + trimmed.length,
      script: 'deva',
    };
  }

  /** Latin runs (letters, digits and internal joiners), for selection lookup. */
  const LATIN_RUN = new RegExp(
    '[A-Za-z\u00c0-\u024f0-9]+(?:[' + LATIN_JOINER_CLASS + ']'
    + '[A-Za-z\u00c0-\u024f0-9]+)*', 'gu');

  function trimLatinJoiners(text) {
    let start = 0;
    let end = text.length;
    while (start < end && LATIN_JOINERS.indexOf(text[start]) >= 0) start += 1;
    while (end > start && LATIN_JOINERS.indexOf(text[end - 1]) >= 0) end -= 1;
    return text.slice(start, end);
  }

  /**
   * Every word in a string, in order, in either script.
   * Devanagari runs come first at each position because the two patterns cannot
   * overlap, so a simple alternating scan of the matches preserves reading order.
   */
  function findWords(text) {
    if (typeof text !== 'string' || !text) {
      return [];
    }
    const words = [];

    DEVANAGARI_RUN.lastIndex = 0;
    let match = DEVANAGARI_RUN.exec(text);
    while (match) {
      const word = trimJoiners(match[0]);
      if (word && hasDevanagari(word)) {
        words.push({
          word: word.normalize('NFC'),
          start: match.index,
          end: match.index + match[0].length,
          script: 'deva',
        });
      }
      match = DEVANAGARI_RUN.exec(text);
    }

    LATIN_RUN.lastIndex = 0;
    match = LATIN_RUN.exec(text);
    while (match) {
      const word = trimLatinJoiners(match[0]);
      if (word && hasLatinLetter(word) && word.length >= 2) {
        // LATIN_RUN is <alnum>+(?:<joiner><alnum>+)*, so a match can never begin
        // or end on a joiner and the trim above is a no-op.  Offsets are
        // therefore the match's own.
        words.push({
          word,
          start: match.index,
          end: match.index + match[0].length,
          script: 'latin',
        });
      }
      match = LATIN_RUN.exec(text);
    }

    words.sort((a, b) => a.start - b.start);
    return words;
  }

  /** The first Devanagari token in a string, for pronunciation display. */
  function firstDevanagariToken(text) {
    if (typeof text !== 'string' || !text) {
      return '';
    }
    DEVANAGARI_RUN.lastIndex = 0;
    const match = DEVANAGARI_RUN.exec(text);
    return match ? match[0] : '';
  }

  const namespace = {
    DEVANAGARI_CLASS,
    DEVANAGARI_CHAR,
    DEVANAGARI_ONLY,
    ZWNJ,
    ZWJ,
    JOINERS,
    DANDA,
    LATIN_JOINERS,
    isDevanagariChar,
    hasDevanagari,
    isDevanagariWord,
    isLatinLetter,
    hasLatinLetter,
    isJoiner,
    isWordChar,
    isLatinWordChar,
    isLatinJoinerAt,
    isWordCharAt,
    scriptAt,
    trimJoiners,
    extractWord,
    findWords,
    firstDevanagariToken,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { devanagari: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
