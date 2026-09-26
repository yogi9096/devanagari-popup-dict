/**
 * Background script.
 *
 * Kept deliberately small: it seeds default settings, owns the context menu and
 * keyboard commands, and mirrors the enabled/disabled state onto the toolbar
 * badge.  All dictionary work happens in the content scripts.
 */
(function (global) {
  'use strict';

  const DecDi = global.DecDi || {};
  const compat = DecDi.compat;
  const settingsModule = DecDi.settings;

  if (!compat || !compat.available || !settingsModule) {
    return;
  }

  const MENU_ROOT = 'decdi-root';
  const MENU_LOOKUP = 'decdi-lookup-selection';
  const MENU_TOGGLE_SITE = 'decdi-toggle-site';
  const MENU_OPTIONS = 'decdi-options';

  function menuApi() {
    const api = compat.api;
    return api.menus || api.contextMenus || null;
  }

  function createMenus() {
    const menus = menuApi();
    if (!menus || typeof menus.create !== 'function') {
      return;
    }
    menus.removeAll(() => {
      menus.create({
        id: MENU_LOOKUP,
        title: 'Look up \u201C%s\u201D',
        contexts: ['selection'],
      });
      menus.create({
        id: MENU_TOGGLE_SITE,
        title: 'Turn off on this site',
        contexts: ['page', 'frame'],
      });
      menus.create({
        id: MENU_OPTIONS,
        title: 'Devanagari dictionary options\u2026',
        contexts: ['page', 'frame'],
      });
    });
  }

  async function seedSettings() {
    const stored = await compat.storageGet('sync', settingsModule.STORAGE_KEY);
    const local = stored && stored[settingsModule.STORAGE_KEY]
      ? stored
      : await compat.storageGet('local', settingsModule.STORAGE_KEY);
    if (local && local[settingsModule.STORAGE_KEY]) {
      return;
    }
    await settingsModule.save(settingsModule.DEFAULT_SETTINGS);
  }

  async function hostnameOfTab(tab) {
    if (!tab || !tab.url) {
      return '';
    }
    try {
      return new URL(tab.url).hostname;
    } catch (error) {
      return '';
    }
  }

  async function updateBadge(tab) {
    const api = compat.api;
    if (!api || !api.action || !api.action.setBadgeText) {
      return;
    }
    if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
      await compat.call(api.action, 'setBadgeText', [{ text: '', tabId: tab ? tab.id : undefined }]);
      return;
    }
    const settings = await settingsModule.load();
    const host = await hostnameOfTab(tab);
    const disabled = settingsModule.hostDisabled(settings, host);
    await compat.call(api.action, 'setBadgeText', [{ text: disabled ? 'off' : '', tabId: tab.id }]);
    await compat.call(api.action, 'setBadgeBackgroundColor', [{ color: '#9ca3af', tabId: tab.id }]);
  }

  async function activeTab() {
    const api = compat.api;
    if (!api || !api.tabs) {
      return null;
    }
    const tabs = await compat.call(api.tabs, 'query', [{ active: true, currentWindow: true }]);
    return tabs && tabs.length ? tabs[0] : null;
  }

  async function toggleSite(tab) {
    const target = tab || await activeTab();
    const host = await hostnameOfTab(target);
    if (!host) {
      return;
    }
    const settings = await settingsModule.load();
    const disabled = settingsModule.hostDisabled(settings, host);
    settings.disabledHosts = disabled
      ? settings.disabledHosts.filter((entry) => String(entry).toLowerCase().replace(/^\*\./, '') !== host)
      : settings.disabledHosts.concat([host]);
    await settingsModule.save(settings);
    await updateBadge(target || { id: target && target.id, url: target && target.url });
  }

  function openOptions() {
    const api = compat.api;
    if (api && api.runtime && typeof api.runtime.openOptionsPage === 'function') {
      api.runtime.openOptionsPage();
    }
  }

  function wireEvents() {
    const api = compat.api;

    if (api.runtime.onInstalled) {
      api.runtime.onInstalled.addListener(() => {
        seedSettings().then(createMenus).catch(() => undefined);
      });
    }
    // Menus are recreated on every start so a stale definition cannot linger.
    createMenus();

    const menus = menuApi();
    if (menus && menus.onClicked) {
      menus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === MENU_LOOKUP) {
          if (tab && tab.id !== undefined) {
            compat.call(api.tabs, 'sendMessage', [tab.id, { type: 'decdi:lookup-selection' }]);
          }
          return;
        }
        if (info.menuItemId === MENU_TOGGLE_SITE) {
          toggleSite(tab);
          return;
        }
        if (info.menuItemId === MENU_OPTIONS) {
          openOptions();
        }
      });
    }

    if (api.commands && api.commands.onCommand) {
      api.commands.onCommand.addListener((command) => {
        if (command === 'toggle-site') {
          toggleSite();
        } else if (command === 'lookup-selection') {
          activeTab().then((tab) => {
            if (tab && tab.id !== undefined) {
              compat.call(api.tabs, 'sendMessage', [tab.id, { type: 'decdi:lookup-selection' }]);
            }
          });
        }
      });
    }

    if (api.tabs) {
      const refresh = (tab) => {
        updateBadge(tab).catch(() => undefined);
      };
      if (api.tabs.onActivated) {
        api.tabs.onActivated.addListener((info) => {
          compat.call(api.tabs, 'get', [info.tabId]).then(refresh).catch(() => undefined);
        });
      }
      if (api.tabs.onUpdated) {
        api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
          if (changeInfo.status === 'complete' || changeInfo.url) {
            refresh(tab);
          }
        });
      }
    }

    if (api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener(() => {
        activeTab().then(refresh2 => updateBadge(refresh2)).catch(() => undefined);
      });
    }

    compat.onMessage((message, sender, sendResponse) => {
      if (message && message.type === 'decdi:toggle-site') {
        toggleSite(sender && sender.tab).then(() => sendResponse({ ok: true })).catch(() => {
          sendResponse({ ok: false });
        });
        return true;
      }
      if (message && message.type === 'decdi:open-options') {
        openOptions();
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    });
  }

  wireEvents();
})(typeof globalThis !== 'undefined' ? globalThis : this);
