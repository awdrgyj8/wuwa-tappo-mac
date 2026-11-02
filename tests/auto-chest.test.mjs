import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { profile, root, findSource } from './frontend-context.mjs';
import { patchMacAutoChest, patchMacAutoChestNames } from '../scripts/patch-frontend.mjs';

process.env.TZ = 'UTC';
const script = await readFile(new URL('../scripts/mac-auto-chest.js', import.meta.url), 'utf8');

// Same statement shapes as the official 1.0.2 pet view, with minified local names.
const handler = 'async function uc(e){if(Ie()){yt($("update_force_lock_hint"));return}if(Dn.value||kt.value)return;const t=e==="left"?xi:Di,o=e==="left"?Oi:Fi;if(!(e==="left"?Wn.value:Gn.value))return;if(!A.isLoggedIn){ru(),q();return}Dn.value=!0;let b=!1;try{if(b=!0,A.totalClickCount<Ns){yt("click_not_enough");return}const M=await(async()=>{const Z=await km({place:e,click_num:A.cumulativeClickCount});return{ok:!0,data:Z,assetName:String(Z.asset_name),assetType:String(Z.asset_type)}})();if(!M.ok)return;Cm({itemId:M.data.asset_id,itemRarity:M.data.rarity_type,itemType:M.assetType}),await Rp(M.assetType,M.assetName)}catch(M){console.warn("[chest] openChest failed",M)}finally{Dn.value=!1}}';
const fixture = `const A={isLoggedIn:!0,userInfo:{id:42},totalClickCount:1500,cumulativeClickCount:9000},Ns=1e3;let lockedState=!1;function Ie(){return lockedState}function setup(){const Dn={value:!1},kt={value:!1},Wn={value:!0},Gn={value:!1},xi=0,Di=0,Oi=0,Fi=0;${handler}function Yn(){}return{uc,Dn,kt,Wn,Gn}}`;

function runPatchedView(source) {
  const calls = [];
  const controller = {
    attach: target => calls.push(['attach', target]),
    claimed: (...args) => calls.push(['claimed', ...args]),
  };
  const env = vm.createContext({
    window: { __WUWATAPPO_AUTO_CHEST__: controller },
    $: key => key, yt: message => calls.push(['toast', message]), ru() {}, q() {},
    km: async request => { calls.push(['request', request]); return { asset_id: 7, asset_name: 'accessory_1000', asset_type: 'accessory', rarity_type: 'rare' }; },
    Cm: item => calls.push(['track', item.itemId]),
    Rp: async () => calls.push(['popup']),
    console: { warn: (...args) => calls.push(['warn', ...args]) },
  });
  vm.runInContext(`${source};globalThis.view=setup();globalThis.setLocked=value=>{lockedState=value}`, env);
  return { env, calls };
}

test('auto chest patch exposes the official handler and records rewards before the official tracking', async () => {
  const patched = patchMacAutoChest(fixture);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  const { env, calls } = runPatchedView(patched);
  const [kind, target] = calls.shift();
  assert.equal(kind, 'attach');
  assert.equal(target.open, env.view.uc);
  assert.deepEqual({ ...target.snapshot() }, {
    loggedIn: true, account: '42', locked: false, busy: false, disabled: false,
    left: true, right: false, clicks: 1500, minimum: 1000,
  });
  env.view.Dn.value = true; env.view.Gn.value = true; env.setLocked(true);
  assert.deepEqual([target.snapshot().busy, target.snapshot().right, target.snapshot().locked], [true, true, true]);
  env.view.Dn.value = false; env.setLocked(false);
  await target.open('left');
  assert.deepEqual(calls.map(call => call[0]), ['request', 'claimed', 'track', 'popup']);
  assert.deepEqual({ ...calls[0][1] }, { place: 'left', click_num: 9000 });
  assert.deepEqual(calls[1].slice(1, 2), ['left']);
  assert.equal(calls[1][2].rarity_type, 'rare');
  assert.deepEqual(calls[1].slice(3), ['accessory', 'accessory_1000']);
});

test('auto chest patch stops the build when the official chest flow changes', () => {
  const changed = /Original chest opening flow changed/;
  assert.throws(() => patchMacAutoChest(''), changed);
  assert.throws(() => patchMacAutoChest(fixture.replace('itemType:M.assetType', 'itemKind:M.assetType')), changed);
  assert.throws(() => patchMacAutoChest(fixture.replace('"update_force_lock_hint"', '"update_lock"')), changed);
  assert.throws(() => patchMacAutoChest(fixture.replace('A.totalClickCount<Ns', 'A.totalClickCount<1e3')), changed);
  assert.throws(() => patchMacAutoChest(fixture.replace('Gn={value:!1},', '')), changed, 'chest state must be in the handler scope');
  assert.throws(() => patchMacAutoChest(fixture.replace(handler, handler + handler.replace('uc(', 'uc2('))), changed);
  assert.throws(() => patchMacAutoChestNames('function other(){}'), /reward name resolver changed/);
  assert.match(patchMacAutoChestNames('function resolveAssetDisplayName(e,t){return t}export{resolveAssetDisplayName as co};'), /useAssetNames\(resolveAssetDisplayName\)/);
});

test('prepared resources connect the official chest view and reward names to the macOS auto chest', async () => {
  const view = findSource(source => source.includes('"[chest] openChest failed"'));
  const prepared = await readFile(path.join(root, profile.preparedDir, 'assets', view.name), 'utf8');
  parse(prepared, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.equal((prepared.match(/__WUWATAPPO_AUTO_CHEST__\?\.attach\(\{open:/g) ?? []).length, 1);
  assert.equal((prepared.match(/__WUWATAPPO_AUTO_CHEST__\?\.claimed\(/g) ?? []).length, 1);
  const main = findSource(source => source.includes(`const APP_REGION="${profile.region}"`));
  const preparedMain = await readFile(path.join(root, profile.preparedDir, 'assets', main.name), 'utf8');
  parse(preparedMain, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.ok(preparedMain.endsWith(';window.__WUWATAPPO_AUTO_CHEST__?.useAssetNames(resolveAssetDisplayName);\n'));
});

function webview({ stored } = {}) {
  let now = Date.UTC(2026, 10, 2, 6, 30);
  const storage = new Map(stored === undefined ? [] : [['wuwatappo-mac-auto-chest-v1', stored]]);
  const invokes = [], listeners = new Map(), timeouts = [], warnings = [];
  let interval;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; },
    setInterval(callback, delay) { assert.equal(delay, 15000); interval = callback; return 1; },
    clearInterval() { interval = undefined; },
    addEventListener() {},
    __TAURI__: {
      core: { invoke: async (command, payload) => { invokes.push({ command, payload }); } },
      event: { listen: async (name, callback) => { listeners.set(name, callback); } },
    },
  };
  vm.runInNewContext(script, { window, Date: ClockDate, console: { warn: message => warnings.push(message) } });
  const state = { loggedIn: true, account: '42', locked: false, busy: false, disabled: false, left: false, right: false, clicks: 0, minimum: 1000 };
  const opened = [];
  let reward = null;
  const controller = window.__WUWATAPPO_AUTO_CHEST__;
  const view = {
    snapshot: () => ({ ...state }),
    async open(place) {
      opened.push(place);
      if (!reward) return;
      controller.claimed(place, { rarity_type: reward.rarity }, reward.type, reward.name);
      state[place] = false;
    },
  };
  return {
    controller, view, state, opened, invokes, listeners, timeouts, warnings,
    get interval() { return interval; },
    setReward(value) { reward = value; },
    advance(milliseconds) { now += milliseconds; },
    stored: () => JSON.parse(storage.get('wuwatappo-mac-auto-chest-v1') ?? 'null'),
    menus: () => invokes.filter(call => call.command === 'sync_auto_chest_menu').map(call => JSON.parse(JSON.stringify(call.payload))),
  };
}

test('auto chest waits for login, enough clicks and a finished cooldown before opening', async () => {
  const app = webview();
  app.controller.attach(app.view);
  assert.equal(typeof app.interval, 'function');
  assert.deepEqual(app.timeouts.map(item => item.delay), [3000]);
  app.state.loggedIn = false;
  assert.equal(await app.controller.check(), false);
  assert.deepEqual(app.menus().at(-1), { enabled: true, summary: '登录后才会自动领取宝箱', entries: [] });
  app.state.loggedIn = true; app.state.left = true; app.state.clicks = 999;
  assert.equal(await app.controller.check(), false);
  assert.equal(app.menus().at(-1).summary, '暂无领取记录，冷却结束后自动领取');
  for (const blocker of ['locked', 'busy', 'disabled']) {
    app.state.clicks = 1000; app.state[blocker] = true;
    assert.equal(await app.controller.check(), false, blocker);
    app.state[blocker] = false;
  }
  app.state.left = false;
  assert.equal(await app.controller.check(), false);
  assert.deepEqual(app.opened, []);
});

test('auto chest opens each ready chest and lists rewards for the main menu', async () => {
  const app = webview();
  app.controller.useAssetNames((type, name) => ({ 'character_skin:role_1102_3': '今汐·夏日' })[`${type}:${name}`] ?? '');
  app.controller.attach(app.view);
  Object.assign(app.state, { left: true, right: true, clicks: 2400 });
  app.setReward({ type: 'Character_Skin', name: 'role_1102_3', rarity: 'Epic' });
  assert.equal(await app.controller.check(), true);
  app.advance(60_000);
  app.setReward({ type: 'accessory', name: 'accessory_1000', rarity: 'rare' });
  assert.equal(await app.controller.check(), true);
  assert.deepEqual(app.opened, ['left', 'right']);
  assert.deepEqual(app.menus().at(-1), {
    enabled: true,
    summary: '已自动领取 2 件，最近获得：',
    entries: ['11/02 06:31  accessory_1000（饰品·紫）', '11/02 06:30  今汐·夏日（角色·金）'],
  });
  assert.deepEqual(app.stored().records.map(record => [record.place, record.account, record.type, record.name, record.rarity]), [
    ['right', '42', 'accessory', 'accessory_1000', 'rare'],
    ['left', '42', 'character_skin', 'role_1102_3', 'epic'],
  ]);
  assert.ok(app.invokes.some(call => call.command === 'write_app_log' && call.payload.message === '[CHEST] auto_claim place=left result=ok'));
  app.controller.claimed('left', { rarity_type: 'epic' }, 'emote', 'emote_1_happy');
  assert.equal(app.stored().records.length, 2, 'manual openings are not reported as automatic rewards');
});

test('failed automatic openings back off instead of repeating the official error toast', async () => {
  const app = webview();
  app.controller.attach(app.view);
  Object.assign(app.state, { left: true, clicks: 5000 });
  assert.equal(await app.controller.check(), false);
  app.advance(5 * 60_000 - 1);
  assert.equal(await app.controller.check(), false);
  assert.deepEqual(app.opened, ['left']);
  app.advance(1);
  assert.equal(await app.controller.check(), false);
  app.advance(5 * 60_000);
  await app.controller.check();
  assert.deepEqual(app.opened, ['left', 'left'], 'second failure waits ten minutes');
  app.advance(5 * 60_000);
  app.setReward({ type: 'emote', name: 'emote_1_happy', rarity: 'common' });
  assert.equal(await app.controller.check(), true);
  assert.deepEqual(app.opened, ['left', 'left', 'left']);
  assert.equal(app.menus().at(-1).entries[0], '11/02 06:45  emote_1_happy（表情·绿）');
});

test('menu actions pause automatic opening and clear only the current account records', async () => {
  const other = { at: 1, place: 'left', account: '7', type: 'emote', name: 'x', label: 'x', rarity: 'common' };
  const app = webview({ stored: JSON.stringify({ enabled: true, records: [other] }) });
  app.controller.attach(app.view);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app.listeners.keys()], ['mac-auto-chest-toggle', 'mac-auto-chest-clear']);
  Object.assign(app.state, { right: true, clicks: 1000 });
  app.setReward({ type: 'accessory', name: 'accessory_1000', rarity: 'uncommon' });
  assert.equal(await app.controller.check(), true);
  assert.equal(app.menus().at(-1).summary, '已自动领取 1 件，最近获得：', 'other account records stay hidden');
  app.listeners.get('mac-auto-chest-toggle')();
  assert.equal(app.stored().enabled, false);
  assert.equal(app.menus().at(-1).enabled, false);
  app.state.right = true;
  assert.equal(await app.controller.check(), false);
  assert.deepEqual(app.opened, ['right']);
  app.listeners.get('mac-auto-chest-clear')();
  assert.deepEqual(app.stored().records, [other]);
  assert.deepEqual(app.menus().at(-1), { enabled: false, summary: '暂无领取记录', entries: [] });
  app.listeners.get('mac-auto-chest-toggle')();
  assert.equal(app.stored().enabled, true);
  assert.deepEqual(app.timeouts.at(-1).delay, 0, 'enabling checks immediately');
});

test('damaged records and failing name lookups fall back safely', async () => {
  const app = webview({ stored: '{broken' });
  app.controller.useAssetNames(() => { throw new Error('dictionary unavailable'); });
  app.controller.attach(app.view);
  Object.assign(app.state, { left: true, clicks: 1000 });
  app.setReward({ type: 'unknown', name: 'mystery_1', rarity: 'legendary' });
  assert.equal(await app.controller.check(), true);
  assert.deepEqual(app.menus().at(-1).entries, ['11/02 06:30  mystery_1']);
  assert.throws(() => { app.controller.extra = true; }, TypeError);
});
