// OZON Brand Guard — Background Service Worker
// Автор: firayzer (https://t.me/firayzer)

const ALARM_SELLERS = 'obg-schedule';
const ALARM_PRODUCTS = 'obg-schedule-products';

// ── State ──
let isRunning = false;
let isPaused = false;
let latestSellerStats = null;
let latestProductStats = null;
let latestDuplicateStats = null;
let duplicateScanState = null; // { skus, currentIndex, results, config, tabId, strategy }

// ── Message handling ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'getStatus':
      sendResponse({
        running: isRunning, paused: isPaused,
        sellerStats: latestSellerStats, productStats: latestProductStats,
        duplicateStats: latestDuplicateStats,
        scanState: duplicateScanState ? { currentIndex: duplicateScanState.currentIndex, total: duplicateScanState.skus.length, resultsCount: duplicateScanState.results.length } : null
      });
      return true;

    case 'setRunning':
      isRunning = msg.running;
      break;

    // ── Launch from popup (background handles navigation so popup can close) ──
    case 'launchSellers':
      launchSellers(msg.config);
      break;

    case 'launchProducts':
      launchProducts(msg.config);
      break;

    case 'launchDuplicates':
      launchDuplicateSearch(msg.skus, msg.config, msg.strategy || 'manual');
      break;

    case 'launchCurrentPage':
      launchCurrentPageScan(msg.config);
      break;

    case 'launchBatchProducts':
      launchBatchFromProducts(msg.config);
      break;

    case 'batchSkusCollected':
      // SKUs collected from products table, now launch duplicate search
      relayToExtensionPages(msg);
      if (msg.skus && msg.skus.length > 0) {
        // Save config before resetting state — launchDuplicateSearch checks isRunning
        const savedConfig = duplicateScanState?.config || {};
        // Reset isRunning so launchDuplicateSearch can proceed
        isRunning = false;
        duplicateScanState = null;
        relayToExtensionPages({ action: 'techLog', text: `[Пакетный] 🚀 Начинаю поиск дубликатов по ${msg.skus.length} товарам...` });
        launchDuplicateSearch(msg.skus, savedConfig, 'batch');
      } else {
        relayToExtensionPages({ action: 'techLog', text: `[Пакетный] ❌ SKU не найдены в таблице товаров` });
        relayToExtensionPages({ action: 'doneDuplicates', results: [] });
        isRunning = false;
        duplicateScanState = null;
      }
      break;

    case 'pauseDuplicates':
      pauseDuplicateSearch();
      break;

    case 'resumeDuplicates':
      resumeDuplicateSearch();
      break;

    case 'stopDuplicates':
      stopDuplicateSearch();
      break;

    case 'resumeFromSaved':
      resumeFromSavedSession().then(r => sendResponse(r));
      return true;

    case 'getPausedSession':
      loadPausedSession().then(s => sendResponse(s));
      return true;

    case 'getHistory':
      loadDuplicateHistory().then(h => sendResponse(h));
      return true;

    case 'clearHistory':
      chrome.storage.local.set({ obgDupHistory: [] });
      sendResponse({ ok: true });
      return true;

    case 'updateSchedule':
      updateSchedule(msg.config);
      break;

    case 'updateProductSchedule':
      updateProductSchedule(msg.config);
      break;

    case 'logComplaint':
      addLogEntry(msg.entry);
      break;

    case 'showNotification':
      showNotification(msg.title, msg.message);
      break;

    case 'getConfig':
      chrome.storage.local.get('obgConfig', (result) => {
        sendResponse(result.obgConfig || null);
      });
      return true;

    // Relay + store stats
    case 'updateStats':
      latestSellerStats = msg.stats;
      relayToExtensionPages(msg);
      break;

    case 'updateProductStats':
      latestProductStats = msg.stats;
      relayToExtensionPages(msg);
      break;

    case 'updateDuplicateStats':
      latestDuplicateStats = msg.stats;
      relayToExtensionPages(msg);
      break;

    case 'done':
      isRunning = false;
      relayToExtensionPages(msg);
      break;

    case 'doneProducts':
      isRunning = false;
      relayToExtensionPages(msg);
      break;

    case 'duplicatePageResult':
      handleDuplicatePageResult(msg);
      break;

    case 'duplicateScanStopped':
      isRunning = false;
      duplicateScanState = null;
      relayToExtensionPages({ action: 'doneDuplicates' });
      break;

    case 'scanBrandsResult':
    case 'logUpdate':
      relayToExtensionPages(msg);
      break;
    // NOTE: techLog NOT relayed — content scripts broadcast via chrome.runtime.sendMessage
    // which already reaches popup directly. Relaying caused double log lines.
    // SW-generated techLogs use relayToExtensionPages() directly.
  }
});

function relayToExtensionPages(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup closed, ignore */ });
}

// ── Switch OZON cabinet to "Кабинет бренда" ──
async function switchToBrandCabinet(tabId) {
  console.log('[OBG] Checking cabinet mode on tab', tabId);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const triggerEl = document.querySelector('[data-onboarding-target="headerSellerType"] .ct1110-a');
        if (!triggerEl) return 'no-header';

        const text = triggerEl.textContent || '';
        // If text contains "Продавец" we're in seller cabinet — need to switch
        if (!text.includes('Продавец')) return 'already-brand';

        // Open the dropdown
        triggerEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await new Promise(r => setTimeout(r, 800));

        // Walk all text nodes to find "Кабинет бренда" option
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim() === 'Кабинет бренда') {
            const clickTarget = node.parentElement;
            clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            try { clickTarget.click(); } catch (e) { /* ignore */ }
            await new Promise(r => setTimeout(r, 3500));
            return 'switched';
          }
        }

        // Could not find option — close dropdown and continue
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return 'not-found';
      }
    });
    const status = results?.[0]?.result;
    console.log('[OBG] Cabinet switch result:', status);
    if (status === 'switched') await wait(2000);
    return status;
  } catch (e) {
    console.log('[OBG] switchToBrandCabinet error:', e.message);
    return 'error';
  }
}

// ── Navigate, inject, and start — reusable for popup launch + scheduled runs ──
async function navigateInjectStart(url, scriptFile, action, config) {
  // Step 1: Find existing seller.ozon.ru tab OR create one at home
  let sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
  let tabId;

  if (sellerTabs.length > 0) {
    tabId = sellerTabs[0].id;
    await chrome.tabs.update(tabId, { active: true });
    await wait(600);
  } else {
    const tab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/' });
    await waitForTabComplete(tab.id);
    await wait(1500);
    tabId = tab.id;
  }

  // Step 2: Switch to brand cabinet if needed
  await switchToBrandCabinet(tabId);

  // Step 3: Navigate to target URL
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  const alreadyThere = currentTab && currentTab.url && currentTab.url.startsWith(url.replace(/\/+$/, ''));

  if (!alreadyThere) {
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    await wait(2000);
  }

  // Step 4: Inject content script and send start message
  await injectAndStart(tabId, scriptFile, action, config);
}

async function injectAndStart(tabId, scriptFile, action, config) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: [scriptFile] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
  } catch (e) { console.log('[OBG] inject:', e.message); }
  await wait(500);
  chrome.tabs.sendMessage(tabId, { action, config }, () => {
    if (chrome.runtime.lastError) console.log('[OBG] sendMessage:', chrome.runtime.lastError.message);
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Launch sellers (called from popup) ──
async function launchSellers(config) {
  if (isRunning) { console.log('[OBG] Already running'); return; }
  isRunning = true;
  latestSellerStats = null;
  console.log('[OBG] Launching sellers, mode:', config.mode);
  await navigateInjectStart(
    'https://seller.ozon.ru/app/brand/sellers',
    'content/content.js',
    'start',
    config
  );
}

// ── Launch products (called from popup) ──
async function launchProducts(config) {
  if (isRunning) { console.log('[OBG] Already running'); return; }
  isRunning = true;
  latestProductStats = null;
  console.log('[OBG] Launching products, productMode:', config.productMode);
  await navigateInjectStart(
    'https://seller.ozon.ru/app/brand-products/all',
    'content/content-products.js',
    'startProducts',
    config
  );
}

// ── Scheduling — Sellers ──
function updateSchedule(config) {
  chrome.alarms.clear(ALARM_SELLERS);
  if (config && config.scheduleEnabled) {
    chrome.alarms.create(ALARM_SELLERS, { periodInMinutes: config.scheduleInterval * 60 });
    console.log('[OBG] Sellers schedule: every', config.scheduleInterval, 'hours');
  }
}

// ── Scheduling — Products ──
function updateProductSchedule(config) {
  chrome.alarms.clear(ALARM_PRODUCTS);
  if (config && config.productScheduleEnabled) {
    chrome.alarms.create(ALARM_PRODUCTS, { periodInMinutes: config.productScheduleInterval * 60 });
    console.log('[OBG] Products schedule: every', config.productScheduleInterval, 'hours');
  }
}

// ── Alarm handler ──
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_SELLERS && alarm.name !== ALARM_PRODUCTS) return;
  if (isRunning) { console.log('[OBG] Already running, skip'); return; }

  const config = await getConfig();
  if (!config) return;

  if (alarm.name === ALARM_SELLERS) {
    await launchSellers(config);
  } else {
    // Ensure productMode is set for scheduled runs
    if (config.productMode !== 'complain') config.productMode = 'scan';
    await launchProducts(config);
  }
});

// ── Logging ──
async function addLogEntry(entry) {
  const config = await getConfig();
  if (!config) return;

  if (!config.log) config.log = [];
  config.log.push(entry);

  // Keep last 5000 entries
  if (config.log.length > 5000) {
    config.log = config.log.slice(-5000);
  }

  await chrome.storage.local.set({ obgConfig: config });
}

// ── Notifications ──
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: '../assets/icon-128.png',
    title: title || 'OZON Brand Guard',
    message: message
  });
}

// ── Helpers ──
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('obgConfig', (result) => {
      resolve(result.obgConfig || null);
    });
  });
}

// ── Launch duplicate search (sequential SKU processing) ──
async function launchDuplicateSearch(skus, config, strategy) {
  if (isRunning) { console.log('[OBG] Already running'); return; }
  if (!skus || skus.length === 0) { console.log('[OBG] No SKUs to scan'); return; }
  isRunning = true;
  isPaused = false;
  latestDuplicateStats = { total: skus.length, processed: 0, found: 0 };
  duplicateScanState = { skus, currentIndex: 0, results: [], config, tabId: null, strategy: strategy || 'manual' };

  console.log('[OBG] Launching duplicate search for', skus.length, 'SKUs');
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] 🔍 Запускаю поиск дубликатов по ${skus.length} SKU...` });
  relayToExtensionPages({ action: 'updateDuplicateStats', stats: latestDuplicateStats });
  await processDuplicateSku(0);
}

async function processDuplicateSku(index) {
  if (!duplicateScanState || index >= duplicateScanState.skus.length) {
    // All done
    isRunning = false;
    const totalFound = duplicateScanState?.results?.length || 0;
    relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ✅ Поиск завершён. Найдено ${totalFound} дубликатов` });
    relayToExtensionPages({ action: 'doneDuplicates', results: duplicateScanState?.results || [] });
    console.log('[OBG] Duplicate search complete. Total found:', totalFound);
    duplicateScanState = null;
    return;
  }

  const sku = duplicateScanState.skus[index];
  const total = duplicateScanState.skus.length;
  const url = `https://www.ozon.ru/product/${sku}/`;
  console.log('[OBG] Processing SKU', sku, `(${index + 1}/${total})`);
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] 📦 Обработка SKU ${sku} (${index + 1}/${total})...` });

  try {
    // Find or create tab on ozon.ru
    let tabId = duplicateScanState.tabId;
    if (tabId) {
      // Reuse existing tab (stays in background — no active: true)
      try {
        await chrome.tabs.get(tabId); // Check tab still exists
        await chrome.tabs.update(tabId, { url });
      } catch (e) {
        // Tab was closed, create new one in background
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        duplicateScanState.tabId = tabId;
      }
    } else {
      // Find existing ozon.ru tab or create new in background
      const ozonTabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
      if (ozonTabs.length > 0) {
        tabId = ozonTabs[0].id;
        await chrome.tabs.update(tabId, { url });
      } else {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      }
      duplicateScanState.tabId = tabId;
    }

    await waitForTabComplete(tabId);
    await wait(2500); // Wait for SPA rendering

    // Inject content script
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content/content-duplicates.js'] });
    } catch (e) { console.log('[OBG] inject duplicates:', e.message); }
    await wait(500);

    // Send scan command
    duplicateScanState.currentIndex = index;
    chrome.tabs.sendMessage(tabId, {
      action: 'startDuplicateScan',
      skus: duplicateScanState.skus,
      currentIndex: index,
      config: duplicateScanState.config
    }, () => {
      if (chrome.runtime.lastError) console.log('[OBG] sendMessage:', chrome.runtime.lastError.message);
    });
  } catch (e) {
    console.log('[OBG] Error processing SKU', sku, ':', e.message);
    // Move to next SKU on error
    handleDuplicatePageResult({
      sku,
      competitors: [],
      error: e.message,
      pageIndex: index,
      totalSkus: duplicateScanState.skus.length
    });
  }
}

function handleDuplicatePageResult(msg) {
  if (!duplicateScanState) return;

  const { sku, competitors, pageIndex } = msg;
  const found = competitors?.length || 0;
  const processed = (pageIndex || 0) + 1;
  const total = duplicateScanState.skus.length;
  console.log('[OBG] Page result for SKU', sku, '- found', found, 'competitors');

  // Store results
  if (competitors && competitors.length > 0) {
    for (const comp of competitors) {
      duplicateScanState.results.push({ ...comp, sourceSku: sku });
    }
  }

  // Log per-SKU result
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ${found > 0 ? '🔴' : '🟢'} SKU ${sku}: ${found} дубликатов (${processed}/${total})` });

  // Update stats
  latestDuplicateStats = { total, processed, found: duplicateScanState.results.length };
  relayToExtensionPages({ action: 'updateDuplicateStats', stats: latestDuplicateStats });
  relayToExtensionPages({ action: 'duplicatePageDone', sku, competitors: competitors || [], allResults: duplicateScanState.results });

  // Process next SKU (with delay)
  const nextIndex = processed;
  if (nextIndex < total) {
    // Check if paused
    if (isPaused) {
      duplicateScanState.currentIndex = nextIndex;
      savePausedSession();
      relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ⏸ Пауза. Обработано ${processed}/${total}, найдено ${duplicateScanState.results.length} дубликатов` });
      relayToExtensionPages({ action: 'duplicateScanPaused', results: duplicateScanState.results, processed, total });
      return;
    }
    const delay = (duplicateScanState.config?.duplicateDelay || 3) * 1000;
    setTimeout(() => processDuplicateSku(nextIndex), delay);
  } else {
    // All done
    isRunning = false;
    isPaused = false;
    clearPausedSession();
    const totalFound = duplicateScanState.results.length;
    relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ✅ Готово! Обработано ${total} SKU, найдено ${totalFound} дубликатов` });
    relayToExtensionPages({ action: 'doneDuplicates', results: duplicateScanState.results });
    console.log('[OBG] Duplicate search complete. Total:', totalFound);
    saveDuplicateSession(duplicateScanState, 'completed');
    duplicateScanState = null;
  }
}

function pauseDuplicateSearch() {
  if (!duplicateScanState || !isRunning) return;
  isPaused = true;
  // Сохраняем состояние паузы в storage для восстановления после закрытия popup
  savePausedSession();
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ⏸ Пауза запрошена, ожидаю завершения текущего SKU...` });
  console.log('[OBG] Duplicate search paused');
}

function resumeDuplicateSearch() {
  if (!duplicateScanState || !isPaused) return;
  isPaused = false;
  clearPausedSession();
  const nextIndex = duplicateScanState.currentIndex;
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ▶ Возобновление с SKU ${nextIndex + 1}/${duplicateScanState.skus.length}...` });
  relayToExtensionPages({ action: 'duplicateScanResumed' });
  console.log('[OBG] Duplicate search resumed from index', nextIndex);
  processDuplicateSku(nextIndex);
}

/** Возобновление из сохранённой сессии (после закрытия popup или перезагрузки SW) */
async function resumeFromSavedSession() {
  const saved = await loadPausedSession();
  if (!saved || !saved.skus || saved.skus.length === 0) return { ok: false, error: 'Нет сохранённой сессии' };

  if (isRunning) return { ok: false, error: 'Сканирование уже запущено' };

  isRunning = true;
  isPaused = false;
  duplicateScanState = {
    skus: saved.skus,
    currentIndex: saved.currentIndex,
    results: saved.results || [],
    config: saved.config || {},
    tabId: null,
    strategy: saved.strategy || 'manual'
  };
  latestDuplicateStats = { total: saved.skus.length, processed: saved.currentIndex, found: (saved.results || []).length };

  clearPausedSession();
  const nextIndex = saved.currentIndex;
  relayToExtensionPages({ action: 'techLog', text: `[Дубликаты] ▶ Возобновление сохранённой сессии с SKU ${nextIndex + 1}/${saved.skus.length}...` });
  relayToExtensionPages({ action: 'updateDuplicateStats', stats: latestDuplicateStats });
  relayToExtensionPages({ action: 'duplicateScanResumed' });
  console.log('[OBG] Resuming saved session from index', nextIndex);
  processDuplicateSku(nextIndex);
  return { ok: true, total: saved.skus.length, from: nextIndex };
}

function stopDuplicateSearch() {
  const partialResults = duplicateScanState?.results || [];
  if (duplicateScanState && duplicateScanState.tabId) {
    chrome.tabs.sendMessage(duplicateScanState.tabId, { action: 'stopDuplicates' }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }
  if (duplicateScanState && partialResults.length > 0) {
    saveDuplicateSession(duplicateScanState, 'stopped');
  }
  isRunning = false;
  isPaused = false;
  latestDuplicateStats = null;
  clearPausedSession();
  relayToExtensionPages({ action: 'doneDuplicates', results: partialResults });
  duplicateScanState = null;
}

// ── Paused session persistence ──
function savePausedSession() {
  if (!duplicateScanState) return;
  const session = {
    skus: duplicateScanState.skus,
    currentIndex: duplicateScanState.currentIndex,
    results: duplicateScanState.results,
    config: duplicateScanState.config,
    strategy: duplicateScanState.strategy,
    date: new Date().toISOString()
  };
  chrome.storage.local.set({ obgPausedSession: session });
  console.log('[OBG] Saved paused session at index', session.currentIndex);
}

function clearPausedSession() {
  chrome.storage.local.remove('obgPausedSession');
}

function loadPausedSession() {
  return new Promise(resolve => {
    chrome.storage.local.get('obgPausedSession', r => resolve(r.obgPausedSession || null));
  });
}

// ── Duplicate search history (last 10 sessions) ──
async function saveDuplicateSession(state, status) {
  if (!state || !state.results || state.results.length === 0) return;
  const history = await loadDuplicateHistory();
  history.unshift({
    id: 'dup_' + Date.now(),
    date: new Date().toISOString(),
    strategy: state.strategy || 'manual',
    skusInput: state.skus || [],
    results: state.results,
    totalSkus: state.skus?.length || 0,
    processedSkus: (state.currentIndex || 0) + (status === 'completed' ? 0 : 0),
    status
  });
  // Keep last 10
  if (history.length > 10) history.length = 10;
  await chrome.storage.local.set({ obgDupHistory: history });
  console.log('[OBG] Saved duplicate session:', status, 'results:', state.results.length);
}

async function loadDuplicateHistory() {
  return new Promise(resolve => {
    chrome.storage.local.get('obgDupHistory', r => resolve(r.obgDupHistory || []));
  });
}

// ── Launch current page scan (get SKU from active ozon.ru tab) ──
async function launchCurrentPageScan(config) {
  if (isRunning) { console.log('[OBG] Already running'); return; }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url) {
      relayToExtensionPages({ action: 'doneDuplicates', results: [], error: 'Нет активной вкладки' });
      return;
    }
    const url = activeTab.url;
    const match = url.match(/ozon\.ru\/product\/(?:.*?[-/])?(\d{5,})/);
    if (!match) {
      relayToExtensionPages({ action: 'doneDuplicates', results: [], error: 'Откройте страницу товара на ozon.ru' });
      return;
    }
    const sku = match[1];
    console.log('[OBG] Current page SKU:', sku);
    await launchDuplicateSearch([sku], config, 'current');
  } catch (e) {
    console.log('[OBG] launchCurrentPageScan error:', e.message);
    relayToExtensionPages({ action: 'doneDuplicates', results: [], error: e.message });
    isRunning = false;
  }
}

// ── Launch batch from seller products page ──
async function launchBatchFromProducts(config) {
  if (isRunning) { console.log('[OBG] Already running'); return; }
  isRunning = true;
  latestDuplicateStats = { total: 0, processed: 0, found: 0 };
  duplicateScanState = { skus: [], currentIndex: 0, results: [], config, tabId: null, strategy: 'batch' };
  relayToExtensionPages({ action: 'updateDuplicateStats', stats: latestDuplicateStats });

  console.log('[OBG] Launching batch from seller products page');
  relayToExtensionPages({ action: 'techLog', text: `[Пакетный] 📦 Открываю страницу товаров seller.ozon.ru/app/products...` });
  try {
    // Find or open seller products page
    let sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    let tabId;
    if (sellerTabs.length > 0) {
      tabId = sellerTabs[0].id;
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url.includes('/app/products')) {
        await chrome.tabs.update(tabId, { url: 'https://seller.ozon.ru/app/products', active: true });
        await waitForTabComplete(tabId);
        await wait(2500);
      } else {
        await chrome.tabs.update(tabId, { active: true });
        await wait(1000);
      }
    } else {
      const tab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/products' });
      tabId = tab.id;
      await waitForTabComplete(tabId);
      await wait(3000);
    }

    // Inject batch collector script
    relayToExtensionPages({ action: 'techLog', text: `[Пакетный] 🔧 Внедряю скрипт сбора SKU...` });
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content/content-batch-products.js'] });
    } catch (e) { console.log('[OBG] inject batch:', e.message); }
    await wait(500);

    // Tell it to collect SKUs
    relayToExtensionPages({ action: 'techLog', text: `[Пакетный] ▶ Запускаю сбор SKU из таблицы товаров...` });
    chrome.tabs.sendMessage(tabId, { action: 'collectProductSkus' }, () => {
      if (chrome.runtime.lastError) {
        console.log('[OBG] batch msg:', chrome.runtime.lastError.message);
        relayToExtensionPages({ action: 'techLog', text: `[Пакетный] ❌ Ошибка отправки команды: ${chrome.runtime.lastError.message}` });
      }
    });
  } catch (e) {
    console.log('[OBG] launchBatchFromProducts error:', e.message);
    isRunning = false;
    relayToExtensionPages({ action: 'doneDuplicates', results: [], error: e.message });
  }
}

// ── Init on install ──
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[OBG] Extension installed');
  const config = await getConfig();
  if (config) {
    if (config.scheduleEnabled) updateSchedule(config);
    if (config.productScheduleEnabled) updateProductSchedule(config);
  }
});

// ── Restore schedules on startup ──
chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  if (config) {
    if (config.scheduleEnabled) updateSchedule(config);
    if (config.productScheduleEnabled) updateProductSchedule(config);
  }
});
