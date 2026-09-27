/**
 * Part-of-speech labels.
 *
 * The source dictionaries each use their own short markers: Berntsen writes
 * "m." / "n." / "adj. inv.", Vaze writes bare "a" / "m", Chaturvedi writes
 * "(nm)" / "(v)", and the English Wiktionary extract writes its Wiktextract
 * names ("noun", "adj", "prep_phrase", "name").  The build step keeps the
 * marker as-is (it is the most faithful thing to store) and the UI maps it to
 * something a learner can read.
 */
(function (global) {
  'use strict';

  const LABELS = {
    n: 'noun',
    m: 'masculine noun',
    f: 'feminine noun',
    nm: 'masculine noun',
    nf: 'feminine noun',
    nc: 'countable noun',
    nu: 'uncountable noun',
    mu: 'uncountable masculine noun',
    mc: 'countable masculine noun',
    mf: 'masculine or feminine',
    nn: 'neuter noun',
    a: 'adjective',
    adj: 'adjective',
    'adj inv': 'adjective (invariable)',
    adv: 'adverb',
    v: 'verb',
    vi: 'intransitive verb',
    vt: 'transitive verb',
    vz: 'transitive verb',
    pp: 'past participle',
    pron: 'pronoun',
    post: 'postposition',
    postp: 'postposition',
    prep: 'preposition',
    prep_phrase: 'prepositional phrase',
    conj: 'conjunction',
    interj: 'interjection',
    intj: 'interjection',
    part: 'particle',
    particle: 'particle',
    num: 'numeral',
    pref: 'prefix',
    suf: 'suffix',
    inf: 'infix',
    infix: 'infix',
    interfix: 'interfix',
    ind: 'indeclinable',
    'prop. n': 'proper noun',
    'prop n': 'proper noun',
    name: 'proper noun',
    phrase: 'phrase',
    proverb: 'proverb',
    prov: 'proverb',
    contr: 'contraction',
    det: 'determiner',
    art: 'article',
    punct: 'punctuation',
    punc: 'punctuation',
    letter: 'letter',
    symbol: 'symbol',
    //: Grammatical tags that ride along with a Wiktionary translation.
    masculine: 'masculine',
    feminine: 'feminine',
    neuter: 'neuter',
    plural: 'plural',
    singular: 'singular',
    countable: 'countable',
    uncountable: 'uncountable',
  };

  /** Short suffix markers that appear glued to another marker ("adj. inv."). */
  const MODIFIERS = {
    inv: 'invariable',
    'inv.': 'invariable',
  };

  /**
   * Base parts of speech, used to pick the head out of a combined marker.
   * Wiktextract writes "n m" for a masculine noun and "prop. n" for a proper
   * noun, so the marker has to be read as one part of speech plus qualifiers
   * rather than as a list of independent parts.
   */
  const BASE = new Set([
    'n', 'adj', 'a', 'v', 'vi', 'vt', 'vz', 'adv', 'pron', 'post', 'postp',
    'prep', 'conj', 'interj', 'intj', 'part', 'particle', 'num', 'det', 'art',
    'punct', 'punc', 'letter', 'symbol', 'inf', 'infix', 'prefix', 'suffix',
    'interfix', 'contr', 'phrase', 'proverb', 'prov', 'ind',
  ]);

  /** Tokens that mark a name rather than a part of speech. */
  const PROPER = new Set(['prop', 'name']);

  /** Gender, number and countability tags that qualify the head noun. */
  const QUALIFIERS = {
    m: 'masculine',
    f: 'feminine',
    n: 'neuter',
    c: 'countable',
    u: 'uncountable',
    sg: 'singular',
    pl: 'plural',
    mf: 'masculine or feminine',
    mn: 'masculine or neuter',
    fn: 'feminine or neuter',
  };

  /** Qualifiers that read better before the noun than after it. */
  const PRE_NOUN = new Set([
    'masculine', 'feminine', 'neuter', 'countable', 'uncountable',
    'singular', 'plural', 'masculine or feminine', 'masculine or neuter',
    'feminine or neuter',
  ]);

  function normalizeToken(pos) {
    return String(pos || '')
      .toLowerCase()
      .replace(/[().]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build one label from a head part of speech plus its qualifiers.
   * "n m" becomes "masculine noun", not "noun masculine" and certainly not the
   * doubled "noun masculine noun" that token-by-token expansion produces.
   */
  function compose(head, proper, qualifiers) {
    let text = proper ? (head === 'noun' ? 'proper noun' : 'proper ' + head) : head;
    const leading = qualifiers.filter((word) => PRE_NOUN.has(word));
    const trailing = qualifiers.filter((word) => !PRE_NOUN.has(word));
    if (leading.length && /\bnoun\b/.test(text)) {
      text = leading.join(' or ') + ' ' + text;
    }
    return trailing.length ? [text].concat(trailing).join(', ') : text;
  }

  /**
   * Human label for a stored part-of-speech marker.
   * Returns '' when there is nothing sensible to show.
   */
  function label(pos) {
    const token = normalizeToken(pos);
    if (!token) {
      return '';
    }
    if (LABELS[token]) {
      return LABELS[token];
    }
    let head = '';
    let proper = false;
    const qualifiers = [];
    for (const word of token.split(' ')) {
      if (!head && PROPER.has(word)) {
        proper = true;
      } else if (!head && BASE.has(word)) {
        head = LABELS[word] || word;
      } else {
        qualifiers.push(QUALIFIERS[word] || MODIFIERS[word] || LABELS[word] || word);
      }
    }
    if (!head) {
      return qualifiers.join(' ');
    }
    return compose(head, proper, qualifiers);
  }

  /** A very short chip version of the label ("n", "adj", "v"). */
  function short(pos) {
    const token = normalizeToken(pos);
    if (!token) {
      return '';
    }
    const first = token.split(' ')[0];
    if (first === 'adjective') return 'adj';
    if (first === 'noun') return 'n';
    if (first.endsWith('noun')) return first.slice(0, 1);
    return first.slice(0, 4);
  }

  const namespace = { label, short, normalizeToken, LABELS };

  global.DecDi = Object.assign(global.DecDi || {}, { posLabels: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
