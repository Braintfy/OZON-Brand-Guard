// OZON Brand Guard — Background Service Worker
// Автор: firayzer (https://t.me/firayzer)

const ALARM_SELLERS = 'obg-schedule';
const ALARM_PRODUCTS = 'obg-schedule-products';

// ── State ──
let isRunning = false;
let latestSellerStats = null;
let latestProductStats = null;

// ── Message handling ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'getStatus':
      sendResponse({ running: isRunning, sellerStats: latestSellerStats, productStats: latestProductStats });
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

    case 'done':
      isRunning = false;
      relayToExtensionPages(msg);
      break;

    case 'doneProducts':
      isRunning = false;
      relayToExtensionPages(msg);
      break;

    case 'scanBrandsResult':
    case 'logUpdate':
    case 'techLog':
      relayToExtensionPages(msg);
      break;
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
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
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
