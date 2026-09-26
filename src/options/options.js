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

  function bindCheckbox(id, get, set) {
    const node = byId(id);
    node.checked = get();
    node.addEventListener('change', () => save(set(node.checked)));
  }

  function bindNumber(id, get, set) {
    const node = byId(id);
    node.value = get();
    node.addEventListener('change', () => {
      const value = Number(node.value);
      if (Number.isFinite(value)) {
        save(set(value));
      }
    });
  }

  function bindSelect(id, get, set) {
    const node = byId(id);
    node.value = get();
    node.addEventListener('change', () => save(set(node.value)));
  }

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
    const counts = { hi: 0, mr: 0 };
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

      const meta = document.createElement('p');
      meta.className = 'pack-meta';
      meta.textContent = (pack.count || 0).toLocaleString('en-US')
        + ' entries · ' + (pack.sourceLang === 'hi' ? 'Hindi' : pack.sourceLang === 'mr' ? 'Marathi' : pack.sourceLang)
        + ' → ' + pack.targetLang + ' · ' + pack.license + '. ' + (pack.attribution || '');
      box.appendChild(meta);

      if (packEnabled(pack) && counts[pack.sourceLang] !== undefined) {
        counts[pack.sourceLang] += pack.count || 0;
      }
      host.appendChild(box);
    });
    const hi = byId('count-hi');
    const mr = byId('count-mr');
    if (hi) hi.textContent = counts.hi ? '(' + counts.hi.toLocaleString('en-US') + ' words)' : '';
    if (mr) mr.textContent = counts.mr ? '(' + counts.mr.toLocaleString('en-US') + ' words)' : '';
  }

  function render() {
    bindCheckbox('enabled', () => settings.enabled !== false, (v) => ({ enabled: v }));
    bindCheckbox('lang-hi', () => settings.languages.hi, (v) => ({
      languages: Object.assign({}, settings.languages, { hi: v }),
    }));
    bindCheckbox('lang-mr', () => settings.languages.mr, (v) => ({
      languages: Object.assign({}, settings.languages, { mr: v }),
    }));
    bindSelect('primary', () => settings.primaryLanguage, (v) => ({ primaryLanguage: v }));
    bindSelect('trigger', () => settings.trigger, (v) => ({ trigger: v }));
    bindSelect('modifier', () => settings.modifier, (v) => ({ modifier: v }));
    bindNumber('hover-delay', () => settings.hoverDelay, (v) => ({ hoverDelay: v }));
    bindNumber('hide-delay', () => settings.hideDelay, (v) => ({ hideDelay: v }));
    bindCheckbox('allow-frames', () => settings.allowFrames === true, (v) => ({ allowFrames: v }));
    bindCheckbox('show-romanization', () => settings.showRomanization !== false,
      (v) => ({ showRomanization: v }));
    bindSelect('scheme', () => settings.romanizationScheme, (v) => ({ romanizationScheme: v }));
    bindCheckbox('show-derived', () => settings.showDerived !== false, (v) => ({ showDerived: v }));
    bindCheckbox('show-context', () => settings.showContext === true, (v) => ({ showContext: v }));
    bindCheckbox('show-tts', () => settings.showTts !== false, (v) => ({ showTts: v }));
    bindCheckbox('show-source', () => settings.showSource !== false, (v) => ({ showSource: v }));
    bindNumber('max-matches', () => settings.maxMatches, (v) => ({ maxMatches: v }));
    bindSelect('theme', () => settings.theme, (v) => ({ theme: v }));
    bindNumber('font-size', () => settings.fontSize, (v) => ({ fontSize: v }));
    const hosts = byId('disabled-hosts');
    if (document.activeElement !== hosts) {
      hosts.value = settings.disabledHosts.join('\n');
    }
    const modifierRow = byId('modifier-row');
    if (modifierRow) {
      modifierRow.style.display = settings.trigger === 'modifier' ? '' : 'none';
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
    wireStatic();
  }

  main();
})();
