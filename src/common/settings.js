/**
 * Extension settings: defaults, loading, saving and change notifications.
 *
 * Everything lives under a single `settings` key in storage.sync so the popup,
 * options page, background script and every content script see the same object.
 * storage.sync can be unavailable (private windows, profiles that are not signed
 * in) or hit quota limits, so writes transparently fall back to storage.local
 * and reads look in both areas.
 *
 * Scope: this is an English -> Hindi dictionary and nothing else.  There is no
 * language picker, because a picker is a decision the reader has to make on
 * every popup and the data is not good enough for Marathi to be worth offering
 * (1,158 entries against Hindi at 147,342).  `languages` is kept in the stored
 * shape as a one-key map so the pack pipeline stays generic, and so a Marathi
 * pack can be switched back on later without a storage migration.
 *
 * Trigger: one setting, `trigger`, with three values.  `selection` is the
 * default because selecting a word is an unambiguous request, whereas hovering
 * fires constantly while the pointer travels across a paragraph.
 */
(function (global) {
  'use strict';

  const compat = (typeof module !== 'undefined' && module.exports)
    ? require('./compat')
    : (global.DecDi && global.DecDi.compat);

  const STORAGE_KEY = 'settings';
  const SETTINGS_VERSION = 3;

  const LANGUAGES = ['hi'];
  const LANGUAGE_NAMES = { hi: 'Hindi' };
  const TRIGGERS = ['selection', 'hover', 'both'];
  const MODIFIERS = ['none', 'Shift', 'Control', 'Alt', 'Meta'];

  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,

    // --- master switch ----------------------------------------------------
    enabled: true,

    // --- what the answer is in --------------------------------------------
    languages: { hi: true },

    // --- how the popup is triggered --------------------------------------
    // 'selection' = select and release;  'hover' = point at a word;
    // 'both' = either.  'modifier' constrains the hover half only.
    trigger: 'selection',
    modifier: 'Shift',
    hoverDelay: 220,             // ms before the popup appears on hover
    hideDelay: 260,              // ms of grace before it disappears
    disabledHosts: [],           // per-site opt-out, e.g. ['mail.example.com']
    // Also look up inside <iframe>s, so a word inside an embedded video,
    // comment thread or search widget answers too.
    //
    // On by default, because the cost that argued against it does not exist: the
    // content script is declared `all_frames: true`, so a frame always receives
    // the code, but `shouldBeActive()` keeps `setActive(false)` for a frame, and
    // that never constructs a Dictionary and never calls the warm-up.  A frame
    // that is switched off fetches no pack at all - it costs the ten small
    // scripts and five passive listeners, and nothing more.  What switching it
    // off actually costs is the reader: on a page whose words live inside a
    // frame, selection is a document-local event, so the top document cannot see
    // it and no popup appears at all until this is turned on.
    allowFrames: true,

    // --- what counts as worth looking up ----------------------------------
    // See src/common/selection.js: the guards that keep a paragraph, a URL or a
    // Ctrl+A page selection from opening a popup that cannot be answered.
    maxSelectionWords: 4,
    maxSelectionChars: 60,

    // --- what the popup shows --------------------------------------------
    showRomanization: true,
    romanizationScheme: 'iso15919',  // 'iso15919' | 'simplified'
    showDerived: true,
    showSource: true,
    showTts: true,
    maxMatches: 4,
    theme: 'auto',               // 'auto' | 'light' | 'dark'
    fontSize: 14,

    // --- dictionary packs -------------------------------------------------
    // pack id -> enabled.  A pack that is absent uses the catalogue default.
    packs: {},
    useCatalogDefaults: true,
  });

  const AREAS = ['sync', 'local'];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  /**
   * Older versions stored `direction`, `primaryLanguage`, `lookupOnSelect`,
   * `showContext` and `showSense`.  They are dropped rather than carried
   * forward: the first two are meaningless now that there is one language, and
   * the last two are gone features.  `trigger: 'modifier'` becomes
   * `trigger: 'hover'` with the modifier kept, which is what it actually meant.
   */
  function migrate(raw) {
    if (!isPlainObject(raw)) {
      return raw;
    }
    const next = Object.assign({}, raw);
    // Read the legacy fields before dropping them.
    const wasModifier = next.trigger === 'modifier';
    const hadLookupOnSelect = Object.prototype.hasOwnProperty.call(next, 'lookupOnSelect');
    const lookupOnSelect = next.lookupOnSelect;

    if (wasModifier) {
      // 'modifier' meant "hover, but hold a key": that is now trigger 'hover'
      // with the modifier kept.
      next.trigger = 'hover';
      next.modifier = next.modifier || 'Shift';
    } else if (hadLookupOnSelect) {
      // 0.2.x had a hover trigger plus a separate lookupOnSelect flag.  Fold the
      // pair into the single trigger setting.
      next.trigger = lookupOnSelect === false ? 'hover' : 'both';
    }

    delete next.direction;
    delete next.primaryLanguage;
    delete next.lookupOnSelect;
    delete next.showContext;
    delete next.showSense;
    if (isPlainObject(next.languages)) {
      // Marathi is not offered any more, so a stored `mr: true` must not
      // resurrect a language the UI has no way to turn off again.
      next.languages = { hi: true };
    }
    return next;
  }

  /** Merge stored settings over the defaults, dropping anything unexpected. */
  function normalize(raw) {
    const settings = clone(DEFAULT_SETTINGS);
    if (!isPlainObject(raw)) {
      return settings;
    }
    const source = migrate(raw);
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      const value = source[key];
      if (value === undefined || value === null) {
        return;
      }
      if (isPlainObject(DEFAULT_SETTINGS[key])) {
        if (isPlainObject(value)) {
          settings[key] = Object.assign({}, DEFAULT_SETTINGS[key], value);
        }
        return;
      }
      if (Array.isArray(DEFAULT_SETTINGS[key])) {
        if (Array.isArray(value)) {
          settings[key] = value.slice();
        }
        return;
      }
      if (typeof value === typeof DEFAULT_SETTINGS[key]) {
        settings[key] = value;
      }
    });
    settings.version = SETTINGS_VERSION;

    // Guard rails so a bad import cannot make the UI unusable.
    settings.hoverDelay = clamp(settings.hoverDelay, 0, 5000);
    settings.hideDelay = clamp(settings.hideDelay, 0, 5000);
    settings.maxMatches = clamp(settings.maxMatches, 1, 10);
    settings.fontSize = clamp(settings.fontSize, 10, 28);
    // The upper bounds are the hard caps in src/common/selection.js.  Clamping to
    // the same numbers keeps the stored value and the effective value the same
    // thing, so a setting never appears to do nothing.
    settings.maxSelectionWords = clamp(settings.maxSelectionWords, 1, 10);
    settings.maxSelectionChars = clamp(settings.maxSelectionChars, 10, 200);
    if (TRIGGERS.indexOf(settings.trigger) < 0) {
      settings.trigger = DEFAULT_SETTINGS.trigger;
    }
    if (MODIFIERS.indexOf(settings.modifier) < 0) {
      settings.modifier = DEFAULT_SETTINGS.modifier;
    }
    settings.languages = { hi: true };
    return settings;
  }

  /** The single language a lookup answers in. */
  function answerLanguage() {
    return 'hi';
  }

  /** Languages that are switched on.  There is only one. */
  function activeLanguages() {
    return LANGUAGES.slice();
  }

  /** True when the given trigger mode should act on a mouse selection. */
  function onSelection(settings) {
    return settings.trigger === 'selection' || settings.trigger === 'both';
  }

  /** True when the given trigger mode should act on hover. */
  function onHover(settings) {
    return settings.trigger === 'hover' || settings.trigger === 'both';
  }

  /** True when hover additionally needs the modifier key held down. */
  function needsModifier(settings) {
    return settings.trigger !== 'selection' && settings.modifier !== 'none';
  }

  function hostDisabled(settings, hostname) {
    if (!hostname) {
      return false;
    }
    const host = hostname.toLowerCase();
    return settings.disabledHosts.some((entry) => {
      const pattern = String(entry).trim().toLowerCase().replace(/^\*\./, '');
      if (!pattern) {
        return false;
      }
      return host === pattern || host.endsWith('.' + pattern);
    });
  }

  async function load() {
    for (const area of AREAS) {
      const stored = await compat.storageGet(area, STORAGE_KEY);
      if (stored && stored[STORAGE_KEY]) {
        return normalize(stored[STORAGE_KEY]);
      }
    }
    return clone(DEFAULT_SETTINGS);
  }

  async function save(settings) {
    const payload = normalize(settings);
    const record = {};
    record[STORAGE_KEY] = payload;
    for (const area of AREAS) {
      try {
        await compat.storageSet(area, record);
        return payload;
      } catch (error) {
        /* try the next storage area */
      }
    }
    return payload;
  }

  /** Subscribe to settings changes; returns an unsubscribe function. */
  function onChange(callback) {
    const api = compat && compat.api;
    if (!api || !api.storage || !api.storage.onChanged) {
      return () => {};
    }
    const listener = (changes) => {
      if (!changes || !changes[STORAGE_KEY]) {
        return;
      }
      const next = changes[STORAGE_KEY].newValue;
      callback(next ? normalize(next) : clone(DEFAULT_SETTINGS));
    };
    api.storage.onChanged.addListener(listener);
    return () => api.storage.onChanged.removeListener(listener);
  }

  const namespace = {
    STORAGE_KEY,
    SETTINGS_VERSION,
    DEFAULT_SETTINGS,
    LANGUAGES,
    LANGUAGE_NAMES,
    TRIGGERS,
    MODIFIERS,
    normalize,
    migrate,
    activeLanguages,
    answerLanguage,
    onSelection,
    onHover,
    needsModifier,
    hostDisabled,
    load,
    save,
    onChange,
    clamp,
    clone,
  };

  global.DecDi = Object.assign(global.DecDi || {}, { settings: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
