/**
 * The lookup popup.
 *
 * Rendered inside a closed-ish shadow root on a single host element so page CSS
 * can never leak in and our CSS can never leak out (a real problem for injected
 * dictionaries on heavily styled sites).  Everything is built with DOM calls
 * and textContent - no innerHTML - so dictionary text can never inject markup.
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const posLabels = isNode ? require('./pos-labels') : (global.DecDi && global.DecDi.posLabels);
  const translit = isNode ? require('./translit') : (global.DecDi && global.DecDi.translit);

  const HOST_ID = 'decdi-tooltip-host';
  const HIGHLIGHT_ID = 'decdi-highlight';
  const MAX_VISIBLE_GLOSS = 320;

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
.decdi-derived { font-size: .82em; color: var(--decdi-muted); margin-top: 2px; }
.decdi-gloss { margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
.decdi-gloss ol { margin: 0; padding-inline-start: 1.3em; }
.decdi-gloss li { margin: 0; }
.decdi-src { font-size: .78em; color: var(--decdi-muted); margin-top: 4px; }
.decdi-context {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-inline-start: 3px solid var(--decdi-accent);
  background: var(--decdi-chip);
  border-radius: 4px;
  font-size: .95em;
}
.decdi-context mark { background: transparent; color: var(--decdi-accent); font-weight: 700; }
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
      if (settings.showContext && config.context) {
        body.appendChild(this.buildContext(config.context));
      }
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
      if (settings.showRomanization) {
        const roman = (first && first.roman)
          || translit.romanize(term, settings.romanizationScheme);
        if (roman) {
          words.appendChild(element(doc, 'span', 'decdi-roman', roman));
        }
      }
      head.appendChild(words);

      const actions = element(doc, 'div', 'decdi-actions');

      if (settings.showTts && this.onRequestSpeak && typeof SpeechSynthesisUtterance !== 'undefined') {
        const speak = element(doc, 'button', 'decdi-btn', '\uD83D\uDD0A');
        speak.type = 'button';
        speak.title = 'Pronounce ' + term;
        speak.setAttribute('aria-label', 'Pronounce ' + term);
        speak.addEventListener('click', (event) => {
          event.preventDefault();
          this.onRequestSpeak(term, result.languages);
        });
        actions.appendChild(speak);
      }

      const copy = element(doc, 'button', 'decdi-btn', '\u29C9');
      copy.type = 'button';
      copy.title = 'Copy entry';
      copy.setAttribute('aria-label', 'Copy entry');
      copy.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.onRequestCopy) {
          this.onRequestCopy(result);
        }
      });
      actions.appendChild(copy);

      const pin = element(doc, 'button', 'decdi-btn', '\uD83D\uDCCC');
      pin.type = 'button';
      pin.title = 'Keep this open';
      pin.setAttribute('aria-label', 'Keep this open');
      pin.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
      pin.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.pinned = !this.pinned;
        pin.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
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

    buildContext(context) {
      const doc = this.document;
      const wrapper = element(doc, 'p', 'decdi-context');
      const before = context.text.slice(0, context.before);
      const word = context.text.slice(context.before, context.after);
      const after = context.text.slice(context.after);
      wrapper.appendChild(doc.createTextNode(before));
      wrapper.appendChild(element(doc, 'mark', null, word));
      wrapper.appendChild(doc.createTextNode(after));
      return wrapper;
    }

    buildMatch(match, result) {
      const doc = this.document;
      const wrapper = element(doc, 'div', 'decdi-match');

      const head = element(doc, 'div', 'decdi-match-head');
      head.appendChild(element(doc, 'span', 'decdi-term', match.headword));
      const posText = posLabels.label(match.pos);
      if (posText) {
        head.appendChild(element(doc, 'span', 'decdi-chip', posText));
      }
      if (this.settings.showRomanization) {
        const roman = match.roman
          || translit.romanize(match.headword, this.settings.romanizationScheme);
        if (roman) {
          head.appendChild(element(doc, 'span', 'decdi-roman', roman));
        }
      }
      wrapper.appendChild(head);

      if (match.derivedFrom) {
        wrapper.appendChild(element(doc, 'div', 'decdi-derived',
          result.query + ' \u2192 ' + match.headword
          + (match.derivedLabel ? ' \u00B7 ' + match.derivedLabel : '')));
      }

      const gloss = element(doc, 'div', 'decdi-gloss');
      const senses = splitSenses(truncate(match.gloss, MAX_VISIBLE_GLOSS));
      if (senses.length > 1) {
        const list = element(doc, 'ol');
        senses.forEach((sense) => list.appendChild(element(doc, 'li', null, sense)));
        gloss.appendChild(list);
      } else {
        gloss.textContent = senses[0] || match.gloss;
      }
      wrapper.appendChild(gloss);

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
        '\u201C' + result.query + '\u201D is not in the enabled dictionaries.'));
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
      this.hideHighlight();
    }

    /** Remove the popup entirely (used when the extension is switched off). */
    destroy() {
      this.hideHighlight();
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
    MAX_VISIBLE_GLOSS,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { tooltip: namespace });
  if (isNode) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
