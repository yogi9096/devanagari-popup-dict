/**
 * Part-of-speech labels.
 *
 * The source dictionaries each use their own short markers: Berntsen writes
 * "m." / "n." / "adj. inv.", Vaze writes bare "a" / "m", Chaturvedi writes
 * "(nm)" / "(v)", Wiktionary uses "n" / "v" / "prop. n". The build step keeps
 * the marker as-is (it is the most faithful thing to store) and the UI maps it
 * to something a learner can read.
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
    mu: 'masculine, uncountable',
    mc: 'masculine, countable',
    mf: 'masculine or feminine',
    nn: 'neuter noun',
    a: 'adjective',
    adj: 'adjective',
    'adj inv': 'adjective (invariable)',
    adv: 'adverb',
    v: 'verb',
    vi: 'intransitive verb',
    vt: 'transitive verb',
    pp: 'past participle',
    pron: 'pronoun',
    post: 'postposition',
    postp: 'postposition',
    prep: 'preposition',
    conj: 'conjunction',
    interj: 'interjection',
    intj: 'interjection',
    part: 'particle',
    particle: 'particle',
    num: 'numeral',
    pref: 'prefix',
    suf: 'suffix',
    inf: 'infix',
    ind: 'indeclinable',
    'prop. n': 'proper noun',
    'prop n': 'proper noun',
    name: 'proper noun',
    phrase: 'phrase',
    prov: 'proverb',
    contr: 'contraction',
    det: 'determiner',
    art: 'article',
    interfix: 'interfix',
    punc: 'punctuation',
  };

  /** Short suffix markers that appear glued to another marker ("adj. inv."). */
  const MODIFIERS = {
    inv: 'invariable',
    'inv.': 'invariable',
  };

  function normalizeToken(pos) {
    return String(pos || '')
      .toLowerCase()
      .replace(/[().]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
    const words = token.split(' ').filter(Boolean).map((word) => LABELS[word] || MODIFIERS[word] || word);
    return words.join(' ');
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
