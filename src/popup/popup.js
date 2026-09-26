/**
 * Toolbar popup: the quick on/off controls, language switches and a summary of
 * the installed dictionary packs.
 */
(function () {
  'use strict';

  const compat = window.DecDi.compat;
  const settingsModule = window.DecDi.settings;

  const ui = {
    enabled: document.getElementById('enabled'),
    status: document.getElementById('status-line'),
    siteEnabled: document.getElementById('site-enabled'),
    siteHost: document.getElementById('site-host'),
    langHi: document.getElementById('lang-hi'),
    langMr: document.getElementById('lang-mr'),
    countHi: document.getElementById('count-hi'),
    countMr: document.getElementById('count-mr'),
    packHint: document.getElementById('pack-hint'),
    options: document.getElementById('open-options'),
    catalog: document.getElementById('open-catalog'),
    triggerButtons: Array.from(document.querySelectorAll('[data-trigger]')),
  };

  let settings = null;
  let hostname = '';
  let catalog = null;

  function formatCount(value) {
    return value.toLocaleString('en-US') + ' entries';
  }

  function render() {
    ui.enabled.checked = settings.enabled !== false;
    ui.status.textContent = settings.enabled !== false ? 'on all enabled sites' : 'turned off';
    const disabled = settingsModule.hostDisabled(settings, hostname);
    ui.siteEnabled.checked = !disabled;
    ui.siteHost.textContent = hostname || 'this site';
    ui.langHi.checked = settings.languages.hi;
    ui.langMr.checked = settings.languages.mr;

    ui.triggerButtons.forEach((button) => {
      button.setAttribute('aria-pressed',
        button.dataset.trigger === settings.trigger ? 'true' : 'false');
    });

    if (catalog) {
      let hi = 0;
      let mr = 0;
      const enabled = [];
      catalog.packs.forEach((pack) => {
        const explicit = settings.packs[pack.id];
        const on = (explicit === undefined || explicit === null)
          ? Boolean(settings.useCatalogDefaults && pack.default)
          : Boolean(explicit);
        if (!on) {
          return;
        }
        if (pack.sourceLang === 'hi') {
          hi += pack.count;
        } else if (pack.sourceLang === 'mr') {
          mr += pack.count;
        }
        enabled.push(pack.name);
      });
      ui.countHi.textContent = hi ? '(' + formatCount(hi) + ')' : '(no pack enabled)';
      ui.countMr.textContent = mr ? '(' + formatCount(mr) + ')' : '(no pack enabled)';
      ui.packHint.textContent = enabled.length
        ? 'Using: ' + enabled.join(', ')
        : 'No dictionary packs enabled — open All settings to choose.';
    }
  }

  async function save(patch) {
    settings = await settingsModule.save(Object.assign({}, settings, patch));
    render();
  }

  async function currentHostname() {
    const api = compat.api;
    if (!api || !api.tabs) {
      return '';
    }
    const tabs = await compat.call(api.tabs, 'query', [{ active: true, currentWindow: true }]);
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      return '';
    }
    try {
      const url = new URL(tab.url);
      return /^https?:$/.test(url.protocol) || url.protocol === 'file:' ? url.hostname : '';
    } catch (error) {
      return '';
    }
  }

  function wire() {
    ui.enabled.addEventListener('change', () => {
      save({ enabled: ui.enabled.checked });
    });

    ui.siteEnabled.addEventListener('change', () => {
      const hosts = settings.disabledHosts.slice();
      const index = hosts.findIndex((entry) => String(entry).toLowerCase().replace(/^\*\./, '') === hostname);
      if (ui.siteEnabled.checked && index >= 0) {
        hosts.splice(index, 1);
      } else if (!ui.siteEnabled.checked && index < 0) {
        hosts.push(hostname);
      }
      save({ disabledHosts: hosts });
    });

    ui.langHi.addEventListener('change', () => {
      save({ languages: Object.assign({}, settings.languages, { hi: ui.langHi.checked }) });
    });
    ui.langMr.addEventListener('change', () => {
      save({ languages: Object.assign({}, settings.languages, { mr: ui.langMr.checked }) });
    });

    ui.triggerButtons.forEach((button) => {
      button.addEventListener('click', () => {
        save({ trigger: button.dataset.trigger });
      });
    });

    ui.options.addEventListener('click', () => {
      if (compat.api && compat.api.runtime && compat.api.runtime.openOptionsPage) {
        compat.api.runtime.openOptionsPage();
        window.close();
      }
    });

    ui.catalog.addEventListener('click', () => {
      const url = compat.getUrl('options/options.html') + '#sources';
      if (compat.api && compat.api.tabs && compat.api.tabs.create) {
        compat.api.tabs.create({ url });
        window.close();
      }
    });
  }

  async function main() {
    settings = await settingsModule.load();
    hostname = await currentHostname();
    render();
    wire();
    try {
      catalog = await compat.fetchJson(compat.getUrl('dict/index.json'));
    } catch (error) {
      ui.packHint.textContent = 'Dictionary packs are missing — run the build tools.';
      return;
    }
    render();
  }

  main();
})();
