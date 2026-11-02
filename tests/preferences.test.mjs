import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const preferences = await readFile(new URL('../scripts/mac-preferences.js', import.meta.url), 'utf8');
const session = await readFile(new URL('../scripts/mac-session.js', import.meta.url), 'utf8');

class FakeStorage {
  #map = new Map();
  getItem(key) { return this.#map.get(String(key)) ?? null; }
  setItem(key, value) { this.#map.set(String(key), String(value)); }
  removeItem(key) { this.#map.delete(String(key)); }
  clear() { this.#map.clear(); }
  key(index) { return [...this.#map.keys()][index] ?? null; }
  get length() { return this.#map.size; }
  dump() { return Object.fromEntries(this.#map); }
}

// Loads one page the way windows.rs orders its scripts: saved values, the preference
// bridge, then the session bridge that wraps localStorage.
function page({ storage = new FakeStorage(), saved = {}, protocol = 'tauri:', hostname = 'localhost' } = {}) {
  const saves = [], timers = [], listeners = new Map();
  const window = {
    localStorage: storage,
    __WUWATAPPO_PREFERENCES__: Object.freeze({ ...saved }),
    __TAURI_INTERNALS__: {
      async invoke(command, payload) {
        if (command === 'save_preference') { saves.push({ ...payload }); return null; }
        if (command === 'session_snapshot') return { revision: 0, cookies: [], storage: {}, persistence: 'memory' };
        if (command === 'plugin:event|listen') return 1;
        if (command === 'session_apply') return { revision: 1, cookies: [], storage: {}, persistence: 'memory' };
        throw new Error(`unexpected ${command}`);
      },
      transformCallback: () => 1,
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatchEvent() {},
  };
  const element = () => ({ style: {}, setAttribute() {}, append() {}, appendChild() {}, remove() {}, addEventListener() {} });
  const context = vm.createContext({
    window, location: { protocol, hostname, pathname: '/index.html', href: `${protocol}//${hostname}/index.html` },
    document: { readyState: 'complete', body: element(), documentElement: element(), getElementById() {}, createElement: element, addEventListener() {} },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: id => { timers[id - 1] = null; },
    console: { warn() {} },
    CustomEvent: class {}, StorageEvent: class {},
  });
  vm.runInContext(preferences, context);
  vm.runInContext(session.replace('__WUWATAPPO_SESSION_SNAPSHOT__', JSON.stringify({ revision: 0, cookies: [], storage: {}, persistence: 'memory' })), context);
  return {
    storage, saves, localStorage: window.localStorage,
    settle() { for (const timer of timers.splice(0)) timer?.(); return Promise.resolve(); },
    leave() { listeners.get('pagehide')?.(); },
  };
}

test('settings missing from the WebView are restored before the app reads them', async () => {
  const view = page({ saved: { 'wuwatappo-settings': '{"petScale":125,"windowOpacity":80}', 'wuwatappo-locale': 'zh-tw' } });
  assert.equal(view.localStorage.getItem('wuwatappo-settings'), '{"petScale":125,"windowOpacity":80}');
  assert.equal(view.localStorage.getItem('wuwatappo-locale'), 'zh-tw');
  await view.settle();
  assert.deepEqual(view.saves, [], 'restored values are already saved');
});

test('existing WebView settings win and back up an older or empty file', async () => {
  const storage = new FakeStorage();
  storage.setItem('wuwatappo-settings', '{"petScale":90}');
  storage.setItem('about_startup_skip', '1');
  const view = page({ storage, saved: { 'wuwatappo-settings': '{"petScale":150}' } });
  assert.equal(view.localStorage.getItem('wuwatappo-settings'), '{"petScale":90}');
  await view.settle();
  assert.deepEqual(view.saves, [
    { key: 'wuwatappo-settings', value: '{"petScale":90}' },
    { key: 'about_startup_skip', value: '1' },
  ]);
});

test('only setting keys written through the session bridge are mirrored', async () => {
  const view = page();
  view.localStorage.setItem('wuwatappo-settings', '{"windowPassthrough":true}');
  view.localStorage.setItem('wuwatappo-settings', '{"windowPassthrough":false}');
  view.localStorage.setItem('bag_new_asset_ids', '[1,2]');
  view.localStorage.setItem('__KrSDK_USER_TOKEN__', 'synthetic-secret');
  assert.deepEqual(view.saves, [], 'writes are batched');
  await view.settle();
  assert.deepEqual(view.saves, [{ key: 'wuwatappo-settings', value: '{"windowPassthrough":false}' }]);
  assert.equal(view.storage.getItem('__KrSDK_USER_TOKEN__'), null, 'sign-in data stays with the session store');
  view.localStorage.setItem('wuwatappo-locale', 'en');
  view.leave();
  assert.deepEqual(view.saves.at(-1), { key: 'wuwatappo-locale', value: 'en' }, 'leaving the page saves at once');
});

test('a removed setting is not brought back by an older window snapshot', async () => {
  const storage = new FakeStorage();
  const first = page({ storage, saved: { about_startup_skip: '1' } });
  assert.equal(first.localStorage.getItem('about_startup_skip'), '1');
  first.localStorage.removeItem('about_startup_skip');
  await first.settle();
  assert.deepEqual(first.saves, [{ key: 'about_startup_skip', value: null }]);
  const reloaded = page({ storage, saved: { about_startup_skip: '1' } });
  assert.equal(reloaded.localStorage.getItem('about_startup_skip'), null);
  reloaded.localStorage.setItem('about_startup_skip', '1');
  await reloaded.settle();
  assert.deepEqual(reloaded.saves, [{ key: 'about_startup_skip', value: '1' }]);
  const wiped = page({ storage: new FakeStorage(), saved: { about_startup_skip: '1' } });
  assert.equal(wiped.localStorage.getItem('about_startup_skip'), '1', 'a lost WebView store is restored');
});

test('external pages are left untouched', () => {
  const view = page({ protocol: 'https:', hostname: 'login.example.com', saved: { 'wuwatappo-locale': 'en' } });
  assert.equal(view.storage.getItem('wuwatappo-locale'), null);
});
