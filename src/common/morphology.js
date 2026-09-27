/**
 * Lightweight inflection handling.
 *
 * The extension reads ENGLISH and answers in Hindi, so the headwords stored in
 * the packs are English base forms.  A reader selecting "running" or "cats" must
 * still reach "run" and "cat", which needs English lemmatisation.  The Hindi
 * table covers the other case: a Devanagari lemma reached from a
 * stem-final ending, which is the shape an oblique or a verb form takes.
 *
 * Both tables are deliberately heuristic and data-free: suffix rewrites plus
 * a short list of very common irregulars.  Each rule carries a short label that
 * the tooltip shows ("plural", "past tense", ...) so the user can see why an
 * entry was offered.
 */
(function (global) {
  'use strict';

  /** Devanagari consonant at the end of a stem, used for the -ā / -ī expansion. */
  const CONSONANT_END = /[\u0915-\u0939\u0958-\u095f\u0931\u0934]$/;

  /**
   * A doubled final consonant before -ed/-ing: "stopped" -> "stop", "running"
   * -> "run".  Only a single consonant is unwrapped, and only when the stem is
   * long enough that the result is still a plausible word.
   */
  const EN_DOUBLING = /([^aeiou])\1$/;

  const ENGLISH = {
    rules: [
      // ---- nouns and adjectives ------------------------------------------
      { s: 'ies', r: 'y', l: 'plural' },
      { s: 'es', r: '', l: 'plural' },
      { s: 's', r: '', l: 'plural' },
      { s: "['\u2019]s", r: '', l: 'possessive' },
      { s: 'ier', r: 'y', l: 'comparative' },
      { s: 'iest', r: 'y', l: 'superlative' },
      { s: 'er', r: '', l: 'comparative' },
      { s: 'est', r: '', l: 'superlative' },
      { s: 'ier', r: 'er', l: 'comparative' },
      { s: 'iest', r: 'est', l: 'superlative' },
      { s: 'ier', r: '', l: 'comparative' },
      { s: 'iest', r: '', l: 'superlative' },
      // ---- verbs -----------------------------------------------------------
      { s: 'ies', r: 'y', l: 'third person singular' },
      { s: 'ied', r: 'y', l: 'past tense' },
      { s: 'ing', r: '', l: 'gerund' },
      { s: 'ing', r: 'e', l: 'gerund' },
      { s: 'ed', r: '', l: 'past tense' },
      { s: 'ed', r: 'e', l: 'past tense' },
      { s: 'ed', r: 'y', l: 'past tense' },
      { s: 'es', r: '', l: 'third person singular' },
      { s: 's', r: '', l: 'third person singular' },
      // ---- adverbs ---------------------------------------------------------
      { s: 'ly', r: '', l: 'adverb' },
      { s: 'ily', r: 'y', l: 'adverb' },
      { s: 'ally', r: 'al', l: 'adverb' },
    ],
    expand: [],
    exceptions: {
      // Irregular plurals that no suffix rule can reach.
      children: 'child', men: 'man', women: 'woman', people: 'person',
      feet: 'foot', teeth: 'tooth', geese: 'goose', mice: 'mouse',
      lice: 'louse', oxen: 'ox', sheep: 'sheep', fish: 'fish',
      series: 'series', species: 'species', deer: 'deer',
      // Irregular verbs.
      was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
      had: 'have', has: 'have', did: 'do', does: 'do', done: 'do',
      said: 'say', went: 'go', gone: 'go', goes: 'go',
      made: 'make', knew: 'know', known: 'know', thought: 'think',
      took: 'take', taken: 'take', gave: 'give', given: 'give',
      came: 'come', saw: 'see', seen: 'see', got: 'get',
      told: 'tell', became: 'become', found: 'find', felt: 'feel',
      left: 'leave', put: 'put', kept: 'keep', held: 'hold',
      wrote: 'write', written: 'write', stood: 'stand', heard: 'hear',
      let: 'let', meant: 'mean', met: 'meet', ran: 'run',
      paid: 'pay', sat: 'sit', spoke: 'speak', spoken: 'speak',
      lay: 'lie', led: 'lead', grew: 'grow', grown: 'grow',
      lost: 'lose', fell: 'fall', fallen: 'fall', sent: 'send',
      built: 'build', understood: 'understand', drew: 'draw',
      drawn: 'draw', broke: 'break', broken: 'break', spent: 'spend',
      cut: 'cut', rose: 'rise', risen: 'rise', drove: 'drive',
      driven: 'drive', bought: 'buy', wore: 'wear', worn: 'wear',
      chose: 'choose', chosen: 'choose', ate: 'eat', eaten: 'eat',
      taught: 'teach', caught: 'catch', dealt: 'deal', won: 'win',
      forgot: 'forget', forgotten: 'forget', began: 'begin',
      begun: 'begin', flew: 'fly', flown: 'fly', threw: 'throw',
      thrown: 'throw', knew: 'know', children: 'child',
      // Contractions and adverbs that the suffix rules mangle.
      "don't": 'do', "doesn't": 'do', "didn't": 'do', "isn't": 'be',
      "aren't": 'be', "wasn't": 'be', "weren't": 'be', "can't": 'can',
      "won't": 'will', "n't": 'not', 'cannot': 'can',
    },
  };

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


  const TABLES = { en: ENGLISH, hi: HINDI };

  function tableFor(language) {
    return TABLES[language] || null;
  }

  const MAX_CANDIDATES = 8;
  /** Below this length a rewritten stem is noise rather than a lemma. */
  const MIN_STEM = 2;

  /**
   * Undo English consonant doubling: "stopped" -> "stop", "running" -> "run".
   * Returns '' when the word does not double, or when unwrapping would leave a
   * stem too short to be a word ("odd" must not become "o").
   */
  function undouble(stem) {
    if (stem.length < MIN_STEM + 1) {
      return '';
    }
    const match = stem.match(EN_DOUBLING);
    if (!match) {
      return '';
    }
    return stem.slice(0, -1);
  }

  /**
   * Lemma candidates for a surface form, best first.
   *
   * @param {string} word
   * @param {'en'|'hi'} language
   * @returns {{word: string, label: string}[]} never includes `word` itself
   */
  function candidates(word, language) {
    if (typeof word !== 'string' || word.length < 2) {
      return [];
    }
    const table = tableFor(language);
    if (!table) {
      return [];
    }
    // English rules are written in lower case; the index keys are lower case
    // too, so normalise once here and let the caller looseKey() the result.
    const subject = table === ENGLISH ? word.toLowerCase() : word;
    const seen = new Set([word, subject]);
    const results = [];

    const push = (candidate, label) => {
      if (!candidate || candidate.length < MIN_STEM || seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      results.push({ word: candidate, label });
      return results.length >= MAX_CANDIDATES;
    };

    const irregular = table.exceptions[subject] || table.exceptions[word];
    if (irregular) {
      push(irregular, 'irregular');
    }

    const stems = [];
    for (const rule of table.rules) {
      if (results.length >= MAX_CANDIDATES) {
        break;
      }
      if (!subject.endsWith(rule.s) || subject.length === rule.s.length) {
        continue;
      }
      const stem = subject.slice(0, subject.length - rule.s.length);
      if (push(stem + rule.r, rule.l)) {
        break;
      }
      stems.push({ stem, label: rule.l });
    }

    if (table === ENGLISH) {
      // Second pass: only the verb-ish suffixes produce a doubled stem worth
      // unwrapping, and only when the plain rewrite is not already a candidate.
      if (/ing$|ed$/.test(subject)) {
        for (const entry of stems) {
          if (results.length >= MAX_CANDIDATES) {
            break;
          }
          const base = undouble(entry.stem);
          if (base) {
            push(base, 'doubled ' + entry.label);
          }
        }
      }
      return results.slice(0, MAX_CANDIDATES);
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
