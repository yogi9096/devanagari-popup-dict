/**
 * Content script: turns hovering over Devanagari text into dictionary popups.
 *
 * Design notes
 * ------------
 * * One rAF-throttled `mousemove` listener does everything.  There is no
 *   per-word DOM instrumentation, so pages (and SPAs) are never modified, which
 *   keeps the extension safe on sites that rewrite their DOM constantly.
 * * Caret resolution uses `caretPositionFromPoint` (with the Chrome
 *   `caretRangeFromPoint` fallback) and then expands to a word with the
 *   Devanagari-aware helpers in src/common/devanagari.js.
 * * Lookups are debounced and results are discarded when the pointer has moved
 *   on, so a fast sweep over a paragraph never flashes stale entries.
 * * All state is reloaded from storage on change, so options apply live.
 */
(function (global) {
  'use strict';

  if (!global.DecDi || !global.DecDi.dictionary || !global.DecDi.tooltip) {
    // Not running as a content script (e.g. required from Node for tests).
    return;
  }

  const DecDi = global.DecDi;
  const compat = DecDi.compat;
  const devanagari = DecDi.devanagari;
  const settingsModule = DecDi.settings;
  const dictionaryModule = DecDi.dictionary;
  const tooltipModule = DecDi.tooltip;

  const MODIFIER_FLAGS = {
    Shift: 'shiftKey',
    Control: 'ctrlKey',
    Alt: 'altKey',
    Meta: 'metaKey',
  };

  const state = {
    settings: null,
    dictionary: null,
    tooltip: null,
    active: false,
    inFrame: false,
    pointer: { x: -1, y: -1 },
    current: null,
    hoverTimer: 0,
    hideTimer: 0,
    requestId: 0,
    frameOffset: null,
  };

  function isEditable(target) {
    if (!target || target.nodeType !== 1) {
      return false;
    }
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'textarea' || tag === 'input' || tag === 'select') {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    return false;
  }

  /** The text node + word under a viewport point, or null. */
  function wordAtPoint(x, y) {
    const doc = global.document;
    let node = null;
    let offset = 0;
    try {
      if (typeof doc.caretPositionFromPoint === 'function') {
        const position = doc.caretPositionFromPoint(x, y);
        if (position && position.offsetNode) {
          node = position.offsetNode;
          offset = position.offset;
        }
      } else if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(x, y);
        if (range) {
          node = range.startContainer;
          offset = range.startOffset;
        }
      }
    } catch (error) {
      return null;
    }
    if (!node || node.nodeType !== 3 || !node.data) {
      return null;
    }
    let root = node.getRootNode ? node.getRootNode() : null;
    if (root && root.nodeType === 11) {
      // Inside a shadow DOM: ignore our own tree, otherwise still usable.
      if (root.host && root.host.id === tooltipModule.HOST_ID) {
        return null;
      }
    }
    const found = devanagari.extractWord(node.data, offset);
    if (!found) {
      return null;
    }
    return { node, word: found.word, start: found.start, end: found.end };
  }

  function rectFor(entry) {
    try {
      const range = global.document.createRange();
      range.setStart(entry.node, entry.start);
      range.setEnd(entry.node, entry.end);
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        return rect;
      }
    } catch (error) {
      /* the node may have been replaced between lookup and render */
    }
    return null;
  }

  function sameTarget(candidate) {
    return state.current
      && state.current.node === candidate.node
      && state.current.start === candidate.start
      && state.current.end === candidate.end;
  }

  function modifierHeld(event) {
    if (!state.settings || state.settings.trigger !== 'modifier') {
      return true;
    }
    const flag = MODIFIER_FLAGS[state.settings.modifier] || 'shiftKey';
    return Boolean(event && event[flag]);
  }

  function clearTimers() {
    if (state.hoverTimer) {
      global.clearTimeout(state.hoverTimer);
      state.hoverTimer = 0;
    }
    if (state.hideTimer) {
      global.clearTimeout(state.hideTimer);
      state.hideTimer = 0;
    }
  }

  function hide(force) {
    if (!state.tooltip) {
      return;
    }
    state.tooltip.hide(force);
    state.current = null;
  }

  function scheduleHide(delay) {
    if (state.hideTimer) {
      global.clearTimeout(state.hideTimer);
    }
    state.hideTimer = global.setTimeout(() => {
      state.hideTimer = 0;
      hide(false);
    }, typeof delay === 'number' ? delay : state.settings.hideDelay);
  }

  /** Run the lookup and show the popup; stale results are dropped. */
  async function showForEntry(entry) {
    if (!state.dictionary || !state.tooltip || !state.settings) {
      return;
    }
    const rect = rectFor(entry);
    if (!rect) {
      return;
    }
    state.current = { node: entry.node, start: entry.start, end: entry.end, rect };
    state.tooltip.showHighlight(rect);

    const requestId = (state.requestId += 1);
    let result;
    try {
      result = await state.dictionary.lookup(entry.word, state.settings);
    } catch (error) {
      return;
    }
    if (requestId !== state.requestId || !state.current) {
      return;
    }
    if (result.missing) {
      try {
        result.suggestions = await state.dictionary.suggest(entry.word, state.settings, 5);
      } catch (error) {
        result.suggestions = [];
      }
      if (requestId !== state.requestId || !state.current) {
        return;
      }
    }

    const context = state.settings.showContext
      ? devanagari.sentenceAround(
        entry.node.data,
        entry.start,
        entry.end,
        state.settings.contextChars || 160,
      )
      : null;

    state.tooltip.settings = state.settings;
    state.tooltip.render(result, { context });
    state.tooltip.show(rect);
  }

  function handleMove(event) {
    if (!state.active) {
      return;
    }
    state.pointer.x = event.clientX;
    state.pointer.y = event.clientY;

    if (state.tooltip && state.tooltip.contains(event.target)) {
      return; // hovering the popup itself keeps it open
    }
    const doc = global.document;
    const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      return; // the user is selecting text, do not interfere
    }
    if (!modifierHeld(event)) {
      scheduleHide(0);
      return;
    }

    const target = event.target;
    if (target && isEditable(target) && target.isContentEditable === false) {
      return;
    }
    if (target && target.nodeType === 1 && target.closest
      && target.closest('[data-dec-di]')) {
      return;
    }

    const entry = wordAtPoint(event.clientX, event.clientY);
    if (!entry) {
      scheduleHide();
      return;
    }
    if (sameTarget(entry) && state.tooltip && state.tooltip.visible) {
      if (state.hideTimer) {
        global.clearTimeout(state.hideTimer);
        state.hideTimer = 0;
      }
      return;
    }
    if (state.tooltip && state.tooltip.pinned && sameTarget(entry)) {
      return;
    }

    clearTimers();
    state.current = { node: entry.node, start: entry.start, end: entry.end, rect: rectFor(entry) };
    const delay = Math.max(0, Number(state.settings.hoverDelay) || 0);
    state.hoverTimer = global.setTimeout(() => {
      state.hoverTimer = 0;
      showForEntry(entry);
    }, delay);
  }

  function handleLeave() {
    if (!state.active) {
      return;
    }
    scheduleHide(120);
  }

  function handleScroll() {
    if (!state.active || !state.tooltip || !state.tooltip.visible || !state.current) {
      return;
    }
    if (!state.current.node || !state.current.node.isConnected) {
      hide(true);
      return;
    }
    const rect = rectFor(state.current);
    if (!rect) {
      hide(true);
      return;
    }
    state.current.rect = rect;
    state.tooltip.position(rect);
    state.tooltip.showHighlight(rect);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      hide(true);
      if (state.tooltip) {
        state.tooltip.pinned = false;
      }
    }
  }

  function pickVoice(lang) {
    if (typeof global.speechSynthesis === 'undefined'
      || typeof global.speechSynthesis.getVoices !== 'function') {
      return null;
    }
    const prefix = lang.slice(0, 2).toLowerCase();
    const voices = global.speechSynthesis.getVoices() || [];
    return voices.find((voice) => (voice.lang || '').toLowerCase() === lang.toLowerCase())
      || voices.find((voice) => (voice.lang || '').toLowerCase().indexOf(prefix) === 0)
      || null;
  }

  function speak(text, languages) {
    if (typeof global.speechSynthesis === 'undefined'
      || typeof global.SpeechSynthesisUtterance === 'undefined') {
      return;
    }
    const language = languages && languages[0] === 'mr' ? 'mr-IN' : 'hi-IN';
    const utterance = new global.SpeechSynthesisUtterance(text);
    utterance.lang = language;
    const voice = pickVoice(language);
    if (voice) {
      utterance.voice = voice;
    }
    utterance.rate = 0.9;
    try {
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(utterance);
    } catch (error) {
      /* voice unavailable - not worth breaking the UI over */
    }
  }

  function copyToClipboard(text) {
    const nav = global.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      return nav.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const doc = global.document;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('data-dec-di', 'clipboard');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    try {
      doc.execCommand('copy');
    } catch (error) {
      /* ignore */
    }
    doc.body.removeChild(area);
  }

  function formatResult(result) {
    return result.matches.map((match) => {
      const parts = [match.headword];
      const pos = DecDi.posLabels.label(match.pos);
      if (pos) {
        parts.push('(' + pos + ')');
      }
      const roman = match.roman || DecDi.translit.romanize(match.headword, state.settings.romanizationScheme);
      if (roman) {
        parts.push(roman);
      }
      return parts.join(' ') + ' - ' + match.gloss;
    }).join('\n');
  }

  /** Look up the current selection (context menu / keyboard command). */
  async function lookupSelection() {
    const doc = global.document;
    const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
    const text = selection ? String(selection) : '';
    const match = devanagari.findWords(text)[0];
    if (!selection || selection.rangeCount === 0 || !match) {
      return false;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      return false;
    }
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) {
      return false;
    }
    if (state.tooltip) {
      state.tooltip.pinned = true;
    }
    await showForEntry({
      node,
      word: match.word,
      start: match.start,
      end: match.end,
    });
    return true;
  }

  function ensureTooltip() {
    if (!state.tooltip) {
      state.tooltip = new tooltipModule.Tooltip({
        document: global.document,
        settings: state.settings,
        onRequestSpeak: speak,
        onRequestCopy: (result) => copyToClipboard(formatResult(result)),
        onClose: () => {},
        onSelectSuggestion: (suggestion) => {
          const doc = global.document;
          const range = doc.createRange();
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const index = node.data.indexOf(suggestion.headword);
            if (index >= 0) {
              range.setStart(node, index);
              range.setEnd(node, index + suggestion.headword.length);
              break;
            }
            node = walker.nextNode();
          }
          if (node) {
            showForEntry({
              node,
              word: suggestion.headword,
              start: range.startOffset,
              end: range.endOffset,
            });
          }
        },
      });
    }
    return state.tooltip;
  }

  function shouldBeActive() {
    const settings = state.settings;
    if (!settings || settings.enabled === false) {
      return false;
    }
    if (state.inFrame && !settings.allowFrames) {
      return false;
    }
    const host = global.location && global.location.hostname
      ? global.location.hostname
      : '';
    if (settingsModule.hostDisabled(settings, host)) {
      return false;
    }
    return true;
  }

  function setActive(active) {
    if (active) {
      ensureTooltip();
      if (!state.dictionary) {
        state.dictionary = new dictionaryModule.Dictionary({
          baseUrl: '',
        });
      }
    } else {
      clearTimers();
      if (state.tooltip) {
        state.tooltip.destroy();
        state.tooltip = null;
      }
    }
    state.active = active;
  }

  function applySettings(settings) {
    state.settings = settings;
    if (state.tooltip) {
      state.tooltip.settings = settings;
    }
    setActive(shouldBeActive());
  }

  function bootstrap() {
    state.inFrame = false;
    try {
      state.inFrame = global.top !== global;
    } catch (error) {
      state.inFrame = true; // cross-origin parent: treat as a frame
    }

    settingsModule.load().then((settings) => {
      applySettings(settings);
      if (state.active && state.dictionary) {
        // Warm the packs up in the background so the first hover is instant.
        state.dictionary.preload(settings).catch(() => undefined);
      }
    }).catch(() => undefined);

    settingsModule.onChange((settings) => applySettings(settings));

    global.document.addEventListener('mousemove', handleMove, { passive: true, capture: true });
    global.document.addEventListener('mouseleave', handleLeave, { passive: true });
    global.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    global.document.addEventListener('keydown', handleKeyDown, true);

    compat.onMessage((message, sender, sendResponse) => {
      const type = message && message.type;
      if (type === 'decdi:lookup-selection') {
        lookupSelection().then((found) => {
          sendResponse({ found });
        });
        return true;
      }
      if (type === 'decdi:ping') {
        sendResponse({ active: state.active, inFrame: state.inFrame });
        return true;
      }
      return undefined;
    });

    // Expose a tiny hook for debugging in the page console.
    global.__decDi = {
      lookup: (word) => (state.dictionary
        ? state.dictionary.lookup(word, state.settings)
        : Promise.reject(new Error('dictionary not ready'))),
      state,
    };
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
