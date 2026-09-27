/**
 * The lookup popup.
 *
 * Reads an English word and answers in Hindi, so the headword line is the Latin
 * word the reader selected and the answer below it is the Devanagari
 * translation, with its ISO 15919 pronunciation and the English sense that
 * translation belongs to.
 *
 * Rendered inside a shadow root on a single host element so page CSS can never
 * leak in and our CSS can never leak out (a real problem for injected
 * dictionaries on heavily styled sites).  Everything is built with DOM calls
 * and textContent - no innerHTML - so dictionary text can never inject markup.
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const posLabels = isNode ? require('./pos-labels') : (global.DecDi && global.DecDi.posLabels);
  const translit = isNode ? require('./translit') : (global.DecDi && global.DecDi.translit);
  const devanagari = isNode ? require('./devanagari') : (global.DecDi && global.DecDi.devanagari);

  const HOST_ID = 'decdi-tooltip-host';
  const HIGHLIGHT_ID = 'decdi-highlight';
  const MAX_VISIBLE_GLOSS = 320;
  const MAX_VISIBLE_SENSE = 140;

  const CSS = `
:host { all: initial; }
.decdi {
  --decdi-bg: #ffffff;
  --decdi-fg: #1a1a1f;
  --decdi-muted: #6b7280;
  --decdi-border: #e5e7eb;
  --decdi-accent: #4f46e5;
  --decdi-chip: #eef2ff;
  --decdi-shadow: 0 10px 30px rgba(15, 23, 42, .18);
  font-family: system-ui, "Segoe UI", "Noto Sans Devanagari", sans-serif;
  font-size: var(--decdi-font-size, 14px);
  line-height: 1.45;
  color: var(--decdi-fg);
  background: var(--decdi-bg);
  border: 1px solid var(--decdi-border);
  border-radius: 10px;
  box-shadow: var(--decdi-shadow);
  box-sizing: border-box;
  width: max-content;
  max-width: min(420px, 92vw);
  max-height: min(70vh, 560px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* The UA stylesheet's [hidden] rule is a UA-origin declaration, so the
   author-origin display:flex above beats it whatever the specificity.  Hiding
   the popup therefore means setting the hidden attribute (hide()), and without
   this rule that attribute hides nothing: Escape and the close button both set
   it and left the popup on screen. */
.decdi[hidden] { display: none; }
.decdi[data-theme="dark"] {
  --decdi-bg: #17181c;
  --decdi-fg: #f3f4f6;
  --decdi-muted: #9ca3af;
  --decdi-border: #2f3138;
  --decdi-accent: #a5b4fc;
  --decdi-chip: #262838;
  --decdi-shadow: 0 10px 30px rgba(0, 0, 0, .5);
}
.decdi-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--decdi-border);
}
.decdi-words { flex: 1 1 auto; min-width: 0; }
.decdi-headword {
  font-size: 1.45em;
  font-weight: 600;
  line-height: 1.2;
  word-break: break-word;
}
.decdi-roman { color: var(--decdi-muted); font-style: italic; margin-inline-start: 8px; font-size: .92em; }
.decdi-actions { display: flex; gap: 2px; flex: 0 0 auto; }
.decdi-btn {
  all: unset;
  cursor: pointer;
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 1em;
  line-height: 1;
  color: var(--decdi-muted);
}
.decdi-btn:hover, .decdi-btn:focus-visible { background: var(--decdi-chip); color: var(--decdi-accent); outline: none; }
.decdi-btn[aria-pressed="true"] { color: var(--decdi-accent); background: var(--decdi-chip); }
.decdi-body { overflow-y: auto; padding: 8px 12px 10px; }
.decdi-match + .decdi-match { border-top: 1px dashed var(--decdi-border); margin-top: 8px; padding-top: 8px; }
.decdi-match-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.decdi-term { font-weight: 600; }
.decdi-chip {
  font-size: .78em;
  background: var(--decdi-chip);
  color: var(--decdi-accent);
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
}
.decdi-answer {
  font-size: 1.3em;
  font-weight: 600;
  line-height: 1.35;
  margin-top: 3px;
  word-break: break-word;
}
.decdi-answer-roman { color: var(--decdi-muted); font-style: italic; font-weight: 400; font-size: .74em; margin-inline-start: 8px; }
.decdi-answer-sep { color: var(--decdi-muted); }
.decdi-sense { font-size: .88em; color: var(--decdi-muted); margin-top: 2px; }
.decdi-gloss { margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
.decdi-lang { font-size: .74em; color: var(--decdi-muted); margin-inline-start: 6px; }
.decdi-derived { font-size: .82em; color: var(--decdi-muted); margin-top: 2px; }
.decdi-gloss ol { margin: 0; padding-inline-start: 1.3em; }
.decdi-gloss li { margin: 0; }
.decdi-src { font-size: .78em; color: var(--decdi-muted); margin-top: 4px; }
.decdi-empty { padding: 6px 12px 12px; }
.decdi-empty p { margin: 0 0 6px; }
.decdi-suggest { list-style: none; margin: 0; padding: 0; }
.decdi-suggest li { margin: 2px 0; }
.decdi-suggest button {
  all: unset;
  cursor: pointer;
  color: var(--decdi-accent);
  font-weight: 600;
}
.decdi-suggest span { color: var(--decdi-muted); margin-inline-start: 6px; }
.decdi-foot {
  font-size: .74em;
  color: var(--decdi-muted);
  padding: 5px 12px 7px;
  border-top: 1px solid var(--decdi-border);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
`;

  const HIGHLIGHT_CSS = `
#${HIGHLIGHT_ID} {
  position: fixed;
  z-index: 2147483646;
  pointer-events: none;
  background: rgba(79, 70, 229, .16);
  border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(79, 70, 229, .35);
  transition: opacity .08s ease-out;
}
`;

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function prefersDark(doc) {
    try {
      return Boolean(doc.defaultView && doc.defaultView.matchMedia
        && doc.defaultView.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (error) {
      return false;
    }
  }

  function resolveTheme(setting, doc) {
    if (setting === 'dark' || setting === 'light') {
      return setting;
    }
    return prefersDark(doc) ? 'dark' : 'light';
  }

  /** "1. a. 2. b." -> ["a.", "b."] so the popup can render a real list. */
  function splitSenses(gloss) {
    const text = String(gloss || '').trim();
    if (!text) {
      return [];
    }
    const parts = text.split(/\s+(?=\d{1,2}\.\s)/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      return [text];
    }
    return parts.map((part) => part.replace(/^\d{1,2}\.\s*/, ''));
  }

  function truncate(text, limit) {
    if (text.length <= limit) {
      return text;
    }
    const cut = text.slice(0, limit);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return (boundary > limit * 0.5 ? cut.slice(0, boundary + 1) : cut).trim() + ' \u2026';
  }

  /**
   * Pronunciation for one entry.
   *
   * The headword is English, so romanising it would be meaningless; what the
   * reader needs is how to *say* the answer, so we romanise the Devanagari
   * translation.  Wiktionary already supplies ISO 15919 in the pack's `roman`
   * column, which we prefer over deriving it.
   */
  function pronunciationFor(match, scheme) {
    if (match.roman) {
      return match.roman;
    }
    const answer = devanagari.firstDevanagariToken(match.gloss || '');
    if (answer) {
      return translit.romanize(answer, scheme);
    }
    return '';
  }

  /**
   * What to speak for one entry: the translation when there is one, otherwise
   * the English headword.  Returns '' when there is nothing to say.
   */
  function speechTextFor(match) {
    const answer = devanagari.firstDevanagariToken(match.gloss || '');
    return answer || match.headword || '';
  }

  /**
   * The same answer as Latin letters, for reading aloud when the platform has no
   * voice for Devanagari.  Always the *simplified* romanisation, not the
   * displayed scheme: an English voice asked for "sīkhnā" does no better than one
   * asked for "sikhnā", and the macrons are read as separate letters.
   *
   * Prefers the pack's own ISO 15919 when it supplied one, since that is a
   * transliteration rather than a re-derivation, but only for a Devanagari
   * answer: for a Latin headword it would just be the word again.
   */
  function speechFallbackFor(match) {
    if (!match) {
      return '';
    }
    const answer = devanagari.firstDevanagariToken(match.gloss || '');
    if (!answer) {
      return match.roman ? translit.simplify(match.roman) : '';
    }
    if (match.roman && devanagari.hasDevanagari(answer)) {
      return translit.simplify(match.roman);
    }
    return translit.romanize(answer, 'simplified');
  }

  /**
   * The BCP-47 tag the answer should be spoken in, taken from the pack rather
   * than hard-coded, so a pack answering in another language would be spoken in
   * that language without a change here.
   */
  const SPEECH_LANGS = { hi: 'hi-IN', mr: 'mr-IN', en: 'en-IN' };

  function speechLangFor(match) {
    const code = (match.pack && match.pack.targetLang) || '';
    return SPEECH_LANGS[code] || SPEECH_LANGS.hi;
  }

  /**
   * True when a keystroke belongs to whatever the reader is typing rather than
   * to us.  The popup is often open over a search box or a comment field, and a
   * dictionary that swallows the letter "a" there is worse than one with no
   * shortcuts at all.
   */
  function isEditableTarget(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (node.isContentEditable) {
      return true;
    }
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return true;
    }
    return typeof node.closest === 'function' && Boolean(node.closest('[contenteditable]'));
  }

  class Tooltip {
    constructor(options) {
      const config = options || {};
      this.document = config.document || global.document;
      this.settings = config.settings || {};
      this.onRequestSpeak = config.onRequestSpeak || null;
      this.onRequestCopy = config.onRequestCopy || null;
      this.onClose = config.onClose || null;
      this.onSelectSuggestion = config.onSelectSuggestion || null;
      this.host = null;
      this.shadow = null;
      this.root = null;
      this.pinned = false;
      this.visible = false;
      this.result = null;
      this.highlight = null;
      this.keyHandler = null;
    }

    /* ----------------------------------------------------------------- *
     * Keyboard: A speaks, C copies, Shift pins, Escape closes.
     * ----------------------------------------------------------------- */

    /**
     * Speak the answer, in the language the pack answers in.
     *
     * `onRequestSpeak` also gets a Latin-letter rendering, used only when the
     * platform has no voice for Devanagari - see speechFallbackFor().
     * @returns {boolean} whether anything was spoken
     */
    speakCurrent() {
      if (!this.onRequestSpeak || !this.result) {
        return false;
      }
      const match = this.result.matches[0];
      this.onRequestSpeak(
        match ? speechTextFor(match) : this.result.query,
        match ? speechLangFor(match) : null,
        match ? speechFallbackFor(match) : '',
      );
      return true;
    }

    /** Copy the whole entry. @returns {boolean} whether anything was copied */
    copyCurrent() {
      if (!this.onRequestCopy || !this.result) {
        return false;
      }
      this.onRequestCopy(this.result);
      return true;
    }

    /** Freeze the popup open, or let it follow the pointer again. */
    togglePin() {
      this.pinned = !this.pinned;
      const pin = this.root ? this.root.querySelector('.decdi-pin') : null;
      if (pin) {
        pin.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
      }
      return this.pinned;
    }

    /**
     * The element a keystroke is actually going into, or null.
     *
     * `event.target` is normally the focused element, but it is not reliable on
     * its own: an event dispatched at the document, or one retargeted out of a
     * shadow tree, reports the document and would let a shortcut fire while the
     * reader is typing.  `activeElement` is the authority on where the text goes,
     * and a shadow host is not itself editable - the element inside it is.
     */
    activeElement() {
      const doc = this.document;
      const active = doc && doc.activeElement;
      if (!active || !active.tagName) {
        return null;
      }
      if (active.shadowRoot && active.shadowRoot.activeElement) {
        return active.shadowRoot.activeElement;
      }
      return active;
    }

    handleKey(event) {
      if (!this.visible || !this.result) {
        return;
      }
      // A modified keystroke belongs to the browser or the page, not to us.
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      // Never swallow typing: the popup is very often open over a search box or
      // a comment field, and a dictionary that eats the letter "a" there is
      // worse than one with no shortcuts at all.
      if (isEditableTarget(event.target) || isEditableTarget(this.activeElement())) {
        return;
      }
      let handled = true;
      if (event.key === 'Shift') {
        this.togglePin();
      } else {
        const key = String(event.key || '').toLowerCase();
        if (key === 'a') {
          handled = this.speakCurrent();
        } else if (key === 'c') {
          handled = this.copyCurrent();
        } else {
          handled = false;
        }
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    ensureKeyHandler() {
      if (this.keyHandler || !this.document) {
        return;
      }
      this.keyHandler = (event) => this.handleKey(event);
      // Capture, so the shortcut still works when focus sits on a page button
      // rather than on ours.
      this.document.addEventListener('keydown', this.keyHandler, true);
    }

    removeKeyHandler() {
      if (this.keyHandler && this.document) {
        this.document.removeEventListener('keydown', this.keyHandler, true);
        this.keyHandler = null;
      }
    }

    ensureHost() {
      if (this.host && this.host.isConnected) {
        return this.shadow;
      }
      const doc = this.document;
      if (!doc || !doc.documentElement) {
        return null;
      }
      const existing = doc.getElementById(HOST_ID);
      if (existing && existing.shadowRoot) {
        this.host = existing;
        this.shadow = existing.shadowRoot;
        this.root = this.shadow.querySelector('.decdi');
        return this.shadow;
      }

      const host = doc.createElement('div');
      host.id = HOST_ID;
      host.style.setProperty('all', 'initial');
      host.style.setProperty('position', 'fixed');
      host.style.setProperty('top', '0');
      host.style.setProperty('left', '0');
      host.style.setProperty('z-index', '2147483647');
      host.setAttribute('data-dec-di', 'tooltip');

      const shadow = host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const root = element(doc, 'div', 'decdi');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'Dictionary entry');
      root.hidden = true;
      shadow.appendChild(root);

      doc.documentElement.appendChild(host);
      this.host = host;
      this.shadow = shadow;
      this.root = root;
      return shadow;
    }

    /** Show a filled-in result. */
    render(result, options) {
      const config = options || {};
      if (!this.ensureHost()) {
        return;
      }
      this.result = result;
      const doc = this.document;
      const settings = this.settings;
      const root = this.root;
      root.setAttribute('data-theme', resolveTheme(settings.theme, doc));
      root.style.setProperty('--decdi-font-size', (settings.fontSize || 14) + 'px');
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }

      root.appendChild(this.buildHead(result));
      const body = element(doc, 'div', 'decdi-body');
      if (result.missing) {
        body.appendChild(this.buildEmpty(result));
      } else {
        result.matches.forEach((match) => body.appendChild(this.buildMatch(match, result)));
      }
      root.appendChild(body);
      if (settings.showSource && !result.missing && result.matches.length) {
        root.appendChild(this.buildFooter(result));
      }
      root.hidden = false;
    }

    buildHead(result) {
      const doc = this.document;
      const settings = this.settings;
      const head = element(doc, 'div', 'decdi-head');

      const words = element(doc, 'div', 'decdi-words');
      const first = result.matches.length ? result.matches[0] : null;
      const term = first ? first.headword : result.query;
      words.appendChild(element(doc, 'span', 'decdi-headword', term));
      head.appendChild(words);

      const actions = element(doc, 'div', 'decdi-actions');

      if (settings.showTts && this.onRequestSpeak && typeof SpeechSynthesisUtterance !== 'undefined') {
        const speak = element(doc, 'button', 'decdi-btn', '\uD83D\uDD0A');
        speak.type = 'button';
        speak.title = 'Pronounce ' + term;
        speak.setAttribute('aria-label', 'Pronounce ' + term);
        speak.addEventListener('click', (event) => {
          event.preventDefault();
          this.speakCurrent();
        });
        actions.appendChild(speak);
      }

      const copy = element(doc, 'button', 'decdi-btn', '\u29C9');
      copy.type = 'button';
      copy.title = 'Copy entry';
      copy.setAttribute('aria-label', 'Copy entry');
      copy.addEventListener('click', (event) => {
        event.preventDefault();
        this.copyCurrent();
      });
      actions.appendChild(copy);

      const pin = element(doc, 'button', 'decdi-btn decdi-pin', '\uD83D\uDCCC');
      pin.type = 'button';
      pin.title = 'Keep this open (Shift)';
      pin.setAttribute('aria-label', 'Keep this open');
      pin.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
      pin.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.togglePin();
      });
      actions.appendChild(pin);

      const close = element(doc, 'button', 'decdi-btn', '\u00D7');
      close.type = 'button';
      close.title = 'Close (Esc)';
      close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', (event) => {
        event.preventDefault();
        this.hide(true);
        if (this.onClose) {
          this.onClose();
        }
      });
      actions.appendChild(close);

      head.appendChild(actions);
      return head;
    }

    buildMatch(match, result) {
      const doc = this.document;
      const wrapper = element(doc, 'div', 'decdi-match');

      // The English word and its part of speech.
      const head = element(doc, 'div', 'decdi-match-head');
      head.appendChild(element(doc, 'span', 'decdi-term', match.headword));
      const posText = posLabels.label(match.pos);
      if (posText) {
        head.appendChild(element(doc, 'span', 'decdi-chip', posText));
      }
      wrapper.appendChild(head);

      if (match.derivedFrom) {
        wrapper.appendChild(element(doc, 'div', 'decdi-derived',
          match.derivedFrom + ' \u2192 ' + match.headword
          + (match.derivedLabel ? ' \u00B7 ' + match.derivedLabel : '')));
      }

      // The answer itself.  Raghuvira rows pack several equivalent renderings
      // into one semicolon-separated field, so it is split back out into a list
      // rather than shown as one run-on string.  The English sense the answer
      // came from is rendered separately below, because "what it means in
      // English" is usually the part a learner needs.
      const answerText = match.gloss || '';
      const senses = splitSenses(truncate(answerText, MAX_VISIBLE_GLOSS));
      const answer = element(doc, 'div', 'decdi-answer');
      if (senses.length > 1) {
        senses.forEach((sense, index) => {
          if (index > 0) {
            answer.appendChild(element(doc, 'span', 'decdi-answer-sep', '; '));
          }
          answer.appendChild(doc.createTextNode(sense));
        });
      } else {
        answer.textContent = senses[0] || answerText;
      }
      if (this.settings.showRomanization) {
        const roman = pronunciationFor(match, this.settings.romanizationScheme);
        if (roman) {
          answer.appendChild(element(doc, 'span', 'decdi-answer-roman', roman));
        }
      }
      wrapper.appendChild(answer);

      if (match.sense) {
        // What `sense` holds depends on the pack.  Raghu Vira and Wiktionary
        // carry the English definition the translation answers; a pack with no
        // per-sense definition stores an example sentence instead, and the pack
        // declares that with the `with-examples` flag.  The line is labelled
        // rather than passed off as a definition.
        const isExample = Array.isArray(match.pack.flags)
          && match.pack.flags.indexOf('with-examples') >= 0;
        wrapper.appendChild(element(doc, 'div', 'decdi-sense',
          (isExample ? 'e.g. ' : '')
          + truncate(match.sense, MAX_VISIBLE_SENSE)));
      }

      if (this.settings.showSource) {
        wrapper.appendChild(element(doc, 'div', 'decdi-src', match.pack.name));
      }
      return wrapper;
    }

    buildFooter(result) {
      const doc = this.document;
      const foot = element(doc, 'div', 'decdi-foot');
      const licenses = [];
      result.matches.forEach((match) => {
        if (match.pack.license && licenses.indexOf(match.pack.license) < 0) {
          licenses.push(match.pack.license);
        }
      });
      foot.appendChild(element(doc, 'span', null, licenses.join(' \u00B7 ')));
      foot.appendChild(element(doc, 'span', null, 'Esc to close'));
      return foot;
    }

    buildEmpty(result) {
      const doc = this.document;
      const wrapper = element(doc, 'div', 'decdi-empty');
      wrapper.appendChild(element(doc, 'p', null,
        'No entry for \u201C' + result.query + '\u201D in the installed dictionaries.'));
      if (result.suggestions && result.suggestions.length) {
        wrapper.appendChild(element(doc, 'p', null, 'Did you mean:'));
        const list = element(doc, 'ul', 'decdi-suggest');
        result.suggestions.forEach((suggestion) => {
          const item = element(doc, 'li');
          const button = element(doc, 'button', null, suggestion.headword);
          button.type = 'button';
          button.addEventListener('click', (event) => {
            event.preventDefault();
            if (this.onSelectSuggestion) {
              this.onSelectSuggestion(suggestion);
            }
          });
          item.appendChild(button);
          if (suggestion.gloss) {
            item.appendChild(element(doc, 'span', null, truncate(suggestion.gloss, 60)));
          }
          list.appendChild(item);
        });
        wrapper.appendChild(list);
      }
      return wrapper;
    }

    /** Place the popup near `rect`, flipping and clamping to stay on screen. */
    position(rect) {
      if (!this.root || this.root.hidden) {
        return;
      }
      const view = this.document.defaultView;
      const width = this.root.offsetWidth;
      const height = this.root.offsetHeight;
      const margin = 8;
      const viewportWidth = view ? view.innerWidth : 1024;
      const viewportHeight = view ? view.innerHeight : 768;

      let top = rect.bottom + 6;
      if (top + height > viewportHeight - margin) {
        const above = rect.top - height - 6;
        top = above > margin ? above : Math.max(margin, viewportHeight - height - margin);
      }
      let left = rect.left;
      if (left + width > viewportWidth - margin) {
        left = Math.max(margin, viewportWidth - width - margin);
      }
      if (left < margin) {
        left = margin;
      }
      this.root.style.position = 'fixed';
      this.root.style.top = Math.round(top) + 'px';
      this.root.style.left = Math.round(left) + 'px';
    }

    show(rect) {
      if (!this.ensureHost()) {
        return;
      }
      this.root.hidden = false;
      this.visible = true;
      this.ensureKeyHandler();
      this.position(rect);
    }

    hide(force) {
      if (!this.root) {
        return;
      }
      if (this.pinned && !force) {
        return;
      }
      this.root.hidden = true;
      this.visible = false;
      this.removeKeyHandler();
      this.hideHighlight();
    }

    /** Remove the popup entirely (used when the extension is switched off). */
    destroy() {
      this.hideHighlight();
      this.removeKeyHandler();
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }
      this.host = null;
      this.shadow = null;
      this.root = null;
      this.visible = false;
      this.pinned = false;
    }

    /** True when the node is inside our shadow host (so hover handlers ignore it). */
    contains(node) {
      if (!this.host || !node) {
        return false;
      }
      return this.host === node || this.host.contains(node);
    }

    /** Non-invasive highlight of the hovered word, drawn behind the page text. */
    showHighlight(rect) {
      const doc = this.document;
      if (!doc || !doc.documentElement) {
        return;
      }
      if (!this.highlight || !this.highlight.isConnected) {
        if (!doc.getElementById(HIGHLIGHT_ID)) {
          const style = doc.createElement('style');
          style.textContent = HIGHLIGHT_CSS;
          style.setAttribute('data-dec-di', 'style');
          doc.documentElement.appendChild(style);
        }
        const box = doc.createElement('div');
        box.id = HIGHLIGHT_ID;
        box.setAttribute('data-dec-di', 'highlight');
        doc.documentElement.appendChild(box);
        this.highlight = box;
      }
      const box = this.highlight;
      box.style.top = Math.round(rect.top - 1) + 'px';
      box.style.left = Math.round(rect.left - 1) + 'px';
      box.style.width = Math.max(2, Math.round(rect.width + 2)) + 'px';
      box.style.height = Math.max(2, Math.round(rect.height + 2)) + 'px';
      box.style.display = 'block';
    }

    hideHighlight() {
      if (this.highlight) {
        this.highlight.style.display = 'none';
      }
    }
  }

  const namespace = {
    Tooltip,
    HOST_ID,
    HIGHLIGHT_ID,
    splitSenses,
    truncate,
    resolveTheme,
    isEditableTarget,
    pronunciationFor,
    speechTextFor,
    speechFallbackFor,
    speechLangFor,
    CSS,
    MAX_VISIBLE_GLOSS,
    MAX_VISIBLE_SENSE,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { tooltip: namespace });
  if (isNode) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
