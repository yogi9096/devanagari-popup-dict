/**
 * Devanagari romanisation (ISO 15919 / IAST-style), plus a diacritic-free
 * "readable" form.
 *
 * Perapera shows pinyin above Chinese words; the equivalent affordance for
 * Hindi and Marathi is a romanisation line, which this module produces.
 * The rules implement the standard scholarly transliteration, including the
 * details that trip up naive mappings:
 *
 *  * inherent 'a' - every consonant carries an implicit 'a' unless it is
 *    followed by virama (्), a dependent vowel sign (matra), or a word break
 *  * nukta letters (क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़) - NFC does not compose these, so a
 *    following U+093C has to be folded back into the base consonant
 *  * anusvara / candrabindu / visarga and the avagraha
 */
(function (global) {
  'use strict';

  const VIRAMA = '\u094d';
  const NUKTA = '\u093c';

  const CONSONANTS = {
    '\u0915': 'k', '\u0916': 'kh', '\u0917': 'g', '\u0918': 'gh', '\u0919': '\u1e45',
    '\u091a': 'c', '\u091b': 'ch', '\u091c': 'j', '\u091d': 'jh', '\u091e': '\u00f1',
    '\u091f': '\u1e6d', '\u0920': '\u1e6dh', '\u0921': '\u1e0d', '\u0922': '\u1e0dh',
    '\u0923': '\u1e47',
    '\u0924': 't', '\u0925': 'th', '\u0926': 'd', '\u0927': 'dh', '\u0928': 'n',
    '\u092a': 'p', '\u092b': 'ph', '\u092c': 'b', '\u092d': 'bh', '\u092e': 'm',
    '\u092f': 'y', '\u0930': 'r', '\u0932': 'l', '\u0933': '\u1e37', '\u0935': 'v',
    '\u0936': '\u015b', '\u0937': '\u1e63', '\u0938': 's', '\u0939': 'h',
    // nukta letters, in their precomposed code points
    '\u0958': 'q', '\u0959': 'k\u0335h', '\u095a': '\u0121', '\u095b': 'z',
    '\u095c': '\u1e5b', '\u095d': '\u1e5bh', '\u095e': 'f', '\u095f': 'y\u0307',
    // Marathi and Sindhi additions
    '\u0931': '\u1e5b', '\u0934': '\u1e3b',
  };

  //: base consonant -> precomposed nukta form
  const NUKTA_FORMS = {
    '\u0915': '\u0958', '\u0916': '\u0959', '\u0917': '\u095a', '\u091c': '\u095b',
    '\u0921': '\u095c', '\u0922': '\u095d', '\u092b': '\u095e', '\u092f': '\u095f',
  };

  const INDEPENDENT_VOWELS = {
    '\u0905': 'a', '\u0906': '\u0101', '\u0907': 'i', '\u0908': '\u012b',
    '\u0909': 'u', '\u090a': '\u016b', '\u090b': '\u1e5b', '\u0960': '\u1e5b\u0304',
    '\u090c': '\u1e37', '\u0961': '\u1e37\u0304',
    '\u090d': 'e', '\u090e': 'ai', '\u090f': 'e', '\u0910': 'ai',
    '\u0911': 'o', '\u0912': 'au', '\u0913': 'o', '\u0914': 'au',
    '\u0904': '\u0115',
  };

  const MATRAS = {
    '\u093e': '\u0101', '\u093f': 'i', '\u0940': '\u012b', '\u0941': 'u',
    '\u0942': '\u016b', '\u0943': '\u1e5b', '\u0944': '\u1e5b\u0304',
    '\u0962': '\u1e37', '\u0963': '\u1e37\u0304',
    '\u0945': '\u0115', '\u0946': 'e', '\u0947': 'e', '\u0948': 'ai',
    '\u0949': 'o', '\u094a': 'o', '\u094b': 'o', '\u094c': 'au',
    '\u094e': 'e', '\u094f': 'au',
  };

  const SIGNS = {
    '\u0901': 'm\u0310',  // candrabindu m̐
    '\u0903': '\u1e25',   // visarga     ḥ
    '\u0950': 'o\u1e43',  // om
    '\u093d': '\u2019',   // avagraha
    '\u0970': '.',        // abbreviation sign
  };

  //: class nasal for a following stop, used for anusvara assimilation.
  const ANUSVARA_NASALS = {
    '\u0915': '\u1e45', '\u0916': '\u1e45', '\u0917': '\u1e45', '\u0918': '\u1e45',
    '\u091a': '\u00f1', '\u091b': '\u00f1', '\u091c': '\u00f1', '\u091d': '\u00f1',
    '\u091f': '\u1e47', '\u0920': '\u1e47', '\u0921': '\u1e47', '\u0922': '\u1e47',
    '\u0924': 'n', '\u0925': 'n', '\u0926': 'n', '\u0927': 'n',
    '\u092a': 'm', '\u092b': 'm', '\u092c': 'm', '\u092d': 'm',
  };
  const ANUSVARA = '\u0902';

  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  /** ISO 15919 transliteration of a Devanagari string. */
  function toIso15919(text) {
    if (typeof text !== 'string' || !text) {
      return '';
    }
    let normalized = text;
    try {
      normalized = text.normalize('NFC');
    } catch (error) {
      normalized = text;
    }
    const chars = Array.from(normalized);
    const out = [];
    let implicitA = false;
    let lastConsonant = '';

    for (let index = 0; index < chars.length; index += 1) {
      const ch = chars[index];

      if (ch === NUKTA) {
        const dotted = NUKTA_FORMS[lastConsonant];
        if (dotted && has(CONSONANTS, dotted)) {
          out.pop();
          out.push(CONSONANTS[dotted]);
        }
        continue;
      }

      if (has(CONSONANTS, ch)) {
        if (implicitA) {
          out.push('a');
        }
        out.push(CONSONANTS[ch]);
        implicitA = true;
        lastConsonant = ch;
        continue;
      }

      if (ch === VIRAMA) {
        implicitA = false;
        lastConsonant = '';
        continue;
      }

      if (has(MATRAS, ch)) {
        implicitA = false;
        lastConsonant = '';
        out.push(MATRAS[ch]);
        continue;
      }

      if (implicitA) {
        out.push('a');
        implicitA = false;
      }
      lastConsonant = '';

      if (ch === ANUSVARA) {
        const next = chars[index + 1];
        const nasal = next && has(ANUSVARA_NASALS, next) ? ANUSVARA_NASALS[next] : 'ṃ';
        out.push(nasal);
        continue;
      }

      if (has(SIGNS, ch)) {
        out.push(SIGNS[ch]);
        continue;
      }
      if (has(INDEPENDENT_VOWELS, ch)) {
        out.push(INDEPENDENT_VOWELS[ch]);
        continue;
      }
      out.push(ch);
    }

    if (implicitA) {
      out.push('a');
    }
    return out.join('').replace(/[\u200c\u200d]/g, '');
  }

  /** Strip the diacritics: aṅk -> ank. For readers who cannot use them. */
  function simplify(roman) {
    if (typeof roman !== 'string' || !roman) {
      return '';
    }
    let text = roman;
    try {
      text = text.normalize('NFD');
    } catch (error) {
      return roman;
    }
    return text
      .replace(/[\u0300-\u036f\u0310\u0335]/g, '')
      .replace(/\u1e5b/g, 'r')
      .replace(/\u1e37/g, 'l')
      .replace(/\u1e45/g, 'n')
      .replace(/\u1e43/g, 'm')
      .replace(/\u1e25/g, 'h');
  }

  /**
   * Romanise for display.
   * @param {string} text
   * @param {'iso15919'|'simplified'} [scheme]
   */
  function romanize(text, scheme) {
    const roman = toIso15919(text);
    return scheme === 'simplified' ? simplify(roman) : roman;
  }

  const namespace = {
    toIso15919,
    simplify,
    romanize,
    CONSONANTS,
    INDEPENDENT_VOWELS,
    MATRAS,
    SIGNS,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { translit: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
