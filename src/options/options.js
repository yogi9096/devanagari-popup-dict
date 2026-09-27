/**
 * Settings page: form binding, dictionary-pack listing and import/export.
 */
(function () {
  'use strict';

  const compat = window.DecDi.compat;
  const settingsModule = window.DecDi.settings;

  let settings = null;
  let catalog = null;
  const byId = (id) => document.getElementById(id);
  const saveState = byId('save-state');

  function flag(text) {
    saveState.textContent = text;
    window.clearTimeout(flag.timer);
    flag.timer = window.setTimeout(() => { saveState.textContent = ''; }, 4000);
  }

  const LANGUAGES = { hi: 'Hindi', en: 'English' };

  /*
   * Binding is separated from filling in values.  render() runs after every
   * save, so binding inside it would attach a fresh listener on every change
   * and each toggle would then be handled N times over.
   */
  function bindOnce(id, apply, assign) {
    const node = byId(id);
    if (!node || node.dataset.bound === '1') {
      return node;
    }
    node.dataset.bound = '1';
    node.addEventListener('change', () => {
      let value;
      if (node.type === 'checkbox') {
        value = node.checked;
      } else if (node.type === 'number') {
        value = Number(node.value);
        if (!Number.isFinite(value)) {
          return;
        }
      } else {
        value = node.value;
      }
      save(assign(value));
    });
    apply(node);
    return node;
  }

  const fill = {
    check(id, value) {
      const node = byId(id);
      if (node) {
        node.checked = Boolean(value);
      }
    },
    value(id, value) {
      const node = byId(id);
      if (node) {
        node.value = value;
      }
    },
  };

  async function save(patch) {
    settings = await settingsModule.save(Object.assign({}, settings, patch));
    render();
    flag('Saved.');
  }

  function packEnabled(pack) {
    const explicit = settings.packs[pack.id];
    if (explicit === undefined || explicit === null) {
      return Boolean(settings.useCatalogDefaults && pack.default);
    }
    return Boolean(explicit);
  }

  function renderPacks() {
    const host = byId('packs');
    host.textContent = '';
    if (!catalog || !catalog.packs || !catalog.packs.length) {
      host.textContent = 'No packs found. Build them with: python tools/build_dict.py --defaults';
      return;
    }
    // Counted by the language the answer is written in, so the number beside
    // the pack list is the Hindi coverage the reader actually gets.
    let words = 0;
    catalog.packs.forEach((pack) => {
      const box = document.createElement('div');
      box.className = 'pack';

      const head = document.createElement('label');
      head.className = 'pack-head';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = packEnabled(pack);
      toggle.setAttribute('aria-label', 'Enable ' + pack.name);
      toggle.addEventListener('change', () => {
        const packs = Object.assign({}, settings.packs, { [pack.id]: toggle.checked });
        save({ packs });
      });
      head.appendChild(toggle);
      const name = document.createElement('span');
      name.className = 'pack-name';
      name.textContent = pack.name;
      head.appendChild(name);
      box.appendChild(head);

      const from = LANGUAGES[pack.sourceLang] || pack.sourceLang;
      const to = LANGUAGES[pack.targetLang] || pack.targetLang;
      const meta = document.createElement('p');
      meta.className = 'pack-meta';
      meta.textContent = (pack.count || 0).toLocaleString('en-US')
        + ' words · ' + from + ' → ' + to + ' · ' + pack.license
        + (pack.attribution ? '. ' + pack.attribution : '');
      box.appendChild(meta);

      if (packEnabled(pack) && pack.targetLang === 'hi') {
        words += pack.count || 0;
      }
      host.appendChild(box);
    });
    const total = byId('pack-total');
    if (total) {
      total.textContent = words
        ? words.toLocaleString('en-US') + ' Hindi meanings loaded'
        : 'No Hindi pack enabled';
    }
  }

  /** Attach the listeners.  Runs once; safe to call again. */
  function bind() {
    bindOnce('enabled', (n) => { n.checked = settings.enabled !== false; },
      (v) => ({ enabled: v }));
    bindOnce('trigger', () => { fill.value('trigger', settings.trigger); },
      (v) => ({ trigger: v }));
    bindOnce('modifier', () => { fill.value('modifier', settings.modifier); },
      (v) => ({ modifier: v }));
    bindOnce('hover-delay', () => { fill.value('hover-delay', settings.hoverDelay); },
      (v) => ({ hoverDelay: v }));
    bindOnce('hide-delay', () => { fill.value('hide-delay', settings.hideDelay); },
      (v) => ({ hideDelay: v }));
    bindOnce('max-selection-words', () => { fill.value('max-selection-words', settings.maxSelectionWords); },
      (v) => ({ maxSelectionWords: v }));
    bindOnce('max-selection-chars', () => { fill.value('max-selection-chars', settings.maxSelectionChars); },
      (v) => ({ maxSelectionChars: v }));
    bindOnce('allow-frames', () => { fill.check('allow-frames', settings.allowFrames === true); },
      (v) => ({ allowFrames: v }));
    bindOnce('show-romanization', () => { fill.check('show-romanization', settings.showRomanization !== false); },
      (v) => ({ showRomanization: v }));
    bindOnce('scheme', () => { fill.value('scheme', settings.romanizationScheme); },
      (v) => ({ romanizationScheme: v }));
    bindOnce('show-derived', () => { fill.check('show-derived', settings.showDerived !== false); },
      (v) => ({ showDerived: v }));
    bindOnce('show-tts', () => { fill.check('show-tts', settings.showTts !== false); },
      (v) => ({ showTts: v }));
    bindOnce('show-source', () => { fill.check('show-source', settings.showSource !== false); },
      (v) => ({ showSource: v }));
    bindOnce('max-matches', () => { fill.value('max-matches', settings.maxMatches); },
      (v) => ({ maxMatches: v }));
    bindOnce('theme', () => { fill.value('theme', settings.theme); },
      (v) => ({ theme: v }));
    bindOnce('font-size', () => { fill.value('font-size', settings.fontSize); },
      (v) => ({ fontSize: v }));
  }

  /** Reflect the saved settings in the form.  Runs on every save. */
  function render() {
    fill.check('enabled', settings.enabled !== false);
    fill.value('trigger', settings.trigger);
    fill.value('modifier', settings.modifier);
    fill.value('hover-delay', settings.hoverDelay);
    fill.value('hide-delay', settings.hideDelay);
    fill.value('max-selection-words', settings.maxSelectionWords);
    fill.value('max-selection-chars', settings.maxSelectionChars);
    fill.check('allow-frames', settings.allowFrames === true);
    fill.check('show-romanization', settings.showRomanization !== false);
    fill.value('scheme', settings.romanizationScheme);
    fill.check('show-derived', settings.showDerived !== false);
    fill.check('show-tts', settings.showTts !== false);
    fill.check('show-source', settings.showSource !== false);
    fill.value('max-matches', settings.maxMatches);
    fill.value('theme', settings.theme);
    fill.value('font-size', settings.fontSize);

    const hosts = byId('disabled-hosts');
    if (document.activeElement !== hosts) {
      hosts.value = settings.disabledHosts.join('\n');
    }
    // The modifier only means something for the hover triggers, so it is hidden
    // rather than left on screen as a setting that would do nothing.
    const modifierRow = byId('modifier-row');
    if (modifierRow) {
      modifierRow.style.display = settings.trigger === 'selection' ? 'none' : '';
    }
    renderPacks();
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wireStatic() {
    const hosts = byId('disabled-hosts');
    hosts.addEventListener('change', () => {
      const list = hosts.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      save({ disabledHosts: list });
    });

    byId('export').addEventListener('click', () => {
      download('devanagari-dict-settings.json', JSON.stringify(settings, null, 2));
      flag('Exported.');
    });

    byId('import-btn').addEventListener('click', () => byId('import-file').click());
    byId('import-file').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          save(settingsModule.normalize(parsed)).then(() => flag('Imported.'));
        } catch (error) {
          flag('That file is not valid settings JSON.');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    });

    byId('reset').addEventListener('click', () => {
      save(settingsModule.normalize(settingsModule.DEFAULT_SETTINGS)).then(() => flag('Reset.'));
    });

    if (window.location.hash === '#sources') {
      window.setTimeout(() => {
        const target = byId('h-sources');
        if (target) target.scrollIntoView();
      }, 300);
    }
  }

  async function main() {
    settings = await settingsModule.load();
    try {
      catalog = await compat.fetchJson(compat.getUrl('dict/index.json'));
    } catch (error) {
      catalog = null;
    }
    render();
    bind();
    wireStatic();
  }

  main();
})();
