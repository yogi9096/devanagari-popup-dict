/**
 * Lookup key normalisation.
 *
 * This MUST stay byte-for-byte equivalent to `loose_key()` in
 * tools/build_dict.py, because the pack index is built with that function:
 *
 *   NFD -> drop ZWJ/ZWNJ/ZWSP -> drop nukta -> candrabindu becomes anusvara
 *       -> NFC -> trim surrounding punctuation -> lowercase
 *
 * Dropping the nukta merges क/क़ and candrabindu into anusvara merges अँ/अं,
 * which is what users expect from a learner's popup dictionary: typing or
 * reading either spelling finds the entry.
 */
(function (global) {
  'use strict';

  const ZWJ = '\u200d';
  const ZWNJ = '\u200c';
  const ZERO_WIDTH_SPACE = '\u200b';
  const NUKTA = '\u093c';
  const CANDRABINDU = '\u0901';
  const ANUSVARA = '\u0902';
  const DANDA = '\u0964';

  //: Kept identical to TRIM_CHARS in tools/build_dict.py.
  const TRIM_CHARS = (' \t\r\n' + DANDA + '\u0965.,;:!?"\'()[]{}<>|*-'
    + '\u2013\u2014\u2018\u2019\u201c\u201d');

  const TRIM_RE = new RegExp('^[' + escapeClass(TRIM_CHARS) + ']+|[' + escapeClass(TRIM_CHARS) + ']+$', 'g');

  function escapeClass(chars) {
    return chars.replace(/[\\\]^\-]/g, '\\$&');
  }

  function trimChars(text) {
    return text.replace(TRIM_RE, '');
  }

  /** Normalised lookup key. Returns '' when there is nothing to look up. */
  function looseKey(word) {
    if (typeof word !== 'string' || word.length === 0) {
      return '';
    }
    let text;
    try {
      text = word.normalize('NFD');
    } catch (error) {
      text = word;
    }
    text = text
      .split('')
      .filter((ch) => ch !== ZWJ && ch !== ZWNJ && ch !== ZERO_WIDTH_SPACE && ch !== NUKTA)
      .join('')
      .split(CANDRABINDU)
      .join(ANUSVARA);
    try {
      text = text.normalize('NFC');
    } catch (error) {
      /* ignore: keep the NFD-ish form */
    }
    return trimChars(text).toLowerCase();
  }

  /** Every normalised key that could identify `word` (primary + fallbacks). */
  function lookupKeys(word) {
    const keys = [];
    const primary = looseKey(word);
    if (primary) {
      keys.push(primary);
    }
    return keys;
  }

  const namespace = { looseKey, lookupKeys, trimChars, TRIM_CHARS };

  global.DecDi = Object.assign(global.DecDi || {}, { normalize: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
