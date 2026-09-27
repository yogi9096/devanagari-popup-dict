/**
 * Toolbar popup: the quick on/off controls, the trigger mode, and a summary of
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
    options: document.getElementById('open-options'),
    catalog: document.getElementById('open-catalog'),
    triggerButtons: Array.from(document.querySelectorAll('[data-trigger]')),
  };

  let settings = null;
  let hostname = '';

  function render() {
    ui.enabled.checked = settings.enabled !== false;
    ui.status.textContent = settings.enabled !== false ? 'on all enabled sites' : 'turned off';
    const disabled = settingsModule.hostDisabled(settings, hostname);
    ui.siteEnabled.checked = !disabled;
    ui.siteHost.textContent = hostname || 'this site';

    ui.triggerButtons.forEach((button) => {
      button.setAttribute('aria-pressed',
        button.dataset.trigger === settings.trigger ? 'true' : 'false');
    });
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
  }

  main();
})();
