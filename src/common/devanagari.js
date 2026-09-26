/**
 * Devanagari-aware text handling: character classes, word extraction from a
 * caret position, and sentence context.
 *
 * Hindi and Marathi are written with spaces between words, so unlike Chinese
 * (Perapera's target) a "word" is delimited by whitespace and punctuation -
 * but it is *not* delimited per codepoint: matras, virama, nukta, anusvara and
 * ZWJ/ZWNJ all belong to the word, and they are spread across several Unicode
 * blocks.  The helpers here are the single source of truth for that.
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

  function isDevanagariChar(ch) {
    return typeof ch === 'string' && ch.length > 0 && DEVANAGARI_CHAR.test(ch);
  }

  function hasDevanagari(text) {
    return typeof text === 'string' && DEVANAGARI_CHAR.test(text);
  }

  function isDevanagariWord(text) {
    return typeof text === 'string' && text.length > 0 && DEVANAGARI_ONLY.test(text);
  }

  function isJoiner(ch) {
    return ch === ZWNJ || ch === ZWJ;
  }

  /** True for characters that may appear inside a Devanagari word. */
  function isWordChar(ch) {
    return isJoiner(ch) || isDevanagariChar(ch);
  }

  function trimJoiners(text) {
    let start = 0;
    let end = text.length;
    while (start < end && isJoiner(text[start])) start += 1;
    while (end > start && isJoiner(text[end - 1])) end -= 1;
    return text.slice(start, end);
  }

  /**
   * Expand a caret offset inside `text` to the surrounding Devanagari word.
   *
   * @param {string} text   the text node's data
   * @param {number} offset caret offset (0..text.length)
   * @returns {{word: string, start: number, end: number}|null}
   */
  function extractWord(text, offset) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    const position = Math.max(0, Math.min(typeof offset === 'number' ? offset : 0, text.length));

    // Caret positions are reported between characters.  Prefer the character to
    // the left when we are at the end of a word (that is what users expect when
    // the pointer sits on the trailing matra or on the right edge of a glyph).
    let pivot = position;
    if (pivot > 0 && !isWordChar(text[pivot]) && isWordChar(text[pivot - 1])) {
      pivot -= 1;
    }

    let start = pivot;
    let end = pivot;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;

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
    };
  }

  /** Every Devanagari word in a string, in order. */
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
        });
      }
      match = DEVANAGARI_RUN.exec(text);
    }
    return words;
  }

  const SENTENCE_END = new RegExp('[.!?\u0964\u0965\n\r]');

  /**
   * The sentence-ish context around a match, used for the optional context line.
   * Returns {text, before, after} where before/after are the offsets of the word
   * inside `text`, or null when there is nothing useful to show.
   */
  function sentenceAround(text, start, end, maxChars) {
    const limit = typeof maxChars === 'number' ? maxChars : 160;
    if (typeof text !== 'string' || !text) {
      return null;
    }
    let left = Math.max(0, start);
    let right = Math.min(text.length, end);

    while (left > 0 && !SENTENCE_END.test(text[left - 1])) left -= 1;
    while (right < text.length && !SENTENCE_END.test(text[right])) right += 1;

    const original = text.slice(left, right);
    let snippet = original.trim();
    if (!snippet) {
      return null;
    }
    if (snippet.length > limit) {
      const overflow = snippet.length - limit;
      const cutLeft = Math.min(Math.floor(overflow / 2), Math.max(0, start - left));
      snippet = snippet.slice(cutLeft, cutLeft + limit);
    }
    if (snippet.length < 2) {
      return null;
    }
    const offsetInOriginal = original.indexOf(snippet);
    if (offsetInOriginal < 0) {
      return null;
    }
    const wordStart = Math.max(0, start - left - offsetInOriginal);
    const wordEnd = wordStart + (end - start);
    const clampedEnd = Math.max(wordStart, Math.min(snippet.length, wordEnd));
    return {
      text: snippet,
      before: wordStart,
      after: clampedEnd,
    };
  }

  const namespace = {
    DEVANAGARI_CLASS,
    DEVANAGARI_CHAR,
    DEVANAGARI_ONLY,
    ZWNJ,
    ZWJ,
    JOINERS,
    DANDA,
    isDevanagariChar,
    hasDevanagari,
    isDevanagariWord,
    isJoiner,
    isWordChar,
    trimJoiners,
    extractWord,
    findWords,
    sentenceAround,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { devanagari: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
