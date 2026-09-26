/**
 * Cross-browser WebExtension API access.
 *
 * Firefox exposes the promise-based `browser` namespace, Chrome exposes
 * `chrome` (promise-based for most APIs since MV3, callback-based for a few).
 * Everything in this extension talks to the browser through `DecDi.api`, and
 * the small helpers below normalise the differences we actually hit.
 *
 * The module is written so it can also be `require()`d from Node for tests:
 * when no browser is present `api` is null and the helpers degrade gracefully.
 */
(function (global) {
  'use strict';

  const extensionApi = (typeof browser !== 'undefined' && browser && browser.runtime)
    ? browser
    : ((typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome : null);

  /** Promise-first wrapper: works with both promise and callback APIs. */
  function call(target, method, args) {
    if (!target || typeof target[method] !== 'function') {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      let result;
      try {
        result = target[method](...args, (value) => {
          const error = extensionApi && extensionApi.runtime
            ? extensionApi.runtime.lastError
            : null;
          if (error) {
            fail(new Error(error.message || String(error)));
          } else {
            done(value);
          }
        });
      } catch (error) {
        fail(error);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(done, fail);
      } else if (typeof target[method].length === args.length && result !== undefined) {
        // Callback-style API that returned synchronously without a callback slot.
        done(result);
      }
    });
  }

  const api = extensionApi;

  function runtime() {
    return api ? api.runtime : null;
  }

  function getUrl(path) {
    if (runtime() && typeof runtime().getURL === 'function') {
      return runtime().getURL(path);
    }
    return path;
  }

  function sendMessage(message) {
    if (!runtime() || typeof runtime().sendMessage !== 'function') {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(runtime().sendMessage(message)).catch(() => undefined);
  }

  function onMessage(handler) {
    if (runtime() && runtime().onMessage && typeof runtime().onMessage.addListener === 'function') {
      runtime().onMessage.addListener(handler);
    }
  }

  /** Storage area access that works whether or not `sync` exists. */
  function area(name) {
    if (!api || !api.storage) {
      return null;
    }
    return api.storage[name] || null;
  }

  function storageGet(areaName, keys) {
    return call(area(areaName), 'get', [keys]).then((value) => value || {});
  }

  function storageSet(areaName, values) {
    return call(area(areaName), 'set', [values]);
  }

  function storageRemove(areaName, keys) {
    return call(area(areaName), 'remove', [keys]);
  }

  async function fetchJson(url) {
    if (typeof fetch !== 'function') {
      throw new Error('fetch() is unavailable in this context');
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' for ' + url);
    }
    return response.json();
  }

  const namespace = {
    api,
    available: Boolean(api),
    call,
    runtime,
    getUrl,
    sendMessage,
    onMessage,
    storageGet,
    storageSet,
    storageRemove,
    fetchJson,
    hasStorageSync: Boolean(area('sync')),
  };

  global.DecDi = Object.assign(global.DecDi || {}, { compat: namespace });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = namespace;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
