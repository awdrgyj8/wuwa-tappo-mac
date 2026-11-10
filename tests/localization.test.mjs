import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { prepareBootstrap, patchMacAbout, patchMacUpdater } from '../scripts/patch-frontend.mjs';
import { getRegionProfile } from '../scripts/regions.mjs';

const read = name => readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
const [bootstrap, platform, autoChest, session] = await Promise.all(['bootstrap.html', 'mac-platform.js', 'mac-auto-chest.js', 'mac-session.js'].map(read));
// Characters that only appear in Simplified Chinese; none may reach the Global app's Mac text.
const simplified = /[录会话钥启设键监听级领宝记获饰绿蓝奖励暂无务删时间应该说读为这简体闭开关请输]/;

test('Global startup page asks about sign-in storage in Traditional Chinese', () => {
  const global = prepareBootstrap(bootstrap, getRegionProfile('global'));
  for (const text of ['<html lang="zh-Hant">', '<title>Wuwa Tappo Global Mac</title>', 'Wuwa Tappo · 國際服', '僅限本次：登入資訊只保存在記憶體', '記住登入：使用 macOS 鑰匙圈', '>結束</button>', '>記住登入</button>', '>僅限本次</button>']) {
    assert.ok(global.includes(text), text);
  }
  const visible = global.replace(/<script>[\s\S]*<\/script>/, '');
  assert.doesNotMatch(visible, simplified);
  const cn = prepareBootstrap(bootstrap, getRegionProfile('cn'));
  assert.ok(cn.includes('<h1>Wuwa Tappo · 国服</h1>') && cn.includes('记住登录'));
  assert.throws(() => prepareBootstrap(bootstrap.replace('记住登录</button>', '记住</button>'), getRegionProfile('global')), /Startup page template changed/);
});

test('Global About banner and update recovery use Traditional Chinese', () => {
  const about = patchMacAbout('t=b(()=>k("about_content")?String(v("about_content")).trim():"");<h2 data-v-1>系统配置</h2>', 'GLOBAL');
  assert.ok(about.includes('macOS 重製版') && about.includes('Windows 原版系統配備'));
  // Simplified remote About content keeps a Simplified heading; everything the Mac build adds is Traditional.
  assert.doesNotMatch(about.replace('html.replace("系统配置","Windows 原版系统配置")', ''), /重建版|原版系统/);
  const resolver = 'async function resolveUpdaterLatestJsonUrl(){const e=resolveUpdaterLatestHostJsonUrl();if(!e)return null;';
  const failure = 'if(logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:e?.interactive?"report_error":"treat_as_latest"},"warn"),e?.interactive)return{kind:"error",message:n};try{const s=await getVersion();return console.warn("[updater] check skipped (treat as latest)",t),{kind:"none",currentVersion:s}}catch{return{kind:"error",message:n}}';
  assert.ok(patchMacUpdater(resolver + failure, 'GLOBAL').includes('官方設定缺少更新資源位址'));
  assert.ok(patchMacUpdater(resolver + failure).includes('官方配置缺少更新资源地址'));
});

function inputNotice(region, status, shortcuts = { error: null }) {
  const nodes = new Map();
  const invoke = async command => (['get_input_status', 'resume_input_monitor'].includes(command) ? status
    : command === 'get_shortcut_status' ? shortcuts : undefined);
  const window = {
    addEventListener() {}, setInterval() { return 1; }, clearInterval() {},
    __WUWATAPPO_PROFILE__: { region, productName: 'Wuwa Tappo Global Mac' },
    __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } }, invoke },
    __TAURI__: { core: { invoke }, event: { listen: async () => {} } },
  };
  const document = {
    readyState: 'complete', addEventListener() {}, getElementById: id => nodes.get(id),
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    body: { append(node) { nodes.set(node.id, node); } },
  };
  vm.runInNewContext(platform, { window, document, Error, console });
  return () => nodes.get('wuwatappo-input-status')?.textContent;
}

test('Global input permission notices use Traditional Chinese', async () => {
  const revoked = inputNotice('GLOBAL', { granted: false, running: false, error: null });
  const stopped = inputNotice('GLOBAL', { granted: true, running: false, error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revoked(), '鍵盤滑鼠計數已暫停：請在「系統設定」→「輸入監控」中重新允許 Wuwa Tappo Global Mac。');
  assert.match(stopped(), /^已取得輸入監控權限/);
  assert.doesNotMatch(revoked() + stopped(), simplified);
  const cn = inputNotice('CN', { granted: false, running: false, error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(cn(), /键鼠计数已暂停/);
});

test('Global shortcut notices use Traditional Chinese', async () => {
  const running = { granted: true, running: true, error: null };
  const notices = ['occupied', 'unavailable', 'status_unavailable'].map(error => inputNotice('GLOBAL', running, { error }));
  const clear = inputNotice('GLOBAL', running);
  const cn = inputNotice('CN', running, { error: 'occupied' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(notices[0](), /^全域快速鍵已被系統或其他 App 佔用/);
  assert.match(notices[1](), /^全域快速鍵暫時無法使用/);
  assert.match(notices[2](), /^無法讀取全域快速鍵狀態/);
  for (const notice of notices) assert.doesNotMatch(notice(), simplified);
  assert.equal(clear(), undefined);
  assert.match(cn(), /^全局快捷键被系统或其他应用占用/);
});

test('Global auto chest menu text uses Traditional Chinese', async () => {
  const menus = [];
  const window = {
    __WUWATAPPO_PROFILE__: { region: 'GLOBAL' },
    localStorage: (() => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; })(),
    setTimeout() { return 1; }, setInterval() { return 1; }, addEventListener() {},
    __TAURI__: { core: { invoke: async (command, payload) => { if (command === 'sync_auto_chest_menu') menus.push(JSON.parse(JSON.stringify(payload))); } }, event: { listen: async () => {} } },
  };
  vm.runInNewContext(autoChest, { window, Date, console: { warn() {} } });
  const chest = window.__WUWATAPPO_AUTO_CHEST__;
  const state = { loggedIn: false, account: '1', locked: false, busy: false, disabled: false, left: true, right: false, clicks: 1000, minimum: 1000 };
  chest.attach({ snapshot: () => ({ ...state }), open: async place => { chest.claimed(place, { rarity_type: 'uncommon' }, 'accessory', 'accessory_9'); state[place] = false; } });
  await chest.check();
  assert.equal(menus.at(-1).summary, '登入後才會自動領取寶箱');
  state.loggedIn = true;
  await chest.check();
  assert.equal(menus.at(-1).summary, '冷卻中，結束後自動領取 · 已領 1 件');
  assert.match(menus.at(-1).entries[0], /accessory_9（飾品·藍）$/);
  Object.assign(state, { rightWait: 5 * 60_000 });
  await chest.check();
  assert.match(menus.at(-1).summary, /^冷卻中，\d\d:\d\d 自動領取 · 已領 1 件$/);
  Object.assign(state, { right: true, rightWait: 0, clicks: 10 });
  await chest.check();
  assert.equal(menus.at(-1).summary, '點擊數不足 1000，累積後自動領取 · 已領 1 件');
  for (const summary of menus.map(menu => menu.summary)) assert.doesNotMatch(summary, simplified);
});

test('Global session error banner uses Traditional Chinese', async () => {
  const elements = new Map();
  const element = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, appendChild(node) { if (node.id) elements.set(node.id, node); }, remove() {} });
  const window = {
    __WUWATAPPO_PROFILE__: { region: 'GLOBAL' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 },
    dispatchEvent() {},
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('synthetic unavailable'); }, transformCallback: () => 1 },
  };
  const context = vm.createContext({
    window, location: { protocol: 'tauri:', hostname: 'localhost', pathname: '/', href: 'tauri://localhost/' },
    document: { readyState: 'complete', body: element(), documentElement: element(), getElementById: id => elements.get(id), createElement: element, addEventListener() {} },
    console, CustomEvent: class {}, StorageEvent: class {},
  });
  vm.runInContext(session.replace('__WUWATAPPO_SESSION_SNAPSHOT__', JSON.stringify({ revision: 0, cookies: [], storage: {}, persistence: 'memory' })), context);
  await new Promise(resolve => setImmediate(resolve));
  const banner = elements.get('wuwatappo-session-error');
  assert.equal(banner.children[0].textContent, '無法同步登入資訊，請重試以繼續。');
  assert.equal(banner.children[1].textContent, '重試');
});

test('every Global string in the native backend is Traditional Chinese', async () => {
  const sources = await Promise.all(['lib', 'menu', 'startup', 'system'].map(name => readFile(new URL(`../src-tauri/src/${name}.rs`, import.meta.url), 'utf8')));
  const pairs = sources.flatMap(source => [...source.matchAll(/\.text\(\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)",?\s*\)/g)]);
  assert.ok(pairs.length >= 25, `found ${pairs.length} regional strings`);
  for (const [, cn, global] of pairs) {
    assert.notEqual(cn, global);
    assert.doesNotMatch(global, simplified, global);
  }
  const menu = sources[1];
  const labels = menu.slice(menu.indexOf('fn for_region'), menu.indexOf('impl Default for Labels'));
  assert.match(labels, /"圖鑑"/);
  assert.doesNotMatch(labels, simplified);
});
