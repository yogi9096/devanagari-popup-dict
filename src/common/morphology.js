/**
 * Lightweight inflection handling for Hindi and Marathi.
 *
 * Both languages are heavily inflected, so a reader hovering over लड़कियों
 * (girls, oblique plural) or करतात (they do) must still find लड़की / करणे.
 * This module turns a surface form into an ordered list of *lemma candidates*;
 * the caller looks up the surface form itself first and then walks the
 * candidates, so a wrong guess can never shadow a genuine entry.
 *
 * The tables are deliberately heuristic and data-free: suffix rewrites plus a
 * short list of very common irregulars. Each rule carries a short label that
 * the tooltip shows ("plural", "verb form", ...) so the user can see why an
 * entry was offered.
 */
(function (global) {
  'use strict';

  /** Devanagari consonant at the end of a stem, used for the -ā / -ī expansion. */
  const CONSONANT_END = /[\u0915-\u0939\u0958-\u095f\u0931\u0934]$/;

  const HINDI = {
    rules: [
      // ---- nouns and adjectives ------------------------------------------
      { s: 'ियों', r: 'ी', l: 'feminine plural' },
      { s: 'ियाँ', r: 'ी', l: 'feminine plural' },
      { s: 'ाएँ', r: 'ा', l: 'plural' },
      { s: 'ाओं', r: 'ा', l: 'oblique plural' },
      { s: 'ों', r: 'ा', l: 'oblique plural' },
      { s: 'ों', r: '', l: 'oblique plural' },
      { s: 'ें', r: 'ा', l: 'plural' },
      { s: 'ें', r: '', l: 'plural' },
      { s: 'ुओं', r: 'ू', l: 'oblique plural' },
      { s: 'े', r: 'ा', l: 'oblique / plural' },
      { s: 'ी', r: 'ा', l: 'feminine agreement' },
      // ---- attached postpositions and particles ---------------------------
      { s: 'वालों', r: '', l: 'with वाला' },
      { s: 'वाला', r: '', l: 'with वाला' },
      { s: 'वाली', r: '', l: 'with वाला' },
      { s: 'वाले', r: '', l: 'with वाला' },
      { s: 'का', r: '', l: 'with का' },
      { s: 'के', r: '', l: 'with के' },
      { s: 'की', r: '', l: 'with की' },
      { s: 'को', r: '', l: 'with को' },
      { s: 'से', r: '', l: 'with से' },
      { s: 'ने', r: '', l: 'with ने' },
      { s: 'में', r: '', l: 'with में' },
      { s: 'पर', r: '', l: 'with पर' },
      { s: 'तक', r: '', l: 'with तक' },
      // ---- verbs -----------------------------------------------------------
      { s: 'ना', r: '', l: 'infinitive' },
      { s: 'ने', r: 'ना', l: 'infinitive oblique' },
      { s: 'नी', r: 'ना', l: 'infinitive oblique' },
      { s: 'तीं', r: 'ना', l: 'imperfective participle' },
      { s: 'ता', r: 'ना', l: 'imperfective participle' },
      { s: 'ती', r: 'ना', l: 'imperfective participle' },
      { s: 'ते', r: 'ना', l: 'imperfective participle' },
      { s: 'ेंगे', r: 'ना', l: 'future' },
      { s: 'ेगा', r: 'ना', l: 'future' },
      { s: 'ेगी', r: 'ना', l: 'future' },
      { s: 'ऊँगा', r: 'ना', l: 'future' },
      { s: 'ोगे', r: 'ना', l: 'future' },
      { s: 'करके', r: '', l: 'conjunctive participle' },
      { s: 'कर', r: '', l: 'conjunctive participle' },
      { s: 'रहा', r: '', l: 'progressive' },
      { s: 'रही', r: '', l: 'progressive' },
      { s: 'रहे', r: '', l: 'progressive' },
      { s: 'या', r: 'ना', l: 'perfective participle' },
      { s: 'यी', r: 'ना', l: 'perfective participle' },
      { s: 'ये', r: 'ना', l: 'perfective participle' },
      // ---- last resort ------------------------------------------------------
      { s: 'ी', r: '', l: 'stem' },
      { s: 'ा', r: '', l: 'stem' },
      { s: 'े', r: '', l: 'stem' },
    ],
    expand: [
      { r: 'ा', l: 'stem + ा' },
      { r: 'ी', l: 'stem + ी' },
    ],
    exceptions: {
      'हुआ': 'होना', 'हुई': 'होना', 'हुए': 'होना',
      'किया': 'करना', 'किए': 'करना',
      'गया': 'जाना', 'गई': 'जाना', 'गए': 'जाना',
      'दिया': 'देना', 'दिए': 'देना', 'लिया': 'लेना', 'लिए': 'लेना',
      'आया': 'आना', 'आई': 'आना', 'आए': 'आना',
      'था': 'होना', 'थी': 'होना', 'थे': 'होना',
    },
  };

  const MARATHI = {
    rules: [
      // ---- nouns ----------------------------------------------------------
      { s: '्यां', r: 'ा', l: 'oblique plural' },
      { s: 'ांना', r: '', l: 'case form' },
      { s: 'ांमध्ये', r: '', l: 'case form' },
      { s: 'ांपासून', r: '', l: 'case form' },
      { s: 'ांशी', r: '', l: 'case form' },
      { s: 'ांकडे', r: '', l: 'case form' },
      { s: 'ांस', r: '', l: 'case form' },
      { s: 'ांवर', r: '', l: 'case form' },
      { s: 'ांत', r: '', l: 'case form' },
      { s: 'ांचा', r: 'ा', l: 'genitive' },
      { s: 'ांची', r: 'ा', l: 'genitive' },
      { s: 'ांचे', r: 'ा', l: 'genitive' },
      { s: 'ां', r: '', l: 'plural / oblique' },
      { s: 'ां', r: 'ा', l: 'plural / oblique' },
      { s: 'च्या', r: '', l: 'genitive' },
      { s: 'चा', r: '', l: 'genitive' },
      { s: 'ची', r: '', l: 'genitive' },
      { s: 'चे', r: '', l: 'genitive' },
      { s: 'ासाठी', r: '', l: 'with साठी' },
      { s: 'ापासून', r: '', l: 'with पासून' },
      { s: 'ाला', r: 'ा', l: 'dative' },
      { s: 'ाला', r: '', l: 'dative' },
      { s: 'ाली', r: 'ा', l: 'dative' },
      { s: 'ाले', r: 'ा', l: 'dative' },
      { s: 'ाने', r: 'ा', l: 'instrumental' },
      { s: 'ाशी', r: 'ा', l: 'with शी' },
      { s: 'ला', r: '', l: 'dative' },
      { s: 'ली', r: '', l: 'dative' },
      { s: 'ले', r: '', l: 'dative' },
      { s: 'ने', r: '', l: 'instrumental' },
      { s: 'मध्ये', r: '', l: 'with मध्ये' },
      { s: 'कडे', r: '', l: 'with कडे' },
      { s: 'शी', r: '', l: 'with शी' },
      { s: 'वर', r: '', l: 'with वर' },
      { s: 'त', r: '', l: 'locative' },
      { s: 'ं', r: '', l: 'plural' },
      { s: 'े', r: 'ा', l: 'plural / oblique' },
      { s: 'े', r: '', l: 'plural / oblique' },
      { s: 'ी', r: '', l: 'feminine' },
      { s: 'ा', r: '', l: 'stem' },
      // ---- verbs -----------------------------------------------------------
      { s: 'ण्यासाठी', r: 'णे', l: 'verbal noun' },
      { s: 'ण्याचा', r: 'णे', l: 'verbal noun' },
      { s: 'ण्याची', r: 'णे', l: 'verbal noun' },
      { s: 'ण्याचे', r: 'णे', l: 'verbal noun' },
      { s: 'ण्यास', r: 'णे', l: 'verbal noun' },
      { s: 'णार', r: 'णे', l: 'future participle' },
      { s: 'लेला', r: 'णे', l: 'perfective participle' },
      { s: 'लेली', r: 'णे', l: 'perfective participle' },
      { s: 'लेले', r: 'णे', l: 'perfective participle' },
      { s: 'ताना', r: 'णे', l: 'simultaneous' },
      { s: 'तात', r: 'णे', l: 'present tense' },
      { s: 'तो', r: 'णे', l: 'present tense' },
      { s: 'ते', r: 'णे', l: 'present tense' },
      { s: 'ती', r: 'णे', l: 'present tense' },
      { s: 'वून', r: 'णे', l: 'conjunctive participle' },
      { s: 'ून', r: 'णे', l: 'conjunctive participle' },
      { s: 'ल्या', r: 'णे', l: 'past tense' },
      { s: 'ला', r: 'णे', l: 'past tense' },
      { s: 'ली', r: 'णे', l: 'past tense' },
      { s: 'ले', r: 'णे', l: 'past tense' },
    ],
    expand: [
      { r: 'ा', l: 'stem + ा' },
      { r: 'ी', l: 'stem + ी' },
      { r: 'णे', l: 'stem + णे' },
    ],
    exceptions: {
      'मुले': 'मूल', 'मुलां': 'मूल', 'मुलांना': 'मूल',
      'गेला': 'जाणे', 'गेली': 'जाणे', 'गेले': 'जाणे', 'गेल्या': 'जाणे',
      'आला': 'येणे', 'आली': 'येणे', 'आले': 'येणे', 'आल्या': 'येणे',
      'केला': 'करणे', 'केली': 'करणे', 'केले': 'करणे',
      'दिला': 'देणे', 'दिली': 'देणे', 'दिले': 'देणे',
      'घेतला': 'घेणे', 'घेतली': 'घेणे', 'घेतले': 'घेणे',
      'आहे': 'असणे', 'आहेत': 'असणे', 'होता': 'होणे', 'होते': 'होणे', 'होतो': 'होणे',
      'झाले': 'होणे', 'झाला': 'होणे', 'झाली': 'होणे',
    },
  };

  const TABLES = { hi: HINDI, mr: MARATHI };

  function tableFor(language) {
    return TABLES[language] || HINDI;
  }

  const MAX_CANDIDATES = 8;

  /**
   * Lemma candidates for a surface form, best first.
   *
   * @param {string} word
   * @param {'hi'|'mr'} language
   * @returns {{word: string, label: string}[]} never includes `word` itself
   */
  function candidates(word, language) {
    if (typeof word !== 'string' || word.length < 2) {
      return [];
    }
    const table = tableFor(language);
    const seen = new Set([word]);
    const results = [];

    const push = (candidate, label) => {
      if (!candidate || candidate.length < 2 || seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      results.push({ word: candidate, label });
      return results.length >= MAX_CANDIDATES;
    };

    if (table.exceptions[word]) {
      push(table.exceptions[word], 'irregular');
    }

    const stems = [];
    for (const rule of table.rules) {
      if (results.length >= MAX_CANDIDATES) {
        break;
      }
      if (!word.endsWith(rule.s) || word.length === rule.s.length) {
        continue;
      }
      const stem = word.slice(0, word.length - rule.s.length);
      if (push(stem + rule.r, rule.l)) {
        break;
      }
      stems.push({ stem, label: rule.l });
    }

    // Second pass: a stripped consonant stem often needs a final vowel back
    // (बच्चों -> बच्च -> बच्चा, बोलला -> बोल -> बोलणे).
    for (const entry of stems) {
      if (results.length >= MAX_CANDIDATES) {
        break;
      }
      if (!CONSONANT_END.test(entry.stem)) {
        continue;
      }
      for (const expansion of table.expand) {
        if (push(entry.stem + expansion.r, expansion.l)) {
          break;
        }
      }
    }

    return results.slice(0, MAX_CANDIDATES);
  }

  /** True when the language has an inflection table. */
  function supports(language) {
    return Object.prototype.hasOwnProperty.call(TABLES, language);
  }

  const namespace = {
    candidates,
    supports,
    tableFor,
    languages: Object.keys(TABLES),
    MAX_CANDIDATES,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { morphology: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
