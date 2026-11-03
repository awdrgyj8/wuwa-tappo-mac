export function patchSessionBarriers(source) {
  let changes = 0;
  const patched = source.replace(
    /async function (invoke(?:\$\d+)?)\(e,t=\{\},n\)\{return window\.__TAURI_INTERNALS__\.invoke\(e,t,n\)\}/g,
    (_, name) => {
      changes += 1;
      return `async function ${name}(e,t={},n){if(e==="open_login_window"||e==="open_panel_window"||e==="plugin:event|emit"&&(t.event==="cat-auth-login-success"||t.event==="cat-auth-logout"))await window.__WUWATAPPO_SESSION__?.flush();return window.__TAURI_INTERNALS__.invoke(e,t,n)}`;
    },
  );
  if (changes !== 2) throw new Error(`Expected 2 original Tauri invoke wrappers, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function patchLoginReady(source) {
  const original='function N(n){return o(u,t=>{n(t.payload??{})})}';
  const replacement='async function N(n){const unlisten=await o(u,t=>{n(t.payload??{})});await window.__TAURI_INTERNALS__.invoke("login_window_ready");return unlisten}';
  if(source.split(original).length!==2) throw new Error('Original login listener bridge changed; reconcile modal readiness before building.');
  return source.replace(original,replacement);
}

export function patchDomesticSdkUrls(source) {
  if (!source.includes('const APP_REGION="CN"')) {
    throw new Error('Expected the official CN frontend. Extract the CN installer before building.');
  }
  let changes = 0;
  const patched = source.replace(
    /(isdk(?:Src|Css)=")(\/\/pro-cdn-sdk\.kurogame\.com\/pro\/web-sdk\/1\.x\/(?:kr-sdk\.js|style\.css)")/g,
    (_, prefix, url) => {
      changes += 1;
      return `${prefix}https:${url}`;
    },
  );
  if (changes !== 2) throw new Error(`Expected 2 CN SDK URLs, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function patchDomesticLoginReload(source) {
  const start = 'async function we(e=!1){if(E)return E;if(!e&&$())';
  const end = 'async function me()';
  const insertion = ',document.head.appendChild(t),r=window.setTimeout(';
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  if (offset < 0 || limit < 0 || source.split(start).length !== 2) {
    throw new Error('Original CN SDK reload function changed; reconcile the login reload patch before building.');
  }
  const loader = source.slice(offset, limit);
  if (!loader.includes('t.dataset.kuroSdkRetry="true"') || loader.split(insertion).length !== 2) {
    throw new Error('Original CN SDK script insertion changed; reconcile the login reload patch before building.');
  }
  const replacement = ',e&&([...document.scripts].filter(s=>s.src===t.src).forEach(s=>s.remove()),document.getElementById("KrSDK")?.remove())' + insertion;
  return source.slice(0, offset) + loader.replace(insertion, replacement) + source.slice(limit);
}

export function patchMacUpdateFeedback(source) {
  const pattern = /if\(([$\w]+)\.kind==="error"\)\{([^{}]*?)([$\w]+)\.value=n\("setting_version_check_failed"\);return\}/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Original update feedback changed; reconcile the Mac update message before building.');
  return source.replace(pattern, (_, error, before, target) => `if(${error}.kind==="error"){${before}${target}.value=${error}.message||n("setting_version_check_failed");return}`);
}

export function patchMacUpdater(source, region = 'CN') {
  const resolver = 'async function resolveUpdaterLatestJsonUrl(){const e=resolveUpdaterLatestHostJsonUrl();if(!e)return null;';
  const missingHost = region === 'GLOBAL' ? '官方設定缺少更新資源位址' : '官方配置缺少更新资源地址';
  const recovery = `async function resolveUpdaterLatestJsonUrl(){let e=resolveUpdaterLatestHostJsonUrl();if(!e){const config=unwrapApiData(await activityInfo());const host=typeof config?.assets_host==="string"?config.assets_host.trim():"";if(!host||host===LOCAL_ROLE_ASSETS_HOST)throw new Error("${missingHost}");setUpdaterAssetsHost(host,{triggerSilentCheck:!1});e=resolveUpdaterLatestHostJsonUrl()}`;
  const failure = 'if(logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:e?.interactive?"report_error":"treat_as_latest"},"warn"),e?.interactive)return{kind:"error",message:n};try{const s=await getVersion();return console.warn("[updater] check skipped (treat as latest)",t),{kind:"none",currentVersion:s}}catch{return{kind:"error",message:n}}';
  const report = 'return logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:"report_error"},"warn"),{kind:"error",message:n}';
  for (const original of [resolver, failure]) {
    if (source.split(original).length !== 2) throw new Error('Original updater flow changed; reconcile the Mac update path before building.');
  }
  return source.replace(resolver, recovery).replace(failure, report);
}

export function patchMacAbout(source, region = 'CN') {
  const headings = [...source.matchAll(/<h2 (data-v-[a-f0-9]+)>系统配置<\/h2>/g)];
  if (headings.length !== 1) throw new Error('Original About system section changed; reconcile the Mac build information before building.');
  const original = headings[0][0], scope = headings[0][1];
  const remotes = [...source.matchAll(/t=([$\w]+)\(\(\)=>k\("about_content"\)\?String\(v\("about_content"\)\)\.trim\(\):""\)/g)];
  if (remotes.length !== 1) throw new Error('Original remote About content changed; reconcile the Mac build information before building.');
  const [remote, computed] = remotes[0];
  const info = region === 'GLOBAL'
    ? `<h2 ${scope}>macOS 重製版</h2><p ${scope}>Wuwa Tappo Global Mac · 非官方重製 · Apple Silicon · macOS 13 以上</p>`
    : `<h2 ${scope}>macOS 重建版</h2><p ${scope}>Wuwa Tappo CN Mac · 非官方重建 · Apple Silicon · macOS 13 及以上</p>`;
  const banner = `<section class="about-section" ${scope}>${info}</section>`;
  const windowsHeading = region === 'GLOBAL' ? 'Windows 原版系統配備' : 'Windows 原版系统配置';
  return source
    .replace(original, `${info}<h3 ${scope}>${windowsHeading}</h3>`)
    .replace(remote, `t=${computed}(()=>{const html=k("about_content")?String(v("about_content")).trim():"";return html?${JSON.stringify(banner)}+html.replace("系统配置","Windows 原版系统配置").replace("系統配備","Windows 原版系統配備"):""})`);
}

// The startup page asks how to keep sign-in information before any frontend loads.
export function prepareBootstrap(html, profile) {
  const changed = 'Startup page template changed; reconcile its regional text before building.';
  const replacements = [
    ['<title>Wuwa Tappo CN Mac</title>', `<title>${profile.productName}</title>`],
  ];
  if (profile.region === 'GLOBAL') {
    replacements.push(
      ['<html lang="zh-CN">', '<html lang="zh-Hant">'],
      ['<h1>Wuwa Tappo · 国服</h1>', '<h1>Wuwa Tappo · 國際服</h1>'],
      ['<p id="status">仅本次会话：登录信息只保存在内存，退出后清除。\n记住登录：使用 macOS 钥匙串，需要系统授权。</p>',
        '<p id="status">僅限本次：登入資訊只保存在記憶體，結束後清除。\n記住登入：使用 macOS 鑰匙圈，需要系統授權。</p>'],
      ['<button id="quit">退出</button><button id="keychain">记住登录</button><button id="memory">仅本次会话</button>',
        '<button id="quit">結束</button><button id="keychain">記住登入</button><button id="memory">僅限本次</button>'],
    );
  } else replacements.push(['<h1>Wuwa Tappo · 国服</h1>', `<h1>Wuwa Tappo · ${profile.label}</h1>`]);
  for (const [original, replacement] of replacements) {
    if (html.split(original).length !== 2) throw new Error(changed);
    html = html.replace(original, replacement);
  }
  return html;
}

export function patchGlobalAuthListener(source) {
  const bridge = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
  const wake = 'async function onOpenUrl(e){return await listen("mac-oauth-callback-ready",()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))})}';
  const current = 'try{const t=await getCurrent();t?.length&&handleRawUrls(t)}catch(t){console.warn("[overseas-auth] getCurrent failed:",t)}';
  const listener = 'try{unlisten=await onOpenUrl(t=>{handleRawUrls(t)})}catch(t){throw console.warn("[overseas-auth] onOpenUrl failed:",t),bound=!1,t}';
  if (source.split(bridge).length !== 2 || source.split(current + listener).length !== 2) throw new Error('Original GLOBAL OAuth callback binding changed; reconcile cold and warm callback delivery before building.');
  return source.replace(bridge, wake).replace(current + listener, listener + current);
}

export function patchMacLayoutBarriers(source) {
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const targets = [];
  function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    callback(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, callback));
      else if (value && typeof value === 'object') visit(value, callback);
    }
  }
  visit(tree, node => {
    if (node.type !== 'FunctionDeclaration') return;
    const content = source.slice(node.start, node.end);
    if (content.includes('[taskbar-insets] desktop state refresh failed')
      || (content.includes('[main-window-bounds] sync failed') && content.includes('syncMainWindowContentBoundsNow'))) targets.push(node);
  });
  if (targets.length !== 2) throw new Error('Original desktop layout barriers changed; reconcile macOS layout before building.');
  const frames = [];
  for (const target of targets) {
    const matches = [];
    visit(target.body, node => {
      if (node.type === 'AwaitExpression' && node.argument.type === 'NewExpression'
        && node.argument.callee.type === 'Identifier' && node.argument.callee.name === 'Promise'
        && source.slice(node.argument.start, node.argument.end).includes('requestAnimationFrame')) matches.push(node);
    });
    if (matches.length !== 1) throw new Error('Original desktop layout frame changed; reconcile macOS layout before building.');
    frames.push(matches[0]);
  }
  for (const frame of frames.sort((a, b) => b.start - a.start)) source = source.slice(0, frame.start) + 'await __wuwatappoMacLayoutBarrier()' + source.slice(frame.end);
  const helper = `async function __wuwatappoMacLayoutBarrier(){
  const nativeWindow=window.__TAURI__.window.getCurrentWindow();
  const [size,scale]=await Promise.all([nativeWindow.innerSize(),nativeWindow.scaleFactor()]);
  const root=document.documentElement;
  if(!root)throw new Error("macOS DOM layout root is unavailable");
  getComputedStyle(root).getPropertyValue("--pet-scale");
  const rootRect=root.getBoundingClientRect();
  const dockRect=document.querySelector(".pet-dock")?.getBoundingClientRect();
  const width=window.innerWidth,height=window.innerHeight;
  if(!Number.isFinite(scale)||scale<=0||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(size.width)||!Number.isFinite(size.height)||Math.abs(width-size.width/scale)>2||Math.abs(height-size.height/scale)>2)throw new Error("macOS layout viewport does not match native window");
  for(const rect of[rootRect,dockRect])if(rect&&![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite))throw new Error("macOS DOM layout geometry is invalid");
}`;
  return helper + source;
}

function walkSyntax(node, callback, parent = null) {
  if (!node || typeof node !== 'object') return;
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walkSyntax(child, callback, node));
    else if (value && typeof value === 'object' && typeof value.type === 'string') walkSyntax(value, callback, node);
  }
}

function declaredNames(statements) {
  const names = new Set();
  for (const statement of statements) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'ImportDeclaration') declaration.specifiers.forEach(item => names.add(item.local.name));
    else if (declaration?.type === 'VariableDeclaration') declaration.declarations.forEach(item => item.id.type === 'Identifier' && names.add(item.id.name));
    else if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') names.add(declaration.id.name);
  }
  return names;
}

const escapeRegExp = value => value.replace(/[$]/g, '\\$');

// Expose the official chest click handler to scripts/mac-auto-chest.js. The handler
// keeps its own cooldown, click-count, reward popup and bag refresh behaviour.
export function patchMacAutoChest(source) {
  const changed = 'Original chest opening flow changed; reconcile the Mac auto chest before building.';
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const handlers = [];
  walkSyntax(tree, (node, parent) => {
    if (node.type !== 'FunctionDeclaration' || parent?.type !== 'BlockStatement') return;
    const content = source.slice(node.start, node.end);
    if (content.includes('"[chest] openChest failed"') && content.includes('click_num:')) handlers.push({ node, block: parent });
  });
  if (handlers.length !== 1) throw new Error(changed);
  const [{ node, block }] = handlers;
  const content = source.slice(node.start, node.end);
  const head = /^async function ([$\w]+)\(([$\w]+)\)\{if\(([$\w]+)\(\)\)\{[$\w]+\([$\w]+\("update_force_lock_hint"\)\);return\}if\(([$\w]+)\.value\|\|([$\w]+)\.value\)return;/.exec(content);
  if (!head) throw new Error(changed);
  const [, handler, place, locked, busy, disabled] = head;
  const p = escapeRegExp(place);
  const gate = new RegExp(`if\\(!\\(${p}==="left"\\?([$\\w]+)\\.value:([$\\w]+)\\.value\\)\\)return;if\\(!([$\\w]+)\\.isLoggedIn\\)`).exec(content);
  if (!gate) throw new Error(changed);
  const [, left, right, store] = gate;
  const s = escapeRegExp(store);
  const minimum = new RegExp(`${s}\\.totalClickCount<([$\\w]+)\\)`).exec(content)?.[1];
  const request = new RegExp(`\\{place:${p},click_num:${s}\\.cumulativeClickCount\\}`, 'g');
  const rewards = [...content.matchAll(/[$\w]+\(\{itemId:([$\w]+)\.data\.asset_id,itemRarity:\1\.data\.rarity_type,itemType:\1\.assetType\}\)/g)];
  if (!minimum || (content.match(request) ?? []).length !== 1 || rewards.length !== 1) throw new Error(changed);
  const result = rewards[0][1];
  if (!content.includes(`${result}.assetName`)) throw new Error(changed);
  // Remaining cooldown refs behind the official readiness computeds, e.g. Wn=pe(()=>kt.value||!A.isLoggedIn?!0:Bt.value<=0).
  const wait = name => new RegExp(`[,;\\s]${escapeRegExp(name)}=[$\\w]+\\(\\(\\)=>${escapeRegExp(disabled)}\\.value\\|\\|!${s}\\.isLoggedIn\\?!0:([$\\w]+)\\.value<=0\\)`).exec(source.slice(block.start, block.end))?.[1];
  const leftWait = wait(left), rightWait = wait(right);
  if (!leftWait || !rightWait) throw new Error(changed);
  const local = declaredNames(block.body);
  const module = declaredNames(tree.body);
  if (![busy, disabled, left, right, leftWait, rightWait].every(name => local.has(name))
    || ![locked, store, minimum].every(name => module.has(name) && !local.has(name))) throw new Error(changed);
  const controller = 'window.__WUWATAPPO_AUTO_CHEST__';
  const claimed = `${controller}?.claimed(${place},${result}.data,${result}.assetType,${result}.assetName),`;
  const attach = `${controller}?.attach({open:${handler},snapshot:()=>({loggedIn:!!${store}.isLoggedIn,account:String(${store}.userInfo?.id??""),locked:!!${locked}(),busy:!!${busy}.value,disabled:!!${disabled}.value,left:!!${left}.value,right:!!${right}.value,leftWait:Number(${leftWait}.value)||0,rightWait:Number(${rightWait}.value)||0,clicks:Number(${store}.totalClickCount)||0,minimum:${minimum}})});`;
  const reward = node.start + rewards[0].index;
  return source.slice(0, reward) + claimed + source.slice(reward, node.end) + attach + source.slice(node.end);
}

// The official emote menu keeps a requestAnimationFrame spring loop alive for the whole
// session, waking the always-visible pet window every frame. Run it only while a button
// is pressed or still settling, and wake it again on the next press.
export function patchMacEmotionMenuIdle(source) {
  const changed = 'Original emote menu animation changed; reconcile the Mac idle frame patch before building.';
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const components = [];
  walkSyntax(tree, node => {
    if (node.type === 'ObjectExpression' && node.properties.some(item => item.type === 'Property' && !item.computed
      && (item.key.name ?? item.key.value) === '__name' && item.value.type === 'Literal' && item.value.value === 'EmotionMenu')) components.push(node);
  });
  if (components.length !== 1) throw new Error(changed);
  const [component] = components;
  const componentText = source.slice(component.start, component.end);
  if (!['targetX:1,targetY:1,targetR:0', 'held:!1,releaseTimer:0,returnTimer:0'].every(fields => componentText.includes(fields))) throw new Error(changed);
  const loops = [], presses = [];
  walkSyntax(component, node => {
    if (node.type !== 'FunctionDeclaration') return;
    const tail = node.body.body.at(-1);
    const frame = tail?.type === 'ExpressionStatement' ? tail.expression : null;
    if (frame?.type === 'AssignmentExpression' && frame.operator === '=' && frame.left.type === 'Identifier'
      && frame.right.type === 'CallExpression' && frame.right.callee.type === 'Identifier' && frame.right.callee.name === 'requestAnimationFrame'
      && frame.right.arguments.length === 1 && frame.right.arguments[0].type === 'Identifier' && frame.right.arguments[0].name === node.id.name) {
      loops.push({ node, frame, handle: frame.left.name });
    }
    if (source.slice(node.start, node.end).includes('.pressedAt=performance.now()')) presses.push(node);
  });
  if (loops.length !== 1 || presses.length !== 1) throw new Error(changed);
  const [{ node: loop, frame, handle }] = loops;
  const header = /^function [$\w]+\(([$\w]+)\)\{const [$\w]+=Math\.min\(\(\1-([$\w]+)\)\/1e3,\.028\);\2=\1;for\(const\[[$\w]+,[$\w]+\]of ([$\w]+)\)/.exec(source.slice(loop.start, loop.end));
  if (!header) throw new Error(changed);
  const [, , clock, states] = header;
  const schedule = `${handle}=requestAnimationFrame(${loop.id.name})`;
  const start = `${clock}=performance.now(),${schedule}`;
  if (componentText.split(schedule).length !== 3 || componentText.split(start).length !== 2) throw new Error(changed);
  const press = presses[0].body.body.at(-1);
  if (press?.type !== 'ExpressionStatement' || !source.slice(press.start, press.end).includes('.held=!0')) throw new Error(changed);
  const mount = component.start + componentText.indexOf(start);
  const edits = [
    [frame.start, frame.end, `${handle}=__wuwatappoSpringActive(${states})?requestAnimationFrame(${loop.id.name}):0`],
    [mount, mount + start.length, `${clock}=performance.now(),${handle}=0`],
    [press.expression.end, press.expression.end, `,${handle}||(${start})`],
  ].sort((first, second) => second[0] - first[0]);
  for (const [from, to, text] of edits) source = source.slice(0, from) + text + source.slice(to);
  const helper = 'function __wuwatappoSpringActive(states){for(const state of states.values())if(state.held||state.releaseTimer||state.returnTimer||Math.abs(state.x-state.targetX)>.001||Math.abs(state.y-state.targetY)>.001||Math.abs(state.r-state.targetR)>.001||Math.abs(state.vx)>.01||Math.abs(state.vy)>.01||Math.abs(state.vr)>.01)return!0;return!1}\n';
  return helper + source;
}

export function patchMacAutoChestNames(source) {
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  if (tree.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'resolveAssetDisplayName').length !== 1) {
    throw new Error('Original reward name resolver changed; reconcile the Mac auto chest records before building.');
  }
  return `${source}\n;window.__WUWATAPPO_AUTO_CHEST__?.useAssetNames(resolveAssetDisplayName);\n`;
}
import { parse } from 'acorn';
