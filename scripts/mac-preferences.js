(function initializeMacPreferences(saved) {
  'use strict';
  // Settings live in the WebView's localStorage as usual; this mirrors them to
  // Application Support (src-tauri/src/preferences.rs) and restores any that the
  // WebView lost, for example after an app update. Runs before mac-session.js so
  // the session bridge captures these wrapped Storage methods.
  const localApp = (location.protocol === 'tauri:' && location.hostname === 'localhost')
    || (['http:', 'https:'].includes(location.protocol) && ['localhost', '127.0.0.1', 'tauri.localhost'].includes(location.hostname));
  if (!localApp || window.__WUWATAPPO_PREFERENCES_BRIDGE__) return;

  const keys = new Set([
    'wuwatappo-settings',
    'wuwatappo-locale',
    'wuwatappo-main-pet-placement-v1',
    'wuwatappo-main-window-outer-pos',
    'role_switch_emote_confirm_skip',
    'about_startup_skip',
    'wuwatappo-mac-auto-chest-v1',
  ]);
  // A removed setting leaves a marker so an older window snapshot cannot bring it back.
  const removedPrefix = 'wuwatappo-mac-preference-removed:';
  const storage = window.localStorage;
  const prototype = Object.getPrototypeOf(storage);
  const rawGet = prototype.getItem;
  const rawSet = prototype.setItem;
  const rawRemove = prototype.removeItem;
  const rawClear = prototype.clear;
  const pending = new Map();
  let timer = 0;

  function send() {
    timer = 0;
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') return;
    for (const [key, value] of pending) {
      Promise.resolve(invoke('save_preference', { key, value }))
        .catch(() => console.warn('[macOS] A setting could not be saved outside the app'));
    }
    pending.clear();
  }

  function queue(key, value) {
    pending.set(key, value);
    if (!timer) timer = setTimeout(send, 150);
  }

  try {
    for (const key of keys) {
      const current = rawGet.call(storage, key);
      const backup = typeof saved[key] === 'string' ? saved[key] : null;
      if (current === null) {
        if (backup !== null && rawGet.call(storage, removedPrefix + key) === null) rawSet.call(storage, key, backup);
      } else if (current !== backup) queue(key, current);
    }
  } catch {
    console.warn('[macOS] Saved settings could not be restored');
  }

  prototype.setItem = function setItem(key, value) {
    rawSet.call(this, key, value);
    key = String(key);
    if (this === storage && keys.has(key)) {
      rawRemove.call(storage, removedPrefix + key);
      queue(key, String(value));
    }
  };
  prototype.removeItem = function removeItem(key) {
    rawRemove.call(this, key);
    key = String(key);
    if (this === storage && keys.has(key)) {
      rawSet.call(storage, removedPrefix + key, '1');
      queue(key, null);
    }
  };
  prototype.clear = function clear() {
    rawClear.call(this);
    if (this !== storage) return;
    for (const key of keys) {
      rawSet.call(storage, removedPrefix + key, '1');
      queue(key, null);
    }
  };
  window.addEventListener('pagehide', () => {
    if (!timer) return;
    clearTimeout(timer);
    send();
  });
  Object.defineProperty(window, '__WUWATAPPO_PREFERENCES_BRIDGE__', { value: true });
})(window.__WUWATAPPO_PREFERENCES__ ?? {});
