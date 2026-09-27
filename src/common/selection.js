/**
 * Should this selection be looked up?
 *
 * A selection-triggered dictionary is only pleasant if it stays quiet when the
 * reader is selecting something *else*.  Selecting a paragraph to copy it,
 * pressing Ctrl+A, or dragging across a table of numbers must never open a
 * popup.  Perapera and Rikaichamp both work this way: the gesture is the
 * request, so anything that is not plausibly a dictionary lookup is declined
 * before a single byte of dictionary data is fetched.
 *
 * Every rule below returns a reason string so the caller can log *why* a popup
 * did not appear, which is the difference between "it is broken" and "that
 * selection was too long".
 */
(function (global) {
  'use strict';

  /** A Ctrl+A on a normal article is far past this, a single word is far under. */
  const HARD_CHAR_LIMIT = 200;
  const HARD_WORD_LIMIT = 12;
  /** Below this there is no word to look up ("a", "I", "of"). */
  const MIN_WORD_CHARS = 2;
  /** Longer than this and it is a URL, a hash or a minified identifier. */
  const MAX_WORD_CHARS = 40;

  const URL_LIKE = /^(?:https?:\/\/|www\.|mailto:)|\.[a-z]{2,}(?:\/|$)|@/i;
  const HAS_DIGIT = /\d/;
  const HAS_LETTER = /[A-Za-z]/;
  /** A word is letters plus the punctuation that lives inside one. */
  const WORD_SPLIT = /[^A-Za-z'’-]+/;
  const DEVANAGARI = /[ऀ-ॿ]/;

  const REASONS = {
    EMPTY: 'empty selection',
    TOO_LONG: 'selection longer than a short phrase',
    TOO_MANY_WORDS: 'too many words selected',
    SELECT_ALL: 'looks like a select-all',
    NO_LETTERS: 'no letters in the selection',
    NUMBER: 'numbers only',
    URL: 'looks like a URL or email address',
    NON_LATIN: 'not Latin text',
    WORD_TOO_LONG: 'word is too long to be a word',
  };

  /** Split on anything that cannot be inside an English word. */
  function words(text) {
    return String(text || '')
      .split(WORD_SPLIT)
      .map((word) => word.replace(/^['’-]+|['’-]+$/g, ''))
      .filter(Boolean);
  }

  /**
   * Decide whether a selection is worth looking up.
   *
   * @param {string} text   the selected text, as the reader sees it
   * @param {object} limits {maxWords, maxChars}
   * @returns {{ok: boolean, reason: string, words: string[], query: string}}
   *   `query` is the text to look up: a single word when exactly one was
   *   selected, otherwise the whole short phrase.
   */
  function evaluate(text, limits) {
    const maxWords = positive(limits && limits.maxWords, 4);
    const maxChars = positive(limits && limits.maxChars, 60);
    const raw = String(text == null ? '' : text);
    const trimmed = raw.trim();

    const decline = (reason) => ({ ok: false, reason, words: [], query: '' });

    if (!trimmed) {
      return decline(REASONS.EMPTY);
    }

    // Ctrl+A on a long page, and any drag across a paragraph, land here.  This
    // check comes before anything else so a huge selection costs nothing.  The
    // hard limits are floors on top of the user's setting: a stored value can
    // be wrong, but more than a dozen words is never a lookup.
    if (trimmed.length > maxChars || trimmed.length > HARD_CHAR_LIMIT) {
      return decline(REASONS.TOO_LONG);
    }

    const parts = words(trimmed);
    if (!parts.length) {
      // Punctuation, an emoji, a run of dashes: nothing to look up.
      return decline(REASONS.NO_LETTERS);
    }
    if (parts.length > Math.min(maxWords, HARD_WORD_LIMIT)) {
      return decline(REASONS.TOO_MANY_WORDS);
    }

    if (!HAS_LETTER.test(trimmed)) {
      return decline(REASONS.NUMBER);
    }
    if (DEVANAGARI.test(trimmed)) {
      // The packs are keyed by English, so a Devanagari selection cannot match.
      return decline(REASONS.NON_LATIN);
    }
    if (URL_LIKE.test(trimmed)) {
      return decline(REASONS.URL);
    }
    if (parts.every((word) => HAS_DIGIT.test(word) && !/^[a-z]/i.test(word))) {
      return decline(REASONS.NUMBER);
    }
    if (parts.some((word) => word.length > MAX_WORD_CHARS)) {
      return decline(REASONS.WORD_TOO_LONG);
    }
    if (parts.every((word) => word.replace(/[^A-Za-z]/g, '').length < MIN_WORD_CHARS)) {
      // "a", "I", "of" - real words, but a dictionary popup is just noise.
      return decline(REASONS.NO_LETTERS);
    }

    return {
      ok: true,
      reason: '',
      words: parts,
      // A single word is looked up whole; a short phrase keeps its spaces so a
      // multi-word pack entry can match it.
      query: parts.length === 1 ? parts[0] : parts.join(' '),
    };
  }

  /**
   * A selection is a deliberate "select all" (Ctrl+A / menu Select all) rather
   * than a word, if it covers a large share of the document.  Word and
   * character limits already catch a normal article, but a short page can be
   * entirely selected while still looking small.
   */
  function looksLikeSelectAll(selectedChars, documentChars) {
    const total = Number(documentChars);
    if (!Number.isFinite(total) || total <= 0) {
      return false;
    }
    return Number(selectedChars) >= total * 0.9;
  }

  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  const namespace = { evaluate, looksLikeSelectAll, words, REASONS };

  global.DecDi = Object.assign(global.DecDi || {}, { selection: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
