(() => {
  // Opens the desktop chests through the official click handler as soon as their
  // 30-minute cooldown ends, then lists the rewards in the native menus.
  const STORAGE_KEY = 'wuwatappo-mac-auto-chest-v1';
  const CHECK_INTERVAL_MS = 15_000;
  const FIRST_CHECK_DELAY_MS = 3_000;
  const RETRY_BASE_MS = 5 * 60_000;
  const RETRY_MAX_MS = 30 * 60_000;
  const MAX_RECORDS = 100;
  const MENU_ENTRIES = 5;
  const ALIVE_LOG_MS = 10 * 60_000;
  const PLACES = ['left', 'right'];
  // Simplified Chinese for the CN app, Traditional Chinese for Global.
  const traditional = window.__WUWATAPPO_PROFILE__?.region === 'GLOBAL';
  const T = (cn, global) => (traditional ? global : cn);
  const TYPE_LABELS = { character_skin: '角色', accessory: T('饰品', '飾品'), emote: '表情' };
  const RARITY_LABELS = { common: T('绿', '綠'), uncommon: T('蓝', '藍'), rare: '紫', epic: '金' };

  let view = null;
  let resolveName = null;
  let timer = null;
  let running = false;
  let pending = null;
  let account;
  let listening = false;
  let status = null;
  let lastAlive = 0;
  const failures = { left: 0, right: 0 };
  const retryAt = { left: 0, right: 0 };

  const tauri = () => window.__TAURI__;
  const text = value => String(value ?? '').trim();

  function validRecord(record) {
    return record && typeof record === 'object' && Number.isFinite(record.at) && PLACES.includes(record.place)
      && typeof record.account === 'string' && typeof record.label === 'string';
  }

  function load() {
    try {
      const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
      return {
        enabled: value?.enabled !== false,
        records: Array.isArray(value?.records) ? value.records.filter(validRecord).slice(0, MAX_RECORDS) : [],
      };
    } catch {
      return { enabled: true, records: [] };
    }
  }

  function save(state) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { console.warn('[macOS] Auto chest records could not be saved'); }
  }

  function log(message) {
    try {
      Promise.resolve(tauri()?.core?.invoke('write_app_log', { level: 'info', message: `[CHEST] ${message}` }))
        .catch(() => {});
    } catch {}
  }

  function displayName(type, name) {
    try {
      const resolved = text(resolveName?.(type, name));
      if (resolved) return resolved;
    } catch {}
    return text(name) || T('未知奖励', '未知獎勵');
  }

  const pad = value => String(value).padStart(2, '0');
  const clock = ms => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
  function formatRecord(record) {
    const date = new Date(record.at);
    const details = [TYPE_LABELS[record.type], RARITY_LABELS[record.rarity]].filter(Boolean).join('·');
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}  ${record.label}${details ? `（${details}）` : ''}`;
  }

  // Why nothing is being opened right now, shown at the top of the menu.
  function waitStatus(state, current, now) {
    if (!state.enabled) return { key: 'paused', text: T('自动领取已暂停', '自動領取已暫停') };
    if (!account) return { key: 'logged_out', text: T('登录后才会自动领取宝箱', '登入後才會自動領取寶箱') };
    if (current.locked) return { key: 'update_locked', text: T('需要先更新应用', '需要先更新 App') };
    if (current.busy) return null;
    if (current.disabled) return { key: 'syncing', text: T('宝箱同步中，完成后自动领取', '寶箱同步中，完成後自動領取') };
    const ready = PLACES.filter(place => current[place] === true);
    if (!ready.length) {
      const waits = PLACES.map(place => Number(current[`${place}Wait`])).filter(ms => Number.isFinite(ms) && ms > 0);
      if (!waits.length) return { key: 'cooldown', text: T('冷却中，结束后自动领取', '冷卻中，結束後自動領取') };
      const at = clock(now + Math.min(...waits));
      return { key: 'cooldown', text: T(`冷却中，${at} 后自动领取`, `冷卻中，${at} 自動領取`), detail: `next=${at}` };
    }
    const minimum = Number(current.minimum);
    if (!Number.isFinite(minimum) || !(Number(current.clicks) >= minimum)) {
      return { key: 'clicks', text: T(`点击数不足 ${minimum}，累积后自动领取`, `點擊數不足 ${minimum}，累積後自動領取`), detail: `clicks=${Number(current.clicks) || 0}` };
    }
    if (!ready.some(place => now >= retryAt[place])) {
      const at = clock(Math.min(...ready.map(place => retryAt[place])));
      return { key: 'retry', text: T(`领取失败，${at} 重试`, `領取失敗，${at} 重試`), detail: `retry=${at}` };
    }
    return { key: 'ready', text: T('冷却结束，正在领取', '冷卻結束，正在領取') };
  }

  function updateStatus(next, state) {
    if (!next || (status?.key === next.key && status.text === next.text)) return;
    status = next;
    log(`status=${next.key}${next.detail ? ` ${next.detail}` : ''}`);
    syncMenu(state);
  }

  function menuPayload(state) {
    if (!account) return { enabled: state.enabled, summary: T('登录后才会自动领取宝箱', '登入後才會自動領取寶箱'), entries: [] };
    const mine = state.records.filter(record => record.account === account);
    const total = mine.length >= MAX_RECORDS ? `${MAX_RECORDS}+` : String(mine.length);
    const current = status?.text ?? (state.enabled ? T('冷却结束后自动领取', '冷卻結束後自動領取') : T('自动领取已暂停', '自動領取已暫停'));
    return {
      enabled: state.enabled,
      summary: mine.length ? `${current} · ${T(`已领 ${total} 件`, `已領 ${total} 件`)}` : current,
      entries: mine.slice(0, MENU_ENTRIES).map(formatRecord),
    };
  }

  function syncMenu(state = load()) {
    const invoke = tauri()?.core?.invoke;
    if (!view || typeof invoke !== 'function') return;
    try {
      Promise.resolve(invoke('sync_auto_chest_menu', menuPayload(state)))
        .catch(() => console.warn('[macOS] Auto chest menu could not be updated'));
    } catch {
      console.warn('[macOS] Auto chest menu could not be updated');
    }
  }

  function snapshot() {
    try { return view?.snapshot() ?? null; }
    catch { return null; }
  }

  function refreshAccount(current) {
    const next = current.loggedIn ? text(current.account) : '';
    if (next === account) return;
    account = next;
    for (const place of PLACES) { failures[place] = 0; retryAt[place] = 0; }
    syncMenu();
  }

  async function check() {
    if (!view || running) return false;
    const current = snapshot();
    if (!current) return false;
    refreshAccount(current);
    const state = load();
    const now = Date.now();
    const next = waitStatus(state, current, now);
    updateStatus(next, state);
    // Gaps between these lines in the log show when macOS paused the timers.
    if (now - lastAlive >= ALIVE_LOG_MS) {
      lastAlive = now;
      log(`alive status=${status?.key ?? 'unknown'}`);
    }
    if (next?.key !== 'ready') return false;
    const place = PLACES.find(item => current[item] === true && now >= retryAt[item]);
    if (!place) return false;
    running = true;
    pending = { place, account, claimed: false };
    log(`auto_claim start place=${place}`);
    try {
      await view.open(place);
    } catch {
      console.warn('[macOS] Auto chest opening failed');
    } finally {
      running = false;
    }
    const claimed = pending.claimed;
    pending = null;
    const after = snapshot();
    if (after) updateStatus(waitStatus(load(), after, Date.now()), load());
    if (claimed) {
      failures[place] = 0;
      retryAt[place] = 0;
    } else {
      failures[place] += 1;
      retryAt[place] = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures[place] - 1));
    }
    log(`auto_claim place=${place} result=${claimed ? 'ok' : 'failed'} ms=${Date.now() - now}`);
    return claimed;
  }

  function schedule(delay) {
    window.setTimeout(() => { check().catch(() => {}); }, delay);
  }

  async function listen() {
    if (listening) return;
    const event = tauri()?.event;
    if (typeof event?.listen !== 'function') return;
    listening = true;
    try {
      await event.listen('mac-auto-chest-toggle', () => {
        const state = load();
        state.enabled = !state.enabled;
        for (const place of PLACES) { failures[place] = 0; retryAt[place] = 0; }
        save(state);
        log(`auto_claim enabled=${state.enabled}`);
        syncMenu(state);
        schedule(0);
      });
      await event.listen('mac-auto-chest-clear', () => {
        const state = load();
        state.records = state.records.filter(record => record.account !== account);
        save(state);
        syncMenu(state);
      });
    } catch {
      listening = false;
      console.warn('[macOS] Auto chest menu actions are unavailable');
    }
  }

  const controller = Object.freeze({
    attach(target) {
      if (typeof target?.open !== 'function' || typeof target?.snapshot !== 'function') return;
      view = target;
      account = undefined;
      listen();
      if (timer === null) {
        timer = window.setInterval(() => { check().catch(() => {}); }, CHECK_INTERVAL_MS);
        window.addEventListener('pagehide', () => {
          window.clearInterval(timer);
          timer = null;
          view = null;
        }, { once: true });
      }
      schedule(FIRST_CHECK_DELAY_MS);
    },
    claimed(place, data, type, name) {
      try {
        if (!pending || pending.place !== place || pending.claimed) return;
        pending.claimed = true;
        const assetType = text(type).toLowerCase();
        const state = load();
        state.records.unshift({
          at: Date.now(),
          place,
          account: pending.account,
          type: assetType,
          name: text(name),
          label: displayName(assetType, name),
          rarity: text(data?.rarity_type).toLowerCase(),
        });
        state.records = state.records.slice(0, MAX_RECORDS);
        save(state);
        syncMenu(state);
      } catch {
        console.warn('[macOS] Auto chest reward could not be recorded');
      }
    },
    useAssetNames(resolver) {
      if (typeof resolver === 'function') resolveName = resolver;
    },
    check,
  });

  Object.defineProperty(window, '__WUWATAPPO_AUTO_CHEST__', { value: controller, writable: false, configurable: false });
})();
