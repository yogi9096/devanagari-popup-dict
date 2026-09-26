/**
 * Extension settings: defaults, loading, saving and change notifications.
 *
 * Everything lives under a single `settings` key in storage.sync so the popup,
 * options page, background script and every content script see the same object.
 * storage.sync can be unavailable (private windows, profiles that are not signed
 * in) or hit quota limits, so writes transparently fall back to storage.local
 * and reads look in both areas.
 */
(function (global) {
  'use strict';

  const compat = (typeof module !== 'undefined' && module.exports)
    ? require('./compat')
    : (global.DecDi && global.DecDi.compat);

  const STORAGE_KEY = 'settings';
  const SETTINGS_VERSION = 1;

  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,

    // --- master switch ----------------------------------------------------
    enabled: true,

    // --- which languages to look up -------------------------------------
    languages: { hi: true, mr: true },
    primaryLanguage: 'hi',

    // --- how the popup is triggered --------------------------------------
    trigger: 'hover',            // 'hover' | 'modifier'
    modifier: 'Shift',           // used when trigger === 'modifier'
    hoverDelay: 180,             // ms before the popup appears
    hideDelay: 260,              // ms of grace before it disappears
    disabledHosts: [],           // per-site opt-out, e.g. ['mail.example.com']
    allowFrames: false,          // also look up inside <iframe>s

    // --- what the popup shows --------------------------------------------
    showRomanization: true,
    romanizationScheme: 'iso15919',  // 'iso15919' | 'simplified'
    showContext: false,
    showDerived: true,
    showSource: true,
    showTts: true,
    maxMatches: 3,
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

  /** Merge stored settings over the defaults, dropping anything unexpected. */
  function normalize(raw) {
    const settings = clone(DEFAULT_SETTINGS);
    if (!isPlainObject(raw)) {
      return settings;
    }
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      const value = raw[key];
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
    settings.languages = {
      hi: Boolean(settings.languages.hi),
      mr: Boolean(settings.languages.mr),
    };
    if (!settings.languages.hi && !settings.languages.mr) {
      settings.languages.hi = true;
    }
    if (!settings.languages[settings.primaryLanguage]) {
      settings.primaryLanguage = settings.languages.hi ? 'hi' : 'mr';
    }
    return settings;
  }

  /** Languages that are switched on, primary first. */
  function activeLanguages(settings) {
    const languages = ['hi', 'mr'].filter((code) => settings.languages[code]);
    const primary = settings.primaryLanguage;
    return languages.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));
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
    normalize,
    activeLanguages,
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
