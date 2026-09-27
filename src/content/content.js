/**
 * Content script: turns a selected (or hovered) English word into a Hindi
 * meaning popup.
 *
 * Design notes
 * ------------
 * * Selection is the primary trigger.  Selecting a word is an unambiguous
 *   request, and every competing gesture - hovering, Ctrl+A, dragging to copy -
 *   is filtered by src/common/selection.js before any data is fetched.
 * * One rAF-throttled `mousemove` listener drives the optional hover path.
 *   There is no per-word DOM instrumentation, so pages (and SPAs) are never
 *   modified, which keeps the extension safe on sites that rewrite their DOM
 *   constantly.
 * * Caret resolution uses `caretPositionFromPoint` (with the Chrome
 *   `caretRangeFromPoint` fallback) and then expands to a word with the
 *   script-aware helpers in src/common/devanagari.js, which handle both Latin
 *   and Devanagari runs.
 * * Lookups are debounced and results are discarded when the request is stale,
 *   so a fast sweep over a paragraph never flashes stale entries.
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
  const selectionModule = DecDi.selection;
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
    lastDecline: '',
    hoverTimer: 0,
    hideTimer: 0,
    warmTimer: 0,
    warmIdle: false,
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
    // The packs are keyed by English, so only a Latin word can match.  This
    // also stops a hover over the Devanagari answer inside our own popup.
    if (found.script !== 'latin') {
      return null;
    }
    // Reuse the selection rules so hover and selection agree about what counts
    // as a word: no bare "a", no URLs, no long identifiers.
    if (!selectionModule.evaluate(found.word, {
      maxWords: state.settings.maxSelectionWords,
      maxChars: state.settings.maxSelectionChars,
    }).ok) {
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

  /** True when a mousemove should be treated as a hover request. */
  function modifierHeld(event) {
    if (!state.settings || !settingsModule.onHover(state.settings)) {
      return false;
    }
    if (!settingsModule.needsModifier(state.settings)) {
      return true;
    }
    const flag = MODIFIER_FLAGS[state.settings.modifier];
    if (!flag) {
      return true;
    }
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
    // A forced dismissal - click away, Escape, the looked-up node being removed -
    // ends the popup for good, so it must not stay pinned: a hover popup that
    // inherited the pin would never close on its own.  An *unforced* hide is the
    // hover path, and refusing it is exactly what pinning is for.
    if (force) {
      state.tooltip.pinned = false;
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

  /**
   * Run the lookup and show the popup; stale results are dropped.
   *
   * `knownRect` is passed by the selection trigger, which has already measured
   * the selection.  A text node can be measured again from offsets, but a form
   * control cannot: a range cannot address the text inside an <input>, so the
   * rect has to come from the caller or there would be no popup at all.
   */
  async function showForEntry(entry, knownRect) {
    if (!state.dictionary || !state.tooltip || !state.settings) {
      return;
    }
    // A double-click to select a word releases the button twice, and a reader
    // who selects a word twice in a row is asking the same question.  Re-rendering
    // an unchanged popup flickers the reader's eyes for nothing.
    if (state.current && state.current.word === entry.word && state.tooltip.visible) {
      return;
    }
    const rect = knownRect || rectFor(entry);
    if (!rect) {
      return;
    }
    state.current = { node: entry.node, start: entry.start, end: entry.end, word: entry.word, rect };

    state.tooltip.showHighlight(rect);

    const requestId = (state.requestId += 1);
    let result;
    try {
      result = await state.dictionary.lookup(entry.word, state.settings);
    } catch (error) {
      // Swallowing this made a broken pack fetch look identical to "no result",
      // which is how a relative-URL 404 hid as a silent no-op.  Log it so a
      // failure in the Browser Console is visible.
      if (global.console && typeof global.console.error === 'function') {
        global.console.error('[devanagari-dict] lookup failed for "'
          + entry.word + '":', error);
      }
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

    state.tooltip.settings = state.settings;
    state.tooltip.render(result);
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
      // Hover is not the trigger here, so there is nothing to look up.  Only
      // tear down an unpinned popup: a selection popup is pinned, and must
      // survive the reader moving the mouse to read it.
      if (!state.tooltip || !state.tooltip.pinned) {
        scheduleHide(0);
      }
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
    state.current = {
      node: entry.node,
      start: entry.start,
      end: entry.end,
      word: entry.word,
      rect: rectFor(entry),
    };
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

  /**
   * The primary trigger, and the dismissal.
   *
   * One release of the mouse is either a request for a meaning or a click on the
   * page, and the two are told apart by the same selection rules the lookup
   * itself uses.  A release over a selected word opens the popup; a release
   * anywhere else - empty space, a link, another paragraph - dismisses what is
   * open, because that is what a reader clicking away expects to happen.
   *
   * This is deliberately handled on `mouseup` and not on `click`.  `click` fires
   * *after* the mouse-up that opened the popup, so a click-away listener would
   * close the popup the same gesture had just opened, and no selection-based
   * lookup would ever survive.
   *
   * The context menu and Alt+Shift+L call lookupSelection(true) directly and so
   * work even when the trigger is set to hover only.
   */
  function handleMouseUp(event) {
    if (!state.active || !state.settings) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    // The popup's own buttons (speak, copy, pin, a suggestion) are inside the
    // host, and they act on the popup rather than dismissing it.
    if (state.tooltip && state.tooltip.contains(event.target)) {
      return;
    }
    // Shift-click extends an existing selection, so releasing after one is
    // finishing a multi-step selection rather than asking about a word.  The
    // popup is left alone rather than dismissed, because a shift-click is a
    // continuation of the gesture that opened it.
    if (event.shiftKey) {
      return;
    }
    clearTimers();
    if (settingsModule.onSelection(state.settings) && resolveSelection()) {
      lookupSelection().catch(() => undefined);
      return;
    }
    hide(true);
  }

  function handleScroll() {
    if (!state.active || !state.tooltip || !state.tooltip.visible || !state.current) {
      return;
    }
    if (!state.current.node || !state.current.node.isConnected) {
      hide(true);
      return;
    }
    // A form field cannot be re-measured from offsets, so fall back to the rect
    // the selection was found at rather than dropping the popup on every scroll.
    const rect = rectFor(state.current)
      || (state.current.node.nodeType === 3 ? null : state.current.rect);
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
    }
  }

  /**
   * The voices the platform has installed.
   *
   * `getVoices()` is empty until enumeration finishes, and Firefox then fires
   * `voiceschanged`.  Reading it once on the click therefore misses the list on a
   * cold start - which is most first clicks after a page load - so the list is
   * cached and refreshed whenever the platform says it changed.
   */
  const voices = { list: [], wired: false };

  function refreshVoices() {
    const synth = global.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') {
      return voices.list;
    }
    const list = synth.getVoices() || [];
    if (list.length) {
      voices.list = list;
    } else if (!voices.wired && typeof synth.addEventListener === 'function') {
      voices.wired = true;
      synth.addEventListener('voiceschanged', refreshVoices);
    }
    return voices.list;
  }

  /** The best installed voice for `lang`: exact tag, then language, then none. */
  function pickVoice(lang) {
    const list = refreshVoices();
    if (!lang || !list.length) {
      return null;
    }
    const want = String(lang).toLowerCase();
    const prefix = want.slice(0, 2);
    return list.find((voice) => String(voice.lang || '').toLowerCase() === want)
      || list.find((voice) => String(voice.lang || '').toLowerCase().indexOf(prefix) === 0)
      || null;
  }

  /**
   * Resolve once the platform has enumerated its voices, or after `timeoutMs`.
   *
   * `getVoices()` is empty for a moment after a page loads, and the first click
   * on the speaker usually lands inside that window - so a lookup that would
   * have worked is declined for want of a list that was about to arrive.  The
   * wait is bounded because a platform with genuinely no voices never fires
   * `voiceschanged` at all.
   */
  function voicesReady(timeoutMs) {
    if (refreshVoices().length) {
      return Promise.resolve(true);
    }
    const synth = global.speechSynthesis;
    if (!synth || typeof synth.addEventListener !== 'function') {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready) => {
        if (settled) {
          return;
        }
        settled = true;
        synth.removeEventListener('voiceschanged', onChange);
        global.clearTimeout(timer);
        resolve(ready);
      };
      const onChange = () => finish(refreshVoices().length > 0);
      const timer = global.setTimeout(() => finish(false), timeoutMs || 400);
      synth.addEventListener('voiceschanged', onChange);
    });
  }

  /** A voice for `lang`, else any voice at all - for reading a transliteration. */
  function pickAnyVoice() {
    const list = refreshVoices();
    return pickVoice('en-IN') || pickVoice('en-GB') || pickVoice('en-US') || list[0] || null;
  }

  /**
   * Speak `text` in `lang` (a BCP-47 tag the tooltip chose, matching the
   * language the answer is written in).
   *
   * Three things are wrong with the obvious version of this, all of which present
   * as "the speaker does nothing":
   *
   *  - `speechSynthesis.cancel()` must not be called first.  Gecko dispatches a
   *    cancel asynchronously, so one issued in the same task as `speak()` lands
   *    *after* the new utterance and takes it down with it.  A one-word answer
   *    is short enough that letting an earlier one finish is cheaper.
   *  - The voice list is empty until the platform has enumerated it, and Firefox
   *    then fires `voiceschanged`; reading it once on the click misses it on a
   *    cold start, which is most first clicks.
   *  - Plenty of systems have no voice for the answer's language at all - a
   *    machine with only en-US and en-IN voices cannot pronounce Devanagari, and
   *    the Web Speech API says nothing when handed text no installed voice can
   *    render.  Rather than be silent, fall back to reading the *romanisation*,
   *    which is what the popup is already showing and which an English or Indian
   *    English voice can approximate.  Diacritics are stripped for this: an
   *    English voice asked for "sīkhnā" will not do better than one asked for
   *    "sikhnā".
   *
   * Every outcome is logged, because a reader who presses A and hears nothing
   * cannot otherwise tell "no Hindi voice on this system" from "broken".
   */
  async function speak(text, lang, romanText) {
    if (typeof global.speechSynthesis === 'undefined'
      || typeof global.SpeechSynthesisUtterance === 'undefined'
      || !text) {
      return false;
    }
    const warn = global.console && typeof global.console.warn === 'function'
      ? (message) => global.console.warn('[devanagari-dict] speech: ' + message)
      : () => {};

    // Ask the platform once more, briefly: a click in the first moments after a
    // page loads would otherwise be declined for a list that was about to arrive.
    await voicesReady(400);

    const wanted = lang || 'hi-IN';
    let voice = pickVoice(wanted);
    let spoken = text;

    if (!voice && romanText) {
      const substitute = pickAnyVoice();
      if (substitute) {
        voice = substitute;
        spoken = romanText;
        warn('no voice installed for ' + wanted + '; reading the romanisation "'
          + romanText + '" with ' + (substitute.lang || 'the default voice')
          + ' instead.  Install a ' + wanted.slice(0, 2) + ' speech pack for a real pronunciation.');
      }
    }
    if (!voice) {
      const list = refreshVoices();
      warn('no voice for ' + wanted + '; installed: '
        + (list.length
          ? list.map((entry) => entry.lang).filter(Boolean).join(', ')
          : '(the platform reports no voices at all)'));
    }

    const utterance = new global.SpeechSynthesisUtterance(spoken);
    utterance.lang = (voice && voice.lang) || wanted;
    if (voice) {
      utterance.voice = voice;
    }
    utterance.rate = 0.9;
    utterance.onerror = (event) => {
      warn((event && event.error ? event.error : 'failed') + ' for "' + spoken + '"');
    };
    try {
      global.speechSynthesis.speak(utterance);
    } catch (error) {
      warn(error);
      return false;
    }
    return true;
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
      const roman = DecDi.tooltip.pronunciationFor(match, state.settings.romanizationScheme);
      if (roman) {
        parts.push(roman);
      }
      if (match.sense) {
        parts.push('- ' + match.sense);
      }
      return parts.join(' ') + ' - ' + match.gloss;
    }).join('\n');
  }

  /**
   * Resolve the current selection into something the rules will accept.
   *
   * Handles both a normal document selection and a selection inside an
   * <input>/<textarea>, which is where "what does this word mean" is asked most
   * often - in a search box, a comment field, a form.
   */
  function readSelection() {
    const doc = global.document;
    const active = doc.activeElement;

    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      if (active.type === 'password' || active.readOnly || active.disabled) {
        return null;
      }
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number' || start === end) {
        return null;
      }
      const text = active.value.slice(start, end);
      let rect = null;
      try {
        // No caret geometry is exposed for form controls, so mirror a plausible
        // box just under the control; the tooltip clamps itself to the viewport.
        const box = active.getBoundingClientRect();
        rect = { left: box.left, right: box.left + 40, top: box.bottom, bottom: box.bottom };
      } catch (error) {
        rect = null;
      }
      return { text, rect, field: active };
    }

    const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
    return { text: String(selection), rect, field: null };
  }

  /**
   * Look up the current selection, if it is a lookup worth doing.
   *
   * This is the primary trigger: mouse-up over a selected word, the context
   * menu, and Alt+Shift+L all land here.  Everything src/common/selection.js
   * rejects is declined silently, which is what keeps a paragraph selection or a
   * Ctrl+A from opening a popup.
   *
   * @param {boolean} [explicit] true when the reader asked for this lookup
   *   directly (context menu, keyboard shortcut).  The trigger setting gates the
   *   *automatic* paths only: choosing "hover" must not disable the only gesture
   *   that works on a touch screen or under scripted scrolling.
   * @returns {Promise<boolean>} whether a popup was shown
   */
  /**
   * Decide whether the current selection is a lookup, and prepare it.
   *
   * Split out of lookupSelection() so handleMouseUp() can ask the same question
   * *synchronously*.  It has to: whether a mouse-up opens a popup or dismisses
   * the open one is the same decision, and answering it after awaiting the
   * dictionary would leave the popup on screen for the length of a lookup.
   *
   * @returns {?{entry: object, rect: ?object}} null when the gesture is declined,
   *   in which case `lastDecline` says why.
   */
  function resolveSelection() {
    const found = readSelection();
    if (!found) {
      return null;
    }
    const verdict = selectionModule.evaluate(found.text, {
      maxWords: state.settings.maxSelectionWords,
      maxChars: state.settings.maxSelectionChars,
    });
    if (!verdict.ok) {
      // Deliberately quiet: a reader who selected a paragraph did not ask for a
      // popup and does not need to be told why there wasn't one.
      state.lastDecline = verdict.reason;
      return null;
    }
    // Belt and braces for a short page that can be selected in its entirety.
    if (selectionModule.looksLikeSelectAll(found.text.length, documentTextLength())) {
      state.lastDecline = selectionModule.REASONS.SELECT_ALL;
      return null;
    }
    // Anchor the highlight on the word inside the selection, so the popup points
    // at the right place even when a phrase was selected.
    const anchor = anchorFor(found, verdict);
    if (!anchor) {
      return null;
    }
    return {
      entry: { node: anchor.node, word: verdict.query, start: anchor.start, end: anchor.end },
      rect: found.rect,
    };
  }

  async function lookupSelection(explicit) {
    if (!state.settings) {
      return false;
    }
    if (!explicit && !settingsModule.onSelection(state.settings)) {
      return false;
    }
    const resolved = resolveSelection();
    if (!resolved) {
      return false;
    }
    if (state.tooltip) {
      // A selection is deliberate, so keep it up until the reader dismisses it
      // or picks another word, rather than vanishing when the mouse moves away.
      state.tooltip.pinned = true;
    }
    await showForEntry(resolved.entry, resolved.rect);
    return true;
  }

  /**
   * Total text length of the document, used only for the select-all check.
   *
   * `document.body.textContent` walks and concatenates the entire page, so the
   * result is cached briefly rather than recomputed on every lookup.  The value
   * only feeds a heuristic, and a page's text rarely changes by a factor of two
   * within a few seconds of a selection.
   */
  const DOC_LENGTH_TTL = 10000;
  const docLength = { at: 0, value: 0 };

  function documentTextLength() {
    const now = global.Date.now();
    if (docLength.value && now - docLength.at < DOC_LENGTH_TTL) {
      return docLength.value;
    }
    const doc = global.document;
    if (!doc || !doc.body) {
      return 0;
    }
    docLength.at = now;
    docLength.value = (doc.body.textContent || '').length;
    return docLength.value;
  }

  /**
   * Work out which text node and offsets the popup should highlight: the first
   * occurrence of the looked-up word inside the selected range.
   */
  function anchorFor(found, verdict) {
    if (found.field) {
      // A form control has no addressable text node; there is nothing to
      // highlight, so fall back to the control itself and let the tooltip draw.
      return { node: found.field, start: 0, end: 0 };
    }
    const selection = global.document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed || !range.startContainer) {
      return null;
    }
    if (range.startContainer.nodeType !== 3) {
      return { node: range.startContainer, start: 0, end: 0 };
    }
    const data = range.startContainer.data || '';
    const word = verdict.words[0];
    const at = data.toLowerCase().indexOf(word.toLowerCase());
    if (at < 0) {
      return { node: range.startContainer, start: range.startOffset, end: range.endOffset };
    }
    return { node: range.startContainer, start: at, end: at + word.length };
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
    if (active === state.active) {
      return;
    }
    if (active) {
      ensureTooltip();
      if (!state.dictionary) {
        state.dictionary = new dictionaryModule.Dictionary({
          baseUrl: '',
        });
      }
      state.active = true;
      scheduleWarmUp();
      return;
    }
    clearTimers();
    cancelWarmUp();
    if (state.tooltip) {
      state.tooltip.destroy();
      state.tooltip = null;
    }
    state.active = false;
  }

  function applySettings(settings) {
    state.settings = settings;
    if (state.tooltip) {
      state.tooltip.settings = settings;
    }
    setActive(shouldBeActive());
  }

  /**
   * Load the packs once the page is idle, so the first lookup is instant.
   *
   * The terminology pack is ~16 MB, and reading it during page load competes
   * with the page the reader actually came for.  Doing it in the browser's idle
   * time means the dictionary is ready for a lookup a moment later without ever
   * delaying a page, and a reader who never looks anything up never pays for it
   * at all.  A lookup that arrives before this finishes simply awaits the same
   * in-flight promise (loadPack caches it), so there is no double fetch.
   */
  function scheduleWarmUp() {
    if (state.warmTimer || !state.active || !state.dictionary || !state.settings) {
      return;
    }
    if (typeof global.requestIdleCallback === 'function') {
      state.warmIdle = true;
      state.warmTimer = global.requestIdleCallback(() => {
        state.warmTimer = 0;
        warmUp();
      }, { timeout: 5000 });
      return;
    }
    state.warmIdle = false;
    state.warmTimer = global.setTimeout(() => {
      state.warmTimer = 0;
      warmUp();
    }, 1500);
  }

  /** Called when the extension is turned off: drop a pending warm-up. */
  function cancelWarmUp() {
    if (!state.warmTimer) {
      return;
    }
    if (state.warmIdle && typeof global.cancelIdleCallback === 'function') {
      global.cancelIdleCallback(state.warmTimer);
    } else {
      global.clearTimeout(state.warmTimer);
    }
    state.warmTimer = 0;
  }

  function warmUp() {
    if (!state.active || !state.dictionary || !state.settings) {
      return;
    }
    state.dictionary.preload(state.settings).catch(() => undefined);
  }

  function bootstrap() {
    state.inFrame = false;
    try {
      state.inFrame = global.top !== global;
    } catch (error) {
      state.inFrame = true; // cross-origin parent: treat as a frame
    }

    // Start the platform enumerating its voices now rather than on the first
    // click.  getVoices() is empty until that finishes, and a reader's first
    // press of the speaker is exactly when it is most likely to still be running.
    refreshVoices();

    settingsModule.load().then((settings) => {
      // setActive() schedules the idle warm-up when the dictionary is on.
      applySettings(settings);
    }).catch(() => undefined);

    settingsModule.onChange((settings) => applySettings(settings));

    global.document.addEventListener('mousemove', handleMove, { passive: true, capture: true });
    global.document.addEventListener('mouseleave', handleLeave, { passive: true });
    global.document.addEventListener('mouseup', handleMouseUp, { passive: true, capture: true });
    global.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    global.document.addEventListener('keydown', handleKeyDown, true);

    compat.onMessage((message, sender, sendResponse) => {
      const type = message && message.type;
      if (type === 'decdi:lookup-selection') {
        lookupSelection(true).then((found) => {
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

    /*
     * A tiny hook for debugging.  It is set on the content script's global, not
     * on the page's window: Firefox gives every extension a sandbox per document,
     * so `window.__decDi` is invisible from the page console and the hook has to
     * be read with this extension's content-script context selected in the
     * DevTools console (or the Browser Console).
     */
    global.__decDi = {
      lookup: (word) => (state.dictionary
        ? state.dictionary.lookup(word, state.settings)
        : Promise.reject(new Error('dictionary not ready'))),
      /**
       * Why the last selection did not open a popup, e.g.
       * "too many words selected".  A decline is silent by design, so this is
       * the only way to tell "declined on purpose" from "broken".
       */
      lastDecline: () => state.lastDecline,
      state,
    };
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
